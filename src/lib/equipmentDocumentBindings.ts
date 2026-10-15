import type {
  EquipmentDocumentBinding,
  EquipmentDocumentBindingInput,
  EquipmentDocumentBindingsView,
} from '../../equipment/documentBindings';
import { useStore } from '../store/store';
import { windowsFilesRequest, type WindowsFileRef, type WindowsFileEntry } from './windowsFiles';

const api = (path: string) => `/api${path}`;
const LOCAL_REFS_KEY = 'flux.equipmentDocumentRefs.local.v1';

export interface LocalEquipmentDocumentRef {
  projectId: string;
  bindingId: string;
  sourceFolder: WindowsFileRef;
  fileRef?: WindowsFileRef;
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
  if (!userId || !value.projectId || !value.bindingId || !value.sourceFolder?.rootId || !value.sourceFolder.relativePath) return;
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
          queue.push({ ref: { rootId: current.ref.rootId, relativePath: entry.relativePath, ...(entry.draftId ? { draftId: entry.draftId } : {}) }, depth: current.depth + 1, revision: current.depth === 0 ? entry.name : current.revision });
        }
      }
      offset = page.data.nextOffset ?? -1;
    } while (offset >= 0);
  }
  if (!matches.length) return null;
  matches.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  const newest = matches[0];
  const hash = await windowsFilesRequest<{ sha256: string }>({ action: 'fileHash', ref: newest.ref });
  if (hash.ok === false) return null;
  return { fileRef: newest.ref, sourceFolder: folder, revision: newest.revision, sha256: hash.data.sha256, modifiedAt: newest.modifiedAt };
}
