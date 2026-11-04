/**
 * Запуск: сервер на порту PORT с одноразовой базой (VENT_APP_DATA=/tmp/office-stale/data, FLUX_TEST_LICENSE=1,
 * FLUX_TEST_LICENSE_AUTO=1, DISABLE_HMR=true), затем FLUX_CHROME=… tsx scripts/__office-stale-live.ts; снимки — в OUT.
 * Черновик живого прогона «Обновить» с предпросмотром (решение 4.11.2026).
 * Сервер поднят отдельно (порт PORT), база одноразовая; Sheets — настоящий редактор.
 */
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import JSZip from 'jszip';
import { chromium } from 'playwright-core';
import { makeXlsx, loginPage } from './officeHarness';
import { writeOfficeBindings, officeRowMarker, type OfficePackageBindings } from '../server/officeBindings';

const PORT = process.env.PORT || '3517';
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.OUT || '/tmp/office-stale';
const DB = '/tmp/office-stale/data/database.sqlite';
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => { if (ok) console.log('  ok', name); else { failures++; console.error('  FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600)); } };
let token = '';
const api = async (method: string, route: string, body?: unknown) => {
  const r = await fetch(BASE + route, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const bytes = Buffer.from(await r.arrayBuffer()); let json: any = null; try { json = JSON.parse(bytes.toString('utf8')); } catch { /* binary */ }
  return { status: r.status, json, bytes };
};
const waitFor = async (probe: () => Promise<boolean>, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await probe().catch(() => false)) return true; await wait(300); } return probe().catch(() => false); };

const specs = (v: number | null) => JSON.stringify({ groups: v === null ? [] : [{ title: 'Аэродинамика', params: [{ key: 'Расход воздуха', value: String(v), unit: 'м³/ч' }] }] });
const FIELD = 'param:Аэродинамика|Расход воздуха';

async function main() {
  const db = new Database(DB);
  const stamp = crypto.randomBytes(4).toString('hex'), now = new Date().toISOString();
  const salt = crypto.randomBytes(16);
  const password = 'pw' + stamp;
  const hash = `scrypt$${salt.toString('hex')}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
  const symbol = `GA${stamp}`, userId = `u_${stamp}`, projectId = `p_${stamp}`, sys = `s_${stamp}`, mono = `m_${stamp}`;
  db.prepare('INSERT INTO User (id, symbol, password, name, role, isActive, createdAt) VALUES (?, ?, ?, ?, ?, 1, ?)').run(userId, symbol, hash, 'Проверка', 'ADMIN', now);
  db.prepare('INSERT INTO Project (id, name, createdAt) VALUES (?, ?, ?)').run(projectId, `Проект ${stamp}`, now);
  db.prepare('INSERT INTO ProjectMember (id, projectId, userId, addedBy, addedAt) VALUES (?, ?, ?, ?, ?)').run(`pm_${stamp}`, projectId, userId, userId, now);
  db.prepare('INSERT INTO EquipmentSystem (id, name, projectId, category, createdAt) VALUES (?, ?, ?, ?, ?)').run(sys, 'П1', projectId, 'AHU', now);
  db.prepare('INSERT INTO Monoblock (id, name, systemId, createdAt) VALUES (?, ?, ?, ?)').run(mono, 'МБ-1', sys, now);
  const ins = db.prepare('INSERT INTO ComponentElement (id, name, itemCode, monoblockId, specs, equipType, status, hasConflict, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)');
  const fans: Array<[string, string, number]> = [['fan_a', 'FAN_A', 900], ['fan_b', 'FAN_B', 1200], ['fan_c', 'FAN_C', 1000]];
  for (const [id, name, v] of fans) ins.run(`${id}_${stamp}`, name, name, mono, specs(v), 'ВЕНТИЛЯТОР', 'OK', now, now);

  const login = await api('POST', '/api/login', { symbol, password });
  token = String(login.json?.token || '');
  check('вход', !!token, login.json);
  const q = await api('GET', `/api/project-data/office/query?projectId=${projectId}&entity=element&columns=name,${encodeURIComponent(FIELD)}&limit=50`);
  const rows: Array<{ entityId: string; values: any }> = q.json?.rows || [];
  const ids = Object.fromEntries(fans.map(([, name]) => [name, rows.find((r) => r.values?.name?.value === name)?.entityId]));
  check('позиции в источнике', Object.values(ids).every(Boolean), q.json);

  // Книга «заполнена Flux»: имя и расход по трём позициям, схема и имена строк на месте
  const A = '0b1b8a50-7777-4a4a-8a8a-aaaaaaaaaaa1', B = '0b1b8a50-7777-4a4a-8a8a-aaaaaaaaaaa2';
  const bind = (fieldKey: string, anchorId: string, unit?: string) => ({ fieldKey, sourceId: 'equipment', entityType: 'element', entityId: null, sourceRevision: 'R1', anchorId, ...(unit ? { unit } : {}) });
  const order = fans.map(([, name]) => name);
  const schema: OfficePackageBindings = {
    version: 1, schemaVersion: 1, sourceRevision: 'R1',
    anchors: [
      { id: A, kind: 'excel-range', sheet: 'Перечень', address: 'A1', parts: [{ kind: 'field', binding: bind('name', A) }] },
      { id: B, kind: 'excel-range', sheet: 'Перечень', address: 'B1', parts: [{ kind: 'field', binding: bind(FIELD, B, 'м³/ч') }] },
    ],
    rows: order.map((name, i) => ({ entityId: ids[name], entityType: 'element', sourceId: 'equipment', sourceRevision: 'R1', anchorIds: [A, B], cells: { [A]: `A${i + 2}`, [B]: `B${i + 2}` }, values: { [A]: name, [B]: String(fans[i]![2]) } })),
  };
  const zip = await JSZip.loadAsync(await makeXlsx());
  const names = `<definedName name="FLUX_ANCHOR_${A.replaceAll('-', '_')}">'Перечень'!$A$1</definedName><definedName name="FLUX_ANCHOR_${B.replaceAll('-', '_')}">'Перечень'!$B$1</definedName>` +
    order.map((name, i) => `<definedName name="${officeRowMarker('equipment', 'element', ids[name], 'Перечень')}">'Перечень'!$A$${i + 2}</definedName>`).join('');
  zip.file('xl/workbook.xml', (await zip.file('xl/workbook.xml')!.async('string')).replace('</definedNames>', `${names}</definedNames>`));
  const cells = order.map((name, i) => `<row r="${i + 2}"><c r="A${i + 2}" t="inlineStr"><is><t>${name}</t></is></c><c r="B${i + 2}"><v>${fans[i]![2]}</v></c></row>`).join('');
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Позиция</t></is></c><c r="B1" t="inlineStr"><is><t>Расход воздуха</t></is></c></row>${cells}</sheetData></worksheet>`);
  const bytes = await writeOfficeBindings(await zip.generateAsync({ type: 'nodebuffer' }), schema);

  const folder = await api('POST', '/api/folders', { name: `__stale_${stamp}`, projectId });
  const folderId = String(folder.json?.folder?.id || '');
  const name = `__stale_${stamp}.xlsx`;
  const made = await api('POST', '/api/files', { name, type: 'XLSX', folderId, filePath: `/shared/${name}` });
  const fileId = String(made.json?.file?.id || '');
  await api('POST', `/api/files/${fileId}/chunk`, { idx: 0, data: bytes.toString('base64') });
  check('файл загружен', (await api('POST', `/api/files/${fileId}/done`, { count: 1 })).status === 200);
  const changes = async () => (await api('GET', `/api/project-data/files/${fileId}/changes`)).json;
  const c0 = await changes();
  check('документ актуален до правок', c0?.stale === false && c0?.rows === 3, c0);

  // Данные меняются: расход B другой, у A значение пропало, C снята
  db.prepare('UPDATE ComponentElement SET specs = ?, version = version + 1, updatedAt = ? WHERE id = ?').run(specs(1500), now, `fan_b_${stamp}`);
  db.prepare('UPDATE ComponentElement SET specs = ?, version = version + 1, updatedAt = ? WHERE id = ?').run(specs(null), now, `fan_a_${stamp}`);
  db.prepare('DELETE FROM ComponentElement WHERE id = ?').run(`fan_c_${stamp}`);
  const c1 = await changes();
  check('сервер видит три расхождения', c1?.count === 3, c1?.changes?.map((c: any) => [c.kind, c.entityLabel]));

  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const cell = (page: any, address: string) => page.frameLocator('iframe[title="Flux Office — Таблица"]').locator('body').evaluate((_b: HTMLElement, a: string) => {
    const sheet = (window as any).__fluxSheets?.univerRef?.current?.univerAPI?.getActiveWorkbook?.()?.getSheets?.().find((x: any) => x.getSheetName() === 'Перечень');
    return sheet ? String(sheet.getRange(a)?.getValues?.()?.[0]?.[0] ?? '') : undefined;
  }, address).catch(() => undefined);
  for (const theme of ['light', 'dark'] as const) {
    if (theme === 'dark') { // документ после отмены снова «устарел» — тот же путь во второй теме; данные уже те же
      await api('GET', `/api/project-data/files/${fileId}/changes`);
    }
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const page = await context.newPage();
    const errors: string[] = []; page.on('pageerror', (e) => errors.push(String(e)));
    await loginPage(page, BASE, { symbol, password }, theme === 'dark');
    if (theme === 'dark') await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.goto(`${BASE}/#/office-sheet?file=${encodeURIComponent(fileId)}`, { waitUntil: 'domcontentloaded' });
    const bar = page.getByTestId('flux-stale-bar');
    check(`[${theme}] полоса «устарело» появилась`, await waitFor(() => bar.isVisible(), 60000));
    await page.screenshot({ path: `${OUT}/${theme}-1-bar.png` });
    check(`[${theme}] в полосе 3 значения`, /устарело 3 значения/.test(await bar.innerText().catch(() => '')), await bar.innerText().catch(() => ''));
    await bar.getByRole('button', { name: 'Обновить' }).click();
    const panel = page.getByRole('complementary', { name: 'Flux Office' });
    const preview = panel.getByTestId('flux-refresh-preview');
    check(`[${theme}] предпросмотр открылся`, await waitFor(() => preview.isVisible(), 30000));
    const text = await preview.innerText().catch(() => '');
    check(`[${theme}] группы и «было → станет»`, /Значения изменятся/.test(text) && /1200 → 1500 м³\/ч/.test(text) && /Значение пропало/.test(text) && /900 → пусто/.test(text) && /Позиция снята/.test(text), text);
    check(`[${theme}] галочки по умолчанию стоят`, await preview.locator('input[type=checkbox]:checked').count() === 3);
    await preview.scrollIntoViewIfNeeded().catch(() => {});
    await page.screenshot({ path: `${OUT}/${theme}-2-preview.png` });
    await panel.getByRole('button', { name: 'Применить отмеченное' }).click();
    check(`[${theme}] применено, полоса ушла`, await waitFor(async () => !(await bar.isVisible()) && /Помечено строк снятых позиций: 1/.test(await panel.innerText()), 40000));
    const after = await changes();
    check(`[${theme}] сервер: не устарело, строка помечена`, after?.stale === false && after.changes.some((c: any) => c.kind === 'row-removed' && c.marked), after);
    const sheetXml = async () => { const z = await JSZip.loadAsync((await api('GET', `/api/files/${fileId}/raw`)).bytes); return z.file('xl/worksheets/sheet1.xml')!.async('string'); };
    await page.keyboard.press('Control+s');
    await wait(3000);
    await page.screenshot({ path: `${OUT}/${theme}-3-applied.png` });
    check(`[${theme}] в ячейках: B2 пусто, B3 1500, B4 осталась`, await cell(page, 'B2') === '' && await cell(page, 'B3') === '1500' && await cell(page, 'B4') === '1000', [await cell(page, 'B2'), await cell(page, 'B3'), await cell(page, 'B4')]);
    const undo = panel.getByRole('button', { name: 'Отменить обновление' });
    check(`[${theme}] кнопка отмены есть`, await undo.isVisible());
    await undo.click();
    check(`[${theme}] после отмены полоса вернулась`, await waitFor(() => bar.isVisible(), 40000));
    const undone = await changes();
    check(`[${theme}] сервер после отмены: снова 3 расхождения`, undone?.count === 3, undone?.changes?.map((c: any) => [c.kind, c.was, c.now, c.marked]));
    check(`[${theme}] в ячейках после отмены: 900, 1200, 1000`, await cell(page, 'B2') === '900' && await cell(page, 'B3') === '1200' && await cell(page, 'B4') === '1000', [await cell(page, 'B2'), await cell(page, 'B3'), await cell(page, 'B4')]);
    await page.screenshot({ path: `${OUT}/${theme}-4-undone.png` });
    check(`[${theme}] ошибок страницы нет`, errors.length === 0, errors);
    void sheetXml;
    await context.close();
  }
  await browser.close();
  console.log(failures ? `ПРОВАЛОВ: ${failures}` : 'всё прошло');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
