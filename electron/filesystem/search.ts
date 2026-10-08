import fs from 'node:fs/promises';
import path from 'node:path';
import type { WindowsFileRef, WindowsSearchEvent, WindowsSearchFilters, WindowsSearchHit, WindowsSearchLimits, WindowsSearchStop } from '../../filesystem/contracts';
import { WindowsFilesError, isContained, joinRelative, validateWindowsName } from './paths';
import type { WindowsFilesService } from './service';

// Пределы защищают интерфейс и диск: поиск с корня огромного тома без них
// превращается в многоминутный обход. Верхняя планка — у нас, а не у renderer:
// он может попросить меньше, но не больше.
const DEFAULTS = { depth: 32, objects: 300_000, hits: 2000, ms: 60_000 };
const CEILING = { depth: 64, objects: 1_000_000, hits: 20_000, ms: 180_000 };
const MAX_PARALLEL = 4;
const PAGE_SIZE = 100;
const PAGE_MS = 120;
const LOCK_NAME = /^\.flux-write-[0-9a-f]{64}\.lock$/u;
const TEMP_NAME = /^\.flux-[0-9a-f-]{36}\.tmp$/u;

export interface SearchParams { ref: WindowsFileRef; requestId: string; query: string; filters?: WindowsSearchFilters; limits?: WindowsSearchLimits }
export type SearchEmit = (owner: number, event: WindowsSearchEvent) => void;

// «Ё» и «е» в именах файлов смешивают постоянно; Windows при поиске их не различает.
const fold = (value: string) => value.normalize('NFC').toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е');
const escapeRegExp = (value: string) => value.replace(/[.+^${}()|[\]\\]/gu, '\\$&');

/** Слова запроса — через пробел и все обязательны. Слово с * или ? сверяется с именем целиком, как маска Windows. */
export function nameMatcher(query: string): (name: string) => boolean {
  const terms = fold(query).split(/\s+/u).filter(Boolean);
  if (!terms.length) return () => true;
  const tests = terms.map(term => {
    if (!/[*?]/u.test(term)) return (name: string) => name.includes(term);
    const pattern = new RegExp(`^${escapeRegExp(term).replace(/\*/gu, '.*').replace(/\?/gu, '.')}$`, 'u');
    return (name: string) => pattern.test(name);
  });
  return name => { const folded = fold(name); return tests.every(test => test(folded)); };
}

function clampLimit(value: unknown, fallback: number, ceiling: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) throw new WindowsFilesError('INVALID_REQUEST', 'Предел поиска должен быть положительным числом.');
  return Math.min(Math.floor(value), ceiling);
}
function parseDate(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) throw new WindowsFilesError('INVALID_REQUEST', 'Дата в условии поиска указана неверно.');
  return time;
}
function parseSize(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new WindowsFilesError('INVALID_REQUEST', 'Размер в условии поиска указан неверно.');
  return value;
}
function text(value: unknown, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 200) throw new WindowsFilesError('INVALID_REQUEST', `Условие «${what}» указано неверно.`);
  return fold(value);
}

type FluxMetadata = { data: { metadata: Record<string, { tags: string[]; projectIds: string[]; revision: string }> } };

