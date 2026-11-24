import {
  accountApprovalSchema, accountDirectorySchema, accountProvisionSchema, adminAccountSchema, siteRoleSchema,
  type AccountApproval, type BrowserSession,
} from '@planner/contracts';
import { useState, type FormEvent } from 'react';
import { useLoaderData, useRevalidator, useRouteLoaderData, useSearchParams, type LoaderFunctionArgs } from 'react-router';
import { PageHeading } from '../../app/page-state.js';
import { accountError, accountMutation, accountRequest, AccountRequestError } from './account-api.js';

const accountsPath = '/api/v1/admin/accounts';
const roleNames = { admin: 'Administrator', projectOwner: 'Project owner', boardUser: 'Board user' } as const;
const signInNames = { available: 'Can sign in', 'password-required': 'Password required',
  'enrollment-required': 'MFA enrollment required', disabled: 'Disabled' } as const;

export function loadAccountDirectory({ request }: LoaderFunctionArgs) {
  const query = new URL(request.url).search;
  return accountRequest(accountsPath + query, accountDirectorySchema, { signal: request.signal });
}

export function AccountDirectoryPage() {
  const directory = useLoaderData<typeof loadAccountDirectory>();
  const { csrfToken } = useRouteLoaderData('app-shell') as BrowserSession;
  const { revalidate } = useRevalidator();
  const [search, setSearch] = useSearchParams();
  const [problem, setProblem] = useState('');
  const [notice, setNotice] = useState('');
  const [approval, setApproval] = useState<AccountApproval | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setProblem('');
    setNotice('');
    try {
      await action();
    } catch (error) {
      setProblem(accountError(error));
      if (error instanceof AccountRequestError && ['REVISION_CONFLICT', 'APPROVAL_UNAVAILABLE'].includes(String(error.code))) {
        void revalidate();
      }
    } finally { setBusy(false); }
  }

  function provision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    void submit(async () => {
      const input = accountProvisionSchema.safeParse({ name: values.get('name'), email: values.get('email'),
        username: String(values.get('username') ?? '').trim() || null, role: values.get('role') });
      if (!input.success) throw new Error('Check the email, username and role.');
      const account = await accountRequest(accountsPath, adminAccountSchema,
        accountMutation('POST', csrfToken, input.data, crypto.randomUUID()));
      setNotice(`${account.name} was added. Request a password reset to enable sign-in.`);
      form.reset();
      void revalidate();
    });
  }

  function requestApproval(id: string, revision: number, change: AccountApproval['change']) {
    void submit(async () => {
      const recovery = change.action === 'recovery';
      setApproval(await accountRequest(accountsPath + '/' + id + (recovery ? '/recovery' : ''), accountApprovalSchema,
        accountMutation(recovery ? 'POST' : 'PATCH', csrfToken, recovery ? { revision } : { ...change, revision })));
    });
  }

  return (
    <section className="page">
      <PageHeading>{directory.access === 'administration' ? 'Manage accounts' : 'Account directory'}</PageHeading>
      {notice && <p role="status">{notice}</p>}
      {problem && <p className="auth-error" role="alert">{problem}</p>}
      {approval && <section className="account-panel account-approval" aria-label="Pending local confirmation">
        <h2>Local confirmation required</h2>
        <p>Ask a Planner operator to confirm this request before {new Date(approval.expiresAt).toLocaleTimeString()}.</p>
        <p><code>sudo plannerctl accounts inspect {approval.id}</code></p>
        <p><code>sudo plannerctl accounts confirm {approval.id} --yes</code></p>
      </section>}
      {directory.access === 'administration' && <section className="account-panel account-provision">
        <h2>Add an account</h2>
        <form className="auth-form" method="post" onSubmit={provision}>
          <label>Full name<input name="name" required /></label>
          <label>Email<input name="email" type="email" required /></label>
          <label>Username<input name="username" /></label>
          <label>Site role<select name="role" defaultValue="boardUser">
            {siteRoleSchema.options.map((role) => <option key={role} value={role}>{roleNames[role]}</option>)}
          </select></label>
          <button className="primary-button" disabled={busy} type="submit">Add account</button>
        </form>
      </section>}
      <form className="account-search" onSubmit={(event) => {
        event.preventDefault();
        const value = String(new FormData(event.currentTarget).get('q') ?? '').trim();
        setSearch(value ? { q: value } : {});
      }}>
        <label>Search accounts <input defaultValue={search.get('q') ?? ''} name="q" maxLength={120} /></label>
        <button type="submit">Search</button>
      </form>
      <ul className="account-list">
        {directory.access === 'administration' ? directory.accounts.map((account) => (
          <li className="account-panel" key={account.id}>
            <h2>{account.name}</h2>
            <p>{account.email}{account.username && ` · ${account.username}`}</p>
            <p>{signInNames[account.signIn]}</p>
            <div className="account-actions">
              <form method="post" key={account.revision} onSubmit={(event) => {
                event.preventDefault();
                const role = siteRoleSchema.parse(new FormData(event.currentTarget).get('siteRole'));
                if (role !== account.role) requestApproval(account.id, account.revision, { action: 'role', role });
              }}>
                <label>Site role <select defaultValue={account.role} name="siteRole">
                  {siteRoleSchema.options.map((role) => <option key={role} value={role}>{roleNames[role]}</option>)}
                </select></label>
                <button disabled={busy} type="submit">Request role change</button>
              </form>
              <button disabled={busy} type="button" onClick={() => requestApproval(account.id, account.revision,
                { action: 'availability', disabled: !account.disabled })}>
                {account.disabled ? 'Request reactivation' : 'Request disablement'}
              </button>
              <button disabled={busy || account.disabled} type="button"
                onClick={() => requestApproval(account.id, account.revision, { action: 'recovery' })}>Request password reset</button>
            </div>
          </li>
        )) : directory.accounts.map((account) => <li className="account-panel" key={account.id}>
          <h2>{account.name}</h2><p>{roleNames[account.role]}</p>
        </li>)}
      </ul>
      {directory.accounts.length === 0 && <p>No matching accounts.</p>}
      {directory.next && <button type="button" onClick={() => {
        const params = new URLSearchParams(search);
        params.set('cursor', directory.next!);
        setSearch(params);
      }}>Next page</button>}
    </section>
  );
}
