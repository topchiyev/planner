import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import { readMigrationAdminActivationProof } from '../apps/backend/dist/application/auth/migration-admin.js';
import { accountFixture, callSocket, changedPassword, password } from './support/account-fixture.mjs';
import { migrationAdminFixture, stagedPassword } from './support/migration-admin-fixture.mjs';
import { tlsBridge } from './support/tls-bridge.mjs';
import { withFixtureMongo } from './support/fixture-mongo.ts';
import { assertOwnedMongoEnvironment } from './support/mongo-environment.ts';

assertOwnedMongoEnvironment(process.env);

test('Chromium recovers the designated imported administrator and enrolls MFA while workspace access stays closed', { timeout: 45_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const fixture = await migrationAdminFixture(mongo);
    const account = await fixture.seed('9007199254741201', { mfa: true });
    const grant = await fixture.issue({ sourceUserId: '9007199254741201' });
    await fixture.startGate();
    let browser;
    let web;
    try {
      web = await tlsBridge(mongo.directory, fixture.startBrowser);
      browser = await chromium.launch();
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      await page.goto(web.origin + '/account-recovery');
      await page.getByLabel('Recovery grant').fill(grant.grant);
      await page.getByLabel('New password').fill(stagedPassword);
      await page.getByLabel('Confirm password').fill(stagedPassword);
      await page.getByRole('button', { name: 'Set password' }).click();
      await expect(page.getByRole('heading', { name: 'Set up your authenticator' })).toBeVisible();
      expect(await readMigrationAdminActivationProof(mongo.db, fixture.run)).toBeNull();
      await page.getByRole('button', { name: 'Set up authenticator' }).click();
      const setup = page.getByLabel('Authenticator setup key');
      await expect(setup).toBeVisible();
      const totp = new TOTP({ secret: Secret.fromBase32(await setup.textContent()), algorithm: 'SHA1', digits: 6, period: 30 });
      await page.getByLabel('Authenticator code').fill(totp.generate({ timestamp: fixture.now().valueOf() }));
      await page.getByRole('button', { name: 'Verify authenticator' }).click();
      await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
      await page.getByRole('button', { name: 'I saved my recovery codes' }).click();
      await expect(page.getByRole('heading', { name: 'Administrator recovery complete' })).toBeVisible();
      assert.equal((await readMigrationAdminActivationProof(mongo.db, fixture.run))?.userId, account.id);
      assert.deepEqual(await context.cookies(), []);
      assert.equal((await context.request.get(web.origin + '/workspace')).status(), 503);
      assert.equal((await context.request.get(web.origin + '/health/ready')).status(), 503);
    } finally { await browser?.close(); await web?.close(); await fixture.closeGate(); }
  });
});

async function signIn(page, host, email, pass) {
  await page.goto(host + '/sign-in');
  await page.getByLabel('Email or username').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(pass);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(host + '/workspace');
}

