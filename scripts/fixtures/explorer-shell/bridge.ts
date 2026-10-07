/**
 * Мост-заглушка для стенда Проводника: маленькая файловая система в памяти и
 * ровно те команды, которые зовут вкладки, строка адреса и панель навигации.
 * Всё, что заглушка делает, пишется в `window.__calls`: проверка смотрит не
 * только на экран, но и на то, что ушло в мост.
 */
import type { WindowsFileRef, WindowsFilesRequest, WindowsFilesResponse, WindowsSearchEvent, WindowsVolume, WindowsRoot } from '../../../filesystem/contracts';

type Node = { name: string; flux?: boolean; draftId?: string; kids?: Node[] };

const TREE: Record<string, Node[]> = {
  desktop: [{ name: 'Проекты', kids: [{ name: 'Чертежи', kids: [{ name: 'Архив' }] }, { name: 'Расчёты' }] }, { name: 'Эскизы' }],
  documents: [
    { name: '2026', kids: [{ name: 'Отчёты' }] }, { name: '1_PDF' }, { name: 'Новая папка' },
    { name: 'Черновик Flux', flux: true, draftId: 'draft-1', kids: [{ name: 'Внутри', flux: true, draftId: 'draft-2' }] },
  ],
  downloads: [],
  'disk-c': [{ name: 'Users', kids: [{ name: 'Анна', kids: [{ name: 'Загрузки' }] }] }, { name: 'Windows' }],
  'disk-d': [{ name: 'Данные' }, { name: 'Черновик диска', flux: true, draftId: 'draft-disk' }],
  'disk-e': [],
  yandex: [{ name: 'Общая' }, { name: 'Фото' }],
  vdr: [{ name: 'Раздел 1' }],
  net: [{ name: 'Проекты компании', kids: [{ name: 'ВДР' }] }],
};

const root = (id: string, name: string, kind: WindowsRoot['kind'], extra: Partial<WindowsRoot> = {}): WindowsRoot => ({ id, name, kind, available: true, ...extra });
const ROOTS: WindowsRoot[] = [
  root('desktop', 'Рабочий стол', 'desktop'), root('documents', 'Документы', 'documents'), root('downloads', 'Загрузки', 'downloads'),
  root('disk-c', 'Локальный диск (C:)', 'custom'), root('disk-d', 'Новый том (D:)', 'custom'), root('disk-e', 'Новый том (E:)', 'custom'),
  root('net', 'Проекты (Z:)', 'custom', { network: true }), root('yandex', 'Яндекс Диск', 'custom'), root('vdr', 'Проект ВДР', 'custom'),
];
const GB = 1024 ** 3;
const volume = (id: string, label: string, letter: string, rootId: string, size: number, free: number, kind: WindowsVolume['kind'] = 'fixed', networkPath?: string): WindowsVolume => ({
  id, name: `${label} (${letter})`, label, letter, kind, size: size * GB, free: free * GB, used: (size - free) * GB, ...(networkPath ? { networkPath } : {}),
  root: ROOTS.find((item) => item.id === rootId)!,
});
const VOLUMES: WindowsVolume[] = [
  volume('v-c', 'Локальный диск', 'C:', 'disk-c', 541, 160), volume('v-d', 'Новый том', 'D:', 'disk-d', 388, 147), volume('v-e', 'Новый том', 'E:', 'disk-e', 931, 574),
  volume('v-z', 'Проекты', 'Z:', 'net', 2000, 900, 'network', '\\\\corp\\Проекты'),
];

const icon = (seed: string) => {
  const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
  const context = canvas.getContext('2d')!;
  let hash = 0; for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  context.fillStyle = `hsl(${hash % 360} 60% 50%)`; context.fillRect(2, 8, 28, 20);
  context.fillStyle = `hsl(${hash % 360} 60% 65%)`; context.fillRect(2, 4, 12, 6);
  return canvas.toDataURL('image/png');
};

function find(ref: WindowsFileRef): Node[] | null {
  let level: Node[] | undefined = TREE[ref.rootId];
  if (!level) return null;
  for (const part of ref.relativePath.split('/').filter(Boolean)) {
    const next: Node | undefined = level.find((item) => item.name.toLowerCase() === part.toLowerCase());
    if (!next) return null;
    level = next.kids ?? [];
  }
  return level;
}

