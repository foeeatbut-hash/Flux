import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import type { WindowsFileChoice, WindowsFileRef, WindowsPublishChoices, WindowsPublishPlan, WindowsPublishPlanItem } from '../../filesystem/contracts';
import { WindowsFilesError, joinRelative, validateWindowsName } from './paths';
import { freeWindowsName, sameWindowsName } from './names';
import type { StoredDraft, WindowsFilesState } from './state';
import type { WindowsFilesService } from './service';

const MAX_ITEMS = 5000;
const MAX_FILE = 64 * 1024 * 1024;
const MAX_TOTAL = 512 * 1024 * 1024;
const MAX_PATH_CHARS = 32_000;

export interface Existing { kind: 'file' | 'directory' | 'other'; size: number; modifiedAt: string }

/** Что лежит на месте будущего объекта. null — место свободно; ссылка и выход за корень — отказ, как везде в мосте. */
export async function existingAt(service: WindowsFilesService, ref: { rootId: string; relativePath: string }): Promise<Existing | null> {
  const filename = await service.filename(ref, true);
  try {
    const stat = await fs.lstat(filename);
    return { kind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other', size: stat.size, modifiedAt: stat.mtime.toISOString() };
  } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Допустимые значения выбора разбираются на границе: интерфейс присылает строки, а не типы. */
export function parseChoices(value: unknown): WindowsPublishChoices {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WindowsFilesError('INVALID_REQUEST', 'Выбор для совпадающих имён указан неверно.');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_ITEMS) throw new WindowsFilesError('INVALID_REQUEST', 'Слишком много выборов для одной публикации.');
  const result: WindowsPublishChoices = {};
  for (const [id, choice] of entries) {
    if (choice !== 'replace' && choice !== 'skip' && choice !== 'keepBoth') throw new WindowsFilesError('INVALID_REQUEST', 'Выберите «Заменить», «Пропустить» или «Оставить оба».');
    result[id] = choice as WindowsFileChoice;
  }
  return result;
}

/**
 * Свободное имя в папке назначения: занятое в Windows, занятое другим
 * неопубликованным черновиком той же папки и занятое тем, что публикуется
 * вместе с этим объектом (extraTaken).
 */
export async function freeNameIn(service: WindowsFilesService, parent: { rootId: string; relativePath: string }, name: string, isDirectory: boolean, extraTaken: string[] = []): Promise<string> {
  let names: string[] = [];
  try { names = await fs.readdir(await service.filename(parent)); } catch (error: any) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  const siblings = service.draftsIn({ rootId: parent.rootId, relativePath: parent.relativePath }).map(draft => draft.name);
  const used = [...names, ...siblings, ...extraTaken];
  return freeWindowsName(name, candidate => used.some(item => sameWindowsName(item, candidate)), isDirectory);
}

/** Переносит теги и проекты черновика на файл, который он заменил: свойства существующего файла не затираются. */
export function mergeDraftMetadata(state: WindowsFilesState, fromFileId: string, toFileId: string): void {
  const source = state.data.metadata[fromFileId];
  if (!source || fromFileId === toFileId) return;
  const target = state.metadata(toFileId);
  target.tags = [...new Set([...target.tags, ...source.tags])];
  target.projectIds = [...new Set([...target.projectIds, ...source.projectIds])];
  if (!target.revision) target.revision = source.revision;
  if (!target.responsible) target.responsible = source.responsible;
}

function childrenOf(service: WindowsFilesService, draft: StoredDraft): StoredDraft[] {
  return Object.values(service.state.data.drafts)
    .filter(item => !item.trashed && item.parent.draftId === draft.id && (item.kind === 'directory' || !item.publishedRef))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true, sensitivity: 'base' }));
}

/**
 * План публикации: что совпадёт по именам и что недоступно — до того, как
 * что-нибудь записано. Ничего не пишет; применяется потом publishDraft /
 * publishDraftTree с выбором по каждому объекту. Состояние Windows между планом
 * и применением может измениться, поэтому применение проверяет совпадения
 * заново и без выбора по-прежнему отказывает, а не заменяет.
 */
