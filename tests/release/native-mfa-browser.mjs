import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [executablePath, certificateKey, stageTicketPath, stagedMode] = process.argv.slice(2);
const { chromium } = await import(new URL('./playwright-core/index.mjs', import.meta.url));
const { Secret, TOTP } = await import('file:///opt/planner/current/node_modules/otpauth/dist/otpauth.node.mjs');
const origin = 'https://planner.example.test';
const identity = 'synthetic.admin@example.test';
const password = '  Owned äccount 🗝️ pass & %  ';
const sessionName = '__Host-planner-session';
const trustName = '__Host-planner-trusted-device';
const browser = await chromium.launch({
  executablePath,
  args: [
    '--disable-dev-shm-usage', '--no-proxy-server',
    '--host-resolver-rules=MAP planner.example.test 127.0.0.1',
    `--ignore-certificate-errors-spki-list=${certificateKey}`,
  ],
});
let stage = 'browser launch';
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const heading = (name) => page.getByRole('heading', { name, exact: true }).waitFor();
  const button = (name) => page.getByRole('button', { name, exact: true });
  const signIn = async () => {
    await page.goto(`${origin}/sign-in`);
    await page.getByLabel('Email or username').fill(identity);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await button('Sign in').click();
  };
  const logout = async () => {
    await button('Sign out').click();
    await page.waitForURL(`${origin}/sign-in`);
  };
  const codeList = async () => {
    await heading('Save your recovery codes');
    const codes = await page.getByRole('region', { name: 'Recovery codes' }).locator('code').allTextContents();
    assert.equal(codes.length, 10);
    assert.equal(new Set(codes).size, 10);
    return codes;
  };
  const status = (path, method = 'GET') => page.evaluate(async ({ path, method }) => (await fetch(path, { method })).status, { path, method });
  const cookie = async (name) => (await context.cookies()).find((value) => value.name === name);

  if (stageTicketPath) {
    stage = 'staged imported recovery';
    const recovering = stagedMode === '--migration-recovery';
    assert.equal((await page.goto(`${origin}${recovering ? '/account-recovery' : '/enroll-mfa'}`)).status(), 200);
    assert.equal(await page.evaluate(() => isSecureContext), true);
    for (const [path, method] of [
      ['/api/v1/session', 'GET'], ['/api/v1/session/login', 'POST'], ['/files/synthetic', 'HEAD'],
      ['/api/v1/boards/synthetic/events', 'GET'], ['/oauth/consent', 'GET'], ['/workspace', 'GET'],
    ]) assert.equal(await status(path, method), 503);
    const ticket = (await readFile(stageTicketPath, 'utf8')).trim();
    if (recovering) {
      await page.getByLabel('Recovery grant').fill(ticket);
      await page.getByLabel('New password').fill(password);
      await page.getByLabel('Confirm password').fill(password);
      await button('Set password').click();
      await heading('Set up your authenticator');
      assert.equal(await status('/account-recovery'), 503);
    } else await page.getByLabel('Enrollment ticket').fill(ticket);
    await button('Set up authenticator').click();
    const text = await page.getByLabel('Authenticator setup key').textContent();
    const totp = new TOTP({ secret: Secret.fromBase32(text), digits: 6, period: 30, algorithm: 'SHA1' });
    await page.getByLabel('Authenticator code').fill(totp.generate());
    await button('Verify authenticator').click();
    await codeList();
    assert.equal(await cookie(sessionName), undefined);
    await button('I saved my recovery codes').click();
    await heading(recovering ? 'Administrator recovery complete' : 'Authenticator set up');
    assert.equal(await status('/health/ready'), 503);
    assert.equal(await status('/api/v1/session'), 503);
    assert.equal(await status('/oauth/consent'), 503);
    console.log('The recovered staged operator completed TOTP through the limited HTTPS route while the workspace stayed inactive.');
  } else {
    stage = 'initial password sign-in';
    await signIn();
    await heading('Projects');
    const passwordOnly = await cookie(sessionName);
    assert.ok(passwordOnly);
    await page.goto(`${origin}/settings/security`);
    await heading('Account security');

    stage = 'factor enrollment';
    await button('Set up authenticator').click();
    const text = await page.getByLabel('Authenticator setup key').textContent();
    const totp = new TOTP({ secret: Secret.fromBase32(text), digits: 6, period: 30, algorithm: 'SHA1' });
    await page.getByLabel('Authenticator code').fill(totp.generate({ timestamp: Date.now() - 30_000 }));
    await button('Verify authenticator').click();
    const initialCodes = await codeList();
    assert.equal(await cookie(sessionName), undefined);
    await context.addCookies([passwordOnly]);
    assert.equal(await status('/api/v1/session'), 401);
    await context.clearCookies({ name: sessionName });
    await button('I saved my recovery codes').click();
    await page.waitForURL(`${origin}/sign-in`);

    stage = 'second factor and remembered browser';
    await signIn();
    await heading('Verify your sign-in');
    assert.equal(await cookie(sessionName), undefined);
    assert.equal(await status('/api/v1/session'), 401);
    await page.getByLabel('Authenticator code').fill(totp.generate());
    await page.getByLabel('Trust this browser for 30 days').check();
    await button('Verify and sign in').click();
    await page.waitForURL(`${origin}/workspace`);
    await heading('Projects');
    assert.equal(await status('/api/v1/admin/accounts'), 200);
    const trusted = await cookie(trustName);
    assert.ok(trusted?.secure && trusted.httpOnly);
    assert.equal(trusted.sameSite, 'Lax');
    assert.equal(trusted.path, '/');
    assert.ok(Math.abs(trusted.expires - Date.now() / 1000 - 30 * 24 * 3600) < 30);

    await logout();
    assert.ok(await cookie(trustName));
    await signIn();
    await page.waitForURL(`${origin}/workspace`);
    await heading('Projects');

    stage = 'trusted browser revocation';
    await page.goto(`${origin}/settings/security`);
    await heading('Trusted browsers');
    await page.getByText(/^This browser · Added/u).waitFor();
    await button('Revoke trust').click();
    await page.getByText('You have no trusted browsers.').waitFor();
    assert.equal(await cookie(trustName), undefined);
    await context.addCookies([trusted]);
    await logout();
    await signIn();
    await heading('Verify your sign-in');
    await button('Use a recovery code').click();
    await page.getByLabel('Recovery code').fill(initialCodes[0]);
    await button('Verify and sign in').click();
    await page.waitForURL(`${origin}/workspace`);

    stage = 'recovery code renewal and MFA disablement';
    await page.goto(`${origin}/settings/security`);
    await heading('Account security');
    await button('Use a recovery code').click();
    await page.getByLabel('Current password').fill(password);
    await page.getByLabel('Recovery code').fill(initialCodes[1]);
    await button('Replace recovery codes').click();
    const renewed = await codeList();
    assert.equal(renewed.some((code) => initialCodes.includes(code)), false);
    await button('I saved my recovery codes').click();
    await button('Use a recovery code').click();
    await page.getByLabel('Current password').fill(password);
    await page.getByLabel('Recovery code').fill(initialCodes[2]);
    await button('Disable authenticator').click();
    await page.getByRole('alert').filter({ hasText: 'Enter your current password and a valid code.' }).waitFor();
    await page.getByLabel('Recovery code').fill(renewed[0]);
    await button('Disable authenticator').click();
    await page.waitForURL(`${origin}/sign-in`);
    assert.equal(await cookie(trustName), undefined);
    assert.equal(await cookie(sessionName), undefined);
    await signIn();
    await page.waitForURL(`${origin}/workspace`);
    await heading('Projects');
    console.log('Chromium proved factor enrollment, password-only cookie invalidation, TOTP, tested trust revocation and one-use recovery through the shipped TLS proxy.');
  }
} catch (error) {
  console.error(`Browser MFA acceptance failed during ${stage} (${error?.name ?? 'unknown error'}).`);
  const frame = String(error?.stack ?? '').split('\n').find((line) => line.startsWith('    at ') && line.includes(import.meta.url));
  if (frame) console.error(frame);
  process.exitCode = 1;
} finally {
  await browser.close();
}
