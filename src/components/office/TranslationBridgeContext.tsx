import React, { createContext, useContext, type ReactNode } from 'react';
import type { OfficeTranslationRecord, TranslationApp, TranslationLangDirection, TranslationPlacementPayload, TranslationScope } from '../../translate/placement';

export interface OfficeTranslationUnit {
  key: string;
  source: string;
  targetText?: string;
  sourceId?: string;
  fieldKey?: string;
  displayLabel?: string;
  location: Record<string, unknown>;
  verified?: boolean;
  stale?: boolean;
  /** Состояние относительно журнала: new / current / stale / detached / replaced. */
  status?: 'new' | 'current' | 'stale' | 'detached' | 'replaced';
  /** Сколько плашек вынуто из исходника (знаки U+E5C0…). */
  chips?: number;
  origin?: string;
  missing?: string[];
}

export type { OfficeTranslationRecord } from '../../translate/placement';

export interface OfficeTranslationRead {
  ok: boolean;
  units?: OfficeTranslationUnit[];
  sourceRevision?: string;
  schema?: unknown;
  displayLabels?: Record<string, string>;
  records?: OfficeTranslationRecord[];
  error?: string;
}

export interface OfficeTranslationApplyItem extends OfficeTranslationUnit {
  targetText: string;
  confirmed?: boolean;
}

export interface OfficeTranslationApplyResult {
  ok: boolean;
  records?: OfficeTranslationRecord[];
  /** Прежние записи, которые заменяет постановка (повтор без дублей). */
  removeRecords?: OfficeTranslationRecord[];
  stepId?: string;
  /** Постановка создала отдельный файл или копию, исходник не тронут. */
  copied?: boolean;
  /** Как записан результат: слова для человека («Перевод записан в файл», «Копия сохранена»). */
  message?: string;
  error?: string;
}

/** Строка предпросмотра, как её вернул редактор (dryRun): что было и что станет. */
export interface OfficeTranslationPreviewItem {
  key: string;
  location: Record<string, unknown>;
  before: string;
  after: string;
  target: 'same' | 'new-block' | 'new-cell' | 'new-sheet' | 'new-file';
}

export interface OfficeTranslationApplyPayload {
  items: OfficeTranslationApplyItem[];
  placement: TranslationPlacementPayload;
  direction: TranslationLangDirection;
  schema?: unknown;
  displayLabels?: Record<string, string>;
}

/**
 * Мост панели с окном. Резервная копия перед «Заменить», копия для «Нового файла»,
 * постановка и запись одним сохранением — дело хука (useOfficeTranslation): панель
 * говорит только «прочитай / покажи / поставь».
 */
export interface OfficeTranslationBridge {
  app: TranslationApp;
  fileId: string;
  readOnly: boolean;
  read: (scope: TranslationScope, direction?: TranslationLangDirection) => Promise<OfficeTranslationRead>;
  /** Предпросмотр без изменения документа (dryRun редактора). */
  preview?: (payload: OfficeTranslationApplyPayload) => Promise<{ ok: boolean; items?: OfficeTranslationPreviewItem[]; error?: string }>;
  apply: (payload: OfficeTranslationApplyPayload) => Promise<OfficeTranslationApplyResult>;
}

const TranslationBridgeContext = createContext<OfficeTranslationBridge | null>(null);

export function TranslationBridgeProvider({ value, children }: { value: OfficeTranslationBridge; children: ReactNode }) {
  return <TranslationBridgeContext.Provider value={value}>{children}</TranslationBridgeContext.Provider>;
}

export function useTranslationBridge(): OfficeTranslationBridge | null {
  return useContext(TranslationBridgeContext);
}
