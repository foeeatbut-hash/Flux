import { testCredentials } from './testCredentials';
/**
 * Шаблон шапки между двумя сотрудниками — вживую, в окне Таблицы.
 *
 *   А собирает шапку («Тег», «Марка», «Отдел») и записывает шаблон для всех;
 *   Б создаёт свою чистую таблицу, открывает шаблон — те же колонки встают на те же
 *   места без единого уточнения, а значения подтягиваются из проекта и совпадают
 *   со столбцами А построчно; после повторного открытия шапка на месте.
 *
 * Раньше шаблон в чистой книге ждал «выберите ячейку документа», а выбирать было
 * не из чего: ячеек шапки в ней ещё нет.
 *
 * Нужен сервер (FLUX_API, по умолчанию :3000), FLUX_USER/FLUX_PASS администратора и
 * собранный редактор (node tools/genoffice/build.mjs sheets). Запуск:
 *   npx tsx scripts/test-office-template-users-live.ts
 */
import * as XLSX from 'xlsx';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';
const ADMIN = testCredentials();
const stamp = Date.now().toString(36);
/** Второй сотрудник: готовый (FLUX_USER_B/FLUX_PASS_B) или заводится администратором, если у него есть такое право */
const B = process.env.FLUX_USER_B ? { symbol: process.env.FLUX_USER_B, password: String(process.env.FLUX_PASS_B || '') } : { symbol: `tplb${stamp}`.slice(0, 20), password: 'pass12345' };

let failures = 0;
const ok = (name: string, condition: boolean, detail?: unknown) =>
  (condition ? console.log('  ✓', name) : (failures++, console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300))));
const tokens: Record<string, string> = {};
const call = async (who: string, method: string, url: string, body?: any, raw?: Uint8Array) => {
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(tokens[who] ? { Authorization: `Bearer ${tokens[who]}` } : {}), ...(raw ? { 'Content-Type': 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: raw ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* байты */ }
  return { status: res.status, json, buf };
};
const login = async (who: string, creds: { symbol: string; password: string }) => { tokens[who] = (await call(who, 'POST', '/api/login', creds)).json?.token || ''; return !!tokens[who]; };
const blankBook = () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, { '!ref': 'A1' }, 'Лист1');
  return new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
};
const until = async (probe: () => Promise<boolean>, ms: number) => { for (let t = 0; t < ms; t += 500) { if (await probe()) return true; await new Promise((r) => setTimeout(r, 500)); } return probe(); };

/** Окно Таблицы пользователя: вход, файл, панель Flux */
async function openSheet(browser: any, creds: { symbol: string; password: string }, fileId: string) {
  const page = await (await browser.newContext({ viewport: { width: 1700, height: 1000 } })).newPage();
  await page.route('**/api/license/status', (r: any) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ licensed: true, machineId: 'TEST', expiresAt: Date.now() + 9e8, daysLeft: 30, reason: '' }) }));
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  const inputs = await page.$$('input');
  await inputs[0]!.fill(creds.symbol); await inputs[1]!.fill(creds.password);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(6000);
  await page.goto(`${BASE}/#/office-sheet?file=${fileId}`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const frame = page.frameLocator('iframe[title="Flux Office — Таблица"]');
  await frame.locator('body').waitFor({ state: 'visible', timeout: 60000 });
  const ready = await until(() => frame.locator('body').evaluate(() => { const h = (window as any).__fluxSheets; const wb = h?.univerRef?.current?.univerAPI?.getActiveWorkbook?.(); return !!wb && wb.getId() !== 'new-workbook' && !!h?.lazyWorkbookRef?.current; }).catch(() => false), 60000);
  const panelOpen = async () => {
    await frame.locator('body').evaluate(() => window.parent.postMessage({ flux: 'office', op: 'flux:open-panel' }, location.origin));
    const panel = page.getByRole('complementary', { name: 'Flux Office' });
    await panel.waitFor({ timeout: 15000 });
    return panel;
  };
  return { page, frame, ready, panelOpen };
}
const cell = (frame: any, a1: string) => frame.locator('body').evaluate((_b: any, a: string) => (window as any).__fluxSheets?.univerRef?.current?.univerAPI?.getActiveWorkbook?.()?.getActiveSheet?.()?.getRange(a)?.getValues?.()?.[0]?.[0], a1).catch(() => undefined);
async function clickCell(frame: any, a1: string) {
  const box = frame.locator('input.univer-box-border').first();
  await box.fill(a1); await box.press('Enter');
  const point = await frame.locator('body').evaluate((_b: any, a: string) => {
    const sheet = (window as any).__fluxSheets?.univerRef?.current?.univerAPI?.getActiveWorkbook?.()?.getActiveSheet?.();
    const canvas = document.querySelector('canvas[id^="univer-sheet-main-canvas_"]') as HTMLCanvasElement | null;
    const rect = sheet?.getRange(a)?.getCellRect?.(); const bounds = canvas?.getBoundingClientRect();
    return rect && bounds && canvas ? { x: (Number(rect.left) + Number(rect.width) / 2) * bounds.width / canvas.width, y: (Number(rect.top) + Number(rect.height) / 2) * bounds.height / canvas.height } : null;
  }, a1);
  if (!point) throw new Error(`нет ячейки ${a1}`);
  await frame.locator('canvas[id^="univer-sheet-main-canvas_"]').first().click({ position: point });
}
/** Таблица листа «Лист1» как строки «a|b|c» без пустых строк */
const gridOf = async (who: string, fileId: string, width: number) => {
  const wb = XLSX.read((await call(who, 'GET', `/api/files/${fileId}/raw`)).buf, { type: 'buffer' });
  return XLSX.utils.sheet_to_json<any[]>(wb.Sheets['Лист1']!, { header: 1, defval: '' }).map((row) => row.slice(0, width).map(String).join('|')).filter((line) => line.replaceAll('|', '') !== '');
};

