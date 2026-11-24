import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { csrfToken, readSessionCookie } from '../../apps/backend/dist/application/auth/credentials.js';
import { assertOwnedMongoEnvironment } from '../support/mongo-environment.ts';
import { cookieOf, ids, makeWorkspaceAccessFixture, origin } from '../support/workspace-access-fixture.mjs';
import { withFixtureMongo } from '../support/fixture-mongo.ts';

assertOwnedMongoEnvironment(process.env);
const path = (id) => '/api/v1/projects/' + id + '/favorite';

async function actor(f, id) {
  const loggedIn = await f.login(id);
  assert.equal(loggedIn.status, 200);
  return cookieOf(loggedIn);
}

function change(f, cookie, method, url, revision, key = randomUUID(), headers = {}) {
  return f.call(url, cookie, { method, headers: {
    Origin: origin, 'X-CSRF-Token': csrfToken(readSessionCookie(cookie)),
    'Idempotency-Key': key, 'If-Match': '"' + revision + '"', ...headers,
  } });
}

test('favorite writes preserve shared revisions and current visibility on scoped journal retries', { timeout: 75_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const f = await makeWorkspaceAccessFixture(mongo);
    const endpoint = path(ids.privateProject);
    const members = '/api/v1/boards/' + ids.privateBoard + '/members/' + ids.viewer;
    try {
      const owner = await actor(f, ids.privateOwner);
      const viewer = await actor(f, ids.viewer);
      const admin = await actor(f, ids.admin);
      const unrelated = await actor(f, ids.unrelated);
      assert.equal((await change(f, admin, 'PUT', endpoint, 1)).status, 404);
      assert.equal((await change(f, unrelated, 'PUT', endpoint, 1)).status, 404);
      assert.equal((await change(f, viewer, 'PUT', endpoint, 1, randomUUID(), { Origin: 'https://other.invalid' })).status, 403);
      assert.equal((await change(f, viewer, 'PUT', endpoint, 1, randomUUID(), { 'If-Match': '*' })).status, 422);
      assert.equal((await change(f, viewer, 'PUT', endpoint, 2)).status, 409);

      const key = randomUUID();
      const added = await change(f, viewer, 'PUT', endpoint, 1, key);
      assert.equal(added.status, 200);
      assert.deepEqual(added.data, { data: { id: ids.privateProject, revision: 1, favorite: true } });
      assert.deepEqual((await change(f, viewer, 'PUT', endpoint, 1, key)).data, added.data);
      assert.deepEqual((await change(f, viewer, 'PUT', endpoint, 1)).data, added.data);
      const favorites = '/api/v1/projects?favorite=true';
      assert.deepEqual((await f.call(favorites, viewer)).data.data.map(({ id }) => id), [ids.privateProject]);
      assert.deepEqual((await f.call(favorites, owner)).data.data, []);
      assert.equal((await change(f, owner, 'PUT', endpoint, 1)).status, 200);
      for (const removalKey of [randomUUID(), randomUUID()]) {
        const response = await change(f, viewer, 'DELETE', endpoint, 1, removalKey);
        assert.equal(response.status, 204);
        assert.equal(response.data, '');
      }
      assert.equal(await f.db.collection('projectFavorites').countDocuments({ ...f.scope, projectId: ids.privateProject }), 1);
      assert.equal((await f.db.collection('projects').findOne({ ...f.scope, id: ids.privateProject })).revision, 1);
      assert.equal(await f.db.collection('events').countDocuments(f.scope), 0);
      assert.equal(await f.db.collection('projectFavorites').countDocuments({ generationId: f.stagedGenerationId }), 0);
      const audits = await f.db.collection('auditEntries').find(f.scope).toArray();
      assert.ok(audits.length > 0);
      assert.ok(audits.every((audit) => audit.resourceType === 'account' && audit.actorId === audit.resourceId));

      // A retry never restores or exposes a private favorite after the actor loses the last project read path.
      assert.equal((await change(f, owner, 'DELETE', members, 1)).status, 204);
      assert.equal((await change(f, viewer, 'PUT', endpoint, 1, key)).status, 404);
      assert.deepEqual((await f.call(favorites, owner)).data.data.map(({ id }) => id), [ids.privateProject]);
    } finally { await f.close(); }
  });
});
