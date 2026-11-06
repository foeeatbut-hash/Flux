/**
 * Публикация черновика из панели (src/lib/draftsActions.ts): порядок вызовов
 * моста, занятое имя, «Оставить копию», отказ при неопубликованной папке —
 * без браузера и Electron, мост подменён.
 */
import assert from 'node:assert/strict';
import { dragItem, encodeDraftDrag, folderLabel, parseDraftDrag, publishDraftInPlace, publishDraftInto, type DraftDragItem, type DraftRequest } from '../src/lib/draftsActions';
import type { WindowsDraftEntry } from '../filesystem/contracts';

let passed = 0;
const ok = async (name: string, check: () => void | Promise<void>) => { await check(); passed++; console.log('✓', name); };

const file: DraftDragItem = { ref: { rootId: 'r', relativePath: 'Документ.docx', draftId: 'd1' }, name: 'Документ.docx', kind: 'file' };
const folder: DraftDragItem = { ref: { rootId: 'r', relativePath: 'Бланки', draftId: 'd2' }, name: 'Бланки', kind: 'directory' };
const target = { rootId: 'r', relativePath: 'Проект/Чертежи' };

/** Мост-имитация: занятые имена в папке назначения и сбой публикации задаются параметрами. */
function bridge(opts: { taken?: string[]; publishFails?: boolean } = {}) {
  const calls: any[] = [];
  const request = (async (call: any) => {
    calls.push(call);
    if (call.action === 'move' || call.action === 'copy') {
      if ((opts.taken || []).includes(call.name)) return { ok: false, error: { code: 'EEXIST', message: 'занято' } };
      return { ok: true, data: { ref: { rootId: 'r', relativePath: `${call.parent.relativePath}/${call.name}`, draftId: call.action === 'copy' ? 'copy-1' : call.ref.draftId } } };
    }
    if (call.action === 'publishDraft') return opts.publishFails ? { ok: false, error: { code: 'IO', message: 'Диск недоступен.' } } : { ok: true, data: { ref: call.ref } };
    return { ok: false, error: { code: 'UNSUPPORTED', message: '?' } };
  }) as unknown as DraftRequest;
  return { calls, request };
}

(async () => {
  await ok('Данные перетаскивания: круг через JSON и отказ от чужого', () => {
    const entry = { name: 'Схема.pdf', relativePath: 'Схема.pdf', draftId: 'x', kind: 'file', rootId: 'r', parent: { rootId: 'r', relativePath: '' } } as WindowsDraftEntry;
    assert.deepEqual(parseDraftDrag(encodeDraftDrag([dragItem(entry)])), [{ ref: { rootId: 'r', relativePath: 'Схема.pdf', draftId: 'x' }, name: 'Схема.pdf', kind: 'file' }]);
    assert.equal(parseDraftDrag(''), null);
    assert.equal(parseDraftDrag('{"items":[]}'), null);
    assert.equal(parseDraftDrag('{"items":[{"name":"a","ref":{"rootId":"r","relativePath":"a"}}]}'), null, 'без draftId это не черновик');
    assert.equal(parseDraftDrag('not json'), null);
  });

  await ok('Без копии: сначала перенос в папку, потом публикация перенесённого', async () => {
    const { calls, request } = bridge();
    const outcome = await publishDraftInto(request, file, target, { keepCopy: false });
    assert.equal(outcome.ok, true);
    assert.deepEqual(calls.map((call) => call.action), ['move', 'publishDraft']);
    assert.deepEqual(calls[0].parent, target);
    assert.equal(calls[1].ref.relativePath, 'Проект/Чертежи/Документ.docx', 'публикуется там, куда перенесён');
  });

  await ok('Занятое имя: «Документ (2).docx», «Документ (3).docx»', async () => {
    const { calls, request } = bridge({ taken: ['Документ.docx', 'Документ (2).docx'] });
    const outcome = await publishDraftInto(request, file, target, { keepCopy: false });
    assert.equal(outcome.name, 'Документ (3).docx');
    assert.deepEqual(calls.filter((call) => call.action === 'move').map((call) => call.name), ['Документ.docx', 'Документ (2).docx', 'Документ (3).docx']);
  });

  await ok('Папка получает номер без расширения: «Бланки (2)»', async () => {
    const { calls, request } = bridge({ taken: ['Бланки'] });
    const outcome = await publishDraftInto(request, folder, target, { keepCopy: false });
    assert.equal(outcome.name, 'Бланки (2)');
    assert.equal(calls.at(-1).choices, undefined, 'у дерева выбор по конфликтам не передаётся');
  });

  await ok('«Оставить копию»: копия с метаданными, исходный черновик не переносится', async () => {
    const { calls, request } = bridge();
    const outcome = await publishDraftInto(request, file, target, { keepCopy: true });
    assert.equal(outcome.ok, true);
    assert.deepEqual(calls.map((call) => call.action), ['copy', 'publishDraft']);
    assert.equal(calls[0].carryMeta, true);
    assert.equal(calls[1].ref.draftId, 'copy-1', 'публикуется копия, а не исходник');
    assert.match(outcome.message, /Копия осталась в черновиках/);
  });

  await ok('Папка-черновик как цель: отказ без обращения к мосту', async () => {
    const { calls, request } = bridge();
    const outcome = await publishDraftInto(request, file, { ...target, draftId: 'folder-draft' }, { keepCopy: false });
    assert.equal(outcome.ok, false);
    assert.equal(calls.length, 0);
  });

  await ok('Сбой публикации после переноса: черновик цел и лежит в папке', async () => {
    const { request } = bridge({ publishFails: true });
    const outcome = await publishDraftInto(request, file, target, { keepCopy: false });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.draftKept, true);
    assert.match(outcome.message, /Диск недоступен/);
  });

  await ok('Публикация на месте не переносит и не копирует', async () => {
    const { calls, request } = bridge();
    const outcome = await publishDraftInPlace(request, file);
    assert.equal(outcome.ok, true);
    assert.deepEqual(calls.map((call) => call.action), ['publishDraft']);
  });

  await ok('Название папки в окне подтверждения', () => {
    assert.equal(folderLabel('Проект/Чертежи', 'Рабочий стол'), 'Чертежи');
    assert.equal(folderLabel('', 'Рабочий стол'), 'Рабочий стол');
  });

  console.log(`Проверки публикации черновиков пройдены: ${passed}`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
