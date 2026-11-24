import {
  generationIdSchema, nonnegativeIntegerSchema, normalizedEmailSchema, parseSourceIdentity, publicIdSchema, revisionSchema,
  sourceUuidSchema, utcInstantSchema,
} from '@planner/contracts/storage';
import { Long, type Db, type Filter } from 'mongodb';
import { workspaceCollections, type WorkspaceCollection } from './catalog.js';
import { decodeRank, encodeRank, readLongField, readStoredInstant, signedLongFields, storedInstantFields, workspaceKey } from './identity.js';
import { readInstallation, requireCurrentSchema, verifyStorageSchema } from './schema.js';

type Value = null | boolean | number | bigint | string | Date | Value[] | { [key: string]: Value };
export type WorkspaceFields = Record<string, Value>;
interface WorkspaceDocument {
  _id: string;
  id: string;
  generationId: string;
  revision?: number;
  [key: string]: unknown;
}

const indexedCollections = new Set<WorkspaceCollection>(workspaceCollections);
const protectedCollections = new Set<WorkspaceCollection>([
  'sessions', 'recoveryGrants', 'trustedDevices', 'oauthArtifacts', 'oauthConnections',
]);
const identityFields = new Set(['_id', 'id', 'generationId', 'revision', 'commandEffectId']);
const versionedCollections = new Set<WorkspaceCollection>([
  'users', 'projects', 'boards', 'boardPreferences', 'lists', 'cards', 'labels', 'checklists', 'tasks',
  'fieldGroups', 'fieldDefinitions', 'fieldValues', 'comments', 'attachments', 'projectBackgrounds', 'notifications',
]);
const integer64Fields = new Set<string>(signedLongFields);
const sizeFields = new Set(['byteLength', 'batch']);
const dates = new Set<string>(storedInstantFields);
const nullablePublicReference = publicIdSchema.nullable();
const publicReferences = new Set([
  'actorId', 'assigneeId', 'boardId', 'cardId', 'checklistId', 'commandId', 'definitionOrderTieId', 'fieldDefinitionId', 'fieldGroupId',
  'labelId', 'linkedCardId', 'listId', 'projectId', 'recipientId', 'resourceId', 'runId', 'scopeId', 'userId',
]);
const writeConcern = { w: 1, j: true };

function validateField(field: string) {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/u.test(field) || ['constructor', 'prototype'].includes(field)) {
    throw new TypeError('Workspace fields must have ordinary names.');
  }
}

function toInstant(value: unknown) {
  if (typeof value === 'string') return new Date(utcInstantSchema.parse(value));
  return readStoredInstant(value);
}

function encodeValue(value: unknown): unknown {
  if (typeof value === 'bigint') return encodeRank(value);
  if (value instanceof Date) return toInstant(value);
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([field, stored]) => {
      validateField(field);
      return [field, encodeValue(stored)];
    }));
  }
  throw new TypeError('Expected an explicit supported workspace field value.');
}

export function encodeWorkspaceFields(fields: WorkspaceFields) {
  if (!fields || Object.getPrototypeOf(fields) !== Object.prototype) {
    throw new TypeError('Expected workspace fields as an object.');
  }
  return Object.fromEntries(Object.entries(fields).map(([field, value]) => {
    if (identityFields.has(field)) throw new TypeError('Workspace identity fields cannot be overridden.');
    if (field === 'localAuth' || field === 'accountChange') throw new TypeError('Account credentials require protected storage access.');
    validateField(field);
    if (integer64Fields.has(field)) return [field, (field === 'rank' && value === null) ? null : encodeRank(value as bigint | string)];
    if (dates.has(field)) return [field, toInstant(value)];
    if (sizeFields.has(field)) return [field, nonnegativeIntegerSchema.parse(value)];
    if (publicReferences.has(field)) return [field, nullablePublicReference.parse(value)];
    if (field === 'normalizedEmail') return [field, normalizedEmailSchema.parse(value)];
    if (field === 'normalizedUsername' || field === 'providerGrantId') {
      if (typeof value !== 'string' && value !== null) {
        throw new TypeError('Expected a concrete string or an explicit optional identifier.');
      }
      return [field, value];
    }
    if (field === 'sourceInstanceId') return [field, sourceUuidSchema.parse(value)];
    return [field, encodeValue(value)];
  }));
}

export function workspaceInsertFields(name: WorkspaceCollection, fields: WorkspaceFields, revision?: number) {
  const record = encodeWorkspaceFields(fields);
  if (name === 'users' && !record.normalizedEmail) throw new TypeError('A user requires a normalized email.');
  if (name === 'importIds') parseSourceIdentity(record.entity, record.sourceId);
  const initial = revision === undefined && !versionedCollections.has(name) ? undefined : revisionSchema.parse(revision ?? 1);
  return { ...record, ...(initial === undefined ? {} : { revision: initial }) };
}

