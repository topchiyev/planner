import Provider, { errors, type JWKS } from 'oidc-provider';
import type { OAuthStorage } from './storage.js';
import { connectionLifetimeSeconds, interactionLifetime } from './storage.js';
import type { OAuthClientRegistry } from './clients.js';

export const readScope = 'planner:read';
export const writeScope = 'planner:write';
export const offlineScope = 'offline_access';
export const authorizationPath = '/oauth/authorize';
export const tokenPath = '/oauth/token';
export const keysPath = '/oauth/jwks';
export const interactionPath = '/oauth/interaction';
export const issuerMetadataPath = '/.well-known/oauth-authorization-server';
export const protectedResourceMetadataPath = '/.well-known/oauth-protected-resource/mcp';

export function oauthMetadata(origin: string) {
  const resource = origin + '/mcp';
  return {
    resource,
    challenge: `Bearer resource_metadata="${origin + protectedResourceMetadataPath}", scope="${readScope}"`,
    resourceMetadata: { resource, authorization_servers: [origin], scopes_supported: [readScope, writeScope],
      bearer_methods_supported: ['header'] },
    issuerMetadata: { issuer: origin, authorization_endpoint: origin + authorizationPath, token_endpoint: origin + tokenPath,
      jwks_uri: origin + keysPath, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
      scopes_supported: [readScope, writeScope, offlineScope], authorization_response_iss_parameter_supported: true },
  };
}

export function requestedPlannerScopes(scope: unknown) {
  if (typeof scope !== 'string') return null;
  const scopes = scope.split(' ');
  return scopes.includes(readScope) && new Set(scopes).size === scopes.length
    && scopes.every((entry) => entry === readScope || entry === writeScope || entry === offlineScope) ? scopes : null;
}

export function createPlannerProvider(
  origin: string, storage: OAuthStorage, cookieKey: string, jwks: JWKS, clients: OAuthClientRegistry,
) {
  const resource = origin + '/mcp';
  const provider = new Provider(origin, {
    jwks,
    adapter: storage.adapter,
    clients: clients.staticClients,
    fetch: clients.fetch,
    routes: { authorization: authorizationPath, token: tokenPath, jwks: keysPath },
    clientAuthMethods: ['none'],
    clientBasedCORS: (_ctx, caller, client) => client.redirectUris?.some((uri) => new URL(uri).origin === caller) ?? false,
    responseTypes: ['code'],
    allowOmittingSingleRegisteredRedirectUri: false,
    acceptQueryParamAccessTokens: false,
    expiresWithSession: () => false,
    rotateRefreshToken(ctx) {
      const current = ctx.oidc.entities.RefreshToken;
      const requested = ctx.oidc.params?.scope;
      if (current && typeof requested === 'string') {
        const accepted = requestedPlannerScopes(requested);
        if (!accepted) throw new errors.InvalidScope('A Planner read scope is required.', typeof requested === 'string' ? requested : '');
        current.scope = [...new Set([...accepted, offlineScope])].join(' ');
      }
      return true;
    },
    pkce: { required: () => true },
    ttl: { AccessToken: 900, AuthorizationCode: 300, Grant: connectionLifetimeSeconds, RefreshToken: connectionLifetimeSeconds, Interaction: interactionLifetime, Session: 900 },
    cookies: {
      keys: [cookieKey],
      long: { signed: true, httpOnly: true, sameSite: 'lax', secure: true },
      short: { signed: true, httpOnly: true, sameSite: 'lax', secure: true },
    },
    features: {
      clientIdMetadataDocument: { enabled: true, ack: 'draft-03', cacheDuration: clients.cacheDuration,
        allowFetch: (_ctx, id) => clients.allowFetch(id),
        allowClient: (_ctx, client) => clients.allowDocumentClient(client.clientId, client.redirectUris ?? []) },
      devInteractions: { enabled: false },
      dPoP: { enabled: false },
      pushedAuthorizationRequests: { enabled: false },
      rpInitiatedLogout: { enabled: false },
      userinfo: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => resource,
        getResourceServerInfo: (_ctx, requested) => {
          if (requested !== resource) throw new errors.InvalidTarget();
          return { audience: resource, scope: readScope + ' ' + writeScope, accessTokenFormat: 'opaque', accessTokenTTL: 900 };
        },
        useGrantedResource: () => true,
      },
    },
    interactions: { url: (_ctx, { uid }) => `${interactionPath}/${uid}` },
    loadExistingGrant: async ({ oidc }) => {
      const id = oidc.result?.consent?.grantId;
      return id ? oidc.provider.Grant.find(id) : undefined;
    },
    findAccount: async (_ctx, accountId) => await storage.accountExists(accountId)
      ? { accountId, claims: () => ({ sub: accountId }) } : undefined,
    renderError(ctx, output) {
      ctx.type = 'application/json';
      ctx.body = { error: output.error };
    },
  });
  // Only the native boundary creates the forwarding header consumed by Koa.
  provider.proxy = true;
  return provider;
}
