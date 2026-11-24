import type { EditorMode } from './card-markdown.js';

const databaseName = 'planner-description-drafts';
const storeName = 'drafts';
const lifetime = 7 * 24 * 60 * 60 * 1000;

export type DescriptionDraft = {
  version: string;
  markdown: string;
  baseRevision: number;
  mode: EditorMode;
  editedAt: number;
};

let opened: Promise<IDBDatabase | undefined> | undefined;

function openDraftDatabase() {
  opened ??= new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(undefined); return; }
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(databaseName, 1); }
    catch { resolve(undefined); return; }
    let blocked = false;
    request.onupgradeneeded = () => request.result.createObjectStore(storeName).createIndex('editedAt', 'editedAt');
    request.onerror = () => resolve(undefined);
    request.onblocked = () => { blocked = true; resolve(undefined); };
    request.onsuccess = () => {
      const database = request.result;
      if (blocked) { database.close(); return; }
      database.onversionchange = () => { database.close(); opened = undefined; };
      resolve(database);
    };
  });
  return opened;
}

async function draftOperation<T>(run: (store: IDBObjectStore, result: (value: T) => void) => void) {
  const database = await openDraftDatabase();
  if (!database) return undefined;
  try {
    return await new Promise<T | undefined>((resolve) => {
      let value: T | undefined;
      const transaction = database.transaction(storeName, 'readwrite');
      transaction.oncomplete = () => resolve(value);
      transaction.onabort = () => resolve(undefined);
      run(transaction.objectStore(storeName), (result) => { value = result; });
    });
  } catch { return undefined; }
}

function validDraft(value: unknown): value is DescriptionDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<DescriptionDraft>;
  return typeof draft.version === 'string' && typeof draft.markdown === 'string'
    && Number.isSafeInteger(draft.baseRevision) && Number.isSafeInteger(draft.editedAt)
    && (draft.mode === 'markup' || draft.mode === 'wysiwyg');
}

export function readDescriptionDraft(key: string, now = Date.now()) {
  return draftOperation<DescriptionDraft>((store, record) => {
    const cutoff = now - lifetime;
    const expired = store.index('editedAt').openKeyCursor(IDBKeyRange.upperBound(cutoff));
    expired.onsuccess = () => {
      const cursor = expired.result;
      if (!cursor) return;
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
    const request = store.get(key);
    request.onsuccess = () => {
      const draft: unknown = request.result;
      if (validDraft(draft) && draft.editedAt > cutoff) record(draft);
    };
  });
}

export function writeDescriptionDraft(key: string, draft: DescriptionDraft, expectedVersion?: string) {
  return draftOperation<void>((store) => {
    const request = store.get(key);
    request.onsuccess = () => {
      const current: unknown = request.result;
      if (expectedVersion !== undefined ? validDraft(current) && current.version === expectedVersion
        : !validDraft(current) || draft.editedAt >= current.editedAt) store.put(draft, key);
    };
  });
}

export function clearDescriptionDraft(key: string, version: string) {
  return draftOperation<void>((store) => {
    const request = store.get(key);
    request.onsuccess = () => {
      const current: unknown = request.result;
      if (validDraft(current) && current.version === version) store.delete(key);
    };
  });
}
