/**
 * Живые сценарии переводчика Таблицы (Univer): шесть режимов размещения, защита, одна отмена,
 * устаревшие переводы, сдвиг строк и столбцов, «новый файл», сохранение и повторное открытие.
 * Окно Flux с панелью перевода ещё не подключено, поэтому мост редактора вызывается напрямую:
 * через window.__fluxTranslation (тот же объект, что слушает каналы) и через сообщения окна
 * flux:translation-*-request (каналы).
 */
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { makeXlsx } from './officeHarness';

type SuiteOptions = {
  fixture: { projectId: string };
  folderId: string;
  stamp: string;
  created: string[];
  api: (method: string, route: string, body?: unknown) => Promise<any>;
  raw: (method: string, route: string, bytes?: Buffer, headers?: Record<string, string>) => Promise<any>;
  upload: (folderId: string, name: string, type: string, bytes: Buffer) => Promise<string>;
  check: (label: string, good: unknown, detail?: unknown) => void;
  waitFor: (probe: () => Promise<boolean>, timeout?: number) => Promise<boolean>;
  resetPage: (dark?: boolean) => Promise<void>;
  navigateOffice: (page: any, route: string) => Promise<void>;
  openPanel: (page: any, title: string) => Promise<any>;
  waitForSheetFile: (frame: any) => Promise<boolean>;
  clickSheetGrid: (frame: any) => Promise<any>;
  page: () => any;
};

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const inline = (ref: string, text: string) => `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;

/** Книга: «Перечень» с текстом, числом, формулой и кодами; «Справка» с одной строкой. */
async function makeBook(): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await makeXlsx());
  zip.file('xl/worksheets/sheet1.xml', `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
    <row r="1">${inline('A1', 'Наименование')}${inline('B1', 'Мощность')}${inline('C1', 'Примечание')}</row>
    <row r="2">${inline('A2', 'Вентилятор')}<c r="B2"><v>5</v></c>${inline('C2', 'Резерв')}</row>
    <row r="3">${inline('A3', 'Насос')}<c r="B3"><v>12</v></c><c r="C3"><f>B3*2</f><v>24</v></c></row>
    <row r="4">${inline('A4', 'Установка AHU-01 мощностью 1 250,5 кВт')}</row>
  </sheetData></worksheet>`);
  zip.file('xl/workbook.xml', (await zip.file('xl/workbook.xml')!.async('string')).replace(/<definedNames>[\s\S]*?<\/definedNames>/, '<definedNames/>'));
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

const DICT: Record<string, string> = {
  'Наименование': 'Name', 'Мощность': 'Power', 'Примечание': 'Note', 'Вентилятор': 'Fan', 'Резерв': 'Standby', 'Насос': 'Pump',
  'Установка AHU-01 мощностью 1 250,5 кВт': 'Unit AHU-01 with power 1 250,5 kW', 'Справочный лист': 'Reference sheet',
};

/** Выполнить в редакторе строку-функцию (обход ловушки tsx: именованные функции в evaluate не пишем). */
const run = (frame: any, code: string, arg?: unknown): Promise<any> =>
  frame.locator('body').evaluate((_body: HTMLElement, a: { code: string; arg: unknown }) => (0, eval)(a.code)(a.arg), { code, arg });

const DUMP = `(async () => {
  const wb = window.__fluxSheets.univerRef.current.univerAPI.getActiveWorkbook();
  const letters = (c) => { let s = ''; for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
  const out = { sheets: [], names: {}, active: wb.getActiveSheet().getSheetName() };
  for (const fs of wb.getSheets()) {
    const cells = {};
    fs.getSheet().getCellMatrix().forValue((r, c, cell) => {
      if (!cell) return;
      const v = cell.f ? '=' + String(cell.f).replace(/^=/, '') : (cell.p && cell.p.body ? String(cell.p.body.dataStream).replace(/\\r\\n$/, '') : cell.v);
      if (v !== undefined && v !== null && v !== '') cells[letters(c) + (r + 1)] = v;
    });
    out.sheets.push({ name: fs.getSheetName(), cells });
  }
  for (const d of wb.getDefinedNames()) { const n = String(d.getName()); out.names[n] = String(d.getRef ? d.getRef() : d.getFormulaOrRefString()).replace(/^=/, ''); }
  return out;
})`;

export async function runNativeTranslatorSheets(options: SuiteOptions): Promise<void> {
  const { folderId, stamp, created, api, raw, upload, check, waitFor, resetPage, navigateOffice, openPanel, waitForSheetFile, clickSheetGrid } = options;
  const page = options.page;
  console.log('\n7. Переводчик Таблицы: режимы, защита, отмена, устаревшие, сдвиг, копия, сохранение');

  const originalBytes = await makeBook();
  const fileId = await upload(folderId, `__translator_sheets_${stamp}.xlsx`, 'XLSX', originalBytes);
  if (!fileId) return;
  created.push(fileId);
  const originalSha = sha(originalBytes);
  await resetPage(false);
  await navigateOffice(page(), `/office-sheet?file=${encodeURIComponent(fileId)}`);
  let frame = await openPanel(page(), 'Flux Office — Таблица');
  check('книга перевода открыта в Таблице', await waitForSheetFile(frame));

  await run(frame, `(async () => { window.__errs = []; const push = (m) => window.__errs.push(String(m).slice(0, 300)); window.addEventListener('error', (e) => push('error ' + e.message)); window.addEventListener('unhandledrejection', (e) => push('rejection ' + (e.reason && e.reason.message || e.reason))); const orig = console.error; console.error = (...a) => { push('console ' + a.join(' ')); orig.apply(console, a); }; })`);
  const dump = (): Promise<any> => run(frame, DUMP);
  const tr = (method: string, request: unknown): Promise<any> => run(frame, `(async (r) => window.__fluxTranslation.${method}(r))`, request);
  const cell = (d: any, sheet: string, a1: string) => d.sheets.find((s: any) => s.name === sheet)?.cells[a1];
  const placement = (mode: string, extra: Record<string, unknown> = {}) => ({ mode, scope: 'sheet', separator: 'newline', order: 'source-first', sourceRevision: 'r1', ...extra });
  const read = (scope = 'sheet', records: unknown[] = []) => tr('read', { scope, records, destination: 'en' });
  /** Запрос постановки по результату чтения: перевод берётся из словаря. */
  const requestFor = (units: any[], mode: string, extra: Record<string, unknown> = {}, place: Record<string, unknown> = {}, records: unknown[] = []) => ({
    items: units.map((u) => ({ key: u.key, source: u.source, targetText: DICT[u.source] ?? `EN ${u.source}`, confirmed: true })),
    placement: placement(mode, place), direction: 'ru-en', records, ...extra,
  });
  /** Щелчок по ячейке настоящей сетки: фокус на холсте, не трогая ручку закрепления в углу. */
  const focusGrid = async (): Promise<void> => {
    const point = await run(frame, `(async () => {
      const canvas = document.querySelector('canvas[id^="univer-sheet-main-canvas_"]');
      const sheet = window.__fluxSheets.univerRef.current.univerAPI.getActiveWorkbook().getActiveSheet();
      const rect = sheet.getRange('H20').getCellRect();
      const bounds = canvas.getBoundingClientRect();
      return { x: (Number(rect.left) + Number(rect.width) / 2) * bounds.width / canvas.width, y: (Number(rect.top) + Number(rect.height) / 2) * bounds.height / canvas.height };
    })`);
    await frame.locator('canvas[id^="univer-sheet-main-canvas_"]').first().click({ position: point, timeout: 10000 });
  };
  const undoKey = async (): Promise<void> => { await focusGrid(); await new Promise((r) => setTimeout(r, 500)); await page().keyboard.press('Control+z'); };
  const redoKey = async (): Promise<void> => { await page().keyboard.press('Control+Shift+z'); };
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  const base = await dump();
  const first = await read();
  check('чтение листа: 7 фрагментов (число и формула пропущены)', first.ok && first.units.length === 7 && first.skipped >= 1, { ok: first.ok, n: first.units?.length, skipped: first.skipped, err: first.error });
  check('ключи новых ячеек — адреса, статус new', first.units.every((u: any) => /^n:Перечень!/.test(u.key) && u.status === 'new'), first.units?.map((u: any) => u.key));

  // ── 1. Соседний столбец ──
  const col = await tr('apply', requestFor(first.units, 'adjacent-column'));
  check('соседний столбец: постановка принята', col.ok && col.applied === 7 && !!col.stepId && col.records.length === 7, col);
  let d = await dump();
  check('соседний столбец: перевод в новых столбцах рядом с каждым исходным, число сдвинулось в C', cell(d, 'Перечень', 'B1') === 'Name' && cell(d, 'Перечень', 'D1') === 'Power' && cell(d, 'Перечень', 'F1') === 'Note' && cell(d, 'Перечень', 'B2') === 'Fan' && cell(d, 'Перечень', 'C2') === 5 && cell(d, 'Перечень', 'B4') === 'Unit AHU-01 with power 1 250,5 kW', d.sheets[0].cells);
  check('соседний столбец: формула осталась формулой и сдвинулась вместе со ссылкой', cell(d, 'Перечень', 'E3') === '=C3*2', cell(d, 'Перечень', 'E3'));
  check('соседний столбец: имена FLUX_TR_ и FLUX_TRT_ созданы по 7 штук', Object.keys(d.names).filter((n) => n.startsWith('FLUX_TR_')).length === 7 && Object.keys(d.names).filter((n) => n.startsWith('FLUX_TRT_')).length === 7, Object.keys(d.names));
  await undoKey();
  check('соседний столбец: один Ctrl+Z возвращает ячейки, столбцы и имена', await waitFor(async () => same(await dump(), base)), await dump());
  await redoKey();
  check('соседний столбец: Ctrl+Shift+Z возвращает перевод и имена', await waitFor(async () => { const x = await dump(); return cell(x, 'Перечень', 'B1') === 'Name' && Object.keys(x.names).filter((n) => n.startsWith('FLUX_TRT_')).length === 7; }), await dump());
  await undoKey();
  { const okBack = await waitFor(async () => same(await dump(), base)); check('возврат к исходной книге перед следующим режимом', okBack, okBack ? undefined : await run(frame, `(async () => window.__fluxTranslation.debug())`)); }

  const count = (d0: any, prefix: string) => Object.keys(d0.names).filter((n) => n.startsWith(prefix)).length;
  /** Поставить режим, проверить результат функцией, одним Ctrl+Z вернуть всё. */
  const modeCase = async (label: string, mode: string, place: Record<string, unknown>, verify: (x: any, applied: any) => boolean | string) => {
    const units = (await read()).units;
    const result = await tr('apply', requestFor(units, mode, {}, place));
    const x = await dump();
    const verdict = result.ok ? verify(x, result) : `отказ: ${result.error}`;
    check(`${label}: результат верный`, verdict === true, verdict === true ? undefined : { verdict, result: { ok: result.ok, err: result.error }, sheets: x.sheets });
    check(`${label}: имена FLUX_TR_/FLUX_TRT_ по 7`, count(x, 'FLUX_TR_') === 7 && count(x, 'FLUX_TRT_') === 7, Object.keys(x.names));
    await undoKey();
    const restored = await waitFor(async () => same(await dump(), base));
    check(`${label}: один Ctrl+Z возвращает книгу целиком`, restored, restored ? undefined : { debug: await run(frame, `(async () => ({ ...window.__fluxTranslation.debug(), errs: window.__errs.slice(-5) }))`) });
    return result;
  };

  // ── 2. Строка под оригиналом ──
  await modeCase('строка под оригиналом', 'adjacent-row', {}, (x) =>
    cell(x, 'Перечень', 'A1') === 'Наименование' && cell(x, 'Перечень', 'A2') === 'Name' && cell(x, 'Перечень', 'B2') === 'Power' && cell(x, 'Перечень', 'C2') === 'Note'
    && cell(x, 'Перечень', 'A3') === 'Вентилятор' && cell(x, 'Перечень', 'A4') === 'Fan' && cell(x, 'Перечень', 'B3') === 5 && cell(x, 'Перечень', 'C5') === '=B5*2'
    && cell(x, 'Перечень', 'A8') === 'Unit AHU-01 with power 1 250,5 kW' || JSON.stringify(x.sheets[0].cells));

  // ── 3. Новый лист ──
  await modeCase('новый лист', 'new-sheet', {}, (x) => {
    const made = x.sheets.find((sh: any) => sh.name === 'Перечень (EN)');
    return !!made && x.sheets.length === 3 && made.cells.A1 === 'Name' && made.cells.B1 === 'Power' && made.cells.A4 === 'Unit AHU-01 with power 1 250,5 kW' && cell(x, 'Перечень', 'A1') === 'Наименование' || JSON.stringify(x.sheets.map((sh: any) => sh.name));
  });

  // ── 4. В той же ячейке: после / перед, перенос и свой разделитель ──
  await modeCase('в ячейке после оригинала (перенос строки)', 'inline-after', {}, (x) =>
    cell(x, 'Перечень', 'A1') === 'Наименование\nName' && cell(x, 'Перечень', 'A4') === 'Установка AHU-01 мощностью 1 250,5 кВт\nUnit AHU-01 with power 1 250,5 kW' && cell(x, 'Перечень', 'C3') === '=B3*2' && cell(x, 'Перечень', 'B2') === 5 || JSON.stringify(x.sheets[0].cells));
  await modeCase('в ячейке перед оригиналом (свой разделитель «|», перевод первым)', 'inline-before', { separator: 'custom', customSeparator: '|', order: 'target-first' }, (x) =>
    cell(x, 'Перечень', 'A1') === 'Name | Наименование' && cell(x, 'Перечень', 'A2') === 'Fan | Вентилятор' || JSON.stringify(x.sheets[0].cells));

  // ── 5. Замена ──
  const replaceResult = await modeCase('замена', 'replace', {}, (x) =>
    cell(x, 'Перечень', 'A1') === 'Name' && cell(x, 'Перечень', 'A3') === 'Pump' && cell(x, 'Перечень', 'B3') === 12 && cell(x, 'Перечень', 'C3') === '=B3*2' && cell(x, 'Перечень', 'A4') === 'Unit AHU-01 with power 1 250,5 kW' || JSON.stringify(x.sheets[0].cells));
  check('замена: записи журнала несут режим, исходник и хеш', replaceResult.records.length === 7 && replaceResult.records.every((r: any) => r.mode === 'replace' && r.sourceText && r.sourceHash && /^s:[0-9a-f]{12}$/.test(r.key)), replaceResult.records?.[0]);

  // ── 6. Защита: технические фрагменты, подтверждение, исходник ──
  const units0 = (await read()).units;
  const a4 = units0.find((u: any) => u.key.endsWith('!A4'));
  const broken = await tr('apply', { ...requestFor(units0, 'replace'), items: [{ key: a4.key, source: a4.source, targetText: 'Unit AHU 01 with power 1250.5 kW', confirmed: true }] });
  check('защита: испорченный код и число отклоняют постановку (protected-changed)', !broken.ok && broken.code === 'protected-changed', broken);
  const unconfirmed = await tr('apply', { ...requestFor(units0, 'replace'), items: [{ key: a4.key, source: a4.source, targetText: DICT[a4.source], confirmed: false }] });
  check('непроверенный фрагмент отклоняется (not-confirmed)', !unconfirmed.ok && unconfirmed.code === 'not-confirmed', unconfirmed);
  const wrongSource = await tr('apply', { ...requestFor(units0, 'replace'), items: [{ key: a4.key, source: 'Другой текст', targetText: 'X', confirmed: true }] });
  check('исходник изменился после чтения (source-changed)', !wrongSource.ok && wrongSource.code === 'source-changed', wrongSource);
  const unsupported = await tr('apply', requestFor(units0, 'after-paragraph'));
  check('режим Документа в Таблице отклоняется (unsupported-mode)', !unsupported.ok && unsupported.code === 'unsupported-mode', unsupported);
  check('все отказы оставили книгу без изменений', same(await dump(), base));

  // ── 7. Предпросмотр и каналы окна ──
  const pageRun = (code: string, arg?: unknown): Promise<any> => page().evaluate((a: { code: string; arg: unknown }) => (0, eval)(a.code)(a.arg), { code, arg });
  const channel = (name: string, answer: string, body: unknown): Promise<any> => pageRun(`(async (a) => {
    const f = document.querySelector('iframe[title="Flux Office — Таблица"]');
    return await new Promise((resolve) => {
      const h = (e) => { const d = e.data; if (e.source === f.contentWindow && d && d.flux === 'office' && d.op === 'ipc-send' && d.payload.channel === a.answer) { window.removeEventListener('message', h); resolve(d.payload.args[0]); } };
      window.addEventListener('message', h);
      f.contentWindow.postMessage({ flux: 'office', event: 'ipc', payload: { channel: a.name, args: [a.body] } }, '*');
    });
  })`, { name, answer, body });
  const viaRead = await channel('flux:translation-read-request', 'flux:translation-read', { scope: 'sheet', records: [], destination: 'en' });
  check('канал чтения: flux:translation-read-request → flux:translation-read, 7 фрагментов', viaRead.ok && viaRead.units.length === 7, viaRead);
  const preview = await channel('flux:translation-apply-request', 'flux:translation-applied', { ...requestFor(viaRead.units, 'adjacent-column'), dryRun: true });
  check('предпросмотр (dryRun) по каналу: 7 строк «было → станет», книга не тронута', preview.ok && preview.preview.length === 7 && preview.preview[0].before === '' && preview.preview[0].after === 'Name' && preview.preview[0].target === 'new-cell' && same(await dump(), base), preview.preview?.[0]);
  const viaApply = await channel('flux:translation-apply-request', 'flux:translation-applied', requestFor(viaRead.units, 'adjacent-column'));
  check('канал постановки: flux:translation-applied с записями и stepId', viaApply.ok && viaApply.records.length === 7 && !!viaApply.stepId, viaApply);
  const rolled = await channel('flux:translation-rollback-request', 'flux:translation-rolled-back', { stepId: viaApply.stepId });
  check('канал отката: свой верхний шаг отменяется, книга как была, имена убраны', rolled.ok && await waitFor(async () => same(await dump(), base)), rolled);
  const twice = await tr('rollback', 'tr-неизвестный');
  check('откат чужого шага — cannot-rollback', !twice.ok && twice.code === 'cannot-rollback', twice);
  const mine = await tr('apply', requestFor(viaRead.units, 'adjacent-column'));
  await run(frame, `(async () => { window.__fluxSheets.univerRef.current.univerAPI.getActiveWorkbook().getSheets()[0].getRange('A9').setValues([[{ v: 'Ручная правка' }]]); })`);
  const late = await tr('rollback', mine.stepId);
  check('после чужой правки откат отказывает (cannot-rollback), правка и перевод на месте', !late.ok && late.code === 'cannot-rollback' && cell(await dump(), 'Перечень', 'A9') === 'Ручная правка' && cell(await dump(), 'Перечень', 'B1') === 'Name', late);

  // ── 8. Вставка строки и столбца над переведённой ячейкой, устаревшие, повтор без дублей ──
  let records: any[] = mine.records;
  await run(frame, `(async () => { const sheet = window.__fluxSheets.univerRef.current.univerAPI.getActiveWorkbook().getSheets()[0]; sheet.getRange('A9').clear(); sheet.insertRows(0, 1); sheet.insertColumns(0, 1); })`);
  const names1 = (await dump()).names;
  check('вставка строки и столбца сдвинула имена: FLUX_TR_ первого фрагмента — B2, перевод — C2', Object.entries(names1).some(([n, r]) => n.startsWith('FLUX_TR_') && String(r).replace(/'/g, '') === 'Перечень!$B$2') && Object.entries(names1).some(([n, r]) => n.startsWith('FLUX_TRT_') && String(r).replace(/'/g, '') === 'Перечень!$C$2'), names1);
  const shifted = await read('sheet', records);
  check('чтение после сдвига: 7 актуальных фрагментов по ключам s:<id> на новых адресах', shifted.ok && shifted.units.length === 7 && shifted.units.every((u: any) => u.status === 'current' && /^s:/.test(u.key)) && shifted.units[0].location.address === 'B2', shifted.units?.map((u: any) => [u.key, u.status, u.location.address]));
  const cell0 = (x: any) => x.sheets[0].cells;
  const colsBefore = Object.keys(cell0(await dump())).length;
  const rerun = await tr('apply', { ...requestFor(shifted.units, 'adjacent-column', {}, {}, records), items: shifted.units.map((u: any) => ({ key: u.key, source: u.source, targetText: `${DICT[u.source]} v2`, confirmed: true })) });
  const afterRerun = await dump();
  check('повтор того же способа: пишет в те же ячейки, новых столбцов нет, дублей нет', rerun.ok && cell(afterRerun, 'Перечень', 'C2') === 'Name v2' && cell(afterRerun, 'Перечень', 'B2') === 'Наименование' && Object.keys(cell0(afterRerun)).length === colsBefore && rerun.removeRecords.length === 7 && count(afterRerun, 'FLUX_TRT_') === 7, { rerun: { ok: rerun.ok, err: rerun.error, removed: rerun.removeRecords?.length }, cells: cell0(afterRerun) });
  records = rerun.records;
  await run(frame, `(async () => { window.__fluxSheets.univerRef.current.univerAPI.getActiveWorkbook().getSheets()[0].getRange('B3').setValues([[{ v: 'Вентилятор №2' }]]); })`);
  const stale = await read('sheet', records);
  const staleUnit = stale.units.find((u: any) => u.location.address === 'B3');
  check('правка исходной ячейки: устарел ровно один фрагмент, остальные актуальны', stale.ok && staleUnit?.status === 'stale' && staleUnit.stale === true && stale.units.filter((u: any) => u.status === 'current').length === 6, stale.units?.map((u: any) => [u.location.address, u.status]));
  const refresh = await tr('apply', { ...requestFor([staleUnit], 'adjacent-column', {}, {}, records), items: [{ key: staleUnit.key, source: staleUnit.source, targetText: 'Fan 2', confirmed: true }] });
  const afterStale = await dump();
  check('повторный перевод устаревшего заменяет перевод на месте и запись журнала', refresh.ok && cell(afterStale, 'Перечень', 'C3') === 'Fan 2' && refresh.removeRecords.length === 1 && Object.keys(cell0(afterStale)).length === colsBefore, { refresh: refresh.error, c3: cell(afterStale, 'Перечень', 'C3') });
  records = [...rerun.records.filter((r: any) => r.key !== refresh.records[0].key), ...refresh.records];
  const fresh = await read('sheet', records);
  check('после повторного перевода все 7 актуальны', fresh.units.every((u: any) => u.status === 'current'), fresh.units?.map((u: any) => [u.location.address, u.status]));
  // перевод как оригинал не читается
  check('ячейки-переводы не читаются как оригиналы', fresh.units.length === 7 && !fresh.units.some((u: any) => ['C2', 'C3'].includes(u.location.address)));

  // ── 9. Откат своего шага и «не последний шаг» ──
  const beforeRoll = await dump();
  const probe = await tr('apply', { ...requestFor([staleUnit], 'adjacent-column', {}, {}, records), items: [{ key: staleUnit.key, source: staleUnit.source, targetText: 'Fan 2 v3', confirmed: true }] });
  check('постановка поверх уже переведённого: шаг и stepId', probe.ok && !!probe.stepId && cell(await dump(), 'Перечень', 'C3') === 'Fan 2 v3', probe);
  const rolledBack = await tr('rollback', probe.stepId);
  check('rollback(stepId) отменяет ровно свой верхний шаг', rolledBack.ok && await waitFor(async () => same(await dump(), beforeRoll)), rolledBack);

  // ── 10. Шапка Flux: плашки полей и защищённые ячейки ──
  const ANCHOR = '11111111-1111-4111-8111-111111111111';
  await run(frame, `(async (id) => {
    const wb = window.__fluxSheets.univerRef.current.univerAPI.getActiveWorkbook();
    const sheet = wb.getSheets()[0];
    sheet.getRange('B8').setValues([[{ v: 'Расход Мощность' }]]);
    wb.insertDefinedName('FLUX_ANCHOR_' + id.replace(/-/g, '_'), "'Перечень'!$B$8");
    window.__fluxHeaderParts = (anchor) => anchor === id ? [{ kind: 'text', text: 'Расход ' }, { kind: 'field', binding: { label: 'Мощность', fieldKey: 'param:@Power' } }] : null;
  })`, ANCHOR);
  const header = await read('header', records);
  const hu = header.units?.[0];
  check('шапка: плашка поля вынута знаком, подпись и fieldKey не переводятся', header.ok && header.units.length === 1 && hu.chips === 1 && /^Расход [\ue5c0-\ue5df]$/.test(hu.source) && hu.fieldKey === 'param:@Power' && hu.sourceId === ANCHOR, header);
  const plainScope = await read('sheet', records);
  check('шапка не попадает в обычное чтение листа', !plainScope.units.some((u: any) => u.location.address === 'B8'));
  const marker = hu.source.slice(-1);
  const bad = await tr('apply', { ...requestFor([hu], 'adjacent-column', {}, {}, records), items: [{ key: hu.key, source: hu.source, targetText: 'Flow', confirmed: true }] });
  check('шапка: перевод без плашки отклоняется (protected-changed)', !bad.ok && bad.code === 'protected-changed', bad);
  const inCell = await tr('apply', { ...requestFor([hu], 'replace', {}, {}, records), items: [{ key: hu.key, source: hu.source, targetText: `Flow ${marker}`, confirmed: true }] });
  check('шапка: замена внутри защищённой ячейки отклоняется (unsupported-mode)', !inCell.ok && inCell.code === 'unsupported-mode', inCell);
  const good = await tr('apply', { ...requestFor([hu], 'adjacent-column', {}, {}, records), items: [{ key: hu.key, source: hu.source, targetText: `Flow ${marker}`, confirmed: true }] });
  const afterHeader = await dump();
  check('шапка: подпись поля вернулась в перевод, ячейка с меткой не тронута', good.ok && cell(afterHeader, 'Перечень', 'C8') === 'Flow Мощность' && cell(afterHeader, 'Перечень', 'B8') === 'Расход Мощность', { good: good.error, cells: afterHeader.sheets[0].cells });
  await undoKey();
  await run(frame, `(async () => {
    const wb = window.__fluxSheets.univerRef.current.univerAPI.getActiveWorkbook();
    wb.deleteDefinedName('FLUX_ANCHOR_11111111_1111_4111_8111_111111111111');
    wb.getSheets()[0].getRange('B8').clear();
    window.__fluxHeaderParts = () => null;
  })`);

  // ── 11. «Новый файл»: копия с переводом, оригинал не тронут ──
  // Несохранённые правки прежней книги редактор держит в копии восстановления и вернул бы при открытии:
  // дальше работаем с чистым вторым файлом
  const fileId2 = await upload(folderId, `__translator_sheets_b_${stamp}.xlsx`, 'XLSX', originalBytes);
  created.push(fileId2);
  await resetPage(false);
  await navigateOffice(page(), `/office-sheet?file=${encodeURIComponent(fileId2)}`);
  frame = await openPanel(page(), 'Flux Office — Таблица');
  check('второй файл открыт', await waitForSheetFile(frame));
  const baseAgain = await dump();
  const units1 = (await read()).units;
  const nf = await tr('apply', requestFor(units1, 'new-file'));
  check('новый файл: копия просит окно Flux сохранить (saved:false), шаг для отката есть', nf.ok && nf.copyRequest?.kind === 'sheets-save-as' && nf.copyRequest.saved === false && !!nf.stepId, nf);
  check('новый файл: в окне правки стоят до сохранения копии', cell(await dump(), 'Перечень', 'A1') === 'Name');
  // Окно Flux при saved:false само открывает «Сохранить как»; здесь это делает тест тем же путём редактора
  const copyBefore = await listCopies();
  const saving = run(frame, `(async () => window.__fluxSheetsSave('save-as', true))`);
  const nameBox = page().getByPlaceholder('Имя файла');
  await nameBox.waitFor({ timeout: 20000 });
  await nameBox.press('Enter');
  await saving.catch(() => undefined);
  const copies = await waitForCopy(copyBefore);
  check('новый файл: копия появилась рядом', copies.length === 1, copies);
  const undoneCopy = await tr('rollback', nf.stepId);
  check('новый файл: после копии шаг откатывается, окно как до перевода', undoneCopy.ok && await waitFor(async () => same(await dump(), baseAgain)), undoneCopy);
  const original = await raw('GET', `/api/files/${encodeURIComponent(fileId2)}/raw`);
  check('новый файл: байты оригинала не изменились', original.status === 200 && sha(original.bytes) === originalSha);
  if (copies[0]) {
    created.push(copies[0]);
    const copyBytes = (await raw('GET', `/api/files/${encodeURIComponent(copies[0])}/raw`)).bytes;
    const zip = await JSZip.loadAsync(copyBytes);
    const sheetXml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    const workbookXml = await zip.file('xl/workbook.xml')!.async('string');
    const shared = (await zip.file('xl/sharedStrings.xml')?.async('string')) || '';
    const text = sheetXml + shared;
    check('новый файл: в копии переведённые ячейки, число и формула на месте', text.includes('Name') && text.includes('Pump') && text.includes('Unit AHU-01 with power 1 250,5 kW') && !text.includes('Наименование') && /<f>B3\*2<\/f>/.test(sheetXml), { head: text.slice(0, 400) });
    check('новый файл: в копии записаны имена FLUX_TR_ и FLUX_TRT_ (связь с оригиналом сохраняется)', (workbookXml.match(/FLUX_TR_/g) || []).length >= 7 && (workbookXml.match(/FLUX_TRT_/g) || []).length >= 7, workbookXml.slice(0, 500));
  }

  // ── 12. Сохранение книги и повторное открытие ──
  const toSave = await tr('apply', requestFor((await read()).units, 'adjacent-column'));
  check('для сохранения: постановка в соседний столбец принята', toSave.ok, toSave);
  await focusGrid();
  await new Promise((r) => setTimeout(r, 500));
  await page().keyboard.press('Control+s');
  const saved = await waitFor(async () => sha((await raw('GET', `/api/files/${encodeURIComponent(fileId2)}/raw`)).bytes) !== originalSha, 30000);
  check('книга с переводом записана в файл', saved);
  const savedZip = await JSZip.loadAsync((await raw('GET', `/api/files/${encodeURIComponent(fileId2)}/raw`)).bytes);
  const savedWorkbook = await savedZip.file('xl/workbook.xml')!.async('string');
  check('в файле остались имена FLUX_TR_ и FLUX_TRT_ (по 7)', (savedWorkbook.match(/definedName[^>]*name="FLUX_TR_/g) || []).length === 7 && (savedWorkbook.match(/definedName[^>]*name="FLUX_TRT_/g) || []).length === 7, savedWorkbook.slice(0, 800));
  await resetPage(false);
  await navigateOffice(page(), `/office-sheet?file=${encodeURIComponent(fileId2)}`);
  frame = await openPanel(page(), 'Flux Office — Таблица');
  await waitForSheetFile(frame);
  const namesBack = await waitFor(async () => Object.keys((await dump()).names).filter((n) => n.startsWith('FLUX_TR')).length === 14, 20000);
  check('после повторного открытия: имена перевода загружены в книгу', namesBack, Object.keys((await dump()).names));
  const reopened = await read('sheet', toSave.records);
  check('после повторного открытия: 7 фрагментов, все актуальны (перевод найден по именам)', reopened.ok && reopened.units.length === 7 && reopened.units.every((u: any) => u.status === 'current' && /^s:/.test(u.key)), reopened.units?.map((u: any) => [u.location.address, u.status]));
  const reopenedDump = await dump();
  check('после повторного открытия: перевод в своих ячейках, формула цела', cell(reopenedDump, 'Перечень', 'B1') === 'Name' && cell(reopenedDump, 'Перечень', 'E3') === '=C3*2', reopenedDump.sheets[0].cells);
  const rerunSaved = await tr('apply', { ...requestFor(reopened.units, 'adjacent-column', {}, {}, toSave.records), items: reopened.units.map((u: any) => ({ key: u.key, source: u.source, targetText: `${DICT[u.source]}!`, confirmed: true })) });
  const rerunDump = await dump();
  check('повтор после открытия: перевод заменён на месте, столбцов не прибавилось', rerunSaved.ok && cell(rerunDump, 'Перечень', 'B1') === 'Name!' && Object.keys(rerunDump.sheets[0].cells).length === Object.keys(reopenedDump.sheets[0].cells).length, rerunSaved.error);

  async function listCopies(): Promise<string[]> {
    const tree = await api('GET', `/api/projects/${encodeURIComponent(options.fixture.projectId)}/folders`);
    const found = new Set<string>();
    const walk = (node: any): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (typeof node.name === 'string' && node.name.includes(`__translator_sheets_b_${stamp}`) && node.name.includes('копия') && node.id) found.add(String(node.id));
      Object.values(node).forEach(walk);
    };
    walk(tree.json);
    return [...found];
  }
  async function waitForCopy(before: string[]): Promise<string[]> {
    let now: string[] = [];
    await waitFor(async () => { now = (await listCopies()).filter((id) => !before.includes(id)); return now.length > 0; }, 20000);
    return now;
  }
}
