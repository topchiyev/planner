import { randomUUID } from 'node:crypto';
import { type CardStopwatch, finiteListKindSchema, type RelationshipCommandInput } from '@planner/contracts';
import { revisionSchema } from '@planner/contracts/storage';
import { decodeRank, encodeRank } from '../../storage/identity.js';
import type { CommandPlan, CommandPlanningContext, JournalFields, PlannedEffect } from '../command-journal/operation.js';
import { availableMedia, unavailableMedia } from '../media/records.js';
import { requireCapability, WorkspaceAccessError, type CardAccessContext, type WorkspaceAuthorization } from './authorization.js';
import { boardPreferences, boardPreferencesRow } from './board-state.js';
import { cardClosed, cardDto, cardDue, cardStopwatch } from './card-state.js';
import { planLinkedCardCompletion } from './linked-card-completion.js';
import { listCardOrderVersion } from './list-state.js';
import { planRankChange, RankAnchorError } from './ordered-ranks.js';
import { RelationshipError, requireRevision, touchRevision } from './relationship-policy.js';
import { canonicalRow, equal, rankSort, type WorkspaceRecords, type WorkspaceRow } from './records.js';

type ListAccess = Awaited<ReturnType<WorkspaceAuthorization['requireList']>>;
type CardUpdate = RelationshipCommandInput<'cards.update'>;
const audit = (action: string, resourceId: string) => ({ action, resourceId, resourceType: 'card' });
const changedCard = (boardId: string, id: string, revision: number) => ({ boardId, kind: 'card.changed', payload: { id, revision } });

export async function authorizeCardCreate(scope: WorkspaceAuthorization, id: string) {
  const access = await scope.requireList(id);
  requireCapability(access.board.permissions.canEdit && finiteListKindSchema.safeParse(access.list.kind).success);
  return access;
}

export async function authorizeCardUpdate(scope: WorkspaceAuthorization, id: string) {
  const access = await scope.requireCard(id);
  requireCapability(access.permissions.canEdit);
  return access;
}

function readCardType(requested: WorkspaceRow<'cards'>['type'] | undefined, options: ReturnType<typeof boardPreferences>) {
  if (requested && options.restrictedCardType && requested !== options.restrictedCardType) throw new RelationshipError('cardType');
  return requested ?? options.restrictedCardType ?? options.defaultCardType ?? 'project';
}

async function newPlacement(records: WorkspaceRecords, generationId: string, boardId: string, listId: string,
  id: string, before: string | null, timestamp: string,
) {
  const cards = await records.find('cards', { listId, boardId, kind: 'board',
    $expr: { $and: [canonicalRow(generationId), equal('listId', listId), equal('boardId', boardId), equal('kind', 'board')] } }, rankSort);
  let ranks: Map<string, bigint>;
  try {
    ranks = new Map(planRankChange(cards.map((card) => ({ id: card.id, rank: card.rank == null ? null : decodeRank(card.rank) })), id, before)
      .map((row) => [row.id, row.rank]));
  } catch (error) {
    if (error instanceof RankAnchorError) throw new RelationshipError('cardOrder');
    throw error;
  }
  const rank = ranks.get(id);
  if (rank === undefined) throw new Error('A new card must have a rank.');
  const effects = cards.flatMap((card) => {
    const changed = ranks.get(card.id);
    if (changed === undefined) return [];
    const touch = touchRevision('cards', card, timestamp);
    return [{ ...touch, fields: { ...touch.fields, rank: changed.toString() } }];
  });
  return { rank, effects };
}

export async function planCardCreate(records: WorkspaceRecords, { list, board }: ListAccess,
  input: RelationshipCommandInput<'cards.create'>, context: CommandPlanningContext,
): Promise<CommandPlan> {
  const { actorId: userId, generationId, timestamp } = context;
  const boardId = board.board.id;
  const listId = list.id;
  const parent = touchRevision('lists', list, timestamp, input.expectedRevision);
  const nextVersion = revisionSchema.safeParse(listCardOrderVersion(list) + 1);
  if (!nextVersion.success) throw new RelationshipError('cardOrder');
  const id = randomUUID();
  const options = boardPreferences(board.board, await boardPreferencesRow(records, generationId, boardId));
  const type = readCardType(input.type, options);
  const { rank, effects: placement } = await newPlacement(records, generationId, boardId, listId, id, input.beforeCardId, timestamp);
  const fields = { boardId, listId, type, kind: 'board' as const, name: input.name, closed: list.kind === 'closed', dueDate: null, dueDateCompleted: null };
  const effects: PlannedEffect[] = [
    { kind: 'insert', collection: 'cards', id, fields: { ...fields, creatorId: userId, description: input.description,
      rank: rank.toString(), createdAt: timestamp, updatedAt: null, stopwatch: null, previousListId: null, coverAttachmentId: null } },
    ...placement,
    { ...parent, fields: { ...parent.fields, orderVersion: nextVersion.data } },
    { kind: 'insert', collection: 'activities', id: randomUUID(), fields: { boardId, cardId: id, actorId: userId, commandId: context.commandId, kind: 'createCard', createdAt: timestamp } },
  ];
  const user = await context.read('users', userId);
  const preferences = user?.preferences;
  if (preferences && !Array.isArray(preferences) && typeof preferences === 'object'
    && 'followOwnCards' in preferences && preferences.followOwnCards === true) {
    effects.push({ kind: 'insert', collection: 'cardFollows', id: randomUUID(), fields: { cardId: id, userId, isPermanent: true, createdAt: timestamp } });
  }
  const card = cardDto({ ...fields, id, rank: encodeRank(rank), revision: 1, createdAt: new Date(timestamp) }, board, list);
  return { effects, result: { data: { card, listRevision: parent.revision + 1, listOrderVersion: nextVersion.data } },
    audit: audit('cards.create', id), events: [changedCard(boardId, id, 1),
      ...(placement.length ? [{ boardId, kind: 'board.invalidated', payload: {} }] : [])] };
}

