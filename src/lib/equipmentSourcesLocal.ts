import { XMLParser, XMLValidator } from 'fast-xml-parser';
import {
  base64ToBytes, windowsFilesRequest,
  type WindowsFileEntry, type WindowsFileRef, type WindowsFilesResponse,
  type WindowsFilesRequest,
} from './windowsFiles';
import type { WindowsEquipmentSourceFolderPick, WindowsEquipmentSourcePick } from '../../filesystem/contracts';
import { decodeEquipmentSourceXml, EQUIPMENT_SOURCE_MAX_BYTES, inferEquipmentSourceFilenameRule, matchesEquipmentSourceFilename, type EquipmentSourceFilenameRule } from '../../equipment/sourceXml';
import type { EquipmentXmlTargetIdentity } from '../../equipment/sourceXml';
import { useStore } from '../store/store';
export type { EquipmentSourceFilenameRule } from '../../equipment/sourceXml';

export interface LocalEquipmentSourceBinding {
  sourceId: string;
  userId?: string;
  projectId: string;
  tagId?: string;
  systemId?: string;
  elementId?: string;
  targetType: 'system' | 'component';
  tagIdentifier?: string;
  xmlTargetIdentity?: EquipmentXmlTargetIdentity;
  rootId: string;
  relativePath: string;
  selectedFileRef?: WindowsFileRef;
  revisionOrder: string[];
  selectedRule?: EquipmentSourceFilenameRule;
}

export interface EquipmentSourceCandidate {
  revision: string;
  fileRef: WindowsFileRef;
  fileName: string;
  size: number;
  modifiedAt: string;
  sha256: string;
  base64: string;
  text: string;
  selectedRule: EquipmentSourceFilenameRule;
  revisionWarning?: string;
}

export type EquipmentSourceScanResult =
  | { status: 'ready'; candidates: EquipmentSourceCandidate[]; recommended?: EquipmentSourceCandidate; invalidFiles?: string[]; warnings?: string[] }
  | { status: 'source-unavailable' | 'no-match' | 'ambiguous' | 'invalid' | 'unstable'; candidates: EquipmentSourceCandidate[]; message: string; invalidFiles?: string[]; warnings?: string[] };

export type EquipmentSourcePreview =
  | { status: 'canceled' }
  | { status: 'ready'; selectedFile: { ref: WindowsFileRef; name: string }; sourceFolder: WindowsFileRef; suggestedTag?: string; revision: string; revisionWarning?: string; selectedRule: EquipmentSourceFilenameRule; sha256: string; size: number; modifiedAt: string; base64: string; text: string }
  | { status: 'invalid' | 'unstable' | 'source-unavailable'; message: string };

/** Первичный снимок XML до того, как сервер определил и подтвердил целевой тег. */
export type EquipmentSourceImportPreview =
  | { status: 'canceled' }
  | { status: 'ready'; selectedFile: { ref: WindowsFileRef; name: string }; sourceFolder: WindowsFileRef; suggestedTag?: string; revision: string; revisionWarning?: string; sha256: string; size: number; modifiedAt: string; base64: string; text: string }
  | { status: 'invalid' | 'unstable' | 'source-unavailable'; message: string };

export interface EquipmentSourceAdapter {
  list(ref: WindowsFileRef, offset: number, limit: number): Promise<WindowsFilesResponse<{ entries: WindowsFileEntry[]; nextOffset: number | null }>>;
  read(ref: WindowsFileRef): Promise<WindowsFilesResponse<{ name: string; size: number; modifiedAt: string; sha256: string; base64: string }>>;
}
export type EquipmentSourceRequest = <T = unknown>(request: WindowsFilesRequest) => Promise<WindowsFilesResponse<T>>;

const STORAGE_KEY = 'flux.equipmentSources.local.v1';
const MAX_SOURCE_ENTRIES = 1000;
const systemNames = new Set(['system', 'equipmentsystem', 'установка', 'unit']);
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, trimValues: true, parseTagValue: false, parseAttributeValue: false });

