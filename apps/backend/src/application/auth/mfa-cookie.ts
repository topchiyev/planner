import { opaqueTokenSchema } from '@planner/contracts';

const name = '__Host-planner-trusted-device';
const flags = 'Path=/; Secure; HttpOnly; SameSite=Lax';
export const trustedDeviceCookie = (token: string) => `${name}=${token}; Max-Age=2592000; ${flags}`;
export const clearTrustedDeviceCookie = `${name}=; Max-Age=0; ${flags}`;

export function readTrustedDeviceCookie(header: string | undefined) {
  const prefix = `${name}=`;
  const values = header?.split(';').map((part) => part.trim()).filter((part) => part.startsWith(prefix));
  if (values?.length !== 1) return undefined;
  const token = opaqueTokenSchema.safeParse(values[0].slice(prefix.length));
  return token.success ? token.data : undefined;
}
