/**
 * Хук переводчика окна Flux без редактора и без React: порядок постановки
 * (ворота → запись правок → постановка → запись с переводом → откат при отказе),
 * слова ошибок, режимы-копии, слот и совпадение каналов с протоколом редактора.
 */
import { createTranslationFlow, createTranslationGate, translationErrorText, type OfficeTranslationEditorLink, type OfficeTranslationFileLink, type OfficeTranslationState } from '../src/components/office/useOfficeTranslation';
import { TRANSLATION_CHANNELS as HOST_CHANNELS, TRANSLATION_TIMEOUT as HOST_TIMEOUT, createTranslationSlot, docsTranslationEditor, sheetsTranslationEditor } from '../src/components/office/officeTranslationLinks';
import { TRANSLATION_CHANNELS, TRANSLATION_TIMEOUT } from '../tools/genoffice/inject/translation-bridge';

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)); }
};

const record = (key: string) => ({ sourceId: 'doc', key, destination: 'en', revision: 'h1', time: 1, mode: 'after-paragraph', scope: 'document', targetLocation: {}, targetText: 'Hello', sourceText: 'Привет', sourceHash: 'x' });
const state = (baseHash = 'h1'): OfficeTranslationState => ({ baseHash, records: [], displayLabels: {} });
const placement = (mode: string) => ({ mode: mode as any, scope: 'document' as const, separator: 'newline' as const, order: 'source-first' as const, sourceRevision: 'h1' });
const item = { key: 'p1', source: 'Привет', targetText: 'Hello', confirmed: true, location: {} };
const payload = (mode = 'after-paragraph') => ({ items: [item], placement: placement(mode), direction: 'ru-en' as const });

interface Rig { log: string[]; editor: OfficeTranslationEditorLink; file: OfficeTranslationFileLink; gate: ReturnType<typeof createTranslationGate>; opts: any; flow: ReturnType<typeof createTranslationFlow> }
function rig(over: { apply?: any; saveOk?: boolean | Error; rollback?: any; readOnly?: boolean; blocked?: string; read?: any } = {}): Rig {
  const log: string[] = [];
  const gate = createTranslationGate();
  const editor: OfficeTranslationEditorLink = {
    read: async (request) => { log.push(`read:${request.scope}:${request.destination}:${(request.records || []).length}`); return 'read' in over ? over.read : { ok: true, units: [{ key: 'p1', source: 'Привет', location: {}, status: 'stale', targetText: 'Hi' }, { key: 'p2', source: 'Мир', location: {}, status: 'new' }] }; },
    apply: async (request) => {
      log.push(`apply:${request.dryRun ? 'dry' : 'real'}:${request.placement.mode}:busy=${gate.busy()}`);
      if (request.dryRun) return { ok: true, preview: [{ key: 'p1', location: {}, before: 'Привет', after: 'Привет\nHello', target: 'new-block' }] };
      return over.apply ?? { ok: true, records: [record('p1')], removeRecords: [], stepId: 's1' };
    },
    rollback: async (stepId) => { log.push(`rollback:${stepId}`); return over.rollback ?? { ok: true }; },
  };
  const file: OfficeTranslationFileLink = {
    state: async () => { log.push('state'); return state(); },
    committed: async () => { log.push(`committed:busy=${gate.busy()}`); return state(); },
    writeBlocked: () => over.blocked || '',
    saveWithTranslation: async (delta, baseHash) => {
      log.push(`save:${baseHash}:${delta.records?.length}:busy=${gate.busy()}`);
      if (over.saveOk instanceof Error) throw over.saveOk;
      return over.saveOk !== false;
    },
    saveBackup: async () => { log.push('backup'); },
    saveCopy: async (bytes, name, records) => { log.push(`copy:${bytes.byteLength}:${name}:${records?.length}`); },
    saveSheetsCopy: async (records) => { log.push(`sheets-copy:${records.length}`); },
  };
  const opts = { app: 'docs' as const, fileId: 'f1', readOnly: !!over.readOnly, editor, file, gate };
  return { log, editor, file, gate, opts, flow: createTranslationFlow(() => opts) };
}

