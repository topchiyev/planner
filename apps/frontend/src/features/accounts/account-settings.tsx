import {
  accountPreferencesSchema, accountProfileSchema, passwordChangeSchema, preferencesSchema, profileUpdateSchema,
  type AccountPreferences, type AccountProfile, type BrowserSession,
} from '@planner/contracts';
import { useState, type FormEvent } from 'react';
import { useLoaderData, useRouteLoaderData, type LoaderFunctionArgs } from 'react-router';
import { PageHeading } from '../../app/page-state.js';
import { accountError, accountMutation, accountRequest, AccountRequestError } from './account-api.js';

const profilePath = '/api/v1/me/profile';
const preferencesPath = '/api/v1/me/preferences';

export function loadAccountSettings({ request }: LoaderFunctionArgs) {
  return readSettings(request.signal);
}

async function readSettings(signal?: AbortSignal) {
  const [profile, preferences] = await Promise.all([
    accountRequest(profilePath, accountProfileSchema, { signal }),
    accountRequest(preferencesPath, accountPreferencesSchema, { signal }),
  ]);
  return { profile, preferences };
}

const profileFields = [
  ['name', 'Full name', 'name'],
  ['email', 'Email', 'email'],
  ['username', 'Username', 'username'],
  ['phone', 'Phone', 'tel'],
  ['organization', 'Organization', 'organization'],
  ['language', 'Language', 'language'],
] as const;

const preferenceChoices = {
  editorMode: { label: 'Editor', options: [['wysiwyg', 'Rich text'], ['markup', 'Markup']] },
  homeView: { label: 'Projects view', options: [['groupedProjects', 'Grouped'], ['gridProjects', 'Grid']] },
  projectOrder: { label: 'Project order', options: [['byDefault', 'Default'], ['alphabetically', 'Alphabetical'], ['byCreationTime', 'Creation time']] },
  autoLogout: { label: 'Sign out after inactivity', options: [
    ['never', 'Never'], ['2m', '2 minutes'], ['5m', '5 minutes'], ['10m', '10 minutes'], ['30m', '30 minutes'], ['12h', '12 hours'],
  ] },
} as const;

const preferenceChecks = [
  ['followOwnCards', 'Follow cards I create'],
  ['followOnComment', 'Follow cards I comment on'],
  ['showFavorites', 'Show favorite projects'],
  ['highlightRecentlyChanged', 'Highlight recently changed cards'],
] as const;

