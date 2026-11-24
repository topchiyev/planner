import type { Document } from 'mongodb';
import { memberRoles } from './relationship-policy.js';
import { canonicalRow, directBoardRole, equal, type WorkspaceRecords, type WorkspaceRow } from './records.js';

type Person = Pick<WorkspaceRow<'users'>, 'id' | 'name' | 'username'>;

export async function eligibleBoardPeople(records: WorkspaceRecords, generationId: string, boardId: string,
  filter: Document = {}, stages: Document[] = []) {
  const canonical = canonicalRow(generationId);
  const people = await records.aggregate<Person>('users', {
    ...filter, $expr: { $and: [canonical, { $eq: [{ $type: '$disabledAt' }, 'null'] }, { $in: ['$role', memberRoles] }] },
  }, [
    records.lookup('boardMembers', 'member', { userId: '$id' }, {
      boardId,
      $expr: { $and: [canonical, equal('boardId', boardId), { $eq: ['$userId', '$$userId'] }, directBoardRole] },
    }, [{ $limit: 1 }, { $project: { _id: 1 } }]),
    { $match: { 'member.0': { $exists: true } } },
    ...stages,
    { $project: { _id: 0, id: 1, name: 1, username: 1 } },
  ]);
  return people.map(({ id, name, username }) => ({ id, name, username: username ?? null }));
}
