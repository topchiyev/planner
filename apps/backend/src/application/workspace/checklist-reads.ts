import { publicIdSchema } from '@planner/contracts/storage';
import { decodeRank } from '../../storage/identity.js';
import { WorkspaceAccessError, type CardAccessContext, type WorkspaceAuthorization } from './authorization.js';
import { cardClosed } from './card-state.js';
import { checklistRows, isUnavailableTask, taskOrderVersion, taskRows } from './checklist-state.js';
import { eligibleBoardPeople } from './eligible-members.js';
import { canonicalRow, together, type WorkspaceRecords, type WorkspaceRow } from './records.js';

type Checklist = WorkspaceRow<'checklists'>;
type Task = WorkspaceRow<'tasks'>;

const entity = (row: Pick<Task, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'rank'>) => ({
  id: row.id, revision: row.revision, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt?.toISOString() ?? null,
  rank: row.rank == null ? null : decodeRank(row.rank).toString(),
});

export function createChecklistReads(records: WorkspaceRecords, access: WorkspaceAuthorization) {
  const { generationId } = access;
  const canonical = canonicalRow(generationId);
  const targets = new Map<string, Promise<CardAccessContext | null>>();
  function readableTarget(id: string) {
    if (!publicIdSchema.safeParse(id).success) return Promise.resolve(null);
    const cached = targets.get(id);
    if (cached) return cached;
    const pending = access.requireCard(id).catch((error: unknown) => {
      if (error instanceof WorkspaceAccessError && error.statusCode === 404) return null;
      throw error;
    });
    targets.set(id, pending);
    return pending;
  }

  async function people(boardId: string, rows: readonly Task[]) {
    const ids = [...new Set(rows.flatMap(({ assigneeId }) => publicIdSchema.safeParse(assigneeId).success ? [assigneeId!] : []))];
    const visible = ids.length ? await eligibleBoardPeople(records, generationId, boardId, { id: { $in: ids } }) : [];
    return new Map(visible.map((person) => [person.id, person]));
  }

  async function materialize(groups: readonly Checklist[], rows: readonly Task[], boardId: string) {
    const assignees = await people(boardId, rows);
    async function project(row: Task) {
      const base = { ...entity(row), checklistId: row.checklistId };
      if (isUnavailableTask(row)) return { ...base, kind: 'unavailable' as const };
      const assignee = row.assigneeId ? assignees.get(row.assigneeId) ?? null : null;
      if (row.linkedCardId == null) return { ...base, kind: 'task' as const, name: row.name ?? '', completed: row.completed ?? false, assignee };
      const target = await readableTarget(row.linkedCardId);
      if (!target) return { ...base, kind: 'unavailable' as const };
      return { ...base, kind: 'linked' as const, assignee, linkedCard: {
        id: target.card.id, name: target.card.name, boardId: target.board.board.id, completed: cardClosed(target.card, target.list),
      } };
    }

    const projected = new Map<string, Awaited<ReturnType<typeof project>>[]>();
    // Keep the number of simultaneous target authorization reads bounded while the read lease is held.
    for (let offset = 0; offset < rows.length; offset += 16) {
      for (const task of await together(rows.slice(offset, offset + 16).map(project))) {
        const group = projected.get(task.checklistId) ?? [];
        group.push(task);
        projected.set(task.checklistId, group);
      }
    }
    return groups.map((group) => ({
      ...entity(group), name: group.name, cardId: group.cardId, orderVersion: taskOrderVersion(group),
      showOnFront: group.showOnFront ?? false, hideCompleted: group.hideCompleted ?? false, tasks: projected.get(group.id) ?? [],
    }));
  }

  return {
    async list(cardId: string, boardId: string) {
      const groups = await checklistRows(records, generationId, cardId);
      const tasks = await together(groups.map(({ id }) => taskRows(records, generationId, id)));
      return materialize(groups, tasks.flat(), boardId);
    },

    async front(cardIds: string[], boardId: string) {
      const visible = new Map<string, Awaited<ReturnType<typeof materialize>>>();
      if (!cardIds.length) return visible;
      const groups = await records.aggregate<Checklist>('checklists', {
        cardId: { $in: cardIds }, showOnFront: true,
        $expr: { $and: [canonical, { $in: ['$cardId', cardIds] }, { $eq: ['$showOnFront', true] }] },
      }, [
        { $sort: { cardId: 1, rank: 1, id: 1 } },
        { $group: { _id: '$cardId', items: { $firstN: { input: '$$ROOT', n: 3 } } } },
        { $unwind: '$items' }, { $replaceWith: '$items' },
      ]);
      if (!groups.length) return visible;
      const groupIds = groups.map(({ id }) => id);
      const tasks = await records.aggregate<Task>('tasks', {
        checklistId: { $in: groupIds }, $expr: { $and: [canonical, { $in: ['$checklistId', groupIds] }] },
      }, [
        { $project: { id: 1, revision: 1, createdAt: 1, updatedAt: 1, rank: 1, checklistId: 1, name: 1,
          completed: 1, assigneeId: 1, linkedCardId: 1, linkedUnavailable: 1 } },
        { $sort: { checklistId: 1, rank: 1, id: 1 } },
        { $group: { _id: '$checklistId', items: { $firstN: { input: '$$ROOT', n: 5 } } } },
        { $unwind: '$items' }, { $replaceWith: '$items' },
      ]);
      for (const group of await materialize(groups, tasks, boardId)) {
        const card = visible.get(group.cardId) ?? [];
        card.push(group);
        visible.set(group.cardId, card);
      }
      return visible;
    },
  };
}
