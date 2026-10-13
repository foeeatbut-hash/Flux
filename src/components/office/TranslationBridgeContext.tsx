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
  copy?: { bytes: ArrayBuffer; suggestedName?: string };
  copyRequest?: { kind: 'word-copy'; json: unknown } | { kind: 'sheets-save-as'; packet: unknown };
  pendingTranslation?: {
    records: OfficeTranslationRecord[];
    headerSchema?: unknown;
    displayLabels?: Record<string, string>;
  };
  error?: string;
}

export interface OfficeTranslationBridge {
  app: TranslationApp;
  fileId: string;
  readOnly: boolean;
  read: (scope: TranslationScope) => Promise<OfficeTranslationRead>;
  apply: (payload: {
    items: OfficeTranslationApplyItem[];
    placement: TranslationPlacementPayload;
    direction: TranslationLangDirection;
    schema?: unknown;
    displayLabels?: Record<string, string>;
  }) => Promise<OfficeTranslationApplyResult>;
  /** Сохранить перед заменой исходника отдельную копию его текущих байтов. */
  saveBackup?: () => Promise<void>;
  /** Создать отдельный файл с уже сериализованными байтами; исходник не трогается. */
  saveCopy?: (bytes: ArrayBuffer, name: string, records?: OfficeTranslationRecord[]) => Promise<void>;
  saveCopyRequest?: (request: NonNullable<OfficeTranslationApplyResult['copyRequest']>, records?: OfficeTranslationRecord[]) => Promise<void>;
}

const TranslationBridgeContext = createContext<OfficeTranslationBridge | null>(null);

export function TranslationBridgeProvider({ value, children }: { value: OfficeTranslationBridge; children: ReactNode }) {
  return <TranslationBridgeContext.Provider value={value}>{children}</TranslationBridgeContext.Provider>;
}

export function useTranslationBridge(): OfficeTranslationBridge | null {
  return useContext(TranslationBridgeContext);
}
