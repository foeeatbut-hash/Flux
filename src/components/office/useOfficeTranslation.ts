import { useMemo, useRef } from 'react';
import type {
  OfficeTranslationApplyItem, OfficeTranslationApplyPayload, OfficeTranslationBridge, OfficeTranslationPreviewItem,
  OfficeTranslationRecord, OfficeTranslationUnit,
} from './TranslationBridgeContext';
import type { OfficeTranslationDelta } from '../../../office/translationPackage';
import type { TrApplyItem, TrApplyRequest, TrApplyResult, TrReadRequest, TrReadResult, TrRollbackResult } from '../../../tools/genoffice/inject/translation-bridge';

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

/** Слова для человека по коду отказа редактора; текст самого редактора, если он есть, важнее. */
const CODE_TEXT: Record<string, string> = {
  'not-ready': 'Редактор ещё загружается. Подождите немного и повторите.',
  'read-only': 'Файл открыт только для просмотра, перевод не записан.',
  'busy': 'Перевод уже выполняется. Дождитесь его окончания.',
  'too-many': 'Слишком много фрагментов за один раз. Сузьте область: выберите лист или выделение.',
  'source-changed': 'Документ изменился после чтения. Прочитайте его заново.',
  'not-confirmed': 'Есть непроверенный фрагмент. Подтвердите или пропустите его.',
  'protected-changed': 'В переводе потеряна плашка Flux или защищённый фрагмент (код, число, обозначение). Верните его на место.',
  'unsupported-mode': 'Этот способ размещения не поддерживается в открытом редакторе.',
  'cannot-rollback': 'После перевода в документе были другие правки. Отмените перевод вручную (Ctrl+Z).',
  'failed': 'Редактор не смог выполнить перевод.',
};
const SILENT = 'Редактор не ответил. Проверьте, что документ открыт и загружен, и повторите.';

export function translationErrorText(result: { error?: string; code?: string } | null | undefined): string {
  if (!result) return SILENT;
  return result.error || (result.code && CODE_TEXT[result.code]) || CODE_TEXT.failed;
}
const reason = (error: unknown): string => String((error as { message?: string } | null)?.message || error || 'неизвестная ошибка');
const destinationOf = (direction: 'ru-en' | 'en-ru'): string => (direction === 'ru-en' ? 'en' : 'ru');

/**
 * Порядок постановки без React: хук держит его на живых ссылках окна, а модульный
 * набор (scripts/test-office-translation-hook.ts) проверяет с фальшивыми редактором и файлом.
 */
