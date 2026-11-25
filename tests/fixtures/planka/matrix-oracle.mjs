import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

// These counts come from the hand-authored fixture statements. Do not derive them from Planner's reports.
const inputs = {
  action: 2, attachment: 6, background_image: 1, base_custom_field_group: 1, board: 2,
  board_membership: 5, board_subscription: 1, card: 6, card_label: 1, card_membership: 1,
  card_subscription: 1, comment: 1, config: 1, custom_field: 1, custom_field_group: 2,
  custom_field_value: 2, internal_config: 1, label: 1, list: 7, migration: 23, migration_lock: 1,
  notification: 2, notification_service: 1, project: 2, project_favorite: 1, project_manager: 2,
  session: 1, storage_usage: 1, task: 3, task_list: 1, trusted_device: 0, uploaded_file: 5,
  user_account: 5, webhook: 1,
};
const excluded = new Set(['config', 'internal_config', 'migration', 'migration_lock', 'notification_service',
  'session', 'storage_usage', 'trusted_device', 'webhook']);

export const sharedImageKey = 'private/attachments/9007199254741220/Re\u0301seau Tile.png';
export const sharedTextKey = 'private/attachments/9007199254741221/Fixture Deck.txt';
export const privateTextKey = 'private/attachments/9007199254741222/Alternate Deck.txt';
export const missingOriginal = { type: 'uploaded_file', sourceId: '9007199254741220', reason: 'missing-original' };
export const releasePins = {
  '2.3.0': 'ce6d499ae16202a727d7dbb9238b48422ab60da9',
  '2.3.1': '27219fd3635e695b2ec4e2a9d9ed6bec6560370f',
};

export function expectedTables(scenario) {
  assert.ok(['clean', 'inconsistent', 'ambiguous'].includes(scenario));
  const result = {};
  for (const [table, input] of Object.entries({ ...inputs, list: scenario === 'clean' ? 8 : 7,
    attachment: scenario === 'ambiguous' ? 7 : 6 })) {
    const excludedCount = excluded.has(table) ? input : 0;
    const quarantined = table === 'notification' && scenario !== 'clean' ? 1 : 0;
    const unavailable = table === 'attachment' ? (scenario === 'inconsistent' ? 2 : scenario === 'ambiguous' ? 1 : 0)
      : Number(table === 'uploaded_file' && scenario === 'inconsistent');
    const blocked = Number(table === 'uploaded_file' && scenario === 'ambiguous');
    const normal = input - excludedCount - quarantined - unavailable - blocked;
    result[table] = Object.fromEntries(Object.entries({ input, normal, quarantined, excluded: excludedCount, unavailable, blocked })
      .map(([key, count]) => [key, String(count)]));
  }
  return result;
}

