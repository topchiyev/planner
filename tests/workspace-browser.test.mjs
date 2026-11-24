import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import { createTotpSecret, issueRecoveryCodes } from '../apps/backend/dist/application/auth/mfa-crypto.js';
import { assertOwnedMongoEnvironment } from './support/mongo-environment.ts';
import { cookieOf, fixtureId, ids, makeWorkspaceAccessFixture } from './support/workspace-access-fixture.mjs';
import { password } from './support/account-fixture.mjs';
import { withFixtureMongo } from './support/fixture-mongo.ts';
import { tlsBridge } from './support/tls-bridge.mjs';

assertOwnedMongoEnvironment(process.env);
const project = (id) => '/projects/' + id;
const board = (id) => '/boards/' + id;

async function workspaceBrowser(run) {
  await withFixtureMongo(async (mongo) => {
    let fixture;
    let web;
    let browser;
    try {
      web = await tlsBridge(mongo.directory, async (browserOrigin) => {
        fixture = await makeWorkspaceAccessFixture(mongo, { browserOrigin });
        return { path: fixture.socketPath, close: fixture.close };
      });
      browser = await chromium.launch();
      const page = async (viewport) => (await browser.newContext({ ignoreHTTPSErrors: true, viewport })).newPage();
      await run({ fixture, origin: web.origin, page });
    } finally { await Promise.allSettled([browser?.close(), web?.close()]); }
  });
}