export function createTranslationFlow(live: () => UseOfficeTranslationOptions): OfficeTranslationBridge {
  const options = live();
  const toApplyItem = (item: OfficeTranslationApplyItem): TrApplyItem => ({
    key: item.key, source: item.source, targetText: item.targetText, confirmed: item.confirmed === true,
    location: item.location, ...(item.sourceId ? { sourceId: item.sourceId } : {}), ...(item.fieldKey ? { fieldKey: item.fieldKey } : {}),
  });
  const request = (payload: OfficeTranslationApplyPayload, state: OfficeTranslationState, dryRun: boolean): TrApplyRequest => ({
    items: payload.items.map(toApplyItem), placement: payload.placement as TrApplyRequest['placement'], direction: payload.direction,
    records: state.records as TrApplyRequest['records'], schema: payload.schema ?? state.schema, displayLabels: payload.displayLabels ?? state.displayLabels,
    ...(dryRun ? { dryRun: true } : {}),
  });

  return {
    get app() { return live().app; },
    get fileId() { return live().fileId; },
    get readOnly() { return live().readOnly; },

    async read(scope, direction = 'ru-en') {
      const { editor, file } = live();
      try {
        const state = await file.state();
        const result = await editor.read({ scope, records: state.records as TrReadRequest['records'], destination: destinationOf(direction), schema: state.schema });
        if (!result?.ok) return { ok: false, error: translationErrorText(result) };
        const units: OfficeTranslationUnit[] = (result.units || []).map((unit) => ({
          key: unit.key, source: unit.source, targetText: unit.targetText, sourceId: unit.sourceId, fieldKey: unit.fieldKey,
          displayLabel: unit.displayLabel, location: unit.location, verified: unit.verified,
          status: unit.status, stale: unit.status === 'stale' || unit.status === 'detached' || unit.stale === true, chips: unit.chips,
        }));
        return { ok: true, units, sourceRevision: state.baseHash, schema: state.schema, displayLabels: state.displayLabels, records: state.records };
      } catch (error) { return { ok: false, error: reason(error) }; }
    },

    async preview(payload) {
      const { editor, file } = live();
      try {
        const state = await file.state();
        const result = await editor.apply(request(payload, state, true));
        if (!result?.ok) return { ok: false, error: translationErrorText(result) };
        return { ok: true, items: (result.preview || []) as OfficeTranslationPreviewItem[] };
      } catch (error) { return { ok: false, error: reason(error) }; }
    },

    async apply(payload) {
      const { editor, file, gate, readOnly } = live();
      if (readOnly) return { ok: false, error: 'Файл открыт только для просмотра: перевод не записан.' };
      const blocked = file.writeBlocked?.() || '';
      if (blocked) return { ok: false, error: blocked };
      // Пока идёт постановка, обычное и автосохранение окна ждут: иначе в файл ушла бы половина перевода
      const release = gate.begin();
      let stepId: string | undefined;
      try {
        // 1. Правки редактора — в файл: хеш записанной версии становится основой проверки CAS
        const committed = await file.committed();
        // «Заменить»: сначала копия записанного исходника, и только потом изменение документа
        if (payload.placement.mode === 'replace') {
          try { await file.saveBackup(); }
          catch (error) { return { ok: false, error: `Резервная копия не создана, исходник не тронут: ${reason(error)}` }; }
        }
        // 2. Одна транзакция редактора (один шаг «назад») или отказ с целым документом
        const result = await editor.apply(request(payload, committed, false));
        if (!result) return { ok: false, error: SILENT };
        if (!result.ok) return { ok: false, error: translationErrorText(result) };
        stepId = result.stepId;
        // Новый DOCX / новая книга: исходник не менялся, байты копии идут отдельным файлом
        if (result.copy) {
          await file.saveCopy(result.copy.bytes, result.copy.suggestedName || 'Перевод.docx', result.records);
          return { ok: true, copied: true, records: result.records, message: 'Перевод сохранён отдельным файлом, исходник не тронут.' };
        }
        if (result.copyRequest) {
          if (!result.copyRequest.saved) await file.saveSheetsCopy(result.records || []);
          return { ok: true, copied: true, records: result.records, message: 'Перевод сохранён в новую книгу, исходник не тронут.' };
        }
        // 3. Содержимое и журнал — одним сохранением с проверкой версии
        const delta: OfficeTranslationDelta = {
          records: (result.records || []) as OfficeTranslationDelta['records'],
          removeRecords: (result.removeRecords || []) as OfficeTranslationDelta['removeRecords'],
          ...(result.headerSchema ? { headerSchema: result.headerSchema } : {}),
          ...(result.displayLabels ? { displayLabels: result.displayLabels } : {}),
        };
        let failure = '';
        try { if (!(await file.saveWithTranslation(delta, committed.baseHash))) failure = 'Файл не записан.'; }
        catch (error) { failure = reason(error); }
        if (failure) {
          // 4. Отказ записи: перевод в документе отменяется тем же шагом «назад»
          const back = stepId ? await editor.rollback(stepId).catch(() => null) : null;
          const tail = back?.ok ? 'Перевод в документе отменён.' : 'Перевод остался в документе и не записан в файл: отмените его через «Назад» (Ctrl+Z) или сохраните копию.';
          return { ok: false, error: `${failure.replace(/[.\s]+$/, '')}. ${tail}` };
        }
        return { ok: true, records: result.records, removeRecords: result.removeRecords, stepId, message: 'Перевод записан в файл вместе с журналом.' };
      } catch (error) {
        // Сбой до записи (чтение журнала, сохранение правок, копия): документ мог измениться, если шаг уже сделан
        if (stepId) await editor.rollback(stepId).catch(() => null);
        return { ok: false, error: reason(error) };
      } finally { release(); }
    },
  };
}

/** Мост для TranslationBridgeProvider вокруг панели «Переводчик». Окно создаёт один раз; ссылки читаются живыми. */
export function useOfficeTranslation(options: UseOfficeTranslationOptions): OfficeTranslationBridge {
  const ref = useRef(options); ref.current = options;
  return useMemo(() => createTranslationFlow(() => ref.current), [options.app, options.fileId]);
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
