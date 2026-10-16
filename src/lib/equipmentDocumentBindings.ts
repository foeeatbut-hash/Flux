import type {
  EquipmentDocumentBinding,
  EquipmentDocumentBindingInput,
  EquipmentDocumentImportSource,
  EquipmentDocumentBindingsView,
} from '../../equipment/documentBindings';
import { useStore } from '../store/store';
import { windowsFilesRequest, type WindowsFileRef, type WindowsFileEntry } from './windowsFiles';
import { getEquipmentSourceBinding, saveEquipmentSourceBinding, type LocalEquipmentSourceBinding } from './equipmentSourcesLocal';
import type { EquipmentXmlTargetIdentity } from '../../equipment/sourceXml';

const api = (path: string) => `/api${path}`;
const LOCAL_REFS_KEY = 'flux.equipmentDocumentRefs.local.v1';

export interface LocalEquipmentDocumentRef {
  projectId: string;
  bindingId: string;
  sourceFolder: WindowsFileRef;
  fileRef?: WindowsFileRef;
}

export interface EquipmentSourceBindingContext {
  sourceId: string;
  projectId?: string;
  tagId?: string;
  tagIdentifier?: string;
  xmlTargetIdentity?: EquipmentXmlTargetIdentity | null;
  elementId: string;
  targetType: 'system' | 'component';
  systemId?: string;
  revisionOrder?: string[];
  selectedRule?: LocalEquipmentSourceBinding['selectedRule'];
}

/** Resolve a source's device-local capability from its shared portable locator when needed. */
export async function resolveEquipmentSourceBinding(
  projectId: string,
  source: EquipmentSourceBindingContext,
  sharedBinding?: EquipmentDocumentBinding,
): Promise<LocalEquipmentSourceBinding | null> {
  const local = getEquipmentSourceBinding(projectId, source.sourceId, source.tagId, source.elementId);
  if (local) return local;

  const priorCapability = getLocalEquipmentDocumentRef(projectId, source.sourceId);
  if (priorCapability) {
    const restored: LocalEquipmentSourceBinding = {
      sourceId: source.sourceId, projectId,
      ...(source.tagId ? { tagId: source.tagId } : {}), ...(source.tagIdentifier ? { tagIdentifier: source.tagIdentifier } : {}),
      ...(source.xmlTargetIdentity ? { xmlTargetIdentity: source.xmlTargetIdentity } : {}),
      elementId: source.elementId, targetType: source.targetType, ...(source.systemId ? { systemId: source.systemId } : {}),
      rootId: priorCapability.sourceFolder.rootId, relativePath: priorCapability.sourceFolder.relativePath,
      ...(priorCapability.fileRef ? { selectedFileRef: priorCapability.fileRef } : {}),
      revisionOrder: source.revisionOrder || ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'],
      ...(source.selectedRule ? { selectedRule: source.selectedRule } : {}),
    };
    saveEquipmentSourceBinding(restored);
    return restored;
  }

  if (sharedBinding?.kind !== 'cad-xml' || (sharedBinding.xmlSourceId || sharedBinding.id) !== source.sourceId || !sharedBinding.locator) return null;
  const resolved = await windowsFilesRequest<WindowsFileRef | null>({ action: 'resolvePortableFolder', locator: sharedBinding.locator });
  if (resolved.ok === false || !resolved.data) return null;
  const rule = sharedBinding.rule?.kind === 'exact-tag' || sharedBinding.rule?.kind === 'selected-name' ? sharedBinding.rule : undefined;
  const restored: LocalEquipmentSourceBinding = {
    sourceId: source.sourceId, projectId,
    ...(source.tagId ? { tagId: source.tagId } : {}), ...(source.tagIdentifier || sharedBinding.tag ? { tagIdentifier: source.tagIdentifier || sharedBinding.tag } : {}),
    ...(source.xmlTargetIdentity ? { xmlTargetIdentity: source.xmlTargetIdentity } : {}),
    elementId: source.elementId, targetType: source.targetType, ...(source.systemId || sharedBinding.systemId ? { systemId: source.systemId || sharedBinding.systemId } : {}),
    rootId: resolved.data.rootId, relativePath: resolved.data.relativePath,
    revisionOrder: source.revisionOrder || ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'],
    ...(source.selectedRule ? { selectedRule: source.selectedRule } : rule ? { selectedRule: rule } : {}),
  };
  saveEquipmentSourceBinding(restored);
  return restored;
}

