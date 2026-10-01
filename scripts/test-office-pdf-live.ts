import { testCredentials } from './testCredentials';
/**
 * PDF Flux Office: открыть PDF, сохранить пометку в копию и в исходник.
 *
 * Что стережёт (src/screens/OfficeAppHost.tsx, server/officeHostApps.ts,
 * tools/genoffice/shims/*):
 *   - PDF открывается в редакторе GenOffice внутри окна Flux, текст виден;
 *   - ни ИИ, ни имени Genspark на экране;
 *   - Ctrl+Shift+S из редактора открывает родное окно «Сохранить копию PDF»;
 *   - копия получает пометку, исходник до Ctrl+S не меняется, отмена не создаёт файл;
 *   - выделение и Ctrl+S пишут пометку в сам файл Flux (главный процесс
 *     GenOffice работает на сервере);
 *   - прежнее содержимое лежит в откате;
 *   - закрытие окна убирает окно редактора на сервере;
 *   - ни одного запроса за пределы сервера Flux.
 *
 * Нужны поднятый сервер и собранный редактор (node tools/genoffice/build.mjs pdf).
 * Запуск: npx tsx scripts/test-office-pdf-live.ts
 */
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { makePdf, loginPage } from './officeHarness';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = testCredentials();
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let f = 0;
const ok = (n: string, c: boolean, d?: unknown) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d === undefined ? '' : JSON.stringify(d).slice(0, 300))));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
let token = '';
const call = async (method: string, url: string, body?: any) => {
  const res = await fetch(BASE + url, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* байты */ }
  return { status: res.status, json, buf };
};
const until = async (probe: () => Promise<boolean>, ms: number) => {
  for (let t = 0; t < ms; t += 300) { if (await probe()) return true; await new Promise((r) => setTimeout(r, 300)); }
  return probe();
};