test('Chromium manages accounts, completes local recovery, changes credentials and signs out', { timeout: 90_000 }, async () => {
  await withFixtureMongo(async (mongo) => {
    const f = await accountFixture(mongo);
    let web;
    let local;
    let browser;
    try {
      web = await tlsBridge(mongo.directory, f.startBrowser);
      local = await f.startOperator();
      browser = await chromium.launch();
      await f.seed('admin@example.test', { name: 'Site administrator', role: 'admin' });
      const admin = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await admin.newPage();
      await signIn(page, web.origin, 'admin@example.test', password);
      await page.getByRole('link', { name: 'Manage accounts' }).click();
      await expect(page.getByRole('heading', { name: 'Manage accounts' })).toBeVisible();
      const provision = page.getByRole('heading', { name: 'Add an account' }).locator('..');
      await provision.getByLabel('Full name').fill('Browser member');
      await provision.getByLabel('Email').fill('browser@example.test');
      await provision.getByRole('button', { name: 'Add account' }).click();
      await expect(page.getByRole('heading', { name: 'Browser member', exact: true })).toBeVisible();
      const card = page.getByRole('heading', { name: 'Browser member', exact: true }).locator('..');
      await card.getByRole('button', { name: 'Request password reset' }).click();
      const confirmation = page.getByRole('region', { name: 'Pending local confirmation' });
      await expect(confirmation).toBeVisible();
      const operatorCommand = await confirmation.getByText('sudo plannerctl accounts inspect', { exact: false }).textContent();
      const approvalId = operatorCommand.split(' ').at(-1);
      const issued = await callSocket(local.path, '/accounts/approvals/' + approvalId + '/confirm', { method: 'POST' });
      assert.equal(issued.status, 200, JSON.stringify(issued.data));
      const grant = issued.data.recovery.grant;
      await expect(page.locator('body')).not.toContainText(grant);

      const narrow = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
      const member = await narrow.newPage();
      await member.goto(web.origin + '/account-recovery');
      await member.getByLabel('Recovery grant').fill(grant);
      await member.getByLabel('New password').fill(password);
      await member.getByLabel('Confirm password').fill(password);
      await member.getByRole('button', { name: 'Set password' }).click();
      await expect(member.getByRole('heading', { name: 'Password set' })).toBeVisible();
      await signIn(member, web.origin, 'browser@example.test', password);
      const secondContext = await browser.newContext({ ignoreHTTPSErrors: true });
      const other = await secondContext.newPage();
      await signIn(other, web.origin, 'browser@example.test', password);
      await other.getByRole('link', { name: 'Account settings' }).click();
      await expect(other.getByRole('heading', { name: 'Account settings' })).toBeVisible();
      await member.getByRole('button', { name: 'Menu' }).click();
      await member.getByRole('link', { name: 'Account settings' }).click();
      await expect(member.getByRole('heading', { name: 'Account settings' })).toBeVisible();
      await member.getByLabel('Full name').fill('Updated Browser Member');
      await member.getByRole('button', { name: 'Save profile' }).click();
      await expect(member.getByRole('status')).toContainText('Profile saved');
      await other.getByLabel('Full name').fill('Stale edit');
      await other.getByRole('button', { name: 'Save profile' }).click();
      await expect(other.getByRole('alert')).toContainText('The current settings have been loaded');
      await expect(other.getByLabel('Full name')).toHaveValue('Updated Browser Member');
      await other.getByLabel('Full name').fill('Retried edit');
      await other.getByRole('button', { name: 'Save profile' }).click();
      await expect(other.getByRole('status')).toContainText('Profile saved');
      let letProfileRead;
      let letOldPreferencesReturn;
      let capturedPreferences;
      const profileRead = new Promise((resolve) => { letProfileRead = resolve; });
      const oldPreferencesReturn = new Promise((resolve) => { letOldPreferencesReturn = resolve; });
      const captured = new Promise((resolve) => { capturedPreferences = resolve; });
      await member.route('**/api/v1/me/profile', async (route) => {
        await profileRead;
        await route.continue();
      });
      await member.route('**/api/v1/me/preferences', async (route) => {
        const response = await route.fetch();
        capturedPreferences();
        await oldPreferencesReturn;
        await route.fulfill({ response });
      });
      const refreshed = member.reload();
      try {
        await captured;
        await other.getByLabel('Editor').selectOption('markup');
        await other.getByRole('button', { name: 'Save preferences' }).click();
        await expect(other.getByRole('status')).toContainText('Preferences saved');
      } finally { letProfileRead(); letOldPreferencesReturn(); }
      await refreshed;
      await expect(member.getByLabel('Full name')).toHaveValue('Retried edit');
      await expect(member.getByLabel('Editor')).toHaveValue('wysiwyg');
      await member.unroute('**/api/v1/me/profile');
      await member.unroute('**/api/v1/me/preferences');
      await member.getByLabel('Projects view').selectOption('gridProjects');
      await member.getByRole('button', { name: 'Save preferences' }).click();
      await expect(member.getByRole('alert')).toContainText('The current settings have been loaded');
      await expect(member.getByLabel('Editor')).toHaveValue('markup');
      await member.getByLabel('Projects view').selectOption('gridProjects');
      await member.getByRole('button', { name: 'Save preferences' }).click();
      await expect(member.getByRole('status')).toContainText('Preferences saved');
      await expect(member.getByLabel('Editor')).toHaveValue('markup');
      const security = member.getByRole('heading', { name: 'Change password' }).locator('..');
      await security.getByLabel('Current password').fill(password);
      await security.getByLabel('New password', { exact: true }).fill(changedPassword);
      await security.getByLabel('Confirm new password').fill(changedPassword);
      await security.getByRole('button', { name: 'Change password and sign out' }).click();
      await expect(member).toHaveURL(web.origin + '/sign-in');
      await other.reload();
      await expect(other).toHaveURL(web.origin + '/sign-in');
      await signIn(member, web.origin, 'browser@example.test', changedPassword);
      await member.getByRole('button', { name: 'Menu' }).click();
      await member.getByRole('button', { name: 'Sign out' }).click();
      await expect(member).toHaveURL(web.origin + '/sign-in');
      const response = await member.request.get(web.origin + '/api/v1/session');
      assert.equal(response.status(), 401);
    } finally { await Promise.allSettled([browser?.close(), local?.close(), web?.close(), f.close()]); }
  });
});
