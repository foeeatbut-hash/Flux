/**
 * Переводчик Flux Office: протокол «окно Flux ↔ редактор» и подключение.
 *
 * Модуль сборка кладёт в оба редактора (build.mjs). Пока подключения нет:
 * `installTranslationBridge` — заготовка, патчи patches.mjs его не вызывают
 * (список оставшейся проводки — в .claude/progress/translator-02.md).
 *
 * Протокол один для обоих редакторов, меняется только транспорт:
 *
 *            Документ (askFrame: событие → ответ)        Таблица (ipc: канал → канал-ответ)
 *   чтение   fluxTranslationRead   → flux:translation-read     flux:translation-read-request   → flux:translation-read
 *   запись   fluxTranslationApply  → flux:translation-applied  flux:translation-apply-request  → flux:translation-applied
 *   откат    fluxTranslationRollback → flux:translation-rolled-back   flux:translation-rollback-request → flux:translation-rolled-back
 *
 * Тела — типы из translation-common.ts:
 *   чтение  TrReadRequest  → TrReadResult   (units со статусом new/current/stale/detached/replaced — это и есть проверка
 *                                          устаревших: окно присылает records журнала, редактор сверяет хеш исходника)
 *   запись  TrApplyRequest → TrApplyResult  (dryRun:true — только preview; иначе одна транзакция = один шаг «назад»,
 *                                          результат несёт records/removeRecords для журнала и stepId для отката)
 *   откат   TrRollbackRequest → TrRollbackResult (undo ровно своего шага; code 'cannot-rollback', если шаг уже не верхний)
 *
 * Блокировка: пока идёт постановка, редактор отвечает на второй запрос кодом 'busy'; обычное сохранение окна Flux ждёт
 * конца постановки (хук useOfficeTranslation держит ворота gate). Любой отказ — документ без изменений.
 */
import type { TrApplyRequest, TrApplyResult, TrReadRequest, TrReadResult, TrRollbackRequest, TrRollbackResult } from './translation-common'

export type { TrApplyRequest, TrApplyResult, TrReadRequest, TrReadResult, TrRollbackRequest, TrRollbackResult }
export type { TrApp, TrErrorCode, TrMode, TrPlacement, TrPreviewItem, TrRecord, TrScope, TrStatus, TrUnit, TrApplyItem } from './translation-common'

export const TRANSLATION_CHANNELS = {
  docs: {
    read: { event: 'fluxTranslationRead', answer: 'flux:translation-read' },
    apply: { event: 'fluxTranslationApply', answer: 'flux:translation-applied' },
    rollback: { event: 'fluxTranslationRollback', answer: 'flux:translation-rolled-back' },
  },
  sheets: {
    read: { event: 'flux:translation-read-request', answer: 'flux:translation-read' },
    apply: { event: 'flux:translation-apply-request', answer: 'flux:translation-applied' },
    rollback: { event: 'flux:translation-rollback-request', answer: 'flux:translation-rolled-back' },
  },
} as const

/** Таймауты ответа, мс: окно Flux считает редактор молчащим, если ответа нет. */
export const TRANSLATION_TIMEOUT = { read: 30_000, apply: 120_000, rollback: 15_000 } as const

/** Что редактор обязан уметь; реализуют translation-word.ts (Документ) и translation-sheets.ts (Таблица). */
export interface EditorTranslator {
  read(req: TrReadRequest): Promise<TrReadResult>
  apply(req: TrApplyRequest): Promise<TrApplyResult>
  rollback(req: TrRollbackRequest): Promise<TrRollbackResult>
}

/** Подключить переводчик к транспорту редактора. ЗАГОТОВКА: проводку делают дорожки Документа и Таблицы. */
export function installTranslationBridge(_app: 'docs' | 'sheets', _translator: EditorTranslator): void {
  throw new Error('not implemented: installTranslationBridge')
}
