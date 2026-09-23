/**
 * Вид категории: какие параметры показывать у каждого типа оборудования и в
 * каком порядке.
 *
 * Раньше видимость хранилась по `equipType` и настраивалась по одной карточке,
 * только её параметрами, за кнопкой «показать все». Владелец просил иначе:
 * «вид должен сохраняться в целом на все имеющиеся параметры категорий… для
 * каждой категории оборудования отдельно». Отсюда устройство:
 *
 *   — вид хранится на КАТЕГОРИЮ (`equip_view:<категория>`), а внутри — на ТИП
 *     оборудования: у приводов своё, у вентиляторов своё;
 *   — у типа три вещи: порядок разделов, порядок параметров и скрытые;
 *   — параметр, которого вид ещё не знает (пришёл с новым расчётом), не
 *     теряется: он встаёт в конец своего раздела и виден, пока его не скроют.
 *
 * Токены скрытия прежние — `g:раздел` и `p:раздел||параметр`, — поэтому
 * старые настройки переезжают без потерь: пока у типа нет своего вида, берутся
 * прежние скрытия его `equipType`, а первая правка записывает их в новый вид.
 *
 * Модуль чистый: правила проверяются scripts/test-category-view.ts.
 */

export interface ClassView {
  /** Порядок разделов; не названные идут после, в порядке карточки */
  groups?: string[];
  /** Порядок параметров: токены «раздел||параметр» */
  params?: string[];
  /** Скрытые: `g:раздел` и `p:раздел||параметр` */
  hidden: string[];
}

/** Вид категории: тип оборудования → его вид */
export type CategoryView = Record<string, ClassView>;

export interface ViewParam { key: string; value?: string; unit?: string }
export interface ViewGroup { title: string; params: ViewParam[] }

export const groupToken = (group: string): string => `g:${group}`;
export const paramToken = (group: string, key: string): string => `p:${group}||${key}`;
const paramId = (group: string, key: string): string => `${group}||${key}`;

export const settingKey = (categoryId: string): string => `equip_view:${categoryId}`;

/** Разобрать сохранённое. Мусор — пустой вид, а не падение раздела */
export function parseView(raw: unknown): CategoryView {
  let v: any = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { return {}; } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: CategoryView = {};
  for (const [cls, cv] of Object.entries(v as Record<string, any>)) {
    if (!cv || typeof cv !== 'object') continue;
    const list = (x: unknown) => (Array.isArray(x) ? x.map(String).filter(Boolean) : undefined);
    out[cls] = { hidden: list(cv.hidden) || [], groups: list(cv.groups), params: list(cv.params) };
  }
  return out;
}

/**
 * Вид типа. Своего нет — прежние скрытия по `equipType` (`legacy`): так старая
 * настройка продолжает работать, пока её не тронули.
 */
export function viewOf(view: CategoryView, cls: string, legacy: string[] = []): ClassView {
  return view[cls] || { hidden: [...legacy] };
}

export const isHiddenIn = (cv: ClassView, token: string): boolean => cv.hidden.includes(token);

/** Переключить скрытие — первая правка переносит прежние скрытия в новый вид */
export function toggleIn(view: CategoryView, cls: string, token: string, legacy: string[] = []): CategoryView {
  const cv = viewOf(view, cls, legacy);
  const hidden = cv.hidden.includes(token) ? cv.hidden.filter((t) => t !== token) : [...cv.hidden, token];
  return { ...view, [cls]: { ...cv, hidden } };
}

/**
 * Разложить разделы карточки по виду.
 *
 * Названные в виде разделы и параметры — в его порядке; остальные — после, в
 * порядке карточки. Скрытое НЕ выбрасывается: карточка сама решает, показать
 * ли его бледным (в режиме «все параметры») или убрать.
 */
export function arrange<G extends ViewGroup>(groups: G[], cv: ClassView): G[] {
  const gOrder = cv.groups || [];
  const pOrder = cv.params || [];
  const rank = (list: string[], id: string) => { const i = list.indexOf(id); return i < 0 ? Infinity : i; };
  const byGroup = [...groups].map((g, i) => ({ g, i }))
    .sort((a, b) => (rank(gOrder, a.g.title) - rank(gOrder, b.g.title)) || (a.i - b.i))
    .map((x) => x.g);
  return byGroup.map((g) => ({
    ...g,
    params: [...(g.params || [])].map((p, i) => ({ p, i }))
      .sort((a, b) => (rank(pOrder, paramId(g.title, a.p.key)) - rank(pOrder, paramId(g.title, b.p.key))) || (a.i - b.i))
      .map((x) => x.p),
  }));
}

