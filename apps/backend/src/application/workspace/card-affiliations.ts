import { randomUUID } from 'node:crypto';
import type { RelationshipCommandInput } from '@planner/contracts';
import type { Db } from 'mongodb';
import type { CommandPlan, CommandPlanningContext, PlannedEffect } from '../command-journal/operation.js';
import { affiliationFilter, personalFollow } from './affiliation-edges.js';
import { requireCapability, type CardAccessContext, type WorkspaceAuthorization } from './authorization.js';
import { eligibleBoardPeople } from './eligible-members.js';
import { RelationshipError, requireRevision, rowRevision, touchRevision } from './relationship-policy.js';
import { createWorkspaceRecords, type WorkspaceRecords } from './records.js';

type Related = RelationshipCommandInput<'cards.assign'>;

export async function authorizeCardAffiliation(scope: WorkspaceAuthorization, { id }: Related) {
  const access = await scope.requireCard(id);
  requireCapability(access.permissions.canEdit);
  return access;
}

export async function authorizeCardLabel(scope: WorkspaceAuthorization, input: Related) {
  const access = await authorizeCardAffiliation(scope, input);
  await scope.requireLabel(input.relatedId, access.board.board.id);
  return access;
}

export async function authorizeCardAssignment(database: Db, scope: WorkspaceAuthorization, input: Related) {
  const access = await authorizeCardAffiliation(scope, input);
  const records = createWorkspaceRecords(database, scope.generationId);
  const [member] = await eligibleBoardPeople(records, scope.generationId, access.board.board.id, { id: input.relatedId });
  if (!member) throw new RelationshipError('target');
  return access;
}

function result(add: boolean, id: string, revision: number): CommandPlan['result'] {
  return add ? { data: { id, revision } } : { data: { parentRevision: revision } };
}
const audit = (action: string, resourceId: string) => ({ action, resourceId, resourceType: 'card' });
const changed = (boardId: string, id: string, revision: number) => ({ boardId, kind: 'card.changed', payload: { id, revision } });

export async function planCardLabel(add: boolean, records: WorkspaceRecords, { card }: CardAccessContext,
  input: Related, { generationId, timestamp }: CommandPlanningContext): Promise<CommandPlan> {
  const cardId = card.id;
  const labelId = input.relatedId;
  const revision = requireRevision(card, input.expectedRevision)!;
  const link = await records.first('cardLabels', affiliationFilter(generationId, { cardId, labelId }));
  const proof = audit(add ? 'cards.addLabel' : 'cards.removeLabel', cardId);
  if (add === !!link) return { effects: [], result: result(add, cardId, revision), audit: proof };
  const parent = touchRevision('cards', card, timestamp, revision);
  const effect: PlannedEffect = add
    ? { kind: 'insert', collection: 'cardLabels', id: randomUUID(), fields: { cardId, labelId, createdAt: timestamp } }
    : { kind: 'delete', collection: 'cardLabels', id: link!.id, revision: rowRevision(link!) };
  return {
    effects: [effect, parent], result: result(add, cardId, revision + 1), audit: proof,
    events: [changed(card.boardId, cardId, revision + 1)],
  };
}

export async function planCardAssignment(assign: boolean, records: WorkspaceRecords, { card }: CardAccessContext,
  input: Related, { generationId, actorId, commandId, timestamp }: CommandPlanningContext): Promise<CommandPlan> {
  const { id: cardId, boardId } = card;
  const userId = input.relatedId;
  const revision = requireRevision(card, input.expectedRevision)!;
  const assignment = await records.first('cardAssignees', affiliationFilter(generationId, { cardId, userId }));
  const proof = audit(assign ? 'cards.assign' : 'cards.unassign', cardId);
  if (assign === !!assignment) return { effects: [], result: result(assign, cardId, revision), audit: proof };
  const parent = touchRevision('cards', card, timestamp, revision);
  const existing = await personalFollow(records, generationId, 'card', cardId, userId);
  const effects: PlannedEffect[] = [];
  if (assign) {
    effects.push({ kind: 'insert', collection: 'cardAssignees', id: randomUUID(), fields: { cardId, userId, createdAt: timestamp } });
    if (!existing) effects.push({ kind: 'insert', collection: 'cardFollows', id: randomUUID(),
      fields: { cardId, userId, isPermanent: false, createdAt: timestamp } });
  } else {
    effects.push({ kind: 'delete', collection: 'cardAssignees', id: assignment!.id, revision: rowRevision(assignment!) });
    if (existing && 'isPermanent' in existing && existing.isPermanent === false) {
      effects.push({ kind: 'delete', collection: 'cardFollows', id: existing.id, revision: rowRevision(existing) });
    }
  }
  const activityId = randomUUID();
  const kind = assign ? 'assignCard' : 'unassignCard';
  effects.push(parent, { kind: 'insert', collection: 'activities', id: activityId,
    fields: { boardId, cardId, actorId, userId, commandId, kind, createdAt: timestamp } });
  if (assign && userId !== actorId) effects.push({ kind: 'insert', collection: 'notifications', id: randomUUID(),
    fields: { boardId, cardId, actorId, recipientId: userId, activityId, commandId, kind, readAt: null, createdAt: timestamp } });
  return {
    effects, result: result(assign, cardId, revision + 1), audit: proof,
    events: [changed(boardId, cardId, revision + 1)],
  };
}
