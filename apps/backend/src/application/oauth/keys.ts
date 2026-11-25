import {
  createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync,
  randomBytes, type JsonWebKey, type KeyObject,
} from 'node:crypto';
import type { JWKS } from 'oidc-provider';
import type { Db } from 'mongodb';
import type { InstallationDocument } from '../../storage/schema.js';
import { durable } from '../command-journal/records.js';

export interface OAuthEnvelope {
  nonce: string;
  body: string;
  tag: string;
}

export function oauthSecrets(root: KeyObject, installationId: string) {
  function derive(label: string) {
    return createHmac('sha256', root).update(JSON.stringify(['planner-oauth-v1', installationId, label])).digest();
  }

  function wrap(label: string) {
    const key = derive(label);
    return {
      seal(value: unknown, binding: readonly string[]): OAuthEnvelope {
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, nonce);
        cipher.setAAD(Buffer.from(JSON.stringify(binding)));
        const bytes = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
        return { nonce: nonce.toString('base64url'), body: bytes.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
      },
      open(envelope: OAuthEnvelope, binding: readonly string[]): unknown {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64url'));
        decipher.setAAD(Buffer.from(JSON.stringify(binding)));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
        const bytes = Buffer.concat([decipher.update(Buffer.from(envelope.body, 'base64url')), decipher.final()]);
        try { return JSON.parse(bytes.toString('utf8')); }
        finally { bytes.fill(0); }
      },
    };
  }

  const identity = derive('identifiers');
  const consent = derive('consent');
  const mac = (key: Buffer, parts: readonly string[]) =>
    createHmac('sha256', key).update(JSON.stringify(parts)).digest('base64url');

  return {
    cookies: derive('provider-cookie-signing').toString('base64url'),
    identity: (...parts: string[]) => mac(identity, parts),
    consent: (...parts: string[]) => mac(consent, parts),
    artifacts: wrap('provider-payload'),
    signer: wrap('issuer-private-jwk'),
  };
}

export type OAuthSecrets = ReturnType<typeof oauthSecrets>;

// The installation record and its existing private key are both carried by Planner backups.
export async function oauthSigningKeys(db: Db, installation: InstallationDocument, secrets: OAuthSecrets): Promise<JWKS> {
  const { installationId } = installation;
  const collection = db.collection<InstallationDocument>('installation');
  const key = { _id: 'installation' as const, installationId };
  let envelope = installation.oauthSigner;
  if (!envelope) {
    const generated = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' });
    const saved = await collection.findOneAndUpdate({ ...key, oauthSigner: { $exists: false } },
      { $set: { oauthSigner: secrets.signer.seal(generated, [installationId]) } },
      { ...durable, returnDocument: 'after', projection: { oauthSigner: 1 } });
    envelope = saved?.oauthSigner ?? (await collection.findOne(key, { projection: { oauthSigner: 1 } }))?.oauthSigner;
  }
  if (!envelope) throw new Error('The Planner authorization issuer key is unavailable.');
  const privateKey = securityKey(secrets.signer.open(envelope, [installationId]));
  const jwk = privateKey.export({ format: 'jwk' });
  const { kty, e, n } = createPublicKey(privateKey).export({ format: 'jwk' });
  const kid = createHash('sha256').update(JSON.stringify({ e, kty, n })).digest('base64url');
  return { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] };
}

function securityKey(jwk: unknown) {
  if (!jwk || typeof jwk !== 'object' || !('kty' in jwk) || jwk.kty !== 'RSA') throw new Error('Invalid Planner issuer key.');
  const privateKey = createPrivateKey({ format: 'jwk', key: jwk as JsonWebKey });
  if (privateKey.asymmetricKeyDetails?.modulusLength !== 2048) throw new Error('Invalid Planner issuer key.');
  return privateKey;
}
