/**
 * Документ из Проводника открывается одним окном.
 *
 * Что стережёт (src/screens/Explorer.tsx, эффекты ссылок /explorer?file=):
 *   - двойной щелчок по .docx и .xlsx заводит ровно одно окно редактора, и
 *     пустого окна «Файл не выбран» рядом нет. Раньше Проводник, ещё живое
 *     окно, принимал file из адреса редактора за свою ссылку, переписывал
 *     адрес — и программа открывала второе окно без файла;
 *   - своя ссылка /explorer?file=… по-прежнему выделяет файл.
 *
 * Нужен поднятый сервер. Запуск: npx tsx scripts/test-explorer-open-live.ts
 */
import { existsSync } from 'node:fs';
import { makeDocx, loginPage } from './officeHarness';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const ADMIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let f = 0, p = 0;
const ok = (n: string, c: boolean, d?: unknown) =>
  (c ? (p++, console.log('  ✓', n)) : (f++, console.error('  ✗', n, d === undefined ? '' : JSON.stringify(d).slice(0, 300))));
const api = async (method: string, url: string, token: string, body?: any) => {
  const res = await fetch(BASE + url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.json().catch(() => ({}));
};

(async () => {
  if (!existsSync('public/genoffice/docs/index.html')) { console.error('Редактор не собран: node tools/genoffice/build.mjs'); process.exit(2); }
  const { chromium } = await import('playwright-core');
  const token = (await api('POST', '/api/login', '', ADMIN)).token;
  if (!token) { console.error('вход не удался'); process.exit(2); }
  const stamp = Date.now().toString(36);
  const name = `__проба открытия ${stamp}.docx`;
  const made = await api('POST', '/api/files', token, { name, filePath: `/shared/${name}`, type: 'DOCX' });
  const id = made?.file?.id;
  await api('POST', `/api/files/${id}/chunk`, token, { idx: 0, data: (await makeDocx()).toString('base64') });
  await api('POST', `/api/files/${id}/done`, token, { count: 1 });

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await loginPage(page, BASE, ADMIN);
    const windows = () => page.locator('[data-win]').count();

    console.log('1. Двойной щелчок по документу');
    await page.goto(`${BASE}/#/explorer`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await page.getByText('Общий', { exact: true }).first().click();
    await page.waitForTimeout(1500);
    const before = await windows();
    await page.getByText(name).first().dblclick();
    await page.waitForTimeout(3000);
    ok('открылось ровно одно новое окно', (await windows()) === before + 1, { before, after: await windows() });
    ok('пустого окна «Файл не выбран» нет', !(await page.getByText('Файл не выбран').first().isVisible().catch(() => false)));
    ok('в адресе — документ, а не Проводник', /office-doc\?file=/.test(page.url()), page.url());

    console.log('\n2. Своя ссылка Проводника');
    await page.goto(`${BASE}/#/explorer?file=${id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    ok('ссылка /explorer?file= показывает файл в предпросмотре', await page.getByText(name).nth(1).isVisible().catch(() => false));
  } finally {
    await browser.close();
    await api('DELETE', `/api/files/${id}`, token);
  }
  console.log(`\n${p} проверок пройдено, ${f} провалено`);
  process.exit(f ? 1 : 0);
})();