/** Проверяет условия до запуска: ошибка приходит ответом на команду, а не потоком. */
export function compileFilter(query: unknown, filters: WindowsSearchFilters | undefined) {
  if (typeof query !== 'string' || query.length > 500) throw new WindowsFilesError('INVALID_REQUEST', 'Запрос поиска слишком длинный.');
  const f = filters ?? {};
  if (typeof f !== 'object' || Array.isArray(f)) throw new WindowsFilesError('INVALID_REQUEST', 'Условия поиска указаны неверно.');
  if (f.kind !== undefined && f.kind !== 'file' && f.kind !== 'directory') throw new WindowsFilesError('INVALID_REQUEST', 'Тип в условии поиска указан неверно.');
  if (f.extensions !== undefined && (!Array.isArray(f.extensions) || f.extensions.length > 50 || f.extensions.some(ext => typeof ext !== 'string' || !/^[^./\\\s]{1,16}$/u.test(ext.replace(/^\./u, ''))))) throw new WindowsFilesError('INVALID_REQUEST', 'Расширения в условии поиска указаны неверно.');
  const extensions = f.extensions ? new Set(f.extensions.map(ext => fold(ext.replace(/^\./u, '')))) : null;
  const from = parseDate(f.modifiedFrom), to = parseDate(f.modifiedTo), min = parseSize(f.sizeMin), max = parseSize(f.sizeMax);
  const tag = text(f.tag, 'тег'), projectId = text(f.projectId, 'проект'), revision = text(f.revision, 'ревизия');
  const onlyDrafts = f.onlyDrafts === true;
  const trimmed = query.trim();
  const hasFilter = !!(f.kind || extensions || from !== undefined || to !== undefined || min !== undefined || max !== undefined || tag || projectId || revision || onlyDrafts);
  if (!trimmed && !hasFilter) throw new WindowsFilesError('INVALID_REQUEST', 'Введите, что искать, или задайте условие.');
  const matches = nameMatcher(trimmed);
  const needsFlux = !!(tag || projectId || revision);
  return {
    onlyDrafts, kind: f.kind,
    /** Условия, которым хватает записи каталога: без обращения к файлу. */
    cheap: (name: string, directory: boolean) => {
      if (f.kind === 'file' && directory) return false;
      if (f.kind === 'directory' && !directory) return false;
      if (extensions) { if (directory) return false; const dot = name.lastIndexOf('.'); if (dot < 0 || !extensions.has(fold(name.slice(dot + 1)))) return false; }
      return matches(name);
    },
    /** Условия, которым нужны размер, дата и свойства Flux. */
    full: (entry: { kind: string; size: number; modifiedAt: string; fileId: string }, state: FluxMetadata) => {
      const modified = Date.parse(entry.modifiedAt);
      if (from !== undefined && modified < from) return false;
      if (to !== undefined && modified > to) return false;
      if (entry.kind === 'file') { if (min !== undefined && entry.size < min) return false; if (max !== undefined && entry.size > max) return false; }
      else if (min !== undefined || max !== undefined) return false; // у папки размера нет: Windows тоже не показывает её в поиске по размеру
      if (needsFlux) {
        const meta = state.data.metadata[entry.fileId];
        if (!meta) return false;
        if (tag && !meta.tags.some(item => fold(item) === tag)) return false;
        if (projectId && !meta.projectIds.some(item => fold(item) === projectId)) return false;
        if (revision && fold(meta.revision) !== revision) return false;
      }
      return true;
    },
  };
}

