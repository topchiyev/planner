import { randomUUID } from 'node:crypto';
import { safeMediaLink } from '@planner/contracts';
import { publicIdSchema } from '@planner/contracts/storage';
import { decodeRank } from '../../storage/identity.js';
import type { CommandPlanningContext, JournalFields, PlannedEffect } from '../command-journal/operation.js';
import { availableMedia, unavailableMedia } from '../media/records.js';
import { WorkspaceAccessError, type CardAccessContext, type WorkspaceAuthorization } from './authorization.js';
import { attachmentFiles, coverForCard } from './card-media.js';
import { cardClosed } from './card-state.js';
import { isUnavailableTask } from './checklist-state.js';
import { equal, type WorkspaceRecords, type WorkspaceRow } from './records.js';
import { rowRevision } from './relationship-policy.js';
import { scopedWorkspaceRows } from './scoped-rows.js';

type Checklist = WorkspaceRow<'checklists'>;
type Task = WorkspaceRow<'tasks'>;

export async function readTransferChecklists(records: WorkspaceRecords, generationId: string, cards: string[]) {
  const { byIds } = scopedWorkspaceRows(records, generationId);
  const checklists = await byIds('checklists', 'cardId', cards);
  const tasks = await byIds('tasks', 'checklistId', checklists.map(({ id }) => id));
  return { checklists, tasks };
}

const scopedRank = (row: Pick<Task, 'id' | 'rank'>) => row.rank == null ? null : decodeRank(row.rank);
function transferOrder<T extends Pick<Task, 'id' | 'rank'>>(rows: T[]) {
  return rows.sort((a, b) => {
    const x = scopedRank(a);
    const y = scopedRank(b);
    if (x === y) return a.id.localeCompare(b.id);
    return x === null || (y !== null && x < y) ? -1 : 1;
  });
}

export function planMoveChecklistAssignees(tasks: Task[], eligible: Set<string>, timestamp: string): PlannedEffect[] {
  return tasks.flatMap((task) => task.assigneeId != null && !eligible.has(task.assigneeId) ? [{
    kind: 'update', collection: 'tasks', id: task.id, revision: rowRevision(task), fields: { assigneeId: null, updatedAt: timestamp },
  }] : []);
}

export async function planCloneChecklists(checklists: Checklist[], tasks: Task[], cardId: string, eligible: Set<string>,
  scope: WorkspaceAuthorization, timestamp: string): Promise<PlannedEffect[]> {
  const effects: PlannedEffect[] = [];
  const targets = new Map<string, CardAccessContext | null>();
  async function readable(id: string) {
    if (!publicIdSchema.safeParse(id).success) return null;
    if (targets.has(id)) return targets.get(id)!;
    try {
      const current = await scope.requireCard(id);
      targets.set(id, current);
      return current;
    } catch (error) {
      if (!(error instanceof WorkspaceAccessError) || error.statusCode !== 404) throw error;
      targets.set(id, null);
      return null;
    }
  }
  for (const [index, checklist] of transferOrder(checklists).entries()) {
    const checklistId = randomUUID();
    effects.push({ kind: 'insert', collection: 'checklists', id: checklistId, fields: {
      cardId, name: checklist.name, rank: (BigInt(index + 1) * 1024n).toString(), orderVersion: 1,
      showOnFront: checklist.showOnFront === true, hideCompleted: checklist.hideCompleted === true,
      createdAt: timestamp, updatedAt: null,
    } });
    for (const [taskIndex, task] of transferOrder(tasks.filter((row) => row.checklistId === checklist.id)).entries()) {
      const target = !isUnavailableTask(task) && task.linkedCardId != null ? await readable(task.linkedCardId) : null;
      const unavailable = isUnavailableTask(task) || (task.linkedCardId != null && !target);
      const fields: JournalFields = unavailable
        ? { name: null, completed: null, linkedCardId: null, linkedUnavailable: true }
        : { name: target ? null : task.name ?? '', completed: target ? cardClosed(target.card, target.list) : task.completed === true,
          linkedCardId: target?.card.id ?? null };
      effects.push({ kind: 'insert', collection: 'tasks', id: randomUUID(), fields: {
        ...fields, checklistId, rank: (BigInt(taskIndex + 1) * 1024n).toString(),
        assigneeId: !unavailable && task.assigneeId != null && eligible.has(task.assigneeId) ? task.assigneeId : null,
        createdAt: timestamp, updatedAt: null,
      } });
    }
  }
  return effects;
}

export async function planMoveComments(records: WorkspaceRecords, sourceBoardId: string, destinationBoardId: string,
  ids: string[], { generationId }: CommandPlanningContext): Promise<PlannedEffect[]> {
  const { byIds } = scopedWorkspaceRows(records, generationId);
  const comments = await byIds('comments', 'cardId', ids, { boardId: sourceBoardId }, equal('boardId', sourceBoardId));
  return comments.map((comment) => ({ kind: 'update', collection: 'comments', id: comment.id,
    revision: rowRevision(comment), fields: { boardId: destinationBoardId } }));
}

export async function planCloneAttachments(records: WorkspaceRecords, card: WorkspaceRow<'cards'>, newCardId: string,
  { generationId, timestamp }: CommandPlanningContext) {
  const { find } = scopedWorkspaceRows(records, generationId);
  const attachments = await find('attachments', { cardId: card.id, deletedAt: null, kind: { $in: ['file', 'link'] } }, equal('cardId', card.id),
    { $in: [{ $type: '$deletedAt' }, ['null', 'missing']] }, { $in: ['$kind', ['file', 'link']] });
  const files = await attachmentFiles(records, generationId, attachments);
  const cover = coverForCard(card, attachments.find(({ id }) => id === card.coverAttachmentId), files)?.attachmentId;
  const effects: PlannedEffect[] = [];
  let coverAttachmentId: string | null = null;
  for (const attachment of attachments) {
    if (typeof attachment.name !== 'string') continue;
    const id = randomUUID();
    const fields: JournalFields = { cardId: newCardId, name: attachment.name, kind: attachment.kind,
      createdAt: timestamp, updatedAt: null };
    if (attachment.kind === 'link') fields.url = safeMediaLink(attachment.url);
    else {
      const available = files.has(attachment.id);
      fields.availability = available ? availableMedia : unavailableMedia;
      fields.blobDigest = available ? attachment.blobDigest! : null;
      if (typeof attachment.byteLength === 'number' && Number.isSafeInteger(attachment.byteLength) && attachment.byteLength >= 0) {
        fields.byteLength = attachment.byteLength;
      }
    }
    if (attachment.id === cover && (fields.availability === availableMedia || attachment.availability === unavailableMedia)) coverAttachmentId = id;
    effects.push({ kind: 'insert', collection: 'attachments', id, fields });
  }
  return { effects, coverAttachmentId };
}
