import { writeFile } from 'node:fs/promises';
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
  if (!fileId) throw new Error('Save-in-place XLSX fixture upload did not return a file id');
  created.push(fileId);
  await resetPage(false);
  await navigateOffice(page(), `/office-sheet?file=${encodeURIComponent(fileId)}`);
  const frame = await openPanel(page(), 'Flux Office — Таблица');
  const fixtureReady = await waitForSheetFile(frame);
  check('save-in-place fixture opened in the native Sheets grid', fixtureReady);
  if (!fixtureReady) throw new Error('Save-in-place XLSX fixture did not open in the native Sheets grid');

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
  // Exercise the actual Insert ribbon command and the workbook's undo journal.
  // The fixture's B2:B3 cells are numeric, so the column chart has valid data.
  await selectB3();
  await nameBox.fill('B2:B3');
  await nameBox.press('Enter');
  const insertTab = frame.locator('nav.ribbon-tabs').getByRole('button', { name: 'Вставка', exact: true });
  const insertTabReady = await waitFor(async () => await insertTab.isVisible().catch(() => false), 5000);
  check('chart regression can reach the Insert ribbon tab', insertTabReady, {
    buttons: await frame.locator('nav.ribbon-tabs button').evaluateAll((items: Element[]) =>
      items.map((item) => ({ text: item.textContent, label: item.getAttribute('aria-label'), role: item.getAttribute('role') }))).catch(() => []),
  });
  if (!insertTabReady) throw new Error('Insert ribbon tab is unavailable');
  await insertTab.click();
  const insertChart = frame.getByRole('button', { name: 'Гистограмма — из текущего выделения', exact: true });
  const chartButtonReady = await waitFor(async () => await insertChart.isVisible().catch(() => false), 5000);
  check('chart regression can reach the column chart insertion button', chartButtonReady, {
    buttons: await frame.locator('.chart-grid button').evaluateAll((items: Element[]) =>
      items.map((item) => ({ label: item.getAttribute('aria-label'), title: item.getAttribute('data-tip'), rect: [item.getBoundingClientRect().x, item.getBoundingClientRect().width] }))).catch(() => []),
  });
  if (!chartButtonReady) throw new Error('Column chart insertion button is unavailable');

  const chartAdds = async () => await frame.locator('body').evaluate(() => {
    const state = (window as any).__fluxSheets?.lazyWorkbookRef?.current;
    return (state?.editJournal?.visualAdds || []).filter((item: any) => item.kind === 'chart').length;
  }).catch(() => -1);
  const beforeChartAdds = await chartAdds();
  check('chart fixture has a live edit journal before insertion', beforeChartAdds === 0, { beforeChartAdds });
  if (beforeChartAdds !== 0) throw new Error('Chart fixture edit journal is not ready');
  await frame.locator('body').evaluate(() => {
    const w = window as any;
    w.__fluxChartUndoTrace = { keys: [], commands: [] };
    window.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement | null;
      const record = { key: event.key, code: event.code, ctrl: event.ctrlKey, target: target?.tagName, targetId: target?.id, prevented: false };
      w.__fluxChartUndoTrace.keys.push(record);
      queueMicrotask(() => { record.prevented = event.defaultPrevented; });
    }, true);
    const api = w.__fluxSheets?.univerRef?.current?.univerAPI;
    if (api?.addEvent && api?.Event?.CommandExecuted) api.addEvent(api.Event.CommandExecuted, (event: any) => {
      w.__fluxChartUndoTrace.commands.push({ id: event.id, params: event.params });
      if (w.__fluxChartUndoTrace.commands.length > 30) w.__fluxChartUndoTrace.commands.shift();
    });
  });
  await insertChart.click();
  const inserted = await waitFor(async () => await chartAdds() === 1, 10000);
  check('ribbon insertion adds a chart to the live workbook journal', inserted, { chartAdds: await chartAdds() });
  if (!inserted) throw new Error('Ribbon chart insertion did not reach the edit journal');

  await clickSheetGrid(frame);
  const gridFocus = await frame.locator('body').evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    const skipHosts = [
      '[data-u-comp="formula-bar"]', '[data-u-comp="input"]', '[data-u-comp="textarea"]',
      '[data-u-comp="panel"]', '[data-u-comp="panel-field"]', '[data-u-comp="cell-popup"]',
      '[data-u-comp="defined-name"]', '[data-u-comp="defined-name-container"]',
      '[data-u-comp="select"]', '[data-u-comp="multiple-select"]', '[data-u-comp="sheets-dropdown-list"]',
      '[data-u-comp="gallery"]', '[data-u-comp="slide-tab-item"]', '.shape-editable', '.chart-editor',
      '.dialog-backdrop', '[role="dialog"]',
    ].join(', ');
    const inContainer = !!active?.closest('#univer-container');
    const isNativeField = !!active?.closest('input, textarea, select');
    const isSkippedHost = !!active?.closest(skipHosts);
    const isEditableOutsideGrid = !!active?.closest('[contenteditable="true"]') && !inContainer;
    const activeBelongsToSheet = inContainer || !!active?.closest('canvas[id^="univer-sheet-main-canvas_"]');
    const chain = [];
    let node: HTMLElement | null = active;
    while (node && chain.length < 6) {
      chain.push({ tag: node.tagName, id: node.id, className: String(node.className || '').slice(0, 120), contentEditable: node.getAttribute('contenteditable') });
      node = node.parentElement;
    }
    return {
      documentHasFocus: document.hasFocus(),
      allowedGridTarget: !isNativeField && !isSkippedHost && !isEditableOutsideGrid,
      activeElement: active ? { tag: active.tagName, id: active.id, className: String(active.className || '').slice(0, 160), contentEditable: active.getAttribute('contenteditable') } : null,
      inContainer, activeBelongsToSheet, isNativeField, isSkippedHost, isEditableOutsideGrid, chain,
      trace: (window as any).__fluxChartUndoTrace,
    };
  }).catch((error: unknown) => ({ error: String(error), documentHasFocus: false, allowedGridTarget: false, activeBelongsToSheet: false }));
  check('chart Undo keyboard target is accepted by the workbook grid routing', gridFocus.documentHasFocus && gridFocus.allowedGridTarget, gridFocus);
  await page().keyboard.press('Control+z');
  const chartUndone = await waitFor(async () => await chartAdds() === 0, 10000);
  check('Ctrl+Z removes the inserted chart from the live workbook journal', chartUndone, {
    chartAdds: await chartAdds(),
    trace: await frame.locator('body').evaluate(() => (window as any).__fluxChartUndoTrace).catch(() => null),
  });
  if (!chartUndone) throw new Error('Ctrl+Z did not undo the chart insertion');

  const relativePart = (from: string, target: string): string => {
    const parts = target.startsWith('/') ? [] : from.split('/').slice(0, -1);
    for (const part of target.split('/')) {
      if (part === '..') parts.pop();
      else if (part && part !== '.') parts.push(part);
    }
    return parts.join('/');
  };
  const relationshipTarget = (xml: string, type: string): string => {
    const entries = xml.match(/<Relationship\b[^>]*>/g) || [];
    const entry = entries.find((value) => value.match(/\bType="([^"]+)"/)?.[1]?.endsWith('/' + type));
    return entry?.match(/\bTarget="([^"]+)"/)?.[1] || '';
  };
  const saveChartState = async (wantChart: boolean, label: string) => {
    const eventsBefore = await frame.locator('body').evaluate(() => {
      const w = window as any;
      if (!w.__fluxSaveRegressionEvents) {
        w.__fluxSaveRegressionEvents = [];
        window.addEventListener('flux-sheets-save', (event) => {
          w.__fluxSaveRegressionEvents.push({ observedAt: new Date().toISOString(), performanceNow: performance.now(), detail: (event as CustomEvent).detail });
        });
      }
      return w.__fluxSaveRegressionEvents.length;
    });
    await page().keyboard.press('Control+s');
    const completed = await waitFor(async () => await frame.locator('body').evaluate((before: number) => {
      const events = (window as any).__fluxSaveRegressionEvents || [];
      return events.slice(before).some((event: any) => event.detail?.phase === 'end');
    }, eventsBefore).catch(() => false), 20000);
    const saveEvents = await frame.locator('body').evaluate((before: number) =>
      ((window as any).__fluxSaveRegressionEvents || []).slice(before), eventsBefore).catch(() => []);
    const successful = completed && saveEvents.some((event: any) =>
      event.detail?.phase === 'end' && event.detail?.ok === true && event.detail?.sessionRetained === true);
    check(label + ': Ctrl+S completed through retained save IPC', successful, { saveEvents });
    if (!successful) throw new Error(label + ': retained save IPC did not complete successfully');
    let firstArchive: unknown = null;
    let lastArchive: any = null;
    let lastArchiveBytes: Buffer | undefined;
    const archiveMatchesExpectation = async (): Promise<boolean> => {
      const response = await raw('GET', '/api/files/' + encodeURIComponent(fileId) + '/raw');
      const observedAt = new Date().toISOString();
      if (response.status === 200) lastArchiveBytes = response.bytes;
      if (response.status !== 200) {
        const metadata = { observedAt, status: response.status, bytesLength: response.bytes?.length ?? null };
        firstArchive ??= metadata;
        lastArchive = metadata;
        return false;
      }
      const zip = await JSZip.loadAsync(response.bytes);
      const names = Object.keys(zip.files).filter((name) => !zip.files[name]?.dir);
      const sheetXml = await zip.file('xl/worksheets/sheet1.xml')?.async('string') || '';
      const sheetRels = await zip.file('xl/worksheets/_rels/sheet1.xml.rels')?.async('string') || '';
      const drawingTarget = relationshipTarget(sheetRels, 'drawing');
      const drawingPath = drawingTarget ? relativePart('xl/worksheets/sheet1.xml', drawingTarget) : '';
      const drawingRelsPath = drawingPath ? drawingPath.replace('drawings/', 'drawings/_rels/') + '.rels' : '';
      const drawingRels = drawingRelsPath ? await zip.file(drawingRelsPath)?.async('string') || '' : '';
      const chartTarget = relationshipTarget(drawingRels, 'chart');
      const chartPath = chartTarget ? relativePart(drawingPath, chartTarget) : '';
      const chartExists = !!chartPath && !!zip.file(chartPath);
      const hasDrawing = /<drawing\b/.test(sheetXml) && !!drawingTarget && !!drawingPath && !!zip.file(drawingPath);
      const hasChart = hasDrawing && !!chartTarget && chartExists && names.some((name) => /^xl\/drawings\/[^/]+\.xml$/.test(name)) && names.some((name) => /^xl\/charts\/[^/]+\.xml$/.test(name));
      const noChart = !names.some((name) => /^xl\/charts\/[^/]+\.xml$/.test(name)) && !/<drawing\b/.test(sheetXml);
      const metadata = {
        observedAt, status: response.status, bytesLength: response.bytes?.length ?? null,
        names, partNames: names.filter((name) => /xl\/(drawings|charts)\//.test(name)),
        sheetHasDrawingTag: /<drawing\b/.test(sheetXml), drawingTarget, drawingPath, drawingExists: !!drawingPath && !!zip.file(drawingPath),
        sheetRels, drawingRelsPath, chartTarget, chartPath, chartExists, hasChart, noChart,
        sheetXmlDrawingExcerpt: sheetXml.match(/<drawing\b[^>]*\/?\s*>/)?.[0] || '',
      };
      firstArchive ??= metadata;
      lastArchive = metadata;
      return wantChart ? hasChart : noChart;
    };
    const probe = async (): Promise<boolean> => {
      try { return await archiveMatchesExpectation(); }
      catch (error) {
        const metadata = { observedAt: new Date().toISOString(), error: String(error) };
        firstArchive ??= metadata;
        lastArchive = metadata;
        return false;
      }
    };
    const archiveReady = await waitFor(probe, 20000);
    // Keep one final observation after timeout so the failure reports the latest bytes.
    if (!archiveReady) await probe();
    const finalSaveEvents = await frame.locator('body').evaluate((before: number) =>
      ((window as any).__fluxSaveRegressionEvents || []).slice(before), eventsBefore).catch(() => []);
    if (!archiveReady) {
      if (lastArchiveBytes) await writeFile('/tmp/office-native-save-in-place-failure.xlsx', lastArchiveBytes);
      await writeFile('/tmp/office-native-save-in-place-failure.json',
        JSON.stringify({ label, wantChart, firstArchive, lastArchive, saveEvents: finalSaveEvents }, null, 2));
    }
    check(label + ': expected chart state is present in the saved XLSX archive', archiveReady, {
      firstArchive, lastArchive, saveEvents: finalSaveEvents,
    });
    if (!archiveReady) throw new Error(label + ': saved XLSX archive did not reach the expected chart state');
  };
  await saveChartState(false, 'Save after Ctrl+Z');

  await frame.locator('canvas[id^="univer-sheet-main-canvas_"]').first().focus();
  await page().keyboard.press('Control+y');
  const chartRedone = await waitFor(async () => await chartAdds() === 1, 10000);
  check('Ctrl+Y restores the inserted chart to the live workbook journal', chartRedone, {
    chartAdds: await chartAdds(),
    trace: await frame.locator('body').evaluate(() => (window as any).__fluxChartUndoTrace).catch(() => null),
  });
  if (!chartRedone) throw new Error('Ctrl+Y did not redo the chart insertion');
  await saveChartState(true, 'Save after Ctrl+Y');
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