/** Живые поиски: id запроса задаёт renderer, но принадлежит он окну — отменить чужой нельзя. */
export class SearchRegistry {
  private active = new Map<string, AbortController>();
  private key(owner: number, requestId: string) { return `${owner}:${requestId}`; }
  count(owner: number) { let n = 0; for (const key of this.active.keys()) if (key.startsWith(`${owner}:`)) n++; return n; }
  cancel(owner: number, requestId: unknown): boolean {
    if (typeof requestId !== 'string') return false;
    const controller = this.active.get(this.key(owner, requestId));
    controller?.abort(); return !!controller;
  }
  closeOwner(owner: number) { for (const [key, controller] of this.active) if (key.startsWith(`${owner}:`)) controller.abort(); }
  /** Разбирает запрос синхронно, а сам обход запускает фоном: события пойдут уже после ответа. */
  start(service: WindowsFilesService, owner: number, params: SearchParams, emit: SearchEmit): { requestId: string } {
    const { requestId } = params;
    if (typeof requestId !== 'string' || !/^[\w.:-]{1,64}$/u.test(requestId)) throw new WindowsFilesError('INVALID_REQUEST', 'Не указан номер запроса поиска.');
    if (this.active.has(this.key(owner, requestId))) throw new WindowsFilesError('INVALID_REQUEST', 'Поиск с таким номером уже идёт.');
    if (this.count(owner) >= MAX_PARALLEL) throw new WindowsFilesError('TOO_MANY_SEARCHES', 'Идёт слишком много поисков. Остановите лишние.');
    const filter = compileFilter(params.query, params.filters);
    const limitsIn = params.limits ?? {};
    const limits = {
      depth: clampLimit(limitsIn.depth, DEFAULTS.depth, CEILING.depth), objects: clampLimit(limitsIn.objects, DEFAULTS.objects, CEILING.objects),
      hits: clampLimit(limitsIn.hits, DEFAULTS.hits, CEILING.hits), ms: clampLimit(limitsIn.ms, DEFAULTS.ms, CEILING.ms),
    };
    // Неизвестный корень лучше назвать сразу, ответом на команду, а не событием.
    service.state.root(params.ref?.rootId);
    const controller = new AbortController();
    this.active.set(this.key(owner, requestId), controller);
    void (async () => {
      let last: WindowsSearchEvent = { requestId, hits: [], done: true, scanned: 0, elapsedMs: 0, reason: 'error' };
      try { last = await walk(service, owner, params.ref, requestId, filter, limits, controller.signal, emit); }
      catch (error: any) {
        last = { ...last, error: { code: typeof error?.code === 'string' ? error.code : 'FILESYSTEM_ERROR', message: error instanceof WindowsFilesError ? error.message : 'Поиск остановлен из-за ошибки доступа к папке.' } };
      } finally { this.active.delete(this.key(owner, requestId)); }
      emit(owner, last);
    })();
    return { requestId };
  }
}

type Filter = ReturnType<typeof compileFilter>;

