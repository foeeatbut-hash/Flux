/**
 * Операции над несколькими объектами: буфер обмена, вставка, корзина.
 *
 * Только существующие команды моста (copy, move, trash, draftTrash,
 * restoreDraft) — новой логики записи на диск здесь нет. Ошибка одного объекта
 * не останавливает остальные: человек выбрал пять файлов, и один занятый
 * другой программой не должен оставить четыре нетронутыми без объяснения.
 * Мост передаётся параметром, чтобы логику можно было проверить без Electron.
 */
import type { WindowsFileEntry, WindowsFileRef } from '../../lib/windowsFiles';
import type { BridgeRequest } from './createEntry';

export interface ClipItem { ref: WindowsFileRef; name: string; kind: WindowsFileEntry['kind']; sha256?: string }
export interface Clip { items: ClipItem[]; cut: boolean }
export interface OpFailure { name: string; message: string }
export interface OpResult { done: number; failed: OpFailure[] }

export const entryRef = (entry: WindowsFileEntry, rootId: string): WindowsFileRef =>
  ({ rootId: entry.rootId || rootId, relativePath: entry.relativePath, ...(entry.draftId ? { draftId: entry.draftId } : {}) });

// Буфер один на все окна Проводника: вырезать в одном окне и вставить в другом —
// обычное дело, и состояние компонента для этого не годится
let current: Clip | null = null;
const listeners = new Set<() => void>();
export const getClip = () => current;
export const subscribeClip = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function setClip(next: Clip | null) { current = next; listeners.forEach((listener) => listener()); }

/** Хеш содержимого файла: перенос и удаление откажут, если файл успели изменить. */
async function hashOf(request: BridgeRequest, ref: WindowsFileRef): Promise<string> {
  const response = await request<{ sha256?: string }>({ action: 'fileHash', ref });
  if ('error' in response) throw new Error(response.error.message);
  const hash = response.data?.sha256;
  if (typeof hash !== 'string' || !hash) throw new Error('Не удалось проверить версию файла. Буфер обмена сохранён без изменений.');
  return hash;
}

/** Собрать буфер из выбранных. Для «вырезать» у файлов запоминается хеш — защита от потери правок. */
export async function makeClip(request: BridgeRequest, entries: WindowsFileEntry[], rootId: string, cut: boolean): Promise<Clip> {
  const items = await Promise.all(entries.map(async (entry): Promise<ClipItem> => {
    const ref = entryRef(entry, rootId);
    return { ref, name: entry.name, kind: entry.kind, ...(cut && entry.kind === 'file' ? { sha256: await hashOf(request, ref) } : {}) };
  }));
  return { items, cut };
}

/** «Отчёт.docx» → «Отчёт - копия.docx» → «Отчёт - копия (2).docx», как в Windows. */
export function copyName(name: string, taken: ReadonlySet<string>): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  let candidate = `${stem} - копия${extension}`;
  for (let index = 2; taken.has(candidate); index++) candidate = `${stem} - копия (${index})${extension}`;
  return candidate;
}

const parentOf = (path: string) => path.split('/').slice(0, -1).join('/');
const failure = (name: string, response: { error: { message: string } }): OpFailure => ({ name, message: response.error.message });

/**
 * Вставить буфер в папку. `existing` — имена, уже лежащие в ней: копия в ту же
 * папку получает свободное имя вместо отказа моста. Вырезанное обратно в ту же
 * папку — не действие: переносить некуда, и мост лишь пожаловался бы на занятое имя.
 */
export async function pasteClip(request: BridgeRequest, clip: Clip, parent: WindowsFileRef, existing: Iterable<string>): Promise<OpResult> {
  const taken = new Set(existing);
  const result: OpResult = { done: 0, failed: [] };
  for (const item of clip.items) {
    if (clip.cut && item.ref.rootId === parent.rootId && parentOf(item.ref.relativePath) === parent.relativePath) { result.done++; continue; }
    const name = !clip.cut && taken.has(item.name) ? copyName(item.name, taken) : item.name;
    const response = await request({ action: clip.cut ? 'move' : 'copy', ref: item.ref, parent, name, ...(clip.cut && item.sha256 ? { baseSha256: item.sha256 } : {}) });
    if ('error' in response) result.failed.push(failure(item.name, response)); else { result.done++; taken.add(name); }
  }
  return result;
}

/** В корзину: файл Windows уходит в корзину Windows, черновик Flux — в корзину черновиков. */
export async function trashEntries(request: BridgeRequest, rootId: string, entries: WindowsFileEntry[]): Promise<OpResult> {
  const result: OpResult = { done: 0, failed: [] };
  for (const entry of entries) {
    const ref = entryRef(entry, rootId);
    const hash = entry.kind === 'file' ? await hashOf(request, ref) : undefined;
    const response = await request({ action: 'trash', ref, ...(hash ? { baseSha256: hash } : {}) });
    if ('error' in response) result.failed.push(failure(entry.name, response)); else result.done++;
  }
  return result;
}

/** Вопрос перед удалением: по слову «черновик» человек понимает, что вернуть Windows не поможет. */
export function trashQuestion(entries: WindowsFileEntry[]): string {
  if (entries.length === 1) return `Переместить «${entries[0].name}» в корзину Windows?`;
  const drafts = entries.filter((entry) => entry.draftId).length;
  if (drafts === entries.length) return `Удалить черновики Flux (${entries.length})?`;
  return `Переместить объекты (${entries.length}) в корзину?${drafts ? ` Из них черновиков Flux: ${drafts}.` : ''}`;
}

/** Удалённые черновики Flux — для раздела «Корзина» (его строит следующий шаг). */
export async function listTrashedDrafts(request: BridgeRequest) {
  const response = await request<{ ref: WindowsFileRef; name: string; fileId: string }[]>({ action: 'draftTrash' });
  if ('error' in response) throw new Error(response.error.message);
  return response.data;
}

export async function restoreTrashedDraft(request: BridgeRequest, ref: WindowsFileRef) {
  const response = await request({ action: 'restoreDraft', ref });
  if ('error' in response) throw new Error(response.error.message);
  return response.data;
}
