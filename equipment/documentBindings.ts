import type { PortableFolderLocator } from '../filesystem/contracts.js';

/** Exact matching policy kept with the source so later revisions cannot widen silently. */
export type FilenameMatchRule =
  | { kind: 'exact-tag' }
  | { kind: 'selected-name'; fileName: string }
  | { kind: 'document-name'; fileName: string };
export type EquipmentDocumentFilenameRule = FilenameMatchRule;

/** Shared provenance for an equipment source; device-local capabilities stay in the renderer. */
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
