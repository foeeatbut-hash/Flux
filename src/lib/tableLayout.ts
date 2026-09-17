/**
 * Разметка таблицы: сначала выбираем поля, потом собираем данные.
 *
 * До этого порядок был обратный: мастер из трёх шагов спрашивал всё сразу и
 * вставлял готовую таблицу. Пока он был открыт, самой книги не было видно, а
 * набор столбцов нигде не оставался — автоматчику, которому нужен тот же набор
 * с одним изменённым столбцом, приходилось проходить мастер заново.
 *
 * Теперь человек размечает шапку по ячейке: выделил, выбрал поле — в ячейке
 * встало его название, данных ещё нет. Разметка живёт отдельно от значений, и
 * это главное: её можно сохранить шаблоном, применить в другом проекте и
 * собрать сколько угодно раз.
 *
 * Здесь только правила, без React и без движка таблиц: у них есть правильный
 * ответ, и его проверяет скрипт (scripts/test-table-layout.ts).
 */

// ── Что считать строкой ──────────────────────────────────────────────────────

/**
 * Виды строки — объявленным списком, а не ветками `if`.
 *
 * Владелец назвал тег, позицию оборудования и «бланк заказа в будущем». Бланк
 * добавится сюда одной записью и одной веткой на сервере; если бы выбор был
 * зашит двумя условиями, каждое новое «что-нибудь ещё конкретное» означало бы
 * правку в пяти местах.
 */
export interface Grain {
  id: string;
  /** Как называется в ленте и в панели полей */
  label: string;
  /** Что стоит в единственном числе: «Тег», «Позиция» — для заголовка панели */
  one: string;
  /** Откуда каталог берёт постоянные поля этого вида */
  fieldsKey: 'tagFields' | 'elementFields';
}

export const GRAINS: Grain[] = [
  { id: 'tag', label: 'Строка — тег', one: 'Тег', fieldsKey: 'tagFields' },
  { id: 'element', label: 'Строка — позиция', one: 'Позиция', fieldsKey: 'elementFields' },
];

export const grainById = (id: string): Grain => GRAINS.find(g => g.id === id) || GRAINS[0];

// ── Каталог полей проекта ────────────────────────────────────────────────────

/** Поле в списке выбора: к самому полю добавлено то, что помогает выбрать. */
export interface CatalogField extends FieldRef {
  /** Раздел списка: «Тег», «Характеристики», «Свои поля», «Метаданные» */
  section: string;
  /** У скольких строк проекта это поле заполнено. Ноль — поле пустое */
  filled?: number;
  /** Образец значения из проекта: по нему узнают поле вернее, чем по названию */
  sample?: string;
}

/** То, что отдаёт `GET /api/constructor/catalog`. */
export interface ProjectCatalog {
  counts?: { tags: number; elements: number };
  tagFields?: { path: string; title: string }[];
  elementFields?: { path: string; title: string }[];
  params?: { group: string; key: string; unit: string; count: number; sample: string }[];
  metaKeys?: { path: string; key: string; count: number }[];
  aliases?: { path: string; title: string; unit: string; members: string[]; count: number }[];
}

/**
 * Все поля проекта одним списком.
 *
 * «Собрать можно каждое значение» держится именно здесь: постоянные поля
 * объявлены, а характеристики НЕ объявлены — они берутся из бланков проекта.
 * Поэтому список в разных проектах разный, и это правильно: в одном есть
 * «Расход воздуха», в другом «Расход теплоносителя», и придумывать общий
 * словарь на все случаи означало бы либо потерять половину, либо показать
 * сотню полей, которых в этом проекте нет.
 *
 * Свои поля (объединённые) идут первыми: их завёл человек, значит они ему
 * нужнее наших.
 */
