import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePreflightOptions } from '../../packages/contracts/src/native-config.ts';

test('native preflight canonicalizes HTTPS origins and validates private ports', () => {
  assert.deepEqual(parsePreflightOptions(['--public-url', 'https://Planner.example.test:443/']), {
    publicUrl: 'https://planner.example.test', appPort: 27430, dbPort: 27431, json: false,
  });
  assert.deepEqual(parsePreflightOptions(['--json', '--db-port', '27531', '--public-url', 'https://planner.example.test:9443', '--app-port', '27530']), {
    publicUrl: 'https://planner.example.test:9443', appPort: 27530, dbPort: 27531, json: true,
  });
  for (const origin of ['http://example.test', 'https:/example.test', 'https://user:pass@example.test', 'https://@example.test',
    'https://example.test/path', 'https://example.test/..', 'https://example.test?q=1', 'https://example.test/#x', 'https://example.test?']) {
    assert.throws(() => parsePreflightOptions(['--public-url', origin]), /HTTPS public origin/u);
  }
  const base = ['--public-url', 'https://planner.example.test'];
  for (const args of [['--app-port', '0'], ['--db-port', '65536'], ['--app-port', '027430'], ['--app-port', '27431'], ['--db-port', '27017'], ['--app-port', 'abc']]) {
    assert.throws(() => parsePreflightOptions([...base, ...args]), /port/iu);
  }
  for (const args of [[], ['--json', '--json', ...base], [...base, '--db-port'], [...base, ...base], [...base, '--other']]) {
    assert.throws(() => parsePreflightOptions(args));
  }
});