async function submitSignIn(page, name) {
  await page.getByLabel('Email or username').fill(name + '@planner.invalid');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function signIn(page, origin, name, target = '') {
  await page.goto(origin + '/sign-in' + target);
  await submitSignIn(page, name);
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
}

function tile(page, name) {
  return page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
}

async function saveFromOtherClient(page, origin, preferences) {
  const account = await (await page.request.get(origin + '/api/v1/session')).json();
  const current = await (await page.request.get(origin + '/api/v1/me/preferences')).json();
  const response = await page.request.patch(origin + '/api/v1/me/preferences', {
    headers: { Origin: origin, 'X-CSRF-Token': account.csrfToken, 'Idempotency-Key': randomUUID() },
    data: { revision: current.revision, preferences },
  });
  assert.equal(response.status(), 200);
}

test('desktop workspace loads authorized counts, pages, search, hidden state and personal favorites', { timeout: 120_000 }, async () => {
  await workspaceBrowser(async ({ fixture: f, origin, page }) => {
    const sibling = fixtureId(800);
    await f.insert('boards', sibling, { projectId: ids.sharedProject, name: 'Shared sibling board', rank: '2048' });
    for (let index = 0; index < 26; index++) {
      await f.insert('projects', fixtureId(1000 + index), { name: 'Workspace page ' + String(index).padStart(2, '0'),
        type: 'shared', hidden: false, ownerProjectManagerId: null, rank: String((index + 10) * 1024) });
    }
    await f.insert('projects', fixtureId(1900), { name: 'Alphabetically first', type: 'shared',
      hidden: false, ownerProjectManagerId: null, rank: '99000' });
    const p = await page({ width: 1440, height: 900 });
    const main = p.getByRole('main');
    let eagerlyFetched = false;
    const detectBoards = (request) => { if (request.url().endsWith('/api/v1/projects/' + ids.sharedProject + '/boards')) eagerlyFetched = true; };
    p.on('request', detectBoards);
    await signIn(p, origin, 'admin');
    const shared = tile(p, 'Shared fixture project');
    await expect(shared.getByText('2 boards', { exact: true })).toBeVisible();
    await expect(main.getByText('Private fixture project')).toHaveCount(0);
    await expect(main.getByText('Hidden fixture project')).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'Create project' })).toHaveCount(0);
    assert.equal(eagerlyFetched, false);
    p.off('request', detectBoards);
    const expand = shared.getByRole('button', { name: 'Boards in Shared fixture project' });
    await expand.focus();
    await expand.press('Enter');
    await expect(expand).toHaveAttribute('aria-expanded', 'true');
    await expect(expand).toBeFocused();
    await expect(shared.getByRole('link', { name: 'Shared sibling board' })).toBeVisible();
    assert.equal(new URL(p.url()).searchParams.get('open'), ids.sharedProject);
    await p.reload();
    await expect(shared.getByRole('link', { name: 'Transfer destination' })).toBeVisible();

    await main.getByRole('link', { name: 'Next page' }).click();
    await expect(main.getByRole('link', { name: 'Workspace page 25' })).toBeVisible();
    assert.ok(new URL(p.url()).searchParams.get('cursor'));
    await p.goBack();
    await expect(shared.getByRole('link', { name: 'Shared sibling board' })).toBeVisible();

    await p.getByLabel('Visibility').selectOption('only');
    await expect(tile(p, 'Hidden fixture project')).toBeVisible();
    await expect(shared).toHaveCount(0);
    assert.equal(new URL(p.url()).searchParams.get('hidden'), 'only');
    await p.reload();
    await expect(tile(p, 'Hidden fixture project').getByText('Hidden', { exact: true })).toBeVisible();
    await p.getByLabel('Visibility').selectOption('exclude');
    await expect(shared).toBeVisible();
    assert.equal((await f.db.collection('projects').findOne({ ...f.scope, id: ids.hiddenProject })).hidden, true);

    await p.getByLabel('Search projects').fill('Shared fixture');
    await p.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(main.getByRole('article')).toHaveCount(1);
    assert.equal(new URL(p.url()).searchParams.get('q'), 'Shared fixture');
    await p.reload();
    await expect(p.getByLabel('Search projects')).toHaveValue('Shared fixture');
    const favoriteRequest = p.waitForRequest((request) => request.url().includes('/api/v1/projects?')
      && new URL(request.url()).searchParams.get('favorite') === 'true');
    await shared.getByRole('button', { name: 'Add Shared fixture project to favorites' }).click();
    await favoriteRequest;
    await expect(shared.getByRole('button', { name: 'Remove Shared fixture project from favorites' })).toHaveAttribute('aria-pressed', 'true');
    await expect(p.getByRole('group', { name: 'Favorites', exact: true }).getByRole('link', { name: 'Shared fixture project' })).toBeVisible();
    assert.equal((await f.db.collection('projects').findOne({ ...f.scope, id: ids.sharedProject })).revision, 1);
    await p.getByLabel('Favorites only').check();
    await expect(p).toHaveURL((url) => url.searchParams.get('favorite') === 'true');
    await expect(shared).toBeVisible();
    await p.getByLabel('Show favorites in sidebar').uncheck();
    await expect(p.getByRole('group', { name: 'Favorites', exact: true })).toHaveCount(0);
    await expect(shared).toBeVisible();

    await saveFromOtherClient(p, origin, { editorMode: 'markup' });
    await p.getByLabel('Projects view').selectOption('gridProjects');
    await expect(p.getByRole('alert')).toContainText('The current information has been loaded');
    await expect(p.getByLabel('Projects view')).toHaveValue('groupedProjects');
    await expect(p.getByLabel('Projects view')).toBeEnabled();
    await p.getByLabel('Projects view').selectOption('gridProjects');
    await expect(main.locator('.workspace-projects')).toHaveAttribute('data-view', 'grid');
    await p.getByLabel('Sort projects').selectOption('alphabetically');
    await expect(p.getByLabel('Sort projects')).toHaveValue('alphabetically');
    await expect(p.getByLabel('Sort projects')).toBeEnabled();
    await p.reload();
    await expect(main.locator('.workspace-projects')).toHaveAttribute('data-view', 'grid');
    await expect(p.getByLabel('Sort projects')).toHaveValue('alphabetically');
    assert.equal((await (await p.request.get(origin + '/api/v1/me/preferences')).json()).preferences.editorMode, 'markup');

    await f.gate.runCommand(() => f.db.collection('projects').updateOne({ ...f.scope, id: ids.sharedProject },
      { $set: { name: 'Shared fixture project updated' }, $inc: { revision: 1 } }));
    await shared.getByRole('button', { name: 'Remove Shared fixture project from favorites' }).click();
    await expect(p.getByRole('alert')).toContainText('The current information has been loaded');
    const updated = tile(p, 'Shared fixture project updated');
    await expect(updated.getByRole('button', { name: 'Remove Shared fixture project updated from favorites' })).toBeVisible();
    await updated.getByRole('button', { name: 'Remove Shared fixture project updated from favorites' }).click();
    await expect(main.getByRole('heading', { name: 'No matching projects' })).toBeVisible();
    assert.equal(await f.db.collection('events').countDocuments(f.scope), 0);
    await p.goto(origin + '/workspace');
    await expect(main.getByRole('article').first().getByRole('heading')).toHaveText('Alphabetically first');
    for (let index = 0; index < 26; index++) {
      await f.insert('projectFavorites', fixtureId(2100 + index), { projectId: fixtureId(1000 + index), userId: ids.admin });
    }
    await p.getByLabel('Show favorites in sidebar').check();
    const favoriteGroup = p.getByRole('group', { name: 'Favorites', exact: true });
    await favoriteGroup.getByRole('link', { name: 'More favorites' }).click();
    await expect(favoriteGroup.getByRole('link', { name: 'Workspace page 25' })).toBeVisible();
    const session = await (await p.request.get(origin + '/api/v1/session')).json();
    const removed = await p.request.delete(origin + '/api/v1/projects/' + fixtureId(1025) + '/favorite', {
      headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': randomUUID(), 'If-Match': '"1"' },
    });
    assert.equal(removed.status(), 204);
    await p.reload();
    await expect(favoriteGroup.getByRole('link', { name: 'Workspace page 25' })).toHaveCount(0);
    await favoriteGroup.getByRole('link', { name: 'First favorites page' }).click();
    await expect(favoriteGroup.getByRole('link', { name: 'Workspace page 00' })).toBeVisible();
    await p.route('**/api/v1/projects?*', (route) => route.fulfill({ status: 503 }));
    await p.goto(origin + '/settings');
    await expect(p.getByRole('heading', { name: 'Account settings', level: 1 })).toBeVisible();
  });
});

