import { accountProfileSchema, cardStopwatchSchema, preferencesSchema, siteRoleSchema, type AccountPreferences } from '@planner/contracts';
import { defaultPreferences } from '../auth/accounts.js';
import { accountIdentity } from '../auth/account-policy.js';
import { MigrationError } from './manifest.js';
import { SourceJsonNumber, type SourceJsonColumn, type SourceRow } from './source-projections.js';

// v1 maps known source tokens to Planner's independently designed palette.
const projectGradients = new Map<string, 'mist' | 'harbor' | 'fern' | 'dusk'>([
  ['prism-light', 'mist'], ['steel-grey', 'mist'], ['sky-change', 'mist'], ['green-mist', 'mist'],
  ['ocean-dive', 'harbor'], ['blue-xchange', 'harbor'], ['blue-steel', 'harbor'], ['blueish-curve', 'harbor'],
  ['old-lime', 'fern'], ['jungle-mesh', 'fern'], ['green-eyes', 'fern'], ['green-ninja', 'fern'], ['algae-green', 'fern'],
  ['tzepesch-style', 'dusk'], ['strawberry-dust', 'dusk'], ['purple-rose', 'dusk'], ['sun-scream', 'dusk'],
  ['warm-rust', 'dusk'], ['blood-orange', 'dusk'], ['sour-peel', 'dusk'], ['coral-reef', 'dusk'],
  ['heat-waves', 'dusk'], ['velvet-lounge', 'dusk'], ['purple-rain', 'dusk'], ['red-curtain', 'dusk'],
]);

export const gradientPreset = (type: string | null, token: string | null) =>
  type === 'gradient' && token !== null ? projectGradients.get(token) ?? null : null;

export function invalidBaseRow(reason: string): never {
  throw new MigrationError('source-read', reason);
}

export const nullableDate = (value: string | null) => value === null ? null : new Date(value);

export function targetTimes(row: { created_at: string | null; updated_at: string | null }, fallback: string) {
  return { createdAt: new Date(row.created_at ?? fallback), updatedAt: nullableDate(row.updated_at) };
}

export function importAccountPreferences(row: SourceRow<'user_account'>) {
  const unsupported: string[] = [];
  function preference<K extends keyof AccountPreferences>(field: K, value: string): AccountPreferences[K] {
    const parsed = preferencesSchema.shape[field].safeParse(value);
    if (parsed.success) return parsed.data as AccountPreferences[K];
    unsupported.push(field);
    return defaultPreferences[field];
  }
  const values: AccountPreferences = {
    autoLogout: preference('autoLogout', row.auto_logout_mode),
    editorMode: preference('editorMode', row.default_editor_mode),
    homeView: preference('homeView', row.default_home_view),
    projectOrder: preference('projectOrder', row.default_projects_order),
    followOwnCards: row.subscribe_to_own_cards,
    followOnComment: row.subscribe_to_card_when_commenting,
    showFavorites: row.enable_favorites_by_default,
    highlightRecentlyChanged: !row.turn_off_recent_card_highlighting,
  };
  return { values, unsupported };
}

export function importAccount(id: string, row: SourceRow<'user_account'>, fallback: string) {
  const role = siteRoleSchema.safeParse(row.role);
  const checked = accountProfileSchema.safeParse({ id, revision: 1, name: row.name, username: row.username,
    email: row.email, organization: row.organization, phone: row.phone, language: row.language });
  if (!role.success || !checked.success) invalidBaseRow('The source has an invalid account role or profile.');
  const { name, email, username, phone, organization, language } = checked.data;
  const { createdAt, updatedAt } = targetTimes(row, fallback);
  return {
    fields: { ...accountIdentity(email, username), name, phone, organization, language, role: role.data,
      disabledAt: row.is_deactivated ? new Date(row.updated_at ?? row.created_at ?? fallback) : null,
      createdAt, preferences: importAccountPreferences(row).values, requiresMfaEnrollment: row.is_totp_enabled },
    updatedAt,
  };
}

export function importStopwatch(column: SourceJsonColumn | null) {
  const raw = column?.value ?? null;
  if (raw === null) return { value: null, sourceStartedAt: null };
  if (typeof raw !== 'object' || raw instanceof SourceJsonNumber || Array.isArray(raw)
    || Object.keys(raw).length !== 2 || !(raw.total instanceof SourceJsonNumber)) {
    invalidBaseRow('The source has an invalid card stopwatch.');
  }
  const starts = raw.startedAt;
  let startedAt: string | null = null;
  if (typeof starts === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(starts)) {
    const candidate = new Date(starts);
    if (Number.isFinite(candidate.valueOf())) startedAt = candidate.toISOString();
  }
  const total = raw.total.decimal;
  const result = cardStopwatchSchema.safeParse({ startedAt, total: /^(?:0|[1-9]\d*)(?:\.0+)?$/u.test(total) ? Number(total) : NaN });
  if ((starts !== null && (typeof starts !== 'string' || startedAt === null || starts.slice(0, 19) !== startedAt.slice(0, 19))) || !result.success)
    invalidBaseRow('The source has an invalid card stopwatch.');
  return { value: result.data, sourceStartedAt: starts };
}