(async () => {
  if (!existsSync('public/genoffice/pdf/index.html') || !existsSync('genoffice-server/pdf.cjs')) {
    console.error('PDF не собран: node tools/genoffice/build.mjs pdf'); process.exit(2);
  }
  let chromium: any;
  try { ({ chromium } = await import('playwright-core')); } catch { console.error('нет playwright-core'); process.exit(2); }
  token = (await call('POST', '/api/login', LOGIN)).json?.token || '';
  const name = `__проба pdf ${Date.now().toString(36)}.pdf`;
  const stamp = name.replace(/[^a-z0-9]+/gi, '-').replace(/-+$/, '');
  const copyName = `__проба pdf ${stamp} (копия).pdf`;
  const canceledName = `__проба pdf ${stamp} (отмена).pdf`;
  const ownedNames = new Set([name, copyName, canceledName]);
  const createdIds = new Set<string>();
  const id = (await call('POST', '/api/files', { name, filePath: `/shared/${name}`, type: 'PDF' })).json?.file?.id;
  const original = makePdf(['Flux PDF proba', 'Second line of the blank']);
  const originalHash = sha(original);
  await call('POST', `/api/files/${id}/chunk`, { idx: 0, data: original.toString('base64') });
  await call('POST', `/api/files/${id}/done`, { count: 1 });
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    const outside: string[] = [];
    page.on('request', (r: any) => {
      const u = String(r.url());
      if (!u.startsWith(BASE) && !u.startsWith('blob:') && !u.startsWith('data:') && !u.startsWith('ws://localhost')) outside.push(u);
    });
    await loginPage(page, BASE, LOGIN, process.env.THEME === 'dark');

    console.log('1. Открытие');
    await page.goto(`${BASE}/#/pdf?file=${id}`, { waitUntil: 'domcontentloaded' });
    const fr = page.frameLocator('iframe[title="Flux Office — PDF"]');
    const line = fr.locator('.textLayer span', { hasText: 'Flux PDF proba' }).first();
    ok('текст PDF виден', await line.waitFor({ timeout: 30000 }).then(() => true).catch(() => false));
    ok('«Открывается…» ушло', await until(async () => !(await page.getByText('Открывается…').isVisible().catch(() => false)), 10000));
    const body = await fr.locator('body').innerText().catch(() => '');
    ok('имени Genspark на экране нет', !/genspark/i.test(body), body.match(/.{0,30}genspark.{0,30}/i)?.[0]);
    ok('интерфейс по-русски', /Выделение|Аннотирование/.test(body));

    console.log('\n2. Пометка и Ctrl+S');
    await line.click({ clickCount: 3 });
    await fr.getByText('Выделение', { exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(800);

    console.log('\n3. Сохранение пометки копией');
    await fr.locator('body').press('Control+Shift+s');
    const saveAs = page.getByRole('dialog', { name: 'Сохранить копию PDF' });
    ok('Ctrl+Shift+S из iframe открыл родное окно копии', await saveAs.waitFor({ timeout: 10000 }).then(() => true).catch(() => false));
    if (await saveAs.isVisible().catch(() => false)) {
      await saveAs.getByRole('textbox').fill(copyName);
      await saveAs.getByRole('button', { name: 'Сохранить', exact: true }).click();
    }
    const findOwnedFile = async (wanted: string) => {
      const tree = await call('GET', '/api/projects/default/folders?actorId=');
      const rows = [
        ...(tree.json?.rootFiles || []),
        ...(tree.json?.folders || []).flatMap((folder: any) => folder.files || []),
      ];
      return rows.find((file: any) => String(file.name) === wanted) || null;
    };
    let savedCopy: any = null;
    for (let i = 0; i < 30 && !savedCopy; i++) {
      await page.waitForTimeout(300);
      savedCopy = await findOwnedFile(copyName);
    }
    ok('новая копия появилась в списке файлов проекта', !!savedCopy?.id, savedCopy);
    if (savedCopy?.id) {
      createdIds.add(String(savedCopy.id));
      const copyBytes = await call('GET', `/api/files/${savedCopy.id}/raw`);
      ok('копия содержит пометку Highlight', copyBytes.buf.includes('/Highlight'));
    }
    const untouched = await call('GET', `/api/files/${id}/raw`);
    ok('до Ctrl+S исходный PDF остался байт в байт прежним', sha(untouched.buf) === originalHash, sha(untouched.buf));

    console.log('\n4. Отмена сохранения копии');
    await fr.locator('body').press('Control+Shift+s');
    const cancelPrompt = page.getByRole('dialog', { name: 'Сохранить копию PDF' });
    const cancelOpened = await cancelPrompt.waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
    ok('повторное Ctrl+Shift+S снова открыло окно копии', cancelOpened);
    if (cancelOpened) {
      await cancelPrompt.getByRole('textbox').fill(canceledName);
      await cancelPrompt.getByRole('button', { name: 'Отмена', exact: true }).click();
    }
    await page.waitForTimeout(1200);
    ok('отмена не создала файл', !(await findOwnedFile(canceledName)));

    console.log('\n5. Сохранение исходника');
    await page.keyboard.press('Control+s');
    const saved = await until(async () => (await call('GET', `/api/files/${id}/raw`)).buf.includes('/Highlight'), 20000);
    ok('пометка записана в сам файл', saved);
    const versions = await call('GET', `/api/office/files/${id}/versions`);
    ok('прежнее содержимое — в откате', versions.json?.versions?.[0]?.sha256 === sha(original), versions.json);

    console.log('\n6. Закрытие');
    // Все окна PDF по очереди (прежнее окно рабочий стол мог восстановить)
    for (let i = 0; i < 3 && await page.locator('iframe[title="Flux Office — PDF"]').count(); i++) {
      await page.getByRole('button', { name: 'Закрыть' }).last().click();
      await page.waitForTimeout(1500);
    }
    ok('окно закрылось, ничего не потеряв', await until(async () => !(await page.locator('iframe[title="Flux Office — PDF"]').count()), 10000));
    ok('ни одного запроса за пределы сервера Flux', outside.length === 0, outside.slice(0, 5));
    await page.screenshot({ path: process.env.OUT || '/tmp/office-pdf.png' }).catch(() => {});
  } catch (e: any) {
    ok('проба оборвалась', false, String(e?.message || e));
  } finally {
    await browser.close();
    const tree = await call('GET', '/api/projects/default/folders?actorId=').catch(() => null as any);
    const rows = [
      ...(tree?.json?.rootFiles || []),
      ...(tree?.json?.folders || []).flatMap((folder: any) => folder.files || []),
    ];
    for (const file of rows) if (ownedNames.has(String(file.name)) && file.id) createdIds.add(String(file.id));
    for (const createdId of createdIds) await call('DELETE', `/api/files/${createdId}`).catch(() => {});
    await call('DELETE', `/api/files/${id}`).catch(() => {});
  }
  console.log(f ? `\nПРОВАЛОВ: ${f}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
  process.exit(f ? 1 : 0);
})();
