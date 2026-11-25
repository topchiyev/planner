import { Resolver } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import type { ClientMetadata } from 'oidc-provider';
import { z } from 'zod';

const pins = new Map([
  ['https://chatgpt.com/oauth/codex/client.json', {
    name: 'Codex', redirects: ['http://127.0.0.1/callback', 'http://localhost/callback'], loopbackPorts: true,
  }],
  ['https://claude.ai/oauth/claude-code-client-metadata', {
    name: 'Claude Code', redirects: ['http://localhost/callback', 'http://127.0.0.1/callback'], loopbackPorts: true,
  }],
  ['https://claude.ai/oauth/mcp-oauth-client-metadata', {
    name: 'Claude connector', redirects: ['https://claude.ai/api/mcp/auth_callback'], loopbackPorts: false,
  }],
]);
const metadataTimeoutMs = 2_500;
const cacheSeconds = 120;
const maximumMetadataBytes = 16 * 1024;
const maximumAnswers = 16;

const blocked = new BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) blocked.addSubnet(prefix, bits, 'ipv4');
for (const [prefix, bits] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['2620:4f:8000::', 48], ['3ffe::', 16], ['3fff::', 20],
] as const) blocked.addSubnet(prefix, bits, 'ipv6');
const globalIpv6 = new BlockList();
globalIpv6.addSubnet('2000::', 3, 'ipv6');

function publicAddress(address: string) {
  switch (isIP(address)) {
    case 4: return !blocked.check(address, 'ipv4');
    case 6: return globalIpv6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
    default: return false;
  }
}

async function resolvePublicHost(host: string, signal: AbortSignal) {
  const resolver = new Resolver({ timeout: 1_000, tries: 1 });
  const cancel = () => resolver.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    const optional = async (resolution: Promise<string[]>) => resolution.catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENODATA' || error.code === 'ENOTFOUND') return [];
      throw error;
    });
    return (await Promise.all([optional(resolver.resolve4(host)), optional(resolver.resolve6(host))])).flat();
  } finally { signal.removeEventListener('abort', cancel); }
}

async function readPinnedResponse(url: URL, address: string, signal: AbortSignal): Promise<unknown> {
  const reply = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const outgoing = request({ hostname: address, servername: url.hostname, port: 443, path: url.pathname, method: 'GET',
      agent: false, signal, rejectUnauthorized: true, checkServerIdentity: (_hostname, certificate) => checkServerIdentity(url.hostname, certificate),
      headers: { Host: url.hostname, Accept: 'application/json', 'Accept-Encoding': 'identity' },
    }, resolve);
    outgoing.once('error', reject).end();
  });
  try {
    const size = reply.headers['content-length'];
    if (reply.statusCode !== 200 || reply.headers.location !== undefined || (size !== undefined && (!/^\d+$/u.test(size) || Number(size) > maximumMetadataBytes))
      || reply.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json'
      || (reply.headers['content-encoding'] !== undefined && reply.headers['content-encoding'] !== 'identity')) throw new Error('Invalid client metadata response.');
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of reply as AsyncIterable<Buffer>) {
      length += chunk.byteLength;
      if (length > maximumMetadataBytes) throw new Error('Client metadata exceeds its size limit.');
      chunks.push(chunk);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length)));
  } finally { reply.destroy(); }
}

type MetadataTransport = { resolve: typeof resolvePublicHost; read: typeof readPinnedResponse };
const network: MetadataTransport = { resolve: resolvePublicHost, read: readPinnedResponse };

const loopback = /^(http:\/\/(?:127\.0\.0\.1|localhost))(?::([1-9]\d{0,4}))?(\/[^?#]*)$/u;
function redirectShape(value: string) {
  const url = URL.parse(value);
  return !!url && url.href === value && !url.username && !url.password && !url.hash && !value.includes('#')
    && !/[\p{Cc}\\]/u.test(value) && (url.protocol === 'https:' || loopback.test(value));
}
const clientName = z.string().trim().min(1).max(80).refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value));
const registration = z.strictObject({
  client_id: z.string().regex(/^[A-Za-z0-9._~-]{1,128}$/u),
  client_name: clientName,
  redirect_uris: z.array(z.string().max(512).refine(redirectShape)).min(1).max(8)
    .refine((values) => new Set(values).size === values.length),
  loopbackPorts: z.boolean().optional(),
}).refine(({ redirect_uris, loopbackPorts }) => !loopbackPorts || redirect_uris.some((uri) => {
  const parsed = loopback.exec(uri);
  return !!parsed && parsed[2] === undefined;
}));

export type PlannerOAuthClient = z.infer<typeof registration>;
export function parseOAuthClientRegistrations(value: unknown) {
  return z.strictObject({ version: z.literal(1), clients: z.array(registration).max(32) }).parse(value).clients;
}

function redirectsMatch(values: readonly string[], expected: readonly string[]) {
  return values.length === expected.length && new Set(values).size === values.length && values.every((uri) => expected.includes(uri));
}

