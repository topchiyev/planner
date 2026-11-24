import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { passiveSessionHeader } from '@planner/contracts';
import { Secret, TOTP } from 'otpauth';
import { CommandJournal } from '../apps/backend/dist/application/command-journal/journal.js';
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

async function workspaceBrowser(run, mediaEnabled = false, options = {}) {
  await withFixtureMongo(async (mongo) => {
    let fixture;
    let web;
    let browser;
    let store;
    try {
      web = await tlsBridge(mongo.directory, async (browserOrigin) => {
        fixture = await makeWorkspaceAccessFixture(mongo, { browserOrigin, ...options, ...(mediaEnabled && {
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
  await workspaceBrowser(async ({ fixture, origin, page }) => {
    const editor = await page({ width: 1440, height: 900 });
    const colleague = await page({ width: 390, height: 844 });
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

    async function drag(from, target, cancel = false) {
      const source = listRow(editor, from).locator('[data-list-drag-handle]');
      // Wait until the handle is stable and reachable after any dnd-kit drop animation.
      await source.hover();
      const handle = await source.boundingBox();
      assert.ok(handle);
      await editor.mouse.down();
      await editor.mouse.move(handle.x + handle.width / 2 - 15, handle.y + handle.height / 2, { steps: 4 });
      await expect(target).toBeVisible();
      const box = await target.boundingBox();
      assert.ok(box);
      await editor.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
      await expect(target).toHaveAttribute('data-list-drop-target', 'true');
      if (cancel) await editor.keyboard.press('Escape');
      await editor.mouse.up();
    }
    await drag('Review queue', listRow(editor, 'Done'));
    await expect(listNames(editor)).toHaveText(['Finished', 'To do', 'Review queue', 'Done']);
    assert.equal(moveRequests, 2);

    const dropEnd = editor.getByText('Drop at the end', { exact: true });
    await drag('Finished', dropEnd, true);
    await expect(dropEnd).toHaveCount(0);
    await expect(moveFinished).toBeFocused();
    assert.equal(moveRequests, 2);
    await drag('Finished', dropEnd);
    await expect(listNames(editor)).toHaveText(['To do', 'Review queue', 'Done', 'Finished']);
    assert.equal(moveRequests, 3);

    await expect(editor).toHaveURL(origin + path);
    await editor.reload();
    await expect(listNames(editor)).toHaveText(['To do', 'Review queue', 'Done', 'Finished']);

    await colleague.goto(origin + path);
    const stale = colleague.getByRole('button', { name: 'Move Done', exact: true });
    await stale.focus();
    await colleague.keyboard.press('Enter');
    const staleDialog = colleague.getByRole('dialog', { name: 'Move list' });
    const placement = staleDialog.getByLabel('Place list');
    await expect(placement).toBeFocused();
    await placement.press('Home');
    await add(editor, 'Concurrent addition', 'active');
    await staleDialog.getByRole('button', { name: 'Move list', exact: true }).click();
    await expect(colleague.getByRole('alert')).toContainText('The list order changed');
    await expect(listNames(colleague)).toHaveText(['To do', 'Review queue', 'Done', 'Finished', 'Concurrent addition']);
    await expect(stale).toBeFocused();
    await expect(colleague).toHaveURL(origin + path);

    await viewer.goto(origin + path);
    await expect(listNames(viewer)).toHaveText(['To do', 'Review queue', 'Done', 'Finished', 'Concurrent addition']);
    await expect(viewer.getByRole('button', { name: 'Add list' })).toHaveCount(0);
    await expect(viewer.getByRole('button', { name: 'Move Done' })).toHaveCount(0);
    await editor.getByRole('link', { name: 'Archive', exact: true }).click();
    await expect(listNames(editor)).toHaveText(['Archive']);
    await expect(editor.getByRole('button', { name: 'Edit Archive' })).toHaveCount(0);
    await expect(editor.getByRole('button', { name: 'Add list' })).toHaveCount(0);

    const legacy = 'Imported ' + 'long-list-name'.repeat(14);
    await fixture.gate.runCommand(() => fixture.db.collection('lists').updateOne({ ...fixture.scope, id: ids.privateActiveList },
      { $set: { name: legacy } }));
    await colleague.reload();
    await expect(listRow(colleague, legacy)).toBeVisible();
    assert.ok(await colleague.getByRole('main').evaluate((main) => main.scrollWidth <= main.clientWidth));
    await colleague.getByRole('button', { name: 'Move ' + legacy, exact: true }).click();
    await expect(staleDialog).toBeVisible();
    assert.ok(await staleDialog.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth));

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

test('desktop editors create a closed card and use rich text, ID-backed mentions and a local-only stopwatch', { timeout: 120_000 }, async () => {
  await workspaceBrowser(async ({ fixture: f, origin, page }) => {
    for (let index = 0; index < 12; index++) {
      const userId = fixtureId(12000 + index);
      await f.insert('users', userId, { normalizedEmail: `alias-${index}@planner.invalid`, normalizedUsername: null,
        name: 'Shared alias', username: null, role: 'boardUser', disabledAt: null });
      await f.insert('boardMembers', fixtureId(13000 + index), { boardId: ids.privateBoard, userId, role: 'viewer', canComment: false });
    }
    const editor = await page({ width: 1440, height: 900 });
    await signIn(editor, origin, 'first-editor');
    await editor.goto(origin + board(ids.privateBoard) + '?view=grid');
    await editor.getByRole('button', { name: 'Add card to Done', exact: true }).click();
    const create = editor.getByRole('dialog', { name: 'Add card' });
    await create.getByLabel('Card name').fill('Closed orbit fixture');
    await create.getByRole('button', { name: 'Create card' }).click();
    const inspector = editor.getByRole('complementary', { name: 'Closed orbit fixture' });
    await expect(inspector.getByRole('heading', { name: 'Closed orbit fixture' })).toBeVisible();
    await expect(inspector.getByLabel('Card closed')).toBeChecked();
    assert.equal(new URL(editor.url()).searchParams.get('view'), 'grid');
    const cardId = new URL(editor.url()).pathname.split('/').at(-1);

    const modes = inspector.getByRole('group', { name: 'Description editor mode' });
    await expect(modes.getByRole('button', { name: 'Rich text' })).toHaveAttribute('aria-pressed', 'true');
    const description = inspector.getByRole('textbox', { name: 'Description' });
    await description.fill('Spectral log 🌱 ');
    await inspector.getByRole('button', { name: 'Mention a board member' }).click();
    await inspector.getByLabel('Find a board member').fill('second-editor');
    await inspector.getByRole('button', { name: 'Find members' }).click();
    await inspector.getByRole('button', { name: 'Mention Fixture second-editor' }).click();
    await expect(inspector.locator('.card-mention')).toHaveText('@Fixture second-editor');
    await inspector.getByRole('button', { name: 'Mention a board member' }).click();
    await inspector.getByLabel('Find a board member').fill('Shared alias');
    await inspector.getByRole('button', { name: 'Find members' }).click();
    await expect(inspector.getByRole('button', { name: 'Mention Shared alias' })).toHaveCount(10);
    await inspector.getByRole('button', { name: 'Next members page' }).click();
    await expect(inspector.getByRole('button', { name: 'Mention Shared alias' })).toHaveCount(2);
    await inspector.getByRole('button', { name: 'Mention Shared alias' }).last().click();
    await modes.getByRole('button', { name: 'Markdown' }).click();
    await expect(inspector.getByRole('textbox', { name: 'Description' })).toHaveValue(
      new RegExp('Spectral log 🌱 .*\\[Fixture second-editor\\]\\(' + ids.secondEditor + '\\)'));
    await inspector.getByLabel('Due date and time (UTC)').fill('2026-03-19T13:13');
    await modes.getByRole('button', { name: 'Rich text' }).click();
    await expect(description).toHaveAttribute('contenteditable', 'true');
    const submitted = Promise.withResolvers();
    const release = Promise.withResolvers();
    await editor.route('**/api/v1/cards/' + cardId, async (intercepted) => {
      if (intercepted.request().method() === 'PATCH') {
        submitted.resolve();
        await release.promise;
      }
      await intercepted.continue().catch(() => {});
    });
    const saved = editor.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().endsWith('/api/v1/cards/' + cardId));
    try {
      await inspector.getByRole('button', { name: 'Save card', exact: true }).click();
      await submitted.promise;
      await expect(description).toHaveAttribute('contenteditable', 'false');
      await expect(inspector.getByRole('button', { name: 'Save card', exact: true })).toBeDisabled();
    } finally { release.resolve(); }
    const receipt = await saved;
    await expect(description).toHaveAttribute('contenteditable', 'true');
    assert.equal(receipt.status(), 200);
    assert.equal(receipt.request().postDataJSON().dueDate, '2026-03-19T13:13:00.000Z');
    await expect(inspector.getByRole('button', { name: 'Save card', exact: true })).toBeDisabled();
    const persisted = await f.db.collection('cards').findOne({ ...f.scope, id: cardId });
    assert.equal(persisted.dueDate.toISOString(), '2026-03-19T13:13:00.000Z');
    assert.equal(persisted.dueDateCompleted, false);
    assert.ok(persisted.description.includes(`@[Fixture second-editor](${ids.secondEditor})`));
    assert.ok(persisted.description.includes(`@[Shared alias](${fixtureId(12011)})`));

    await inspector.getByRole('button', { name: 'Start stopwatch' }).click();
    await expect(inspector.getByRole('button', { name: 'Stop stopwatch' })).toBeEnabled();
    const elapsed = inspector.getByLabel('Elapsed time');
    const watchRequests = [];
    editor.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/v1/cards/' + cardId) watchRequests.push(request.method());
    });
    const running = await f.db.collection('cards').findOne({ ...f.scope, id: cardId });
    await expect(elapsed).not.toHaveText('00:00:00');
    assert.deepEqual(watchRequests, []);
    assert.deepEqual((await f.db.collection('cards').findOne({ ...f.scope, id: cardId })).stopwatch, running.stopwatch);
    await inspector.getByRole('button', { name: 'Stop stopwatch' }).click();
    await expect(inspector.getByRole('button', { name: 'Start stopwatch' })).toBeEnabled();
    await inspector.getByRole('button', { name: 'Reset stopwatch' }).click();
    await expect(elapsed).toHaveText('00:00:00');
    await expect(inspector.getByRole('button', { name: 'Reset stopwatch' })).toBeDisabled();
    await inspector.getByRole('link', { name: 'Close card' }).click();
    await expect(editor).toHaveURL(origin + board(ids.privateBoard) + '?view=grid');
    await expect(editor.getByRole('link', { name: 'Closed orbit fixture' })).toBeVisible();
    await editor.goBack();
    await expect(inspector.getByRole('heading', { name: 'Closed orbit fixture' })).toBeVisible();
  });
});

test('narrow card inspector retains exact imported Markdown and stale drafts, then clears the editor on access loss', { timeout: 120_000 }, async () => {
  await workspaceBrowser(async ({ fixture: f, origin, page }) => {
    const raw = '  <span>Imported text</span>\r\n\r\n<div data-fixture-html>Imported block</div>\r\n\r\nUnicode 🌱 [Unsafe](javascript:example) and `a < b`\r\n\r\n```js\r\nif (a < b) work()\r\n```  ';
    await f.db.collection('cards').updateOne({ ...f.scope, id: ids.activeCard }, { $set: { description: raw, stopwatch: { startedAt: null, total: 19 } } });
    await f.db.collection('users').updateOne({ ...f.scope, id: ids.firstEditor }, { $set: { 'preferences.editorMode': 'markup' } });
    const first = await page({ width: 390, height: 844 });
    const second = await page({ width: 390, height: 844 });
    await signIn(first, origin, 'first-editor');
    await signIn(second, origin, 'second-editor');
    const target = origin + board(ids.privateBoard) + '/cards/' + ids.activeCard;
    await first.goto(target);
    await second.goto(target);
    const editor = first.getByRole('complementary', { name: 'Moving an assigned card' });
    const mode = editor.getByRole('group', { name: 'Description editor mode' });
    await expect(mode.getByRole('button', { name: 'Markdown' })).toHaveAttribute('aria-pressed', 'true');
    await mode.getByRole('button', { name: 'Rich text' }).click();
    await expect(editor.getByRole('textbox', { name: 'Description' })).toContainText('Imported text');
    await expect(editor.locator('a[href^="javascript:"]')).toHaveCount(0);
    await expect(editor.locator('[data-fixture-html]')).toHaveCount(0);
    await expect(editor.getByRole('textbox', { name: 'Description' })).toContainText('Imported block');
    await expect(editor.locator('code').filter({ hasText: /^a < b$/u })).toBeVisible();
    await expect(editor.locator('pre code')).toContainText('if (a < b) work()');
    await mode.getByRole('button', { name: 'Markdown' }).click();
    await editor.getByLabel('Card type').selectOption('story');
    await expect(editor.getByLabel('Due date and time (UTC)')).toHaveCount(0);
    await editor.getByRole('button', { name: 'Save card', exact: true }).click();
    await expect(editor.getByRole('region', { name: 'Stopwatch' })).toHaveCount(0);
    assert.equal((await f.db.collection('cards').findOne({ ...f.scope, id: ids.activeCard })).description, raw);
    await editor.getByLabel('Card type').selectOption('project');
    await editor.getByRole('button', { name: 'Save card', exact: true }).click();
    await expect(editor.getByLabel('Elapsed time')).toHaveText('00:00:19');

    await second.reload();
    await editor.getByRole('textbox', { name: 'Description', exact: true }).fill('Keep this local draft 🌱');
    const competing = second.getByRole('complementary', { name: 'Moving an assigned card' });
    await competing.getByLabel('Card name').fill('Name from another editor');
    await competing.getByRole('button', { name: 'Save card', exact: true }).click();
    await expect(second.getByRole('heading', { name: 'Name from another editor' })).toBeVisible();
    await editor.getByRole('button', { name: 'Save card', exact: true }).click();
    const current = first.getByRole('complementary', { name: 'Name from another editor' });
    await expect(current.getByText('The card changed while you were editing.')).toBeVisible();
    await expect(current.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue('Keep this local draft 🌱');
    await current.getByRole('button', { name: 'Keep edits and use current revision' }).click();
    await f.gate.runCommand(() => f.db.collection('boardMembers').updateOne({ ...f.scope, boardId: ids.privateBoard, userId: ids.firstEditor },
      { $set: { role: 'viewer', canComment: false }, $inc: { revision: 1 } }));
    await current.getByRole('button', { name: 'Save card', exact: true }).click();
    await expect(current.getByRole('button', { name: 'Save card', exact: true })).toHaveCount(0);
    await expect(current.getByText('Keep this local draft 🌱')).toHaveCount(0);
    assert.equal((await f.db.collection('cards').findOne({ ...f.scope, id: ids.activeCard })).description, raw);
    await f.gate.runCommand(() => f.db.collection('sessions').updateMany({ ...f.scope, userId: ids.secondEditor },
      { $set: { expiresAt: new Date('2025-01-01T00:00:00.000Z') } }));
    await second.getByRole('button', { name: 'Mention a board member' }).click();
    await expect(second).toHaveURL((url) => url.pathname === '/sign-in' &&
      url.searchParams.get('returnTo') === new URL(target).pathname);
  });
});

test('editors move cards by pointer and keyboard, recover stale placement, and use historical actions', { timeout: 150_000 }, async () => {
  await workspaceBrowser(async ({ origin, page }) => {
    const editor = await page({ width: 1440, height: 900 });
    const colleague = await page({ width: 1240, height: 900 });
    const reader = await page({ width: 390, height: 844 });
    const root = board(ids.privateBoard);
    const path = root + '?context=board&view=kanban';
    const name = 'Moving an assigned card';
    const missingTitle = 'Story with a missing prior list';
    const cardLink = (p, label = name) => p.getByRole('link', { name: label, exact: true });
    const listRow = (p, title) => p.getByRole('list', { name: 'Board lists' }).locator(':scope > li')
      .filter({ has: p.getByText(title, { exact: true }) });
    await signIn(editor, origin, 'first-editor');
    await signIn(colleague, origin, 'second-editor');
    await signIn(reader, origin, 'viewer');
    await editor.goto(origin + path);
    await colleague.goto(origin + path);

    const lane = listRow(editor, 'To do');
    const closed = listRow(editor, 'Done');
    const source = lane.locator('[data-card-drag-handle]');
    await source.hover();
    const handle = await source.boundingBox();
    assert.ok(handle);
    await editor.mouse.down();
    await editor.mouse.move(handle.x + handle.width / 2 - 12, handle.y + handle.height / 2, { steps: 4 });
    const target = closed.getByText('Drop card at the end', { exact: true });
    await expect(target).toBeVisible();
    const targetBox = await target.boundingBox();
    assert.ok(targetBox);
    await editor.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 12 });
    await expect(target).toHaveAttribute('data-card-drop-target', 'true');
    await editor.mouse.up();
    await expect(closed.getByRole('link', { name, exact: true })).toBeVisible();

    const move = editor.getByRole('button', { name: 'Move card ' + name, exact: true });
    await move.focus();
    await editor.keyboard.press('Enter');
    const picker = editor.getByRole('dialog', { name: 'Move card' });
    const destination = picker.getByLabel('Destination list');
    await expect(destination).toBeFocused();
    await destination.selectOption({ label: 'To do' });
    await colleague.reload();
    await colleague.getByRole('button', { name: 'Add card to To do', exact: true }).click();
    const add = colleague.getByRole('dialog', { name: 'Add card' });
    await add.getByLabel('Card name').fill('Concurrent card');
    await add.getByRole('button', { name: 'Create card' }).click();
    await expect(colleague.getByRole('heading', { name: 'Concurrent card', exact: true })).toBeVisible();
    await picker.getByRole('button', { name: 'Move card', exact: true }).press('Enter');
    await expect(editor.getByRole('alert')).toContainText('The card order changed');
    await expect(closed.getByRole('link', { name, exact: true })).toBeVisible();
    await expect(move).toBeFocused();
    await editor.keyboard.press('Enter');
    await destination.selectOption({ label: 'To do' });
    await picker.getByLabel('Position').selectOption({ label: 'Before Concurrent card' });
    await picker.getByRole('button', { name: 'Move card', exact: true }).click();
    await expect(lane.getByRole('link', { name, exact: true })).toBeVisible();
    await expect(move).toBeFocused();
    await expect(editor).toHaveURL(origin + path);

    await cardLink(editor).click();
    const inspector = editor.getByRole('complementary', { name });
    const placement = inspector.getByRole('region', { name: 'Card placement' });
    await placement.getByRole('button', { name: 'Archive card', exact: true }).click();
    await expect(placement.getByRole('status')).toContainText('Card archived.');
    await expect(inspector.getByRole('textbox', { name: 'Card name' })).toHaveCount(0);
    await reader.goto(origin + root + '/cards/' + ids.activeCard + '?context=archive&view=list');
    await expect(reader.getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(reader.getByRole('button', { name: 'Restore card', exact: true })).toHaveCount(0);
    await expect(reader.getByRole('button', { name: 'Move to trash', exact: true })).toHaveCount(0);

    await placement.getByRole('button', { name: 'Move to trash', exact: true }).click();
    await expect(placement.getByRole('status')).toContainText('Card moved to trash.');
    await placement.getByRole('button', { name: 'Restore card', exact: true }).click();
    await expect(placement.getByRole('status')).toContainText('Card restored.');

    await editor.goto(origin + root + '?context=archive&view=list');
    await cardLink(editor, missingTitle).click();
    const missing = editor.getByRole('complementary', { name: missingTitle }).getByRole('region', { name: 'Card placement' });
    const unavailable = editor.waitForResponse((response) =>
      response.request().method() === 'POST' && response.url().endsWith('/api/v1/cards/' + ids.archivedStory + '/restore'));
    await missing.getByRole('button', { name: 'Restore card', exact: true }).click();
    assert.equal((await unavailable).status(), 422);
    const restore = editor.getByRole('dialog', { name: 'Restore card' });
    await restore.getByLabel('Destination list').selectOption({ label: 'Done' });
    await restore.getByRole('button', { name: 'Restore card', exact: true }).click();
    await expect(missing.getByRole('status')).toContainText('Card restored.');

    await editor.goto(origin + path);
    await expect(closed.getByRole('link', { name: missingTitle, exact: true })).toBeVisible();
    await closed.getByRole('button', { name: 'Delete list Done', exact: true }).click();
    await editor.getByRole('dialog', { name: 'Delete list' }).getByRole('button', { name: 'Confirm list deletion' }).click();
    await expect(closed).toHaveCount(0);
    await editor.getByRole('link', { name: 'Trash', exact: true }).click();
    await expect(cardLink(editor, missingTitle)).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Delete list Trash' })).toHaveCount(0);
  });
});

test('list maintenance sorts, archives closed cards and requires fresh confirmation after a new trash arrival', { timeout: 125_000 }, async () => {
  await workspaceBrowser(async ({ fixture: f, origin, page }) => {
    const alpha = fixtureId(16200);
    const closedA = fixtureId(16201);
    const closedB = fixtureId(16202);
    const privateBoard = ids.privateBoard;
    for (const [id, listId, name, rank] of [
      [alpha, ids.privateActiveList, 'Alpha fixture', '4096'], [closedA, ids.privateClosedList, 'Closed first', '1024'],
      [closedB, ids.privateClosedList, 'Closed second', '2048'],
    ]) {
      await f.insert('cards', id, { boardId: privateBoard, listId, name, rank, kind: 'board', type: 'project', closed: listId === ids.privateClosedList });
    }
    await f.db.collection('boardMembers').deleteOne({ ...f.scope, boardId: privateBoard, userId: ids.privateOwner });
    const editor = await page({ width: 1440, height: 900 });
    const manager = await page({ width: 390, height: 844 });
    const viewer = await page({ width: 390, height: 844 });
    await signIn(editor, origin, 'first-editor');
    await signIn(manager, origin, 'private-owner');
    await signIn(viewer, origin, 'viewer');
    const base = origin + board(privateBoard);
    await editor.goto(base + '?view=grid');
    await viewer.goto(base + '?context=trash&view=grid');
    await expect(viewer.getByRole('link', { name: 'Card in trash' })).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Clear trash', exact: true })).toHaveCount(0);
    await expect(editor.getByRole('button', { name: 'Archive cards in To do' })).toHaveCount(0);
    await editor.getByRole('button', { name: 'Sort cards in To do' }).click();
    const sort = editor.getByRole('dialog', { name: 'Sort cards' });
    await sort.getByLabel('Sort by').selectOption('name');
    await sort.getByLabel('Direction').selectOption('asc');
    await sort.getByRole('button', { name: 'Apply sort' }).click();
    await expect(editor.getByRole('list', { name: 'Card grid' }).getByRole('link').first()).toHaveText('Alpha fixture');

    await editor.getByRole('button', { name: 'Archive cards in Done' }).click();
    const archive = editor.getByRole('dialog', { name: 'Archive cards' });
    await expect(archive.getByText('Move 2 cards from')).toBeVisible();
    await archive.getByRole('button', { name: 'Confirm archive' }).click();
    await expect(editor.getByRole('link', { name: 'Closed first' })).toHaveCount(0);
    const contexts = editor.getByRole('navigation', { name: 'Board context' });
    await contexts.getByRole('link', { name: 'Archive' }).click();
    await expect(editor.getByRole('table', { name: 'Cards' }).getByRole('link').first()).toHaveText('Closed first');
    await expect(editor.getByRole('table', { name: 'Cards' }).getByRole('link').nth(1)).toHaveText('Closed second');

    await manager.goto(base + '?context=trash&view=grid');
    await manager.getByRole('button', { name: 'Clear trash', exact: true }).click();
    const clear = manager.getByRole('dialog', { name: 'Clear trash' });
    const confirmation = clear.getByLabel('I confirm permanent deletion of these cards');
    const apply = clear.getByRole('button', { name: 'Permanently clear trash' });
    await expect(clear.getByText('Permanently delete 1 card and its contents?')).toBeVisible();
    await expect(apply).toBeDisabled();
    await confirmation.check();
    await expect(apply).toBeEnabled();

    const session = await (await editor.request.get(origin + '/api/v1/session')).json();
    const current = (await (await editor.request.get(origin + '/api/v1/cards/' + alpha)).json()).data;
    const workspace = (await (await editor.request.get(origin + '/api/v1/boards/' + privateBoard + '/workspace')).json()).data;
    const source = workspace.lists.find(({ id }) => id === ids.privateActiveList);
    const trash = workspace.lists.find(({ id }) => id === ids.privateTrash);
    const arrival = await editor.request.post(origin + '/api/v1/cards/' + alpha + '/trash', {
      headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken, 'If-Match': `"${current.revision}"`, 'Idempotency-Key': randomUUID() },
      data: { sourceOrderVersion: source.orderVersion, destinationOrderVersion: trash.orderVersion },
    });
    assert.equal(arrival.status(), 200);
    await apply.click();
    await expect(clear.getByRole('alert')).toContainText('changed');
    await expect(clear.getByText('Permanently delete 2 cards and their contents?')).toBeVisible();
    await expect(confirmation).not.toBeChecked();
    await expect(apply).toBeDisabled();
    await confirmation.check();
    await apply.click();
    await expect(clear).toHaveCount(0);
    await expect(manager.getByRole('button', { name: 'Clear trash', exact: true })).toBeDisabled();
    await expect(manager.getByRole('link', { name: 'Card in trash' })).toHaveCount(0);
    await expect(manager).toHaveURL(base + '?context=trash&view=grid');
    assert.equal((await editor.request.get(origin + '/api/v1/cards/' + alpha)).status(), 404);
    assert.ok(await f.db.collection('lists').findOne({ ...f.scope, id: ids.privateTrash, kind: 'trash' }));
    assert.equal(await f.db.collection('cards').countDocuments({ ...f.scope, listId: ids.privateArchive, kind: 'archive' }), 3);
  });
});

test('keyboard placement continues past the first anchor page and closes when protected access is lost', { timeout: 120_000 }, async () => {
  await workspaceBrowser(async ({ fixture, origin, page }) => {
    const p = await page({ width: 390, height: 844 });
    const target = ids.privateClosedList;
    const anchor = fixtureId(8102);
    for (let index = 1; index <= 102; index++) {
      await fixture.insert('cards', fixtureId(8000 + index), { boardId: ids.privateBoard, listId: target,
        name: 'Anchor ' + String(index).padStart(3, '0'), kind: 'board', type: 'project', closed: true, rank: String(index * 1024) });
    }
    await signIn(p, origin, 'first-editor');
    const card = ids.activeCard;
    const path = board(ids.privateBoard) + '/cards/' + card + '?context=board&view=list';
    await p.goto(origin + path);
    const placement = p.getByRole('region', { name: 'Card placement' });
    await placement.getByRole('button', { name: 'Move card', exact: true }).press('Enter');
    const dialog = p.getByRole('dialog', { name: 'Move card' });
    await dialog.getByLabel('Destination list').selectOption({ label: 'Done' });
    const position = dialog.getByLabel('Position');
    await expect(dialog.getByRole('button', { name: 'Load more positions' })).toBeVisible();
    await expect(position.locator('option', { hasText: 'Before Anchor 102' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Load more positions' }).press('Enter');
    await position.selectOption({ label: 'Before Anchor 102' });
    const submitted = p.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/api/v1/cards/' + card + '/move'));
    await dialog.getByRole('button', { name: 'Move card', exact: true }).press('Enter');
    assert.equal((await submitted).postDataJSON().beforeCardId, anchor);
    await expect(placement.getByRole('status')).toContainText('Card moved.');
    const saved = await fixture.db.collection('cards').findOne({ ...fixture.scope, id: card }, { promoteLongs: false });
    assert.equal(saved.listId, target);
    assert.ok(saved.rank.toBigInt() > 101n * 1024n && saved.rank.toBigInt() < 102n * 1024n);

    await placement.getByRole('button', { name: 'Move card', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Load more positions' })).toBeVisible();
    await fixture.gate.runCommand(() => fixture.db.collection('boardMembers').deleteOne({ ...fixture.scope,
      boardId: ids.privateBoard, userId: ids.firstEditor }));
    const rejected = p.waitForResponse((response) => response.url().includes('/api/v1/boards/' + ids.privateBoard + '/cards')
      && new URL(response.url()).searchParams.get('listIds') === ids.privateActiveList);
    await dialog.getByLabel('Destination list').selectOption({ label: 'To do' });
    assert.equal((await rejected).status(), 404);
    await expect(dialog).toHaveCount(0);
    await expect(p.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible();
  });
});

test('board and card labels, scoped assignees and explicit follows work in the native frontend', { timeout: 150_000 }, async () => {
  await workspaceBrowser(async ({ origin, page }) => {
    const editor = await page({ width: 1440, height: 900 });
    const colleague = await page({ width: 390, height: 844 });
    const viewer = await page({ width: 1240, height: 900 });
    const path = board(ids.privateBoard);
    const cardPath = path + '/cards/' + ids.activeCard + '?context=board&view=list';
    await signIn(editor, origin, 'first-editor');
    await signIn(colleague, origin, 'second-editor');
    await signIn(viewer, origin, 'viewer');
    await editor.goto(origin + path);
    await viewer.goto(origin + path);

    await viewer.getByRole('button', { name: 'Follow board', exact: true }).click();
    await expect(viewer.getByRole('button', { name: 'Unfollow board', exact: true })).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Follow board', exact: true })).toBeVisible();
    await editor.getByRole('button', { name: 'Board labels', exact: true }).click();
    const palette = editor.getByRole('dialog', { name: 'Board labels' });
    await palette.getByRole('button', { name: 'New label' }).click();
    await palette.getByLabel('Label color').selectOption('pirate-gold');
    await palette.getByRole('button', { name: 'Create label' }).click();
    await expect(palette.getByRole('list', { name: 'Labels' }).getByText('Pirate gold', { exact: true })).toBeVisible();
    await palette.getByRole('button', { name: 'Edit label Pirate gold', exact: true }).click();
    await palette.getByLabel('Label name').fill('Urgent');
    await palette.getByLabel('Label color').selectOption('berry-red');
    await palette.getByRole('button', { name: 'Save label' }).click();
    await expect(palette.getByRole('list', { name: 'Labels' }).getByText('Urgent', { exact: true })).toBeVisible();
    await palette.getByRole('button', { name: 'Close', exact: true }).click();

    await viewer.reload();
    await viewer.getByRole('button', { name: 'Board labels', exact: true }).click();
    const readOnly = viewer.getByRole('dialog', { name: 'Board labels' });
    await expect(readOnly.getByText('Urgent', { exact: true })).toBeVisible();
    await expect(readOnly.getByRole('button', { name: 'New label' })).toHaveCount(0);
    await expect(readOnly.getByRole('button', { name: 'Edit label Urgent' })).toHaveCount(0);

    await editor.goto(origin + cardPath);
    const panel = editor.getByRole('region', { name: 'Card affiliations' });
    await panel.getByRole('button', { name: 'Add label', exact: true }).click();
    const attach = editor.getByRole('dialog', { name: 'Add label' });
    await attach.getByRole('button', { name: 'Add label Urgent', exact: true }).click();
    await expect(panel.getByRole('list', { name: 'Attached labels' }).getByText('Urgent', { exact: true })).toBeVisible();

    await panel.getByRole('button', { name: 'Assign people' }).click();
    const people = editor.getByRole('dialog', { name: 'Assign people' });
    await people.getByLabel('Find a board member').fill('disabled-member');
    await people.getByRole('button', { name: 'Search members' }).click();
    await expect(people.getByText('No eligible board members on this page.')).toBeVisible();
    await people.getByLabel('Find a board member').fill('commenting-viewer');
    await people.getByRole('button', { name: 'Search members' }).click();
    await people.getByRole('button', { name: 'Assign Fixture commenting-viewer', exact: true }).click();
    await expect(panel.getByRole('list', { name: 'Assignees' }).getByText('Fixture commenting-viewer', { exact: true })).toBeVisible();

    await panel.getByRole('button', { name: 'Unassign Fixture second-editor', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Unassign Fixture second-editor', exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Assign people' }).click();
    await people.getByLabel('Find a board member').fill('second-editor');
    await people.getByRole('button', { name: 'Search members' }).click();
    await people.getByRole('button', { name: 'Assign Fixture second-editor', exact: true }).click();
    await expect(panel.getByRole('list', { name: 'Assignees' }).getByText('Fixture second-editor', { exact: true })).toBeVisible();
    await colleague.goto(origin + cardPath);
    const own = colleague.getByRole('region', { name: 'Card affiliations' });
    await expect(own.getByRole('button', { name: 'Unfollow card', exact: true })).toBeVisible();
    await own.getByRole('button', { name: 'Keep following card', exact: true }).click();
    await expect(own.getByRole('button', { name: 'Keep following card', exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Unassign Fixture second-editor', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Unassign Fixture second-editor', exact: true })).toHaveCount(0);
    await colleague.reload();
    await expect(own.getByRole('button', { name: 'Unfollow card', exact: true })).toBeVisible();
    await expect(own.getByText('Fixture second-editor', { exact: true })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Follow card', exact: true })).toBeVisible();
    assert.ok(await colleague.getByRole('main').evaluate((main) => main.scrollWidth <= main.clientWidth));

    await viewer.goto(origin + path + '/cards/' + ids.archivedStory + '?context=archive&view=list');
    const historical = viewer.getByRole('region', { name: 'Card affiliations' });
    await historical.getByRole('button', { name: 'Follow card', exact: true }).click();
    await expect(historical.getByRole('button', { name: 'Unfollow card', exact: true })).toBeVisible();
    await expect(historical.getByRole('button', { name: 'Assign people' })).toHaveCount(0);
    await expect(historical.getByRole('button', { name: 'Add label', exact: true })).toHaveCount(0);

    await editor.goto(origin + path);
    await editor.getByRole('button', { name: 'Board labels', exact: true }).click();
    await palette.getByRole('button', { name: 'Delete label Urgent', exact: true }).click();
    await palette.getByRole('button', { name: 'Confirm label deletion', exact: true }).click();
    await expect(palette.getByText('No labels yet.')).toBeVisible();
    await editor.goto(origin + cardPath);
    await expect(panel.getByRole('list', { name: 'Attached labels' })).toHaveCount(0);
  });
});

test('native checklists keep keyboard editing and private linked projections in sync', async () => {
  await workspaceBrowser(async ({ fixture, origin, page }) => {
    await fixture.insert('boardPreferences', randomUUID(), {
      boardId: ids.privateBoard, expandChecklists: true,
    });
    const editor = await page({ width: 1440, height: 900 });
    const viewer = await page({ width: 390, height: 844 });
    const path = origin + board(ids.privateBoard) + '/cards/' + ids.activeCard;
    await signIn(editor, origin, 'first-editor');
    await signIn(viewer, origin, 'viewer');
    await editor.goto(path);

    const editorPanel = editor.getByRole('region', { name: 'Checklists', exact: true });
    const legacy = editorPanel.getByRole('button', { name: 'Linked work', exact: true });
    await expect(legacy).toHaveAttribute('aria-expanded', 'true');
    const writes = [];
    editor.on('request', (request) => {
      if (request.url().includes('/api/v1/') && ['POST', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.method());
    });
    await legacy.click();
    await expect(legacy).toHaveAttribute('aria-expanded', 'false');
    await legacy.click();
    await expect(legacy).toHaveAttribute('aria-expanded', 'true');
    assert.deepEqual(writes, []);

    const createGroup = async (name, front) => {
      await editorPanel.getByRole('button', { name: 'Add checklist', exact: true }).click();
      const form = editor.getByRole('dialog', { name: 'Add checklist' });
      await form.getByLabel('Checklist name').fill(name);
      await expect(form.getByLabel('Show on card front')).toBeChecked();
      if (!front) await form.getByLabel('Show on card front').uncheck();
      await form.getByRole('button', { name: 'Create checklist', exact: true }).click();
      const group = editorPanel.getByRole('region', { name, exact: true });
      await expect(group.getByRole('button', { name, exact: true })).toHaveAttribute('aria-expanded', 'true');
      return group;
    };
    const dispatch = await createGroup('Dispatch work', true);
    const review = await createGroup('Review work', false);
    await dispatch.getByRole('button', { name: 'Add task', exact: true }).click();
    const task = editor.getByRole('dialog', { name: 'Add task' });
    await task.getByLabel('Task name').fill('Review the handoff');
    await task.getByRole('button', { name: 'Choose assignee' }).click();
    await task.getByLabel('Find an assignee').fill('second-editor');
    await task.getByRole('button', { name: 'Search members' }).click();
    await task.getByRole('button', { name: 'Fixture second-editor', exact: true }).click();
    await task.getByRole('button', { name: 'Create task' }).click();
    await expect(task).toHaveCount(0);
    await expect(dispatch.getByText('Fixture second-editor', { exact: true })).toBeVisible();

    await dispatch.getByRole('button', { name: 'Edit task Review the handoff' }).click();
    const edit = editor.getByRole('dialog', { name: 'Edit task' });
    await edit.getByRole('button', { name: 'Change assignee' }).click();
    await edit.getByRole('button', { name: 'Unassigned' }).click();
    await edit.getByRole('button', { name: 'Save task' }).click();
    await expect(edit).toHaveCount(0);
    await expect(dispatch.getByText('Fixture second-editor', { exact: true })).toHaveCount(0);
    const completion = dispatch.getByRole('checkbox', { name: 'Complete Review the handoff' });
    await completion.click();
    await expect(completion).toBeChecked();

    await review.getByRole('button', { name: 'Link a card', exact: true }).click();
    const linkForm = editor.getByRole('dialog', { name: 'Link a card' });
    await linkForm.getByLabel('Card link or ID').fill(board(ids.sharedBoard) + '/cards/' + ids.sharedTarget);
    await linkForm.getByRole('button', { name: 'Add linked task' }).click();
    const linkName = 'Cross-board linked target';
    const move = review.getByRole('button', { name: 'Move task ' + linkName });
    await move.focus();
    await move.press('Enter');
    const moveForm = editor.getByRole('dialog', { name: 'Move task' });
    await moveForm.getByLabel('Destination checklist').selectOption({ label: 'Dispatch work' });
    await moveForm.getByRole('button', { name: 'Place task' }).click();
    await expect(dispatch.getByRole('link', { name: linkName })).toBeVisible();
    await expect(review.getByRole('link', { name: linkName })).toHaveCount(0);
    await expect(dispatch.getByRole('button', { name: 'Edit task ' + linkName })).toHaveCount(0);

    await viewer.goto(path);
    const viewerPanel = viewer.getByRole('region', { name: 'Checklists', exact: true });
    const viewerGroup = viewerPanel.getByRole('region', { name: 'Dispatch work', exact: true });
    await expect(viewerGroup.getByText('Linked card unavailable')).toBeVisible();
    await expect(viewerPanel.getByRole('button', { name: 'Add checklist' })).toHaveCount(0);
    await expect(viewerPanel.getByRole('link', { name: linkName })).toHaveCount(0);

    await dispatch.getByRole('button', { name: 'Checklist settings' }).click();
    const settings = editor.getByRole('dialog', { name: 'Checklist settings' });
    await settings.getByLabel('Hide completed tasks').check();
    await settings.getByRole('button', { name: 'Save checklist settings' }).click();
    await expect(dispatch.getByText('Review the handoff', { exact: true })).toHaveCount(0);
    await viewer.reload();
    await expect(viewerGroup.getByText('Linked card unavailable')).toBeVisible();
    await expect(viewerGroup.getByText('Review the handoff', { exact: true })).toHaveCount(0);
    await viewer.goto(origin + board(ids.privateBoard));
    const front = viewer.getByRole('region', { name: 'Dispatch work', exact: true });
    await expect(front.getByText('Linked card unavailable')).toBeVisible();
    await expect(front.getByText('Review the handoff', { exact: true })).toHaveCount(0);
    await expect(viewer.getByRole('region', { name: 'Review work', exact: true })).toHaveCount(0);
    assert.ok(await viewer.getByRole('main').evaluate((main) => main.scrollWidth <= main.clientWidth));
  });
});

test('project, board and card fields share templates and preserve exact values through detach and promotion', { timeout: 125_000 }, async () => {
  await workspaceBrowser(async ({ origin, page }) => {
    const owner = await page({ width: 1440, height: 900 });
    const editor = await page({ width: 390, height: 844 });
    const viewer = await page({ width: 390, height: 844 });
    const boardPath = origin + board(ids.privateBoard) + '?view=list';
    const cardPath = origin + board(ids.privateBoard) + '/cards/' + ids.activeCard + '?view=list';
    await signIn(owner, origin, 'private-owner');
    await owner.goto(origin + project(ids.privateProject));
    await owner.getByRole('button', { name: 'Project settings', exact: true }).click();
    const settings = owner.getByRole('dialog', { name: 'Project settings' });
    await settings.getByText('Custom field templates', { exact: true }).click();
    await settings.getByRole('button', { name: 'Add field template' }).click();
    let dialog = owner.getByRole('dialog', { name: 'Add field template' });
    await dialog.getByLabel('Template name').fill('Release window');
    await dialog.getByRole('button', { name: 'Create template' }).click();
    const template = settings.getByRole('region', { name: 'Release window', exact: true });
    await template.getByRole('button', { name: 'Add field', exact: true }).click();
    dialog = owner.getByRole('dialog', { name: 'Add field' });
    await dialog.getByLabel('Field name').fill('Deployment note');
    await dialog.getByLabel('Show on card front').check();
    await dialog.getByRole('button', { name: 'Create field' }).click();
    await expect(template.getByText('Deployment note', { exact: true })).toBeVisible();

    await signIn(editor, origin, 'first-editor');
    await editor.goto(boardPath);
    await editor.getByText('Board fields', { exact: true }).click();
    await editor.getByRole('button', { name: 'Add field group' }).click();
    dialog = editor.getByRole('dialog', { name: 'Add field group' });
    await dialog.getByLabel('Project template').selectOption({ label: 'Release window' });
    await dialog.getByRole('button', { name: 'Create group' }).click();
    await expect(editor.getByRole('region', { name: 'Release window', exact: true }).getByText('Deployment note')).toBeVisible();

    await editor.goto(cardPath);
    const fields = editor.getByRole('region', { name: 'Custom fields' });
    await fields.getByRole('button', { name: 'Add field group' }).click();
    dialog = editor.getByRole('dialog', { name: 'Add field group' });
    await dialog.getByLabel('Project template').selectOption({ label: 'Release window' });
    await dialog.getByLabel('Group name (optional)').fill('Local release window');
    await dialog.getByRole('button', { name: 'Create group' }).click();
    const boardFields = fields.getByRole('region', { name: 'Release window', exact: true });
    const local = fields.getByRole('region', { name: 'Local release window', exact: true });
    await expect(local.getByLabel('Deployment note value')).toBeVisible();
    await expect(boardFields.getByRole('button', { name: 'Edit field Deployment note' })).toHaveCount(0);
    const original = '  blue / λ  ';
    await boardFields.getByLabel('Deployment note value').fill(original);
    const written = editor.waitForResponse((response) =>
      response.request().method() === 'PUT' && response.url().includes('/field-values/'));
    await boardFields.getByRole('button', { name: 'Save value' }).click();
    const response = await written;
    assert.equal(response.status(), 200, await response.text());
    await expect(boardFields.getByRole('button', { name: 'Clear value' })).toBeVisible();
    await local.getByLabel('Deployment note value').fill('0\n');
    await local.getByRole('button', { name: 'Save value' }).click();
    await expect(local.getByRole('button', { name: 'Clear value' })).toBeVisible();
    await local.getByRole('button', { name: 'Detach', exact: true }).click();
    await editor.getByRole('dialog', { name: 'Detach field group' }).getByRole('button', { name: 'Detach field group', exact: true }).click();
    await expect(local.getByRole('button', { name: 'Edit field Deployment note' })).toBeVisible();
    await expect(local.getByLabel('Deployment note value')).toHaveValue('0\n');
    await expect(boardFields.getByLabel('Deployment note value')).toHaveValue(original);
    assert.ok(await editor.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

    await owner.goto(cardPath);
    const ownerLocal = owner.getByRole('region', { name: 'Custom fields' }).getByRole('region', { name: 'Local release window' });
    await ownerLocal.getByRole('button', { name: 'Save as project template' }).click();
    await owner.getByRole('dialog', { name: 'Save as project template' }).getByRole('button', { name: 'Save as project template' }).click();
    await expect(owner.getByRole('dialog', { name: 'Save as project template' })).toHaveCount(0);
    await expect(ownerLocal.getByLabel('Deployment note value')).toHaveValue('0\n');

    const dirty = '  draft / λ  ';
    await boardFields.getByLabel('Deployment note value').fill(dirty);
    const ownerBoard = owner.getByRole('region', { name: 'Custom fields' }).getByRole('region', { name: 'Release window', exact: true });
    await ownerBoard.getByLabel('Deployment note value').fill('Colleague update');
    const changed = owner.waitForResponse((response) =>
      response.request().method() === 'PUT' && response.url().includes('/field-values/'));
    await ownerBoard.getByRole('button', { name: 'Save value' }).click();
    assert.equal((await changed).status(), 200);
    await editor.getByRole('button', { name: 'Follow card', exact: true }).click();
    await expect(boardFields.getByRole('alert')).toContainText('Current value: Colleague update');
    await expect(boardFields.getByLabel('Deployment note value')).toHaveValue(dirty);
    await expect(boardFields.getByRole('button', { name: 'Save value' })).toBeDisabled();
    await boardFields.getByRole('button', { name: 'Keep draft' }).click();
    const reapplied = editor.waitForResponse((response) =>
      response.request().method() === 'PUT' && response.url().includes('/field-values/'));
    await boardFields.getByRole('button', { name: 'Save value' }).click();
    assert.equal((await reapplied).status(), 200);
    await expect(boardFields.getByRole('button', { name: 'Save value' })).toBeDisabled();

    await local.getByRole('button', { name: 'Edit field Deployment note' }).click();
    const editorDefinition = editor.getByRole('dialog', { name: 'Edit field', exact: true });
    await editorDefinition.getByLabel('Field name').fill('Revised deployment note');
    await ownerLocal.getByRole('button', { name: 'Edit field Deployment note' }).click();
    const ownerDefinition = owner.getByRole('dialog', { name: 'Edit field', exact: true });
    await ownerDefinition.getByLabel('Show on card front').uncheck();
    await ownerDefinition.getByRole('button', { name: 'Save field' }).click();
    await expect(ownerLocal.getByText('Inspector only')).toBeVisible();
    await editorDefinition.getByRole('button', { name: 'Save field' }).click();
    await expect(editorDefinition.getByRole('alert')).toContainText('Inspector only');
    await expect(editorDefinition.getByLabel('Field name')).toHaveValue('Revised deployment note');
    await expect(editorDefinition.getByLabel('Show on card front')).not.toBeChecked();
    await expect(editorDefinition.getByRole('button', { name: 'Save field' })).toBeDisabled();
    await editorDefinition.getByRole('button', { name: 'Review current version' }).click();
    await editorDefinition.getByRole('button', { name: 'Save field' }).click();
    await expect(local.getByLabel('Revised deployment note value')).toHaveValue('0\n');
    await expect(local.getByText('Inspector only')).toBeVisible();

    await signIn(viewer, origin, 'viewer');
    await viewer.goto(cardPath);
    const readOnly = viewer.getByRole('region', { name: 'Custom fields' });
    await expect(readOnly.getByRole('region', { name: 'Release window', exact: true }).locator('.field-value')).toHaveJSProperty('textContent', dirty);
    await expect(readOnly.getByRole('button', { name: 'Save value' })).toHaveCount(0);
    await viewer.getByRole('link', { name: 'Close card' }).click();
    await expect(viewer.locator('.card-front-fields').getByText('Deployment note', { exact: true })).toHaveCount(1);
    await expect(viewer.locator('.card-front-fields').getByText('Revised deployment note')).toHaveCount(0);
  });
});

test('native card media keeps files private, manages covers by revision and opens external links only on request', { timeout: 125_000 }, async () => {
  const requests = [];
  const sentinel = createServer((message, response) => {
    requests.push({ path: message.url, referer: message.headers.referer });
    response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('External test link');
  });
  await new Promise((resolve, reject) => {
    sentinel.once('error', reject);
    sentinel.listen(0, '127.0.0.1', resolve);
  });
  try {
    await workspaceBrowser(async ({ fixture, origin, page }) => {
      const editor = await page({ width: 1440, height: 900 });
      const secondEditor = await page({ width: 390, height: 844 });
      const viewer = await page({ width: 390, height: 844 });
      const parent = origin + board(ids.privateBoard);
      const path = parent + '/cards/' + ids.activeCard;
      const panel = (browserPage) => browserPage.getByRole('region', { name: 'Attachments', exact: true });
      const file = (browserPage, name) => panel(browserPage).getByRole('listitem').filter({ has: browserPage.getByText(name, { exact: true }) });
      const uploadFile = async (target, item) => {
        await panel(target).getByRole('button', { name: 'Add file', exact: true }).click();
        const dialog = target.getByRole('dialog', { name: 'Add file' });
        await dialog.getByLabel('File').setInputFiles(item);
        await dialog.getByRole('button', { name: 'Upload file' }).click();
        await expect(dialog).toHaveCount(0, { timeout: 15_000 });
      };
      const stored = () => fixture.db.collection('cards').findOne({ ...fixture.scope, id: ids.activeCard });
      const renameFile = async (target, previous, next) => {
        await file(target, previous).getByRole('button', { name: 'Rename ' + previous }).click();
        const form = target.getByRole('dialog', { name: 'Rename attachment' });
        await form.getByLabel('Name').fill(next);
        await form.getByRole('button', { name: 'Save name' }).click();
        await expect(file(target, next)).toBeVisible();
      };

      await signIn(editor, origin, 'first-editor');
      await signIn(secondEditor, origin, 'second-editor');
      await signIn(viewer, origin, 'viewer');
      await editor.goto(path);
      const bytes = Buffer.from('Private passive file');
      await uploadFile(editor, { name: 'notes.dat', mimeType: 'application/octet-stream', buffer: bytes });
      const originalLink = file(editor, 'notes.dat').getByRole('link', { name: 'Download notes.dat' });
      await expect(originalLink).toBeVisible();
      await expect(file(editor, 'notes.dat').locator('img')).toHaveCount(0);
      assert.equal((await stored()).coverAttachmentId ?? null, null);
      const downloadPath = await originalLink.getAttribute('href');
      const [download] = await Promise.all([editor.waitForEvent('download'), originalLink.click()]);
      assert.equal(download.suggestedFilename(), 'notes.dat');
      assert.deepEqual(await readFile(await download.path()), bytes);
      const head = await editor.request.head(origin + downloadPath);
      assert.equal(head.status(), 200);
      assert.equal(head.headers()['content-length'], String(bytes.length));
      const range = await editor.request.get(origin + downloadPath, { headers: { Range: 'bytes=1-3' } });
      assert.equal(range.status(), 206);
      assert.deepEqual(await range.body(), bytes.subarray(1, 4));
      assert.equal((await editor.request.get(origin + downloadPath, { headers: { 'If-None-Match': head.headers().etag } })).status(), 304);

      await uploadFile(editor, fileURLToPath(new URL('./fixtures/media/sample.png', import.meta.url)));
      const firstImage = file(editor, 'sample.png');
      await expect(firstImage.getByText('Cover', { exact: true })).toBeVisible();
      const firstImageId = (await stored()).coverAttachmentId;
      await uploadFile(editor, fileURLToPath(new URL('./fixtures/media/sample.jpeg', import.meta.url)));
      const otherImage = file(editor, 'sample.jpeg');
      await expect(otherImage.getByRole('button', { name: 'Use sample.jpeg as cover' })).toBeVisible();
      assert.equal((await stored()).coverAttachmentId, firstImageId);
      await secondEditor.goto(path);
      await expect(file(secondEditor, 'sample.png').getByText('Cover', { exact: true })).toBeVisible();

      await otherImage.getByRole('button', { name: 'Use sample.jpeg as cover' }).click();
      await expect(otherImage.getByText('Cover', { exact: true })).toBeVisible();
      const secondImageId = (await stored()).coverAttachmentId;
      assert.notEqual(secondImageId, firstImageId);
      const [stale] = await Promise.all([
        secondEditor.waitForResponse((response) =>
          response.request().method() === 'PATCH' && response.url().endsWith('/api/v1/cards/' + ids.activeCard)),
        panel(secondEditor).getByRole('button', { name: 'Clear cover' }).click(),
      ]);
      assert.equal(stale.status(), 409);
      await expect(panel(secondEditor).getByRole('alert')).toContainText('Review the current information');
      await expect(file(secondEditor, 'sample.jpeg').getByText('Cover', { exact: true })).toBeVisible();
      await panel(secondEditor).getByRole('button', { name: 'Clear cover' }).click();
      await expect(panel(secondEditor).getByRole('button', { name: 'Clear cover' })).toHaveCount(0);
      assert.equal((await stored()).coverAttachmentId, null);

      await editor.reload();
      await firstImage.getByRole('button', { name: 'Use sample.png as cover' }).click();
      await expect(firstImage.getByText('Cover', { exact: true })).toBeVisible();
      await viewer.goto(parent);
      const front = viewer.locator('.card-front-cover');
      await expect(front).toHaveAttribute('src', '/api/v1/attachments/' + firstImageId + '/thumbnail/small');
      await expect.poll(() => front.evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
      await viewer.goto(path);
      await expect(file(viewer, 'sample.png').getByRole('link', { name: 'Download sample.png' })).toBeVisible();
      await expect(panel(viewer).getByRole('button', { name: 'Add file' })).toHaveCount(0);
      await expect(panel(viewer).getByRole('button', { name: 'Remove sample.png' })).toHaveCount(0);

      await firstImage.getByRole('button', { name: 'Rename sample.png' }).click();
      const rename = editor.getByRole('dialog', { name: 'Rename attachment' });
      await rename.getByLabel('Name').fill('Current cover.png');
      await secondEditor.reload();
      await renameFile(secondEditor, 'sample.png', 'Coworker cover.png');
      await rename.getByRole('button', { name: 'Save name' }).click();
      await expect(rename.getByRole('alert')).toContainText('Coworker cover.png');
      await expect(rename.getByLabel('Name')).toHaveValue('Current cover.png');
      await expect(rename.getByRole('button', { name: 'Save name' })).toBeDisabled();
      await rename.getByRole('button', { name: 'Close', exact: true }).click();
      await renameFile(editor, 'Coworker cover.png', 'Current cover.png');
      const cover = file(editor, 'Current cover.png');
      await expect(cover.getByText('Cover', { exact: true })).toBeVisible();
      assert.equal((await stored()).coverAttachmentId, firstImageId);

      await cover.getByRole('button', { name: 'Remove Current cover.png' }).click();
      const remove = editor.getByRole('dialog', { name: 'Remove attachment' });
      await secondEditor.reload();
      await renameFile(secondEditor, 'Current cover.png', 'Ready to remove.png');
      await remove.getByRole('button', { name: 'Confirm removal' }).click();
      await expect(remove.getByRole('alert')).toContainText('This attachment changed');
      await expect(remove.getByText('Ready to remove.png', { exact: true })).toBeVisible();
      await expect(remove.getByRole('button', { name: 'Confirm removal' })).toBeDisabled();
      await remove.getByRole('button', { name: 'Close', exact: true }).click();
      await file(editor, 'Ready to remove.png').getByRole('button', { name: 'Remove Ready to remove.png' }).click();
      await remove.getByRole('button', { name: 'Confirm removal' }).click();
      await expect(file(editor, 'Ready to remove.png')).toHaveCount(0);
      assert.equal((await stored()).coverAttachmentId, null);
      assert.equal((await viewer.request.head(origin + '/api/v1/attachments/' + firstImageId + '/download')).status(), 404);

      const openLink = panel(editor).getByRole('button', { name: 'Add link', exact: true });
      const linkDialog = editor.getByRole('dialog', { name: 'Add link' });
      const validAddress = 'http://127.0.0.1:' + sentinel.address().port + '/guide';
      await openLink.click();
      await linkDialog.getByLabel('Name').fill('External guide');
      await linkDialog.getByLabel('URL').fill('http://user:password@127.0.0.1:' + sentinel.address().port + '/guide');
      await expect(linkDialog.getByRole('button', { name: 'Save link' })).toBeDisabled();
      await linkDialog.getByLabel('URL').fill(validAddress);
      await secondEditor.reload();
      await renameFile(secondEditor, 'sample.jpeg', 'Other image.jpeg');
      await linkDialog.getByRole('button', { name: 'Save link' }).click();
      await expect(linkDialog.getByRole('alert')).toContainText('This card changed');
      await expect(linkDialog.getByRole('button', { name: 'Save link' })).toBeDisabled();
      await linkDialog.getByRole('button', { name: 'Close', exact: true }).click();
      await openLink.click();
      await linkDialog.getByLabel('Name').fill('External guide');
      await linkDialog.getByLabel('URL').fill(validAddress);
      await linkDialog.getByRole('button', { name: 'Save link' }).click();
      await expect(linkDialog).toHaveCount(0);
      const external = panel(editor).getByRole('link', { name: 'Open link External guide' });
      await expect(external).toHaveAttribute('rel', 'noopener noreferrer');
      await viewer.reload();
      await expect(panel(viewer).getByRole('link', { name: 'Open link External guide' })).toBeVisible();
      assert.deepEqual(requests, []);
      const [opened] = await Promise.all([editor.context().waitForEvent('page'), external.click()]);
      await expect(opened.getByText('External test link')).toBeVisible();
      assert.deepEqual(requests.filter(({ path }) => path === '/guide'), [{ path: '/guide', referer: undefined }]);
      assert.equal(await opened.evaluate(() => window.opener), null);
      await opened.close();

      const unavailable = fixtureId(5194);
      await fixture.insert('attachments', unavailable, {
        cardId: ids.archivedStory, name: 'Imported missing file', kind: 'file', availability: 'unavailable',
      });
      await editor.goto(parent + '/cards/' + ids.archivedStory + '?context=archive');
      await expect(file(editor, 'Imported missing file').getByText('File unavailable')).toBeVisible();
      await expect(panel(editor).getByRole('button', { name: 'Add file' })).toHaveCount(0);
      await expect(panel(editor).getByRole('link', { name: 'Download Imported missing file' })).toHaveCount(0);

      await fixture.gate.runCommand(() => fixture.db.collection('boardMembers').deleteOne({
        ...fixture.scope, userId: ids.viewer, boardId: ids.privateBoard,
      }));
      assert.equal((await viewer.request.get(origin + downloadPath)).status(), 404);
      await viewer.reload();
      await expect(viewer.getByRole('heading', { name: 'Page not found' }).first()).toBeVisible();
      await expect(panel(viewer)).toHaveCount(0);
      assert.ok(await viewer.getByRole('main').evaluate((main) => main.scrollWidth <= main.clientWidth));
    }, true);
  } finally {
    await new Promise((resolve) => sentinel.close(resolve));
  }
});

test('keyboard destination picker duplicates and transfers cards and a populated finite list across protected boards', { timeout: 125_000 }, async () => {
  await workspaceBrowser(async ({ fixture, origin, page }) => {
    await fixture.db.collection('boardMembers').deleteOne({ ...fixture.scope, boardId: ids.privateBoard, userId: ids.privateOwner });
    await fixture.insert('boardMembers', fixtureId(26000), { boardId: ids.sharedBoard, userId: ids.privateOwner, role: 'editor', canComment: null });
    const third = await fixture.insert('boards', fixtureId(26003), { name: 'Third editor board', projectId: ids.sharedProject, rank: '4000' });
    await fixture.insert('boardMembers', fixtureId(26004), { boardId: third, userId: ids.firstEditor, role: 'editor', canComment: null });
    const relocating = await fixture.insert('lists', fixtureId(26005), { boardId: ids.sharedBoard, name: 'Relocating lane', kind: 'active', rank: '5000' });
    const lane = await fixture.insert('lists', fixtureId(26001), { boardId: ids.privateBoard, name: 'Shipping lane', kind: 'active', rank: '4000' });
    const occupied = await fixture.insert('cards', fixtureId(26002), { boardId: ids.privateBoard, listId: lane,
      name: 'A moving occupant', kind: 'board', type: 'project', rank: '1024' });
    const source = origin + board(ids.privateBoard) + '/cards/' + ids.activeCard + '?view=list';
    const target = origin + board(ids.sharedBoard);
    const manager = await page({ width: 1440, height: 900 });
    const editor = await page({ width: 390, height: 844 });
    const reader = await page({ width: 390, height: 844 });

    async function selectBoard(dialog) {
      await dialog.getByText('Choose another board', { exact: true }).press('Enter');
      await dialog.getByRole('combobox', { name: /^Destination board/u }).selectOption({ label: 'Shared fixture project · Transfer destination' });
    }

    await signIn(manager, origin, 'private-owner');
    await manager.goto(source);
    const managerActions = manager.getByRole('region', { name: 'Card placement' });
    await expect(managerActions.getByRole('button', { name: 'Move card', exact: true })).toHaveCount(0);
    await managerActions.getByRole('button', { name: 'Duplicate card' }).click();
    let dialog = manager.getByRole('dialog', { name: 'Duplicate card' });
    await selectBoard(dialog);
    await dialog.getByLabel('Destination list').selectOption(ids.sharedActiveList);
    await dialog.getByLabel('Position').selectOption(ids.sharedTarget);
    await dialog.getByRole('button', { name: 'Duplicate card' }).click();
    await expect(manager).toHaveURL(new RegExp(target + '/cards/'));
    await expect(manager.getByRole('heading', { name: 'Moving an assigned card', level: 2 })).toBeVisible();
    const duplicateId = new URL(manager.url()).pathname.split('/').at(-1);
    assert.notEqual(duplicateId, ids.activeCard);

    await signIn(reader, origin, 'viewer');
    await reader.goto(source);
    await expect(reader.getByRole('heading', { name: 'Moving an assigned card', level: 2 })).toBeVisible();
    await expect(reader.getByRole('button', { name: 'Duplicate card' })).toHaveCount(0);
    await signIn(editor, origin, 'first-editor');
    await editor.goto(source);
    await editor.getByRole('region', { name: 'Card placement' }).getByRole('button', { name: 'Move card' }).click();
    dialog = editor.getByRole('dialog', { name: 'Move card' });
    await selectBoard(dialog);
    await dialog.getByLabel('Destination list').selectOption(relocating);
    const session = await (await editor.request.get(origin + '/api/v1/session')).json();
    const displaced = await editor.request.post(origin + '/api/v1/lists/' + relocating + '/move', {
      headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': randomUUID(), 'If-Match': '"1"' },
      data: { toBoardId: third, beforeListId: null, sourceOrderVersion: 1, destinationOrderVersion: 1 },
    });
    assert.equal(displaced.status(), 200, await displaced.text());
    const stale = editor.waitForResponse((response) =>
      response.request().method() === 'POST' && response.url().endsWith('/cards/' + ids.activeCard + '/move'));
    await dialog.getByRole('button', { name: 'Move card', exact: true }).click();
    const failure = await stale;
    assert.equal(failure.status(), 409);
    const rejected = await failure.json();
    assert.equal(rejected.error.code, 'CARD_ORDER_CONFLICT');
    assert.equal(rejected.error.fields, undefined);
    await expect(editor).toHaveURL(source);
    await expect(editor.getByRole('region', { name: 'Card placement' }).getByRole('alert')).toBeVisible();

    await editor.getByRole('region', { name: 'Card placement' }).getByRole('button', { name: 'Move card' }).click();
    dialog = editor.getByRole('dialog', { name: 'Move card' });
    await selectBoard(dialog);
    await dialog.getByLabel('Destination list').selectOption(ids.sharedClosedList);
    await dialog.getByRole('button', { name: 'Move card', exact: true }).click();
    await expect(editor).toHaveURL(target + '/cards/' + ids.activeCard);
    await expect(editor.getByRole('heading', { name: 'Moving an assigned card', level: 2 })).toBeVisible();
    await reader.reload();
    await expect(reader.getByRole('heading', { name: 'Page not found', level: 2 })).toBeVisible();
    await expect(reader.getByText('Transfer destination', { exact: true })).toHaveCount(0);

    await editor.goto(origin + board(ids.privateBoard));
    await editor.getByRole('button', { name: 'Move Shipping lane' }).click();
    dialog = editor.getByRole('dialog', { name: 'Move list' });
    await selectBoard(dialog);
    await dialog.getByRole('button', { name: 'Move list', exact: true }).click();
    await expect(editor).toHaveURL(target);
    await expect(editor.getByText('Shipping lane', { exact: true })).toBeVisible();
    await expect(editor.getByRole('link', { name: 'A moving occupant' })).toHaveAttribute('href', board(ids.sharedBoard) + '/cards/' + occupied);
    assert.ok(await editor.getByRole('main').evaluate((main) => main.scrollWidth <= main.clientWidth));
  });
});

test('native comments and inbox honor commenter, recipient and moderation roles on desktop and narrow screens', { timeout: 125_000 }, async () => {
  await workspaceBrowser(async ({ fixture, origin, page }) => {
    await fixture.gate.runCommand(() => fixture.db.collection('boardMembers').deleteOne({
      ...fixture.scope, boardId: ids.privateBoard, userId: ids.privateOwner,
    }));
    await fixture.insert('boardFollows', fixtureId(20151), { boardId: ids.privateBoard, userId: ids.secondEditor });
    await fixture.insert('cardFollows', fixtureId(20152), { cardId: ids.activeCard, userId: ids.secondEditor, isPermanent: true });
    await fixture.insert('activities', fixtureId(20153), {
      boardId: ids.privateBoard, cardId: ids.activeCard, actorId: ids.firstEditor, kind: 'createCard',
    });
    const author = await page({ width: 1440, height: 900 });
    const recipient = await page({ width: 390, height: 844 });
    const manager = await page({ width: 1440, height: 900 });
    const path = origin + board(ids.privateBoard) + '/cards/' + ids.activeCard;
    await signIn(author, origin, 'commenting-viewer');
    await signIn(manager, origin, 'private-owner');
    await recipient.goto(origin + '/inbox?unread=true');
    await expect(recipient).toHaveURL(/\/sign-in\?returnTo=/u);
    await submitSignIn(recipient, 'second-editor');
    await expect(recipient.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
    await expect(recipient.getByText('No unread notifications.')).toBeVisible();

    await author.goto(path);
    const comments = author.getByRole('region', { name: 'Comments', exact: true });
    await comments.getByLabel('Write a comment').fill('Recheck <strong>this measurement</strong> ');
    await comments.getByRole('button', { name: 'Mention someone in this comment' }).click();
    await comments.getByLabel('Find a board member').fill('second-editor');
    await comments.getByRole('button', { name: 'Find members' }).click();
    await comments.getByRole('button', { name: 'Mention Fixture second-editor' }).click();
    const submitted = Promise.withResolvers();
    const acknowledgment = Promise.withResolvers();
    await author.route('**/api/v1/cards/' + ids.activeCard + '/comments', async (route) => {
      if (route.request().method() === 'POST') { submitted.resolve(); await acknowledgment.promise; }
      await route.continue();
    });
    await comments.getByRole('button', { name: 'Post comment' }).click();
    await submitted.promise;
    try {
      await expect(comments.getByLabel('Write a comment')).toBeDisabled();
      await expect(comments.getByRole('button', { name: 'Mention someone in this comment' })).toBeDisabled();
    } finally { acknowledgment.resolve(); }
    const posted = comments.getByRole('listitem').filter({ hasText: 'Recheck <strong>this measurement</strong>' });
    await expect(posted.getByText('@Fixture second-editor', { exact: true })).toBeVisible();
    await expect(posted.locator('.comment-body strong')).toHaveCount(0);

    await recipient.reload();
    await expect(recipient.getByText('mentioned you in a comment.')).toBeVisible();
    await recipient.getByRole('button', { name: 'Menu' }).click();
    await expect(recipient.getByRole('link', { name: 'Inbox, 1 unread' })).toBeVisible();
    await recipient.getByRole('link', { name: 'Inbox, 1 unread' }).click();
    await recipient.getByRole('link', { name: /Unread/u }).click();
    await recipient.getByRole('button', { name: 'Mark read', exact: true }).click();
    await expect(recipient.getByText('No unread notifications.')).toBeVisible();
    await recipient.getByRole('link', { name: 'All', exact: true }).click();
    await recipient.getByRole('button', { name: 'Mark unread', exact: true }).click();
    await expect(recipient.getByRole('button', { name: 'Mark all read', exact: true })).toBeVisible();
    await recipient.getByRole('button', { name: 'Mark card read' }).click();
    await expect(recipient.getByRole('button', { name: 'Mark unread', exact: true })).toBeVisible();

    await posted.getByRole('button', { name: 'Edit comment' }).click();
    const edit = author.getByRole('dialog', { name: 'Edit comment' });
    await expect(edit).toBeVisible();
    const editableComment = edit.getByRole('textbox', { name: 'Comment', exact: true });
    await expect(editableComment).toHaveValue(/Recheck/u);
    await editableComment.fill('Edited without another notice');
    await edit.getByRole('button', { name: 'Save comment' }).click();
    await expect(comments.getByText('Edited without another notice')).toBeVisible();
    await recipient.reload();
    await expect(recipient.getByText('mentioned you in a comment.')).toHaveCount(1);

    await author.getByText('Card activity', { exact: true }).click();
    await expect(author.getByText('created this card.')).toBeVisible();
    await author.getByRole('link', { name: 'Close card' }).click();
    await author.getByText('Board activity', { exact: true }).click();
    const boardActivity = author.locator('details[aria-label="Board activity"]');
    await expect(boardActivity.getByRole('link', { name: 'Moving an assigned card' })).toBeVisible();

    await manager.goto(path);
    const moderation = manager.getByRole('region', { name: 'Comments', exact: true });
    await expect(moderation.getByLabel('Write a comment')).toHaveCount(0);
    await expect(moderation.getByRole('button', { name: 'Edit comment' })).toHaveCount(0);
    await moderation.getByRole('button', { name: 'Delete comment' }).click();
    await manager.getByRole('dialog', { name: 'Delete comment' }).getByRole('button', { name: 'Confirm deletion' }).click();
    await expect(moderation.getByText('No comments.')).toBeVisible();
    await recipient.reload();
    await expect(recipient.getByText('No notifications.')).toBeVisible();
    assert.ok(await recipient.getByRole('main').evaluate((main) => main.scrollWidth <= main.clientWidth));
  });
});

test('board filters retain one URL recipe across views and pages with isolated explicit tab recall', { timeout: 125_000 }, async () => {
  await workspaceBrowser(async ({ fixture, origin, page }) => {
    await fixture.insert('boardPreferences', fixtureId(28999), { boardId: ids.privateBoard, showCardCount: true });
    const label = await fixture.insert('labels', fixtureId(29000), { boardId: ids.privateBoard, name: 'Release label', rank: '1' });
    for (let index = 0; index < 5; index++) {
      const id = await fixture.insert('cards', fixtureId(29001 + index), { boardId: ids.privateBoard, listId: ids.privateActiveList,
        name: 'Quartz card ' + (index + 1), description: 'Signal from the imported source', kind: 'board', type: 'project', rank: String(2048 + index * 1024) });
      await fixture.insert('cardLabels', fixtureId(29011 + index), { cardId: id, labelId: label });
    }
    await fixture.insert('cards', fixtureId(29016), { boardId: ids.privateBoard, listId: ids.privateArchive,
      name: 'Quartz archived', description: 'Signal from history', kind: 'archive', type: 'project', rank: null,
      historySequence: '9007199254740996', listChangedAt: '2026-01-15T10:30:45.000Z' });
    const mount = origin + board(ids.privateBoard);
    const editor = await page({ width: 1440, height: 900 });
    const other = await page({ width: 390, height: 844 });
    await signIn(editor, origin, 'first-editor');
    await editor.goto(mount + '?view=list&limit=2');
    const filters = editor.getByRole('search', { name: 'Board cards' });
    await filters.getByRole('searchbox', { name: 'Search cards' }).fill('Quartz; SIGNAL');
    await filters.getByText('Filter by labels, members or lists').click();
    await filters.getByRole('group', { name: 'Include any label' }).getByLabel('Release label').check();
    await filters.getByRole('button', { name: 'Apply filters' }).click();
    const cards = editor.getByRole('table', { name: 'Cards' }).or(editor.getByRole('list', { name: 'Card grid' }));
    await expect(cards.getByRole('link', { name: 'Quartz card 1', exact: true })).toBeVisible();
    await expect(cards.getByRole('link')).toHaveCount(2);
    await expect(editor.getByRole('list', { name: 'Board lists' }).getByText('5 cards', { exact: true })).toBeVisible();
    assert.equal(new URL(editor.url()).searchParams.get('labelsAny'), label);
    async function saveRecipe(name) {
      await filters.getByRole('button', { name: 'Save filters' }).click();
      await filters.getByRole('textbox', { name: 'Recipe name' }).fill(name);
      await filters.getByRole('button', { name: 'Save recipe' }).click();
      await expect(filters.getByText('Filters saved for this tab.')).toBeVisible();
    }
    await saveRecipe('Release quartz');
    await filters.getByRole('searchbox').fill('A different filter');
    await saveRecipe('Alternate recipe');
    await expect(filters.getByRole('combobox', { name: 'Saved recipe' }).getByRole('option')).toHaveCount(2);
    assert.equal(new URL(editor.url()).searchParams.get('q'), 'Quartz; SIGNAL');
    await editor.getByRole('navigation', { name: 'Board view' }).getByRole('link', { name: 'Grid' }).click();
    await expect(editor.getByRole('link', { name: 'Quartz card 1', exact: true })).toBeVisible();
    assert.equal(new URL(editor.url()).searchParams.get('q'), 'Quartz; SIGNAL');
    assert.equal(new URL(editor.url()).searchParams.get('view'), 'grid');
    await cards.getByRole('link', { name: 'Quartz card 1', exact: true }).click();
    await expect(editor.getByRole('heading', { name: 'Quartz card 1', level: 2 })).toBeVisible();
    assert.equal(new URL(editor.url()).searchParams.get('labelsAny'), label);
    await editor.goBack();
    await expect(cards.getByRole('link', { name: 'Quartz card 1', exact: true })).toBeFocused();

    const pager = editor.getByRole('navigation', { name: 'Card pages' });
    await pager.getByRole('link', { name: 'Next page' }).click();
    await expect(cards.getByRole('link', { name: 'Quartz card 3', exact: true })).toBeVisible();
    assert.ok(new URL(editor.url()).searchParams.get('cursor'));
    await expect(editor.getByRole('list', { name: 'Board lists' }).getByText('5 cards', { exact: true })).toBeVisible();
    await editor.reload();
    await expect(cards.getByRole('link', { name: 'Quartz card 3', exact: true })).toBeVisible();
    const invalidCursor = new URL(editor.url());
    invalidCursor.searchParams.set('cursor', 'v1.A');
    await editor.goto(invalidCursor.href);
    await expect(cards.getByRole('link', { name: 'Quartz card 1', exact: true })).toBeVisible();
    assert.equal(new URL(editor.url()).searchParams.has('cursor'), false);
    await filters.getByRole('button', { name: 'Clear filters' }).click();
    await expect(filters.getByRole('searchbox')).toHaveValue('');
    await expect.poll(() => new URL(editor.url()).searchParams.has('q')).toBe(false);
    await filters.getByRole('button', { name: 'Recall last cleared filters' }).click();
    await expect(cards.getByRole('link', { name: 'Quartz card 1', exact: true })).toBeVisible();
    await filters.getByRole('combobox', { name: 'Saved recipe' }).selectOption('Alternate recipe');
    await filters.getByRole('button', { name: 'Recall saved filters' }).click();
    await expect(editor.getByText('No matching cards', { exact: true })).toBeVisible();
    await filters.getByRole('combobox', { name: 'Saved recipe' }).selectOption('Release quartz');
    await filters.getByRole('button', { name: 'Recall saved filters' }).click();
    await expect(filters.getByRole('searchbox')).toHaveValue('Quartz; SIGNAL');
    await expect(cards.getByRole('link', { name: 'Quartz card 1', exact: true })).toBeVisible();
    await editor.getByRole('navigation', { name: 'Board context' }).getByRole('link', { name: 'Archive' }).click();
    await expect(editor.getByRole('link', { name: 'Archive', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(filters.getByRole('button', { name: 'Recall saved filters' })).toHaveCount(0);
    await filters.getByRole('button', { name: 'Clear filters' }).click();
    await filters.getByRole('searchbox').fill('Quartz');
    await filters.getByRole('button', { name: 'Apply filters' }).click();
    await expect(editor.getByRole('link', { name: 'Quartz archived', exact: true })).toBeVisible();
    await expect(editor.getByRole('link', { name: 'Quartz card 1', exact: true })).toHaveCount(0);

    const otherTab = await editor.context().newPage();
    await otherTab.goto(mount);
    const tabFilters = otherTab.getByRole('search', { name: 'Board cards' });
    await expect(tabFilters).toBeVisible();
    await expect(tabFilters.getByRole('button', { name: /Recall/u })).toHaveCount(0);
    await editor.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(editor.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(filters).toHaveCount(0);
    await expect(otherTab.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await signIn(editor, origin, 'first-editor');
    await editor.goto(mount);
    await expect(filters).toBeVisible();
    await expect(filters.getByRole('button', { name: /Recall/u })).toHaveCount(0);
    await editor.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(editor.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await signIn(editor, origin, 'viewer');
    await editor.goto(mount);
    await expect(filters).toBeVisible();
    await expect(filters.getByRole('button', { name: /Recall/u })).toHaveCount(0);
    await signIn(other, origin, 'viewer');
    await other.goto(mount);
    const otherFilters = other.getByRole('search', { name: 'Board cards' });
    await expect(otherFilters.getByRole('button', { name: /Recall/u })).toHaveCount(0);
    await otherFilters.getByRole('searchbox').fill('/([/');
    await otherFilters.getByRole('button', { name: 'Apply filters' }).click();
    await expect(other.getByText('Enter a valid slash-delimited search pattern.')).toBeVisible();
    await expect(other.getByRole('link', { name: 'Quartz card 1', exact: true })).toHaveCount(0);
    assert.ok(await other.getByRole('main').evaluate((main) => main.scrollWidth <= main.clientWidth));
  });
});

test('a late card page cannot replace a newer recipe or survive current board access loss', { timeout: 120_000 }, async () => {
  await workspaceBrowser(async ({ fixture, origin, page }) => {
    const lateCard = await fixture.insert('cards', fixtureId(29100), { boardId: ids.privateBoard, listId: ids.privateActiveList,
      name: 'Late card from the prior recipe', description: null, kind: 'board', type: 'project', rank: '2048' });
    const editor = await page({ width: 1440, height: 900 });
    await signIn(editor, origin, 'first-editor');
    await editor.goto(origin + board(ids.privateBoard) + '?limit=1&view=list');
    const filters = editor.getByRole('search', { name: 'Board cards' });
    const watched = '**/api/v1/boards/**/cards?*';
    const held = Promise.withResolvers();
    const resume = Promise.withResolvers();
    await editor.route(watched, async (intercepted) => {
      if (!new URL(intercepted.request().url()).searchParams.has('cursor')) { await intercepted.continue(); return; }
      const response = await intercepted.fetch();
      held.resolve((await response.json()).data.map(({ id }) => id));
      await resume.promise;
      await intercepted.fulfill({ response }).catch(() => {});
    });
    try {
      await editor.getByRole('navigation', { name: 'Card pages' }).getByRole('link', { name: 'Next page' }).click({ noWaitAfter: true });
      assert.deepEqual(await held.promise, [lateCard]);
      await expect(editor.getByText('Loading cards…')).toBeVisible();
      await filters.getByRole('searchbox').fill('No such card in this board');
      await filters.getByRole('button', { name: 'Apply filters' }).click({ noWaitAfter: true });
      await expect(editor.getByText('No matching cards', { exact: true })).toBeVisible();
      resume.resolve();
      await expect(editor.getByRole('link', { name: 'Late card from the prior recipe' })).toHaveCount(0);
    } finally { resume.resolve(); await editor.unroute(watched); }

    await editor.route(watched, (request) => request.fulfill({ status: 503,
      json: { error: { code: 'UNAVAILABLE', message: 'Planner is unavailable.', requestId: 'fixture' } } }));
    await filters.getByRole('searchbox').fill('Late card');
    await filters.getByRole('button', { name: 'Apply filters' }).click();
    await expect(editor.getByRole('alert').getByText('Cards couldn’t load.')).toBeVisible();
    await editor.unroute(watched);
    await editor.getByRole('alert').getByRole('button', { name: 'Retry' }).click();
    await expect(editor.getByRole('link', { name: 'Late card from the prior recipe' })).toBeVisible();

    await fixture.gate.runCommand(() => fixture.db.collection('boardMembers').deleteOne({
      ...fixture.scope, boardId: ids.privateBoard, userId: ids.firstEditor,
    }));
    await filters.getByRole('searchbox').fill('Prior recipe');
    await filters.getByRole('button', { name: 'Apply filters' }).click();
    await expect(editor.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(editor.getByRole('link', { name: 'Late card from the prior recipe' })).toHaveCount(0);
    await expect(filters).toHaveCount(0);
  });
});

test('a rejected filter-member read clears the board and open inspector before revalidation completes', { timeout: 120_000 }, async () => {
  await workspaceBrowser(async ({ fixture, origin, page }) => {
    const editor = await page({ width: 1440, height: 900 });
    await signIn(editor, origin, 'first-editor');
    await editor.goto(origin + board(ids.privateBoard) + '/cards/' + ids.activeCard);
    await expect(editor.getByRole('heading', { name: 'Moving an assigned card', level: 2 })).toBeVisible();
    const heading = editor.locator('#page-heading');
    const oldName = await heading.textContent();
    assert.ok(oldName?.trim());
    const sidebarBoard = editor.getByRole('navigation', { name: 'Project navigation' }).getByRole('link', { name: oldName, exact: true });
    await expect(sidebarBoard).toBeVisible();
    const filters = editor.getByRole('search', { name: 'Board cards' });
    await expect(filters).toBeVisible();
    const held = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const overview = '**/api/v1/boards/' + ids.privateBoard + '/workspace';
    await editor.route(overview, async (intercepted) => {
      held.resolve();
      await resume.promise;
      await intercepted.continue().catch(() => {});
    });
    try {
      await fixture.gate.runCommand(() => fixture.db.collection('boardMembers').deleteOne({
        ...fixture.scope, boardId: ids.privateBoard, userId: ids.firstEditor,
      }));
      const denied = editor.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/filter-members'));
      await filters.getByText('Filter by labels, members or lists').click();
      assert.equal((await denied).status(), 404);
      await held.promise;
      await expect(editor.getByRole('heading', { name: 'Page not found' })).toBeVisible();
      await expect(editor.getByRole('heading', { name: oldName, exact: true })).toHaveCount(0);
      await expect(sidebarBoard).toHaveCount(0);
      await expect(editor.getByRole('heading', { name: 'Moving an assigned card', level: 2 })).toHaveCount(0);
      await expect(editor.getByRole('navigation', { name: 'Board context' })).toHaveCount(0);
      await expect(filters).toHaveCount(0);
    } finally { resume.resolve(); }
    await expect(editor.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  });
});

test('native board layouts share card placement, preference display, and paged inspector focus', { timeout: 125_000 }, async () => {
  await workspaceBrowser(async ({ fixture, origin, page }) => {
    const path = origin + board(ids.privateBoard);
    await fixture.insert('boardPreferences', fixtureId(29900), {
      boardId: ids.privateBoard, defaultView: 'grid', showCreator: true, showCardAge: true, showCardCount: true,
    });
    const after = await fixture.insert('cards', fixtureId(29901), {
      boardId: ids.privateBoard, listId: ids.privateActiveList, name: 'Layout second card',
      description: null, kind: 'board', type: 'project', rank: '2048', creatorId: ids.secondEditor,
    });
    const editor = await page({ width: 1440, height: 900 });
    const narrow = await page({ width: 390, height: 844 });
    await signIn(editor, origin, 'first-editor');
    await editor.goto(path + '?limit=1');
    const cardGrid = editor.getByRole('list', { name: 'Card grid' });
    await expect(cardGrid.getByRole('link', { name: 'Moving an assigned card' })).toBeVisible();
    await editor.getByRole('link', { name: 'Next page' }).click();
    const cardLink = cardGrid.getByRole('link', { name: 'Layout second card' });
    await expect(cardLink).toBeVisible();
    await expect(cardGrid.getByText('To do', { exact: true })).toBeVisible();
    await expect(cardGrid.getByText(/Created by Fixture second-editor/iu)).toBeVisible();
    assert.equal(await cardGrid.locator('time[datetime]').count(), 1);
    const paged = new URL(editor.url()).search;
    await cardLink.click();
    await expect(editor.getByRole('heading', { name: 'Layout second card', level: 2 })).toBeFocused();
    await editor.getByRole('link', { name: 'Close card' }).click();
    await expect(cardLink).toBeFocused();
    assert.equal(new URL(editor.url()).search, paged);
    await cardLink.click();
    await expect(editor.getByRole('heading', { name: 'Layout second card', level: 2 })).toBeVisible();
    await editor.goBack();
    await expect(cardLink).toBeFocused();
    await cardGrid.getByRole('button', { name: 'Move card Layout second card' }).press('Enter');
    const move = editor.getByRole('dialog', { name: 'Move card' });
    await expect(move.getByRole('option', { name: 'Before Moving an assigned card' })).toHaveCount(1);
    await move.getByRole('button', { name: 'Close' }).click();

    const views = editor.getByRole('navigation', { name: 'Board view' });
    await views.getByRole('link', { name: 'List' }).click();
    await expect(editor.getByRole('table', { name: 'Cards' }).getByRole('columnheader', { name: 'List' })).toBeVisible();
    await editor.goto(path);
    await expect(views.getByRole('link', { name: 'List' })).toHaveAttribute('aria-current', 'page');
    await views.getByRole('link', { name: 'Kanban' }).click();
    await expect(editor.getByRole('list', { name: 'Cards in To do' })).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Add card to Done' })).toBeVisible();
    await editor.getByRole('link', { name: 'Archive', exact: true }).click();
    await expect(views.getByRole('link', { name: 'Kanban' })).toHaveCount(0);
    await expect(views.getByRole('link', { name: 'List' })).toHaveAttribute('aria-current', 'page');

    await signIn(narrow, origin, 'viewer');
    await narrow.goto(path + '/cards/' + after + '?view=list');
    await expect(narrow.getByRole('heading', { name: 'Layout second card', level: 2 })).toBeVisible();
    await expect(narrow.getByRole('button', { name: 'Save card' })).toHaveCount(0);
    assert.ok(await narrow.getByRole('main').evaluate((main) => main.scrollWidth <= main.clientWidth));
    await narrow.getByRole('link', { name: 'Close card' }).click();
    await expect(narrow.locator('#page-heading')).toBeFocused();
    await expect(narrow.getByRole('table', { name: 'Cards' })).toBeVisible();
    await narrow.goto(path + '/cards/not-a-card-id?view=list');
    await expect(narrow.getByRole('heading', { name: 'Page not found', level: 2 })).toBeVisible();
    await narrow.getByRole('link', { name: 'Close card' }).click();
    await expect(narrow.locator('#page-heading')).toBeFocused();
  });
});

test('native browser applies verified live updates passively and preserves a dirty draft until access is lost', { timeout: 125_000 }, async () => {
  let time = Date.parse('2026-03-19T13:13:59.719Z');
  await workspaceBrowser(async ({ fixture: f, origin, page }) => {
    const editor = await page({ width: 1440, height: 900 });
    const peer = await page({ width: 1440, height: 900 });
    const path = board(ids.privateBoard) + '/cards/' + ids.activeCard + '?view=list';
    const eventsPath = '/api/v1' + board(ids.privateBoard) + '/events';
    await f.insert('cards', fixtureId(29920), { boardId: ids.privateBoard, listId: ids.privateActiveList,
      name: 'Earlier card on page one', description: null, kind: 'board', type: 'project', rank: '1' });
    await signIn(editor, origin, 'first-editor');
    await f.db.collection('users').updateOne({ ...f.scope, id: ids.privateOwner },
      { $set: { 'preferences.autoLogout': '2m' } });
    await signIn(peer, origin, 'private-owner');
    const liveConnections = [];
    editor.on('response', (response) => {
      if (new URL(response.url()).pathname === eventsPath) liveConnections.push(response.status());
    });
    const sessionReads = [];
    editor.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/v1/session') sessionReads.push(request.headers()[passiveSessionHeader]);
    });
    await editor.goto(origin + path);
    await peer.goto(origin + path);
    const draft = editor.getByRole('textbox', { name: 'Card name' });
    await expect(draft).toHaveValue('Moving an assigned card');
    await expect.poll(() => liveConnections).toEqual([200]);
    await expect.poll(() => sessionReads.includes('1')).toBe(true);
    await draft.fill('Undone local title');
    await draft.fill('Moving an assigned card');
    await expect(editor.getByRole('button', { name: 'Save card' })).toBeDisabled();
    const session = () => f.db.collection('sessions').findOne({ ...f.scope, userId: ids.firstEditor });
    const lastActivity = (await session()).lastActivityAt.getTime();
    time += 25_000;
    const publish = () => new CommandJournal(f.gate, f.db, f.installationId).deliverPending(f.streams.accept);
    const remote = peer.getByRole('textbox', { name: 'Card name' });
    await remote.fill('Peer live title');
    await peer.getByRole('button', { name: 'Save card' }).click();
    await expect(peer.getByRole('heading', { name: 'Peer live title', level: 2 })).toBeVisible();
    await publish();
    await expect(editor.getByRole('heading', { name: 'Peer live title', level: 2 })).toBeVisible();
    await expect(draft).toHaveValue('Peer live title');
    const conflict = editor.getByText('The card changed while you were editing. Your edits are still here.');
    await expect(conflict).toHaveCount(0);
    await draft.fill('Other undone local title');
    await draft.fill('Peer live title');
    await editor.getByRole('button', { name: 'Markdown', exact: true }).click();
    const description = editor.getByRole('textbox', { name: 'Description', exact: true });
    await description.fill('Unsubmitted local description');
    assert.equal((await session()).lastActivityAt.getTime(), lastActivity);

    const peerSession = await (await peer.request.get(origin + '/api/v1/session')).json();
    const peerHeaders = { Origin: origin, 'X-CSRF-Token': peerSession.csrfToken };
    const boardPath = origin + '/api/v1' + board(ids.privateBoard);
    const currentBoard = (await (await peer.request.get(boardPath)).json()).data;
    const renamed = await peer.request.patch(boardPath, {
      headers: { ...peerHeaders, 'If-Match': '"' + currentBoard.revision + '"', 'Idempotency-Key': randomUUID() },
      data: { name: 'Board from the live peer' },
    });
    assert.equal(renamed.status(), 200, await renamed.text());
    await publish();
    await expect(editor.getByRole('heading', { name: 'Board from the live peer', level: 1 })).toBeVisible();
    await expect(editor.getByRole('navigation', { name: 'Project navigation' })
      .getByRole('link', { name: 'Board from the live peer' })).toBeVisible();
    await expect(description).toHaveValue('Unsubmitted local description');

    const heldCard = Promise.withResolvers();
    const releaseCard = Promise.withResolvers();
    const selectedCard = '/api/v1/cards/' + ids.activeCard;
    const cardPath = origin + selectedCard;
    let holdNextCardRead = true;
    await editor.route('**' + selectedCard + '?boardId=*', async (intercepted) => {
      if (!holdNextCardRead) { await intercepted.continue(); return; }
      holdNextCardRead = false;
      const snapshot = await intercepted.fetch();
      heldCard.resolve();
      await releaseCard.promise;
      await intercepted.fulfill({ response: snapshot }).catch(() => {});
    });
    async function renameCard(name) {
      const current = (await (await peer.request.get(cardPath)).json()).data;
      const saved = await peer.request.patch(cardPath, {
        headers: { ...peerHeaders, 'If-Match': '"' + current.revision + '"', 'Idempotency-Key': randomUUID() },
        data: { name },
      });
      assert.equal(saved.status(), 200, await saved.text());
      await publish();
    }
    try {
      await renameCard('First update in a burst');
      await heldCard.promise;
      await renameCard('Newest update in a burst');
    } finally { releaseCard.resolve(); }
    await expect(editor.getByRole('heading', { name: 'Newest update in a burst', level: 2 })).toBeVisible();
    await expect(peer.getByRole('heading', { name: 'Newest update in a burst', level: 2 })).toBeVisible();
    await expect(draft).toHaveValue('Newest update in a burst');
    await expect(description).toHaveValue('Unsubmitted local description');

    let invalidatedResume = false;
    await editor.route('**' + eventsPath + '?after=*', async (intercepted) => {
      const url = new URL(intercepted.request().url());
      if (!invalidatedResume) {
        invalidatedResume = true;
        url.searchParams.set('after', 'v1.0.' + 'a'.repeat(43));
      }
      await intercepted.continue({ url: url.href });
    });
    const credentials = await editor.context().cookies();
    const token = credentials.find(({ name }) => name === '__Host-planner-session')?.value;
    assert.ok(token);
    f.streams.disconnectToken(token);
    await expect.poll(() => liveConnections).toEqual([200, 200, 200]);
    await expect(description).toHaveValue('Unsubmitted local description');
    await publish();
    await expect(conflict).toHaveCount(1);
    assert.equal((await session()).lastActivityAt.getTime(), lastActivity);

    const pageOne = await editor.request.get(boardPath + '/cards?context=board&limit=1');
    assert.equal(pageOne.status(), 200, await pageOne.text());
    const cursor = (await pageOne.json()).page.nextCursor;
    assert.ok(cursor);
    await editor.goto(origin + path + '&limit=1&cursor=' + encodeURIComponent(cursor));
    await expect(editor.getByRole('heading', { name: 'Newest update in a burst', level: 2 })).toBeVisible();
    assert.equal(new URL(editor.url()).searchParams.get('cursor'), cursor);
    const visitActivity = (await session()).lastActivityAt.getTime();
    time += 5_000;

    const memberPath = boardPath + '/members/' + ids.firstEditor;
    const downgraded = await peer.request.patch(memberPath, {
      headers: { ...peerHeaders, 'If-Match': '"1"', 'Idempotency-Key': randomUUID() },
      data: { role: 'viewer', canComment: false },
    });
    assert.equal(downgraded.status(), 200, await downgraded.text());
    await publish();
    await expect.poll(() => new URL(editor.url()).searchParams.has('cursor')).toBe(false);
    assert.equal(new URL(editor.url()).pathname, new URL(origin + path).pathname);
    await expect(editor.getByRole('heading', { name: 'Newest update in a burst', level: 2 })).toBeVisible();
    await expect(editor.getByRole('link', { name: 'Earlier card on page one' })).toBeVisible();
    await expect(draft).toHaveCount(0);
    assert.equal((await session()).lastActivityAt.getTime(), visitActivity);

    const removed = await peer.request.delete(memberPath, {
      headers: { ...peerHeaders, 'If-Match': '"2"', 'Idempotency-Key': randomUUID() },
    });
    assert.equal(removed.status(), 204, await removed.text());
    await publish();
    await expect(editor.getByRole('heading', { name: 'Page not found', level: 1 })).toBeVisible();
    await expect(draft).toHaveCount(0);
    await expect(editor.getByRole('link', { name: 'Board from the live peer', exact: true })).toHaveCount(0);
    assert.equal((await session()).lastActivityAt.getTime(), visitActivity);
    await expect(peer.getByRole('heading', { name: 'Newest update in a burst', level: 2 })).toBeVisible();
    const peerActivity = (await f.db.collection('sessions').findOne({ ...f.scope, userId: ids.privateOwner })).lastActivityAt.getTime();
    assert.equal(peerActivity, time);
    time += 121_000;
    await expect(peer.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible({ timeout: 10_000 });
    assert.equal(new URL(peer.url()).searchParams.get('returnTo'), path);
    await expect(peer.getByRole('heading', { name: 'Newest update in a burst', level: 2 })).toHaveCount(0);
  }, false, { clock: () => new Date(time), heartbeatMs: 200 });
});