export function catalogFields(catalog: ProjectCatalog | null, grain: string): CatalogField[] {
  if (!catalog) return [];
  const g = grainById(grain);
  const own: CatalogField[] = (catalog.aliases || []).map((a) => ({
    path: a.path, title: a.title, unit: a.unit || '',
    section: 'Свои поля', filled: a.count,
  }));
  const base: CatalogField[] = (catalog[g.fieldsKey] || []).map((f) => ({
    path: f.path, title: f.title, section: g.one,
  }));
  const meta: CatalogField[] = grain === 'tag'
    ? (catalog.metaKeys || []).map((m) => ({
      path: m.path, title: m.key, section: 'Метаданные', filled: m.count,
    }))
    : [];
  const params: CatalogField[] = (catalog.params || []).map((p) => ({
    path: `param:${p.group}|${p.key}`, title: p.key, unit: p.unit || '',
    section: p.group || 'Характеристики', filled: p.count, sample: p.sample,
  }));
  return [...own, ...base, ...meta, ...params];
}

/**
 * Отбор по строке поиска.
 *
 * Ищем и по названию, и по разделу: человек помнит «где-то в аэродинамике», а
 * не точное слово. Регистр и лишние пробелы не важны.
 */
export function searchFields(fields: CatalogField[], query: string): CatalogField[] {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return fields;
  return fields.filter((f) =>
    f.title.toLowerCase().includes(q)
    || f.section.toLowerCase().includes(q)
    || String(f.unit || '').toLowerCase().includes(q));
}

/** Разложить по разделам, сохраняя порядок появления разделов. */
export function bySection(fields: CatalogField[]): { section: string; fields: CatalogField[] }[] {
  const out: { section: string; fields: CatalogField[] }[] = [];
  const at = new Map<string, CatalogField[]>();
  for (const f of fields) {
    let bucket = at.get(f.section);
    if (!bucket) { bucket = []; at.set(f.section, bucket); out.push({ section: f.section, fields: bucket }); }
    bucket.push(f);
  }
  return out;
}

// ── Разметка ─────────────────────────────────────────────────────────────────

/** Поле проекта так, как его выбрали: путь для сервера и подпись для человека. */
export interface FieldRef {
  /** Путь запроса: 'identifier', 'system.name', 'param:Аэродинамика|Расход', 'meta:ключ' */
  path: string;
  title: string;
  unit?: string;
}

/** Столбец разметки: поле и НОМЕР СТОЛБЦА ЛИСТА, в котором оно стоит. */
export interface LayoutColumn extends FieldRef {
  /** Абсолютный номер столбца листа, с нуля */
  col: number;
}

export interface TableLayout {
  grain: string;
  /** Строка шапки листа, с нуля */
  headerRow: number;
  columns: LayoutColumn[];
  filters: { field: string; op: string; value: string }[];
}

export const emptyLayout = (grain = 'tag', headerRow = 0): TableLayout => ({
  grain, headerRow, columns: [], filters: [],
});

/** Столбцы всегда по возрастанию номера: так их видит человек на листе. */
const ordered = (columns: LayoutColumn[]): LayoutColumn[] =>
  [...columns].sort((a, b) => a.col - b.col);

/**
 * Привязать поле к столбцу.
 *
 * Повторный выбор того же столбца заменяет поле, а не добавляет второе: человек
 * ткнул не туда и исправился — это одно действие, а не два столбца на одном
 * месте. Одно и то же поле в двух столбцах разрешено: расход в м³/ч и он же
 * рядом в л/с — законная таблица.
 */
export function bindColumn(layout: TableLayout, col: number, field: FieldRef): TableLayout {
  const rest = layout.columns.filter(c => c.col !== col);
  return { ...layout, columns: ordered([...rest, { ...field, col }]) };
}

/** Снять поле со столбца. Ячейка шапки при этом очищается вызывающим. */
export function unbindColumn(layout: TableLayout, col: number): TableLayout {
  return { ...layout, columns: ordered(layout.columns.filter(c => c.col !== col)) };
}

/** Есть ли поле в этом столбце. */
export const columnAt = (layout: TableLayout, col: number): LayoutColumn | null =>
  layout.columns.find(c => c.col === col) || null;

/**
 * Что писать в ячейку шапки.
 *
 * Единица идёт в шапку, а не в ячейку значения — то же соглашение, что в
 * выгрузке оборудования: иначе столбец нельзя ни сложить, ни отсортировать.
 * Дважды единицу не дописываем: подпись из бланка нередко уже несёт её.
 */