export function isEquipmentRevisionName(value: string, revisionOrder: string[] = []): boolean {
  return /^[A-Z]$/iu.test(value) || /^\d{1,20}$/u.test(value) || revisionOrder.some(revision => revision.toLocaleUpperCase() === value.toLocaleUpperCase());
}

export function compareEquipmentRevisionNames(left: string, right: string, revisionOrder: string[] = []): number {
  const rank = new Map(revisionOrder.map((revision, index) => [revision.toUpperCase(), index]));
  const leftRank = rank.get(left.toUpperCase()); const rightRank = rank.get(right.toUpperCase());
  if (leftRank !== undefined || rightRank !== undefined) return (leftRank ?? Number.MAX_SAFE_INTEGER) - (rightRank ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' });
  return left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' });
}

function keyOf(binding: Pick<LocalEquipmentSourceBinding, 'projectId' | 'sourceId' | 'tagId' | 'elementId'>, userId: string): string {
  return [userId, binding.projectId, binding.sourceId, binding.elementId || ''].map(encodeURIComponent).join(':');
}

function legacyKeyOf(binding: Pick<LocalEquipmentSourceBinding, 'projectId' | 'sourceId' | 'tagId' | 'elementId'>, userId: string): string {
  return [userId, binding.projectId, binding.sourceId, binding.tagId || '', binding.elementId || ''].map(encodeURIComponent).join(':');
}

/** Локальная привязка содержит только capability Проводника, а не абсолютный путь или данные проекта. */
export function saveEquipmentSourceBinding(binding: LocalEquipmentSourceBinding): void {
  if (!binding.sourceId || !binding.projectId || !binding.elementId || (!binding.tagId && !binding.xmlTargetIdentity) || !binding.rootId || !['system', 'component'].includes(binding.targetType)) throw new Error('Неполная привязка источника оборудования.');
  if (binding.relativePath.startsWith('/') || /^[a-z]:/iu.test(binding.relativePath) || binding.relativePath.split(/[\\/]/u).some((part) => part === '..') || binding.revisionOrder.length > 32 || new Set(binding.revisionOrder).size !== binding.revisionOrder.length) throw new Error('Некорректная папка или порядок ревизий источника.');
  const storage = localStorage;
  const userId = useStore.getState().user?.id;
  if (!userId) throw new Error('Войдите в Flux, чтобы сохранить локальный источник оборудования.');
  const all = readAllBindings();
  all[keyOf(binding, userId)] = { ...binding, userId, relativePath: binding.relativePath.replaceAll('\\', '/'), revisionOrder: [...binding.revisionOrder] };
  storage.setItem(STORAGE_KEY, JSON.stringify(all));
}

export function getEquipmentSourceBinding(projectId: string, sourceId: string, tagId?: string, elementId?: string): LocalEquipmentSourceBinding | null {
  const userId = useStore.getState().user?.id;
  if (!userId) return null;
  const all = readAllBindings();
  return all[keyOf({ projectId, sourceId, tagId, elementId }, userId)] || all[legacyKeyOf({ projectId, sourceId, tagId, elementId }, userId)] || null;
}

/** Меняет capability-пути выбранных источников одним localStorage commit. */
export interface EquipmentSourceBindingSnapshot { storageKey: string; userId: string; sourceId: string; binding: LocalEquipmentSourceBinding | null }

export function captureEquipmentSourceBindings(projectId: string, rows: Array<{ sourceId: string; binding: LocalEquipmentSourceBinding }>): EquipmentSourceBindingSnapshot[] {
  const userId = useStore.getState().user?.id;
  if (!userId) throw new Error('Войдите в Flux, чтобы перепривязать локальные источники оборудования.');
  if (!rows.length || rows.length > 250 || new Set(rows.map(row => row.sourceId)).size !== rows.length) throw new Error('Выбор источников пуст или содержит повторы.');
  const all = readAllBindings();
  return rows.map(({ sourceId, binding }) => {
    if (binding.projectId !== projectId || binding.sourceId !== sourceId) throw new Error('Недостаточно данных для восстановления локальной привязки источника.');
    const entry = Object.entries(all).find(([, value]) => value.projectId === projectId && value.sourceId === sourceId && (value.userId || userId) === userId);
    return { storageKey: entry?.[0] || keyOf(binding, userId), userId, sourceId, binding: entry ? { ...entry[1] } : null };
  });
}

export function planEquipmentSourceFolderRebind(rows: Array<{ sourceId: string; tagIdentifier?: string }>, folder: WindowsFileRef): Array<{ sourceId: string; folder: WindowsFileRef }> {
  if (!rows.length || rows.length > 250 || new Set(rows.map(row => row.sourceId)).size !== rows.length) throw new Error('Выбор источников пуст или содержит повторы.');
  if (!folder.rootId || folder.relativePath.startsWith('/') || folder.relativePath.split(/[\\/]/u).some(part => part === '..')) throw new Error('Выбран некорректный корень общей папки.');
  if (rows.length === 1) return [{ sourceId: rows[0].sourceId, folder: { rootId: folder.rootId, relativePath: folder.relativePath.replaceAll('\\', '/') } }];
  return rows.map(row => {
    const tag = String(row.tagIdentifier || '').trim();
    if (!tag || /[\\/\u0000-\u001f]/u.test(tag) || tag === '.' || tag === '..') throw new Error('Для массовой перепривязки каждой позиции нужен тег, совпадающий с именем её папки.');
    return { sourceId: row.sourceId, folder: { rootId: folder.rootId, relativePath: [folder.relativePath.replaceAll('\\', '/').replace(/\/$/u, ''), tag].filter(Boolean).join('/') } };
  });
}

export function rebindEquipmentSourceFolders(projectId: string, changes: Array<{ sourceId: string; folder: WindowsFileRef; binding?: LocalEquipmentSourceBinding }>, expectedBefore: EquipmentSourceBindingSnapshot[]): { before: EquipmentSourceBindingSnapshot[]; after: EquipmentSourceBindingSnapshot[] } {
  const userId = useStore.getState().user?.id;
  if (!userId) throw new Error('Войдите в Flux, чтобы перепривязать локальные источники оборудования.');
  if (!changes.length || changes.length > 250 || new Set(changes.map(change => change.sourceId)).size !== changes.length) throw new Error('Выбор источников пуст или содержит повторы.');
  if (expectedBefore.length !== changes.length || expectedBefore.some(snapshot => snapshot.userId !== userId)) throw new Error('Локальный пользователь или состав источников изменился после предварительного просмотра. Перепривязка отменена.');
  const all = readAllBindings();
  const before: EquipmentSourceBindingSnapshot[] = [];
  const after: EquipmentSourceBindingSnapshot[] = [];
  for (const change of changes) {
    const { sourceId, folder } = change;
    const entry = Object.entries(all).find(([, value]) => value.projectId === projectId && value.sourceId === sourceId && (value.userId || userId) === userId);
    const expected = expectedBefore.find(snapshot => snapshot.sourceId === sourceId);
    if (!expected || expected.userId !== userId || (entry ? entry[0] !== expected.storageKey || JSON.stringify(entry[1]) !== JSON.stringify(expected.binding) : expected.binding !== null)) throw new Error('Локальную привязку изменили после предварительного просмотра. Перепривязка отменена, чтобы сохранить более новое решение.');
    const binding = entry?.[1] || change.binding;
    if (!binding || binding.projectId !== projectId || binding.sourceId !== sourceId) throw new Error('Недостаточно данных для восстановления локальной привязки источника.');
    const key = expected.storageKey;
    before.push({ storageKey: key, userId, sourceId, binding: entry ? { ...entry[1] } : null });
    const next = { ...binding, userId, rootId: folder.rootId, relativePath: folder.relativePath.replaceAll('\\', '/') };
    all[key] = next; after.push({ storageKey: key, userId, sourceId, binding: next });
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  return { before, after };
}

/** Отмена перепривязки восстанавливает только локальные ссылки; серверная история остаётся устаревшей. */
export function restoreEquipmentSourceBindings(snapshot: EquipmentSourceBindingSnapshot[], expectedCurrent: EquipmentSourceBindingSnapshot[]): void {
  const userId = useStore.getState().user?.id;
  if (!userId) throw new Error('Войдите в Flux, чтобы восстановить локальные источники оборудования.');
  const all = readAllBindings();
  if (snapshot.length !== expectedCurrent.length || snapshot.some(item => item.userId !== userId) || expectedCurrent.some(item => item.userId !== userId)) throw new Error('Снимок перепривязки неполон или пользователь изменился; откат отменён.');
  for (const saved of snapshot) {
    const current = all[saved.storageKey];
    const expected = expectedCurrent.find(item => item.storageKey === saved.storageKey)?.binding;
    if (!current || !expected || JSON.stringify(current) !== JSON.stringify(expected) || (current.userId || userId) !== userId) throw new Error('Локальную привязку изменили после перепривязки. Откат отменён, чтобы сохранить более новое решение.');
  }
  for (const saved of snapshot) { if (saved.binding) all[saved.storageKey] = { ...saved.binding, userId }; else delete all[saved.storageKey]; }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

export function removeEquipmentSourceBinding(projectId: string, sourceId: string, tagId: string, elementId?: string): void {
  const userId = useStore.getState().user?.id;
  if (!userId) return;
  const all = readAllBindings();
  delete all[keyOf({ projectId, sourceId, tagId, elementId }, userId)];
  delete all[legacyKeyOf({ projectId, sourceId, tagId, elementId }, userId)];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

function readAllBindings(): Record<string, LocalEquipmentSourceBinding> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/** Окно Windows возвращает только capability-ссылки; абсолютные пути остаются в Electron main. */
export async function pickEquipmentSource(tagIdentifier?: string, request: EquipmentSourceRequest = windowsFilesRequest, selected?: { ref: WindowsFileRef; name: string; sourceFolder?: WindowsFileRef; suggestedTag?: string }): Promise<WindowsFilesResponse<EquipmentSourcePreview>> {
  const adapter = bridgeAdapter(request);
  let selectedFile: { ref: WindowsFileRef; name: string };
  let sourceFolder: WindowsFileRef;
  let suggestedTag: string | undefined;
  if (selected) { selectedFile = { ref: selected.ref, name: selected.name }; sourceFolder = selected.sourceFolder || sourceFolderFor(selected.ref); suggestedTag = selected.suggestedTag; }
  else {
    const picked = await request<WindowsEquipmentSourcePick>({ action: 'pickEquipmentSource' });
    if ('error' in picked) return { ok: false, error: picked.error };
    if (!('selectedFile' in picked.data)) return { ok: true, data: { status: 'canceled' } };
    selectedFile = picked.data.selectedFile; sourceFolder = picked.data.sourceFolder; suggestedTag = picked.data.suggestedTag;
  }
  const bytes = await readStable(adapter, selectedFile.ref);
  if ('error' in bytes) return { ok: true, data: { status: isUnstableReadError(bytes.error.code) ? 'unstable' : 'source-unavailable', message: bytes.error.message } };
  const selectedRule = tagIdentifier ? inferEquipmentSourceFilenameRule(selectedFile.name, tagIdentifier) : (/\.xml$/iu.test(selectedFile.name) ? { kind: 'selected-name' as const, fileName: selectedFile.name } : null);
  if (!selectedRule) return { ok: true, data: { status: 'invalid', message: tagIdentifier ? `Имя XML-файла «${selectedFile.name}» не соответствует тегу «${tagIdentifier}».` : 'Выберите XML-файл.' } };
  const text = decodeXml(bytes.data.base64, bytes.data.size);
  if (!text || tagIdentifier && !xmlHasTargetTag(text, tagIdentifier, 'system') && !xmlHasTargetTag(text, tagIdentifier, 'component')) return { ok: true, data: { status: 'invalid', message: tagIdentifier ? `В XML-файле «${selectedFile.name}» не найдено оборудование с тегом «${tagIdentifier}».` : 'XML-файл повреждён или не содержит выбранную позицию.' } };
  const folderRevision = revisionBetween(sourceFolder, selectedFile.ref);
  const xmlRevision = extractRevisionFromXml(text);
  const revision = xmlRevision || folderRevision || '';
  if (!revision) return { ok: true, data: { status: 'invalid', message: 'Не удалось определить ревизию: выберите XML внутри папки ревизии A, B, C и т. д. либо укажите её в XML.' } };
  const revisionWarning = revisionMismatchWarning(folderRevision, xmlRevision);
  return { ok: true, data: { status: 'ready', selectedFile, sourceFolder, ...(suggestedTag ? { suggestedTag } : {}), revision, ...(revisionWarning ? { revisionWarning } : {}), selectedRule, sha256: bytes.data.sha256, size: bytes.data.size, modifiedAt: bytes.data.modifiedAt, base64: bytes.data.base64, text } };
}

/**
 * Первичный импорт не знает целевой тег заранее: отдаём только проверенный локальный снимок,
 * а серверный preview должен подтвердить структуру и точную привязку перед сохранением.
 */
export async function pickEquipmentSourceForImport(request: EquipmentSourceRequest = windowsFilesRequest, selected?: { ref: WindowsFileRef; name: string; sourceFolder?: WindowsFileRef; suggestedTag?: string }): Promise<WindowsFilesResponse<EquipmentSourceImportPreview>> {
  const adapter = bridgeAdapter(request);
  let selectedFile: { ref: WindowsFileRef; name: string };
  let sourceFolder: WindowsFileRef;
  let suggestedTag: string | undefined;
  if (selected) { selectedFile = { ref: selected.ref, name: selected.name }; sourceFolder = selected.sourceFolder || sourceFolderFor(selected.ref); suggestedTag = selected.suggestedTag; }
  else {
    const picked = await request<WindowsEquipmentSourcePick>({ action: 'pickEquipmentSource' });
    if ('error' in picked) return { ok: false, error: picked.error };
    if (!('selectedFile' in picked.data)) return { ok: true, data: { status: 'canceled' } };
    selectedFile = picked.data.selectedFile; sourceFolder = picked.data.sourceFolder; suggestedTag = picked.data.suggestedTag;
  }
  const snapshot = await readStable(adapter, selectedFile.ref);
  if ('error' in snapshot) return { ok: true, data: { status: isUnstableReadError(snapshot.error.code) ? 'unstable' : 'source-unavailable', message: snapshot.error.message } };
  const text = decodeXml(snapshot.data.base64, snapshot.data.size);
  if (!text || XMLValidator.validate(text) !== true) return { ok: true, data: { status: 'invalid', message: `XML-файл «${selectedFile.name}» пуст, повреждён или превышает допустимый размер.` } };
  const folderRevision = revisionBetween(sourceFolder, selectedFile.ref);
  const xmlRevision = extractRevisionFromXml(text);
  const revision = xmlRevision || folderRevision || '';
  if (!revision) return { ok: true, data: { status: 'invalid', message: 'Не удалось определить ревизию из XML или папки, содержащей выбранный файл.' } };
  const revisionWarning = revisionMismatchWarning(folderRevision, xmlRevision);
  return { ok: true, data: { status: 'ready', selectedFile, sourceFolder, ...(suggestedTag ? { suggestedTag } : {}), revision, ...(revisionWarning ? { revisionWarning } : {}), sha256: snapshot.data.sha256, size: snapshot.data.size, modifiedAt: snapshot.data.modifiedAt, base64: snapshot.data.base64, text } };
}

export async function pickEquipmentSourceFolder(request: EquipmentSourceRequest = windowsFilesRequest): Promise<WindowsFilesResponse<WindowsFileRef | null>> {
  const picked = await request<WindowsEquipmentSourceFolderPick>({ action: 'pickEquipmentSourceFolder' });
  if ('error' in picked) return { ok: false, error: picked.error };
  return { ok: true, data: 'folder' in picked.data ? picked.data.folder : null };
}

function sourceFolderFor(file: WindowsFileRef): WindowsFileRef {
  const parts = file.relativePath.replace(/\\/gu, '/').split('/').filter(Boolean);
  const parent = parts.slice(0, -1);
  if (parent.length && (/^[A-Z]$/iu.test(parent[parent.length - 1]) || /^\d{1,20}$/u.test(parent[parent.length - 1]))) parent.pop();
  return { rootId: file.rootId, relativePath: parent.join('/') };
}

export async function scanEquipmentSource(
  binding: LocalEquipmentSourceBinding,
  adapter: EquipmentSourceAdapter = nativeAdapter,
): Promise<EquipmentSourceScanResult> {
  const sourceFolder: WindowsFileRef = { rootId: binding.rootId, relativePath: binding.relativePath };
  const revisions = await listAll(adapter, sourceFolder, 'directory');
  if ('message' in revisions) return { status: 'source-unavailable', candidates: [], message: revisions.message };
  const order = binding.revisionOrder;
  const folders = revisions.entries.filter((entry) => entry.kind === 'directory' && isEquipmentRevisionName(entry.name, order));
  folders.sort((a, b) => compareEquipmentRevisionNames(a.name, b.name, order));
  const candidates: EquipmentSourceCandidate[] = [];
  const invalidFiles: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  let ambiguous = false;
  const matchesFile = (name: string) => binding.tagIdentifier
    ? matchesEquipmentSourceFilename(name, binding.tagIdentifier, binding.selectedRule)
    : binding.selectedRule?.kind === 'selected-name' && normalizeTag(name) === normalizeTag(binding.selectedRule.fileName);
  for (const folder of folders) {
    const folderRef = refForEntry(sourceFolder, folder);
    const files = await listAll(adapter, folderRef, 'file');
    if ('message' in files) { errors.push(files.message); continue; }
    const matching = files.entries.filter((entry) => matchesFile(entry.name));
    if (matching.length > 1) ambiguous = true;
    for (const entry of matching) {
      const fileRef = refForEntry(folderRef, entry);
      const read = await readStable(adapter, fileRef);
      if ('error' in read) {
        if (read.error.code === 'CONFLICT' || read.error.code === 'BUSY') errors.push(`unstable:${entry.name}`);
        else errors.push(read.error.message);
        continue;
      }
      const text = decodeXml(read.data.base64, read.data.size);
      if (!text || binding.tagIdentifier && !xmlHasTargetTag(text, binding.tagIdentifier, binding.targetType)) { invalidFiles.push(entry.name); continue; }
      const xmlRevision = extractRevisionFromXml(text);
      const revision = xmlRevision || folder.name;
      if (!revision) { invalidFiles.push(entry.name); continue; }
      const revisionWarning = revisionMismatchWarning(folder.name, xmlRevision);
      if (revisionWarning) warnings.push(`${entry.name}: ${revisionWarning}`);
      if (!isEquipmentRevisionName(revision, order)) { invalidFiles.push(`${entry.name} (некорректная ревизия ${revision})`); continue; }
      const selectedRule = binding.selectedRule || (binding.tagIdentifier ? inferEquipmentSourceFilenameRule(entry.name, binding.tagIdentifier) : null);
      if (!selectedRule) { invalidFiles.push(entry.name); continue; }
      candidates.push({ revision, fileRef, fileName: entry.name, size: read.data.size, modifiedAt: read.data.modifiedAt, sha256: read.data.sha256, base64: read.data.base64, text, selectedRule, ...(revisionWarning ? { revisionWarning } : {}) });
    }
  }
  const directFiles = await listAll(adapter, sourceFolder, 'file');
  if ('message' in directFiles) return { status: 'source-unavailable', candidates, message: directFiles.message };
  for (const entry of directFiles.entries.filter((file) => matchesFile(file.name))) {
    const fileRef = refForEntry(sourceFolder, entry);
    const read = await readStable(adapter, fileRef);
    if ('error' in read) {
      return { status: read.error.code === 'CONFLICT' || read.error.code === 'BUSY' ? 'unstable' : 'source-unavailable', candidates, message: read.error.message };
    }
    const text = decodeXml(read.data.base64, read.data.size);
    const revision = text ? extractRevisionFromXml(text) : null;
    if (!text || binding.tagIdentifier && !xmlHasTargetTag(text, binding.tagIdentifier, binding.targetType) || !revision) { invalidFiles.push(entry.name); continue; }
    if (!isEquipmentRevisionName(revision, order)) { invalidFiles.push(entry.name); continue; }
    const selectedRule = binding.selectedRule || (binding.tagIdentifier ? inferEquipmentSourceFilenameRule(entry.name, binding.tagIdentifier) : null);
    if (!selectedRule) { invalidFiles.push(entry.name); continue; }
    candidates.push({ revision, fileRef, fileName: entry.name, size: read.data.size, modifiedAt: read.data.modifiedAt, sha256: read.data.sha256, base64: read.data.base64, text, selectedRule });
  }
  if (candidates.length > 1 && new Set(candidates.map((candidate) => candidate.revision.toUpperCase())).size !== candidates.length) ambiguous = true;
  candidates.sort((a, b) => compareEquipmentRevisionNames(a.revision, b.revision, order));
  if (errors.some((value) => value.startsWith('unstable:'))) return { status: 'unstable', candidates, message: 'Один из XML-файлов изменяется или копируется. Повторите проверку позже.', ...(invalidFiles.length ? { invalidFiles } : {}) };
  if (errors.length) return { status: 'source-unavailable', candidates, message: errors[0], ...(invalidFiles.length ? { invalidFiles } : {}) };
  if (ambiguous) return { status: 'ambiguous', candidates, message: `В одной или нескольких ревизиях найдено несколько XML-файлов с выбранным правилом имени тега.${warnings.length ? ` ${[...new Set(warnings)].join(' ')}` : ''}`, ...(invalidFiles.length ? { invalidFiles } : {}), ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}) };
  if (invalidFiles.length) return { status: 'invalid', candidates, message: `XML-файлы источника «${binding.tagIdentifier || binding.elementId}» требуют проверки (${invalidFiles.join(', ')}). Более старые данные не следует считать актуальными.`, invalidFiles };
  if (warnings.length) return { status: 'invalid', candidates, message: `${[...new Set(warnings)].join(' ')} Проверьте папку и XML до сверки ревизии.`, warnings: [...new Set(warnings)] };
  if (!candidates.length) return { status: 'no-match', candidates, message: `В папках ревизий не найден XML для ${binding.tagIdentifier ? `тега «${binding.tagIdentifier}»` : 'выбранного имени файла'}.` };
  return { status: 'ready', candidates, recommended: candidates[candidates.length - 1], ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}) };
}

