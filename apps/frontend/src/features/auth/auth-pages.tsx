import {
  firstAdminInputSchema, firstAdminOutputSchema, loginOutputSchema,
} from '@planner/contracts';
import { useState, type FormEvent, type ReactNode } from 'react';
import { PageHeading } from '../../app/page-state.js';
import { sessionPath } from './browser-session.js';

function AuthPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="auth-page">
      <section aria-labelledby="auth-title" className="auth-panel">
        <div className="auth-brand"><span className="brand-mark" aria-hidden="true" />Planner</div>
        <PageHeading id="auth-title">{title}</PageHeading>
        {children}
      </section>
    </main>
  );
}

function FormFeedback({ error }: { error: string | null }) {
  return error ? <p className="auth-error" role="alert">{error}</p> : null;
}

function postJson(path: string, value: unknown) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
    cache: 'no-store',
  });
}

export function FirstAdminPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  async function enroll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const values = new FormData(event.currentTarget);
    const input = firstAdminInputSchema.safeParse({
      grant: String(values.get('grant') ?? '').trim(),
      name: values.get('name'),
      email: values.get('email'),
      password: values.get('password'),
    });
    if (!input.success) {
      setError('Check your grant, name and email. Use a password with 12 to 128 characters.');
      return;
    }
    if (input.data.password !== values.get('password-confirmation')) {
      setError('The passwords must match.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await postJson('/api/v1/recovery/consume', input.data);
      if (response.status === 400) {
        setError('The enrollment grant is invalid or has expired.');
      } else if (response.status === 429) {
        setError('Too many enrollment attempts. Try again later.');
      } else if (response.ok && firstAdminOutputSchema.safeParse(await response.json()).success) {
        setConfirmed(true);
      } else {
        setError('Planner could not confirm enrollment. Try again or contact your operator.');
      }
    } catch {
      setError('Planner could not confirm enrollment. Try again or contact your operator.');
    } finally { setBusy(false); }
  }

  if (confirmed) {
    return (
      <AuthPage key="confirmed" title="Administrator account created">
        <p>Sign in with the email and password you just set.</p>
        <a className="primary-button auth-continue" href="/sign-in">Continue to sign in</a>
      </AuthPage>
    );
  }
  return (
    <AuthPage title="Create the first administrator">
      <p>Use the enrollment grant issued by your Planner operator.</p>
      <form className="auth-form" method="post" onSubmit={(event) => void enroll(event)}>
        <label>Enrollment grant
          <input autoComplete="off" maxLength={96} name="grant" required spellCheck={false} type="password" />
        </label>
        <label>Full name<input autoComplete="name" maxLength={120} name="name" required /></label>
        <label>Email<input autoComplete="email" maxLength={254} name="email" required type="email" /></label>
        <label>Password
          <input aria-describedby="password-length" autoComplete="new-password" maxLength={256} name="password" required type="password" />
        </label>
        <p className="auth-hint" id="password-length">Use 12 to 128 characters.</p>
        <label>Confirm password
          <input autoComplete="new-password" maxLength={256} name="password-confirmation" required type="password" />
        </label>
        <FormFeedback error={error} />
        <button className="primary-button" disabled={busy} type="submit">{busy ? 'Creating account…' : 'Create administrator'}</button>
      </form>
    </AuthPage>
  );
}

export function SignInPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const response = await postJson(`${sessionPath}/login`, {
        identifier: data.get('identifier'), password: data.get('password'),
      });
      if (response.status === 401) {
        setError('Incorrect identifier or password.');
      } else if (response.status === 429) {
        setError('Too many sign-in attempts. Try again later.');
      } else if (response.ok) {
        const session = loginOutputSchema.parse(await response.json());
        if (session.status === 'enrollment-required') {
          setError('This account requires enrollment before you can sign in. Contact your Planner administrator.');
        } else {
          window.location.replace('/workspace');
        }
      } else {
        setError('Planner could not sign you in. Try again.');
      }
    } catch {
      setError('Planner could not sign you in. Try again.');
    } finally { setBusy(false); }
  }

  return (
    <AuthPage title="Sign in">
      <form className="auth-form" method="post" onSubmit={(event) => void signIn(event)}>
        <label>Email or username
          <input autoComplete="username" maxLength={254} name="identifier" required spellCheck={false} />
        </label>
        <label>Password
          <input autoComplete="current-password" maxLength={256} name="password" required type="password" />
        </label>
        <FormFeedback error={error} />
        <button className="primary-button" disabled={busy} type="submit">{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </AuthPage>
  );
}