async function walk(service: WindowsFilesService, owner: number, start: WindowsFileRef, requestId: string, filter: Filter,
  limits: { depth: number; objects: number; hits: number; ms: number }, signal: AbortSignal, emit: SearchEmit): Promise<WindowsSearchEvent> {
  const began = Date.now();
  let scanned = 0, found = 0, depthSkipped = 0, unreadable = 0;
  let stop: WindowsSearchStop | null = null;
  let page: WindowsSearchHit[] = []; let flushed = Date.now();
  const flush = () => {
    if (!page.length) return;
    emit(owner, { requestId, hits: page, done: false, scanned, elapsedMs: Date.now() - began }); page = []; flushed = Date.now();
  };
  const halted = (): boolean => {
    if (stop) return true;
    if (signal.aborted) stop = 'canceled';
    else if (Date.now() - began > limits.ms) stop = 'limit-time';
    else if (scanned >= limits.objects) stop = 'limit-objects';
    return !!stop;
  };
  const hit = async (ref: WindowsFileRef, parentPath: string): Promise<void> => {
    let entry;
    try { entry = await service.entry(ref, true); } catch { return; } // файл исчез между списком и запросом — не ошибка поиска
    if (!filter.full(entry, service.state)) return;
    page.push({ ...entry, rootId: ref.rootId, parentPath });
    if (++found >= limits.hits) stop = 'limit-hits';
    if (page.length >= PAGE_SIZE || Date.now() - flushed >= PAGE_MS) flush();
  };

  // Корень поиска: настоящая папка или папка-черновик. Неопубликованный черновик на диске не существует.
  const resolved = service.resolveRef(start);
  const startDraft = resolved.draftId ? service.state.data.drafts[resolved.draftId] : null;
  if (startDraft && startDraft.kind !== 'directory') throw new WindowsFilesError('NOT_DIRECTORY', 'Поиск начинается с папки.');
  const virtualStart = !!startDraft && !startDraft.publishedRef;
  const startRef = virtualStart ? null : { rootId: resolved.rootId, relativePath: resolved.relativePath };
  const root = service.state.root(resolved.rootId);

  // Черновики Flux — часть дерева, как и обычные файлы: поиск обязан их находить.
  const draftsHere = Object.values(service.state.data.drafts).filter(draft => !draft.trashed && !draft.publishedRef && draft.parent.rootId === resolved.rootId);
  const inside = (draft: (typeof draftsHere)[number]) => {
    if (virtualStart) {
      for (let id: string | undefined = draft.parent.draftId, hops = 0; id && hops < 64; id = service.state.data.drafts[id]?.parent.draftId, hops++) if (id === startDraft!.id) return true;
      return false;
    }
    const base = resolved.relativePath;
    return !base || draft.parent.relativePath === base || draft.parent.relativePath.startsWith(`${base}/`);
  };
  const startDepth = virtualStart ? 0 : resolved.relativePath ? resolved.relativePath.split('/').length : 0;
  for (const draft of draftsHere.filter(inside)) {
    if (halted()) break;
    const depth = (draft.parent.relativePath ? draft.parent.relativePath.split('/').length : 0) - startDepth + 1;
    if (!virtualStart && depth > limits.depth) { depthSkipped++; continue; }
    scanned++;
    if (!filter.cheap(draft.name, draft.kind === 'directory')) continue;
    await hit({ rootId: draft.parent.rootId, relativePath: joinRelative(draft.parent.relativePath, draft.name), draftId: draft.id }, draft.parent.relativePath);
  }

  if (!filter.onlyDrafts && startRef && !halted()) {
    const startName = await service.filename(startRef);
    if (!(await fs.stat(startName)).isDirectory()) throw new WindowsFilesError('NOT_DIRECTORY', 'Поиск начинается с папки.');
    const queue: ({ rel: string; abs: string; depth: number } | undefined)[] = [{ rel: startRef.relativePath, abs: startName, depth: 0 }];
    let sinceYield = 0;
    for (let index = 0; index < queue.length && !halted(); index++) {
      const { rel, abs, depth } = queue[index]!;
      queue[index] = undefined; // очередь бывает огромной, а обработанное звено нужно разве что сборщику мусора
      // Подпапка могла стать ссылкой уже после перечисления родителя: перед входом проверяется её настоящее место.
      if (depth > 0) {
        try { if (!isContained(root.path, await fs.realpath(abs))) { unreadable++; continue; } } catch { unreadable++; continue; }
      }
      let directory: Awaited<ReturnType<typeof fs.opendir>>;
      try { directory = await fs.opendir(abs); } catch { unreadable++; continue; }
      try {
        for await (const item of directory) {
          if (halted()) break;
          scanned++;
          if (++sinceYield >= 200) { sinceYield = 0; await new Promise<void>(resolve => setImmediate(resolve)); }
          const name = item.name;
          if (LOCK_NAME.test(name) || TEMP_NAME.test(name)) continue;
          try { validateWindowsName(name); } catch { continue; } // необычные имена Windows не становятся адресом в мосте
          const directoryItem = item.isDirectory(), link = item.isSymbolicLink();
          const childRel = rel ? `${rel}/${name}` : name;
          // Ссылки в результаты не попадают: открыть их мост всё равно не даст.
          if (!link && filter.cheap(name, directoryItem)) await hit({ rootId: startRef.rootId, relativePath: childRel }, rel);
          if (directoryItem && !link) {
            if (depth + 1 > limits.depth) depthSkipped++;
            else queue.push({ rel: childRel, abs: path.join(abs, name), depth: depth + 1 });
          }
        }
      } catch { unreadable++; } finally { await directory.close().catch(() => undefined); }
    }
  }
  flush();
  return { requestId, hits: [], done: true, scanned, elapsedMs: Date.now() - began, reason: stop ?? 'complete', ...(depthSkipped ? { depthSkipped } : {}), ...(unreadable ? { unreadable } : {}) };
}
