import { createHash } from 'node:crypto';
import { safeMediaLink, type WorkspaceReadInput } from '@planner/contracts';
import { publicIdSchema } from '@planner/contracts/storage';
import type { Db, Document, Long } from 'mongodb';
import { decodeRank } from '../../storage/identity.js';
import type { BoardEventCursors } from '../board-events/cursor.js';
import { createBoardEventStore } from '../board-events/store.js';
import { InvalidPageCursor, pageCursors, type CursorScope } from '../pagination/cursor.js';
import { WorkspaceAccessError, type BoardAccessContext, type CardAccessContext,
  type ProjectAccessContext, type WorkspaceAuthorization } from './authorization.js';
import { cardDto, cardStopwatch } from './card-state.js';
import { createChecklistReads } from './checklist-reads.js';
import { checklistOrderVersion } from './checklist-state.js';
import { personalFollow } from './affiliation-edges.js';
import { eligibleBoardPeople } from './eligible-members.js';
import { cardLabelJoinFilter, labelDto, scopedLabels } from './label-state.js';
import { boardDto, boardPreferences, boardPreferencesRow, projectBoardOrderVersion } from './board-state.js';
import { boardListOrderVersion, listDto } from './list-state.js';
import { cardFilters, cardPlacementStages, cardSearch, datedOrder, historyOrder, rankedOrder, readPage,
  rejectedPattern, textQuery, type PagePosition } from './queries.js';
import { availableMedia, unavailableMedia } from '../media/records.js';
import { availableProjectImage, effectiveProjectBackground } from './project-background.js';
import { canonicalRow, createWorkspaceRecords, equal, publicIdField, rankSort, together, type WorkspaceRow } from './records.js';
import { projectFavoriteFilter, projectManagerFilter, soleEligibleManager } from './relationship-policy.js';

const nameAnchor = (name: string) => createHash('sha256').update(name, 'utf8').digest('hex');
const iso = (value?: Date | null) => value?.toISOString() ?? null;
const rank = (value?: Long | null) => value == null ? null : decodeRank(value).toString();
type EntityProjection = Pick<WorkspaceRow<'cards'>, 'id' | 'revision' | 'createdAt' | 'updatedAt'>;
const entity = ({ id, revision, createdAt, updatedAt }: EntityProjection) =>
  ({ id, revision, createdAt: createdAt.toISOString(), updatedAt: iso(updatedAt) });
const ordered = (row: EntityProjection & { rank?: Long | null }) => ({ ...entity(row), rank: rank(row.rank) });
const person = ({ id, name, username }: WorkspaceRow<'users'>) => ({ id, name, username: username ?? null });

const fieldDefinition = (row: WorkspaceRow<'fieldDefinitions'>) => ({
  ...ordered(row), name: row.name, fieldGroupId: row.fieldGroupId, showOnFront: row.showOnFront ?? false,
});