function transitionStopwatch(current: CardStopwatch, action: NonNullable<CardUpdate['stopwatchAction']>, timestamp: string): NonNullable<CardStopwatch> {
  const total = current?.total ?? 0;
  if (action === 'reset') return { startedAt: null, total: 0 };
  if (action === 'start' && !current?.startedAt) return { startedAt: timestamp, total };
  if (action === 'stop' && current?.startedAt) {
    const seconds = Math.max(0, Math.floor((Date.parse(timestamp) - Date.parse(current.startedAt)) / 1000));
    if (Number.isSafeInteger(total + seconds)) return { startedAt: null, total: total + seconds };
  }
  throw new RelationshipError('cardStopwatch');
}

async function cardCover(records: WorkspaceRecords, access: CardAccessContext, id: string | null) {
  if (id === null) return null;
  const reference = await records.get('attachments', id);
  if (!reference || reference.cardId !== access.card.id || reference.kind !== 'file' || reference.deletedAt != null) {
    throw new WorkspaceAccessError('missing');
  }
  if (reference.availability === unavailableMedia) return id;
  if (reference.availability === availableMedia && reference.blobDigest && await records.first('blobs', {
    digest: reference.blobDigest, lifecycleState: availableMedia,
    'variants.small.digest': { $type: 'string' }, 'variants.large.digest': { $type: 'string' },
  })) return id;
  throw new RelationshipError('cardCover');
}

export async function planCardUpdate(records: WorkspaceRecords, access: CardAccessContext,
  input: CardUpdate, context: CommandPlanningContext,
): Promise<CommandPlan> {
  const { card, list, board } = access;
  const { generationId, timestamp } = context;
  const id = card.id;
  const boardId = board.board.id;
  const revision = requireRevision(card, input.expectedRevision)!;
  const currentClosed = cardClosed(card, list);
  const closed = input.closed ?? currentClosed;
  const type = input.type === undefined ? card.type : readCardType(input.type,
    boardPreferences(board.board, await boardPreferencesRow(records, generationId, boardId)));
  const currentDue = cardDue(card);
  const dueDate = input.dueDate === undefined ? currentDue.dueDate : input.dueDate;
  if (dueDate === null && input.dueDateCompleted !== undefined) throw new RelationshipError('cardDue');
  const dueDateCompleted = dueDate === null ? null : input.dueDateCompleted ?? currentDue.dueDateCompleted ?? false;
  const currentWatch = cardStopwatch(card.stopwatch);
  const stopwatch = input.stopwatchAction ? transitionStopwatch(currentWatch, input.stopwatchAction, timestamp) : currentWatch;
  const currentCover = card.coverAttachmentId ?? null;
  const coverAttachmentId = input.coverAttachmentId === undefined ? currentCover : await cardCover(records, access, input.coverAttachmentId);
  const name = input.name ?? card.name;
  const fields: JournalFields = {
    ...(name !== card.name && { name }),
    ...(type !== card.type && { type }),
    ...(input.description !== undefined && input.description !== (card.description ?? null) && { description: input.description }),
    ...(closed !== currentClosed && { closed }),
    ...((dueDate !== currentDue.dueDate || dueDateCompleted !== currentDue.dueDateCompleted) && { dueDate, dueDateCompleted }),
    ...(input.stopwatchAction && (stopwatch?.startedAt !== currentWatch?.startedAt || stopwatch?.total !== currentWatch?.total) && { stopwatch }),
    ...(coverAttachmentId !== currentCover && { coverAttachmentId }),
  };
  const makeResult = (next: Parameters<typeof cardDto>[0]) => ({ data: { card: cardDto(next, board, list), stopwatch, coverAttachmentId } });
  if (!Object.keys(fields).length) return { effects: [], result: makeResult(card), audit: audit('cards.update', id) };
  const parent = touchRevision('cards', card, timestamp, revision);
  const next = { ...card, revision: revision + 1, name, type, closed, dueDate, dueDateCompleted, updatedAt: new Date(timestamp) };
  const links = closed === currentClosed ? null : await planLinkedCardCompletion(records, generationId, { id, boardId }, closed, timestamp);
  return {
    effects: [{ ...parent, fields: { ...parent.fields, ...fields } }, ...(links?.effects ?? [])],
    result: makeResult(next), audit: audit('cards.update', id),
    events: [changedCard(boardId, id, next.revision), ...(links?.events ?? [])],
  };
}
