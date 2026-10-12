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

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function makeMergeWorkbook(conflict: boolean): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await makeXlsx());
  zip.file('xl/sharedStrings.xml', '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2"><si><t>Drive Power</t></si><si><t>Motor Power</t></si></sst>');
  zip.file('xl/worksheets/sheet1.xml', `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>DRIVE_ONLY</t></is></c><c r="B2"${conflict ? ' t="inlineStr"><is><t>MOTOR_CONFLICT</t></is></c>' : '/'}><c r="C2" t="inlineStr"><is><t>OTHER_KEEP</t></is></c></row>
    <row r="3"><c r="A3"${conflict ? ' t="inlineStr"><is><t>DRIVE_CONFLICT</t></is></c>' : '/'}><c r="B3" t="inlineStr"><is><t>MOTOR_ONLY</t></is></c><c r="C3" t="inlineStr"><is><t>MANUAL_KEEP</t></is></c></row>
    <row r="4"><c r="D4"><f>1+1</f><v>2</v></c></row>
  </sheetData></worksheet>`);
  zip.file('xl/workbook.xml', (await zip.file('xl/workbook.xml')!.async('string')).replace(/<definedNames>[\s\S]*?<\/definedNames>/, '<definedNames/>'));
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

async function nativeCell(frame: any, address: string): Promise<any> {
  return frame.locator('body').evaluate((_body: HTMLElement, a1: string) => {
    const api = (window as any).__fluxSheets?.univerRef?.current?.univerAPI;
    return api?.getActiveWorkbook?.()?.getSheets?.().find((sheet: any) => sheet.getSheetName() === 'Перечень')?.getRange(a1)?.getValues?.()?.[0]?.[0];
  }, address).catch(() => undefined);
}

async function nativeFormula(frame: any, address: string): Promise<string> {
  return frame.locator('body').evaluate((_body: HTMLElement, a1: string) => {
    const api = (window as any).__fluxSheets?.univerRef?.current?.univerAPI;
    return String(api?.getActiveWorkbook?.()?.getSheets?.().find((sheet: any) => sheet.getSheetName() === 'Перечень')?.getRange(a1)?.getFormulas?.()?.[0]?.[0] || '');
  }, address).catch(() => '');
}

async function clickCell(frame: any, address: string, modifiers: string[] = [], button: 'left' | 'right' = 'left'): Promise<void> {
  const point = await frame.locator('body').evaluate((_body: HTMLElement, a1: string) => {
    const api = (window as any).__fluxSheets?.univerRef?.current?.univerAPI;
    const sheet = api?.getActiveWorkbook?.()?.getSheets?.().find((item: any) => item.getSheetName() === 'Перечень');
    const canvas = document.querySelector('canvas[id^="univer-sheet-main-canvas_"]') as HTMLCanvasElement | null;
    const cell = sheet?.getRange(a1)?.getCellRect?.();
    const bounds = canvas?.getBoundingClientRect();
    if (!canvas || !cell || !bounds) return null;
    return { x: (Number(cell.left) + Number(cell.width) / 2) * bounds.width / canvas.width, y: (Number(cell.top) + Number(cell.height) / 2) * bounds.height / canvas.height };
  }, address);
  if (!point) throw new Error(`Could not locate native grid cell ${address}`);
  await frame.locator('canvas[id^="univer-sheet-main-canvas_"]').first().click({ position: point, modifiers, button, timeout: 10000 });
}

