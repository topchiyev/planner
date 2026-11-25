import {
  oauthConnectionPageSchema, reauthenticateMfaInputSchema, recoveryCodesOutputSchema, trustedDevicesOutputSchema, type BrowserSession,
} from '@planner/contracts';
import { useState, type FormEvent } from 'react';
import { useLoaderData, useRouteLoaderData } from 'react-router';
import { PageHeading } from '../../app/page-state.js';
import { FactorField, factorRequest, MfaEnrollmentForm, readFactor, RecoveryCodeList } from './mfa-forms.js';

const devicesPath = '/me/trusted-devices';
const connectionsPath = '/me/connections';
const readConnections = (after?: string) => factorRequest(connectionsPath + (after ? '?after=' + after : ''), 'GET', oauthConnectionPageSchema);
const noContent = { parse: () => undefined };
export async function loadMfaSettings() {
  const [mfa, connections] = await Promise.all([factorRequest(devicesPath, 'GET', trustedDevicesOutputSchema), readConnections()]);
  return { ...mfa, connections };
}

export function MfaSettingsPage() {
  const initial = useLoaderData<typeof loadMfaSettings>();
  const { csrfToken } = useRouteLoaderData('app-shell') as BrowserSession;
  const [devices, setDevices] = useState(initial.devices);
  const [connections, setConnections] = useState(initial.connections);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const signIn = () => window.location.replace('/sign-in');

  async function revoke(id: string) {
    if (busy) return;
    setBusy(true);
    setProblem('');
    try {
      await factorRequest(`${devicesPath}/${id}`, 'DELETE', noContent, undefined, csrfToken);
      setDevices((items) => items.filter((device) => device.id !== id));
    } catch (error) { setProblem(error instanceof Error ? error.message : 'Planner could not revoke this device.'); }
    finally { setBusy(false); }
  }

  async function disconnect(id: string) {
    if (busy) return;
    setBusy(true);
    setProblem('');
    try {
      await factorRequest(`${connectionsPath}/${id}`, 'DELETE', noContent, undefined, csrfToken);
      setConnections((page) => ({ ...page, connections: page.connections.map((item) =>
        item.id === id ? { ...item, status: 'revoked' } : item) }));
    } catch { setProblem('Planner could not disconnect this client.'); }
    finally { setBusy(false); }
  }

  async function moreConnections(after: string) {
    if (busy) return;
    setBusy(true);
    setProblem('');
    try {
      const next = await readConnections(after);
      setConnections((page) => ({ connections: [...page.connections, ...next.connections], next: next.next }));
    } catch { setProblem('Planner could not load more connections.'); }
    finally { setBusy(false); }
  }

  async function manage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const input = new FormData(event.currentTarget);
    const action = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value');
    const credentials = reauthenticateMfaInputSchema.safeParse({ password: input.get('password'), ...readFactor(input) });
    if (!credentials.success) { setProblem('Check your password and code.'); return; }
    setBusy(true);
    setProblem('');
    try {
      if (action === 'disable') {
        await factorRequest('/me/mfa', 'DELETE', noContent, credentials.data, csrfToken);
        signIn();
      } else {
        const renewal = await factorRequest('/me/mfa/recovery-codes', 'POST', recoveryCodesOutputSchema, credentials.data, csrfToken);
        setCodes(renewal.recoveryCodes);
      }
    } catch (error) { setProblem(error instanceof Error ? error.message : 'Planner could not change multifactor authentication.'); }
    finally { setBusy(false); }
  }

  return (
    <section className="page">
      <PageHeading>Account security</PageHeading>
      {problem && <p className="auth-error" role="alert">{problem}</p>}
      <div className="account-settings">
        <section className="account-panel">
          <h2>Authenticator</h2>
          {initial.mfaEnabled ? (
            codes ? <RecoveryCodeList codes={codes} onSaved={() => setCodes(null)} /> : (
              <form className="auth-form" method="post" onSubmit={(event) => void manage(event)}>
                <label>Current password<input autoComplete="current-password" name="password" required type="password" /></label>
                <FactorField />
                <div className="mfa-actions">
                  <button className="primary-button" disabled={busy} type="submit" value="renew">Replace recovery codes</button>
                  <button className="account-link" disabled={busy} type="submit" value="disable">Disable authenticator</button>
                </div>
              </form>
            )
          ) : <MfaEnrollmentForm csrfToken={csrfToken} onSaved={signIn} />}
        </section>
        {initial.mfaEnabled && (
          <section className="account-panel">
            <h2>Trusted browsers</h2>
            {devices.length === 0 ? <p>You have no trusted browsers.</p> : (
              <ul className="mfa-devices">{devices.map((device) => (
                <li key={device.id}>
                  <span>{device.current ? 'This browser' : 'Browser'} · Added {new Date(device.createdAt).toLocaleDateString()}</span>
                  <button className="account-link" disabled={busy} onClick={() => void revoke(device.id)} type="button">Revoke trust</button>
                </li>
              ))}</ul>
            )}
          </section>
        )}
        <section className="account-panel">
          <h2>Connected clients</h2>
          {connections.connections.length === 0 ? <p>You have no connected clients.</p> : (
            <ul className="mfa-devices">{connections.connections.map((item) => (
              <li key={item.id}>
                <span>{item.name} · {item.scopes.includes('planner:write') ? 'Read and write' : 'Read only'}
                  {item.status !== 'active' ? ` · ${item.status === 'expired' ? 'Expired' : 'Disconnected'}` : ''}</span>
                {item.status === 'active' && <button className="account-link" disabled={busy}
                  onClick={() => void disconnect(item.id)} type="button">Disconnect</button>}
              </li>
            ))}</ul>
          )}
          {connections.next && <button className="account-link" disabled={busy}
            onClick={() => void moreConnections(connections.next!)} type="button">More connections</button>}
        </section>
      </div>
    </section>
  );
}
