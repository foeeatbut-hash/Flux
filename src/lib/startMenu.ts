/**
 * Меню «Пуск»: что в нём показывать и в каком порядке.
 *
 * Отдельно от разметки по той же причине, что и панель задач: отбор по правам,
 * поиск по названию и список недавних — ровно то место, где ошибка не видна
 * глазом. Здесь только данные внутрь и данные наружу.
 */

export interface StartSource {
  path: string;
  title: string;
  scope: 'project' | 'global' | 'mixed';
  adminOnly?: boolean;
  /** Раздел выдаётся по праву: без него его не видно нигде */
  feature?: string;
}

export interface StartGroup {
  id: 'office' | 'project' | 'global';
  title: string;
  items: StartSource[];
}

/**
 * Flux Office — четыре редактора одной семьёй.
 *
 * Они стоят отдельной группой, потому что человек ищет их вместе: «чем открыть
 * файл». В группах «Проект» и «Общее» они терялись между разделами про данные,
 * хотя это не разделы, а программы для работы с файлами.
 */
export const OFFICE_PATHS = ['/sheet', '/doc', '/notes', '/pdf'];
export const OFFICE_TITLE = 'Flux Office';

/** Шесть строк — столько влезает в меню, не заставляя прокручивать */
export const RECENT_SHOWN = 6;

/**
 * Поиск по названию: без учёта регистра и без учёта раскладки — «tuub» вместо
 * «теги» человек набирает чаще, чем кажется. Раскладку разбираем простой
 * заменой по клавишам: словарь тут не нужен, названий полтора десятка.
 */
const RU_BY_EN: Record<string, string> = {
  q: 'й', w: 'ц', e: 'у', r: 'к', t: 'е', y: 'н', u: 'г', i: 'ш', o: 'щ', p: 'з',
  a: 'ф', s: 'ы', d: 'в', f: 'а', g: 'п', h: 'р', j: 'о', k: 'л', l: 'д',
  z: 'я', x: 'ч', c: 'с', v: 'м', b: 'и', n: 'т', m: 'ь',
  '[': 'х', ']': 'ъ', ';': 'ж', "'": 'э', ',': 'б', '.': 'ю',
};

export function toRu(s: string): string {
  return s.toLowerCase().split('').map((ch) => RU_BY_EN[ch] || ch).join('');
}

export function matches(title: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const t = title.toLowerCase();
  return t.includes(q) || t.includes(toRu(q));
}

/**
 * Разделы, доступные человеку: без чужих по правам и без служебных.
 *
 * `can` отвечает, есть ли у человека право. Без него разделы, закрытые правом,
 * показывались бы всем — а закрытый раздел, видный в меню, это обещание,
 * которое программа не выполнит.
 */
export function allowed(
  sections: StartSource[],
  isAdmin: boolean,
  can: (feature: string) => boolean = () => true,
): StartSource[] {
  return sections.filter((s) => (!s.adminOnly || isAdmin) && (!s.feature || isAdmin || can(s.feature)));
}

/**
 * Группы Пуска: сначала Flux Office, затем проектное и общее — как в левом
 * меню. «Смешанные» (Главная, Параметры) в группы не попадают: они не про
 * выбор области, а про саму программу, и живут в подвале меню.
 */
export function groupSections(
  sections: StartSource[],
  isAdmin: boolean,
  query = '',
  can: (feature: string) => boolean = () => true,
): StartGroup[] {
  const list = allowed(sections, isAdmin, can).filter((s) => matches(s.title, query));
  const office = new Set(OFFICE_PATHS);
  // Порядок внутри семьи — тот, что записан в OFFICE_PATHS, а не тот, в каком
  // разделы объявлены: человек привыкает к месту значка
  const inOffice = OFFICE_PATHS
    .map((p) => list.find((s) => s.path === p))
    .filter(Boolean) as StartSource[];
  const rest = list.filter((s) => !office.has(s.path));
  const groups: StartGroup[] = [
    { id: 'office', title: OFFICE_TITLE, items: inOffice },
    { id: 'project', title: 'Проект', items: rest.filter((s) => s.scope === 'project') },
    { id: 'global', title: 'Общее', items: rest.filter((s) => s.scope === 'global') },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/**
 * Закреплённое: программы, которые человек вынес на рабочий стол.
 *
 * В Пуске они идут первыми — это его собственный набор, и искать его в общем
 * списке каждый раз незачем. Закрытое правом сюда не попадает: закрепить можно
 * было раньше, а право могли и снять.
 */
export function pinnedTiles(
  paths: string[],
  sections: StartSource[],
  isAdmin: boolean,
  can: (feature: string) => boolean = () => true,
): StartSource[] {
  const ok = new Map(allowed(sections, isAdmin, can).map((s) => [s.path, s]));
  const seen = new Set<string>();
  const out: StartSource[] = [];
  for (const p of paths) {
    const s = ok.get(p);
    if (s && !seen.has(p)) { seen.add(p); out.push(s); }
  }
  return out;
}

/** Переставить плитку: перетаскивание внутри закреплённого */
export function moveInList<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

/**
 * Куда переедет выделение по стрелке.
 *
 * Плитки лежат сеткой, а список — один: строка это `cols` подряд идущих
 * позиций. Выход за край не заворачивается на другую строку и не уводит за
 * пределы списка — стрелка вниз на последней строке должна оставлять человека
 * там, где он есть, а не бросать его в начало.
 */
export function stepFocus(count: number, current: number, key: string, cols: number): number {
  if (count <= 0) return -1;
  if (current < 0) return 0;
  const c = Math.max(1, cols);
  let next = current;
  if (key === 'ArrowRight') next = current + 1;
  else if (key === 'ArrowLeft') next = current - 1;
  else if (key === 'ArrowDown') next = current + c;
  else if (key === 'ArrowUp') next = current - c;
  else return current;
  if (next < 0 || next >= count) return current;
  return next;
}

/** Сколько всего нашлось — по нему решается, показывать ли «ничего не найдено» */
export function countFound(groups: StartGroup[]): number {
  return groups.reduce((n, g) => n + g.items.length, 0);
}

/**
 * Недавние, из которых убрано то, чего человек больше не видит по правам.
 *
 * Сам список ведёт рабочий стол (rememberSectionUse / recentSections в
 * workspaceStore) — он же его и пишет при открытии раздела. Заводить здесь
 * второй список значило бы иметь два писателя в один ключ хранилища.
 */
export function visibleRecent(paths: string[], sections: StartSource[], isAdmin: boolean): StartSource[] {
  const ok = new Map(allowed(sections, isAdmin).map((s) => [s.path, s]));
  const seen = new Set<string>();
  const out: StartSource[] = [];
  for (const p of paths) {
    const s = ok.get(p);
    if (s && !seen.has(p)) { seen.add(p); out.push(s); }
    if (out.length >= RECENT_SHOWN) break;
  }
  return out;
}
