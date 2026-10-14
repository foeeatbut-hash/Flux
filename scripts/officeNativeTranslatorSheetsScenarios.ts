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
  const undoKey = async (): Promise<void> => { await focusGrid(); await page().keyboard.press('Control+z'); };
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
  await waitFor(async () => same(await dump(), base));
}
