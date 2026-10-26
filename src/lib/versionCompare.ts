/**
 * Сравнение номеров выпуска по правилу semver: единственное место, откуда
 * берут порядок версий и окно (isNewer), и сервер («последний» выпуск), и
 * главный процесс (отказ в откате).
 *
 * Раньше хвост после дефиса отбрасывался, и «1.21.0-beta» считался равным
 * «1.21.0», а «-rc2» не новее «-rc1»: пред-выпуск мешал выпуску, а владелец,
 * выложив rc2, не видел его у тестировщиков. Теперь при равных числах выпуск
 * без суффикса новее любого пред-выпуска, а суффиксы сравниваются по частям:
 * числа по значению и раньше слов, слова по алфавиту, короче — старше.
 *
 * Без зависимостей: модуль берут и окно, и Node.
 */
const parseVersion = (v: string): { core: number[]; pre: string[] } => {
  const text = String(v || '').trim(), dash = text.indexOf('-');
  const core = (dash < 0 ? text : text.slice(0, dash)).split('.').map((x) => parseInt(x, 10) || 0);
  const tail = dash < 0 ? '' : text.slice(dash + 1);
  return { core, pre: tail ? tail.split('.') : [] };
};

const numeric = (s: string) => /^\d+$/.test(s);

/** 1 — `a` новее, -1 — старее, 0 — одинаковые */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    const d = (x.core[i] || 0) - (y.core[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  // Числа равны: выпуск без суффикса новее пред-выпуска
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === q) continue;
    if (numeric(p) && numeric(q)) return Number(p) > Number(q) ? 1 : -1;
    // Число раньше слова: «beta.2» старее «beta.rc»
    if (numeric(p) !== numeric(q)) return numeric(p) ? -1 : 1;
    return p > q ? 1 : -1;
  }
  if (x.pre.length === y.pre.length) return 0;
  return x.pre.length > y.pre.length ? 1 : -1;
}

/** Новее ли выложенная версия той, что запущена */
export const isNewer = (latest: string, current: string): boolean => compareVersions(latest, current) > 0;