const nativeAdapter = bridgeAdapter(windowsFilesRequest);

function bridgeAdapter(request: EquipmentSourceRequest): EquipmentSourceAdapter {
  return {
    list: (ref, offset, limit) => request({ action: 'list', ref, offset, limit }),
    read: (ref) => request({ action: 'read', ref }),
  };
}

async function listAll(adapter: EquipmentSourceAdapter, ref: WindowsFileRef, kind: 'directory' | 'file') {
  const entries: WindowsFileEntry[] = [];
  let offset = 0;
  while (entries.length < MAX_SOURCE_ENTRIES) {
    const page = await adapter.list(ref, offset, Math.min(250, MAX_SOURCE_ENTRIES - entries.length));
    if ('error' in page) return { ok: false as const, message: page.error.message };
    entries.push(...page.data.entries.filter((entry) => entry.kind === kind && !entry.linked));
    if (page.data.nextOffset === null) return { ok: true as const, entries };
    offset = page.data.nextOffset;
  }
  return { ok: false as const, message: 'В папке слишком много файлов для проверки источника.' };
}

function refForEntry(parent: WindowsFileRef, entry: WindowsFileEntry): WindowsFileRef {
  return { rootId: parent.rootId, relativePath: [parent.relativePath, entry.name].filter(Boolean).join('/') };
}

