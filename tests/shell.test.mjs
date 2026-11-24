import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';

const main = fileURLToPath(new URL('../apps/server/dist/main.js', import.meta.url));
const webRoot = fileURLToPath(new URL('../apps/web/', import.meta.url));

async function startBackend(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'planner-shell-cwd-'));
  const child = spawn(process.execPath, [main], {
    cwd,
    env: { ...process.env, PLANNER_HTTP_PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = once(child, 'close');
  const lines = createInterface({ input: child.stdout });
  t.after(async () => {
    const forceKill = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.kill('SIGTERM');
    try {
      assert.deepEqual(await exited, [0, null]);
    } finally {
      clearTimeout(forceKill);
      lines.close();
      await rm(cwd, { force: true, recursive: true });
    }
  });
  const [address] = await once(lines, 'line', { signal: AbortSignal.timeout(5_000) });
  assert.match(address, /^http:\/\/127\.0\.0\.1:[1-9]\d*$/u);
  return address;
}

test('compiled Planner serves only its browser routes and built assets', { timeout: 15_000 }, async (t) => {
  const address = await startBackend(t);
  const load = (path, options) => fetch(new URL(path, address), {
    headers: { accept: 'text/html' }, signal: AbortSignal.timeout(5_000), ...options,
  });
  const root = await load('/', { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/workspace');

  let html;
  for (const path of ['/workspace', '/projects/p', '/boards/b?view=list', '/boards/b/cards/c?context=archive&view=grid']) {
    const response = await load(path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/u);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    html = await response.text();
    assert.match(html, /<title>Planner<\/title>/u);
  }
  for (const extension of ['js', 'css']) {
    const asset = [...html.matchAll(/"(\/assets\/[^"/]+)"/gu)].find(([, path]) => path.endsWith(`.${extension}`));
    assert.ok(asset);
    assert.match(asset[1], /-[\w-]+\.(?:js|css)$/u);
    const response = await load(asset[1]);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), extension === 'js' ? /javascript/u : /text\/css/u);
    assert.match(response.headers.get('cache-control'), /max-age=31536000/u);
    assert.match(response.headers.get('cache-control'), /immutable/u);
    assert.ok((await response.text()).length > 0);
  }
  for (const path of ['/api/v1/example', '/health/other', '/mcp', '/other', '/projects/p/unknown', '/boards/b/cards', '/boards/b/cards/c/unknown', '/assets/missing.js']) {
    const response = await load(path);
    assert.equal(response.status, 404, path);
    assert.match(response.headers.get('content-type'), /application\/json/u, path);
  }
  const live = await load('/health/live');
  assert.equal(live.status, 200);
  assert.equal((await live.json()).status, 'live');
  const ready = await load('/health/ready');
  assert.equal(ready.status, 503);
  assert.equal((await ready.json()).status, 'unavailable');
});

test('Chromium opens and restores routes at desktop and narrow widths', { timeout: 30_000 }, async (t) => {
  const address = await startBackend(t);
  const browser = await chromium.launch();
  t.after(() => browser.close());

  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await t.test(`${viewport.width}×${viewport.height}`, async (t) => {
      const page = await browser.newPage({ viewport });
      t.after(() => page.close());
      const query = '?context=archive&view=grid&filter=kept';
      const board = `${address}/boards/b${query}`;
      const card = `${address}/boards/b/cards/c${query}`;
      await page.goto(address);
      await expect(page).toHaveURL(`${address}/workspace`);
      await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'No projects to show' })).toBeVisible();
      await page.goto(`${address}/projects/p`);
      await expect(page.getByRole('heading', { name: 'Project', exact: true })).toBeFocused();
      await expect(page.getByRole('heading', { name: 'No boards to show' })).toBeVisible();
      await page.goto(card);
      const cardHeading = page.getByRole('heading', { name: 'Card', exact: true });
      await expect(cardHeading).toBeFocused();
      const inspector = page.getByRole('complementary', { name: 'Card' });
      const inspectorBox = await inspector.boundingBox();
      assert.ok(inspectorBox);
      if (viewport.width === 390) {
        assert.equal(Math.round(inspectorBox.width), viewport.width);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), viewport.width);
        const toggle = page.getByRole('button', { name: 'Menu' });
        const navigation = page.getByRole('navigation', { name: 'Project navigation' });
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await toggle.click();
        await expect(navigation).toBeVisible();
        await navigation.getByRole('link', { name: 'Projects' }).focus();
        await page.keyboard.press('Escape');
        await expect(toggle).toBeFocused();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await cardHeading.focus();
      } else {
        await expect(page.getByRole('navigation', { name: 'Project navigation' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Board', exact: true })).toBeVisible();
        assert.ok(inspectorBox.width < viewport.width / 2);
      }
      await page.keyboard.press('Tab');
      await expect(page.getByRole('link', { name: 'Close card' })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(board);
      await expect(page.getByRole('heading', { name: 'Board', exact: true })).toBeFocused();
      await expect(page.getByRole('link', { name: 'Archive' })).toHaveAttribute('aria-current', 'page');
      await expect(page.getByRole('link', { name: 'Grid' })).toHaveAttribute('aria-current', 'page');
      await page.goBack();
      await expect(page).toHaveURL(card);
      await expect(cardHeading).toBeFocused();
      await page.reload();
      await expect(cardHeading).toBeFocused();
      await page.goForward();
      await expect(page).toHaveURL(board);
      await expect(page.getByRole('heading', { name: 'Board', exact: true })).toBeFocused();
      await page.getByRole('link', { name: 'Trash' }).click();
      await expect(page).toHaveURL(`${address}/boards/b?context=trash&view=grid&filter=kept`);
      await expect(page.getByRole('heading', { name: 'No trashed cards to show' })).toBeVisible();
    });
  }
});

