/**
 * Flux Store: что известно о программе в витрине и как это считается.
 *
 * Чистый модуль без React, сети и Node: одни и те же правила читают сервер
 * (собирает витрину), окно (кнопки, окно разрешений), главный процесс и
 * проверки. Разрешения и требования выводятся из manifest.json выпуска —
 * владелец проверяет именно его, поэтому разработчик не может «написать
 * про себя» одно, а запросить другое.
 */
import type { ModuleManifest } from '../contract';
import { CONTRACT_VERSION } from '../contract';
import type { PermissionLine } from '../permissions/registry';
import { compareVersions } from '../../shared/versionCompare';

export const STORE_CATEGORIES = [
  { id: 'calc', name: 'Расчёты' },
  { id: 'link', name: 'Связь с программами' },
  { id: 'docs', name: 'Документы' },
  { id: 'reports', name: 'Отчёты' },
  { id: 'other', name: 'Прочее' },
] as const;
export type StoreCategory = typeof STORE_CATEGORIES[number]['id'];
export const categoryName = (id: string) => STORE_CATEGORIES.find((c) => c.id === id)?.name || 'Прочее';

/** Состояние допуска администратором: новая программа ждёт допуска и обычным людям не видна */
export const STORE_STATUSES = ['pending', 'admitted', 'delisted', 'banned'] as const;
export type StoreStatus = typeof STORE_STATUSES[number];
export const STATUS_NAMES: Record<StoreStatus, string> = {
  pending: 'Ждёт допуска', admitted: 'Проверена администратором', delisted: 'Снята из Store', banned: 'Запрещена',
};

export interface StoreRequires { flux?: string; platform?: 'any' | 'windows'; external?: string[] }
export interface StoreInfo {
  category: StoreCategory;
  summary: string;
  description: string;
  color: string;
  requires: StoreRequires;
  dependsOn: string[];
  /** Для каких должностей (коды Role); пусто — для всех */
  roles: string[];
  /** Пути снимков внутри пакета (`store/…png`) */
  screenshots: string[];
}

const COLOR = /^#[0-9a-fA-F]{6}$/;
export const DEFAULT_COLOR = '#059669';

/** Витринные поля манифеста с умолчаниями: программа без блока `store` остаётся в «Прочем» */
export function storeInfoOf(manifest: ModuleManifest): StoreInfo {
  const s = (manifest as any).store || {};
  return {
    category: STORE_CATEGORIES.some((c) => c.id === s.category) ? s.category : 'other',
    summary: String(s.summary || '').slice(0, 200),
    description: String(s.description || '').slice(0, 4000),
    color: COLOR.test(String(s.color || '')) ? s.color : DEFAULT_COLOR,
    requires: { ...(s.requires && typeof s.requires === 'object' ? s.requires : {}) },
    dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.filter((v: unknown) => typeof v === 'string').slice(0, 10) : [],
    roles: Array.isArray(s.roles) ? s.roles.filter((v: unknown) => typeof v === 'string').slice(0, 20) : [],
    screenshots: Array.isArray(s.screenshots) ? s.screenshots.filter((v: unknown) => typeof v === 'string').slice(0, 8) : [],
  };
}

// ── Разрешения ──────────────────────────────────────────────────────────────
// Виды разрешений, строки для человека, сравнение версий и отпечаток — в реестре
// (modules/permissions/registry.ts); здесь они доступны окну Store под прежними именами.

export { RESOURCE_NAMES, ENTRY_NAMES, permissionLines, addedPermissions, permissionsDigest } from '../permissions/registry';

// ── Требования ──────────────────────────────────────────────────────────────

export interface StoreEnv { fluxVersion: string; windows: boolean }

/** Причины, по которым ставить нельзя; пусто — можно. Внешние программы (E3) только перечисляются в карточке */
export function unmetRequirements(manifest: ModuleManifest, env: StoreEnv): string[] {
  const out: string[] = [];
  const need = storeInfoOf(manifest).requires;
  if (manifest.contractVersion > CONTRACT_VERSION) out.push(`Нужен более новый договор программ (v${manifest.contractVersion}): обновите Flux`);
  if (need.flux && env.fluxVersion && compareVersions(env.fluxVersion, need.flux) < 0) out.push(`Нужен Flux ${need.flux} или новее, у вас ${env.fluxVersion}`);
  if (need.platform === 'windows' && !env.windows) out.push('Работает только в Windows');
  return out;
}

// ── Витрина ─────────────────────────────────────────────────────────────────

export interface StoreVersion {
  version: string; channel: 'test' | 'production'; revoked: boolean; createdAt: string; changelog: string; size: number; releaseId: string;
}
export interface StoreRating { avg: number; count: number; /** 5…1 звезда */ stars: number[] }
export interface StoreMine { version: string; auto: '' | 'on' | 'off'; source: 'user' | 'required' | 'dependency'; installedAt: string }

export interface StoreListing {
  moduleId: string; name: string; developer: string;
  category: StoreCategory; summary: string; description: string; color: string;
  requires: StoreRequires; dependsOn: string[]; roles: string[];
  manifest: ModuleManifest;
  permissions: PermissionLine[];
  /** Новейшая версия, доступная этому человеку (с учётом закрепления и каналов) */
  version: string; channel: 'test' | 'production'; updatedAt: string; changelog: string; size: number; releaseId: string;
  screenshots: string[];
  versions: StoreVersion[];
  status: StoreStatus; deprecated: boolean; testing: boolean;
  rating: StoreRating; installs: number;
  /** Закреплённая администратором версия для этого человека */
  pinned: string | null;
  /** Администратор обязал поставить эту версию для должности человека */
  required: string | null;
  mine: StoreMine | null;
  forMyRole: boolean;
  /** Открытые известные проблемы, помеченные разработчиком (раздел «Ошибки и предложения») */
  known: Array<{ id: string; number: number; title: string; workaround: string }>;
  /** Сбои этой версии за 30 дней: обезличенный счётчик (виден администратору и разработчику) */
  crashes: { version: string; count: number } | null;
}

export const updateAvailable = (l: StoreListing): boolean =>
  !!l.mine && compareVersions(l.version, l.mine.version) > 0 && !l.deprecated;

export function sortNewest<T extends { version: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => compareVersions(b.version, a.version));
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

/** Ряды главной: каждый — отбор и порядок по одному правилу, чтобы тест и окно не разошлись */
export function storeRows(list: StoreListing[]): Array<{ id: string; title: string; items: StoreListing[] }> {
  const visible = list.filter((l) => l.status === 'admitted' && !l.deprecated);
  const byDate = (a: StoreListing, b: StoreListing) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  return [
    { id: 'role', title: 'Для вашей должности', items: visible.filter((l) => l.forMyRole && l.roles.length > 0) },
    { id: 'popular', title: 'Популярные в компании', items: [...visible].filter((l) => l.installs > 0).sort((a, b) => b.installs - a.installs) },
    { id: 'new', title: 'Новые', items: [...visible].filter((l) => l.versions.length === 1).sort(byDate) },
    { id: 'updated', title: 'Недавно обновлённые', items: [...visible].filter((l) => l.versions.length > 1).sort(byDate) },
    { id: 'link', title: 'Связь с программами', items: visible.filter((l) => l.category === 'link') },
  ].filter((row) => row.items.length > 0);
}

export function searchListings(list: StoreListing[], query: string): StoreListing[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((l) => {
    const hay = `${l.name} ${l.developer} ${l.summary} ${l.description} ${categoryName(l.category)}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
