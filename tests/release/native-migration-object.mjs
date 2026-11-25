import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { join } from 'node:path';

const [bundle, assetRoot, work, absentKey] = process.argv.slice(2);
const captured = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(bundle, 'asset-manifest.json'), 'utf8'));
if (process.env.PLANNER_OBJECT_FIXTURE_PREPARE === '1') {
  for (const [index, file] of manifest.files.entries()) file.versionId = 'synthetic-v' + (index + 1);
  captured.asset.kind = 'object';
  const bytes = Buffer.from(JSON.stringify(manifest) + '\n');
  captured.asset.manifestSha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(bundle, 'asset-manifest.json'), bytes, { mode: 0o600 });
  await writeFile(join(bundle, 'manifest.json'), JSON.stringify(captured) + '\n', { mode: 0o600 });
} else {
  const versions = new Map(manifest.files.map(({ key, versionId }) => [key, versionId]));
  if (absentKey !== undefined && !versions.get(absentKey)) throw new Error('The absent object must have an exact manifest version.');
  const server = createServer({
    cert: await readFile(join(work, 'certificate.pem')), key: await readFile(join(work, 'certificate-key.pem')),
  }, async (request, response) => {
    try {
      const url = new URL(request.url, 'https://127.0.0.1');
      const key = decodeURIComponent(url.pathname.slice('/frozen/'.length));
      const version = versions.get(key);
      const exact = request.method === 'GET' && url.pathname.startsWith('/frozen/') && version
        && version === url.searchParams.get('versionId');
      if (key === absentKey) {
        if (!exact || request.headers['accept-encoding'] !== 'identity' || url.searchParams.size !== 1) {
          response.writeHead(400).end();
          return;
        }
        response.writeHead(404, { 'X-Amz-Version-Id': version }).end();
        return;
      }
      if (!exact) {
        response.writeHead(404).end();
        return;
      }
      const bytes = await readFile(join(assetRoot, key));
      const wrong = await readFile(join(work, 'version-mode'), 'utf8');
      response.writeHead(200, {
        'X-Amz-Version-Id': wrong.trim() === 'mismatch' ? 'changed-version' : version, 'Content-Length': bytes.length,
      }).end(bytes);
    } catch { response.writeHead(500).end(); }
  });
  server.listen(0, '127.0.0.1', async () => {
    await writeFile(join(work, 'object-port'), String(server.address().port), { mode: 0o600 });
  });
}
