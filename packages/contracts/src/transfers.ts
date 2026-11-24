import { z } from 'zod';
import { publicIdSchema, revisionSchema } from './storage.js';

export const transferListPosition = z.strictObject({ listId: publicIdSchema, revision: revisionSchema, orderVersion: revisionSchema });

const count = z.number().int().nonnegative();
export const transferSummary = z.strictObject({
  labelsRemapped: count, labelsCreated: count, removedAssignees: count, removedFollows: count,
  clearedTaskAssignees: count, fieldGroupsMaterialized: count,
});
