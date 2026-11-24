import type { WorkspaceReadInput } from '@planner/contracts';
import { publicIdSchema } from '@planner/contracts/storage';
import type { Db, Document, Long } from 'mongodb';
import { decodeRank } from '../../storage/identity.js';
import { InvalidPageCursor, pageCursors, type CursorScope } from '../pagination/cursor.js';
import { cardPermissions, WorkspaceAccessError, type BoardAccessContext, type CardAccessContext,
  type ProjectAccessContext, type WorkspaceAuthorization } from './authorization.js';
import { cardFilters, cardPlacementStages, cardSearch, datedOrder, historyOrder, rankedOrder, readPage,
  rejectedPattern, textQuery, type PagePosition } from './queries.js';
import { createWorkspaceRecords, rankSort, together, type WorkspaceRow } from './records.js';

const iso = (value?: Date | null) => value?.toISOString() ?? null;
const rank = (value?: Long | null) => value == null ? null : decodeRank(value).toString();
type EntityProjection = Pick<WorkspaceRow<'cards'>, 'id' | 'revision' | 'createdAt' | 'updatedAt'>;
const entity = ({ id, revision, createdAt, updatedAt }: EntityProjection) =>
  ({ id, revision, createdAt: createdAt.toISOString(), updatedAt: iso(updatedAt) });
const ordered = (row: EntityProjection & { rank?: Long | null }) => ({ ...entity(row), rank: rank(row.rank) });
const person = ({ id, name, username }: WorkspaceRow<'users'>) => ({ id, name, username: username ?? null });
const labelDto = (row: WorkspaceRow<'labels'>) => ({ ...ordered(row), boardId: row.boardId, name: row.name ?? null, color: row.color ?? null });
const boardDto = ({ board, permissions }: BoardAccessContext) => ({ ...ordered(board), projectId: board.projectId, name: board.name, permissions });

function cardDto(card: WorkspaceRow<'cards'>, board: BoardAccessContext, list: WorkspaceRow<'lists'>) {
  return { ...ordered(card), boardId: board.board.id, listId: list.id, name: card.name, type: card.type, kind: card.kind,
    closed: card.closed ?? list.kind === 'closed', dueDate: iso(card.dueDate), permissions: cardPermissions(board, list) };
}

function inertLink(raw?: string | null) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

const fieldDefinition = (row: WorkspaceRow<'fieldDefinitions'>) => ({
  ...ordered(row), name: row.name, fieldGroupId: row.fieldGroupId, showOnFront: row.showOnFront ?? false,
});