export async function planPublication(service: WindowsFilesService, ref: WindowsFileRef): Promise<WindowsPublishPlan> {
  const root = service.draft(ref);
  const items: WindowsPublishPlanItem[] = [];
  let truncated = false, total = 0;
  const push = (item: WindowsPublishPlanItem) => { items.push(item); return item; };

  // Куда ляжет корень плана: родитель — настоящая папка, либо уже опубликованная папка-черновик.
  let parent: { rootId: string; relativePath: string } | null = null; let parentReason = '';
  if (root.publishedRef) parent = null;
  else if (root.parent.draftId) {
    const published = service.state.data.drafts[root.parent.draftId]?.publishedRef;
    if (published) parent = published; else parentReason = 'Сначала опубликуйте родительскую папку.';
  } else {
    try { await service.reconcileDraftParent(root); parent = { rootId: root.parent.rootId, relativePath: root.parent.relativePath }; await service.filename(parent); }
    catch (error: any) { parentReason = error instanceof WindowsFilesError ? error.message : 'Папка назначения недоступна.'; }
  }
  if (!root.publishedRef && !parent) {
    push({ draftId: root.id, name: root.name, kind: root.kind === 'directory' ? 'directory' : 'file', targetPath: joinRelative(root.parent.relativePath, root.name), status: 'blocked', reason: parentReason });
    return { ref, items, collisions: 0, blocked: 1, truncated };
  }
  if (parent) {
    try { await fs.access(await service.filename(parent), constants.W_OK); }
    catch (error: any) {
      const reason = error instanceof WindowsFilesError ? error.message : 'Папка назначения недоступна для записи.';
      push({ draftId: root.id, name: root.name, kind: root.kind === 'directory' ? 'directory' : 'file', targetPath: joinRelative(parent.relativePath, root.name), status: 'blocked', reason });
      return { ref, items, collisions: 0, blocked: 1, truncated };
    }
  }

  const visit = async (draft: StoredDraft, into: { rootId: string; relativePath: string } | null, depth: number, merged: boolean, intoExists: boolean): Promise<void> => {
    if (items.length >= MAX_ITEMS) { truncated = true; return; }
    const kind = draft.kind === 'directory' ? 'directory' as const : 'file' as const;
    const targetRef = draft.publishedRef ?? { rootId: into!.rootId, relativePath: joinRelative(into!.relativePath, draft.name) };
    const base = { draftId: draft.id, name: draft.name, kind, targetPath: targetRef.relativePath, ...(merged ? { underMergedFolder: true } : {}) };
    let status: WindowsPublishPlanItem['status'] = 'free'; let reason: string | undefined; let existing: Existing | null = null;
    try {
      validateWindowsName(draft.name);
      if (targetRef.relativePath.length > MAX_PATH_CHARS || depth > 64) throw new WindowsFilesError('PATH_TOO_LONG', 'Путь получается слишком длинным для Windows.');
      if (kind === 'file') {
        const size = (await service.entry({ rootId: draft.parent.rootId, relativePath: joinRelative(draft.parent.relativePath, draft.name), draftId: draft.id })).size;
        if (size > MAX_FILE) throw new WindowsFilesError('FILE_TOO_LARGE', 'Файл больше 64 МБ: Flux публикует файлы до этого размера.');
        total += size;
        if (total > MAX_TOTAL) throw new WindowsFilesError('TREE_TOO_LARGE', 'Публикация папки ограничена 512 МБ.');
      }
      // Папка, которой ещё нет в Windows, создаётся пустой: внутри неё столкнуться не с чем.
      existing = draft.publishedRef || !intoExists ? null : await existingAt(service, targetRef);
    } catch (error: any) {
      status = 'blocked'; reason = error instanceof WindowsFilesError ? error.message : 'Путь недоступен.';
    }
    let itemExists = !!draft.publishedRef;
    if (status === 'free' && existing) {
      status = 'collision'; itemExists = true;
      const parentRef = { rootId: targetRef.rootId, relativePath: targetRef.relativePath.split('/').slice(0, -1).join('/') };
      const siblings = draft === root || !draft.parent.draftId ? [] : childrenOf(service, service.state.data.drafts[draft.parent.draftId]).map(item => item.name);
      const suggestedName = await freeNameIn(service, parentRef, draft.name, kind === 'directory', siblings).catch(() => undefined);
      push({ ...base, status, existing, replaceable: existing.kind === kind, ...(suggestedName ? { suggestedName } : {}) });
    } else push({ ...base, status, ...(reason ? { reason } : {}) });
    if (kind === 'directory' && status !== 'blocked') {
      for (const child of childrenOf(service, draft)) await visit(child, targetRef, depth + 1, merged || (status === 'collision' && existing?.kind === 'directory'), itemExists || draft.publishedRef !== undefined);
    }
  };
  await visit(root, parent, 1, false, true);
  return { ref, items, collisions: items.filter(item => item.status === 'collision').length, blocked: items.filter(item => item.status === 'blocked').length, truncated };
}