export function acceptsClientRedirect(client: PlannerOAuthClient, redirect: string) {
  if (client.redirect_uris.includes(redirect)) return true;
  if (!client.loopbackPorts) return false;
  const parsed = loopback.exec(redirect);
  return !!parsed?.[2] && Number(parsed[2]) <= 65_535 && client.redirect_uris.includes(parsed[1] + parsed[3]);
}

function providerClient({ client_id, client_name, redirect_uris }: PlannerOAuthClient): ClientMetadata {
  return { client_id, client_name, redirect_uris, token_endpoint_auth_method: 'none',
    application_type: redirect_uris.some((uri) => loopback.test(uri)) ? 'native' : 'web',
    response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'] };
}

function checkDocument(id: string, pin: NonNullable<ReturnType<typeof pins.get>>, document: unknown) {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) throw new Error('Invalid client metadata document.');
  const fields = document as Record<string, unknown>;
  if (fields.client_id !== id || !Array.isArray(fields.redirect_uris) || !redirectsMatch(fields.redirect_uris, pin.redirects)) {
    throw new Error('Client metadata identity or redirects do not match Planner policy.');
  }
  if ('client_secret' in fields || 'client_secret_expires_at' in fields
      || (fields.token_endpoint_auth_method !== undefined && fields.token_endpoint_auth_method !== 'none')) throw new Error('Client is not public.');
  for (const [key, supported] of [['response_types', ['code']], ['grant_types', ['authorization_code', 'refresh_token']]] as const) {
    const supplied = fields[key];
    if (supplied !== undefined && (!Array.isArray(supplied) || !supported.every((value) => supplied.includes(value)))) {
      throw new Error('Client metadata does not support the Planner flow.');
    }
  }
  return { client_id: id, client_name: pin.name, redirect_uris: [...pin.redirects], loopbackPorts: pin.loopbackPorts };
}

export function createOAuthClientRegistry(registrations: readonly PlannerOAuthClient[] = [], transport: MetadataTransport = network) {
  const staticClients = new Map<string, PlannerOAuthClient>();
  const names = new Set([...pins.values()].map(({ name }) => name.toLowerCase()));
  for (const input of registrations) {
    const client = registration.parse(input);
    const name = client.client_name.toLowerCase();
    if (staticClients.has(client.client_id) || names.has(name)) throw new Error('OAuth client IDs and names must be distinct.');
    staticClients.set(client.client_id, client);
    names.add(name);
  }
  const pending = new Map<string, Promise<PlannerOAuthClient>>();
  const cache = new Map<string, { client: PlannerOAuthClient; expires: number }>();

  async function resolve(id: string, signal?: AbortSignal): Promise<PlannerOAuthClient | null> {
    const pinned = pins.get(id);
    if (!pinned) return staticClients.get(id) ?? null;
    const saved = cache.get(id);
    if (saved && Date.now() < saved.expires) return saved.client;
    const running = pending.get(id);
    if (running) return running;
    const deadline = AbortSignal.timeout(metadataTimeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const work = (async () => {
      const url = new URL(id);
      const answers = await transport.resolve(url.hostname, requestSignal);
      requestSignal.throwIfAborted();
      if (!answers.length || answers.length > maximumAnswers || answers.some((address) => !publicAddress(address))) {
        throw new Error('The client metadata host did not resolve to public addresses.');
      }
      const address = answers.find((candidate) => isIP(candidate) === 4) ?? answers[0];
      const client = checkDocument(id, pinned, await transport.read(url, address, requestSignal));
      requestSignal.throwIfAborted();
      cache.set(id, { client, expires: Date.now() + cacheSeconds * 1000 });
      return client;
    })();
    pending.set(id, work);
    try { return await work; } finally { pending.delete(id); }
  }

  return {
    resolve,
    allowsId: (id: string) => pins.has(id) || staticClients.has(id),
    staticClients: [...staticClients.values()].map(providerClient),
    cacheDuration: { min: cacheSeconds, max: cacheSeconds },
    allowFetch: (id: string) => pins.has(id),
    async allowDocumentClient(id: string, redirects: readonly string[]) {
      return pins.has(id) && !!await resolve(id).then((client) => client && redirectsMatch(redirects, client.redirect_uris), () => false);
    },
    async fetch(input: string | URL | Request, options?: RequestInit) {
      const id = typeof input === 'string' ? input : input instanceof URL ? input.href : undefined;
      if (!id || !pins.has(id) || options?.method !== 'GET' || options.redirect !== 'manual' || options.body != null) {
        throw new Error('The OAuth provider requested an unapproved client metadata address.');
      }
      const client = await resolve(id, options.signal ?? undefined);
      if (!client) throw new Error('The OAuth client is not registered.');
      return Response.json(providerClient(client), { headers: { 'Cache-Control': `max-age=${cacheSeconds}` } });
    },
  };
}

export type OAuthClientRegistry = ReturnType<typeof createOAuthClientRegistry>;