/** Параметр в сводке типа: сколько позиций его вообще знают и у скольких он заполнен */
export interface CatalogParam { key: string; unit: string; present: number; filled: number }
export interface CatalogGroup { title: string; params: CatalogParam[] }

/**
 * Все параметры типа по всем позициям категории — «есть у 3 из 4».
 *
 * Порядок — порядок первого появления: так сводка совпадает с тем, что человек
 * видит в карточках, а не перемешана по алфавиту.
 */
export function catalogOf(positions: { groups: ViewGroup[] }[]): { groups: CatalogGroup[]; total: number } {
  const groups: CatalogGroup[] = [];
  const gIndex = new Map<string, CatalogGroup>();
  const pIndex = new Map<string, CatalogParam>();
  for (const pos of positions || []) {
    const seen = new Set<string>();
    for (const g of pos.groups || []) {
      let cg = gIndex.get(g.title);
      if (!cg) { cg = { title: g.title, params: [] }; gIndex.set(g.title, cg); groups.push(cg); }
      for (const p of g.params || []) {
        if (!p?.key) continue;
        const id = paramId(g.title, p.key);
        let cp = pIndex.get(id);
        if (!cp) { cp = { key: p.key, unit: String(p.unit || ''), present: 0, filled: 0 }; pIndex.set(id, cp); cg.params.push(cp); }
        if (seen.has(id)) continue;   // повтор в одной карточке — одна позиция
        seen.add(id);
        cp.present++;
        if (String(p.value ?? '').trim()) cp.filled++;
        if (!cp.unit && p.unit) cp.unit = String(p.unit);
      }
    }
  }
  return { groups, total: (positions || []).length };
}

/** «Показать все» — у типа снимаются все скрытия, порядок остаётся */
export const showAll = (view: CategoryView, cls: string, legacy: string[] = []): CategoryView =>
  ({ ...view, [cls]: { ...viewOf(view, cls, legacy), hidden: [] } });

/** «Скрыть пустые» — то, что не заполнено ни у одной позиции типа */
export function hideEmpty(view: CategoryView, cls: string, catalog: { groups: CatalogGroup[] }, legacy: string[] = []): CategoryView {
  const cv = viewOf(view, cls, legacy);
  const hidden = new Set(cv.hidden);
  for (const g of catalog.groups) {
    for (const p of g.params) if (!p.filled) hidden.add(paramToken(g.title, p.key));
    if (g.params.length && g.params.every((p) => !p.filled)) hidden.add(groupToken(g.title));
  }
  return { ...view, [cls]: { ...cv, hidden: [...hidden] } };
}

/** «Сбросить» — у типа снова нет своего вида: всё видно, порядок карточки */
export function resetClass(view: CategoryView, cls: string): CategoryView {
  const next = { ...view };
  next[cls] = { hidden: [] };
  return next;
}

/**
 * Передвинуть элемент списка на место другого — перетаскивание и стрелки.
 *
 * Список порядка хранит только то, что человек двигал; остальное стоит «как в
 * карточке». Поэтому двигается ПОЛНЫЙ текущий порядок (`current`), а в вид
 * пишется он весь: иначе перенос одного параметра перемешал бы соседей.
 */
export function moveTo(current: string[], from: string, to: string): string[] {
  if (from === to) return current;
  const list = current.filter((x) => x !== from);
  const at = list.indexOf(to);
  if (at < 0) return current;
  // Тянут вниз — встаёт после цели, вверх — перед ней: так работает любой список
  const down = current.indexOf(from) < current.indexOf(to);
  list.splice(down ? at + 1 : at, 0, from);
  return list;
}

/** Сдвинуть на шаг — для стрелок и клавиатуры */
export function step(current: string[], id: string, dir: -1 | 1): string[] {
  const i = current.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= current.length) return current;
  const list = [...current];
  [list[i], list[j]] = [list[j], list[i]];
  return list;
}

/** Порядок разделов и параметров, как он сейчас выглядит, — для записи в вид */
export function orderOf(groups: ViewGroup[]): { groups: string[]; params: string[] } {
  return {
    groups: groups.map((g) => g.title),
    params: groups.flatMap((g) => (g.params || []).map((p) => paramId(g.title, p.key))),
  };
}