test('Chromium keeps navigation usable during a route load and failed chunk retry', { timeout: 25_000 }, async (t) => {
  const address = await startBackend(t);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  t.after(() => page.close());
  const asset = '**/assets/board-page-*.js';
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route(asset, async (route) => {
    await held;
    await route.abort('failed');
  });
  try {
    await page.goto(`${address}/boards/b?view=list`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('status')).toHaveText('Loading…');
    await expect(page.getByRole('navigation', { name: 'Project navigation' })).toBeVisible();
  } finally {
    release();
  }
  await expect(page.getByRole('heading', { name: 'Page couldn’t load' })).toBeFocused();
  await page.getByRole('navigation', { name: 'Project navigation' }).getByRole('link', { name: 'Projects' }).click();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeFocused();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Page couldn’t load' })).toBeFocused();
  await page.unroute(asset);
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page).toHaveURL(`${address}/boards/b?view=list`);
  await expect(page.getByRole('heading', { name: 'Board', exact: true })).toBeFocused();
  await expect(page.getByRole('link', { name: 'List' })).toHaveAttribute('aria-current', 'page');
});

test('Chromium uses the same Vite origin for API and health proxy requests', { timeout: 25_000 }, async (t) => {
  const backend = await startBackend(t);
  const oldPort = process.env.PLANNER_PROXY_PORT;
  process.env.PLANNER_PROXY_PORT = new URL(backend).port;
  let vite;
  try {
    vite = await createServer({ root: webRoot, logLevel: 'silent', server: { port: 0, strictPort: true } });
  } finally {
    if (oldPort === undefined) delete process.env.PLANNER_PROXY_PORT;
    else process.env.PLANNER_PROXY_PORT = oldPort;
  }
  t.after(() => vite.close());
  await vite.listen();
  const bound = vite.httpServer.address();
  assert.equal(bound.address, '127.0.0.1');
  const origin = `http://127.0.0.1:${bound.port}`;
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(origin);
  await expect(page).toHaveURL(`${origin}/workspace`);
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  const outcomes = await page.evaluate(async () => {
    const paths = ['/health/live', '/health/ready', '/api/v1/example?mode=test', '/api?mode=test', '/apiary', '/healthcare'];
    return Promise.all(paths.map(async (path) => {
      const response = await fetch(path, { headers: { accept: 'text/html' } });
      const contentType = response.headers.get('content-type');
      return { status: response.status, contentType, data: contentType.includes('json') && await response.json() };
    }));
  });
  assert.equal(outcomes[0].status, 200);
  assert.equal(outcomes[0].data.status, 'live');
  assert.equal(outcomes[1].status, 503);
  assert.equal(outcomes[1].data.status, 'unavailable');
  assert.equal(outcomes[2].status, 404);
  assert.match(outcomes[2].data.message, /\/api\/v1\/example\?mode=test/u);
  assert.equal(outcomes[3].status, 404);
  assert.match(outcomes[3].data.message, /\/api\?mode=test/u);
  for (const outcome of outcomes.slice(4)) {
    assert.equal(outcome.status, 200);
    assert.match(outcome.contentType, /text\/html/u);
  }
});
