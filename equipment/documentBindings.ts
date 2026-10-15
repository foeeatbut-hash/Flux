import type { PortableFolderLocator } from '../filesystem/contracts.js';

/** Сохраняем точное правило вместе с источником, чтобы будущий импорт незаметно не расширил совпадения. */
export type FilenameMatchRule =
  | { kind: 'exact-tag' }
  | { kind: 'selected-name'; fileName: string }
  | { kind: 'document-name'; fileName: string };
export type EquipmentDocumentFilenameRule = FilenameMatchRule;

/** Общие сведения об источнике хранятся на сервере; локальные возможности устройства остаются в renderer. */
export interface EquipmentDocumentBinding {
  id: string;
  projectId: string;
  kind: 'cad-xml' | 'document';
  xmlSourceId?: string;
  equipmentIds: string[];
  systemId?: string;
  tag?: string;
  locator?: PortableFolderLocator;
  fileName: string;
  rule?: FilenameMatchRule;
  latestRevision?: { revision: string; sha256: string; updatedAt: string };
  createdAt: string;
  updatedAt: string;
}

export interface EquipmentDocumentBindingsView {
  revision: number;
  canManage: boolean;
  bindings: EquipmentDocumentBinding[];
}

export interface EquipmentDocumentBindingLedger {
  revision: number;
  bindings: EquipmentDocumentBinding[];
  undo: Array<{
    id: string;
    beforeRevision: number;
    afterRevision: number;
    before: EquipmentDocumentBinding[];
    after: EquipmentDocumentBinding[];
  }>;
}

export interface EquipmentDocumentBindingInput {
  id?: string;
  kind: EquipmentDocumentBinding['kind'];
  xmlSourceId?: string;
  equipmentIds: string[];
  systemId?: string;
  tag?: string;
  locator?: PortableFolderLocator;
  fileName: string;
  rule?: FilenameMatchRule;
  latestRevision?: { revision: string; sha256: string; updatedAt?: string };
}

/** Повторный импорт документа несёт общую привязку и ревизию CAS журнала. */
export interface EquipmentDocumentImportSource {
  id?: string;
  kind: 'document';
  expectedLedgerRevision: number;
  locator?: PortableFolderLocator;
  fileName: string;
  rule?: FilenameMatchRule;
  revision: string;
  sha256: string;
  systemId?: string;
  tag?: string;
}
