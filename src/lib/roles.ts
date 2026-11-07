/**
 * Должности сотрудников.
 *
 * Раньше они были зашиты в коде: четыре строки и switch со значками в
 * каждом экране, где показывался сотрудник. В разных компаниях состав
 * должностей свой, поэтому их ведёт владелец (или администратор с правом
 * «Должности: справочник») в программе «Сотрудники», а программа берёт их из
 * базы и рисует одинаково везде.
 *
 * Должность — не уровень доступа. «Администратор» и «Владелец» — уровни, они в
 * справочник не входят; администраторов назначает только владелец, а владельцу
 * доступно всё. Тип `Role` и таблица называются по-старому — это и есть должность.
 */

import { getAuthToken, ENV_CONFIG } from '../config/env';
import { isNonPositionCode } from '../../shared/positions';

export interface Role {
  id: string;
  code: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  /** Порядок в справочнике; уровнем доступа не служит */
  level: number;
  isSystem: boolean;
  permissions?: string;
  sortOrder: number;
}

/** Палитра значков ролей: пары «фон + текст + рамка» для светлой и тёмной темы. */
export const ROLE_COLORS: { id: string; label: string; cls: string; dot: string }[] = [
  { id: 'rose',    label: 'Красный',   dot: 'bg-rose-500',    cls: 'bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-900/50' },
  { id: 'amber',   label: 'Янтарный',  dot: 'bg-amber-500',   cls: 'bg-amber-50 dark:bg-amber-950/20 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800/40' },
  { id: 'emerald', label: 'Зелёный',   dot: 'bg-emerald-500', cls: 'bg-emerald-50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800/40' },
  { id: 'sky',     label: 'Голубой',   dot: 'bg-sky-500',     cls: 'bg-sky-50 dark:bg-sky-950/20 text-sky-700 dark:text-sky-400 border-sky-200 dark:border-sky-800/40' },
  { id: 'indigo',  label: 'Синий',     dot: 'bg-indigo-500',  cls: 'bg-indigo-50 dark:bg-indigo-950/20 text-indigo-700 dark:text-indigo-400 border-indigo-200 dark:border-indigo-800/40' },
  { id: 'violet',  label: 'Фиолетовый',dot: 'bg-violet-500',  cls: 'bg-violet-50 dark:bg-violet-950/20 text-violet-700 dark:text-violet-400 border-violet-200 dark:border-violet-800/40' },
  { id: 'teal',    label: 'Бирюзовый', dot: 'bg-teal-500',    cls: 'bg-teal-50 dark:bg-teal-950/20 text-teal-700 dark:text-teal-400 border-teal-200 dark:border-teal-800/40' },
  { id: 'slate',   label: 'Серый',     dot: 'bg-slate-400',   cls: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700' },
];

export const roleColorClass = (color?: string): string =>
  (ROLE_COLORS.find((c) => c.id === color) || ROLE_COLORS[ROLE_COLORS.length - 1]).cls;

/** Значки на выбор — из тех, что уже есть в программе. */
export const ROLE_ICONS = [
  'shield-check', 'briefcase', 'airplay', 'cpu', 'user', 'users',
  'hard-hat', 'wrench', 'ruler', 'clipboard-list', 'calculator', 'flame', 'code',
] as const;

// Роли меняются редко, а показываются на каждом экране со списком людей —
// держим их в памяти и обновляем по событию, а не запросом на каждый рендер.
let cache: Role[] | null = null;
let inflight: Promise<Role[]> | null = null;

const authHeaders = (): Record<string, string> => {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export async function loadRoles(force = false): Promise<Role[]> {
  if (!force && cache) return cache;
  if (!force && inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(`${ENV_CONFIG.apiUrl}/roles`, { headers: authHeaders() });
      if (!res.ok) throw new Error('roles');
      const data = await res.json();
      cache = Array.isArray(data.roles) ? data.roles : [];
      return cache!;
    } catch (_) {
      // Сервер старой версии или нет связи — работаем на встроенном наборе,
      // иначе экран сотрудников остался бы без единой должности.
      cache = FALLBACK_ROLES;
      return cache;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function cachedRoles(): Role[] {
  return cache || FALLBACK_ROLES;
}

export function invalidateRoles() {
  cache = null;
  try { window.dispatchEvent(new CustomEvent('flux:roles-changed')); } catch (_) {}
}

export const FALLBACK_ROLES: Role[] = [
  { id: 'sys-manager', code: 'MANAGER', name: 'Менеджер проектов', description: '', color: 'amber', icon: 'briefcase', level: 20, isSystem: true, sortOrder: 20 },
  { id: 'sys-vent', code: 'ENGINEER_VENT', name: 'Инженер ОВиК', description: '', color: 'sky', icon: 'airplay', level: 50, isSystem: true, sortOrder: 30 },
  { id: 'sys-auto', code: 'ENGINEER_AUTO', name: 'Инженер КИПиА', description: '', color: 'emerald', icon: 'cpu', level: 50, isSystem: true, sortOrder: 40 },
  { id: 'sys-developer', code: 'MODULE_DEVELOPER', name: 'Разработчик', description: '', color: 'violet', icon: 'code', level: 50, isSystem: true, sortOrder: 50 },
];

/** Роль по коду — с запасным вариантом, чтобы список не «терял» сотрудника. */
export function roleByCode(code: string, roles?: Role[]): Role {
  const list = roles || cachedRoles();
  return list.find((r) => r.code === code)
    || { id: code, code, name: code, description: '', color: 'slate', icon: 'user', level: 90, isSystem: false, sortOrder: 999 };
}

/** Владелец Flux: ему доступно всё; уровни доступа и полномочия администраторов назначает только он. */
export function isOwner(user: { role?: string } | null | undefined): boolean {
  return user?.role === 'OWNER';
}

/** Должности справочника — без уровней доступа (OWNER, ADMIN): их выбирать как должность нельзя. */
export const positionsOnly = (roles: Role[]): Role[] => roles.filter((r) => !isNonPositionCode(r.code));
