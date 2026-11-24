import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { join } from 'node:path';
import { proxyHeaders } from './account-fixture.mjs';

export async function tlsBridge(directory, startProxy) {
  const key = join(directory, 'tls-key');
  const cert = join(directory, 'tls-cert');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  let proxy;
  let origin;
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (incoming, reply) => {
    const forwarded = request({ socketPath: proxy.path, path: incoming.url, method: incoming.method,
      headers: { ...incoming.headers, ...proxyHeaders(origin) } }, (response) => {
      reply.writeHead(response.statusCode, response.headers);
      reply.flushHeaders();
      response.once('close', () => { if (!response.complete) reply.destroy(); });
      response.pipe(reply);
    });
    forwarded.once('error', () => reply.destroy());
    reply.once('close', () => forwarded.destroy());
    incoming.pipe(forwarded);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = 'https://127.0.0.1:' + server.address().port;
  try { proxy = await startProxy(origin); }
  catch (error) { server.close(); throw error; }
  return { origin, close: async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await proxy.close();
  } };
}