export async function runNativeSheetCellActions(options: SuiteOptions): Promise<void> {
  const { fixture, folderId, stamp, created, api, raw, upload, check, waitFor, resetPage, navigateOffice, openPanel, waitForSheetFile, clickSheetGrid } = options;
  const page = options.page;
  console.log('\n5. Native Sheets cell actions, fallback merge, stale preview, formula tokens');

  const query = await api('POST', '/api/project-data/office/query', { projectId: fixture.projectId, query: { entity: 'element', columns: ['name'], filters: [], sort: [], limit: 10, excludedEntityIds: [] } });
  const entities = (query.json?.rows || []).slice(0, 2);
  const entityIds = entities.map((row: any) => decodeURIComponent(String(row.entityId || '').split(':').at(-1) || '')).filter(Boolean);
  check('real project fixture exposes two synthetic equipment entities for native alias fields', entityIds.length === 2, entities.map((row: any) => row.entityId));
  const group = `Native Alias ${stamp}`;
  for (const id of entityIds) for (const [key, value] of [['DrivePower', '120'], ['MotorPower', '95']]) {
    const changed = await api('POST', `/api/equipment/component/${encodeURIComponent(id)}/override`, { group, key, value });
    check(`synthetic catalog fixture defines ${key} on ${id}`, changed.status === 200, changed.json);
  }
  const aliases = await api('PUT', '/api/project-data/aliases', { projectId: fixture.projectId, aliases: [
    { name: 'DrivePower', unit: 'kW', members: [`${group}|DrivePower`] },
    { name: 'MotorPower', unit: 'kW', members: [`${group}|MotorPower`] },
  ] });
  const catalog = await api('GET', `/api/project-data/catalog?projectId=${encodeURIComponent(fixture.projectId)}`);
  check('DrivePower and MotorPower are actual aliases in the disposable project catalog', aliases.status === 200 && catalog.json?.aliases?.some((field: any) => field.path === 'param:@DrivePower') && catalog.json?.aliases?.some((field: any) => field.path === 'param:@MotorPower'), catalog.json?.aliases);

  const prepare = async (suffix: string, conflict: boolean) => {
    const fileId = await upload(folderId, `__native_cell_actions_${stamp}_${suffix}.xlsx`, 'XLSX', await makeMergeWorkbook(conflict));
    if (fileId) created.push(fileId);
    await resetPage(false);
    await navigateOffice(page(), `/office-sheet?file=${encodeURIComponent(fileId)}`);
    const frame = await openPanel(page(), 'Flux Office — Таблица');
    const panel = page().getByRole('complementary', { name: 'Flux Office' });
    check(`${suffix}: actual merge workbook opened in native Sheets`, await waitForSheetFile(frame));
    await clickSheetGrid(frame);
    const nameBox = frame.locator('input.univer-box-border').first();
    const bind = async (address: string, alias: string) => {
      await nameBox.fill(address); await nameBox.press('Enter');
      await clickCell(frame, address);
      await page().getByRole('button', { name: /2\. Поля и шапка/ }).click();
      await panel.getByLabel('Найти поле Flux').fill(alias);
      await panel.getByRole('button', { name: new RegExp(`^${alias}(\\s|$)`) }).click();
      await waitFor(async () => panel.getByRole('button', { name: 'Привязать поле' }).isEnabled());
      await panel.getByRole('button', { name: 'Привязать поле' }).click();
      const boundOk = await waitFor(async () => (await api('GET', `/api/project-data/files/${fileId}/office-state`)).json?.schema?.anchors?.some((anchor: any) => anchor.address === address && anchor.parts?.some((part: any) => part.kind === 'field' && part.binding?.fieldKey === 'param:@' + alias)));
      if (!boundOk) console.error('BIND_DIAGNOSTIC', address, JSON.stringify({ state: (await api('GET', `/api/project-data/files/${fileId}/office-state`)).json?.schema, toasts: await page().locator('[role="status"],[role="alert"]').allTextContents().catch(() => []), cell: await nativeCell(frame, address) }));
      check(`${suffix}: ${address} is bound to the real ${alias} alias`, boundOk);
      // Привязка меняет только часть Flux: книга остаётся открытой в том же окне
      await waitForSheetFile(frame);
    };
    await bind('A1', 'DrivePower');
    if (suffix === 'conflict') {
      // Окно не переоткрывалось, и история «назад» цела: Ctrl+Z отменяет вставку метки в ячейке
      check(`${suffix}: A1 holds the inserted alias label before undo`, await waitFor(async () => await nativeCell(frame, 'A1') === 'DrivePower'), await nativeCell(frame, 'A1'));
      // Фокус — щелчком по соседней ячейке: повторный щелчок по уже выделенной метке открывает редактор ячейки
      await clickCell(frame, 'D3');
      await page().keyboard.press('Control+z');
      check(`${suffix}: native Ctrl+Z after binding restores the cell text from before the label`, await waitFor(async () => await nativeCell(frame, 'A1') === 'Drive Power'), await nativeCell(frame, 'A1'));
      await page().keyboard.press('Control+Shift+z');
      check(`${suffix}: native redo returns the inserted label`, await waitFor(async () => await nativeCell(frame, 'A1') === 'DrivePower'), await nativeCell(frame, 'A1'));
    }
    await bind('B1', 'MotorPower');
    await page().keyboard.press('Control+s');
    await waitForSheetFile(frame);
    let state = (await api('GET', `/api/project-data/files/${fileId}/office-state`)).json;
    const anchors = state?.schema?.anchors || [];
    const a = anchors.find((anchor: any) => anchor.address === 'A1');
    const b = anchors.find((anchor: any) => anchor.address === 'B1');
    if (a && b) {
      const seededRows = entities.map((entity: any, index: number) => ({ entityId: entity.entityId, entityType: 'element', sourceId: 'equipment', sourceRevision: state.sourceRevision, anchorIds: [a.id, b.id], cells: { [a.id]: index === 0 ? 'A2' : 'A3', [b.id]: index === 0 ? 'B2' : 'B3' }, values: { [a.id]: index === 0 ? 'DRIVE_ONLY' : '', [b.id]: index === 0 ? '' : 'MOTOR_ONLY' } }));
      const stored = await api('PUT', `/api/project-data/files/${fileId}/office-state`, { baseHash: state.baseHash, sourceRevision: state.sourceRevision, schema: state.schema, rows: seededRows });
      check(`${suffix}: row identities map both native cells without changing the workbook`, stored.status === 200 && stored.json?.ok, stored.json);
      state = (await api('GET', `/api/project-data/files/${fileId}/office-state`)).json;
      // Запись схемы и строк меняет только часть Flux: окно остаётся тем же и переоткрывать его не нужно.
    }
    return { fileId, frame, panel, state, a, b };
  };

  const conflict = await prepare('conflict', true);
  const conflictBefore = await raw('GET', `/api/files/${conflict.fileId}/raw`);
  await clickCell(conflict.frame, 'A1');
  await clickCell(conflict.frame, 'B1', ['Control']);
  await clickCell(conflict.frame, 'B1', [], 'right');
  const conflictDialog = page().getByRole('dialog', { name: 'Действия с заголовочными ячейками' });
  await conflictDialog.waitFor();
  check('native Ctrl-click selection opens the separate Flux dialog with both selected aliases', await conflictDialog.getByText(/DrivePower · equipment/).count() > 0 && await conflictDialog.getByText(/MotorPower · equipment/).count() > 0);
  await conflictDialog.getByLabel('Имя выходного заголовка').fill('Power');
  await conflictDialog.getByRole('button', { name: 'Проверить объединение' }).click();
  const conflictVisible = await waitFor(async () => await conflictDialog.getByRole('alert').filter({ hasText: /конфликт|разные непустые/i }).count() > 0);
  check('two different nonempty native rows are reported as conflicts and confirmation is blocked', conflictVisible && !await conflictDialog.getByRole('button', { name: 'Подтвердить объединение' }).isEnabled());
  const conflictAfter = await raw('GET', `/api/files/${conflict.fileId}/raw`);
  check('rejected conflicting merge leaves the saved XLSX bytes unchanged', hash(conflictBefore.bytes) === hash(conflictAfter.bytes));
  await conflictDialog.getByRole('button', { name: 'Закрыть', exact: true }).click();

  // Правый щелчок внутри выделенной пары сохраняет пару, как в самом Univer:
  // для одной ячейки сначала сворачиваем выделение обычным щелчком.
  await clickCell(conflict.frame, 'A1');
  await clickCell(conflict.frame, 'A1', [], 'right');
  const formulaDialog = page().getByRole('dialog', { name: 'Действия с заголовочными ячейками' });
  await formulaDialog.waitFor();
  await formulaDialog.getByRole('button', { name: 'Редактировать формулу в ячейке' }).click();
  const formulaEditor = conflict.frame.locator('#flux-sheet-token-overlay .flux-sheet-token-edit');
  await formulaEditor.waitFor();
  await formulaEditor.evaluate((host: HTMLElement) => {
    const chip = host.querySelector('.flux-sheet-token-chip');
    if (!chip) return;
    const range = document.createRange(); range.setStartBefore(chip); range.collapse(true);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  });
  await formulaEditor.pressSequentially('=');
  await formulaEditor.press('ArrowRight');
  await formulaEditor.pressSequentially('+');
  // Правый щелчок в пустом месте за последним знаком ставит точку вставки в конец формулы (на последней строке, если текст перенесён).
  const editorBox = await formulaEditor.boundingBox();
  await formulaEditor.click({ button: 'right', position: { x: Math.max(1, (editorBox?.width || 8) - 4), y: Math.max(1, (editorBox?.height || 14) - 6) } });
  // Правый щелчок в окне формулы открывает малое меню; диалог — его пункт.
  await conflict.frame.getByRole('menuitem', { name: 'Действия заголовка' }).click();
  const insertDialog = page().getByRole('dialog', { name: 'Действия с заголовочными ячейками' });
  await insertDialog.waitFor();
  check('right-click in the active formula overlay opens a separate dialog with the same cell and live field part', await insertDialog.getByText(/Активная ячейка.*A1/).count() > 0 && await insertDialog.getByText(/DrivePower · equipment/).count() > 0);
  await insertDialog.getByLabel('Параметр из каталога').selectOption({ label: 'MotorPower · equipment' });
  await insertDialog.getByRole('button', { name: 'Вставить метку' }).click();
  await formulaEditor.waitFor();
  await formulaEditor.pressSequentially(' end');
  const tokenTexts = await formulaEditor.locator('.flux-sheet-token-chip').allTextContents();
  check('in-cell formula keeps two individually protected parameter aliases and operator/text around them', tokenTexts.length === 2 && tokenTexts.some((text: string) => text.includes('DrivePower')) && tokenTexts.some((text: string) => text.includes('MotorPower')) && (await formulaEditor.innerText()).includes('=') && (await formulaEditor.innerText()).includes('+') && (await formulaEditor.innerText()).includes('end'), { tokenTexts, text: await formulaEditor.innerText() });
  await formulaEditor.locator('.flux-sheet-token-chip').first().click();
  await page().keyboard.type('BROKEN');
  check('keyboard text at a protected token cannot mutate the chip label', (await formulaEditor.locator('.flux-sheet-token-chip').allTextContents()).some((text: string) => text.includes('DrivePower')));
  await formulaEditor.press('Enter');
  check('native Enter commits formula text and two alias bindings into document state', await waitFor(async () => {
    const state = (await api('GET', `/api/project-data/files/${conflict.fileId}/office-state`)).json;
    const anchor = state?.schema?.anchors?.find((item: any) => item.id === conflict.a?.id);
    return anchor?.parts?.filter((part: any) => part.kind === 'field').length === 2 && anchor.parts.some((part: any) => part.kind === 'operator' && part.operator === '+') && await nativeCell(conflict.frame, 'A1') === '=DrivePower+MotorPower end';
  }));
  await page().keyboard.press('Control+s');
  // Запись асинхронна: закрывать страницу можно, когда формула уже лежит в файле
  await waitFor(async () => {
    const zip = await JSZip.loadAsync((await raw('GET', `/api/files/${conflict.fileId}/raw`)).bytes);
    return `${await zip.file('xl/sharedStrings.xml')?.async('string') || ''}${await zip.file('xl/worksheets/sheet1.xml')?.async('string') || ''}`.includes('=DrivePower+MotorPower end');
  });
  await resetPage(false);
  await navigateOffice(page(), `/office-sheet?file=${encodeURIComponent(conflict.fileId)}`);
  const reopenedFormulaFrame = await openPanel(page(), 'Flux Office — Таблица');
  const reopenedLoaded = await waitForSheetFile(reopenedFormulaFrame);
  // Правки сеанса применяются к открытой книге с небольшой задержкой: ждём формулу, а не читаем сразу
  await waitFor(async () => await nativeCell(reopenedFormulaFrame, 'A1') === '=DrivePower+MotorPower end');
  const reopenedA1 = await nativeCell(reopenedFormulaFrame, 'A1');
  const reopenedFields = (await api('GET', `/api/project-data/files/${conflict.fileId}/office-state`)).json?.schema?.anchors?.find((item: any) => item.id === conflict.a?.id)?.parts?.filter((part: any) => part.kind === 'field').length;
  check('formula and protected alias parts survive save and actual native reopen', reopenedLoaded && reopenedA1 === '=DrivePower+MotorPower end' && reopenedFields === 2, { reopenedLoaded, reopenedA1, reopenedFields });
  const formulaPackage = await JSZip.loadAsync((await raw('GET', `/api/files/${conflict.fileId}/raw`)).bytes);
  const formulaParts = `${await formulaPackage.file('xl/sharedStrings.xml')?.async('string') || ''}${await formulaPackage.file('xl/worksheets/sheet1.xml')?.async('string') || ''}`;
  check('saved XLSX XML retains formula text and the two source alias labels', formulaParts.includes('=DrivePower+MotorPower end') && formulaParts.includes('DrivePower') && formulaParts.includes('MotorPower'));

  const success = await prepare('fallback', false);
  const { frame, panel, fileId, a, b } = success;
  const premergeBytes = await raw('GET', `/api/files/${fileId}/raw`);
  await clickCell(frame, 'A1');
  await clickCell(frame, 'B1', ['Control']);
  await clickCell(frame, 'B1', [], 'right');
  const dialog = page().getByRole('dialog', { name: 'Действия с заголовочными ячейками' });
  await dialog.waitFor();
  check('native merge dialog preserves selected anchor priority and alternatives', await dialog.getByText(/Выходная ячейка.*A1/).count() > 0 && await dialog.getByText(/Вторая ячейка.*B1/).count() > 0 && await dialog.getByText(/DrivePower · equipment/).count() > 0 && await dialog.getByText(/MotorPower · equipment/).count() > 0);
  await dialog.getByLabel('Имя выходного заголовка').fill('DrivePower / MotorPower');
  await dialog.getByRole('button', { name: 'Проверить объединение' }).click();
  check('native merge preview confirms one-sided fallback rows are transferable', await waitFor(async () => await dialog.getByRole('status').filter({ hasText: /Конфликтов ручных значений не найдено/ }).count() > 0));

  await frame.locator('body').evaluate(() => {
    const api = (window as any).__fluxSheets?.univerRef?.current?.univerAPI;
    const sheet = api?.getActiveWorkbook?.()?.getSheets?.().find((item: any) => item.getSheetName() === 'Перечень');
    sheet?.getRange('C6')?.setValue('STALE_PREVIEW_KEEP');
  });
  await dialog.getByRole('button', { name: 'Подтвердить объединение' }).click();
  check('stale native preview is rejected after an underlying manual cell edit', await waitFor(async () => await dialog.getByRole('alert').filter({ hasText: /изменил|повторите/i }).count() > 0) && await nativeCell(frame, 'B1') === 'MotorPower' && ((await nativeCell(frame, 'A3')) ?? '') === '');

  await dialog.getByRole('button', { name: 'Проверить объединение' }).click();
  await waitFor(async () => await dialog.getByRole('button', { name: 'Подтвердить объединение' }).isEnabled());
  await dialog.getByRole('button', { name: 'Подтвердить объединение' }).click();
  check('confirmed native merge keeps only the output anchor and stores prioritized alias bindings', await waitFor(async () => {
    const state = (await api('GET', `/api/project-data/files/${fileId}/office-state`)).json;
    return state?.schema?.anchors?.length === 1 && state.schema.anchors[0].id === a?.id && state.schema.anchors[0].parts?.[0]?.kind === 'union' && state.schema.anchors[0].parts[0].alternatives?.map((item: any) => item.fieldKey).join(',') === 'param:@DrivePower,param:@MotorPower';
  }));
  await waitForSheetFile(frame);
  check('native fallback copies source-only data and retains unrelated text and formula cells', await nativeCell(frame, 'A2') === 'DRIVE_ONLY' && await nativeCell(frame, 'A3') === 'MOTOR_ONLY' && await nativeCell(frame, 'B2') === 'OTHER_KEEP' && await nativeCell(frame, 'B3') === 'MANUAL_KEEP' && await nativeCell(frame, 'B6') === 'STALE_PREVIEW_KEEP' && (await nativeFormula(frame, 'C4')).replace(/^=/, '') === '1+1');
  const mergedState = (await api('GET', `/api/project-data/files/${fileId}/office-state`)).json;
  check('stored row identities lose only the removed anchor and retain transferred values', mergedState?.rows?.length === 2 && mergedState.rows.every((row: any) => row.anchorIds?.length === 1 && row.anchorIds[0] === a?.id && !row.cells?.[b?.id] && !row.values?.[b?.id]) && mergedState.rows.find((row: any) => row.entityId === entities[0].entityId)?.values?.[a?.id] === 'DRIVE_ONLY' && mergedState.rows.find((row: any) => row.entityId === entities[1].entityId)?.values?.[a?.id] === 'MOTOR_ONLY', mergedState?.rows);
  await page().keyboard.press('Control+z');
  const mergeUndone = await waitFor(async () => await nativeCell(frame, 'A1') === 'DrivePower' && await nativeCell(frame, 'B1') === 'MotorPower' && ((await nativeCell(frame, 'A3')) ?? '') === '' && await nativeCell(frame, 'B3') === 'MOTOR_ONLY');
  check('one native Ctrl+Z restores both original header columns and their cell values', mergeUndone, { a1: await nativeCell(frame, 'A1'), b1: await nativeCell(frame, 'B1'), a3: await nativeCell(frame, 'A3'), b3: await nativeCell(frame, 'B3') });
  if (mergeUndone) {
    await page().keyboard.press('Control+Shift+z');
    check('native redo reapplies the confirmed merge as one operation', await waitFor(async () => await nativeCell(frame, 'A1') === 'DrivePower / MotorPower' && await nativeCell(frame, 'A3') === 'MOTOR_ONLY' && !String(await nativeCell(frame, 'B1') || '')));
  }
  await page().keyboard.press('Control+s');
  // Запись асинхронна: ждём, пока файл на сервере станет другим, а не читаем его сразу после нажатия
  await waitFor(async () => hash((await raw('GET', `/api/files/${fileId}/raw`)).bytes) !== hash(premergeBytes.bytes));
  const saved = await raw('GET', `/api/files/${fileId}/raw`);
  check('saved XLSX serializes merged fallback values, other-column data, and formula', hash(saved.bytes) !== hash(premergeBytes.bytes) && (await nativeFormula(frame, 'C4')).replace(/^=/, '') === '1+1');

}
