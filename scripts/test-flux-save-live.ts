import { testCredentials } from './testCredentials';
/**
 * Живая проверка выгрузки на настоящем сервере (из исходников, одноразовая база) с подменённым
 * мостом windowsFiles: кнопка «Выгрузить события окна» в настройках открывает окно Проводника
 * Flux, а байты, дошедшие до «диска», — журнал окна.
 *
 *   FLUX_API=http://127.0.0.1:3700 FLUX_USER=… FLUX_PASS=… FLUX_CHROME=… tsx scripts/test-flux-save-live.ts
 *   FLUX_SNAP_DIR=/tmp/снимки — снимки окна сохранения (светлая и тёмная темы)
 *
 * Мост — подмена в памяти (как в test-flux-save-dialog-ui.ts); запись на настоящий диск Windows не проверяется.
 */
const BASE = process.env.FLUX_API || 'http://localhost:3000';
const CHROME = process.env.FLUX_CHROME || '/usr/bin/chromium';
const SNAP = process.env.FLUX_SNAP_DIR || '';
const LOGIN = testCredentials();

const BRIDGE = `
(() => {
  const fs = { docs: { dirs: new Set(['Отчёты', 'Проекты']), files: {} } };
  window.__fs = fs; window.__log = [];
  const parent = p => p.split('/').slice(0, -1).join('/');
  const base = p => p.split('/').pop();
  const bad = (code, message) => ({ ok: false, error: { code, message } });
  const entryOf = (rel) => {
    const f = fs.docs;
    if (f.dirs.has(rel)) return { name: base(rel), relativePath: rel, rootId: 'docs', storage: 'windows', kind: 'directory', fileId: 'd:' + rel, size: 0, modifiedAt: '', linked: false };
    if (rel in f.files) return { name: base(rel), relativePath: rel, rootId: 'docs', storage: 'windows', kind: 'file', fileId: 'f:' + rel, size: f.files[rel].length, modifiedAt: '', linked: false };
    return null;
  };
  const view = {};
  window.electron = { windowsFiles: { onChanged: () => () => {}, invoke: async r => {
    window.__log.push(r.action);
    if (r.action === 'roots') return { ok: true, data: [{ id: 'docs', name: 'Документы', kind: 'custom', available: true }] };
    if (r.action === 'viewStateGet') return { ok: true, data: Object.fromEntries(r.keys.filter(k => k in view).map(k => [k, view[k]])) };
    if (r.action === 'viewStateSet') { Object.assign(view, r.entries); return { ok: true, data: { stored: 1 } }; }
    if (r.action === 'resolveAddress') return { ok: true, data: null };
    if (r.action === 'list') {
      const rel = r.ref.relativePath;
      const kids = [...fs.docs.dirs, ...Object.keys(fs.docs.files)].filter(p => parent(p) === rel).map(entryOf);
      return { ok: true, data: { entries: kids, nextOffset: null } };
    }
    if (r.action === 'stat') { const e = entryOf(r.ref.relativePath); return e ? { ok: true, data: e } : bad('ENOENT', 'Нет файла.'); }
    if (r.action === 'publish') {
      const rel = (r.parent.relativePath ? r.parent.relativePath + '/' : '') + r.name;
      if (rel in fs.docs.files) return bad('EEXIST', 'Занято.');
      fs.docs.files[rel] = r.base64; return { ok: true, data: { ref: { rootId: 'docs', relativePath: rel } } };
    }
    return bad('UNEXPECTED', 'Unexpected ' + r.action);
  } } };
})();
`;

void (async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  let failed = false;
  const check = (name: string, value: boolean, details?: unknown) => { if (value) console.log(`✓ ${name}`); else { failed = true; console.error(`✗ ${name}`, details === undefined ? '' : JSON.stringify(details).slice(0, 300)); } };
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript({ content: BRIDGE });
    await page.route('**/api/license/status', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ licensed: true, machineId: 'TEST', expiresAt: Date.now() + 9e8, daysLeft: 30, reason: '' }) }));
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6500);
    const inputs = await page.$$('input');
    await inputs[0].fill(LOGIN.symbol);
    await inputs[1].fill(LOGIN.password);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(8000);
    check('вход выполнен', await page.evaluate(() => !!document.querySelector('[data-taskbar]')));

    // «Выгрузить события окна» — настоящая кнопка программы (раздел «Ошибки и сбои» в настройках)
    await page.evaluate(() => { window.location.hash = '#/settings'; });
    await page.waitForTimeout(4000);
    await page.getByText('Ошибки и сбои', { exact: true }).first().click();
    await page.getByRole('button', { name: 'Выгрузить события окна' }).click();
    const dialog = page.getByRole('dialog', { name: 'Сохранить в Проводнике Flux' });
    await dialog.waitFor({ timeout: 10000 });
    const proposed = await dialog.getByLabel('Имя файла').inputValue();
    check('вместо системного окна открылось окно Проводника Flux с именем файла', /^flux-diagnostics-\d+\.jsonl$/.test(proposed), proposed);
    await dialog.getByRole('button', { name: 'Отчёты' }).click();
    await dialog.getByText('В этой папке пока ничего нет.').waitFor();
    if (SNAP) {
      await page.screenshot({ path: `${SNAP}/live-save-light.png` });
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${SNAP}/live-save-dark.png` });
      await page.evaluate(() => document.documentElement.classList.remove('dark'));
      await page.waitForTimeout(500);
    }
    await dialog.getByRole('button', { name: 'Сохранить' }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.getByText(`Сохранено: Документы\\Отчёты\\${proposed}`).first().waitFor({ timeout: 5000 });
    check('человеку сказано, куда лёг файл', true);
    const written = await page.evaluate((name) => (window as any).__fs.docs.files['Отчёты/' + name] as string | undefined, proposed);
    const text = written ? Buffer.from(written, 'base64').toString('utf8') : '';
    check('на «диск» дошёл журнал окна: первая строка — заголовок с примечанием', text.startsWith('{"note":"Последние события этого окна'), text.slice(0, 80));
    check('запись шла командой publish, без черновика', await page.evaluate(() => (window as any).__log.includes('publish') && !(window as any).__log.includes('createDraft')));
    check('в окне нет ошибок браузера', errors.length === 0, errors);
  } finally { await browser.close(); }
  if (failed) process.exit(1);
})();
