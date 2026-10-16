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

/** Общая привязка документа хранит установку, а не каждый импортированный компонент. */
export function draftDocumentBindingTargets(
  associations: { systemIds?: string[]; equipmentIds?: string[] } | null | undefined,
  preferredSystemId?: string,
): { equipmentIds: string[]; systemId?: string } {
  const systemIds = [...new Set((associations?.systemIds || []).filter(id => typeof id === 'string' && id))];
  const systemId = preferredSystemId || (systemIds.length === 1 ? systemIds[0] : undefined);
  return { equipmentIds: [], ...(systemId ? { systemId } : {}) };
}

/** Запись данных импорта независима от best-effort обновления источника. */
export async function importWithBestEffortBinding<TSummary, TBinding>(
  importData: () => Promise<TSummary>,
  saveBinding: (summary: TSummary) => Promise<TBinding>,
  attachBinding: (summary: TSummary, binding: TBinding) => void,
): Promise<{ summary: TSummary; bindingWarning: string | null }> {
  const summary = await importData();
  try {
    const binding = await saveBinding(summary);
    attachBinding(summary, binding);
    return { summary, bindingWarning: null };
  } catch (error: any) {
    return { summary, bindingWarning: error?.message || 'Данные сохранены, но привязку источника создать не удалось.' };
  }
}

/** Повторный импорт документа несёт проектную привязку и ревизию CAS журнала. */
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
