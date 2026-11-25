import Provider, { errors, type ClientMetadata, type JWKS } from 'oidc-provider';
import type { OAuthStorage } from './storage.js';
import { interactionLifetime } from './storage.js';

export const readScope = 'planner:read';
export const writeScope = 'planner:write';
export const authorizationPath = '/oauth/authorize';
export const tokenPath = '/oauth/token';
export const keysPath = '/oauth/jwks';
export const interactionPath = '/oauth/interaction';
export const issuerMetadataPath = '/.well-known/oauth-authorization-server';
export const protectedResourceMetadataPath = '/.well-known/oauth-protected-resource/mcp';

export type PlannerOAuthClient = Pick<ClientMetadata, 'client_id' | 'client_name' | 'redirect_uris'>;

export function oauthMetadata(origin: string) {
  const resource = origin + '/mcp';
  return {
    resource,
    challenge: `Bearer resource_metadata="${origin + protectedResourceMetadataPath}"`,
    resourceMetadata: { resource, authorization_servers: [origin], scopes_supported: [readScope],
      bearer_methods_supported: ['header'] },
    issuerMetadata: { issuer: origin, authorization_endpoint: origin + authorizationPath, token_endpoint: origin + tokenPath,
      jwks_uri: origin + keysPath, response_types_supported: ['code'], grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
      scopes_supported: [readScope, writeScope], authorization_response_iss_parameter_supported: true },
  };
}

export function requestedPlannerScopes(scope: unknown) {
  if (typeof scope !== 'string') return null;
  const scopes = scope.split(' ');
  return scopes.includes(readScope) && new Set(scopes).size === scopes.length
    && scopes.every((entry) => entry === readScope || entry === writeScope) ? scopes : null;
}

export function createPlannerProvider(
  origin: string, storage: OAuthStorage, cookieKey: string, jwks: JWKS, clients: readonly PlannerOAuthClient[],
) {
  const resource = origin + '/mcp';
  const provider = new Provider(origin, {
    jwks,
    adapter: storage.adapter,
    clients: clients.map((client) => ({ ...client, token_endpoint_auth_method: 'none',
      response_types: ['code'], grant_types: ['authorization_code'] })),
    routes: { authorization: authorizationPath, token: tokenPath, jwks: keysPath },
    clientAuthMethods: ['none'],
    clientBasedCORS: (_ctx, caller, client) => client.redirectUris?.some((uri) => new URL(uri).origin === caller) ?? false,
    responseTypes: ['code'],
    allowOmittingSingleRegisteredRedirectUri: false,
    acceptQueryParamAccessTokens: false,
    issueRefreshToken: () => false,
    pkce: { required: () => true },
    ttl: { AccessToken: 900, AuthorizationCode: 300, Grant: 30 * 24 * 60 * 60, Interaction: interactionLifetime, Session: 900 },
    cookies: {
      keys: [cookieKey],
      long: { signed: true, httpOnly: true, sameSite: 'lax', secure: true },
      short: { signed: true, httpOnly: true, sameSite: 'lax', secure: true },
    },
    features: {
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
