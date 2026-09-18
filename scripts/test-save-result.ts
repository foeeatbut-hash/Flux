/**
 * Исход записи документа и черновик несохранённой правки.
 *
 * Главное здесь — что ни один исход не молчит. Раньше `saveNow` возвращал
 * `void`, и отказ сервера был снаружи неотличим от успеха: разбор конфликта
 * после `await` показывал «Сохранено» на любой ответ, человек верил и закрывал
 * окно с единственной копией своей работы. Это и проверяется первым.
 *
 * Запуск: npx tsx scripts/test-save-result.ts
 */

import {
  readSaveResponse, isSaved, canCloseAfter, saveResultText, saveResultTone,
  type SaveResult,
} from '../src/lib/saveResult';
import {
  saveDraft, readDraft, clearDraft, worthRestoring, draftExpired, draftAgeText,
  tooBigForDraft, DRAFT_LIMIT, DRAFT_TTL, type DocDraft,
} from '../src/lib/docDraft';

let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond
    ? console.log('  ✓', name)
    : (failed++, console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)));

console.log('1. Разбор ответа сервера: пять разных исходов');
{
  const saved = readSaveResponse(200, { doc: { updatedAt: '2026-09-18T10:00:00.000Z' } });
  ok('200 — записано', saved.kind === 'saved', saved);
  ok('время правки взято из ответа',
    saved.kind === 'saved' && saved.at === '2026-09-18T10:00:00.000Z', saved);

  const conflict = readSaveResponse(409, { conflict: true, who: 'Иванов', at: '2026-09-18T09:00:00.000Z' });
  ok('409 с признаком — конфликт', conflict.kind === 'conflict', conflict);
  ok('в конфликте назван человек', conflict.kind === 'conflict' && conflict.who === 'Иванов');

  // Вот ради чего всё: 500 больше не выглядит как успех
  const err = readSaveResponse(500, { error: 'Сервер упал' });
  ok('500 — ошибка, а не запись', err.kind === 'error', err);
  ok('текст ошибки сервера доехал', err.kind === 'error' && err.text === 'Сервер упал');

  ok('403 — тоже ошибка', readSaveResponse(403, {}).kind === 'error');
  ok('без тела ошибка всё равно названа',
    saveResultText(readSaveResponse(500, {})).includes('500'), saveResultText(readSaveResponse(500, {})));

  const blocked = readSaveResponse(503, { snapshotFailed: true, error: 'Не удалось убрать версию в историю' });
  ok('503 со снимком — отдельный исход, не общая ошибка', blocked.kind === 'blocked', blocked);

  ok('нет связи вовсе — ошибка со статусом 0', readSaveResponse(0, null).kind === 'error');
}

console.log('\n2. Успех показывается только на успехе');
{
  const cases: SaveResult[] = [
    { kind: 'saved', at: 'x' },
    { kind: 'unchanged', reason: 'empty' },
    { kind: 'conflict', who: 'Петров', at: 'y' },
    { kind: 'blocked', text: 'снимок не вышел' },
    { kind: 'error', status: 500, text: 'сбой' },
  ];
  ok('записанным считается ровно один исход', cases.filter(isSaved).length === 1, cases.filter(isSaved));
  ok('тон успеха только у записи',
    cases.filter(c => saveResultTone(c) === 'success').length === 1);
  ok('конфликт, отказ и ошибка — тревожный тон',
    saveResultTone(cases[2]) === 'error' && saveResultTone(cases[3]) === 'error' && saveResultTone(cases[4]) === 'error');
}

console.log('\n3. Когда окно можно закрывать');
{
  // Самое дорогое правило работы: закрыть окно на неуспехе — потерять правку
  ok('после записи — можно', canCloseAfter({ kind: 'saved', at: 'x' }));
  ok('когда писать было нечего — можно', canCloseAfter({ kind: 'unchanged', reason: 'unchanged' }));
  ok('на конфликте — НЕЛЬЗЯ', !canCloseAfter({ kind: 'conflict', who: '', at: '' }));
  ok('на отказе от записи поверх — НЕЛЬЗЯ', !canCloseAfter({ kind: 'blocked', text: '' }));
  ok('на ошибке — НЕЛЬЗЯ', !canCloseAfter({ kind: 'error', status: 500, text: '' }));

  ok('у «нечего писать» нет текста: лишний тост приучает не читать',
    saveResultText({ kind: 'unchanged', reason: 'unchanged' }) === '');
  ok('у конфликта без имени текст всё равно понятный',
    saveResultText({ kind: 'conflict', who: '', at: '' }).includes('изменился'));
}

console.log('\n4. Черновик несохранённой правки');
{
  // Узла localStorage в Node нет — подкладываем простейший
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };

  ok('отложили и прочли', saveDraft('d1', '{"a":1}', 'нет связи') && readDraft('d1')?.snapshot === '{"a":1}');
  ok('причина сохранена — её и покажем человеку', readDraft('d1')?.reason === 'нет связи');
  clearDraft('d1');
  ok('убрали', readDraft('d1') === null);

  // Книга на пять мегабайт выбила бы localStorage целиком, вместе с чужими
  // настройками: лучше честно отказаться от страховки для гиганта
  ok('гигант не кладётся', tooBigForDraft('x'.repeat(DRAFT_LIMIT + 1)));
  ok('обычный снимок кладётся', !tooBigForDraft('x'.repeat(1000)));
  ok('и правда не сохраняется', !saveDraft('big', 'x'.repeat(DRAFT_LIMIT + 1), 'сбой'));

  ok('пустой снимок не кладётся', !saveDraft('d2', '', 'сбой'));

  // Хранилище может бросать: приватное окно, запрет на сайт
  (globalThis as any).localStorage = {
    getItem: () => { throw new Error('заблокировано'); },
    setItem: () => { throw new Error('заблокировано'); },
    removeItem: () => { throw new Error('заблокировано'); },
  };
  ok('запрещённое хранилище не роняет окно', saveDraft('d3', '{}', 'x') === false && readDraft('d3') === null);
}

console.log('\n5. Что предлагать вернуть');
{
  const now = Date.UTC(2026, 8, 18, 12, 0, 0);
  const fresh: DocDraft = { docId: 'd', snapshot: '{"мой":1}', at: now - 60000, reason: 'сбой' };

  ok('черновик отличается от серверного — предлагаем', worthRestoring(fresh, '{"чужой":1}', now));
  // Предложить вернуть ровно то, что и так открыто, — только напугать человека
  ok('совпал с серверным — не предлагаем', !worthRestoring(fresh, '{"мой":1}', now));
  ok('пустого нет — не предлагаем', !worthRestoring(null, '{}', now));

  const old: DocDraft = { ...fresh, at: now - DRAFT_TTL - 1 };
  ok('просроченный не предлагаем', draftExpired(old, now) && !worthRestoring(old, '{"чужой":1}', now));
  ok('недельной давности ещё живой', !draftExpired({ ...fresh, at: now - DRAFT_TTL + 1000 }, now));

  ok('время названо по-человечески', draftAgeText(fresh, now) === '1 мин назад', draftAgeText(fresh, now));
  ok('только что — так и сказано', draftAgeText({ ...fresh, at: now - 1000 }, now) === 'только что');
  ok('часы', draftAgeText({ ...fresh, at: now - 3 * 3600000 }, now) === '3 ч назад');
  ok('дни', draftAgeText({ ...fresh, at: now - 2 * 86400000 }, now) === '2 дн назад');
}

console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
process.exit(failed ? 1 : 0);