export function equipmentDocumentImportSource(value: Omit<EquipmentDocumentImportSource, 'kind'>): EquipmentDocumentImportSource {
  return { ...value, kind: 'document' };
}

function localKey(projectId: string, bindingId: string, userId: string): string {
  return [userId, projectId, bindingId].map(encodeURIComponent).join(':');
}

function readLocalRefs(): Record<string, LocalEquipmentDocumentRef & { userId: string }> {
  try {
    const value = JSON.parse(localStorage.getItem(LOCAL_REFS_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

/** Локальная capability нужна на не-сетевом диске, но никогда не уходит в API. */
export function saveLocalEquipmentDocumentRef(value: LocalEquipmentDocumentRef): void {
  const userId = useStore.getState().user?.id;
  if (!userId || !value.projectId || !value.bindingId || !value.sourceFolder?.rootId || typeof value.sourceFolder.relativePath !== 'string') return;
  const all = readLocalRefs();
  all[localKey(value.projectId, value.bindingId, userId)] = { ...value, userId };
  localStorage.setItem(LOCAL_REFS_KEY, JSON.stringify(all));
}

export function getLocalEquipmentDocumentRef(projectId: string, bindingId: string): LocalEquipmentDocumentRef | null {
  const userId = useStore.getState().user?.id;
  if (!userId) return null;
  return readLocalRefs()[localKey(projectId, bindingId, userId)] || null;
}

export function removeLocalEquipmentDocumentRef(projectId: string, bindingId: string): void {
  const userId = useStore.getState().user?.id;
  if (!userId) return;
  const all = readLocalRefs();
  delete all[localKey(projectId, bindingId, userId)];
  localStorage.setItem(LOCAL_REFS_KEY, JSON.stringify(all));
}

export async function loadEquipmentDocumentBindings(projectId: string, signal?: AbortSignal): Promise<EquipmentDocumentBindingsView> {
  const response = await fetch(api(`/equipment/projects/${encodeURIComponent(projectId)}/document-bindings`), { signal });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Не удалось загрузить привязки документов оборудования.');
  if (!Number.isSafeInteger(body.revision) || !Array.isArray(body.bindings)) throw new Error('Сервер вернул некорректный список привязок документов.');
  return body as EquipmentDocumentBindingsView;
}

export async function upsertEquipmentDocumentBinding(projectId: string, expectedRevision: number, binding: EquipmentDocumentBindingInput): Promise<EquipmentDocumentBindingsView> {
  const response = await fetch(api(`/equipment/projects/${encodeURIComponent(projectId)}/document-bindings`), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision, operation: { kind: 'upsert', binding } }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Не удалось сохранить общую привязку документа.');
  return body as EquipmentDocumentBindingsView;
}

export function equipmentBindingLabel(binding: EquipmentDocumentBinding): string {
  return binding.tag || binding.fileName || 'Документ оборудования';
}

export function equipmentDocumentRevisionFolder(name: string): boolean {
  return /^[A-Z]$/iu.test(name) || /^\d{1,20}$/u.test(name);
}

/** Файл в папке ревизии относится к привязке родительской папки источника. */
export function canonicalDocumentSourceFolder(sourceFolder: WindowsFileRef, fileRef: WindowsFileRef): { sourceFolder: WindowsFileRef; revision?: string } {
  const sourcePath = sourceFolder.relativePath.replace(/\\/gu, '/').replace(/\/$/u, '');
  const filePath = fileRef.relativePath.replace(/\\/gu, '/');
  const rest = filePath.startsWith(sourcePath ? `${sourcePath}/` : '') ? filePath.slice(sourcePath ? sourcePath.length + 1 : 0).split('/').filter(Boolean) : [];
  const parts = sourcePath.split('/').filter(Boolean);
  const leaf = parts[parts.length - 1] || '';
  if (rest.length !== 1 || !equipmentDocumentRevisionFolder(leaf)) return { sourceFolder };
  const parentPath = parts.slice(0, -1).join('/');
  return { sourceFolder: { rootId: sourceFolder.rootId, relativePath: parentPath, ...(sourceFolder.draftId ? { draftId: sourceFolder.draftId } : {}) }, revision: leaf };
}

/** Ищет существующую привязку по общей папке или локальной capability устройства. */
export function findExistingEquipmentDocumentBinding(
  bindings: EquipmentDocumentBinding[], provenance: { sourceFolder?: WindowsFileRef; fileRef?: WindowsFileRef; portableLocator?: { folderKey: string } }, fileName: string,
): EquipmentDocumentBinding | undefined {
  if (!provenance.sourceFolder) return undefined;
  const sourceFolder = provenance.fileRef
    ? canonicalDocumentSourceFolder(provenance.sourceFolder, provenance.fileRef).sourceFolder
    : provenance.sourceFolder;
  const shared = provenance.portableLocator?.folderKey;
  if (shared) {
    const match = bindings.find(item => item.kind === 'document' && item.fileName === fileName && item.locator?.folderKey === shared);
    if (match) return match;
  }
  return bindings.find(item => {
    if (item.kind !== 'document' || item.fileName !== fileName) return false;
    const local = getLocalEquipmentDocumentRef(item.projectId, item.id);
    return !!local && local.sourceFolder.rootId === sourceFolder.rootId
      && local.sourceFolder.relativePath.replace(/\\/gu, '/') === sourceFolder.relativePath.replace(/\\/gu, '/');
  });
}

export async function findLatestBoundDocument(projectId: string, binding: EquipmentDocumentBinding): Promise<{ fileRef: WindowsFileRef; sourceFolder: WindowsFileRef; revision: string; sha256: string; modifiedAt: string } | null> {
  let folder = binding.locator ? null : getLocalEquipmentDocumentRef(projectId, binding.id)?.sourceFolder || null;
  if (binding.locator) {
    const resolved = await windowsFilesRequest<WindowsFileRef | null>({ action: 'resolvePortableFolder', locator: binding.locator });
    if (resolved.ok === false) return null;
    folder = resolved.data;
  }
  if (!folder) return null;
  const queue: Array<{ ref: WindowsFileRef; depth: number; revision?: string }> = [{ ref: folder, depth: 0 }];
  const matches: Array<{ ref: WindowsFileRef; modifiedAt: string; revision: string }> = [];
  let visited = 0;
  while (queue.length && visited++ < 80) {
    const current = queue.shift()!;
    let offset = 0;
    do {
      const page = await windowsFilesRequest<{ entries: WindowsFileEntry[]; nextOffset: number | null }>({ action: 'list', ref: current.ref, offset, limit: 200 });
      if (page.ok === false) break;
      for (const entry of page.data.entries) {
        if (entry.kind === 'file' && entry.name.toLocaleLowerCase() === binding.fileName.toLocaleLowerCase()) {
          matches.push({ ref: { rootId: current.ref.rootId, relativePath: entry.relativePath, ...(entry.draftId ? { draftId: entry.draftId } : {}) }, modifiedAt: entry.modifiedAt, revision: current.revision || new Date(entry.modifiedAt).toISOString() });
        } else if (entry.kind === 'directory' && current.depth < 3) {
          queue.push({ ref: { rootId: current.ref.rootId, relativePath: entry.relativePath, ...(entry.draftId ? { draftId: entry.draftId } : {}) }, depth: current.depth + 1, revision: current.depth === 0 && equipmentDocumentRevisionFolder(entry.name) ? entry.name : current.revision });
        }
      }
      offset = page.data.nextOffset ?? -1;
    } while (offset >= 0);
  }
  if (queue.length) throw new Error('Проверка ревизий остановлена: в источнике больше 80 папок. Уточните папку источника или уменьшите число подпапок.');
  if (!matches.length) return null;
  matches.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  const newest = matches[0];
  const hash = await windowsFilesRequest<{ sha256: string }>({ action: 'fileHash', ref: newest.ref });
  if (hash.ok === false) return null;
  return { fileRef: newest.ref, sourceFolder: folder, revision: newest.revision, sha256: hash.data.sha256, modifiedAt: newest.modifiedAt };
}
