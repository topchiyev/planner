import type { RelationshipRead, RelationshipReadInput } from '@planner/contracts';
import type { Db } from 'mongodb';
import { validTemplateChoice } from './field-planning.js';
import { eligibleBoardPeople } from './eligible-members.js';
import { requireCapability, type WorkspaceAuthorization } from './authorization.js';
import { readPage, textQuery } from './queries.js';
import { managerRoles, memberRoles, requireBoardManagement, rowRevision } from './relationship-policy.js';
import { canonicalRow, createWorkspaceRecords, directBoardRole, equal, publicIdField, type WorkspaceRow } from './records.js';

const byId = [{ field: 'id', type: 'id', direction: 1 }] as const;
const personProjection = { _id: 0, id: 1, name: 1, username: 1 };
type Person = Pick<WorkspaceRow<'users'>, 'id' | 'name' | 'username'>;
const personOf = ({ id, name, username }: Person) => ({ id, name, username: username ?? null });

export function createRelationshipReads(database: Db, scope: WorkspaceAuthorization) {
  const { actor, generationId } = scope;
  const records = createWorkspaceRecords(database, generationId);
  const canonical = canonicalRow(generationId);

  function page(operation: RelationshipRead, input: RelationshipReadInput<RelationshipRead>, binding: string[] = []) {
    return readPage(byId, {
      actorId: actor.id, generationId, operation, query: [input.id, ...binding], order: 'id',
    }, input.limit, input.cursor);
  }

  async function candidates(
    operation: 'projects.managerCandidates' | 'boards.memberCandidates',
    input: RelationshipReadInput<typeof operation>, selfOnly: boolean,
  ) {
    const managers = operation === 'projects.managerCandidates';
    const collection = managers ? 'projectManagers' : 'boardMembers';
    const parent = managers ? 'projectId' : 'boardId';
    const search = textQuery(input.q, ['name', 'username']);
    const paging = page(operation, input, [search.binding, selfOnly ? 'self' : 'all']);
    const rows = await records.aggregate<Person>('users', {
      ...search.filter, ...(selfOnly ? { id: actor.id } : {}),
      $expr: { $and: [
        canonical, { $eq: [{ $type: '$disabledAt' }, 'null'] },
        { $in: ['$role', managers ? managerRoles : memberRoles] },
      ] },
    }, [
      records.lookup(collection, 'assigned', { userId: '$id' }, {
        [parent]: input.id,
        $expr: { $and: [canonical, equal(parent, input.id), { $eq: ['$userId', '$$userId'] }] },
      }, [{ $limit: 1 }]),
      { $match: { 'assigned.0': { $exists: false } } },
      ...paging.stages,
      { $project: personProjection },
    ]);
    const result = paging.result(rows, ({ id }) => ({ id }));
    return { data: result.selected.map(personOf), page: result.page };
  }

  async function roster(
    operation: 'projects.managers' | 'boards.members', input: RelationshipReadInput<typeof operation>,
  ) {
    const managers = operation === 'projects.managers';
    const collection = managers ? 'projectManagers' : 'boardMembers';
    const parent = managers ? 'projectId' : 'boardId';
    const paging = page(operation, input);
    type Entry = WorkspaceRow<'projectManagers' | 'boardMembers'> & Pick<WorkspaceRow<'boardMembers'>, 'role' | 'canComment'> & {
      account: Person[];
    };
    const rows = await records.aggregate<Entry>(collection, {
      [parent]: input.id, $expr: { $and: [
        canonical, equal(parent, input.id), publicIdField('userId'), ...(managers ? [] : [directBoardRole]),
      ] },
    }, [
      ...paging.stages,
      records.lookup('users', 'account', { userId: '$userId' }, {
        $expr: { $and: [canonical, { $eq: ['$id', '$$userId'] }] },
      }, [{ $limit: 1 }, { $project: personProjection }]),
    ]);
    const result = paging.result(rows, ({ id }) => ({ id }));
    return {
      data: result.selected.map((row) => ({
        id: row.id, userId: row.userId, revision: rowRevision(row), person: row.account[0] ? personOf(row.account[0]) : null,
        ...(managers ? {} : { role: row.role, canComment: row.role === 'viewer' ? row.canComment === true : null }),
      })),
      page: result.page,
    };
  }

  async function mentionMembers(input: RelationshipReadInput<'boards.mentionMembers'>) {
    const { permissions } = await scope.requireBoard(input.id);
    requireCapability(permissions.canEdit);
    const search = textQuery(input.q, ['name', 'username']);
    const paging = page('boards.mentionMembers', input, [search.binding]);
    const rows = await eligibleBoardPeople(records, generationId, input.id, search.filter, paging.stages);
    const result = paging.result(rows, ({ id }) => ({ id }));
    return { data: result.selected.map(personOf), page: result.page };
  }

  return {
    async 'boards.transferDestinations'(input: RelationshipReadInput<'boards.transferDestinations'>) {
      const { permissions } = await scope.requireBoard(input.id);
      requireCapability(permissions.canDuplicateFrom);
      const search = textQuery(input.q, ['name', 'project.name']);
      const paging = page('boards.transferDestinations', input, [search.binding]);
      type Destination = { id: string; name: string; project: { id: string; name: string } };
      const rows = await records.aggregate<Destination>('boards', { id: { $ne: input.id }, $expr: canonical }, [
        records.lookup('boardMembers', 'editor', { boardId: '$id' }, {
          userId: actor.id, role: 'editor',
          $expr: { $and: [canonical, equal('userId', actor.id), equal('role', 'editor'), { $eq: ['$boardId', '$$boardId'] }] },
        }, [{ $limit: 1 }, { $project: { _id: 1 } }]),
        { $match: { 'editor.0': { $exists: true } } },
        records.lookup('projects', 'project', { projectId: '$projectId' },
          { $expr: { $and: [canonical, { $eq: ['$id', '$$projectId'] }] } }, [{ $project: { _id: 0, id: 1, name: 1 } }]),
        { $unwind: '$project' },
        { $match: search.filter },
        ...paging.stages, { $project: { _id: 0, id: 1, name: 1, project: 1 } },
      ]);
      const selected = paging.result(rows, ({ id }) => ({ id }));
      return { data: selected.selected, page: selected.page };
    },
    'boards.mentionMembers': mentionMembers,
    async 'fields.templateOptions'(input: RelationshipReadInput<'fields.templateOptions'>) {
      const board = await scope.requireBoard(input.id);
      requireCapability(board.permissions.canEdit);
      const projectId = board.project.project.id;
      const paging = page('fields.templateOptions', input, [projectId]);
      const rows = await records.aggregate<WorkspaceRow<'fieldGroups'>>('fieldGroups', {
        scopeType: 'project', scopeId: projectId, templateGroupId: null,
        $expr: { $and: [canonical, equal('scopeType', 'project'), equal('scopeId', projectId),
          { $eq: [{ $type: '$name' }, 'string'] }, { $in: [{ $type: '$templateGroupId' }, ['null', 'missing']] }] },
      }, paging.stages);
      const result = paging.result(rows, ({ id }) => ({ id }));
      return { data: result.selected.filter((row) => validTemplateChoice(row, projectId))
        .map(({ id, name, revision }) => ({ id, name: name!, revision })), page: result.page };
    },
    async 'projects.managers'(input: RelationshipReadInput<'projects.managers'>) {
      const project = await scope.requireProject(input.id);
      requireCapability(!!project.manager || project.sharedAdmin);
      return roster('projects.managers', input);
    },
    async 'projects.managerCandidates'(input: RelationshipReadInput<'projects.managerCandidates'>) {
      const project = await scope.requireProject(input.id);
      requireCapability(project.permissions.canManageManagers);
      return candidates('projects.managerCandidates', input, false);
    },
    async 'boards.members'(input: RelationshipReadInput<'boards.members'>) {
      await scope.requireBoard(input.id);
      return roster('boards.members', input);
    },
    async 'boards.memberCandidates'(input: RelationshipReadInput<'boards.memberCandidates'>) {
      const board = await scope.requireBoard(input.id);
      requireBoardManagement(scope, board);
      return candidates('boards.memberCandidates', input, !scope.roles.canCreateProject);
    },
  };
}
