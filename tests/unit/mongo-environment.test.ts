import assert from 'node:assert/strict';
import test from 'node:test';
import { assertOwnedMongoEnvironment } from '../support/mongo-environment.ts';

test('fixture guard accepts no external MongoDB target, configuration or arguments', () => {
  const refused = [
    { MONGO_URI: 'mongodb://127.0.0.1:27017/planner' },
    { PLANNER_MONGODB_URI: 'mongodb+srv://outside.invalid/planner' },
    { DATABASE_URL: 'mongodb://%2Ftmp%2Fforeign.sock/planner' },
    { MONGODB_SOCKET: '/tmp/foreign.sock' },
    { PLANNER_MONGO_PORT: '27017' },
    { MONGO_HOST: 'api.example.invalid' },
    { MONGODB_CONFIG: '/etc/mongod.conf' },
  ];
  for (const env of refused) {
    assert.throws(() => assertOwnedMongoEnvironment(env), /only uses its own MongoDB fixture/u);
  }
  assert.throws(() => assertOwnedMongoEnvironment({}, ['mongodb://127.0.0.1:27017']), /only uses its own MongoDB fixture/u);
  assert.doesNotThrow(() => assertOwnedMongoEnvironment({ DATABASE_URL: 'postgresql://localhost/test' }));
});