export function createWorkspaceReads(database: Db, access: WorkspaceAuthorization, eventCursors: BoardEventCursors) {
  const { generationId, actor } = access;
  const records = createWorkspaceRecords(database, generationId);
  const canonical = canonicalRow(generationId);
  const checklistReads = createChecklistReads(records, access);
  function cursorScope(operation: string, order: string, query: readonly string[]) {
    return { generationId, actorId: actor.id, operation, order, query: [actor.role, ...query] };
  }

  async function ownershipCanChange(context: ProjectAccessContext) {
    if (context.ownsProject) return true;
    if (!context.sharedAdmin) return false;
    return !!await soleEligibleManager(records, generationId, context.project.id);
  }

  async function projectSummary(context: ProjectAccessContext, visibleBoardCount?: number) {
    const { project, permissions } = context;
    const favorite = await records.first('projectFavorites', projectFavoriteFilter(generationId, project.id, actor.id));
    const boardCount = visibleBoardCount ?? (context.manager || context.sharedAdmin
      ? await records.count('boards', { projectId: project.id, $expr: { $and: [canonical, equal('projectId', project.id)] } }) : (await access.visibleBoards(context)).length);
    return {
      ...ordered(project), name: project.name, type: project.type, hidden: project.hidden, favorite: !!favorite,
      permissions: { ...permissions, canDelete: permissions.canDelete && boardCount === 0,
        canChangeOwnership: await ownershipCanChange(context) }, boardCount, boardOrderVersion: projectBoardOrderVersion(project),
    };
  }

  async function visibleBoardSummaries(context: ProjectAccessContext) {
    return together((await access.visibleBoards(context)).map(async (board) =>
      boardDto(access.boardAccess(board, context, await access.membershipRow(board)))));
  }

  async function visiblePeople(ids: string[]) {
    return (await records.find('users', { id: { $in: ids }, $expr: canonical }, { id: 1 })).map(person);
  }

  async function blobAvailable(blobDigest?: string | null, image = false) {
    return !!blobDigest && !!await records.first('blobs', {
      digest: blobDigest, lifecycleState: availableMedia,
      ...(image && { 'variants.small.digest': { $type: 'string' }, 'variants.large.digest': { $type: 'string' } }),
    });
  }

  async function attachment(row: WorkspaceRow<'attachments'>) {
    const url = row.kind === 'link' ? safeMediaLink(row.url) : null;
    return {
      ...entity(row), name: row.name, cardId: row.cardId, kind: row.kind,
      available: row.kind === 'link' ? !!url : row.availability === availableMedia && await blobAvailable(row.blobDigest), byteLength: row.byteLength ?? null, url,
    };
  }

  async function fieldGroup(row: WorkspaceRow<'fieldGroups'>, groups = [row.id]) {
    const definitions = (await records.find('fieldDefinitions', { fieldGroupId: { $in: groups } }, rankSort))
      .map((definition) => ({ ...fieldDefinition(definition), fieldGroupId: row.id }));
    return { ...ordered(row), name: row.name, scopeType: row.scopeType, scopeId: row.scopeId, definitions };
  }

  async function cardFields(context: CardAccessContext) {
    const groups = await records.find('fieldGroups', { $or: [
      { scopeType: 'card', scopeId: context.card.id }, { scopeType: 'board', scopeId: context.board.board.id },
    ] }, rankSort);
    const fields = await together(groups.map(async (group) => fieldGroup(group, await access.effectiveDefinitionGroups(context, group))));
    const definitions = new Map(fields.map(({ id, definitions }) => [id, new Set(definitions.map((definition) => definition.id))]));
    const allValues = await records.find('fieldValues', { cardId: context.card.id, fieldGroupId: { $in: [...definitions.keys()] } },
      { fieldGroupId: 1, fieldDefinitionId: 1 });
    const values = allValues.flatMap(({ fieldGroupId, fieldDefinitionId, value }) =>
      definitions.get(fieldGroupId)?.has(fieldDefinitionId) ? [{ fieldGroupId, fieldDefinitionId, value }] : []);
    return { fields, values };
  }

  async function previousList(context: CardAccessContext) {
    const id = context.card.previousListId;
    if (!id || !publicIdSchema.safeParse(id).success) return null;
    const list = await records.get('lists', id);
    return list && list.boardId === context.board.board.id && (list.kind === 'active' || list.kind === 'closed') ? id : null;
  }

  async function alphabeticalAnchor(scope: CursorScope, cursor: string): Promise<PagePosition> {
    // Keep imported names intact while binding the anchor to its original sort value.
    const decoded = pageCursors.decode(scope, cursor);
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) || Object.keys(decoded).length !== 2) {
      throw new InvalidPageCursor('The page cursor has an invalid position.');
    }
    const position = decoded as { id?: unknown; nameDigest?: unknown };
    const id = publicIdSchema.safeParse(position.id);
    if (!id.success || typeof position.nameDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(position.nameDigest)) {
      throw new InvalidPageCursor('The page cursor has an invalid position.');
    }
    try {
      const { project } = await access.requireProject(id.data);
      if (nameAnchor(project.name) !== position.nameDigest) throw new InvalidPageCursor('The page cursor no longer applies.');
      return { id: project.id, name: project.name };
    } catch (error) {
      if (error instanceof WorkspaceAccessError && error.statusCode === 404) {
        throw new InvalidPageCursor('The page cursor no longer applies.');
      }
      throw error;
    }
  }

  return {
    async projectsList(input: WorkspaceReadInput<'projectsList'>) {
      const search = textQuery(input.q, ['name', 'description']);
      const alphabetical = input.order === 'alphabetically';
      const order = alphabetical ? [
        { field: 'name', type: 'name', direction: 1 }, { field: 'id', type: 'id', direction: 1 },
      ] as const : input.order === 'byCreationTime' ? datedOrder : rankedOrder;
      const scope = cursorScope('projects.list', input.order, [search.binding, input.hidden, String(input.favorite), String(input.limit)]);
      const anchor = alphabetical && input.cursor ? await alphabeticalAnchor(scope, input.cursor) : undefined;
      const pagination = readPage(order, scope, input.limit, input.cursor, anchor);
      const stages = access.visibleProjectStages();
      if (input.favorite) {
        stages.push(records.lookup('projectFavorites', 'actorFavorite', { projectId: '$id' }, {
          userId: actor.id, $expr: { $and: [canonical, equal('userId', actor.id), { $eq: ['$projectId', '$$projectId'] }] },
        }, [{ $limit: 1 }]), { $match: { 'actorFavorite.0': { $exists: true } } });
      }
      const hidden = input.hidden === 'include' ? {} : { hidden: input.hidden === 'only' };
      const rows = await records.aggregate<WorkspaceRow<'projects'>>('projects', hidden,
        [...stages, { $match: search.filter }, ...pagination.stages]);
      const { selected, page } = pagination.result(rows, (row): PagePosition => {
        if (alphabetical) return { id: row.id, nameDigest: nameAnchor(row.name) };
        if (input.order === 'byCreationTime') return { createdAt: iso(row.createdAt), id: row.id };
        return { rank: rank(row.rank), id: row.id };
      });
      const data = await together(selected.map(async (row) => projectSummary(access.projectAccess(row, await access.managerRow(row)))));
      return { data, page, permissions: { canCreate: access.roles.canCreateProject } };
    },

    async projectGet({ id }: WorkspaceReadInput<'projectGet'>) {
      const context = await access.requireProject(id);
      const boards = await visibleBoardSummaries(context);
      const summary = await projectSummary(context, boards.length);
      const description = context.project.description ?? null;
      const background = await effectiveProjectBackground(database, generationId, context.project);
      if (!context.manager) return { data: { ...summary, description, boards, managers: null, background, backgrounds: null, fieldTemplates: null } };
      const [managerRows, backgrounds, templates] = await together([
        records.find('projectManagers', projectManagerFilter(generationId, id)), records.find('projectBackgrounds', { projectId: id, kind: 'file', deletedAt: null,
          $expr: { $and: [canonical, equal('projectId', id)] } }, { createdAt: 1, id: 1 }),
        records.find('fieldGroups', { scopeType: 'project', scopeId: id }, rankSort),
      ]);
      const allowedBackgrounds = await together(backgrounds.map(async (background) =>
        await availableProjectImage(database, generationId, id, background.id) ? { ...entity(background), name: background.name } : null));
      return { data: { ...summary, description, boards, managers: await visiblePeople(managerRows.map(({ userId }) => userId)),
        background, backgrounds: allowedBackgrounds.filter((background) => background !== null), fieldTemplates: await together(templates.map((row) => fieldGroup(row))) } };
    },

    async boardsList({ id }: WorkspaceReadInput<'boardsList'>) {
      return { data: await visibleBoardSummaries(await access.requireProject(id)) };
    },

    async boardGet({ id }: WorkspaceReadInput<'boardGet'>) {
      return { data: boardDto(await access.requireBoard(id)) };
    },

    async boardWorkspace({ id }: WorkspaceReadInput<'boardWorkspace'>) {
      const board = await access.requireBoard(id);
      const [project, lists, labels, preferences, latestSequence, totals, follow] = await together([
        projectSummary(board.project),
        records.find('lists', { boardId: id, kind: { $in: ['active', 'closed', 'archive', 'trash'] } }, rankSort),
        scopedLabels(records, generationId, id),
        boardPreferencesRow(records, generationId, id),
        createBoardEventStore(database, generationId, id).highWater(),
        together((['board', 'archive', 'trash'] as const).map((kind) =>
          records.aggregate<{ _id: string; count: number }>('cards', { boardId: id, kind }, [
            ...cardPlacementStages(records, id, kind), { $group: { _id: '$listId', count: { $sum: 1 } } },
          ]))),
        board.permissions.canFollow ? personalFollow(records, generationId, 'board', id, actor.id) : null,
      ]);
      const counts = new Map(totals.flat().map(({ _id, count }) => [_id, count]));
      return { data: {
        board: boardDto(board), project,
        lists: lists.map((item) => ({ ...listDto(item), cardCount: counts.get(item.id) ?? 0 })),
        labels: labels.map(labelDto), orderVersion: boardListOrderVersion(board.board),
        latestEventSequence: latestSequence.toString(),
        eventCursor: eventCursors.encode({ actorId: actor.id, generationId, boardId: id }, latestSequence),
        preferences: boardPreferences(board.board, preferences),
        following: !!follow,
        selfMembership: board.membership ? { revision: board.membership.revision ?? null } : null,
      } };
    },

    async boardCards(input: WorkspaceReadInput<'boardCards'>) {
      const board = await access.requireBoard(input.id);
      const search = cardSearch(input.q);
      const order = input.context === 'board' ? rankedOrder : historyOrder;
      const scope = cursorScope('boards.cards', input.context === 'board' ? 'rank-id' : 'history-id', [
        input.id, input.context, search.binding, JSON.stringify(input.labelsAny), JSON.stringify(input.labelsNone),
        JSON.stringify(input.members), JSON.stringify(input.listIds), String(input.unassigned), String(input.limit),
      ]);
      const pagination = readPage(order, scope, input.limit, input.cursor);
      const invalid = { data: [], page: { nextCursor: null }, searchValidation: 'invalid-pattern' as const };
      if (!search.valid) return invalid;
      const filter: Document = { boardId: input.id, kind: input.context };
      if (input.listIds.length) filter.listId = { $in: input.listIds };
      const filters = await cardFilters(records, board, input);
      let rows: (WorkspaceRow<'cards'> & { placement: WorkspaceRow<'lists'>[] })[];
      try {
        rows = await records.aggregate('cards', filter,
          [...cardPlacementStages(records, input.id, input.context), { $match: search.filter }, ...filters, ...pagination.stages],
          search.bounded ? { maxTimeMS: 350 } : undefined);
      } catch (error) {
        if (search.bounded && rejectedPattern(error)) return invalid;
        throw error;
      }
      const { selected, page } = pagination.result(rows, (row): PagePosition => {
        if (input.context === 'board') return { rank: rank(row.rank), id: row.id };
        return { listChangedAt: iso(row.listChangedAt), historySequence: rank(row.historySequence), id: row.id };
      });
      const front = await checklistReads.front(selected.map(({ id }) => id), board.board.id);
      return { data: selected.map((row) => ({ ...cardDto(row, board, row.placement[0]), frontChecklists: front.get(row.id) ?? [] })),
        page, searchValidation: 'ok' as const };
    },

    async cardGet({ id, boardId: expectedBoard }: WorkspaceReadInput<'cardGet'>) {
      const context = await access.requireCard(id, expectedBoard);
      const { card, board, list } = context;
      const boardId = board.board.id;
      const [links, assignments, attachments, previousListId, fields, follow] = await together([
        records.find('cardLabels', { cardId: id, ...cardLabelJoinFilter(generationId, id) }),
        records.find('cardAssignees', { cardId: id,
          $expr: { $and: [canonical, equal('cardId', id), publicIdField('userId')] } }),
        records.find('attachments', { cardId: id, deletedAt: null, kind: { $in: ['file', 'link'] } }, { createdAt: 1, id: 1 }),
        previousList(context), cardFields(context),
        context.permissions.canFollow ? personalFollow(records, generationId, 'card', id, actor.id) : null,
      ]);
      const labels = await scopedLabels(records, generationId, boardId, links.map(({ labelId }) => labelId));
      const assignees = await eligibleBoardPeople(records, generationId, boardId, { id: { $in: assignments.map(({ userId }) => userId) } }, [{ $sort: { id: 1 } }]);
      const visibleAttachments = await together(attachments.map(attachment));
      const cover = attachments.find((item) => item.id === card.coverAttachmentId && item.kind === 'file');
      const coverAttachmentId = cover && (cover.availability === unavailableMedia
        || (cover.availability === availableMedia && await blobAvailable(cover.blobDigest, true))) ? cover.id : null;
      return { data: { ...cardDto(card, board, list), description: card.description ?? null, stopwatch: cardStopwatch(card.stopwatch), checklistOrderVersion: checklistOrderVersion(card), previousListId, labels: labels.map(labelDto),
        assignees, following: !!follow, automaticFollow: !!follow && 'isPermanent' in follow && follow.isPermanent === false,
        attachments: visibleAttachments,
        coverAttachmentId, ...fields } };
    },

    async boardLabels({ id }: WorkspaceReadInput<'boardLabels'>) {
      const { board } = await access.requireBoard(id);
      return { data: (await scopedLabels(records, generationId, board.id)).map(labelDto) };
    },

    async cardChecklists({ id }: WorkspaceReadInput<'cardChecklists'>) {
      const { card, board } = await access.requireCard(id);
      return { data: await checklistReads.list(card.id, board.board.id) };
    },

    async cardComments({ id, limit, cursor }: WorkspaceReadInput<'cardComments'>) {
      const context = await access.requireCard(id);
      const scope = cursorScope('comments.list', 'time-id-desc', [id, String(limit)]);
      const pagination = readPage(datedOrder, scope, limit, cursor);
      const rows = await records.aggregate<WorkspaceRow<'comments'>>('comments', { cardId: id, boardId: context.board.board.id }, pagination.stages);
      const { selected, page } = pagination.result(rows, (row) => ({ createdAt: iso(row.createdAt), id: row.id }));
      const authors = await visiblePeople(selected.flatMap(({ authorId }) => authorId ? [authorId] : []));
      const people = new Map(authors.map((author) => [author.id, author]));
      return { data: selected.map((row) => {
        const own = row.authorId === actor.id && context.permissions.canComment;
        return { ...entity(row), cardId: id, text: row.text, author: row.authorId ? people.get(row.authorId) ?? null : null,
          permissions: { canEdit: own, canDelete: own || context.board.permissions.canManage } };
      }), page };
    },
  };
}

export type WorkspaceReads = ReturnType<typeof createWorkspaceReads>;
