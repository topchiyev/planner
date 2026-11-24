import {
  mfaEnrollmentOutputSchema, recoveryCodesOutputSchema, sessionSchema, verifyMfaInputSchema,
  type MfaEnrollment,
} from '@planner/contracts';
import { useState, type FormEvent } from 'react';
import './mfa.css';

const prefix = '/api/v1';

export async function factorRequest<T>(
  path: string, method: 'GET' | 'POST' | 'DELETE', schema: { parse(input: unknown): T }, body?: unknown, csrfToken?: string,
) {
  const response = await fetch(prefix + path, {
    method, cache: 'no-store',
    headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(csrfToken && { 'X-CSRF-Token': csrfToken }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const result = response.status === 204 ? undefined : await response.json();
  if (!response.ok) throw new Error(typeof result?.error?.message === 'string'
    ? result.error.message : 'Planner could not complete this request.');
  return schema.parse(result);
}

export function FactorField() {
  const [backup, setBackup] = useState(false);
  return (
    <>
      {backup ? (
        <label>Recovery code
          <input autoComplete="off" maxLength={43} name="recoveryCode" required spellCheck={false} type="password" />
        </label>
      ) : <AuthenticatorField />}
      <button className="account-link" onClick={() => setBackup(!backup)} type="button">
        {backup ? 'Use an authenticator code' : 'Use a recovery code'}
      </button>
    </>
  );
}

function AuthenticatorField() {
  return (
    <label>Authenticator code
      <input autoComplete="one-time-code" inputMode="numeric" name="totpCode" maxLength={6} pattern="[0-9]{6}" required />
    </label>
  );
}

export function readFactor(values: FormData) {
  return values.has('recoveryCode') ? { recoveryCode: String(values.get('recoveryCode')).trim() }
    : { totpCode: String(values.get('totpCode') ?? '').trim() };
}

function problemOf(error: unknown) {
  return error instanceof Error ? error.message : 'Planner could not complete this request.';
}

export function MfaSignIn({ challengeId, onVerified }: { challengeId: string; onVerified: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const values = new FormData(event.currentTarget);
    const input = verifyMfaInputSchema.safeParse({ challengeId, ...readFactor(values), rememberDevice: values.has('remember') });
    if (!input.success) { setProblem('Check the code you entered.'); return; }
    setBusy(true);
    setProblem('');
    try {
      await factorRequest('/session/verify-mfa', 'POST', sessionSchema, input.data);
      onVerified();
    } catch (error) { setProblem(problemOf(error)); }
    finally { setBusy(false); }
  }

  return (
    <form className="auth-form" method="post" onSubmit={(event) => void submit(event)}>
      <FactorField />
      <label className="account-check"><input name="remember" type="checkbox" />Trust this browser for 30 days</label>
      {problem && <p className="auth-error" role="alert">{problem}</p>}
      <button className="primary-button" disabled={busy} type="submit">{busy ? 'Verifying…' : 'Verify and sign in'}</button>
    </form>
  );
}

export function RecoveryCodeList({ codes, onSaved }: { codes: string[]; onSaved: () => void }) {
  return (
    <section className="mfa-codes" aria-label="Recovery codes">
      <h2>Save your recovery codes</h2>
      <p>Each code works once. Keep them somewhere separate from your authenticator.</p>
      <ul>{codes.map((code) => <li key={code}><code>{code}</code></li>)}</ul>
      <button className="primary-button" onClick={onSaved} type="button">I saved my recovery codes</button>
    </section>
  );
}

export function MfaEnrollmentForm({
  enrollmentId, csrfToken, enterTicket = false, onSaved,
}: {
  enrollmentId?: string;
  csrfToken?: string;
  enterTicket?: boolean;
  onSaved: () => void;
}) {
  const [setup, setSetup] = useState<MfaEnrollment | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setProblem('');
    try {
      if (!setup) {
        const ticket = enrollmentId ?? (enterTicket ? String(values.get('ticket') ?? '').trim() : undefined);
        setSetup(await factorRequest('/mfa/enrollment', 'POST', mfaEnrollmentOutputSchema,
          ticket ? { enrollmentId: ticket } : {}, csrfToken));
      } else {
        const result = await factorRequest('/mfa/enrollment/verify', 'POST', recoveryCodesOutputSchema,
          { enrollmentId: setup.enrollmentId, totpCode: String(values.get('totpCode') ?? '') }, csrfToken);
        setSetup(null);
        setCodes(result.recoveryCodes);
      }
    } catch (error) { setProblem(problemOf(error)); }
    finally { setBusy(false); }
  }

  if (codes) return <RecoveryCodeList codes={codes} onSaved={() => { setCodes(null); onSaved(); }} />;
  return (
    <form className="auth-form" method="post" onSubmit={(event) => void submit(event)}>
      {!setup ? (
        <>
          {enterTicket && <label>Enrollment ticket
            <input autoComplete="off" maxLength={43} name="ticket" required spellCheck={false} type="password" />
          </label>}
          <button className="primary-button" disabled={busy} type="submit">Set up authenticator</button>
        </>
      ) : (
        <>
          <p>Copy this setup key into your authenticator app. Planner shows it once.</p>
          <code className="mfa-setup-key" aria-label="Authenticator setup key">{setup.secret}</code>
          <a href={setup.uri}>Open in authenticator app</a>
          <AuthenticatorField />
          <button className="primary-button" disabled={busy} type="submit">Verify authenticator</button>
        </>
      )}
      {problem && <p className="auth-error" role="alert">{problem}</p>}
    </form>
  );
}
