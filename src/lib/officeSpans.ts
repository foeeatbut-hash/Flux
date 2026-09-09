/**
 * Измерения офисного движка — одной строкой на месте вызова.
 *
 * Редакторы книги и текста и без того самые большие файлы в программе, и
 * обвешивать их замерами построчно нельзя: замер должен быть виден как одно
 * слово, а не как пять строк вокруг полезного кода.
 *
 * Что записывается: сколько знаков вышло, сколько это заняло и чем кончилось.
 * Ни содержимого книги, ни текста документа здесь нет и быть не может —
 * словарь событий (diagnostics/contracts) таких полей просто не объявляет.
 *
 * Имя документа тоже не пишется. Вместо настоящего идентификатора берётся
 * случайный, свой на каждый запуск окна: события об одном документе связываются
 * между собой, но сопоставить их с записью в базе по выгруженному файлу
 * невозможно.
 */

import { diagnostic } from './diagnostics';
import { newTraceId } from '../../diagnostics/event';

export type OfficeSection = 'sheet' | 'doc';

const refs = new Map<string, string>();

/** Случайная метка документа на время работы окна. */
export function docRef(docId: string): string {
  let ref = refs.get(docId);
  if (!ref) { ref = newTraceId(); refs.set(docId, ref); }
  return ref;
}

/**
 * Снятие снимка: извлечение плюс превращение в строку.
 *
 * Меряется вместе, потому что человек ждёт их вместе; отдельно от них
 * `characters` говорит, велик ли документ. Знаки — не байты, и подписать их
 * байтами нельзя: это разные виды полей.
 */
export function snapshotSpan(section: OfficeSection, docId: string, take: () => string): string {
  const start = performance.now();
  const text = take();
  diagnostic('office.snapshot', {
    section, documentRef: docRef(docId),
    characters: text.length, stringifyMs: performance.now() - start,
  });
  return text;
}

/**
 * Чем кончилась запись документа.
 *
 * Пропуск — тоже результат: «сохранений не было» и «сохранять было нечего» при
 * разборе жалобы «не сохраняется» отвечают на разные вопросы.
 */
export function saveSpan(
  section: OfficeSection, docId: string,
  fields: { characters?: number; reason: string; status?: string; startedAt?: number; outcome: 'ok' | 'error' | 'conflict' | 'skipped' | 'cancelled' },
): void {
  diagnostic('office.save', {
    section, documentRef: docRef(docId),
    characters: fields.characters, reason: fields.reason, status: fields.status,
    outcome: fields.outcome,
    durationMs: fields.startedAt === undefined ? undefined : performance.now() - fields.startedAt,
  });
}

/** Открытие редактора: загрузка модулей и сборка документа порознь. */
export function initSpan(section: OfficeSection, docId: string, modulesMs: number, bookMs: number): void {
  diagnostic('office.init', { section, documentRef: docRef(docId), modulesMs, bookMs });
}

/** Закрытие редактора. Долгое уничтожение — частая причина «окно подвисло». */
export function disposeSpan(section: OfficeSection, docId: string, startedAt: number): void {
  diagnostic('office.dispose', { section, documentRef: docRef(docId), durationMs: performance.now() - startedAt });
}

/** Выгрузка наружу: во что и сколько получилось байт. */
export function exportSpan(section: OfficeSection, docId: string, format: string, startedAt: number, resultBytes?: number): void {
  diagnostic('office.export', {
    section, documentRef: docRef(docId), format, resultBytes,
    durationMs: performance.now() - startedAt,
  });
}

/** Приём файла извне: откуда и сколько байт пришло. */
export function importSpan(section: OfficeSection, docId: string, format: string, startedAt: number, sourceBytes?: number): void {
  diagnostic('office.import', {
    section, documentRef: docRef(docId), format, sourceBytes,
    durationMs: performance.now() - startedAt,
  });
}
