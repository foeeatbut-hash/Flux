/** Diagnostic reproduction of Explorer -> Office open flow with browser errors and screenshots. */
import { existsSync, readFileSync } from 'node:fs';
import { makeDocx, loginPage } from './officeHarness';

const fixturePath = process.env.FLUX_REMAINING_LIVE_METADATA || '/tmp/flux-remaining-live.json';
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const fixtureOrigin = String(fixture.servers?.find((entry: any) => entry.index === 1)?.origin || '');
const fixtureAdmin = fixture.accounts?.[0];
const BASE = process.env.FLUX_API || fixtureOrigin;
const ADMIN = { symbol: process.env.FLUX_USER || String(fixtureAdmin?.symbol || ''), password: process.env.FLUX_PASS || String(fixtureAdmin?.password || '') };
const CHROME = process.env.FLUX_CHROME || '/usr/bin/chromium';
const api = async (method: string, url: string, token: string, body?: any) => {
  const response = await fetch(BASE + url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  try { return { status: response.status, json: JSON.parse(text) }; } catch { return { status: response.status, json: text }; }
};

async function main() {
  if (process.env.FLUX_TEST_FIXTURE !== '1') throw new Error('Refusing browser mutation without FLUX_TEST_FIXTURE=1');
  if (fixture.kind !== 'flux-remaining-live-fixture' || !/^flux_[a-z0-9_]+_fixture(?:_|$)/.test(fixture.databaseName)) throw new Error('Unexpected disposable fixture metadata');
  const configured = new URL(BASE), expectedBase = new URL(fixture.servers.find((entry: any) => entry.index === 1)?.origin || '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(configured.hostname) || configured.origin !== expectedBase.origin) throw new Error('Explorer debug is restricted to fixture server 1 loopback origin');
  if (ADMIN.symbol !== fixture.accounts[0]?.symbol || ADMIN.password !== fixture.accounts[0]?.password) throw new Error('Credentials do not match the synthetic fixture administrator');
  if (!existsSync('public/genoffice/docs/index.html')) throw new Error('GenOffice Docs bundle is missing');
  const { chromium } = await import('playwright-core');
  const login = await api('POST', '/api/login', '', ADMIN);
  const token = String(login.json?.token || '');
  if (!token) throw new Error(`synthetic fixture login failed: HTTP ${login.status}`);
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const name = `__files_explorer_debug_${stamp}.docx`;
  const created = await api('POST', '/api/files', token, { name, filePath: `/shared/${name}`, type: 'DOCX' });
  const id = String(created.json?.file?.id || '');
  if (!id) throw new Error(`synthetic DOCX creation failed: HTTP ${created.status}`);
  const cleanup = async () => { await api('DELETE', `/api/files/${id}`, token).catch(() => undefined); };
  await api('POST', `/api/files/${id}/chunk`, token, { idx: 0, data: (await makeDocx()).toString('base64') });
  await api('POST', `/api/files/${id}/done`, token, { count: 1 });

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const browserErrors: string[] = [], failedRequests: string[] = [];
    page.on('pageerror', error => browserErrors.push(`pageerror: ${error.message}\n${error.stack || ''}`));
    page.on('console', message => { if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`); });
    page.on('requestfailed', request => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`));
    await loginPage(page, BASE, ADMIN);
    await page.goto(`${BASE}/#/explorer`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await page.getByText('Общий', { exact: true }).first().click();
    await page.waitForTimeout(1200);
    console.log('before-open', JSON.stringify({ url: page.url(), winCount: await page.locator('[data-win]').count(), matchingNameCount: await page.getByText(name, { exact: true }).count() }));
    await page.getByText(name, { exact: true }).first().dblclick();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `/tmp/flux-files-explorer-open-${stamp}-office.png`, fullPage: true });
    console.log('after-double-click', JSON.stringify({ url: page.url(), winCount: await page.locator('[data-win]').count(), matchingNameCount: await page.getByText(name, { exact: true }).count(), fileSelectedLabel: await page.getByText('Файл не выбран').count() }));

    await page.goto(`${BASE}/#/explorer?file=${encodeURIComponent(id)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    await page.screenshot({ path: `/tmp/flux-files-explorer-open-${stamp}-deep-link.png`, fullPage: true });
    console.log('after-explorer-deep-link', JSON.stringify({ url: page.url(), winCount: await page.locator('[data-win]').count(), matchingNameCount: await page.getByText(name, { exact: true }).count(), visibleMatchingNames: await page.getByText(name, { exact: true }).evaluateAll(elements => elements.map(element => ({ visible: !!(element as HTMLElement).offsetParent, text: element.textContent, tag: element.tagName, cls: (element as HTMLElement).className }))), fileSelectedLabel: await page.getByText('Файл не выбран').count(), bodyExcerpt: (await page.locator('body').innerText()).slice(0, 1600) }));
    console.log('browser-errors', JSON.stringify(browserErrors.slice(0, 30)));
    console.log('failed-requests', JSON.stringify(failedRequests.slice(0, 30)));
    console.log('screenshots', `/tmp/flux-files-explorer-open-${stamp}-office.png`, `/tmp/flux-files-explorer-open-${stamp}-deep-link.png`);
  } finally {
    await browser.close();
    await cleanup();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
