import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import { createMediaDecoder } from '../apps/backend/dist/application/media/decoder.js';
import { createMediaService } from '../apps/backend/dist/application/media/service.js';
import { createPrivateMediaStore } from '../apps/backend/dist/storage/blobs/private-store.js';
import { createTotpSecret, issueRecoveryCodes } from '../apps/backend/dist/application/auth/mfa-crypto.js';
import { assertOwnedMongoEnvironment } from './support/mongo-environment.ts';
import { cookieOf, fixtureId, ids, makeWorkspaceAccessFixture } from './support/workspace-access-fixture.mjs';
import { password } from './support/account-fixture.mjs';
import { withFixtureMongo } from './support/fixture-mongo.ts';
import { tlsBridge } from './support/tls-bridge.mjs';

assertOwnedMongoEnvironment(process.env);
const project = (id) => '/projects/' + id;
const board = (id) => '/boards/' + id;

async function workspaceBrowser(run, mediaEnabled = false) {
  await withFixtureMongo(async (mongo) => {
    let fixture;
    let web;
    let browser;
    let store;
    try {
      web = await tlsBridge(mongo.directory, async (browserOrigin) => {
        fixture = await makeWorkspaceAccessFixture(mongo, { browserOrigin, ...(mediaEnabled && {
          async configureMedia({ db, directory, installationId, gate, now }) {
            const staging = join(directory, 'staging');
            const blobs = join(directory, 'blobs');
            await mkdir(staging, { mode: 0o700 });
            await mkdir(blobs, { mode: 0o700 });
            store = await createPrivateMediaStore(staging, blobs);
            const decode = createMediaDecoder(fileURLToPath(new URL('../ops/package/decode-media.py', import.meta.url)),
              process.env.PLANNER_TEST_MEDIA_PYTHON || undefined);
            const media = createMediaService(db, installationId, gate, store, decode, { now });
            return (callback) => callback(media);
          },
        }) });
        return { path: fixture.socketPath, close: fixture.close };
      });
      browser = await chromium.launch();
      const page = async (viewport) => (await browser.newContext({ ignoreHTTPSErrors: true, viewport })).newPage();
      await run({ fixture, origin: web.origin, page });
    } finally { await Promise.allSettled([browser?.close(), web?.close()]); await store?.close(); }
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
    await p.getByLabel('Favorites only').click();
    await expect(p).toHaveURL((url) => url.searchParams.get('favorite') === 'true');
    await expect(p.getByLabel('Favorites only')).toBeChecked();
    await expect(shared).toBeVisible();
    await p.getByLabel('Show favorites in sidebar').click();
    await expect(p.getByRole('group', { name: 'Favorites', exact: true })).toHaveCount(0);
    await expect(p.getByLabel('Show favorites in sidebar')).not.toBeChecked();
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
    await p.getByLabel('Show favorites in sidebar').click();
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

test('project settings preserve a stale draft and refresh manager authority through ownership changes', { timeout: 120_000 }, async () => {
  await workspaceBrowser(async ({ fixture, origin, page }) => {
    const owner = await page({ width: 1440, height: 900 });
    const admin = await page({ width: 1440, height: 900 });
    const viewer = await page({ width: 1440, height: 900 });
    await signIn(owner, origin, 'create-only-owner');
    await signIn(admin, origin, 'admin');
    await signIn(viewer, origin, 'viewer');
    await expect(viewer.getByRole('button', { name: 'Create project', exact: true })).toHaveCount(0);
    await owner.getByRole('button', { name: 'Create project', exact: true }).click();
    const create = owner.getByRole('dialog', { name: 'Create project' });
    await create.getByLabel('Project name').fill('Browser project');
    await create.getByLabel('Description').fill('Original description');
    await create.getByLabel('Visibility').selectOption('private');
    await create.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(owner.getByRole('heading', { name: 'Browser project', level: 1 })).toBeVisible();
    const pathname = new URL(owner.url()).pathname;
    const id = pathname.split('/').at(-1);
    await admin.goto(origin + pathname);
    await expect(admin.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await owner.getByRole('button', { name: 'Project settings' }).click();
    const settings = owner.getByRole('dialog', { name: 'Project settings' });
    await settings.getByLabel('Project name').fill('Browser draft title');
    await fixture.gate.runCommand(() => fixture.db.collection('projects').updateOne({ ...fixture.scope, id }, {
      $set: { description: 'Changed by another session' }, $inc: { revision: 1 },
    }));
    await settings.getByRole('button', { name: 'Save project details' }).click();
    await expect(settings.getByRole('alert')).toContainText('Current information has been loaded');
    await expect(settings.getByLabel('Project name')).toHaveValue('Browser draft title');
    await expect(settings.getByLabel('Description')).toHaveValue('Changed by another session');
    await settings.getByRole('button', { name: 'Save project details' }).click();
    await expect(owner.getByRole('heading', { name: 'Browser draft title', level: 1 })).toBeVisible();
    await settings.getByRole('button', { name: 'Fern' }).click();
    await expect(settings.getByRole('button', { name: 'Fern' })).toHaveAttribute('aria-pressed', 'true');
    await settings.getByRole('button', { name: 'Make shared' }).click();
    await settings.getByRole('button', { name: 'Confirm shared' }).click();
    await expect(settings.getByText('Shared project', { exact: true })).toBeVisible();
    await settings.getByRole('button', { name: 'Close', exact: true }).click();
    await owner.getByRole('button', { name: 'Managers', exact: true }).click();
    const roster = owner.getByRole('dialog', { name: 'Project managers' });
    await roster.getByLabel('Find an eligible manager').fill('viewer');
    await roster.getByRole('button', { name: 'Search accounts' }).click();
    await expect(roster.getByText('No eligible accounts found.')).toBeVisible();
    await roster.getByLabel('Find an eligible manager').fill('project-manager');
    await roster.getByRole('button', { name: 'Search accounts' }).click();
    await roster.getByRole('button', { name: 'Add Fixture project-manager' }).click();
    await expect(roster.getByRole('button', { name: 'Remove Fixture project-manager' })).toBeVisible();
    await roster.getByRole('button', { name: 'Remove Fixture project-manager' }).click();
    await expect(roster.getByRole('button', { name: 'Add Fixture project-manager' })).toBeVisible();
    await roster.getByRole('button', { name: 'Remove Fixture create-only-owner' }).click();
    await expect(roster.getByRole('alert')).toContainText('Keep at least one project manager');
    await roster.getByRole('button', { name: 'Close', exact: true }).click();
    await admin.goto(origin + pathname);
    await admin.getByRole('button', { name: 'Project settings' }).click();
    const access = admin.getByRole('dialog', { name: 'Project settings' });
    await expect(access.getByLabel('Project name')).toHaveCount(0);
    await expect(access.getByLabel('Background image')).toHaveCount(0);
    await access.getByRole('button', { name: 'Hide project' }).click();
    await expect(access.getByRole('button', { name: 'Show project' })).toBeVisible();
    await access.getByRole('button', { name: 'Make private' }).click();
    await access.getByRole('button', { name: 'Confirm private' }).click();
    await expect(admin).toHaveURL(origin + '/workspace');
    await expect(admin.getByRole('dialog')).toHaveCount(0);
    await owner.reload();
    await expect(owner.getByRole('button', { name: 'Managers', exact: true })).toHaveCount(0);
    await owner.getByRole('button', { name: 'Delete project', exact: true }).click();
    const deletion = owner.getByRole('dialog', { name: 'Delete project' });
    await deletion.getByLabel('Confirm project name').fill('Incorrect title');
    await expect(deletion.getByRole('button', { name: 'Delete permanently' })).toBeDisabled();
    await deletion.getByLabel('Confirm project name').fill('Browser draft title');
    await deletion.getByRole('button', { name: 'Delete permanently' }).click();
    await expect(owner).toHaveURL(origin + '/workspace');
    await expect(owner.getByRole('link', { name: 'Browser draft title' })).toHaveCount(0);

    const shared = project(ids.sharedProject);
    await admin.goto(origin + shared);
    const managers = admin.getByRole('button', { name: 'Managers', exact: true });
    await expect(managers).toBeVisible();
    await admin.context().clearCookies();
    await managers.click();
    await expect(admin.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();
    assert.equal(new URL(admin.url()).searchParams.get('returnTo'), shared);
  });
});

const projectDecoderAvailable = !!process.env.PLANNER_TEST_MEDIA_PYTHON
  || spawnSync('/usr/bin/python3', ['-I', '-B', '-c', 'import PIL']).status === 0;

test('project image upload, selection and removal use the protected media path in Chromium', {
  timeout: 120_000, skip: !projectDecoderAvailable && 'Ubuntu python3-pil or PLANNER_TEST_MEDIA_PYTHON is required',
}, async () => {
  await workspaceBrowser(async ({ origin, page }) => {
    const owner = await page({ width: 1280, height: 860 });
    await signIn(owner, origin, 'private-owner');
    await owner.goto(origin + project(ids.privateProject));
    await owner.getByRole('button', { name: 'Project settings' }).click();
    const settings = owner.getByRole('dialog', { name: 'Project settings' });
    await settings.getByLabel('Background image').setInputFiles(fileURLToPath(new URL('./fixtures/media/sample.png', import.meta.url)));
    await settings.getByRole('button', { name: 'Upload image' }).click();
    const select = settings.getByRole('button', { name: 'Use sample.png' });
    await expect(select).toBeVisible();
    await select.click();
    await expect(select).toHaveAttribute('aria-pressed', 'true');
    await settings.getByRole('button', { name: 'Close', exact: true }).click();
    const banner = owner.locator('img.project-banner');
    await expect(banner).toBeVisible();
    await expect.poll(() => banner.evaluate((element) => element.naturalWidth)).toBeGreaterThan(0);
    await owner.getByRole('button', { name: 'Project settings' }).click();
    await settings.getByRole('button', { name: 'Remove sample.png' }).click();
    await expect(settings.getByRole('button', { name: 'None', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(settings.getByText('sample.png')).toHaveCount(0);
    await settings.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(banner).toHaveCount(0);
  }, true);
});

test('desktop manager creates, keyboard reorders and configures a board without losing explicit view or permissions', { timeout: 120_000 }, async () => {
  await workspaceBrowser(async ({ fixture: f, origin, page }) => {
    const owner = await page({ width: 1440, height: 900 });
    await signIn(owner, origin, 'private-owner');
    await owner.goto(origin + project(ids.privateProject));
    const main = owner.getByRole('main');
    await main.getByLabel('Board name').fill('  Morning dispatch  ');
    await main.getByRole('button', { name: 'Create board', exact: true }).click();
    const order = main.getByRole('list', { name: 'Board order' });
    const dispatch = order.getByRole('link', { name: 'Morning dispatch' });
    await expect(dispatch).toBeVisible();
    const move = order.getByRole('button', { name: 'Move Morning dispatch up' });
    await move.focus();
    await move.press('Enter');
    await expect(order.getByRole('link').first()).toHaveText('Morning dispatch');
    await expect(dispatch).toBeFocused();
    const href = await dispatch.getAttribute('href');
    await dispatch.click();
    await expect(main.getByRole('heading', { name: 'Morning dispatch', level: 1 })).toBeVisible();
    await main.getByRole('button', { name: 'Board settings', exact: true }).click();
    const settings = owner.getByRole('dialog', { name: 'Board settings' });
    await settings.getByLabel('Default view').selectOption('grid');
    await settings.getByLabel('Default card type').selectOption('story');
    await settings.getByLabel('Restrict card type').selectOption('story');
    await settings.getByLabel('Show card creator').check();
    await settings.getByLabel('Show card age').check();
    await settings.getByLabel('Show card count').check();
    await settings.getByLabel('Expand checklists').check();
    const createdId = href.split('/').at(-1);
    await f.gate.runCommand(() => f.db.collection('boards').updateOne({ ...f.scope, id: createdId }, { $inc: { revision: 1 } }));
    await settings.getByRole('button', { name: 'Save board settings' }).click();
    await expect(settings.getByRole('alert')).toContainText('your access changed');
    await expect(settings.getByLabel('Default view')).toHaveValue('grid');
    await settings.getByRole('button', { name: 'Save board settings' }).click();
    await expect(settings.getByRole('button', { name: 'Save board settings' })).toBeDisabled();
    await settings.getByRole('button', { name: 'Close', exact: true }).click();
    const view = main.getByRole('navigation', { name: 'Board view' });
    await expect(view.getByRole('link', { name: 'Grid' })).toHaveAttribute('aria-current', 'page');
    await view.getByRole('link', { name: 'List' }).click();
    await expect(owner).toHaveURL((url) => url.searchParams.get('view') === 'list');
    await expect(view.getByRole('link', { name: 'List' })).toHaveAttribute('aria-current', 'page');
    await owner.reload();
    await expect(view.getByRole('link', { name: 'List' })).toHaveAttribute('aria-current', 'page');
    await owner.goBack();
    await expect(view.getByRole('link', { name: 'Grid' })).toHaveAttribute('aria-current', 'page');
    await main.getByRole('button', { name: 'Board settings', exact: true }).click();
    await expect(settings.getByLabel('Default view')).toHaveValue('grid');
    await expect(settings.getByLabel('Restrict card type')).toHaveValue('story');
    await expect(settings.getByLabel('Expand checklists')).toBeChecked();
    await settings.getByRole('button', { name: 'Close', exact: true }).click();

    const sharedAdmin = await page({ width: 1440, height: 900 });
    await signIn(sharedAdmin, origin, 'admin');
    await sharedAdmin.goto(origin + project(ids.sharedProject));
    await expect(sharedAdmin.getByRole('button', { name: 'Create board', exact: true })).toHaveCount(0);
    await sharedAdmin.goto(origin + board(ids.sharedBoard));
    await expect(sharedAdmin.getByRole('heading', { name: 'Transfer destination' })).toBeVisible();
    await expect(sharedAdmin.getByRole('button', { name: 'Board settings' })).toHaveCount(0);
    await expect(sharedAdmin.getByRole('button', { name: 'Board members' })).toHaveCount(0);
  });
});

test('narrow board membership grants only selected access, handles leaving and deletes with exact confirmation', { timeout: 120_000 }, async () => {
  await workspaceBrowser(async ({ fixture: f, origin, page }) => {
    const owner = await page({ width: 390, height: 844 });
    const viewer = await page({ width: 390, height: 844 });
    await signIn(owner, origin, 'private-owner');
    await signIn(viewer, origin, 'viewer');
    await owner.goto(origin + project(ids.privateProject));
    const main = owner.getByRole('main');
    await main.getByLabel('Board name').fill('Shift handoff');
    await main.getByRole('button', { name: 'Create board', exact: true }).click();
    const link = main.getByRole('link', { name: 'Shift handoff' });
    await expect(link).toBeVisible();
    const href = await link.getAttribute('href');
    await viewer.goto(origin + href);
    await expect(viewer.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await link.click();
    await main.getByRole('button', { name: 'Board members' }).click();
    const roster = owner.getByRole('dialog', { name: 'Board members' });
    await roster.getByLabel('Find an eligible account').fill('disabled');
    await roster.getByRole('button', { name: 'Search accounts' }).click();
    await expect(roster.getByText('No eligible accounts found.')).toBeVisible();
    await roster.getByLabel('Find an eligible account').fill('viewer');
    await roster.getByRole('button', { name: 'Search accounts' }).click();
    await roster.getByLabel('Allow comments for Fixture viewer', { exact: true }).check();
    await roster.getByRole('button', { name: 'Add Fixture viewer', exact: true }).click();
    const members = roster.getByRole('region', { name: 'Current board members' });
    await expect(members.getByLabel('Allow comments for Fixture viewer', { exact: true })).toBeChecked();
    await members.getByLabel('Role for Fixture viewer', { exact: true }).selectOption('editor');
    await members.getByRole('button', { name: 'Update Fixture viewer', exact: true }).click();
    await expect(members.getByLabel('Role for Fixture viewer', { exact: true })).toHaveValue('editor');
    await expect(members.getByLabel('Allow comments for Fixture viewer', { exact: true })).toHaveCount(0);
    await roster.getByRole('button', { name: 'Close', exact: true }).click();
    await viewer.reload();
    await expect(viewer.getByRole('heading', { name: 'Shift handoff' })).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Board members' })).toHaveCount(0);
    await viewer.getByRole('button', { name: 'Leave board' }).click();
    await viewer.getByRole('button', { name: 'Confirm leave' }).click();
    await expect(viewer).toHaveURL(origin + project(ids.privateProject));
    await expect(viewer.getByRole('main').getByRole('link', { name: 'Shift handoff' })).toHaveCount(0);
    await viewer.goto(origin + href);
    await expect(viewer.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();

    await owner.getByRole('button', { name: 'Leave board' }).click();
    await owner.getByRole('button', { name: 'Confirm leave' }).click();
    await expect(owner.getByRole('button', { name: 'Leave board' })).toHaveCount(0);
    await expect(owner.getByRole('button', { name: 'Board settings' })).toBeVisible();
    const boardId = href.split('/').at(-1);
    const raw = '  Shift handoff\r\nEvening  ';
    const displayed = String.raw`"\u0020\u0020Shift\u0020handoff\r\nEvening\u0020\u0020"`;
    await f.gate.runCommand(() => f.db.collection('boards').updateOne({ ...f.scope, id: boardId },
      { $set: { name: raw }, $inc: { revision: 1 } }));
    await owner.reload();
    await expect(owner.getByRole('heading', { name: 'Shift handoff Evening' })).toBeVisible();
    await owner.getByRole('button', { name: 'Delete board', exact: true }).click();
    const confirmation = owner.getByRole('dialog', { name: 'Delete board' });
    const deleteBoard = confirmation.getByRole('button', { name: 'Permanently delete board' });
    await expect(confirmation.locator('code')).toHaveText(displayed);
    const exactName = confirmation.getByLabel('Confirm board name');
    await exactName.fill('Shift handoff');
    await expect(deleteBoard).toBeDisabled();
    await exactName.fill(displayed);
    const request = owner.waitForRequest((request) => request.method() === 'DELETE' && request.url().endsWith('/api/v1' + href));
    await deleteBoard.click();
    assert.equal((await request).postDataJSON().name, raw);
    await expect(owner).toHaveURL(origin + project(ids.privateProject));
    await expect(main.getByRole('link', { name: 'Shift handoff' })).toHaveCount(0);
    assert.equal(await f.db.collection('boards').findOne({ ...f.scope, id: boardId }), null);
    assert.ok(await main.evaluate((element) => element.scrollWidth <= element.clientWidth));
  });
});

test('direct editors create, edit and move board lists by keyboard and pointer, including stale order recovery', { timeout: 150_000 }, async () => {
  await workspaceBrowser(async ({ origin, page }) => {
    const editor = await page({ width: 1440, height: 900 });
    const colleague = await page({ width: 1440, height: 900 });
    const viewer = await page({ width: 390, height: 844 });
    const path = board(ids.privateBoard) + '?context=board&view=grid';
    await signIn(editor, origin, 'first-editor');
    await signIn(colleague, origin, 'second-editor');
    await signIn(viewer, origin, 'viewer');
    await editor.goto(origin + path);
    const listNames = (p) => p.getByRole('list', { name: 'Board lists' }).locator('strong');
    const listRow = (p, name) => p.getByRole('list', { name: 'Board lists' }).getByRole('listitem')
      .filter({ has: p.getByText(name, { exact: true }) });
    async function add(p, name, kind, color = '') {
      await p.getByRole('button', { name: 'Add list' }).click();
      const create = p.getByRole('dialog', { name: 'Create list' });
      await create.getByLabel('List name').fill(name);
      await create.getByLabel('List type').selectOption(kind);
      await create.getByLabel('List color').selectOption(color);
      await create.getByRole('button', { name: 'Create list', exact: true }).click();
      await expect(listRow(p, name)).toBeVisible();
    }

    await add(editor, 'Incoming', 'active', 'lagoon-blue');
    await add(editor, 'Finished', 'closed');
    await expect(listRow(editor, 'Incoming').getByText('Active', { exact: true })).toBeVisible();
    await expect(listRow(editor, 'Finished').getByText('Closed', { exact: true })).toBeVisible();
    await expect(listRow(editor, 'Incoming').getByRole('img', { name: 'Lagoon blue' })).toBeVisible();
    await editor.getByRole('button', { name: 'Edit Incoming', exact: true }).click();
    let edit = editor.getByRole('dialog', { name: 'Edit list' });
    await edit.getByLabel('List name').fill('Review queue');
    await edit.getByLabel('List color').selectOption('berry-red');
    await edit.getByRole('button', { name: 'Save list' }).click();
    await expect(listRow(editor, 'Review queue').getByRole('img', { name: 'Berry red' })).toBeVisible();
    await editor.getByRole('button', { name: 'Edit Review queue', exact: true }).click();
    edit = editor.getByRole('dialog', { name: 'Edit list' });
    await edit.getByLabel('List color').selectOption('');
    await edit.getByRole('button', { name: 'Save list' }).click();
    await expect(listRow(editor, 'Review queue').getByRole('img')).toHaveCount(0);

    let moveRequests = 0;
    editor.on('request', (request) => {
      if (request.method() === 'POST' && /\/api\/v1\/lists\/[^/]+\/move$/u.test(request.url())) moveRequests++;
    });
    const moveFinished = editor.getByRole('button', { name: 'Move Finished', exact: true });
    await moveFinished.focus();
    await editor.keyboard.press('Enter');
    const move = editor.getByRole('dialog', { name: 'Move list' });
    await expect(move.getByLabel('Place list')).toBeFocused();
    await editor.keyboard.press('Escape');
    await expect(move).toHaveCount(0);
    await expect(moveFinished).toBeFocused();
    assert.equal(moveRequests, 0);
    await editor.keyboard.press('Enter');
    await move.getByLabel('Place list').selectOption({ label: 'Before To do' });
    await move.getByRole('button', { name: 'Move list', exact: true }).press('Enter');
    await expect(listNames(editor)).toHaveText(['Finished', 'To do', 'Done', 'Review queue']);
    await expect(editor.getByText('Moved Finished.', { exact: true })).toBeVisible();
    await expect(moveFinished).toBeFocused();

    const source = listRow(editor, 'Review queue').locator('[data-list-drag-handle]');
    const target = listRow(editor, 'Done');
    const handle = await source.boundingBox();
    const box = await target.boundingBox();
    assert.ok(handle && box);
    await editor.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await editor.mouse.down();
    await editor.mouse.move(handle.x + handle.width / 2 - 15, handle.y + handle.height / 2, { steps: 4 });
    await editor.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
    await expect(target).toHaveAttribute('data-list-drop-target', 'true');
    await editor.mouse.up();
    await expect(listNames(editor)).toHaveText(['Finished', 'To do', 'Review queue', 'Done']);
    assert.equal(moveRequests, 2);
    await expect(editor).toHaveURL(origin + path);
    await editor.reload();
    await expect(listNames(editor)).toHaveText(['Finished', 'To do', 'Review queue', 'Done']);

    await colleague.goto(origin + path);
    const stale = colleague.getByRole('button', { name: 'Move Done', exact: true });
    await stale.click();
    const staleDialog = colleague.getByRole('dialog', { name: 'Move list' });
    await staleDialog.getByLabel('Place list').selectOption({ label: 'Before Finished' });
    await add(editor, 'Concurrent addition', 'active');
    await staleDialog.getByRole('button', { name: 'Move list', exact: true }).click();
    await expect(colleague.getByRole('alert')).toContainText('The list order changed');
    await expect(listNames(colleague)).toHaveText(['Finished', 'To do', 'Review queue', 'Done', 'Concurrent addition']);
    await expect(stale).toBeFocused();
    await expect(colleague).toHaveURL(origin + path);

    await viewer.goto(origin + path);
    await expect(listNames(viewer)).toHaveText(['Finished', 'To do', 'Review queue', 'Done', 'Concurrent addition']);
    await expect(viewer.getByRole('button', { name: 'Add list' })).toHaveCount(0);
    await expect(viewer.getByRole('button', { name: 'Move Done' })).toHaveCount(0);
    await editor.getByRole('link', { name: 'Archive', exact: true }).click();
    await expect(listNames(editor)).toHaveText(['Archive']);
    await expect(editor.getByRole('button', { name: 'Edit Archive' })).toHaveCount(0);
    await expect(editor.getByRole('button', { name: 'Add list' })).toHaveCount(0);
  });
});

test('project deletion confirms and sends an exact imported name with spaces and line breaks', { timeout: 120_000 }, async () => {
  await workspaceBrowser(async ({ fixture, origin, page }) => {
    const id = fixtureId(2899);
    const raw = '  Imported\r\n' + 'Long title '.repeat(15);
    const displayed = String.raw`"\u0020\u0020Imported\r\n` + String.raw`Long\u0020title\u0020`.repeat(15) + '"';
    await fixture.insert('projects', id, { name: raw, type: 'shared', hidden: false, ownerProjectManagerId: null, rank: '2899' });
    await fixture.insert('projectManagers', fixtureId(2900), { projectId: id, userId: ids.projectManager });
    const owner = await page({ width: 390, height: 844 });
    await signIn(owner, origin, 'project-manager');
    await owner.goto(origin + project(id));
    await owner.getByRole('button', { name: 'Delete project', exact: true }).click();
    const dialog = owner.getByRole('dialog', { name: 'Delete project' });
    await expect(dialog.locator('code')).toHaveText(displayed);
    const input = dialog.getByLabel('Confirm project name');
    const remove = dialog.getByRole('button', { name: 'Delete permanently' });
    await input.fill(displayed.replace(String.raw`\u0020"`, '"'));
    await expect(remove).toBeDisabled();
    await input.fill(displayed);
    await expect(remove).toBeEnabled();
    const request = owner.waitForRequest((request) => request.method() === 'DELETE' && request.url().endsWith('/api/v1' + project(id)));
    await remove.click();
    assert.equal((await request).postDataJSON().name, raw);
    await expect(owner).toHaveURL(origin + '/workspace');
    assert.equal(await fixture.db.collection('projects').findOne({ ...fixture.scope, id }), null);
  });
});