export function createWorkspaceReads(database: Db, access: WorkspaceAuthorization) {
  const { generationId, actor } = access;
  const records = createWorkspaceRecords(database, generationId);
  function cursorScope(operation: string, order: string, query: readonly string[]) {
    return { generationId, actorId: actor.id, operation, order, query: [actor.role, ...query] };
  }

  async function ownershipCanChange(context: ProjectAccessContext) {
    if (context.ownsProject) return true;
    if (!context.sharedAdmin) return false;
    const managers = await records.find('projectManagers', { projectId: context.project.id });
    if (managers.length !== 1 || !publicIdSchema.safeParse(managers[0].userId).success) return false;
    const manager = await records.get('users', managers[0].userId);
    return manager?.disabledAt === null && (manager.role === 'admin' || manager.role === 'projectOwner');
  }

  async function projectSummary(context: ProjectAccessContext, visibleBoardCount?: number) {
    const { project, permissions } = context;
    const favorite = await records.first('projectFavorites', { projectId: project.id, userId: actor.id });
    const boardCount = visibleBoardCount ?? (context.manager || context.sharedAdmin
      ? await records.count('boards', { projectId: project.id }) : (await access.visibleBoards(context)).length);
    return {
      ...ordered(project), name: project.name, type: project.type, hidden: project.hidden, favorite: !!favorite,
      permissions: { ...permissions, canDelete: permissions.canDelete && boardCount === 0,
        canChangeOwnership: await ownershipCanChange(context) }, boardCount,
    };
  }

  async function visibleBoardSummaries(context: ProjectAccessContext) {
    return together((await access.visibleBoards(context)).map(async (board) =>
      boardDto(access.boardAccess(board, context, await access.membershipRow(board)))));
  }

  async function visiblePeople(ids: string[]) {
    return (await records.find('users', { id: { $in: ids } }, { id: 1 })).map(person);
  }

  async function blobAvailable(blobDigest?: string | null) {
    return !!blobDigest && !!await records.first('blobs', { digest: blobDigest, lifecycleState: 'available' });
  }

  async function attachment(row: WorkspaceRow<'attachments'>) {
    const url = row.kind === 'link' ? inertLink(row.url) : null;
    return {
      ...entity(row), name: row.name, cardId: row.cardId, kind: row.kind,
      available: row.kind === 'link' ? !!url : await blobAvailable(row.blobDigest), byteLength: row.byteLength ?? null, url,
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
    const allValues = await records.find('fieldValues', { cardId: context.card.id, fieldGroupId: { $in: [...definitions.keys()] } });
    const values = allValues.flatMap(({ fieldGroupId, fieldDefinitionId, value }) =>
      definitions.get(fieldGroupId)?.has(fieldDefinitionId) ? [{ fieldGroupId, fieldDefinitionId, value }] : []);
    return { fields, values };
  }

  async function publicAssignee(id: string | null | undefined, boardId: string) {
    if (!id || !await records.first('boardMembers', { boardId, userId: id, role: { $in: ['editor', 'viewer'] } })) return null;
    const user = await records.get('users', id);
    return user ? person(user) : null;
  }

  async function previousList(context: CardAccessContext) {
    const id = context.card.previousListId;
    if (!id || !publicIdSchema.safeParse(id).success) return null;
    const list = await records.get('lists', id);
    return list && list.boardId === context.board.board.id && (list.kind === 'active' || list.kind === 'closed') ? id : null;
  }

  async function linkedTask(row: WorkspaceRow<'tasks'>, boardId: string) {
    const base = { ...entity(row), checklistId: row.checklistId, rank: rank(row.rank) };
    if (row.linkedUnavailable) return { ...base, kind: 'unavailable' as const };
    if (!row.linkedCardId) return { ...base, kind: 'task' as const, name: row.name ?? '',
      completed: row.completed ?? false, assignee: await publicAssignee(row.assigneeId, boardId) };
    try {
      if (!publicIdSchema.safeParse(row.linkedCardId).success) return { ...base, kind: 'unavailable' as const };
      const target = await access.requireCard(row.linkedCardId);
      return {
        ...base, kind: 'linked' as const,
        linkedCard: { id: target.card.id, name: target.card.name, boardId: target.board.board.id,
          completed: target.card.closed ?? target.list.kind === 'closed' },
        assignee: await publicAssignee(row.assigneeId, boardId),
      };
    } catch (error) {
      if (error instanceof WorkspaceAccessError && error.statusCode === 404) return { ...base, kind: 'unavailable' as const };
      throw error;
    }
  }

  async function alphabeticalAnchor(scope: CursorScope, cursor: string): Promise<PagePosition> {
    // Store only the ID in the cursor so an imported name can exceed the cursor size.
    const decoded = pageCursors.decode(scope, cursor);
    const id = decoded && typeof decoded === 'object' && !Array.isArray(decoded) && Object.keys(decoded).length === 1
      ? publicIdSchema.safeParse((decoded as { id?: unknown }).id) : undefined;
    if (!id?.success) throw new InvalidPageCursor('The page cursor has an invalid position.');
    try {
      const { project } = await access.requireProject(id.data);
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
          userId: actor.id, $expr: { $eq: ['$projectId', '$$projectId'] },
        }, [{ $limit: 1 }]), { $match: { 'actorFavorite.0': { $exists: true } } });
      }
      const hidden = input.hidden === 'include' ? {} : { hidden: input.hidden === 'only' };
      const rows = await records.aggregate<WorkspaceRow<'projects'>>('projects', hidden,
        [...stages, { $match: search.filter }, ...pagination.stages]);
      const { selected, page } = pagination.result(rows, (row): PagePosition => {
        if (alphabetical) return { id: row.id };
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
      if (!context.manager) return { data: { ...summary, description, boards, managers: null, backgrounds: null, fieldTemplates: null } };
      const [managerRows, backgrounds, templates] = await together([
        records.find('projectManagers', { projectId: id }), records.find('projectBackgrounds', { projectId: id }),
        records.find('fieldGroups', { scopeType: 'project', scopeId: id }, rankSort),
      ]);
      const allowedBackgrounds = await together(backgrounds.map(async (background) =>
        (background.kind === 'preset' || await blobAvailable(background.blobDigest))
          ? { ...entity(background), name: background.name } : null));
      return { data: { ...summary, description, boards, managers: await visiblePeople(managerRows.map(({ userId }) => userId)),
        backgrounds: allowedBackgrounds.filter((background) => background !== null), fieldTemplates: await together(templates.map((row) => fieldGroup(row))) } };
    },

    async boardsList({ id }: WorkspaceReadInput<'boardsList'>) {
      return { data: await visibleBoardSummaries(await access.requireProject(id)) };
    },

    async boardGet({ id }: WorkspaceReadInput<'boardGet'>) {
      return { data: boardDto(await access.requireBoard(id)) };
    },

    async boardWorkspace({ id }: WorkspaceReadInput<'boardWorkspace'>) {
      const board = await access.requireBoard(id);
      const [project, lists, labels, preferences, last, totals] = await together([
        projectSummary(board.project),
        records.find('lists', { boardId: id, kind: { $in: ['active', 'closed', 'archive', 'trash'] } }, rankSort),
        records.find('labels', { boardId: id }, rankSort),
        records.first('boardPreferences', { boardId: id }),
        records.first('events', { boardId: id }, { sequence: -1 }),
        together((['board', 'archive', 'trash'] as const).map((kind) =>
          records.aggregate<{ _id: string; count: number }>('cards', { boardId: id, kind }, [
            ...cardPlacementStages(records, id, kind), { $group: { _id: '$listId', count: { $sum: 1 } } },
          ]))),
      ]);
      const counts = new Map(totals.flat().map(({ _id, count }) => [_id, count]));
      return { data: {
        board: boardDto(board), project,
        lists: lists.map((item) => ({ ...ordered(item), boardId: id, kind: item.kind, name: item.name,
          orderVersion: item.orderVersion ?? item.revision, cardCount: counts.get(item.id) ?? 0 })),
        labels: labels.map(labelDto), orderVersion: board.board.orderVersion ?? board.board.revision,
        latestEventSequence: last ? decodeRank(last.sequence).toString() : '0',
        preferences: {
          revision: preferences?.revision ?? null, defaultView: preferences?.defaultView ?? board.board.defaultView ?? 'kanban',
          defaultCardType: preferences?.defaultCardType ?? null, restrictedCardType: preferences?.restrictedCardType ?? null,
          showCreator: preferences?.showCreator ?? false, showCardAge: preferences?.showCardAge ?? false,
          showCardCount: preferences?.showCardCount ?? false, expandChecklists: preferences?.expandChecklists ?? false,
        },
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
      return { data: selected.map((row) => cardDto(row, board, row.placement[0])), page, searchValidation: 'ok' as const };
    },

    async cardGet({ id }: WorkspaceReadInput<'cardGet'>) {
      const context = await access.requireCard(id);
      const { card, board, list } = context;
      const boardId = board.board.id;
      const [links, assignments, attachments, previousListId, fields] = await together([
        records.find('cardLabels', { cardId: id }), records.find('cardAssignees', { cardId: id }),
        records.find('attachments', { cardId: id, kind: { $in: ['file', 'link'] } }, { createdAt: 1, id: 1 }),
        previousList(context), cardFields(context),
      ]);
      const labels = await records.find('labels', { boardId, id: { $in: links.map(({ labelId }) => labelId) } }, rankSort);
      const members = await records.find('boardMembers', { boardId, userId: { $in: assignments.map(({ userId }) => userId) },
        role: { $in: ['editor', 'viewer'] } });
      const coverAttachmentId = attachments.some((item) => item.id === card.coverAttachmentId && item.kind === 'file') ? card.coverAttachmentId! : null;
      return { data: { ...cardDto(card, board, list), description: card.description ?? null, previousListId, labels: labels.map(labelDto),
        assignees: await visiblePeople(members.map(({ userId }) => userId)), attachments: await together(attachments.map(attachment)),
        coverAttachmentId, ...fields } };
    },

    async boardLabels({ id }: WorkspaceReadInput<'boardLabels'>) {
      const { board } = await access.requireBoard(id);
      return { data: (await records.find('labels', { boardId: board.id }, rankSort)).map(labelDto) };
    },

    async cardChecklists({ id }: WorkspaceReadInput<'cardChecklists'>) {
      const { card, board } = await access.requireCard(id);
      const checklists = await records.find('checklists', { cardId: card.id }, rankSort);
      return { data: await together(checklists.map(async (row) => ({
        ...ordered(row), name: row.name, cardId: card.id, showOnFront: row.showOnFront ?? false, hideCompleted: row.hideCompleted ?? false,
        tasks: await together((await records.find('tasks', { checklistId: row.id }, rankSort)).map((task) => linkedTask(task, board.board.id))),
      }))) };
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
