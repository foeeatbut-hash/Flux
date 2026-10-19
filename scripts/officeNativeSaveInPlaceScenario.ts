import JSZip from 'jszip';
import { makeXlsx } from './officeHarness';
import { runNativeDefinedNamesReloadMode } from './officeNativeDefinedNamesPreflight';
import type { NativeDefinedNamesReloadContext } from './officeNativeDefinedNamesReloadScenario';

type SaveInPlaceOptions = {
  folderId: string;
  stamp: string;
  created: string[];
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

export async function runNativeSaveInPlaceScenario(options: SaveInPlaceOptions): Promise<void> {
  const { folderId, stamp, created, raw, upload, check, waitFor, resetPage, navigateOffice, openPanel, waitForSheetFile, clickSheetGrid } = options;
  const page = options.page;
  console.log('\nNative Sheets ordinary Save retains the live workbook and Undo history');

  const fileId = await upload(folderId, `__native_save_in_place_${stamp}.xlsx`, 'XLSX', await makeXlsx());
  if (fileId) created.push(fileId);
  await resetPage(false);
  await navigateOffice(page(), `/office-sheet?file=${encodeURIComponent(fileId)}`);
  const frame = await openPanel(page(), 'Flux Office — Таблица');
  check('save-in-place fixture opened in the native Sheets grid', await waitForSheetFile(frame));

  const unitAndSelection = () => frame.locator('body').evaluate(() => {
    const hooks = (window as any).__fluxSheets;
    const unit = hooks?.univerRef?.current;
    const workbook = unit?.univerAPI?.getActiveWorkbook?.();
    const sheet = workbook?.getActiveSheet?.();
    return {
      unitId: unit?.univerAPI?.getUnitId?.() ?? workbook?.getId?.() ?? null,
      workbookId: workbook?.getId?.() ?? null,
      sheetId: sheet?.getSheetId?.() ?? null,
      selection: sheet?.getActiveRange?.()?.getA1Notation?.() ?? null,
    };
  }).catch(() => null);

  const nameBox = frame.locator('input.univer-box-border').first();
  const selectB3 = async () => {
    await nameBox.fill('B3');
    await nameBox.press('Enter');
    await frame.locator('canvas[id^="univer-sheet-main-canvas_"]').first().focus();
  };
  await clickSheetGrid(frame);
  await selectB3();
  await page().keyboard.type('41');
  await page().keyboard.press('Enter');
  check('first edit is visible in the live workbook', await waitFor(async () => await frame.locator('body').evaluate(() => {
    const api = (window as any).__fluxSheets?.univerRef?.current?.univerAPI;
    return api?.getActiveWorkbook?.()?.getActiveSheet?.()?.getRange('B3')?.getValues?.()?.[0]?.[0] === 41;
  }).catch(() => false)));

  await selectB3();
  const initial = await unitAndSelection();
  const hasModel = await frame.locator('body').evaluate(() => !!(window as any).__fluxSheets?.univerRef?.current?.univerAPI?.getActiveWorkbook?.()?.getWorkbook?.()).catch(() => false);
  check('save-in-place fixture exposes a live Univer unit, workbook model, and active sheet before saving', !!initial?.unitId && !!initial.workbookId && !!initial.sheetId && hasModel, { ...initial, hasModel });
  check('B3 is the active selection before the first save', initial?.selection === 'B3', initial);
  await frame.locator('body').evaluate(() => {
    const w = window as any;
    const hooks = w.__fluxSheets;
    const workbook = hooks?.univerRef?.current?.univerAPI?.getActiveWorkbook?.();
    w.__fluxSaveInPlaceIdentity = {
      unit: hooks?.univerRef?.current,
      model: workbook?.getWorkbook?.(),
      lazy: hooks?.lazyWorkbookRef?.current,
      document,
    };
  });

  const diskCell = async (): Promise<string> => {
    const response = await raw('GET', `/api/files/${encodeURIComponent(fileId)}/raw`);
    if (response.status !== 200) return '';
    const zip = await JSZip.loadAsync(response.bytes);
    const xml = await zip.file('xl/worksheets/sheet1.xml')?.async('string') || '';
    return xml.match(/<c\b[^>]*\br="B3"[^>]*>[\s\S]*?<v>([^<]*)<\/v>[\s\S]*?<\/c>/)?.[1] || '';
  };

  const save = async (expected: string, label: string) => {
    await page().keyboard.press('Control+s');
    const saved = await waitFor(async () => await diskCell() === expected, 20000);
    const after = await unitAndSelection();
    const sameUnit = await frame.locator('body').evaluate(() => {
      const w = window as any;
      const identity = w.__fluxSaveInPlaceIdentity;
      const hooks = w.__fluxSheets;
      const workbook = hooks?.univerRef?.current?.univerAPI?.getActiveWorkbook?.();
      return !!identity && identity.unit === hooks?.univerRef?.current && identity.model === workbook?.getWorkbook?.() &&
        identity.lazy === hooks?.lazyWorkbookRef?.current && identity.document === document;
    }).catch(() => false);
    check(`${label}: saved value is present in the actual XLSX file`, saved, { expected, actual: await diskCell() });
    check(`${label}: save retained the same Univer unit and workbook`, sameUnit && after?.unitId === initial?.unitId && after?.workbookId === initial?.workbookId, { initial, after, sameUnit });
    check(`${label}: active sheet and B3 selection survived save`, after?.sheetId === initial?.sheetId && after?.selection === 'B3', after);
  };

  await save('41', 'first ordinary Save');
  await page().keyboard.type('42');
  await page().keyboard.press('Enter');
  check('second edit is visible without reopening the workbook', await waitFor(async () => await frame.locator('body').evaluate(() => {
    const api = (window as any).__fluxSheets?.univerRef?.current?.univerAPI;
    return api?.getActiveWorkbook?.()?.getActiveSheet?.()?.getRange('B3')?.getValues?.()?.[0]?.[0] === 42;
  }).catch(() => false)));
  await selectB3();
  await save('42', 'second ordinary Save');

  check('the underlying Univer model is still the same immediately before Undo', await frame.locator('body').evaluate(() => {
    const w = window as any;
    const identity = w.__fluxSaveInPlaceIdentity;
    const hooks = w.__fluxSheets;
    const workbook = hooks?.univerRef?.current?.univerAPI?.getActiveWorkbook?.();
    return !!identity && identity.unit === hooks?.univerRef?.current && identity.model === workbook?.getWorkbook?.() &&
      identity.lazy === hooks?.lazyWorkbookRef?.current && identity.document === document;
  }).catch(() => false));
  await selectB3();
  await page().keyboard.press('Control+z');
  const undone = await waitFor(async () => await frame.locator('body').evaluate(() => {
    const api = (window as any).__fluxSheets?.univerRef?.current?.univerAPI;
    return api?.getActiveWorkbook?.()?.getActiveSheet?.()?.getRange('B3')?.getValues?.()?.[0]?.[0] === 41;
  }).catch(() => false));
  check('Undo after two saves restores the preceding saved cell value in the same workbook', undone && await frame.locator('body').evaluate(() => {
    const w = window as any;
    const identity = w.__fluxSaveInPlaceIdentity;
    const hooks = w.__fluxSheets;
    const workbook = hooks?.univerRef?.current?.univerAPI?.getActiveWorkbook?.();
    return !!identity && identity.unit === hooks?.univerRef?.current && identity.model === workbook?.getWorkbook?.() &&
      identity.lazy === hooks?.lazyWorkbookRef?.current && identity.document === document;
  }).catch(() => false));
  await selectB3();
  await save('41', 'final Save after Undo');
}

export async function runNativeSaveInPlaceMode(
  nativeOnly: string,
  options: SaveInPlaceOptions,
  closeContext: () => Promise<unknown>,
): Promise<boolean> {
  if (nativeOnly !== 'save-in-place') return false;
  await runNativeSaveInPlaceScenario(options);
  await closeContext();
  return true;
}

export async function runNativePreflightModes(
  nativeOnly: string,
  options: NativeDefinedNamesReloadContext,
  closeContext: () => Promise<unknown>,
): Promise<boolean> {
  if (await runNativeDefinedNamesReloadMode(nativeOnly, options, closeContext)) return true;
  return runNativeSaveInPlaceMode(nativeOnly, options, closeContext);
}
