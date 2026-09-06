/**
 * Память рабочего стола: чем пользуются, что открывали и по какому адресу.
 *
 * Раньше здесь жила ещё и раскладка по панелям — 1/2/4 панели, стеки вкладок,
 * активная панель. Панельной оболочки больше нет: разделы открываются окнами,
 * и делить окно на панели незачем — окна и есть панели, только двигаются.
 *
 * Осталось то, что нужно любой оболочке: счёт использований (по нему Главная
 * сортирует разделы), список недавних и «замороженный адрес» — полный
 * path+search каждого открытого раздела, чтобы возврат к нему открывал то же
 * место, а не голый раздел. Ключ адреса — `${frameId}::${path}`, где frameId у
 * окна выглядит как `win:<id>`.
 */
import { create } from 'zustand';

interface WorkspaceState {
  /** Полный адрес (path+search) каждой открытой рамы: возврат открывает её там же */
  frozenHrefs: Record<string, string>;
  setFrozenHref: (frameId: string, path: string, href: string) => void;
  /** Рама закрылась — её адрес больше не нужен */
  dropFrozen: (frameId: string, path: string) => void;
  bindUser: (userId: string | null) => void;
}

// Чем пользователь пользуется чаще и что открывал последним — этим
// главный экран сортирует разделы и предлагает продолжить работу.
// Хранится локально, ничего никуда не отправляется.
const USE_KEY = 'flux_section_uses';
const RECENT_KEY = 'flux_recent_sections';

export function rememberSectionUse(path: string) {
  if (typeof localStorage === 'undefined' || !path) return;
  try {
    const uses = JSON.parse(localStorage.getItem(USE_KEY) || '{}');
    uses[path] = (uses[path] || 0) + 1;
    localStorage.setItem(USE_KEY, JSON.stringify(uses));
    const recent: string[] = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    const next = [path, ...recent.filter((p) => p !== path)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch (_) { /* приватный режим браузера — просто не запоминаем */ }
}

export function sectionUses(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(USE_KEY) || '{}'); } catch (_) { return {}; }
}

export function recentSections(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch (_) { return []; }
}

// ── Память адресов per-пользователь ──
const persistKey = (userId: string) => `flux_workspace_v1_${userId}`;
let boundUserId: string | null = null;

function loadPersisted(userId: string): Record<string, string> | null {
  try {
    const raw = localStorage.getItem(persistKey(userId));
    if (!raw) return null;
    const p = JSON.parse(raw);
    return p?.frozenHrefs && typeof p.frozenHrefs === 'object' ? p.frozenHrefs : null;
  } catch (_) { return null; }
}

function persist(frozenHrefs: Record<string, string>) {
  if (!boundUserId) return;
  try {
    localStorage.setItem(persistKey(boundUserId), JSON.stringify({ frozenHrefs }));
  } catch (_) { /* приватный режим */ }
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  frozenHrefs: {},

  setFrozenHref: (frameId, path, href) => {
    const key = `${frameId}::${path}`;
    if (get().frozenHrefs[key] === href) return;
    const frozenHrefs = { ...get().frozenHrefs, [key]: href };
    set({ frozenHrefs });
    persist(frozenHrefs);
  },

  dropFrozen: (frameId, path) => {
    const key = `${frameId}::${path}`;
    if (!(key in get().frozenHrefs)) return;
    const frozenHrefs = { ...get().frozenHrefs };
    delete frozenHrefs[key];
    set({ frozenHrefs });
    persist(frozenHrefs);
  },

  // Вход пользователя: поднимаем адреса, на которых он остановился
  bindUser: (userId) => {
    boundUserId = userId;
    if (!userId) return;
    const saved = loadPersisted(userId);
    if (saved) set({ frozenHrefs: saved });
  },
}));

// Вынести раздел в отдельное окно ОС (Electron) или вкладку браузера
export function openSectionWindow(path: string): void {
  const wc = (window as any).electron?.windowControls;
  if (wc?.openWindow) wc.openWindow(path);
  else window.open(`${window.location.origin}${window.location.pathname}#${path}`, '_blank', 'width=1280,height=800');
}