(async () => {
  let chromium: any;
  try { ({ chromium } = await import('playwright-core')); } catch { console.error('нет playwright-core'); process.exit(2); }
  const files: string[] = [];
  ok('вход администратора (сотрудник А)', await login('A', ADMIN));
  if (!process.env.FLUX_USER_B) {
    const made = await call('A', 'POST', '/api/users', { symbol: B.symbol, password: B.password, name: 'Борис Проверка', lastName: 'Проверка', firstName: 'Борис', role: 'ENGINEER_VENT' });
    ok('второй сотрудник (Б) заведён', made.status < 300, made.json);
  }
  ok('вход сотрудника Б', await login('B', B));
  const project = (await call('A', 'POST', '/api/projects', { name: `Шаблоны ${stamp}`, code: `TPL-${stamp}` })).json?.project;
  ok('проект создан', !!project?.id, project);
  for (const [i, [tag, brand, dep]] of [['TPL-1', 'Бренд-1', 'ОВ'], ['TPL-2', 'Бренд-2', 'ЭОМ'], ['TPL-3', 'Бренд-3', 'ОВ']].entries()) {
    const t = await call('A', 'POST', `/api/projects/${project.id}/tags`, { identifier: `${tag}-${stamp}`, brand, department: dep });
    ok(`тег ${i + 1} создан`, t.status === 200, t.json);
  }
  // Общий рабочий стол проекта заводится при первой записи файла; документ у каждого свой, но стол общий
  const newFile = async (who: string, name: string) => {
    const r = await call(who, 'POST', `/api/office/files/new?name=${encodeURIComponent(name)}&where=shared&projectId=${encodeURIComponent(project.id)}`, undefined, blankBook());
    if (r.json?.id) files.push(r.json.id);
    return String(r.json?.id || '');
  };
  const fileA = await newFile('A', `Загрузка электриков ${stamp}.xlsx`);
  ok('чистая таблица А создана', !!fileA);

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    console.log('1. А собирает шапку и заполняет таблицу');
    const a = await openSheet(browser, ADMIN, fileA);
    ok('таблица А открылась', a.ready);
    const panelA = await a.panelOpen();
    await a.page.getByRole('button', { name: /2\. Поля и шапка/ }).click();
    const columns: Array<[string, string, string]> = [['A1', 'Теги', 'Тег (идентификатор)'], ['B1', 'Теги', 'Марка'], ['C1', 'Теги', 'Отдел']];
    for (const [address, group, name] of columns) {
      await clickCell(a.frame, address);
      await panelA.getByLabel('Найти поле Flux').fill(name);
      await a.page.waitForTimeout(300);
      const section = panelA.locator('section', { has: a.page.locator('h3', { hasText: group }) }).first();
      await section.getByRole('button', { name: new RegExp(`^${name.replace(/[()]/g, '\\$&')}`) }).first().click();
      await panelA.getByRole('button', { name: 'Привязать поле' }).click();
      ok(`${address} привязана к «${name}»`, await until(async () => (await cell(a.frame, address)) === name, 8000), await cell(a.frame, address));
    }
    await a.page.getByRole('button', { name: /1\. Выборка/ }).click();
    await panelA.getByLabel('Источник данных').selectOption('tags');
    await panelA.getByRole('button', { name: /Обновить выборку/ }).click();
    ok('выборка тегов загружена', await until(async () => (await panelA.getByLabel('Выбрать все строки').count()) > 0 && (await panelA.innerText()).includes(`TPL-1-${stamp}`), 15000));
    await panelA.getByLabel('Выбрать все строки').check();
    await panelA.getByRole('button', { name: /Предпросмотр заполнения/ }).click();
    await panelA.getByRole('button', { name: /Подтвердить и заполнить/ }).click();
    ok('значения легли в таблицу А', await until(async () => String((await cell(a.frame, 'A2')) ?? '').includes(`-${stamp}`), 20000), await cell(a.frame, 'A2'));
    await a.page.keyboard.press('Control+s');
    ok('таблица А записана с тремя строками', await until(async () => (await gridOf('A', fileA, 3)).length === 4, 15000), await gridOf('A', fileA, 3));

    console.log('2. А записывает шаблон для всех');
    const state = (await call('A', 'GET', `/api/project-data/files/${fileA}/office-state`)).json;
    const saved = await call('A', 'POST', '/api/project-data/office/templates', {
      name: `Загрузка для электриков ${stamp}`, scope: 'SHARED', schema: state.schema,
      query: { entity: 'tag', columns: ['identifier', 'brand', 'department'], filters: [], sort: [], excludedEntityIds: [], limit: 1000 },
    });
    ok('шаблон записан', saved.status === 200, saved.json);
    const seenByB = await call('B', 'GET', '/api/project-data/office/templates');
    ok('Б видит шаблон А', (seenByB.json?.templates || []).some((t: any) => t.name === saved.json?.template?.name), seenByB.json);

    console.log('3. Б применяет шаблон в своей чистой таблице');
    const fileB = await newFile('B', `Моя таблица ${stamp}.xlsx`);
    ok('чистая таблица Б создана', !!fileB);
    const b = await openSheet(browser, B, fileB);
    ok('таблица Б открылась', b.ready);
    const panelB = await b.panelOpen();
    await b.frame.getByRole('button', { name: 'Flux', exact: true }).click();
    await b.frame.locator('[data-flux-command="templates"]').evaluate((el: HTMLElement) => el.click());
    // Кнопка «Открыть» — в строке именно этого шаблона: в списке могут быть и чужие
    await b.page.getByText(saved.json.template.name, { exact: true }).locator('xpath=ancestor::*[.//button[normalize-space()="Открыть"]][1]').getByRole('button', { name: 'Открыть' }).click();
    const expected = columns.map(([, , name]) => name);
    ok('шапка встала в те же ячейки без уточнений', await until(async () => JSON.stringify(await Promise.all(['A1', 'B1', 'C1'].map((x) => cell(b.frame, x)))) === JSON.stringify(expected), 25000), await Promise.all(['A1', 'B1', 'C1'].map((x) => cell(b.frame, x))));
    ok('уточнять нечего', !(await panelB.innerText()).includes('Шаблон ожидает уточнения'));
    const stateB = (await call('B', 'GET', `/api/project-data/files/${fileB}/office-state`)).json;
    ok('в файле Б — три привязки на тех же адресах', JSON.stringify(stateB.schema.anchors.map((x: any) => [x.sheetName, x.address, x.parts[0]?.binding?.fieldKey])) === JSON.stringify([['Лист1', 'A1', 'identifier'], ['Лист1', 'B1', 'brand'], ['Лист1', 'C1', 'department']]), stateB.schema.anchors);
    ok('файл знает свой шаблон', stateB.template?.name === saved.json?.template?.name, stateB.template);
    ok('идентификаторы ячеек не перенесены из файла А', !stateB.schema.anchors.some((x: any) => state.schema.anchors.some((y: any) => y.id === x.id)));
    await b.page.getByRole('button', { name: /1\. Выборка/ }).click();
    await b.page.waitForTimeout(1500);
    await panelB.getByRole('button', { name: /Обновить выборку/ }).click();
    ok('выборка Б загружена', await until(async () => (await panelB.getByLabel('Выбрать все строки').count()) > 0 && (await panelB.innerText()).includes(`TPL-1-${stamp}`), 15000));
    await panelB.getByLabel('Выбрать все строки').check();
    await panelB.getByRole('button', { name: /Предпросмотр заполнения/ }).click();
    await panelB.getByRole('button', { name: /Подтвердить и заполнить/ }).click();
    await b.page.waitForTimeout(6000);
    await b.page.keyboard.press('Control+s');
    ok('таблица Б записана', await until(async () => (await gridOf('B', fileB, 3)).length === 4, 15000), await gridOf('B', fileB, 3));
    ok('таблица Б совпадает с таблицей А построчно', JSON.stringify(await gridOf('B', fileB, 3)) === JSON.stringify(await gridOf('A', fileA, 3)), [await gridOf('A', fileA, 3), await gridOf('B', fileB, 3)]);

    console.log('4. После повторного открытия всё на месте');
    const again = await openSheet(browser, B, fileB);
    ok('таблица Б открылась заново', again.ready);
    const firstRow = (await gridOf('A', fileA, 3))[1]!.split('|');
    // Книга догружается частями: ждём, пока ячейки прочитаются
    await until(async () => (await cell(again.frame, 'C2')) !== null && (await cell(again.frame, 'C2')) !== undefined, 20000);
    const seen = await Promise.all(['A1', 'B1', 'C1', 'A2', 'B2', 'C2'].map((x) => cell(again.frame, x)));
    ok('шапка и первая строка те же', JSON.stringify(seen.map(String)) === JSON.stringify([...expected, ...firstRow]), seen);
  } finally {
    await browser.close();
    for (const id of files) await call('A', 'DELETE', `/api/files/${id}`);
  }
  console.log(failures ? `\nПРОВАЛОВ: ${failures}` : '\nВсё верно');
  process.exit(failures ? 1 : 0);
})();