export function AccountSettingsPage() {
  const initial = useLoaderData<typeof loadAccountSettings>();
  const { csrfToken } = useRouteLoaderData('app-shell') as BrowserSession;
  const [profile, setProfile] = useState(initial.profile);
  const [preferences, setPreferences] = useState(initial.preferences);
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>, save: (values: FormData) => Promise<void>) {
    event.preventDefault();
    if (busy) return;
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setNotice('');
    setProblem('');
    try {
      await save(values);
    } catch (error) {
      setProblem(accountError(error));
      if (error instanceof AccountRequestError && error.code === 'REVISION_CONFLICT') {
        try {
          const latest = await readSettings();
          setProfile(latest.profile);
          setPreferences(latest.preferences);
          setProblem('This account changed. The current settings have been loaded.');
        } catch { setProblem('This account changed. Reload this page before trying again.'); }
      }
    } finally { setBusy(false); }
  }

  async function saveProfile(values: FormData) {
    const changes: Partial<AccountProfile> = {};
    for (const [field] of profileFields) {
      const value = String(values.get(field) ?? '').trim();
      if (value !== (profile[field] ?? '')) {
        if (field === 'name' || field === 'email') changes[field] = value;
        else changes[field] = value || null;
      }
    }
    if (Object.keys(changes).length === 0) { setNotice('Your profile is up to date.'); return; }
    const currentPassword = String(values.get('currentPassword') ?? '');
    const input = profileUpdateSchema.safeParse({ ...changes, revision: profile.revision,
      ...(currentPassword && { currentPassword }) });
    if (!input.success) throw new Error('Check the profile fields and your current password.');
    const result = await accountRequest(profilePath, accountProfileSchema,
      accountMutation('PATCH', csrfToken, input.data, crypto.randomUUID()));
    setProfile(result);
    setPreferences((previous) => previous.revision === input.data.revision ? { ...previous, revision: result.revision } : previous);
    setNotice('Profile saved.');
  }

  async function savePreferences(values: FormData) {
    const next = Object.fromEntries([
      ...Object.keys(preferenceChoices).map((field) => [field, values.get(field)]),
      ...preferenceChecks.map(([field]) => [field, values.has(field)]),
    ]);
    const desired = preferencesSchema.parse(next);
    const changes = Object.fromEntries(Object.entries(desired)
      .filter(([field, value]) => preferences.preferences[field as keyof AccountPreferences] !== value));
    if (Object.keys(changes).length === 0) { setNotice('Your preferences are up to date.'); return; }
    const result = await accountRequest(preferencesPath, accountPreferencesSchema,
      accountMutation('PATCH', csrfToken, { revision: preferences.revision, preferences: changes }, crypto.randomUUID()));
    setPreferences(result);
    setProfile((previous) => previous.revision === preferences.revision ? { ...previous, revision: result.revision } : previous);
    setNotice('Preferences saved.');
  }

  async function changePassword(values: FormData) {
    const input = passwordChangeSchema.safeParse({ currentPassword: values.get('oldPassword'), password: values.get('newPassword') });
    if (!input.success || input.data.password !== values.get('repeatPassword')) {
      throw new Error('Use 12 to 128 characters and enter the new password twice.');
    }
    await accountRequest('/api/v1/me/password', { parse: () => undefined }, accountMutation('POST', csrfToken, input.data));
    window.location.replace('/sign-in');
  }

  return (
    <section className="page">
      <PageHeading>Account settings</PageHeading>
      {notice && <p role="status">{notice}</p>}
      {problem && <p className="auth-error" role="alert">{problem}</p>}
      <div className="account-settings">
        <section className="account-panel">
          <h2>Profile</h2>
          <form className="auth-form" method="post" key={profile.revision} onSubmit={(event) => void submit(event, saveProfile)}>
            {profileFields.map(([field, label, autocomplete]) => (
              <label key={field}>{label}<input name={field} autoComplete={autocomplete} type={field === 'email' ? 'email' : 'text'}
                defaultValue={profile[field] ?? ''} required={field === 'name' || field === 'email'} /></label>
            ))}
            <label>Current password for email or username changes
              <input autoComplete="current-password" name="currentPassword" type="password" />
            </label>
            <button className="primary-button" disabled={busy} type="submit">Save profile</button>
          </form>
        </section>
        <section className="account-panel">
          <h2>Preferences</h2>
          <form className="auth-form" method="post" key={preferences.revision} onSubmit={(event) => void submit(event, savePreferences)}>
            {Object.entries(preferenceChoices).map(([field, choice]) => (
              <label key={field}>{choice.label}<select name={field} defaultValue={preferences.preferences[field as keyof AccountPreferences] as string}>
                {choice.options.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
              </select></label>
            ))}
            {preferenceChecks.map(([field, label]) => (
              <label className="account-check" key={field}><input name={field} type="checkbox" defaultChecked={preferences.preferences[field]} />{label}</label>
            ))}
            <button className="primary-button" disabled={busy} type="submit">Save preferences</button>
          </form>
        </section>
        <section className="account-panel">
          <h2>Change password</h2>
          <form className="auth-form" method="post" onSubmit={(event) => void submit(event, changePassword)}>
            <label>Current password<input autoComplete="current-password" name="oldPassword" required type="password" /></label>
            <label>New password<input autoComplete="new-password" name="newPassword" required type="password" /></label>
            <label>Confirm new password<input autoComplete="new-password" name="repeatPassword" required type="password" /></label>
            <button className="primary-button" disabled={busy} type="submit">Change password and sign out</button>
          </form>
        </section>
      </div>
    </section>
  );
}