function normalizeTag(value: string): string { return value.normalize('NFC').trim().toLowerCase(); }

function revisionBetween(folder: WindowsFileRef, file: WindowsFileRef): string {
  const base = folder.relativePath ? `${folder.relativePath}/` : '';
  const remainder = file.relativePath.startsWith(base) ? file.relativePath.slice(base.length) : file.relativePath;
  const first = remainder.split('/')[0] || '';
  return first && first !== file.relativePath.split('/').pop() ? first : '';
}

export function extractRevisionFromXml(text: string): string | null {
  try {
    const doc = parser.parse(text);
    const names = new Set(['revision', 'rev', 'edition', 'редакция', 'ревизия']);
    const visit = (node: unknown): string | null => {
      if (!node || typeof node !== 'object') return null;
      if (Array.isArray(node)) { for (const item of node) { const found = visit(item); if (found) return found; } return null; }
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        const normalized = key.replace(/^@_/u, '').toLowerCase();
        if (names.has(normalized)) {
          const candidate = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)['#text'] : value;
          const found = String(candidate ?? '').trim();
          if (found) return found;
        }
        const nested = visit(value); if (nested) return nested;
      }
      return null;
    };
    return visit(doc);
  } catch { return null; }
}

function revisionMismatchWarning(folderRevision: string, xmlRevision: string | null): string | undefined {
  if (!xmlRevision || !folderRevision || xmlRevision.normalize('NFC').trim().toUpperCase() === folderRevision.normalize('NFC').trim().toUpperCase()) return undefined;
  return `В XML указана ревизия ${xmlRevision}, а имя папки — ${folderRevision}; используется ревизия из XML.`;
}

