/**
 * Переводчик Документа (Word) в настоящем редакторе GenOffice: окно панели ещё не подключено к мосту,
 * поэтому сценарии шлют редактору те же события, что пошлёт хук (fluxTranslationRead/Apply/Rollback),
 * и читают его ответы. Проверяется то, что обещает контракт translation-bridge.ts:
 * пять режимов, один шаг «назад», плашки Flux, устаревшие, повтор без дублей, «новый файл», сохранение.
 */
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { makeDocx } from './officeHarness';

type Options = {
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

const INSTR = 'DOCPROPERTY "flux:v1:srcA:DrivePower"';
const CHIP = '';
const SOURCES = ['Привод мощностью ', 'Номинальный ток двигателя', 'Рабочее напряжение сети', 'Температура окружающей среды', 'Резервный источник питания'];
const TARGETS = [`Drive power ${CHIP} kW`, 'Rated motor current', 'Mains operating voltage', 'Ambient temperature', 'Backup power supply'];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const run = (t: string) => `<w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
const field = `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${INSTR} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run('5,5')}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;

async function makeTranslatableDocx(): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await makeDocx());
  const xml = await zip.file('word/document.xml')!.async('string');
  const body = `<w:p>${run(SOURCES[0])}${field}${run(' кВт')}</w:p>` + SOURCES.slice(1).map((s) => `<w:p>${run(s)}</w:p>`).join('');
  zip.file('word/document.xml', xml.replace(/<w:body>[\s\S]*?(<w:sectPr)/, `<w:body>${body}$1`));
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