test('native project and board links restore the authorized selection through MFA and deny lost or mismatched access', { timeout: 120_000 }, async () => {
  await workspaceBrowser(async ({ fixture: f, origin, page }) => {
    const sibling = fixtureId(810);
    await f.insert('boards', sibling, { projectId: ids.privateProject, name: 'Private sibling board', rank: '2048' });
    const factorId = randomUUID();
    const factor = createTotpSecret(f.mfaKey, { installationId: f.installationId, generationId: f.generationId, userId: ids.viewer, factorId }, 'Viewer');
    await f.gate.runCommand(() => f.db.collection('users').updateOne({ ...f.scope, id: ids.viewer }, { $set: {
      'localAuth.mfa': 'totp', 'localAuth.factor': { id: factorId, encrypted: factor.encrypted, greatestCounter: 0, recoveryDigests: issueRecoveryCodes().digests },
    } }));

    const narrow = await page({ width: 390, height: 844 });
    const destination = board(ids.privateBoard) + '/cards/' + ids.activeCard + '?context=board&view=grid';
    await narrow.goto(origin + destination);
    assert.equal(new URL(narrow.url()).searchParams.get('returnTo'), destination);
    await submitSignIn(narrow, 'viewer');
    await expect(narrow.getByRole('heading', { name: 'Verify your sign-in' })).toBeVisible();
    assert.equal((await narrow.request.get(origin + '/api/v1/session')).status(), 401);
    const totp = new TOTP({ secret: Secret.fromBase32(factor.secret), digits: 6, period: 30, algorithm: 'SHA1' });
    await narrow.getByLabel('Authenticator code').fill(totp.generate({ timestamp: f.now().getTime() }));
    await narrow.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(narrow).toHaveURL(origin + destination);
    await expect(narrow.getByRole('heading', { name: 'Moving an assigned card' })).toBeVisible();
    await narrow.reload();
    await expect(narrow.getByRole('heading', { name: 'Moving an assigned card' })).toBeVisible();
    await narrow.getByRole('link', { name: 'Close card' }).click();
    await expect(narrow.getByRole('link', { name: 'Grid', exact: true })).toHaveAttribute('aria-current', 'page');
    await narrow.goBack();
    await expect(narrow.getByRole('heading', { name: 'Moving an assigned card' })).toBeVisible();
    assert.equal(await narrow.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await narrow.getByRole('button', { name: 'Menu' }).click();
    const sidebar = narrow.getByRole('navigation', { name: 'Project navigation' });
    await expect(sidebar.getByRole('link', { name: 'Transfer source' })).toBeVisible();
    await expect(sidebar.getByText('Private sibling board')).toHaveCount(0);
    await sidebar.getByRole('link', { name: 'Private fixture project' }).click();
    await expect(narrow.getByRole('heading', { name: 'Private fixture project', level: 1 })).toBeVisible();
    await expect(narrow.getByRole('region', { name: 'Boards' }).getByRole('link')).toHaveCount(1);
    await narrow.goBack();
    await expect(narrow).toHaveURL(origin + destination);
    await expect(narrow.getByRole('heading', { name: 'Moving an assigned card' })).toBeVisible();
    await narrow.goto(origin + board(ids.privateBoard) + '/cards/' + ids.sharedTarget);
    await expect(narrow.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(narrow.getByText('Cross-board linked target')).toHaveCount(0);

    const longProjectId = fixtureId(1800);
    const longBoardId = fixtureId(1801);
    const longListId = fixtureId(1802);
    const longCardId = fixtureId(1803);
    const longProject = 'Project'.repeat(18);
    const longBoard = 'Board'.repeat(25);
    const longList = 'List'.repeat(32);
    const longCard = 'Card'.repeat(32);
    await f.insert('projects', longProjectId, { name: longProject, type: 'shared', hidden: false,
      ownerProjectManagerId: null, rank: '18432' });
    await f.insert('boards', longBoardId, { name: longBoard, projectId: longProjectId, rank: '1024' });
    await f.insert('lists', longListId, { name: longList, boardId: longBoardId, kind: 'active', rank: '1024' });
    await f.insert('cards', longCardId, { name: longCard, boardId: longBoardId, listId: longListId, kind: 'board', type: 'project', rank: '1024' });
    await f.insert('boardMembers', fixtureId(1804), { boardId: longBoardId, userId: ids.viewer, role: 'viewer', canComment: false });
    for (const [path, title] of [
      [project(longProjectId), longProject], [board(longBoardId), longBoard], [board(longBoardId) + '/cards/' + longCardId, longCard],
    ]) {
      await narrow.goto(origin + path);
      await expect(narrow.getByRole('heading', { name: title, exact: true })).toBeVisible();
      if (title === longBoard) await expect(narrow.getByRole('list', { name: 'Board lists' }).getByText(longList)).toBeVisible();
      assert.equal(await narrow.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, title);
    }

    const owner = await page({ width: 1440, height: 900 });
    await signIn(owner, origin, 'private-owner');
    await expect(tile(owner, 'Private fixture project').getByText('2 boards')).toBeVisible();
    await tile(owner, 'Private fixture project').getByRole('link', { name: 'Private fixture project' }).click();
    await expect(owner.getByRole('region', { name: 'Boards' }).getByRole('link')).toHaveCount(2);
    assert.equal((await owner.request.get(origin + '/api/v1/cards/' + ids.activeCard + '?boardId=' + ids.hiddenBoard)).status(), 404);

    const unrelated = await page({ width: 390, height: 844 });
    await signIn(unrelated, origin, 'unrelated', '?' + new URLSearchParams({ returnTo: '//example.invalid/elsewhere' }));
    await expect(unrelated).toHaveURL(origin + '/workspace');
    await expect(unrelated.getByRole('heading', { name: 'No projects to show' })).toBeVisible();
    for (const path of [project(ids.privateProject), project(fixtureId(9000)), board(ids.privateBoard)]) {
      await unrelated.goto(origin + path);
      await expect(unrelated.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    }

    const manager = await f.login(ids.privateOwner);
    const removed = await f.call('/api/v1' + board(ids.privateBoard) + '/members/' + ids.viewer, cookieOf(manager), {
      method: 'DELETE', headers: { Origin: origin, 'X-CSRF-Token': manager.data.csrfToken, 'If-Match': '"1"', 'Idempotency-Key': randomUUID() },
    });
    assert.equal(removed.status, 204, JSON.stringify(removed.data));
    await narrow.goto(origin + destination);
    await expect(narrow.getByRole('heading', { name: 'Page not found', level: 1 })).toBeVisible();
    await expect(narrow.getByText('Moving an assigned card')).toHaveCount(0);
    await expect(narrow.getByText('Private fixture project')).toHaveCount(0);
  });
});
