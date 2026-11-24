import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { accountFixture, callSocket, changedPassword, password, proxyHeaders } from './support/account-fixture.mjs';
import { withFixtureMongo } from './support/fixture-mongo.ts';
import { assertOwnedMongoEnvironment } from './support/mongo-environment.ts';

assertOwnedMongoEnvironment(process.env);

async function tlsBridge(directory, startProxy) {
  const key = join(directory, 'tls-key');
  const cert = join(directory, 'tls-cert');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  let proxy;
  let origin;
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (incoming, reply) => {
    const forwarded = request({ socketPath: proxy.path, path: incoming.url, method: incoming.method,
      headers: { ...incoming.headers, ...proxyHeaders(origin) } }, (response) => {
      reply.writeHead(response.statusCode, response.headers);
      response.pipe(reply);
    });
    forwarded.once('error', () => reply.destroy());
    incoming.pipe(forwarded);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = 'https://127.0.0.1:' + server.address().port;
  try { proxy = await startProxy(origin); }
  catch (error) { server.close(); throw error; }
  return { origin, close: async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await proxy.close();
  } };
}

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
      await member.reload();
      await expect(member.getByLabel('Full name')).toHaveValue('Retried edit');
      await member.getByLabel('Projects view').selectOption('gridProjects');
      await member.getByRole('button', { name: 'Save preferences' }).click();
      await expect(member.getByRole('status')).toContainText('Preferences saved');
      const security = member.getByRole('heading', { name: 'Change password' }).locator('..');
      await security.getByLabel('Current password').fill(password);
      await security.getByLabel('New password').fill(changedPassword);
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