export function installBridge() {
  const calls: WindowsFilesRequest[] = [];
  const searchListeners = new Set<(event: WindowsSearchEvent) => void>();
  const canceled = new Set<string>();
  const searches: { requestId: string; ref: WindowsFileRef; query: string; filters: unknown }[] = [];
  const pinned = new Set(['desktop|', 'downloads|', 'documents|', 'documents|2026']);
  const key = (ref: WindowsFileRef) => `${ref.rootId}|${ref.relativePath}`;
  const quick = () => [
    { name: 'Рабочий стол', ref: { rootId: 'desktop', relativePath: '' } }, { name: 'Загрузки', ref: { rootId: 'downloads', relativePath: '' } },
    { name: 'Документы', ref: { rootId: 'documents', relativePath: '' } }, { name: '2026', ref: { rootId: 'documents', relativePath: '2026' } },
    { name: '1_PDF', ref: { rootId: 'documents', relativePath: '1_PDF' } }, { name: 'Новая папка', ref: { rootId: 'documents', relativePath: 'Новая папка' } },
  ].map((item) => ({ ...item, pinned: pinned.has(key(item.ref)) }));
  const stored = () => { try { return JSON.parse(localStorage.getItem('explorer-shell-fixture') || '{}'); } catch { return {}; } };
  const w = window as any;
  w.__calls = calls; w.__searches = searches; w.__connectedCount = 0;
  w.__searchDelay = 60;
  // ?quick=0 — Windows не отдала Быстрый доступ (не Windows или помощник молчит)
  w.__quickUnsupported = new URLSearchParams(location.search).get('quick') === '0';

  const ok = <T,>(data: T): WindowsFilesResponse<T> => ({ ok: true, data });
  const fail = (code: string, message: string): WindowsFilesResponse<any> => ({ ok: false, error: { code, message } });

  async function invoke(request: WindowsFilesRequest): Promise<WindowsFilesResponse<any>> {
    calls.push(request);
    switch (request.action) {
      case 'roots': return ok(ROOTS);
      case 'volumes': return ok(VOLUMES);
      case 'cloudRoots': return ok({ supported: true, items: [{ id: 'yandex-1', name: 'Яндекс Диск', provider: 'yandex', icon: icon('yandex'), root: ROOTS.find((item) => item.id === 'yandex')! }] });
      case 'quickAccess': return w.__quickUnsupported ? ok({ supported: false, items: [], message: 'Не Windows' }) : ok({ supported: true, items: quick() });
      case 'quickAccessPin': { if (request.pinned) pinned.add(key(request.ref)); else pinned.delete(key(request.ref)); return ok({ pinned: request.pinned, changed: true }); }
      case 'children': {
        const level = find(request.ref);
        if (!level) return fail('NOT_FOUND', 'Папка не найдена.');
        const base = request.ref.relativePath;
        return ok({
          root: ROOTS.find((item) => item.id === request.ref.rootId), relativePath: base, truncated: false,
          folders: level.map((item) => ({ name: item.name, relativePath: base ? `${base}/${item.name}` : item.name, storage: item.flux ? 'flux' : 'windows', ...(item.draftId ? { draftId: item.draftId } : {}), ...(request.peek ? { hasChildren: !!item.kids?.length } : {}) })),
        });
      }
      case 'viewStateGet': { const all = stored(); return ok(Object.fromEntries(request.keys.filter((name) => name in all).map((name) => [name, all[name]]))); }
      case 'viewStateSet': { localStorage.setItem('explorer-shell-fixture', JSON.stringify({ ...stored(), ...request.entries })); return ok({ stored: Object.keys(request.entries).length }); }
      case 'addRoot': w.__connectedCount++; return ok(ROOTS[0]);
      case 'search': {
        searches.push({ requestId: request.requestId, ref: request.ref, query: request.query, filters: request.filters });
        const ids = request.requestId;
        // Три страницы по восемь результатов с паузой: успеть увидеть «идёт поиск» и остановить
        void (async () => {
          for (let page = 0; page < 3; page++) {
            await new Promise((resolve) => setTimeout(resolve, w.__searchDelay));
            if (canceled.has(ids)) break;
            const hits = Array.from({ length: 8 }, (_, i) => ({ name: `${request.query || 'файл'} ${page * 8 + i + 1}.docx`, relativePath: `Находки/${request.query || 'файл'} ${page * 8 + i + 1}.docx`, parentPath: 'Находки', storage: 'windows' as const, kind: 'file' as const, fileId: `${ids}-${page}-${i}`, size: 100, modifiedAt: '2026-10-01T10:00:00.000Z', linked: false }));
            searchListeners.forEach((listener) => listener({ requestId: ids, hits, done: false, scanned: (page + 1) * 100, elapsedMs: 10 }));
          }
          const wasCanceled = canceled.has(ids);
          searchListeners.forEach((listener) => listener({ requestId: ids, hits: [], done: true, scanned: 300, elapsedMs: 40, reason: wasCanceled ? 'canceled' : 'complete' }));
        })();
        return ok({ requestId: ids });
      }
      case 'searchCancel': canceled.add(request.requestId); return ok({ canceled: true });
      default: return fail('INVALID_ACTION', `Заглушка не знает команду ${(request as any).action}`);
    }
  }
  w.electron = {
    windowsFiles: {
      invoke, getIcon: async (ref: WindowsFileRef) => icon(`${ref.rootId}/${ref.relativePath}`),
      onChanged: () => () => undefined,
      onSearch: (callback: (event: WindowsSearchEvent) => void) => { searchListeners.add(callback); return () => { searchListeners.delete(callback); }; },
    },
  };
  // Проекты для панели фильтров: настоящий dataService ходит в fetch
  w.fetch = async (url: string) => new Response(JSON.stringify(String(url).includes('/projects') ? { projects: [{ id: 'p1', name: 'Проект 1' }, { id: 'p2', name: 'Проект 2' }] } : {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
