import type { OfficeTranslationBridge, OfficeTranslationRecord } from './TranslationBridgeContext';
import type { OfficeTranslationDelta } from '../../../office/translationPackage';
import type { TrApplyRequest, TrApplyResult, TrReadRequest, TrReadResult, TrRollbackResult } from '../../../tools/genoffice/inject/translation-bridge';

/**
 * Хук переводчика окна Flux — КОНТРАКТ (реализует дорожка панели и хостов).
 *
 * Одна реализация на четыре окна (Word и Таблица проекта — OfficeHost и
 * OfficeAppEditor; Word и Таблица Проводника — LocalOfficeEditor): окно даёт
 * ссылки на редактор и на файл, хук ведёт порядок
 *   1. gate.begin()                                  — обычное сохранение ждёт;
 *   2. file.committed()                              — правки редактора записаны, известен хеш файла;
 *   3. editor.apply(...)                             — один шаг «назад» или отказ (документ цел);
 *   4. file.saveWithTranslation(delta, baseHash)     — содержимое и журнал одним сохранением
 *      (проект: stage → X-Flux-Translation-Token; Проводник: delta вместе с записью);
 *   5. при отказе на шаге 4 — editor.rollback(stepId), ворота открываются, человек видит причину.
 * Режимы «новый DOCX / новая книга» не меняют оригинал: editor.apply возвращает копию, её пишет
 * file.saveCopy / file.saveSheetsCopy, журнал уходит в метаданные копии.
 */

/** Ссылка на редактор: транспорт Документа (askFrame) или Таблицы (ipc), протокол один. */
export interface OfficeTranslationEditorLink {
  read(request: TrReadRequest): Promise<TrReadResult | null>;
  apply(request: TrApplyRequest): Promise<TrApplyResult | null>;
  rollback(stepId: string): Promise<TrRollbackResult | null>;
}

/** Журнал переводов файла, как он записан. */
export interface OfficeTranslationState {
  baseHash: string;
  records: OfficeTranslationRecord[];
  displayLabels: Record<string, string>;
  schema?: unknown;
}

export interface OfficeTranslationFileLink {
  /** Журнал без записи правок редактора (чтение области, пока документ не менялся). */
  state(): Promise<OfficeTranslationState>;
  /** Записать правки редактора и вернуть журнал записанной версии (его baseHash — основа CAS). */
  committed(): Promise<OfficeTranslationState>;
  /** Причина, по которой писать нельзя (общий файл без права держателя, выпущенная ревизия); '' — можно. */
  writeBlocked?(): string;
  /** Содержимое редактора и журнал — одним сохранением с проверкой baseHash; false — не записано. */
  saveWithTranslation(delta: OfficeTranslationDelta, baseHash: string): Promise<boolean>;
  /** Копия записанного исходника перед «Заменить»: файл не меняется. */
  saveBackup(): Promise<void>;
  /** Новый DOCX: байты от редактора → новый файл рядом; журнал — в его метаданные. */
  saveCopy(bytes: ArrayBuffer, name: string, records?: OfficeTranslationRecord[]): Promise<void>;
  /** Новая книга: Save-As копии движком Таблицы с журналом в метаданных копии. */
  saveSheetsCopy(records: OfficeTranslationRecord[]): Promise<void>;
}

/** Ворота: пока открыта постановка, обычное и автосохранение окна ждут её конца. */
export interface OfficeTranslationGate {
  begin(): () => void;
  /** Обычное сохранение вызывает перед записью; свободно — вернётся сразу. */
  wait(): Promise<void>;
  busy(): boolean;
}

export interface UseOfficeTranslationOptions {
  app: 'docs' | 'sheets';
  fileId: string;
  /** Только чтение хоста: панель читает и показывает, но «Применить» неактивна. */
  readOnly: boolean;
  editor: OfficeTranslationEditorLink;
  file: OfficeTranslationFileLink;
  gate: OfficeTranslationGate;
}

/** Мост для TranslationBridgeProvider вокруг панели «Переводчик» (read/apply/saveBackup/saveCopy…). */
export function useOfficeTranslation(_options: UseOfficeTranslationOptions): OfficeTranslationBridge {
  throw new Error('not implemented: useOfficeTranslation');
}

/** Простые ворота на ref: хост создаёт один раз и передаёт и в хук, и в своё сохранение. */
export function createTranslationGate(): OfficeTranslationGate {
  let open = 0;
  let waiters: Array<() => void> = [];
  const release = () => { if (--open === 0) { const list = waiters; waiters = []; list.forEach((f) => f()); } };
  return {
    begin: () => { open++; let done = false; return () => { if (!done) { done = true; release(); } }; },
    wait: () => (open === 0 ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve))),
    busy: () => open > 0,
  };
}
