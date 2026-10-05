/** Real Markdown editor keyboard append and full-content autosave on a disposable API fixture. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loginPage } from './officeHarness';

type Fixture = { kind: string; databaseName: string; servers: { index: number; origin: string }[]; accounts: { symbol: string; password: string; role: string }[] };
const fixture = JSON.parse(readFileSync(process.env.FLUX_REMAINING_LIVE_METADATA || '/tmp/flux-remaining-live.json', 'utf8')) as Fixture;
assert.equal(process.env.FLUX_TEST_FIXTURE, '1', 'refusing live mutation without explicit fixture marker');
assert.equal(fixture.kind, 'flux-remaining-live-fixture');
assert.match(fixture.databaseName, /^flux_[a-z0-9_]+_fixture(?:_|$)/);
const origin = fixture.servers.find(server => server.index === 1)?.origin;
assert.ok(origin, 'loopback API fixture server 1 is configured');
const base = new URL(origin);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'fixture API host is loopback');
const BASE = base.origin;
const ADMIN = fixture.accounts[0];
assert.equal(ADMIN.role, 'ADMIN');
const FRAME = 'iframe[title="Flux Office — Блокнот"]';

type Reply = { status: number; json: any; bytes: Buffer };
async function call(method: string, path: string, token = '', body?: unknown): Promise<Reply> {
  const raw = body instanceof Uint8Array;
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(raw ? { 'Content-Type': 'application/octet-stream' } : body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: raw ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(bytes.toString('utf8')); } catch { /* raw file content */ }
  return { status: response.status, json, bytes };
}

async function main() {
  const health = await call('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json?.databaseMode, 'REMOTE');
  const login = await call('POST', '/api/login', '', { symbol: ADMIN.symbol, password: ADMIN.password });
  const token = String(login.json?.token || '');
  assert.ok(token, 'synthetic fixture administrator login');

  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const name = `__files_notes_markdown_${stamp}.md`;
  const original = '# Записка\n\nПервая строка.\n';
  const create = await call('POST', `/api/office/files/new?name=${encodeURIComponent(name)}&where=desk`, token, new TextEncoder().encode(original));
  const fileId = String(create.json?.id || '');
  assert.equal(create.status, 200, `synthetic Markdown file creation returned HTTP ${create.status}`);
  assert.ok(fileId, 'synthetic Markdown file ID returned');
  let browser: any;
  try {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', args: ['--no-sandbox'] });
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await loginPage(page, BASE, { symbol: ADMIN.symbol, password: ADMIN.password });
    await page.goto(`${BASE}/#/notes?file=${encodeURIComponent(fileId)}`, { waitUntil: 'domcontentloaded' });
    const frame = () => page.locator(FRAME).last().contentFrame();
    const editor = frame().locator('.ProseMirror').first();
    await editor.waitFor({ state: 'visible', timeout: 25_000 });
    await editor.getByRole('heading', { name: 'Записка' }).waitFor({ state: 'visible', timeout: 25_000 });
    await editor.getByText('Первая строка.', { exact: true }).waitFor({ state: 'visible', timeout: 25_000 });

    // Use the editable document itself as the keyboard target. This keeps the
    // caret command and text entry inside the iframe's focused editor.
    await editor.press('Control+End');
    await editor.press('Enter');
    await editor.pressSequentially('Вторая строка', { delay: 15 });

    const expected = /# Записка[\s\S]*Первая строка\.[\s\S]*Вторая строка/;
    let persisted = '';
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      persisted = (await call('GET', `/api/files/${encodeURIComponent(fileId)}/raw`, token)).bytes.toString('utf8');
      if (expected.test(persisted)) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.match(persisted, expected, `saved Markdown retains the original line and appends the complete new line; got ${JSON.stringify(persisted)}`);
    const versions = await call('GET', `/api/office/files/${encodeURIComponent(fileId)}/versions`, token);
    assert.equal(versions.status, 200);
    assert.ok((versions.json?.versions || []).length >= 1, 'successful full-content save created a recoverable version');
    await page.reload({ waitUntil: 'domcontentloaded' });
    const reopened = page.locator(FRAME).last().contentFrame().locator('.ProseMirror').first();
    await reopened.getByRole('heading', { name: 'Записка' }).waitFor({ state: 'visible', timeout: 25_000 });
    await reopened.getByText('Первая строка.', { exact: true }).waitFor({ state: 'visible', timeout: 25_000 });
    await reopened.getByText('Вторая строка', { exact: true }).waitFor({ state: 'visible', timeout: 25_000 });
    if (pageErrors.length) console.log('browser page errors:', JSON.stringify(pageErrors));
    console.log('✓ valid iframe keyboard append preserves old Markdown and persists the complete new line');
    console.log('✓ full-content save keeps a recoverable prior version');
    console.log('✓ re-opening the file restores both the original and appended lines');
    console.log('Notes Markdown editor: 3 checks PASS (disposable live fixture)');
  } finally {
    await browser?.close();
    await call('DELETE', `/api/files/${encodeURIComponent(fileId)}`, token).catch(() => undefined);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
