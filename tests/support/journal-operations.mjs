import { randomUUID } from 'node:crypto';

export const installationId = '20ee0249-8447-44b5-ade6-772d3025846f';
export const generationId = 'd40befaf-bd29-4bfc-aa83-4d477e419db5';
export const stagedGenerationId = 'f7d50ef1-dfcc-4a80-aa75-bc6bb3784212';
export const actorId = '92412793-27bb-4622-974b-4a145989b21b';
export const leftId = '63d5d824-014c-450f-882d-b383183b7cb8';
export const rightId = '90ac4391-14f4-4d3e-843d-a562ee1f6c08';
export const boardId = 'a56d522d-6a1e-4dce-a1cb-57fa2b7157c8';
export const memberId = 'f6d7667f-8692-48fd-9e10-3cce4a09cd13';
export const key = 'f5a2aa91-9620-45af-92d3-52fbfa94e3d8';
export const input = { amount: ' 3 ', leftRevision: 1, rightRevision: 1 };
export const request = { actorId, operationId: 'projects.transfer', idempotencyKey: key, input };

function normalize(value) {
  const amount = typeof value?.amount === 'string' ? Number(value.amount.trim()) : value?.amount;
  const { leftRevision, rightRevision } = value ?? {};
  if (!Number.isSafeInteger(amount) || amount <= 0
      || !Number.isSafeInteger(leftRevision) || !Number.isSafeInteger(rightRevision)) {
    throw new TypeError('Invalid transfer.');
  }
  return { amount, leftRevision, rightRevision };
}

export function journalOperations(CleanCommandRejection) {
  async function authorize(context) {
    const [actor, target] = await Promise.all([context.read('users', context.actorId), context.read('projects', leftId)]);
    if (!actor || actor.disabled || !target || target.hiddenFromActor) throw new CleanCommandRejection('Access denied.');
  }

  const transfer = (events) => ({
    normalize, authorize,
    async plan(context, { amount, leftRevision, rightRevision }) {
      const [left, right] = await Promise.all([context.read('projects', leftId), context.read('projects', rightId)]);
      if (left?.revision !== leftRevision || right?.revision !== rightRevision || left.balance < amount) {
        throw new CleanCommandRejection('Original revisions have changed.');
      }
      const labelId = randomUUID();
      return {
        effects: [
          { kind: 'update', collection: 'projects', id: leftId, revision: leftRevision, fields: { balance: left.balance - amount } },
          { kind: 'update', collection: 'projects', id: rightId, revision: rightRevision, fields: { balance: right.balance + amount } },
          { kind: 'delete', collection: 'boardMembers', id: memberId, revision: null },
          { kind: 'insert', collection: 'labels', id: labelId, fields: { boardId, name: 'Transfer receipt' } },
        ],
        result: { commandId: context.commandId, receivedAt: context.timestamp, balance: right.balance + amount, labelId },
        audit: { resourceId: leftId, resourceType: 'project', action: 'projects.transfer' },
        ...(events && { events: [{ boardId, kind: 'balance.changed', payload: { id: leftId, revision: leftRevision + 1 } },
          { boardId, kind: 'balance.changed', payload: { id: rightId, revision: rightRevision + 1 } }] }),
      };
    },
  });

  return {
    'projects.transfer': transfer(true),
    'enrollment.fixture': transfer(false),
  };
}
