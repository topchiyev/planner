import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { JournalValue } from '../command-journal/operation.js';
import { CleanCommandRejection } from '../command-gate/gate.js';

export class InvalidPageCursor extends CleanCommandRejection {}

export type CursorScope = Readonly<{
  actorId: string;
  generationId: string;
  operation: string;
  query: readonly string[];
  order: string;
}>;

function authenticatedScope(scope: CursorScope) {
  return Buffer.from(JSON.stringify(['planner-cursor-v1', scope.actorId, scope.generationId, scope.operation, scope.query, scope.order]));
}

export function createPageCursors() {
  const key = randomBytes(32);
  return Object.freeze({
    encode(scope: CursorScope, position: JournalValue) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(authenticatedScope(scope));
      const data = Buffer.concat([cipher.update(JSON.stringify(position), 'utf8'), cipher.final()]);
      return 'v1.' + Buffer.concat([nonce, cipher.getAuthTag(), data]).toString('base64url');
    },
    decode(scope: CursorScope, cursor: string): unknown {
      try {
        if (cursor.length > 2048 || !/^v1\.[A-Za-z0-9_-]+$/u.test(cursor)) throw new Error();
        const encoded = cursor.slice(3);
        const bytes = Buffer.from(encoded, 'base64url');
        if (bytes.length <= 28 || bytes.toString('base64url') !== encoded) throw new Error();
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        decipher.setAuthTag(bytes.subarray(12, 28));
        decipher.setAAD(authenticatedScope(scope));
        const payload = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
        return JSON.parse(payload.toString('utf8'));
      } catch {
        throw new InvalidPageCursor('The page cursor is invalid or no longer applies.');
      }
    },
  });
}

// A service restart invalidates cursors. The next request can start a fresh snapshot.
export const pageCursors = createPageCursors();
