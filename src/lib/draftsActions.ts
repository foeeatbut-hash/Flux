/**
 * Панель «Черновики»: что делает публикация и перетаскивание — без React.
 *
 * Мост передаётся параметром, поэтому порядок шагов проверяет
 * scripts/test-drafts-actions.ts без Electron. Публикация черновика —
 * это «Отобразить в Windows»: файл появляется в папке, где черновик лежит.
 * Чтобы опубликовать в другую папку, черновик сначала переносится туда
 * (мост публикует только в исходную папку), а «Оставить копию» переносит не
 * сам черновик, а его копию с теми же метаданными.
 */
import type { WindowsDraftEntry, WindowsFileRef, WindowsFilesRequest, WindowsFilesResponse } from '../../filesystem/contracts';
import { numberedName } from './draftsPanel';

/** Своя MIME: Проводник и дерево отличают черновик панели от обычных объектов Проводника (application/x-flux-entries). */
export const DRAFT_MIME = 'application/x-flux-draft';

export interface DraftDragItem { ref: WindowsFileRef; name: string; kind: 'file' | 'directory' }

export const draftRef = (entry: WindowsDraftEntry): WindowsFileRef => ({ rootId: entry.rootId || entry.parent.rootId, relativePath: entry.relativePath, draftId: entry.draftId });
export const dragItem = (entry: WindowsDraftEntry): DraftDragItem => ({ ref: draftRef(entry), name: entry.name, kind: entry.kind === 'directory' ? 'directory' : 'file' });

export const encodeDraftDrag = (items: DraftDragItem[]) => JSON.stringify({ items });

/** Данные перетаскивания приходят со страницы: каждое поле проверяется, чужой JSON не выполняет публикацию. */
export function parseDraftDrag(raw: string): DraftDragItem[] | null {
  try {
    const value = JSON.parse(raw) as { items?: unknown };
    if (!Array.isArray(value?.items) || !value.items.length) return null;
    const items: DraftDragItem[] = [];
    for (const item of value.items as any[]) {
      if (!item || typeof item.name !== 'string' || !item.ref || typeof item.ref.rootId !== 'string' || typeof item.ref.relativePath !== 'string' || typeof item.ref.draftId !== 'string') return null;
      items.push({ ref: { rootId: item.ref.rootId, relativePath: item.ref.relativePath, draftId: item.ref.draftId }, name: item.name, kind: item.kind === 'directory' ? 'directory' : 'file' });
    }
    return items;
  } catch { return null; }
}

export const isDraftDrag = (event: { dataTransfer: DataTransfer | null }) => Array.from(event.dataTransfer?.types ?? []).includes(DRAFT_MIME);

export type DraftRequest = <T = unknown>(request: WindowsFilesRequest) => Promise<WindowsFilesResponse<T>>;

export interface DraftPublishOutcome {
  ok: boolean; message: string;
  /** Имя, под которым файл лёг в папку (занятое имя дополняется «(2)») */
  name: string;
  /** Не вышла только публикация: черновик уже в папке назначения и никуда не пропал */
  draftKept: boolean;
}

const MAX_NAMES = 99;
const failure = (name: string, message: string, draftKept = false): DraftPublishOutcome => ({ ok: false, name, message, draftKept });

/**
 * Опубликовать черновик в папку Windows.
 *
 * Без копии — перенос черновика в папку и «Отобразить в Windows»; с копией —
 * копия (метаданные переходят вместе с ней) переносится и публикуется, а
 * исходный черновик остаётся в панели. Занятое имя (черновик или файл Windows)
 * получает «(2)», «(3)» — как «Оставить оба» в Проводнике.
 */
export async function publishDraftInto(request: DraftRequest, item: DraftDragItem, parent: WindowsFileRef, opts: { keepCopy: boolean }): Promise<DraftPublishOutcome> {
  if (parent.draftId) return failure(item.name, 'Эта папка ещё не опубликована в Windows. Выберите обычную папку.');
  let placed: WindowsFileRef | null = null;
  let name = item.name;
  for (let n = 1; n <= MAX_NAMES && !placed; n++) {
    name = numberedName(item.name, n, item.kind === 'directory');
    const answer = opts.keepCopy
      ? await request<{ ref?: WindowsFileRef }>({ action: 'copy', ref: item.ref, parent, name, carryMeta: true })
      : await request<{ ref?: WindowsFileRef }>({ action: 'move', ref: item.ref, parent, name });
    if ('error' in answer) {
      if (answer.error.code === 'EEXIST') continue;
      return failure(name, answer.error.message);
    }
    placed = answer.data?.ref ?? null;
    if (!placed) return failure(name, 'Мост не вернул черновик в папке назначения.');
  }
  if (!placed) return failure(item.name, 'Не нашлось свободного имени в папке назначения.');
  const published = await request<{ ref?: WindowsFileRef }>({
    action: 'publishDraft', ref: placed,
    // Папки публикуются деревом; для файла «оставить оба» страхует от гонки: имя заняли между переносом и публикацией
    ...(item.kind === 'file' && placed.draftId ? { choices: { [placed.draftId]: 'keepBoth' as const } } : {}),
  });
  if ('error' in published) return failure(name, `Не опубликовано: ${published.error.message} Черновик лежит в выбранной папке.`, true);
  return { ok: true, name, message: opts.keepCopy ? `Опубликовано: «${name}». Копия осталась в черновиках.` : `Опубликовано: «${name}».`, draftKept: false };
}

/** «Отобразить в Windows»: черновик остаётся в своей папке и становится файлом Windows. */
export async function publishDraftInPlace(request: DraftRequest, item: DraftDragItem): Promise<DraftPublishOutcome> {
  const published = await request<{ ref?: WindowsFileRef }>({
    action: 'publishDraft', ref: item.ref,
    ...(item.kind === 'file' && item.ref.draftId ? { choices: { [item.ref.draftId]: 'keepBoth' as const } } : {}),
  });
  if ('error' in published) return failure(item.name, published.error.message);
  return { ok: true, name: item.name, message: `Опубликовано: «${item.name}».`, draftKept: false };
}

/** Последняя часть пути для заголовков: «Проект/Чертежи» → «Чертежи»; корень — его имя. */
export function folderLabel(relativePath: string, rootName: string): string {
  const parts = relativePath.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : rootName;
}