export function assertReport(report, details, scenario) {
  const clean = scenario === 'clean';
  const ambiguous = scenario === 'ambiguous';
  assert.equal(report.outcome, ambiguous ? 'blocked' : 'verified');
  assert.equal(report.eligibleUnderDefaultPolicy, clean);
  assert.deepEqual(report.tables, expectedTables(scenario));
  assert.deepEqual(report.problems, []);
  assert.deepEqual(report.scopedReads, ambiguous ? null : { boardReads: 2, cardReads: 2, deniedReads: 1 });
  for (const [table, { input, ...parts }] of Object.entries(report.tables)) {
    assert.equal(Number(input), Object.values(parts).reduce((sum, count) => sum + Number(count), 0), table);
  }
  assert.equal(report.assets.originals, ambiguous ? 6 : 5);
  assert.equal(report.assets.derivatives, 4);
  assert.equal(report.assets.missingOriginals, Number(!clean));
  assert.equal(report.assets.missingDerivatives, 0);
  assert.equal(report.assets.targetCatalogs, scenario === 'inconsistent' ? 3 : 4);
  assert.equal(report.targetRows.attachments, ambiguous ? 7 : 6);
  assert.equal(report.targetRows.activities, 2);
  assert.equal(report.targetRows.notifications, clean ? 2 : 1);
  assert.equal(report.targetRows.importQuarantine ?? 0, Number(!clean));
  for (const collection of ['commands', 'events', 'sessions', 'trustedDevices', 'recoveryGrants', 'oauthArtifacts', 'oauthConnections'])
    assert.equal(report.targetRows[collection] ?? 0, 0, collection);
  const has = (table, sourceId, reason) => details.some((row) => row.table === table && row.sourceId === sourceId && row.reasons.includes(reason));
  assert.equal(has('card', '9007199254740996', 'stale-previous-list'), !clean);
  assert.equal(has('action', '711', 'historical-list-unavailable'), !clean);
  assert.equal(details.some(({ table, sourceId, disposition }) => table === 'notification' && sourceId === '721' && disposition === 'quarantined'), !clean);
  assert.equal(has('uploaded_file', missingOriginal.sourceId, missingOriginal.reason), scenario === 'inconsistent');
  assert.equal(has('uploaded_file', missingOriginal.sourceId, 'ambiguous-original'), ambiguous);
  const missingAttachments = details.filter(({ table, disposition }) => table === 'attachment' && disposition === 'unavailable').map(({ sourceId }) => sourceId);
  assert.deepEqual(missingAttachments, clean ? [] : ambiguous ? ['608'] : ['601', '602']);
  assert.match(report.reportSha256, /^[0-9a-f]{64}$/u);
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'image-key') console.log(sharedImageKey);
  else if (command === 'text-key') console.log(sharedTextKey);
  else if (command === 'update-dump-hash') {
    const [directory, dump] = args;
    const manifestPath = join(directory, 'manifest.json');
    const capture = await readJson(manifestPath);
    capture.source.dumpSha256 = sha256(await readFile(join(directory, dump)));
    await writeFile(manifestPath, JSON.stringify(capture) + '\n');
  } else if (command === 'remove-directory-original') {
    const [directory] = args;
    const manifestPath = join(directory, 'manifest.json');
    const assetsPath = join(directory, 'asset-manifest.json');
    const capture = await readJson(manifestPath);
    assert.equal(capture.asset.kind, 'directory');
    const manifest = await readJson(assetsPath);
    const files = manifest.files.filter(({ key }) => key !== sharedImageKey);
    assert.equal(files.length, manifest.files.length - 1);
    const encoded = JSON.stringify({ ...manifest, files }) + '\n';
    capture.asset.manifestSha256 = sha256(encoded);
    await unlink(join(directory, 'assets', sharedImageKey));
    await writeFile(assetsPath, encoded);
    await writeFile(manifestPath, JSON.stringify(capture) + '\n');
  } else if (command === 'write-object-service') {
    const [directory, manifest] = args;
    const capture = await readJson(manifest);
    const port = await readFile(join(directory, 'object-port'), 'utf8');
    assert.match(port, /^[1-9][0-9]{0,4}$/u);
    console.log(JSON.stringify({ objects: { base: `https://127.0.0.1:${port}/frozen/`, snapshotId: capture.asset.snapshotId } }));
  } else if (command === 'counts-sql') {
    console.log(`SELECT json_build_object(${Object.keys(expectedTables(args[0]))
      .map((table) => `'${table}', (SELECT count(*)::text FROM public."${table}")`).join(',')});`);
  } else if (command === 'assert-source') {
    const [scenario, counts, ledger, release] = args;
    assert.deepEqual(await readJson(counts), sourceInputs(scenario));
    assert.deepEqual((await readJson(new URL('source-pins.json', import.meta.url))).releases, releasePins);
    assert.ok(Object.hasOwn(releasePins, release));
    assert.equal(sha256(await readFile(ledger)), '32a3fa9b45c357f523a5f02189ccb63376e9bd35b9844d00296ecf6b4f0b71ef');
  } else if (command === 'assert-preflight') {
    const [scenario, path, release, manifest] = args;
    const receipt = await readJson(path);
    assert.equal(receipt.state, 'preflighted');
    assert.equal(receipt.sourceEdition, 'community');
    assert.equal(receipt.sourceRelease, release);
    assert.equal(receipt.capturePostgresVersion, '17.12');
    assert.match(receipt.restoredPostgresVersion, /^17\./u);
    assert.equal(receipt.manifestSha256, sha256(await readFile(manifest)));
    assert.deepEqual(receipt.rows, sourceInputs(scenario));
    assert.deepEqual(receipt.assets, { present: scenario === 'inconsistent' ? 8 : 9,
      missingOriginals: Number(scenario !== 'clean'), missingDerivatives: 0 });
    assert.equal(receipt.eligibleUnderDefaultPolicy, scenario === 'clean');
  } else if (command === 'assert-report') {
    const [scenario, directory] = args;
    const report = await readJson(join(directory, 'report.json'));
    const preflight = await readJson(join(directory, 'preflight.json'));
    for (const key of ['runId', 'manifestSha256', 'fingerprintSha256']) assert.equal(report[key], preflight[key]);
    const pages = (await readdir(directory)).filter((name) => /^page-\d+\.json$/u.test(name)).length;
    const cases = [];
    let offset = 0;
    for (let index = 0; index < pages; index++) {
      const { details, nextOffset, ...summary } = await readJson(join(directory, `page-${offset}.json`));
      assert.deepEqual(summary, report);
      assert.ok(Array.isArray(details) && details.length <= 2);
      cases.push(...details);
      assert.equal(nextOffset, index + 1 === pages ? null : cases.length);
      offset = nextOffset;
    }
    const { reportSha256, ...summary } = report;
    assert.equal(reportSha256, sha256(JSON.stringify(summary)));
    assert.equal(cases.length, report.detailCount);
    assert.equal(report.detailSha256, sha256(JSON.stringify(cases)));
    assertReport(report, cases, scenario);
  } else throw new Error('Unsupported migration matrix oracle command.');
}

function sourceInputs(scenario) {
  return Object.fromEntries(Object.entries(expectedTables(scenario)).map(([table, { input }]) => [table, input]));
}