function decodeValue(value: unknown): Value {
  if (Long.isLong(value)) return decodeRank(value);
  if (value instanceof Date) return toInstant(value);
  if (value === null || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([field, stored]) => [field, decodeValue(stored)]));
  }
  throw new TypeError('The workspace record contains an unsupported BSON value.');
}

function scopedWorkspace(database: Db, installationId: string, generationId: string, kind: 'active' | 'staged') {
  const collection = (name: WorkspaceCollection) => {
    if (!indexedCollections.has(name)) throw new TypeError('Expected a workspace collection.');
    return database.collection<WorkspaceDocument>(name);
  };
  const lookup = (id: string): Filter<WorkspaceDocument> => ({ _id: workspaceKey(generationId, id), generationId, id });
  async function checkBinding() {
    const installation = await readInstallation(database, installationId);
    requireCurrentSchema(installation);
    if ((kind === 'active') !== (installation.activeGenerationId === generationId)) {
      throw new Error('The bound workspace generation has changed state.');
    }
  }
  return Object.freeze({
    generationId,
    async read(name: WorkspaceCollection, id: string) {
      if (protectedCollections.has(name)) throw new TypeError('Expected a collection available to the workspace.');
      const source = collection(name);
      const filter = lookup(id);
      await checkBinding();
      const stored = await source.findOne(filter, {
        promoteLongs: false,
        ...(name === 'users' && { projection: { localAuth: 0, accountChange: 0 } }),
        ...(name === 'tasks' && { projection: { linkedUnavailableProvenance: 0 } }),
        ...(name === 'cards' && { projection: { previousListProvenance: 0, transferredAcrossBoards: 0 } }),
        ...(name === 'lists' && { projection: { transferredAcrossBoards: 0 } }),
        ...(name === 'fieldDefinitions' && { projection: { definitionOrderTieId: 0 } }),
        ...(name === 'importIds' && { projection: { provenance: 0, order: 0, reference: 0 } }),
      });
      if (!stored) return null;
      const { _id, generationId: storedGeneration, commandEffectId, ...logical } = stored;
      return Object.fromEntries(Object.entries(logical).map(([field, value]) => {
        if (integer64Fields.has(field)) return [field, readLongField(field, value)];
        if (dates.has(field)) return [field, readStoredInstant(value, field)];
        if (field === 'revision') return [field, revisionSchema.parse(value)];
        return [field, decodeValue(value)];
      }));
    },
    async insert(name: WorkspaceCollection, id: string, fields: WorkspaceFields, revision?: number) {
      const source = collection(name);
      const record = workspaceInsertFields(name, fields, revision);
      const key = workspaceKey(generationId, id);
      await checkBinding();
      await source.insertOne({
        ...record, _id: key, generationId, id,
      }, { writeConcern });
    },
    async update(name: WorkspaceCollection, id: string, fields: WorkspaceFields, expectedRevision: number) {
      const source = collection(name);
      const filter = lookup(id);
      const revision = revisionSchema.parse(expectedRevision);
      const nextRevision = revisionSchema.parse(revision + 1);
      const changes = encodeWorkspaceFields(fields);
      if (name === 'importIds' && ('entity' in changes || 'sourceId' in changes)) {
        throw new TypeError('Source mapping identities cannot be updated.');
      }
      await checkBinding();
      const result = await source.updateOne({ ...filter, revision },
        { $set: { ...changes, revision: nextRevision } }, { writeConcern });
      return result.matchedCount === 1;
    },
    async delete(name: WorkspaceCollection, id: string, expectedRevision?: number) {
      const source = collection(name);
      const filter = lookup(id);
      const selection = expectedRevision === undefined ? filter : { ...filter, revision: revisionSchema.parse(expectedRevision) };
      await checkBinding();
      return (await source.deleteOne(selection, { writeConcern })).deletedCount === 1;
    },
  });
}

export async function openActiveWorkspace(database: Db, installationId: string) {
  const installation = await verifyStorageSchema(database, installationId);
  if (!installation.activeGenerationId) throw new Error('No active workspace generation is available.');
  return scopedWorkspace(database, installationId, installation.activeGenerationId, 'active');
}

// Only privileged import and maintenance code may supply this explicit inactive selection.
export async function openTrustedStagedWorkspace(database: Db, installationId: string, stagedGenerationId: string) {
  const generationId = generationIdSchema.parse(stagedGenerationId);
  const installation = await verifyStorageSchema(database, installationId);
  if (installation.activeGenerationId === generationId) throw new Error('The selected workspace generation is active.');
  return scopedWorkspace(database, installationId, generationId, 'staged');
}