export async function runNativeTranslatorWord(options: Options): Promise<void> {
  const { folderId, stamp, created, raw, upload, check, waitFor, resetPage, navigateOffice, openPanel } = options;
  const page = options.page;
  console.log('\n7. Native Word translator: editor bridge, five placement modes, undo, stale, rerun, new file, persistence');

  const fileId = await upload(folderId, `__native_word_translator_${stamp}.docx`, 'DOCX', await makeTranslatableDocx());
  if (fileId) created.push(fileId);
  const open = async () => {
    await resetPage(false);
    await navigateOffice(page(), `/office-doc?file=${encodeURIComponent(fileId)}`);
    const frame = await openPanel(page(), 'Flux Office — Документ');
    const editor = frame.locator('.ProseMirror').first();
    await editor.waitFor({ timeout: 15000 });
    await waitFor(async () => (await editor.innerText()).includes('Резервный'), 20000);
    return { frame, editor };
  };
  let { frame, editor } = await open();

  // Строка внутри функции — ловушка tsx: именованные функции в locator.evaluate ломаются, поэтому код передаётся строкой
  const state = (): Promise<Array<{ t: string; fields: string[]; bm: string[]; pb: boolean }>> => frame.locator('body').evaluate((_el: any, code: string) => (0, eval)(code), `(() => {
    const j = window.__fluxCtxRef.current.editor.getJSON(); const out = [];
    const walk = (n) => {
      if (n.type === 'docParagraph' || n.type === 'docHeading') {
        const c = n.content || [];
        out.push({ t: c.map((x) => x.type === 'text' ? x.text : x.type === 'hardBreak' ? '\\n' : '?').join(''),
          fields: [...new Set(c.flatMap((x) => (x.marks || []).filter((m) => m.type === 'instrField').map((m) => m.attrs.instr)))],
          bm: [...(n.attrs?.hiddenBookmarks || []), ...(n.attrs?.bookmarks || [])], pb: !!n.attrs?.pageBreakBefore });
      } else (n.content || []).forEach(walk);
    };
    walk(j); return out;
  })()`);
  const texts = async () => (await state()).map((p) => p.t);

  // Событие редактору из окна Flux и ожидание ответов (n — сколько ответов ждать)
  const call = async (event: string, answer: string, payload: unknown, n = 1): Promise<any[]> => page().evaluate(`new Promise((resolve) => {
    const f = document.querySelector('iframe[title="Flux Office — Документ"]'); const got = [];
    const b64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
    const h = (e) => {
      if (e.source !== f.contentWindow || !e.data || e.data.flux !== 'office' || e.data.op !== ${JSON.stringify(answer)}) return;
      const p = e.data.payload; if (p && p.copy && p.copy.bytes) p.copy = { ...p.copy, bytes: b64(p.copy.bytes) };
      got.push(p); if (got.length >= ${n}) { removeEventListener('message', h); resolve(got); }
    };
    addEventListener('message', h);
    for (let i = 0; i < ${n}; i++) f.contentWindow.postMessage({ flux: 'office', event: ${JSON.stringify(event)}, payload: ${JSON.stringify(payload)} }, location.origin);
    setTimeout(() => resolve(got.length ? got : [{ timeout: true }]), 60000);
  })`);
  const read = async (records: any[] = [], scope = 'document') => (await call('fluxTranslationRead', 'flux:translation-read', { scope, records, destination: 'en' }))[0];
  const placement = (mode: string) => ({ mode, scope: 'document', separator: 'newline', order: 'source-first', sourceRevision: 'rev-1' });
  const apply = async (mode: string, units: any[], extra: Record<string, unknown> = {}, targets = TARGETS, n = 1) =>
    (await call('fluxTranslationApply', 'flux:translation-applied', {
      items: units.map((u, i) => ({ key: u.key, source: u.source, targetText: targets[i], confirmed: true })),
      placement: placement(mode), direction: 'ru-en', ...extra,
    }, n));
  const undoOnce = async () => { await editor.locator('p').nth(1).click(); await page().keyboard.press('Control+z'); };
  const original = await texts();
  const fieldsOf = async () => (await state()).flatMap((p) => p.fields);
  const noMarks = async () => (await state()).every((p) => p.bm.every((b) => !/^FLUX_7[ab]/.test(b)));

  // 1. Чтение области
  const first = await read();
  check('translator read: whole document gives five units, new, chip counted in the field paragraph',
    first?.ok === true && first.units?.length === 5 && first.units.every((u: any) => u.status === 'new') && first.units[0].chips === 1 && first.units[0].source.includes(CHIP), JSON.stringify(first).slice(0, 400));
  const units = first.units;
  const baseFields = await fieldsOf();
  check('translator read: the Flux field is present with its DOCPROPERTY instruction', baseFields.length === 1 && baseFields[0].includes('flux:v1:srcA:DrivePower'), baseFields);

  // 2. Предпросмотр ничего не меняет, а отказы оставляют документ целым
  const dry = (await apply('replace', units, { dryRun: true }))[0];
  check('dryRun returns a preview of five rows and does not touch the document', dry.ok && dry.preview?.length === 5 && JSON.stringify(await texts()) === JSON.stringify(original), JSON.stringify(dry).slice(0, 300));
  const notConfirmed = (await call('fluxTranslationApply', 'flux:translation-applied', { items: units.map((u: any, i: number) => ({ key: u.key, source: u.source, targetText: TARGETS[i] })), placement: placement('replace'), direction: 'ru-en' }))[0];
  check('unconfirmed fragment is rejected with not-confirmed, document intact', notConfirmed.ok === false && notConfirmed.code === 'not-confirmed' && JSON.stringify(await texts()) === JSON.stringify(original), notConfirmed);
  const lostChip = (await apply('replace', units, {}, ['Drive power kW', ...TARGETS.slice(1)]))[0];
  check('translation without the field chip is rejected with protected-changed, document intact', lostChip.ok === false && lostChip.code === 'protected-changed' && JSON.stringify(await texts()) === JSON.stringify(original), lostChip);
  const staleSource = (await call('fluxTranslationApply', 'flux:translation-applied', { items: units.map((u: any, i: number) => ({ key: u.key, source: i === 1 ? 'Другой текст' : u.source, targetText: TARGETS[i], confirmed: true })), placement: placement('replace'), direction: 'ru-en' }))[0];
  check('changed source is rejected with source-changed, document intact', staleSource.ok === false && staleSource.code === 'source-changed' && JSON.stringify(await texts()) === JSON.stringify(original), staleSource);
  const unsupported = (await apply('adjacent-column', units))[0];
  check('a Sheets-only mode is rejected with unsupported-mode', unsupported.ok === false && unsupported.code === 'unsupported-mode', unsupported);

  // 3. Пять режимов: результат, плашка, один Ctrl+Z
  const srcText = (i: number) => (i === 0 ? `${SOURCES[0]}5,5 кВт` : SOURCES[i]);
  const tgtText = (i: number) => (i === 0 ? 'Drive power 5,5 kW' : TARGETS[i]);
  const modes: Array<{ mode: string; verify: (s: Awaited<ReturnType<typeof state>>) => boolean }> = [
    { mode: 'replace', verify: (s) => s.length === 5 && s.every((p, i) => p.t === tgtText(i)) },
    { mode: 'inline-after', verify: (s) => s.length === 5 && s.every((p, i) => p.t === `${srcText(i)}\n${tgtText(i)}`) },
    { mode: 'inline-before', verify: (s) => s.length === 5 && s.every((p, i) => p.t === `${tgtText(i)}\n${srcText(i)}`) },
    { mode: 'after-paragraph', verify: (s) => s.length === 10 && s.every((p, i) => p.t === (i % 2 ? tgtText((i - 1) / 2) : srcText(i / 2))) },
    { mode: 'new-page', verify: (s) => s.length === 10 && s.slice(0, 5).every((p, i) => p.t === srcText(i)) && s.slice(5).every((p, i) => p.t === tgtText(i)) && s[5].pb === true },
  ];
  for (const { mode, verify } of modes) {
    const res = (await apply(mode, units))[0];
    const after = await state();
    check(`${mode}: applied five fragments with a step id and records for the journal`, res.ok === true && res.applied === 5 && !!res.stepId && res.records?.length === 5, JSON.stringify(res).slice(0, 300));
    check(`${mode}: document text is placed as the mode promises`, verify(after), after.map((p) => p.t));
    const fields = after.flatMap((p) => p.fields);
    check(`${mode}: Flux field survives with the identical instruction (exactly once)`, fields.length === 1 && fields[0] === baseFields[0], fields);
    await undoOnce();
    check(`${mode}: one Ctrl+Z restores the original text, field and bookmarks`, await waitFor(async () => JSON.stringify(await texts()) === JSON.stringify(original), 5000) && JSON.stringify(await fieldsOf()) === JSON.stringify(baseFields) && await noMarks(), await texts());
  }

  // 4. Откат по stepId: только свой верхний шаг
  const rb = (await apply('replace', units))[0];
  const rolled = (await call('fluxTranslationRollback', 'flux:translation-rolled-back', { stepId: rb.stepId }))[0];
  check('rollback by stepId returns the document to the original', rolled.ok === true && JSON.stringify(await texts()) === JSON.stringify(original), rolled);
  const rb2 = (await apply('replace', units))[0];
  await editor.locator('p').nth(2).click(); await page().keyboard.press('End'); await page().keyboard.type('!');
  const refused = (await call('fluxTranslationRollback', 'flux:translation-rolled-back', { stepId: rb2.stepId }))[0];
  check('rollback after a human edit is refused with cannot-rollback and changes nothing', refused.ok === false && refused.code === 'cannot-rollback' && (await texts())[2].endsWith('!'), refused);
  for (let i = 0; i < 4 && JSON.stringify(await texts()) !== JSON.stringify(original); i++) await undoOnce();
  check('manual Ctrl+Z returns to the original after the refused rollback', JSON.stringify(await texts()) === JSON.stringify(original), await texts());

  // 5. Устаревшие: правка исходного абзаца после постановки
  const inl = (await apply('inline-after', units))[0];
  await editor.locator('p').nth(1).click(); await page().keyboard.press('Home'); await page().keyboard.type('Новый ');
  const reread = await read(inl.records);
  const statuses = reread.units?.map((u: any) => u.status);
  check('stale detection: after editing source paragraph 2 only that unit is stale, the rest current', reread.ok && statuses?.[1] === 'stale' && statuses.filter((s: string) => s === 'current').length === 4, statuses);
  for (let i = 0; i < 6 && JSON.stringify(await texts()) !== JSON.stringify(original); i++) await undoOnce();
  check('undo returns the document to the original after the stale test', JSON.stringify(await texts()) === JSON.stringify(original), await texts());

  // 6. Повтор без дублей
  const r1 = (await apply('after-paragraph', units))[0];
  const keyed = (await read(r1.records)).units;
  check('after-paragraph: re-read with the journal reports five current units and the document has 10 paragraphs', keyed.length === 5 && keyed.every((u: any) => u.status === 'current') && (await texts()).length === 10, keyed.map((u: any) => u.status));
  const r2 = (await apply('after-paragraph', keyed, { records: r1.records }))[0];
  check('rerun with the same translation adds nothing (skipped 5, still 10 paragraphs, no step)', r2.ok && r2.applied === 0 && r2.skipped === 5 && !r2.stepId && (await texts()).length === 10, JSON.stringify(r2).slice(0, 300));
  const changed = [...TARGETS]; changed[2] = 'Supply voltage';
  const r3 = (await apply('after-paragraph', keyed, { records: r1.records }, changed))[0];
  const t3 = await texts();
  check('rerun with a changed translation updates it in place: still 10 paragraphs, no duplicates, journal replaced', r3.ok && r3.applied === 1 && t3.length === 10 && t3[5] === 'Supply voltage' && r3.removeRecords?.length === 1, JSON.stringify({ r3: r3.applied, t3, rm: r3.removeRecords?.length }));
  for (let i = 0; i < 4 && JSON.stringify(await texts()) !== JSON.stringify(original); i++) await undoOnce();
  check('Ctrl+Z steps undo both placements and restore the original', JSON.stringify(await texts()) === JSON.stringify(original), await texts());

  // 7. Новый файл: оригинал не тронут, копия — настоящий DOCX
  const before = await raw('GET', `/api/files/${encodeURIComponent(fileId)}/raw`);
  const nf = (await apply('new-file', units))[0];
  const copy = nf.copy?.bytes ? await JSZip.loadAsync(Buffer.from(nf.copy.bytes, 'base64')) : null;
  const copyXml = copy ? await copy.file('word/document.xml')!.async('string') : '';
  check('new-file: returns a DOCX copy with the translation and the unchanged Flux field instruction', nf.ok && !!copy && /Rated motor current/.test(copyXml) && copyXml.includes('flux:v1:srcA:DrivePower') && !copyXml.includes('Номинальный ток'), JSON.stringify(nf).slice(0, 200));
  const afterNew = await raw('GET', `/api/files/${encodeURIComponent(fileId)}/raw`);
  check('new-file: the original editor text and saved file are unchanged, no history step is created', JSON.stringify(await texts()) === JSON.stringify(original) && !nf.stepId && createHash('sha256').update(before.bytes).digest('hex') === createHash('sha256').update(afterNew.bytes).digest('hex'));
  const two = await apply('new-file', units, {}, TARGETS, 2);
  check('second request during a running new-file is answered busy', two.filter((x: any) => x.ok).length === 1 && two.some((x: any) => x.code === 'busy'), JSON.stringify(two).slice(0, 300));

  // 8. Сохранение родным сохранением и повторное открытие
  const saved = (await apply('replace', units))[0];
  await editor.locator('p').nth(1).click();
  await page().keyboard.press('Control+s');
  const xmlNow = async () => { const r = await raw('GET', `/api/files/${encodeURIComponent(fileId)}/raw`); return (await (await JSZip.loadAsync(r.bytes)).file('word/document.xml')!.async('string')); };
  check('native save writes the translation, the field instruction and the FLUX_7a bookmark into the DOCX', saved.ok && await waitFor(async () => { const x = await xmlNow(); return x.includes('Rated motor current') && x.includes('flux:v1:srcA:DrivePower') && /FLUX_7a[0-9a-f]{30}/i.test(x); }, 20000));
  ({ frame, editor } = await open());
  await waitFor(async () => (await texts())[1] === 'Rated motor current', 15000);
  const reopened = await state();
  check('after reopening the editor shows the translation and the same field', reopened.length === 5 && reopened[1].t === 'Rated motor current' && reopened[0].fields[0] === baseFields[0], reopened.map((p) => p.t));
  const again = await read(saved.records);
  check('after reopening the journal still recognises the translated paragraphs (replaced)', again.ok && again.units.length === 5 && again.units.every((u: any) => u.status === 'replaced' || u.status === 'current'), again.units?.map((u: any) => u.status));
}