export function headerText(field: FieldRef): string {
  const name = String(field.title || '').trim();
  const unit = String(field.unit || '').trim();
  if (!unit) return name;
  const tail = name.split(',').pop()?.trim().toLowerCase() || '';
  const norm = (s: string) => s.replace(/³/g, '3').replace(/²/g, '2').replace(/[\s.]/g, '').toLowerCase();
  return tail && norm(tail) === norm(unit) ? name : `${name}, ${unit}`;
}

/**
 * Вид размеченной ячейки — «чип».
 *
 * Своего рисовальщика ячеек у движка мы не заводим: это была бы отдельная
 * подсистема ради одной подложки. Чип собирается тем, что движок уже умеет, —
 * и остаётся обычной ячейкой, поэтому в Excel уезжает нормальной шапкой, а не
 * пустотой с картинкой.
 */
export const CHIP = {
  /** Подложка размеченного, но ещё не собранного столбца */
  pending: '#ECFDF5',
  /** Подложка шапки собранного столбца */
  collected: '#F1F5F9',
  border: '#CBD5E1',
} as const;

// ── Расхождения с проектом ───────────────────────────────────────────────────

/**
 * Что стало с одним значением.
 *
 * Различаются не «сошлось / не сошлось», а четыре разных разговора. Свалить их
 * в один флаг значило бы затирать правку человека обновлением проекта — самая
 * дорогая ошибка из возможных здесь.
 */
export type CellState =
  /** В листе то же, что записали, и в проекте то же — говорить не о чем */
  | 'same'
  /** В листе то же, что записали, а в проекте стало другое — можно обновлять */
  | 'changed'
  /** В листе правка человека, в проекте ничего не менялось — не трогаем */
  | 'manual'
  /** И человек правил, и проект изменился — решает человек */
  | 'conflict';

export interface CellDiff {
  /** Ключ строки: 'tag:<id>' или 'element:<id>' */
  key: string;
  /** Номер столбца листа */
  col: number;
  colTitle: string;
  state: CellState;
  /** Что записали в прошлый раз */
  written: string;
  /** Что стоит в листе сейчас */
  current: string;
  /** Что предлагает проект */
  fresh: string;
}

export interface RowDiff {
  key: string;
  /** Чем строка называется для человека: обычно тег */
  title: string;
}

export interface LayoutDiff {
  cells: CellDiff[];
  /** Строки, которых в проекте больше нет */
  gone: RowDiff[];
  /** Строки, появившиеся в проекте */
  added: RowDiff[];
  /** Сколько значений можно обновить без вопросов */
  safe: number;
  /** Сколько требуют решения человека */
  asks: number;
}

const text = (v: unknown): string => String(v ?? '').trim();

/**
 * Разложить расхождение по клеткам.
 *
 * Сравниваются ТРИ величины, а не две: что мы записали в прошлый раз, что стоит
 * в листе сейчас и что говорит проект. Только по трём видно разницу между
 * «проект уехал» и «человек поправил руками» — по двум они неотличимы, и
 * обновление съедало бы чужую работу.
 */
export function diffLayout(input: {
  /** Ключи строк прошлой сборки, по порядку */
  wasKeys: string[];
  /** Что записали прошлой сборкой: строка × столбец разметки */
  written: string[][];
  /** Что стоит в листе сейчас, той же формы */
  current: string[][];
  /** Свежая выборка проекта: ключ → значения по столбцам разметки */
  fresh: Map<string, string[]>;
  /** Как называть строку человеку */
  titleOf?: (key: string) => string;
  columns: LayoutColumn[];
}): LayoutDiff {
  const { wasKeys, written, current, fresh, columns } = input;
  const titleOf = input.titleOf || ((k: string) => k);

  const cells: CellDiff[] = [];
  wasKeys.forEach((key, r) => {
    const live = fresh.get(key);
    if (!live) return; // строка пропала — это не расхождение значений, а gone
    columns.forEach((c, i) => {
      const was = text(written[r]?.[i]);
      const now = text(current[r]?.[i]);
      const next = text(live[i]);
      const touched = now !== was;
      const moved = next !== was;
      if (!touched && !moved) return;
      const state: CellState = touched && moved ? 'conflict' : touched ? 'manual' : 'changed';
      cells.push({ key, col: c.col, colTitle: c.title, state, written: was, current: now, fresh: next });
    });
  });

  const had = new Set(wasKeys);
  const has = new Set(fresh.keys());
  const gone = wasKeys.filter(k => !has.has(k)).map(k => ({ key: k, title: titleOf(k) }));
  const added = [...has].filter(k => !had.has(k)).map(k => ({ key: k, title: titleOf(k) }));

  return {
    cells, gone, added,
    safe: cells.filter(c => c.state === 'changed').length,
    asks: cells.filter(c => c.state === 'conflict' || c.state === 'manual').length,
  };
}

