import type { AggregateOptions, Db, Document, Filter, Long, Sort } from 'mongodb';
import type { SessionActor, projectGradientSchema } from '@planner/contracts';
import { publicIdPattern } from '@planner/contracts/storage';
import { workspaceKey } from '../../storage/identity.js';

type SiteRole = SessionActor['role'];
type FieldScope = 'project' | 'board' | 'card';
type ListKind = 'active' | 'closed' | 'archive' | 'trash';
type CardKind = 'board' | 'archive' | 'trash';
type CardType = 'project' | 'story';
type BoardView = 'kanban' | 'grid' | 'list';

interface Entity {
  _id: string;
  generationId: string;
  id: string;
  revision: number;
  createdAt: Date;
  updatedAt?: Date | null;
}

type Ordered = { name: string; rank?: Long | null };
interface Records {
  users: { name: string; username?: string | null; role: SiteRole; disabledAt: Date | null };
  projects: Ordered & { type: 'private' | 'shared'; boardOrderVersion?: number; ownerProjectManagerId: string | null; hidden: boolean; description?: string | null; backgroundId?: string | null; backgroundPreset?: typeof projectGradientSchema.options[number] | null };
  projectManagers: { projectId: string; userId: string };
  projectFavorites: { projectId: string; userId: string };
  projectBackgrounds: { projectId: string; name: string; kind: 'preset' | 'file'; blobDigest?: string | null; availability?: string | null; deletedAt?: Date | null };
  boards: Ordered & { projectId: string; defaultView?: BoardView; orderVersion?: number };
  boardMembers: { boardId: string; userId: string; role: 'editor' | 'viewer'; canComment: boolean | null };
  boardPreferences: {
    boardId: string; defaultView?: BoardView; defaultCardType?: CardType | null; restrictedCardType?: CardType | null;
    showCreator?: boolean; showCardAge?: boolean; showCardCount?: boolean; expandChecklists?: boolean;
  };
  lists: Ordered & { boardId: string; kind: ListKind; orderVersion?: number };
  cards: Ordered & {
    boardId: string; listId: string; kind: CardKind; type: CardType; closed?: boolean;
    description?: string | null; previousListId?: string | null; dueDate?: Date | string | null;
    listChangedAt?: Date | null; historySequence?: Long; coverAttachmentId?: string | null;
  };
  labels: Omit<Ordered, 'name'> & { name?: string | null; boardId: string; color?: string | null };
  cardLabels: { cardId: string; labelId: string };
  cardAssignees: { cardId: string; userId: string };
  boardFollows: { boardId: string; userId: string };
  cardFollows: { cardId: string; userId: string };
  checklists: Ordered & { cardId: string; showOnFront?: boolean; hideCompleted?: boolean };
  tasks: {
    checklistId: string; rank?: Long | null; name?: string; completed?: boolean; assigneeId?: string | null;
    linkedCardId?: string | null; linkedUnavailable?: boolean;
  };
  fieldGroups: Ordered & { scopeType: FieldScope; scopeId: string; templateGroupId?: string | null };
  fieldDefinitions: Ordered & { fieldGroupId: string; showOnFront?: boolean };
  fieldValues: { cardId: string; fieldGroupId: string; fieldDefinitionId: string; value: string };
  comments: { boardId: string; cardId: string; authorId?: string | null; text: string };
  activities: { boardId: string; cardId?: string | null };
  notifications: { boardId?: string | null; cardId?: string | null };
  attachments: { cardId: string; name: string; kind: 'file' | 'link'; byteLength?: number | null; blobDigest?: string | null; url?: string | null; availability?: string | null; deletedAt?: Date | null };
  blobs: { digest: string; lifecycleState: string; byteLength: number };
  events: { boardId: string; sequence: Long };
}
export type WorkspaceRecordName = keyof Records;
export type WorkspaceRow<K extends WorkspaceRecordName> = Entity & Records[K];

export const rankSort = { rank: 1, id: 1 } as const;

export const equal = (field: string, value: string) => ({ $eq: ['$' + field, value] });

export function publicIdField(field: string) {
  return { $cond: [
    { $eq: [{ $type: '$' + field }, 'string'] },
    { $regexMatch: { input: '$' + field, regex: publicIdPattern } },
    false,
  ] };
}

export function canonicalRow(generationId: string) {
  return { $cond: [
    publicIdField('id'),
    { $and: [equal('generationId', generationId), { $eq: ['$_id', { $concat: [generationId, '/', '$id'] }] }] },
    false,
  ] };
}

export const directBoardRole = { $in: ['$role', ['editor', 'viewer']] };

export async function together<T extends readonly unknown[] | []>(values: T) {
  const results = await Promise.allSettled(values);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  const fulfilled = results.map((result) => (result as PromiseFulfilledResult<unknown>).value);
  return fulfilled as { -readonly [Index in keyof T]: Awaited<T[Index]> };
}

export function createWorkspaceRecords(database: Db, generationId: string) {
  function collection<K extends WorkspaceRecordName>(name: K) {
    return database.collection<WorkspaceRow<K>>(name);
  }
  const scoped = <K extends WorkspaceRecordName>(filter: Document) => ({ ...filter, generationId } as Filter<WorkspaceRow<K>>);
  const personProjection = { _id: 1, generationId: 1, id: 1, name: 1, username: 1, role: 1, disabledAt: 1 };
  return {
    get<K extends WorkspaceRecordName>(name: K, id: string) {
      return collection(name).findOne(scoped<K>({
        _id: workspaceKey(generationId, id), id, $expr: { $and: [equal('id', id), equal('generationId', generationId)] },
      }),
        { promoteLongs: false, ...(name === 'users' && { projection: personProjection }) });
    },
    first<K extends WorkspaceRecordName>(name: K, filter: Document, sort?: Sort) {
      return collection(name).findOne(scoped<K>(filter),
        { sort, promoteLongs: false, ...(name === 'users' && { projection: personProjection }) });
    },
    find<K extends WorkspaceRecordName>(name: K, filter: Document, sort?: Sort) {
      return collection(name).find<WorkspaceRow<K>>(scoped<K>(filter),
        { sort, promoteLongs: false, ...(name === 'users' && { projection: personProjection }) }).toArray();
    },
    count<K extends WorkspaceRecordName>(name: K, filter: Document) {
      return collection(name).countDocuments(scoped<K>(filter));
    },
    aggregate<Result extends Document>(
      name: WorkspaceRecordName, filter: Document, stages: Document[], options?: Pick<AggregateOptions, 'maxTimeMS'>,
    ) {
      return database.collection(name).aggregate<Result>([{ $match: { ...filter, generationId } }, ...stages],
        { promoteLongs: false, ...options }).toArray();
    },
    lookup(name: WorkspaceRecordName, as: string, variables: Document, filter: Document, tail: Document[] = []): Document {
      return { $lookup: { from: name, as, let: variables, pipeline: [{ $match: { ...filter, generationId } }, ...tail] } };
    },
  };
}

export type WorkspaceRecords = ReturnType<typeof createWorkspaceRecords>;
