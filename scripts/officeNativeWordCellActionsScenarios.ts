import JSZip from 'jszip';
import { makeDocxWithTable } from './officeHarness';

type WordScenarioOptions = {
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
  page: () => any;
};

function wordCell(text: string): string {
  const content = text ? `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>` : '';
  return `<w:tc><w:tcPr><w:tcW w:w="3600" w:type="dxa"/></w:tcPr><w:p>${content}</w:p></w:tc>`;
}

async function makeMergeDocx(conflict: boolean): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await makeDocxWithTable());
  const xml = await zip.file('word/document.xml')!.async('string');
  const row = (left: string, right: string) => `<w:tr>${wordCell(left)}${wordCell(right)}</w:tr>`;
  const rows = [
    row('Drive Power', 'Motor Power'),
    row('', 'SOURCE_ONLY'),
    row('TARGET_ONLY', ''),
    row('SAME_KEEP', 'SAME_KEEP'),
    ...(conflict ? [row('TARGET_CONFLICT', 'SOURCE_CONFLICT')] : []),
  ].join('');
  const table = `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3600"/><w:gridCol w:w="3600"/></w:tblGrid>${rows}</w:tbl>`;
  zip.file('word/document.xml', xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/, table));
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

export async function runNativeWordCellActions(options: WordScenarioOptions): Promise<void> {
  const { fixture, folderId, stamp, created, api, raw, upload, check, waitFor, resetPage, navigateOffice, openPanel } = options;
  const page = options.page;
  console.log('\n6. Native Word cell actions, merge conflicts, fallback, formula marks');

  const makeBoundDoc = async (suffix: string, conflict: boolean) => {
    const fileId = await upload(folderId, `__native_word_actions_${stamp}_${suffix}.docx`, 'DOCX', await makeMergeDocx(conflict));
    if (fileId) created.push(fileId);
    await resetPage(false);
    await navigateOffice(page(), `/office-doc?file=${encodeURIComponent(fileId)}`);
    const frame = await openPanel(page(), 'Flux Office — Документ');
    const editor = frame.locator('.ProseMirror').first();
    await editor.waitFor({ timeout: 15000 });
    const bind = async (index: number, alias: string) => {
      const cell = editor.locator('table tr').first().locator('td,th').nth(index);
      await cell.click();
      await page().getByRole('button', { name: /2\. Поля и шапка/ }).click();
      const panel = page().getByRole('complementary', { name: 'Flux Office' });
      await panel.getByLabel('Найти поле Flux').fill(alias);
      await panel.getByRole('button', { name: new RegExp(`^${alias}(\\s|$)`) }).click();
      await waitFor(async () => panel.getByRole('button', { name: 'Привязать поле' }).isEnabled());
      await panel.getByRole('button', { name: 'Привязать поле' }).click();
      check(`${suffix}: native Word ${index ? 'B1' : 'A1'} is bound to ${alias}`, await waitFor(async () => {
        const state = (await api('GET', `/api/project-data/files/${fileId}/office-state`)).json;
        return state?.schema?.anchors?.some((anchor: any) => anchor.kind === 'word-row' && anchor.parts?.some((part: any) => part.kind === 'field' && part.binding?.fieldKey === `param:@${alias}`));
      }));
    };
    await bind(0, 'DrivePower');
    if (suffix === 'conflict') {
      // Привязка меняет только часть Flux, окно не переоткрывается: Ctrl+Z отменяет вставку метки в ячейке
      const cellA1 = editor.locator('table tr').first().locator('td,th').nth(0);
      const marks = () => cellA1.locator('[data-instr-field*="flux:"]').count();
      check(`${suffix}: A1 holds the inserted Flux mark before undo`, await waitFor(async () => await marks() === 1));
      await cellA1.click({ position: { x: 6, y: 6 } });
      await page().keyboard.press('Control+z');
      check(`${suffix}: native Word Ctrl+Z after binding removes the inserted mark`, await waitFor(async () => await marks() === 0), await cellA1.innerText());
      await page().keyboard.press('Control+Shift+z');
      check(`${suffix}: native Word redo returns the inserted mark`, await waitFor(async () => await marks() === 1));
    }
    await bind(1, 'MotorPower');
    return { fileId, frame, editor };
  };

  const selectAndOpen = async (editor: any) => {
    const first = editor.locator('table tr').first().locator('td,th').nth(0);
    const second = editor.locator('table tr').first().locator('td,th').nth(1);
    await first.scrollIntoViewIfNeeded();
    // Первый щелчок в редакторе сам сдвигает раскладку (замер дал сдвиг на 16 px между
    // жестами), поэтому сначала даём фокус, а стабильность замеряем уже после него.
    await first.click({ position: { x: 6, y: 6 } });
    // Раскладка Word сдвигается после открытия: ждём два одинаковых замера подряд.
    const bounds = async () => ({ a: await first.boundingBox(), b: await second.boundingBox() });
    let { a, b } = await bounds();
    for (let i = 0; i < 20; i++) {
      await page().waitForTimeout(150);
      const next = await bounds();
      const same = !!a && !!b && !!next.a && !!next.b && JSON.stringify([a, b]) === JSON.stringify([next.a, next.b]);
      a = next.a; b = next.b;
      if (same) break;
    }
    if (!a || !b) throw new Error('Word header cells have no native bounds');
    // В центре ячейки стоит метка поля: жест от неё уходит во вторую строку и даёт выделение 2x2.
    // Поэтому берём левое поле ячейки, где метки нет.
    const gesture = async () => {
      const f = await bounds();
      if (!f.a || !f.b) throw new Error('Word header cells have no native bounds');
      await page().mouse.move(f.a.x + 6, f.a.y + f.a.height / 2);
      await page().mouse.down();
      await page().mouse.move(f.b.x + 6, f.b.y + f.b.height / 2, { steps: 5 });
      await page().mouse.up();
      // constructor.name ломается минификацией, поэтому смотрим на тип в JSON и считаем ячейки.
      return await editor.evaluate(() => {
        const sel = (window as any).__fluxCtxRef?.current?.editor?.state?.selection;
        let cells = 0; sel?.forEachCell?.(() => { cells++; });
        return { type: sel?.toJSON?.().type || '', cells };
      });
    };
    let selection = await gesture();
    if (!(selection.type === 'cell' && selection.cells === 2)) selection = await gesture();
    check('real Word table gesture selects both neighboring cells as a CellSelection', selection.type === 'cell' && selection.cells === 2, JSON.stringify(selection));
    // Правая кнопка по левому полю ячейки: в центре стоит метка поля со своим контекстным меню.
    const fresh = await second.boundingBox();
    if (!fresh) throw new Error('Word header cell B1 has no native bounds');
    await page().mouse.click(fresh.x + 6, fresh.y + fresh.height / 2, { button: 'right' });
    const mergeItem = page().getByRole('button', { name: 'Объединить', exact: true });
    await mergeItem.waitFor({ timeout: 10000 });
    check('native right-click on two selected Word cells opens a small menu with one Merge item and no dialog', await page().getByRole('dialog', { name: 'Действия с заголовочными ячейками' }).count() === 0 && await page().getByLabel('Имя выходного заголовка').count() === 0);
    return mergeItem;
  };

  const conflict = await makeBoundDoc('conflict', true);
  const conflictBytes = await raw('GET', `/api/files/${encodeURIComponent(conflict.fileId)}/raw`);
  const conflictMerge = await selectAndOpen(conflict.editor);
  await conflictMerge.click();
  const conflictDialog = page().getByRole('dialog', { name: 'Объединение не выполнено' });
  await conflictDialog.waitFor();
  const conflictsVisible = await waitFor(async () => await conflictDialog.getByRole('alert').filter({ hasText: /конфликт|разные непустые/i }).count() > 0);
  check('Word merge explains differing manual values and writes nothing', conflictsVisible && await page().getByRole('button', { name: /Подтвердить объединение|Проверить объединение/ }).count() === 0);
  const afterConflict = await raw('GET', `/api/files/${encodeURIComponent(conflict.fileId)}/raw`);
  check('rejected Word conflict leaves the saved DOCX byte-for-byte unchanged', conflictBytes.bytes.equals(afterConflict.bytes));
  await conflictDialog.getByRole('button', { name: 'Закрыть', exact: true }).click();

  const success = await makeBoundDoc('fallback', false);
  // Строки документа, уже внесённые в него: по ним плашка находит позиции, где заполнены оба параметра
  const rowsQuery = await api('POST', '/api/project-data/office/query', { projectId: fixture.projectId, query: { entity: 'element', columns: ['name'], filters: [], sort: [], limit: 10, excludedEntityIds: [] } });
  const seedEntities = (rowsQuery.json?.rows || []).slice(0, 2);
  const seeded = (await api('GET', `/api/project-data/files/${success.fileId}/office-state`)).json;
  await api('PUT', `/api/project-data/files/${success.fileId}/office-state`, { baseHash: seeded.baseHash, sourceRevision: seeded.sourceRevision, schema: seeded.schema,
    rows: seedEntities.map((entity: any) => ({ entityId: entity.entityId, entityType: 'element', sourceId: 'equipment', sourceRevision: seeded.sourceRevision, anchorIds: [seeded.schema.anchors[0].id] })) });
  const mergeItem = await selectAndOpen(success.editor);
  await mergeItem.click();
  const merged = await waitFor(async () => {
    const state = (await api('GET', `/api/project-data/files/${success.fileId}/office-state`)).json;
    return state?.schema?.anchors?.length === 1 && state.schema.anchors[0].parts?.[0]?.kind === 'union' && state.schema.anchors[0].parts[0].alternatives?.map((item: any) => item.fieldKey).join(',') === 'param:@DrivePower,param:@MotorPower';
  });
  check('Word confirmation saves one prioritized output anchor with both aliases', merged, (await api('GET', `/api/project-data/files/${success.fileId}/office-state`)).json?.schema);
  check('native Word table merge leaves one physical column and transfers source-only text while preserving manual values', await waitFor(async () => {
    const xml = await raw('GET', `/api/files/${encodeURIComponent(success.fileId)}/raw`);
    const zip = await JSZip.loadAsync(xml.bytes); const document = await zip.file('word/document.xml')!.async('string');
    const table = document.match(/<w:tbl>[\s\S]*?<\/w:tbl>/)?.[0] || '';
    const cells = table.match(/<w:tc>/g)?.length || 0;
    return cells === 4 && /SOURCE_ONLY/.test(document) && /TARGET_ONLY/.test(document) && /SAME_KEEP/.test(document) && !/Motor Power/.test(document);
  }));
  await page().keyboard.press('Control+z');
  const mergeUndo = await waitFor(async () => await success.editor.locator('table tr').first().locator('td,th').count() === 2);
  check('one native Word Ctrl+Z restores the removed source header cell', mergeUndo);
  if (mergeUndo) {
    await page().keyboard.press('Control+Shift+z');
    check('native Word redo reapplies the single-column merge', await waitFor(async () => await success.editor.locator('table tr').first().locator('td,th').count() === 1));
  }
  await page().keyboard.press('Control+s');
  const savedWord = await raw('GET', `/api/files/${encodeURIComponent(success.fileId)}/raw`);
  const savedZip = await JSZip.loadAsync(savedWord.bytes);
  const savedXml = await savedZip.file('word/document.xml')!.async('string');
  check('merged Word union header and transferred manual rows persist in saved OOXML', /DrivePower\s*\/\s*MotorPower/.test(savedXml) && savedXml.includes('SOURCE_ONLY') && savedXml.includes('TARGET_ONLY') && savedXml.includes('SAME_KEEP'));

  const wordBadge = page().getByRole('group', { name: 'Приоритет объединения' });
  check('Word merge goes through in one action and a short badge says both parameters are filled for 2 positions', await wordBadge.waitFor().then(() => true, () => false) && /У 2 позиций заполнены оба параметра/.test(await wordBadge.innerText())
    && await wordBadge.getByRole('button', { name: 'Брать DrivePower' }).count() === 1 && await wordBadge.getByRole('button', { name: 'Брать MotorPower' }).count() === 1 && await wordBadge.getByRole('button', { name: 'Выбрать по каждой' }).count() === 1);
  await page().screenshot({ path: '/tmp/merge-badge-word.png' });
  await wordBadge.getByRole('button', { name: 'Брать MotorPower' }).click();
  const planFor = async () => {
    const state = (await api('GET', `/api/project-data/files/${success.fileId}/office-state`)).json;
    const query = { entity: 'element', columns: ['param:@DrivePower', 'param:@MotorPower'], filters: [], sort: [], limit: 1000, excludedEntityIds: [] };
    const data = await api('POST', '/api/project-data/office/query', { projectId: fixture.projectId, query });
    return (await api('POST', `/api/project-data/files/${success.fileId}/preview`, { projectId: fixture.projectId, baseHash: state.baseHash, sourceRevision: data.json?.revision, selectedEntityIds: seedEntities.map((entity: any) => entity.entityId), query, schema: state.schema })).json;
  };
  check('Word "Брать MotorPower" stores the choice and refresh plan takes 95 for every position', await waitFor(async () => {
    const part = (await api('GET', `/api/project-data/files/${success.fileId}/office-state`)).json?.schema?.anchors?.[0]?.parts?.[0];
    return part?.resolved === true && part.alternatives?.slice().sort((x: any, y: any) => x.priority - y.priority)[0]?.fieldKey === 'param:@MotorPower';
  }) && ((await planFor())?.writes || []).length === 2 && ((await planFor()).writes as any[]).every((write: any) => /^95\b/.test(String(write.value))));
  // Своё имя объединённой колонки Word: в тексте шапки, в схеме, после повторного открытия; данные по ключам
  const mergedCell = success.editor.locator('table tr').first().locator('td,th').nth(0);
  await mergedCell.click({ position: { x: 6, y: 6 } });
  await mergedCell.evaluate((cell: HTMLElement) => {
    const box = cell.getBoundingClientRect();
    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: box.left + 6, clientY: box.top + box.height / 2 }));
  });
  await page().getByRole('button', { name: /^Переименовать/ }).click();
  const wordRename = page().getByRole('dialog', { name: 'Переименовать' });
  await wordRename.getByLabel('Отображаемое имя').fill('Мощность, кВт');
  await wordRename.getByRole('button', { name: 'Сохранить' }).click();
  const wordLabel = async () => (await api('GET', `/api/project-data/files/${success.fileId}/office-state`)).json?.schema?.anchors?.[0]?.parts?.[0]?.label;
  check('Word own name is stored in the union and shown in the header cell', await waitFor(async () => await wordLabel() === 'Мощность, кВт' && (await mergedCell.innerText()).includes('Мощность, кВт')), await mergedCell.innerText());
  await page().screenshot({ path: '/tmp/chip-rename-word.png' });
  await page().keyboard.press('Control+s');
  await page().waitForTimeout(2500);
  await resetPage(false);
  await navigateOffice(page(), `/office-doc?file=${encodeURIComponent(success.fileId)}`);
  const reopenedMerged = await openPanel(page(), 'Flux Office — Документ');
  const reopenedMergedEditor = reopenedMerged.locator('.ProseMirror').first();
  await reopenedMergedEditor.waitFor({ timeout: 15000 });
  check('Word own name survives save and actual reopen and does not break the refresh plan', await waitFor(async () => (await reopenedMergedEditor.locator('table tr').first().locator('td,th').nth(0).innerText()).includes('Мощность, кВт')) && await wordLabel() === 'Мощность, кВт'
    && ((await planFor())?.writes || []).length === 2 && ((await planFor()).writes as any[]).every((write: any) => /^95\b/.test(String(write.value))));

  const formula = await makeBoundDoc('formula', false);
  const first = formula.editor.locator('table tr').first().locator('td,th').nth(0);
  // Ввод прямо в ячейке, без окна формулы: «=» печатается перед меткой обычной клавишей
  await first.scrollIntoViewIfNeeded();
  const nativeEditor = formula.editor.locator('table tr').first().locator('td,th').nth(0);
  const nativeToken = nativeEditor.locator('[data-instr-field*="flux:"]');
  await nativeToken.first().waitFor();
  // Фокус в редакторе: выделение, заданное из страницы, без фокуса не принимает набор
  await nativeEditor.click({ position: { x: 6, y: 6 } });
  await nativeEditor.evaluate((cell: HTMLElement) => {
    const field = cell.querySelector('[data-instr-field*="flux:"]');
    if (!field) return;
    // Исходная подпись ячейки «Drive Power» выделена и заменяется набранным «=», метка остаётся
    const range = document.createRange(); range.setStart(field.closest('p') || field.parentNode!, 0); range.setEndBefore(field);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  });
  await page().keyboard.type('=');
  check('Word cell takes a leading equals sign typed directly before the protected field mark', await waitFor(async () => (await nativeEditor.innerText()).startsWith('=') && await nativeToken.count() === 1), { text: await nativeEditor.innerText(), tokens: await nativeToken.count() });
  const stateBeforeInsert = (await api('GET', `/api/project-data/files/${formula.fileId}/office-state`)).json;
  const anchorId = stateBeforeInsert?.schema?.anchors?.find((anchor: any) => anchor.parts?.some((part: any) => part.kind === 'field' && part.binding?.fieldKey === 'param:@DrivePower'))?.id;
  // Метка встаёт в позицию курсора: ставим его в конец текста ячейки и открываем диалог оттуда
  await nativeEditor.evaluate((cell: HTMLElement) => {
    const paragraph = cell.querySelector('p') || cell;
    const range = document.createRange(); range.selectNodeContents(paragraph); range.collapse(false);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  });
  // Контекстное меню клавишей меню: настоящий правый щелчок перенёс бы курсор
  await nativeEditor.evaluate((cell: HTMLElement) => {
    const box = cell.getBoundingClientRect();
    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: box.right - 6, clientY: box.top + box.height / 2 }));
  });
  await page().getByRole('button', { name: 'Вставить параметр…' }).click();
  const insertDialog = page().getByRole('dialog', { name: 'Действия с заголовочными ячейками' });
  await insertDialog.waitFor();
  await insertDialog.getByLabel('Параметр из каталога').selectOption({ label: 'MotorPower · equipment' });
  await insertDialog.getByRole('button', { name: 'Вставить метку' }).click();
  check('Word dialog inserts the second protected parameter into the same native formula', await waitFor(async () => {
    const state = (await api('GET', `/api/project-data/files/${formula.fileId}/office-state`)).json;
    return state?.schema?.anchors?.find((anchor: any) => anchor.id === anchorId)?.parts?.filter((part: any) => part.kind === 'field').length === 2 && await nativeEditor.locator('[data-instr-field*="flux:"]').count() === 2;
  }));
  const chips = nativeEditor.locator('[data-instr-field*="flux:"]');
  const labelsBefore = await chips.allTextContents();
  const chipAttributes = await chips.evaluateAll((els: HTMLElement[]) => els.map((el) => ({ editable: el.getAttribute('contenteditable'), instruction: el.getAttribute('data-instr-field') })));
  const typeAt = async (where: 'before' | 'between' | 'after', text: string) => {
    // Курсор ставим в состоянии редактора: между двумя нередактируемыми метками DOM-выделение неоднозначно
    await nativeEditor.evaluate((_cell: HTMLElement, position: string) => {
      const editor = (window as any).__fluxCtxRef?.current?.editor;
      const ranges: Array<{ from: number; to: number }> = [];
      editor.state.doc.descendants((node: any, pos: number) => { if (node.isText && node.marks.some((mark: any) => mark.type.name === 'instrField')) ranges.push({ from: pos, to: pos + node.nodeSize }); });
      // Только метки абзаца первой ячейки: в соседней ячейке тоже есть метка
      const own = ranges.filter((range) => editor.state.doc.resolve(range.from).start() === editor.state.doc.resolve(ranges[0]!.from).start());
      ranges.splice(0, ranges.length, ...own);
      const target = position === 'before' ? ranges[0]!.from : position === 'between' ? ranges[0]!.to : ranges[ranges.length - 1]!.to;
      editor.commands.setTextSelection(target);
      editor.view.focus();
    }, where);
    await page().keyboard.type(text);
  };
  await typeAt('before', '(');
  await typeAt('between', '+');
  await typeAt('after', ')');
  const formulaText = await nativeEditor.innerText();
  check('Word native typing places text before, between, and after parameter marks without changing either chip', formulaText === '=(DrivePower+MotorPower)' && JSON.stringify(await chips.allTextContents()) === JSON.stringify(labelsBefore) && chipAttributes.every((attr: any) => attr.editable === 'false'), { formulaText, labelsBefore, labelsAfter: await chips.allTextContents(), chipAttributes });
  await page().screenshot({ path: '/tmp/office-word-chip-light.png' });
  await formula.frame.locator('body').evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); });
  await page().waitForTimeout(300);
  await page().screenshot({ path: '/tmp/office-word-chip-dark.png' });
  await formula.frame.locator('body').evaluate(() => { document.documentElement.removeAttribute('data-theme'); });
  // Набор закончен: окно Flux само сверяет схему с ячейкой после паузы в наборе, отдельной команды нет
  await page().keyboard.press('Control+s');
  check('Word formula and both source-qualified field instructions persist after native save', await waitFor(async () => {
    const xml = await raw('GET', `/api/files/${encodeURIComponent(formula.fileId)}/raw`);
    const zip = await JSZip.loadAsync(xml.bytes); const document = await zip.file('word/document.xml')!.async('string');
    const state = (await api('GET', `/api/project-data/files/${formula.fileId}/office-state`)).json;
    const parts = state?.schema?.anchors?.find((anchor: any) => anchor.id === anchorId)?.parts || [];
    return document.includes('DOCPROPERTY "flux:v1:') && parts.filter((part: any) => part.kind === 'field').length === 2 && parts[0]?.kind === 'text' && parts[0].text === '=(' && parts.some((part: any) => part.kind === 'operator' && part.operator === '+') && parts.at(-1)?.kind === 'operator' && parts.at(-1)?.operator === ')' && document.includes('DrivePower') && document.includes('MotorPower');
  }), (await api('GET', `/api/project-data/files/${formula.fileId}/office-state`)).json?.schema?.anchors?.find((anchor: any) => anchor.id === anchorId)?.parts.map((part: any) => part.kind + ':' + (part.text || part.operator || '')).join('~'));
  await resetPage(false);
  await navigateOffice(page(), `/office-doc?file=${encodeURIComponent(formula.fileId)}`);
  const reopened = await openPanel(page(), 'Flux Office — Документ');
  const reopenedCell = reopened.locator('.ProseMirror table tr').first().locator('td,th').nth(0);
  check('two protected Word formula marks survive actual DOCX reopen', await waitFor(async () => await reopenedCell.locator('[data-instr-field*="flux:"]').count() === 2 && (await reopenedCell.innerText()).includes('+')));
  // Backspace у метки в повторно открытом файле: первое нажатие выделяет её, второе удаляет
  await reopenedCell.click({ position: { x: 6, y: 6 } });
  const reopenedMarks = reopenedCell.locator('[data-instr-field*="flux:"]');
  const reopenedSelected = () => reopenedCell.evaluate(() => { const st = (window as any).__fluxCtxRef?.current?.editor?.state; return st ? st.doc.textBetween(st.selection.from, st.selection.to) : ''; });
  await reopenedCell.evaluate((cell: HTMLElement) => {
    const field = [...cell.querySelectorAll('[data-instr-field*="flux:"]')].at(-1);
    if (!field) return;
    const range = document.createRange(); range.setStartAfter(field); range.collapse(true);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  });
  await page().waitForTimeout(250);
  const reopenedText = await reopenedCell.innerText();
  await page().keyboard.press('Backspace');
  check('Word first Backspace selects the field mark and keeps the cell text', await reopenedMarks.count() === 2 && await reopenedCell.innerText() === reopenedText && await reopenedSelected() === 'MotorPower', { text: await reopenedCell.innerText(), selected: await reopenedSelected() });
  await page().keyboard.press('Backspace');
  check('Word second Backspace removes only the selected field mark', await waitFor(async () => await reopenedMarks.count() === 1 && (await reopenedCell.innerText()).includes('DrivePower') && !(await reopenedCell.innerText()).includes('MotorPower')));
}
