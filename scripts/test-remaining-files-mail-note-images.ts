/** Mail-to-Notes image policy on the disposable, seeded mail fixture. */
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { loginPage } from './officeHarness';

type Fixture = {
  kind: string; databaseName: string;
  servers: Array<{ index: number; origin: string }>;
  accounts: Array<{ symbol: string; password: string; role: string }>;
  mailFixture?: { messageId: string; syntheticSuffix: string };
};
assert.equal(process.env.FLUX_TEST_FIXTURE, '1', 'requires explicitly marked disposable fixture');
const metadataPath = process.env.FLUX_REMAINING_LIVE_METADATA || '/tmp/flux-remaining-live.json';
assert.equal(statSync(metadataPath).mode & 0o077, 0, 'fixture metadata must remain private');
const fixture = JSON.parse(readFileSync(metadataPath, 'utf8')) as Fixture;
assert.equal(fixture.kind, 'flux-remaining-live-fixture');
assert.match(fixture.databaseName, /^flux_[a-z0-9_]+_fixture(?:_|$)/i);
assert.ok(fixture.mailFixture?.messageId && fixture.mailFixture.syntheticSuffix, 'seeded mail fixture details are required');
const api = fixture.servers.find(server => server.index === 1)?.origin;
assert.ok(api, 'fixture API server 1 is recorded');
const apiUrl = new URL(api);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(apiUrl.hostname), 'fixture API must be loopback');
const admin = fixture.accounts.find(account => account.role === 'ADMIN');
assert.ok(admin, 'synthetic administrator credentials are present');

async function call(method: string, route: string, token = '', body?: unknown) {
  const response = await fetch(new URL(route, apiUrl), {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) as any };
}

async function main() {
  const health = await call('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.databaseMode, 'REMOTE');
  const login = await call('POST', '/api/login', '', { symbol: admin!.symbol, password: admin!.password });
  const token = String(login.json?.token || '');
  assert.ok(token, 'synthetic administrator login succeeded');

  const messageId = fixture.mailFixture!.messageId;
  const created = await call('POST', `/api/mail/messages/${encodeURIComponent(messageId)}/to-note`, token, {});
  assert.equal(created.status, 200, 'seed mail converts into a note');
  const noteId = String(created.json?.note?.id || '');
  assert.ok(noteId, 'server returned this run-created note ID');
  try {
    const read = await call('GET', `/api/notes/${encodeURIComponent(noteId)}`, token);
    assert.equal(read.status, 200);
    const content = String(read.json?.note?.content || '');
    assert.match(content, /Синтетическое письмо для проверки/);
    assert.match(content, /\\\[Изображение\\\]/, 'unsupported images leave an inert Markdown placeholder');
    assert.doesNotMatch(content, /!\[[^\]]*\]\([^)]*(?:fixture\.invalid|\(x\))[^)]*\)/i,
      'created note has no loadable external or relative Markdown image URL');
    assert.doesNotMatch(content, /https?:\/\/fixture\.invalid|!\[[^\]]*\]\(x\)/i);
    assert.match(content, /опасная ссылка/, 'surrounding mail text is preserved');
    console.log('✓ seeded mail-to-note route stores text and an inert image placeholder; no remote or relative image survives');

    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', args: ['--no-sandbox'] });
    try {
      const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
      const browserErrors: string[] = [];
      const unsupportedImageRequests: string[] = [];
      page.on('pageerror', error => browserErrors.push(error.message));
      page.on('console', message => {
        if (message.type() === 'error' && /content security policy|violates the following directive|md-asset|fixture\.invalid/i.test(message.text())) browserErrors.push(message.text());
      });
      page.on('request', request => {
        if (/fixture\.invalid|md-asset:\/\/\/flux:\/\/note\/x/i.test(request.url())) unsupportedImageRequests.push(request.url());
      });
      await loginPage(page, apiUrl.origin, admin!);
      await page.goto(`${apiUrl.origin}/#/notes`, { waitUntil: 'domcontentloaded' });
      const title = `Проверка общего ящика ${fixture.mailFixture!.syntheticSuffix}`;
      const card = page.locator('[data-window-body]').last().locator('div.group', { hasText: title }).first();
      await card.waitFor({ state: 'visible', timeout: 25_000 });
      await card.click();
      const frame = page.locator('iframe[title="Flux Office — Блокнот"]').last().contentFrame();
      const editor = frame.locator('.ProseMirror').first();
      await editor.waitFor({ state: 'visible', timeout: 25_000 });
      await editor.getByText('Синтетическое письмо для проверки.', { exact: true }).waitFor({ state: 'visible', timeout: 25_000 });
      await editor.getByText('Изображение', { exact: false }).first().waitFor({ state: 'visible', timeout: 25_000 });
      assert.deepEqual(unsupportedImageRequests, [], 'opening the note issued no request for the fixture remote or relative image');
      assert.deepEqual(browserErrors, [], `opening the note produced no page, console CSP or md-asset errors: ${JSON.stringify(browserErrors)}`);
      console.log('✓ the API-created note opens in the real Markdown editor without CSP, md-asset, or external image-request errors');
      console.log('Mail-to-Notes image policy: API readback + real editor open PASS (disposable fixture)');
    } finally {
      await browser.close();
    }
  } finally {
    const removed = await call('DELETE', `/api/notes/${encodeURIComponent(noteId)}`, token);
    assert.equal(removed.status, 200, 'cleaned only the note ID created by this test');
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