async function main() {
console.log('1. Чтение: журнал → редактор → фрагменты со статусом');
{
  const r = rig();
  const read = await r.flow.read('selection', 'en-ru');
  check('чтение просит журнал и передаёт назначение', r.log.join('|') === 'state|read:selection:ru:0', r.log);
  check('статус устаревшего переходит в stale', read.ok && read.units?.[0].stale === true && read.units?.[1].stale === false, read);
  check('основа версии — хеш файла', read.sourceRevision === 'h1');
  const bad = rig({ read: { ok: false, code: 'too-many' } });
  const failed = await bad.flow.read('document');
  check('отказ редактора — слова по коду', !failed.ok && /Сузьте область/.test(failed.error || ''), failed);
  const silent = await rig({ read: null }).flow.read('document');
  check('молчание редактора — понятное сообщение', !silent.ok && /Редактор не ответил/.test(silent.error || ''), silent);
}

console.log('2. Предпросмотр не меняет документ и файл');
{
  const r = rig();
  const preview = await r.flow.preview!(payload());
  check('dryRun, без записи и без ворот', preview.ok && preview.items?.length === 1 && r.log.join('|') === 'state|apply:dry:after-paragraph:busy=false', r.log);
}

console.log('3. Постановка: ворота → записать правки → поставить → записать с переводом');
{
  const r = rig();
  const result = await r.flow.apply(payload());
  check('порядок и ворота закрыты на всём пути', r.log.join('|') === 'committed:busy=true|apply:real:after-paragraph:busy=true|save:h1:1:busy=true', r.log);
  check('успех: журнал и шаг «назад»', result.ok && result.stepId === 's1' && result.records?.length === 1, result);
  check('ворота открыты после', !r.gate.busy());
}

console.log('4. Отказ записи → откат шагом «назад»');
{
  const r = rig({ saveOk: new Error('Файл изменили после того, как вы его открыли. Ваши правки не записаны.') });
  const result = await r.flow.apply(payload());
  check('вызван rollback своего шага', r.log.at(-1) === 'rollback:s1', r.log);
  check('ошибка по-русски и говорит, что перевод отменён', !result.ok && /Файл изменили/.test(result.error || '') && /Перевод в документе отменён/.test(result.error || ''), result);
  check('ворота открыты и после отказа', !r.gate.busy());
  const stuck = rig({ saveOk: false, rollback: { ok: false, code: 'cannot-rollback' } });
  const second = await stuck.flow.apply(payload());
  check('откат невозможен — человеку сказано про Ctrl+Z', !second.ok && /Ctrl\+Z/.test(second.error || ''), second);
}

console.log('5. Отказ редактора: файл не пишется');
{
  const r = rig({ apply: { ok: false, code: 'protected-changed' } });
  const result = await r.flow.apply(payload());
  check('нет записи и отката', !r.log.some((line) => line.startsWith('save') || line.startsWith('rollback')), r.log);
  check('слова про плашку или защищённый фрагмент', !result.ok && /плашка Flux|защищённый/.test(result.error || ''), result);
  const text = rig({ apply: { ok: false, error: 'Свой текст редактора' } });
  check('текст редактора важнее кода', (await text.flow.apply(payload())).error === 'Свой текст редактора');
}

console.log('6. Только чтение, запрет записи, замена с копией');
{
  const ro = rig({ readOnly: true });
  const denied = await ro.flow.apply(payload());
  check('только чтение: ничего не вызвано', !denied.ok && ro.log.length === 0, ro.log);
  const blocked = rig({ blocked: 'Только держатель общей версии может записать.' });
  check('писать нельзя — причина хоста', (await blocked.flow.apply(payload())).error === 'Только держатель общей версии может записать.' && blocked.log.length === 0);
  const replace = rig();
  await replace.flow.apply(payload('replace'));
  check('«Заменить»: копия исходника раньше постановки', replace.log.join('|').startsWith('committed:busy=true|backup|apply:real:replace'), replace.log);
}

console.log('7. Режимы-копии не трогают оригинал');
{
  const docs = rig({ apply: { ok: true, records: [record('p1')], copy: { bytes: new ArrayBuffer(12), suggestedName: 'Перевод.docx' } } });
  const made = await docs.flow.apply(payload('new-file'));
  check('новый DOCX: копия с журналом, без записи в оригинал', made.ok && made.copied === true && docs.log.at(-1) === 'copy:12:Перевод.docx:1' && !docs.log.some((l) => l.startsWith('save')), docs.log);
  const sheets = rig({ apply: { ok: true, records: [record('a')], copyRequest: { kind: 'sheets-save-as', saved: false } } });
  const book = await sheets.flow.apply(payload('new-file'));
  check('новая книга: сохранение копии движком с журналом', book.ok && sheets.log.at(-1) === 'sheets-copy:1', sheets.log);
  const done = rig({ apply: { ok: true, records: [record('a')], copyRequest: { kind: 'sheets-save-as', saved: true } } });
  await done.flow.apply(payload('new-file'));
  check('копию уже сохранил редактор — хост не дублирует', !done.log.some((l) => l.startsWith('sheets-copy')), done.log);
}

console.log('8. Два перевода подряд не пересекаются в воротах');
{
  const r = rig();
  const release = r.gate.begin();
  let waited = false;
  const slot = createTranslationSlot(r.gate);
  const ordinary = slot.beforeSave().then(() => { waited = true; });
  await Promise.resolve();
  check('обычное сохранение ждёт ворота', !waited);
  let ownRan = false;
  await slot.own(async () => { await slot.beforeSave(); ownRan = true; });
  check('сохранение самого перевода ворота не ждёт', ownRan);
  release();
  await ordinary;
  check('после постановки обычное сохранение идёт', waited && !r.gate.busy());
  slot.arm({ delta: { records: [] }, token: 't' });
  slot.settle(false, 'нет');
  check('слот помнит причину отказа', slot.armed()?.token === 't' && slot.lastError() === 'нет');
  slot.disarm();
  check('слот сбрасывается', slot.armed() === null);
}

console.log('9. Транспорт: окно говорит именами из протокола редактора');
{
  check('каналы совпадают с translation-bridge.ts', JSON.stringify(HOST_CHANNELS) === JSON.stringify(TRANSLATION_CHANNELS) && JSON.stringify(HOST_TIMEOUT) === JSON.stringify(TRANSLATION_TIMEOUT));
  const calls: string[] = [];
  const docs = docsTranslationEditor(async (event, answer, ms, body) => { calls.push(`${event}>${answer}:${ms}:${JSON.stringify(body)}`); return { ok: true } as any; });
  await docs.read({ scope: 'document' }); await docs.rollback('s9');
  check('Документ: события и ответы', calls[0].startsWith('fluxTranslationRead>flux:translation-read:30000') && calls[1] === 'fluxTranslationRollback>flux:translation-rolled-back:15000:{"stepId":"s9"}', calls);
  const sheetCalls: string[] = [];
  const sheets = sheetsTranslationEditor(async (channel, body, answer, ms) => { sheetCalls.push(`${channel}>${answer}:${ms}`); return { ok: true }; });
  await sheets.apply({ items: [], placement: placement('new-sheet') as any, direction: 'ru-en' });
  check('Таблица: каналы запроса и ответа', sheetCalls[0] === 'flux:translation-apply-request>flux:translation-applied:120000', sheetCalls);
  check('слова отказа без ответа', translationErrorText(null).includes('не ответил') && translationErrorText({ code: 'busy' }).includes('уже выполняется'));
}

}

main().then(() => {
  if (failures) { console.error(`\n${failures} проверок не прошли`); process.exit(1); }
  console.log('\nХук переводчика окна Flux: все проверки прошли');
}).catch((error) => { console.error(error); process.exit(1); });