function decodeXml(base64: string, size: number): string | null {
  if (size > EQUIPMENT_SOURCE_MAX_BYTES) return null;
  return decodeEquipmentSourceXml(base64ToBytes(base64));
}

function isUnstableReadError(code: string): boolean { return code === 'CONFLICT' || code === 'BUSY'; }

/** Сопоставляем только имена верхнеуровневых узлов установки; теги вложенных блоков не подходят. */
function xmlHasTargetTag(text: string, target: string, targetType: 'system' | 'component'): boolean {
  try {
    if (XMLValidator.validate(text) !== true) return false;
    const doc = parser.parse(text);
    const identifiers: string[] = [];
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      const object = node as Record<string, unknown>;
      for (const [key, value] of Object.entries(object)) {
        if (key.startsWith('@_') || key === '#text' || key === '#cdata') continue;
        const normalizedKey = key.toLowerCase();
        const targetNode = targetType === 'system'
          ? systemNames.has(normalizedKey)
          : ['block', 'component', 'element', 'блок', 'компонент', 'элемент'].includes(normalizedKey);
        if (targetNode) {
          const systems = Array.isArray(value) ? value : [value];
          for (const system of systems) {
            if (system && typeof system === 'object') {
              const attributes = system as Record<string, unknown>;
              for (const attr of ['name', 'code', 'tag', 'identifier', 'код', 'тег']) {
                const found = Object.entries(attributes).find(([name]) => name.toLowerCase() === `@_${attr}` || name.toLowerCase() === attr)?.[1];
                if (typeof found === 'string' && found.trim()) identifiers.push(found.trim());
              }
            }
          }
        } else visit(value);
      }
    };
    visit(doc);
    return identifiers.some((value) => normalizeTag(value) === normalizeTag(target));
  } catch { return false; }
}

/** Два одинаковых снимка отделяют завершившийся copy от файла, который ещё дописывается. */
async function readStable(adapter: EquipmentSourceAdapter, ref: WindowsFileRef) {
  const first = await adapter.read(ref);
  if ('error' in first) return first;
  await new Promise((resolve) => setTimeout(resolve, 200));
  const second = await adapter.read(ref);
  if ('error' in second) return second;
  if (first.data.size !== second.data.size || first.data.modifiedAt !== second.data.modifiedAt || first.data.sha256 !== second.data.sha256) {
    return { ok: false as const, error: { code: 'CONFLICT', message: 'Файл изменился или копируется. Повторите проверку позже.' } };
  }
  return second;
}
