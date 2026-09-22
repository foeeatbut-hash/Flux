/**
 * Характеристики позиции: один разбор для всех, кто их показывает.
 *
 * В базе `specs` лежат тремя способами сразу — так сложилось за три версии
 * импорта: сгруппированно (`{groups:[…]}`), массивом групп и плоской картой
 * «ключ: значение». Ни один из них не выкинешь: в живых проектах есть все три.
 *
 * Поэтому разбор один и лежит здесь, а не копией в каждом экране: карточка
 * позиции, схема установки и сборка строк выгрузки обязаны видеть одно и то
 * же, иначе в карточке параметр есть, а в выгрузке его нет.
 */

export interface SpecParam { key: string; value: string; unit: string }
export interface SpecGroup { title: string; params: SpecParam[] }

/** Расхождение значения при повторном импорте: было и станет. */
export interface ParamConflict {
  group: string; key: string; oldValue: string; newValue: string; unit: string;
}

/** Любой сохранённый формат → `{ groups: [...] }`. Мусор даёт пустой список. */
export function normalizeSpecs(raw: any): { groups: SpecGroup[] } {
  let parsed: any = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = {}; }
  if (parsed && Array.isArray(parsed.groups)) {
    return { groups: parsed.groups.map((g: any) => ({ title: g?.title || 'Параметры', params: Array.isArray(g?.params) ? g.params : [] })) };
  }
  if (Array.isArray(parsed)) {
    return { groups: parsed.map((g: any) => ({ title: g?.title || 'Параметры', params: Array.isArray(g?.params) ? g.params : [] })) };
  }
  if (parsed && typeof parsed === 'object') {
    const params = Object.entries(parsed).map(([k, v]: [string, any]) => ({
      key: k,
      value: v && typeof v === 'object' ? String(v.value ?? '') : String(v ?? ''),
      unit: v && typeof v === 'object' ? String(v.unit ?? '') : '',
    }));
    return { groups: params.length ? [{ title: 'Параметры', params }] : [] };
  }
  return { groups: [] };
}