/** Человеческое имя состояния — одно на всю программу, чтобы не разошлось. */
export const STATE_NAMES: Record<CellState, string> = {
  same: 'Совпадает',
  changed: 'Изменилось в проекте',
  manual: 'Правка вручную',
  conflict: 'Разошлись обе стороны',
};

// ── Шаблон шапки ─────────────────────────────────────────────────────────────

/**
 * Шаблон — это разметка без листа и без данных.
 *
 * Номера столбцов в шаблон не входят намеренно: он применяется в другой книге,
 * где шапка может начинаться не с той же клетки. Сохраняется порядок полей, а
 * куда их положить, решает применение.
 */
export interface TableTemplateBody {
  grain: string;
  columns: FieldRef[];
  filters: { field: string; op: string; value: string }[];
}

export function layoutToTemplate(layout: TableLayout): TableTemplateBody {
  return {
    grain: layout.grain,
    columns: ordered(layout.columns).map(({ path, title, unit }) => ({ path, title, ...(unit ? { unit } : {}) })),
    filters: layout.filters.map(f => ({ ...f })),
  };
}

/**
 * Разложить шаблон по листу от заданной клетки.
 *
 * Поля ложатся подряд вправо. Пропуски прошлой разметки не переносятся: они
 * были свойством той книги, а не набора полей.
 */
export function templateToLayout(
  body: TableTemplateBody, at: { row: number; col: number },
): TableLayout {
  return {
    grain: body.grain || 'tag',
    headerRow: at.row,
    columns: (body.columns || []).map((f, i) => ({ ...f, col: at.col + i })),
    filters: (body.filters || []).map(f => ({ ...f })),
  };
}

/**
 * Список из двух разных мест.
 *
 * Из базы он приходит строкой, из запроса — уже разобранным массивом.
 * Проверка на массив стоит ПЕРВОЙ, и это не перестраховка: без неё
 * `String(массив)` даёт «[object Object]», разбор падает, и сохранение
 * шаблона получает пустой список. Сервер отвечал «В шапке нет ни одного
 * поля» на шапку, в которой поля были, — человек видел отказ и не мог понять,
 * что не так, потому что на листе всё стояло.
 */
export function asArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) { return []; }
}

/** Прочитать тело шаблона, не падая на чужом содержимом. */
export function readTemplateBody(raw: string | null | undefined): TableTemplateBody {
  const empty: TableTemplateBody = { grain: 'tag', columns: [], filters: [] };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== 'object') return empty;
    const columns = Array.isArray(parsed.columns)
      ? parsed.columns.filter((c: any) => c && typeof c.path === 'string')
        .map((c: any) => ({ path: String(c.path), title: String(c.title || c.path), ...(c.unit ? { unit: String(c.unit) } : {}) }))
      : [];
    const filters = Array.isArray(parsed.filters) ? parsed.filters : [];
    return { grain: String(parsed.grain || 'tag'), columns, filters };
  } catch (_) {
    return empty;
  }
}

/** Почему шаблон нельзя сохранить. Пустая строка — можно. */
export function whyNotSaveTemplate(name: string, layout: TableLayout): string {
  if (!String(name || '').trim()) return 'Дайте шаблону имя — по нему его будут искать';
  if (!layout.columns.length) return 'В шапке нет ни одного поля';
  return '';
}
