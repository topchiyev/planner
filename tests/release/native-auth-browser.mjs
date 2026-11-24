import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const [setupPath, executablePath, certificateKey] = process.argv.slice(2);
const { chromium } = await import(new URL('./playwright-core/index.mjs', import.meta.url));
const { firstAdminGrant } = JSON.parse(await readFile(setupPath, 'utf8'));
const origin = 'https://planner.example.test';
const identity = 'synthetic.admin@example.test';
const password = '  Owned äccount 🗝️ pass & %  ';
const cookieName = '__Host-planner-session';
const browser = await chromium.launch({
  executablePath,
  args: [
    '--disable-dev-shm-usage',
    '--no-proxy-server',
    '--host-resolver-rules=MAP planner.example.test 127.0.0.1',
    `--ignore-certificate-errors-spki-list=${certificateKey}`,
  ],
});
let stage = 'browser launch';
try {
  const page = await browser.newPage();
  const head = (name) => page.getByRole('heading', { name, exact: true }).waitFor();
  const url = (path) => page.waitForURL(new URL(path, origin).href);
  stage = 'enrollment';
  assert.equal((await page.goto(`${origin}/recover`)).status(), 200);
  assert.equal(await page.evaluate(() => isSecureContext), true);
  await head('Create the first administrator');
  await page.getByLabel('Enrollment grant').fill(firstAdminGrant.token);
  await page.getByLabel('Full name').fill('Synthetic Admin');
  await page.getByLabel('Email', { exact: true }).fill(identity);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password + 'x');
  await page.getByRole('button', { name: 'Create administrator' }).click();
  await page.getByRole('alert').filter({ hasText: 'The passwords must match.' }).waitFor();
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Create administrator' }).click();
  await head('Administrator account created');
  assert.equal((await page.context().cookies()).some((cookie) => cookie.name === cookieName), false);

  stage = 'shipped sign-in';
  await page.getByRole('link', { name: 'Continue to sign in' }).click();
  await head('Sign in');
  await page.getByLabel('Email or username').fill(identity.toUpperCase());
  await page.getByLabel('Password').fill('wrong synthetic password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('alert').filter({ hasText: 'Incorrect identifier or password.' }).waitFor();
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await url('/workspace');
  await head('Projects');

  stage = 'authenticated cookie and logout';
  const cookie = (await page.context().cookies()).find(({ name }) => name === cookieName);
  assert.ok(cookie?.secure && cookie.httpOnly);
  assert.equal(cookie.sameSite, 'Lax');
  assert.equal(cookie.path, '/');
  assert.equal(cookie.domain, 'planner.example.test');
  assert.equal(await page.evaluate((name) => document.cookie.includes(name), cookieName), false);
  assert.equal(await page.evaluate(async () => (await fetch('/api/v1/session', { method: 'DELETE' })).status), 403);
  const old = await page.context().newPage();
  await old.goto(`${origin}/workspace`);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await url('/sign-in');
  await head('Sign in');
  assert.equal((await page.context().cookies()).some(({ name }) => name === cookieName), false);
  await page.context().addCookies([cookie]);
  assert.equal(await page.evaluate(async () => (await fetch('/api/v1/session')).status), 401);
  await old.reload();
  await old.waitForURL(`${origin}/sign-in`);
  await old.close();
  assert.equal((await page.goto(`${origin}/boards/synthetic/cards/test`)).url(), `${origin}/sign-in`);
  console.log('Chromium enrolled a local administrator, signed in through the shipped TLS proxy, and proved server-side logout.');
} catch (error) {
  console.error(`Browser acceptance failed during ${stage} (${error?.name ?? 'unknown error'}).`);
  const source = fileURLFrame(error);
  if (source) console.error(source);
  process.exitCode = 1;
} finally {
  await browser.close();
}

function fileURLFrame(error) {
  const file = pathToFileURL(process.argv[1]).href;
  return String(error?.stack ?? '').split('\n').find((line) => line.startsWith('    at ') && line.includes(file));
}
