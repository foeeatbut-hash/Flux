/**
 * Лента редакторов: устройство, размеры и поведение в узком окне.
 *
 * Здесь нет ни React, ни разметки — только описание того, из чего лента
 * состоит, и расчёты, которые должны совпадать у всех четырёх редакторов.
 * Разметку рисует один общий компонент (components/ribbon), а состав каждой
 * ленты объявляется данными (lib/ribbonNotes, ribbonDoc, ribbonSheet,
 * ribbonPdf). Иначе через полгода у четвёртого редактора кнопки станут на два
 * пикселя выше и никто этого не заметит.
 *
 * Побочная выгода от объявления данными — состав можно проверить скриптом:
 * scripts/test-ribbon.ts сторожит, что «Данные проекта» есть у всех, что у
 * группы задан вес, что в группе не больше семи органов и что подписи внутри
 * вкладки не повторяются.
 */

// ── Виды органов управления ────────────────────────────────────────────────
// Их ровно семь. Ограничение намеренное: как только появляется восьмой, панели
// начинают расходиться.
export type OrganKind =
  | 'icon'     // значок 26×26: узнаётся с одного взгляда, жмётся часто
  | 'label'    // значок с подписью справа: когда значок сам по себе двусмыслен
  | 'big'      // крупная кнопка 46: главное действие группы, обе строки ленты
  | 'select'   // поле со списком: показывает текущее значение документа
  | 'split'    // разделённая: левая половина повторяет выбор, правая открывает
  | 'spin'     // счётчик: шаг известен заранее (кегль, масштаб, толщина)
  | 'palette'; // палитра: пять цветов на виду, остальные за многоточием

export interface OrganOption {
  value: string;
  label: string;
}

export interface Organ {
  /** Команда: по ней редактор понимает, что делать. Уникальна в пределах ленты */
  id: string;
  kind: OrganKind;
  /** Подпись — у label, big, select и flux-команд */
  label?: string;
  /** Имя значка; сопоставление с lucide живёт в components/ribbon/icons.tsx */
  icon?: string;
  /** Подсказка при наведении. У недоступной кнопки объясняет причину */
  hint?: string;
  /** Сочетание клавиш — в подсказку, второй строкой */
  keys?: string;
  /** Работает с данными проекта: помечается зелёным */
  flux?: boolean;
  /** Переключатель состояния (Ж, К, Ч): показывает, что под курсором */
  toggle?: boolean;
  /** Список значений — у select */
  options?: OrganOption[];
  /** Ширина поля со списком в точках; по умолчанию считается из подписи */
  width?: number;
  /** Цвета палитры */
  colors?: string[];
}

export interface RibbonGroup {
  name: string;
  /**
   * Чем больше, тем позже группа схлопывается. Вес задаётся руками, а не
   * считается по составу: в тексте «шрифт» важнее «стилей», в таблице «число»
   * важнее «ячеек» — из размера группы этого не выведешь.
   */
  weight: number;
  organs: Organ[];
}

export interface RibbonTab {
  name: string;
  groups: RibbonGroup[];
  /**
   * Контекстная вкладка: появляется, только когда есть что выделять, и
   * помечается синей чертой сверху (в программе синий значит «изменение»).
   */
  context?: boolean;
}

// ── Геометрия ──────────────────────────────────────────────────────────────
// Числа заданы один раз и держатся сами — в этом весь смысл общего компонента.
// Полоса вкладок несёт и сведения о документе: отдельной строки документа
// больше нет — она повторяла заголовок окна и отбирала у листа 34 точки
export const TABS_H = 34;      // полоса вкладок со сведениями о документе
export const RIBBON_H = 70;    // лента: 26 на орган + 46 на крупную + подписи
export const STATUS_H = 24;    // строка состояния
export const ORGAN_H = 26;     // высота кнопки, поля, счётчика — одна на все
export const BIG_H = 46;       // крупная кнопка: занимает обе строки ленты
export const GAP = 3;          // промежуток в группе: внутри тесно — это и делает её группой
export const GROUP_PAD = 10;   // поля группы слева и справа, плюс черта

/**
 * Ширина органа в точках — по ней считается, влезает ли группа.
 *
 * Числа не выведены из вёрстки, а измерены на живой ленте: подпись 11 px
 * полужирным даёт примерно 6,4 точки на знак, рамка добавляет 2. Считать «на
 * глаз» здесь нельзя — расчёт и разметка разойдутся, и лента станет то
 * обрезаться, то схлопываться на ровном месте.
 */
const CHAR_W = 6.4;

export function organWidth(o: Organ): number {
  const text = (o.label?.length || 0) * CHAR_W;
  switch (o.kind) {
    case 'icon': return ORGAN_H + 2;
    case 'label': return 36 + text;
    case 'big': return Math.max(56, 18 + text);
    case 'select': return o.width || Math.max(64, 30 + text);
    // 24 — стрелка палитры: двадцать точек цели и четыре на рамку с отступом
    case 'split': return ORGAN_H + 24 + text;
    case 'spin': return 56 + (o.label?.length || 0) * 7;
    case 'palette': return 5 * 14 + 4 * 4 + 14;
    default: return ORGAN_H + 2;
  }
}

/**
 * Ширина группы.
 *
 * Органы стоят в один ряд — и обычные, и крупные. Ряд один, а не два: во
 * втором ряду кнопка оказывается ниже подписи группы, и глаз перестаёт
 * понимать, к какой группе она относится. Проверено на макетах.
 *
 * Считать ширину обязательно так же, как её потом рисует разметка: разойдутся
 * — и лента будет то обрезаться по краю, то схлопываться там, где место есть.
 */
export function groupWidth(g: RibbonGroup): number {
  const w = g.organs.reduce((s, o, i) => s + organWidth(o) + (i ? GAP : 0), 0);
  // Подпись группы тоже требует места: узкая группа с длинным именем иначе
  // наезжает на соседнюю черту
  // +2: разделительная черта справа и округление размеров вверх. Без этого
  // расчёт стабильно на пару точек короче настоящего, и на десяти группах
  // лента вылезала за край
  return Math.max(w, nameWidth(g.name)) + GROUP_PAD * 2 + 2;
}

/** Подпись группы: 9 px моноширинным прописными с разрядкой — 5,9 на знак */
function nameWidth(name: string): number {
  return 5.9 * name.length;
}

/**
 * Ширина схлопнутой группы.
 *
 * Подпись при схлопывании остаётся — по ней и узнают, что спряталось, — и
 * часто она шире самой кнопки с многоточием. Забыть про это значило считать
 * схлопывание выгоднее, чем оно есть, и останавливаться на группу раньше:
 * лента всё равно вылезала за край.
 */
export function collapsedWidth(g: RibbonGroup): number {
  return Math.max(ORGAN_H + 2, nameWidth(g.name)) + GROUP_PAD * 2 + 2;
}

/**
 * Что схлопнуть, когда лента шире окна.
 *
 * Схлопываем по возрастанию веса — сначала то, чем пользуются реже. Ничего не
 * обрезаем и не переносим на вторую строку: группа превращается в кнопку с
 * многоточием, нажатие раскрывает её списком. Пропасть без следа не может
 * ничего.
 */
export function collapseGroups(groups: RibbonGroup[], available: number): Set<string> {
  const collapsed = new Set<string>();
  const total = () => groups.reduce(
    (s, g) => s + (collapsed.has(g.name) ? collapsedWidth(g) : groupWidth(g)), 0,
  );
  if (!(available > 0)) return collapsed;
  // Порядок жертв: меньший вес — первым. При равном весе первой уходит правая
  const order = groups
    .map((g, i) => ({ g, i }))
    .sort((a, b) => (a.g.weight - b.g.weight) || (b.i - a.i));
  for (const { g } of order) {
    if (total() <= available) break;
    collapsed.add(g.name);
  }
  return collapsed;
}

/**
 * Какие вкладки влезли в полосу.
 *
 * Не влезшие уходят под «▾» в её конце — так же, как кнопки разделов на панели
 * задач. Выбранная вкладка остаётся видимой всегда: она отвечает за то, что
 * человек видит под ней.
 */
export function fitTabs(
  names: string[], available: number, activeName: string, fileLabelW = 52,
): { shown: string[]; hidden: string[] } {
  const width = (n: string) => 7 * n.length + 22;
  const MORE_W = 30;
  let left = available - fileLabelW;
  const shown: string[] = [];
  const hidden: string[] = [];
  for (const n of names) {
    const w = width(n);
    if (w <= left) { shown.push(n); left -= w; } else hidden.push(n);
  }
  if (hidden.length) {
    // Место под «▾» отбираем у последней влезшей
    left -= MORE_W;
    while (left < 0 && shown.length > 1) {
      const dropped = shown.pop() as string;
      hidden.unshift(dropped);
      left += width(dropped);
    }
    // Выбранная вкладка обязана быть видна
    if (activeName && hidden.includes(activeName) && shown.length) {
      const back = shown.pop() as string;
      hidden.unshift(back);
      shown.push(activeName);
      hidden.splice(hidden.indexOf(activeName), 1);
    }
  }
  return { shown, hidden };
}

// ── Меню «Файл» ────────────────────────────────────────────────────────────
// Не вкладка, а экран: здесь живут действия, которые нельзя нажать случайно.
// Описание тоже данными — по той же причине, что и лента.

export interface FileMenuItem {
  label: string;
  hint?: string;
  icon?: string;
  /** Причина недоступности; пусто — доступен */
  disabled?: string;
  run: () => void;
}

export interface FileMenuSection {
  name: string;
  items: FileMenuItem[];
}

/** Все органы вкладки подряд — для проверок и поиска команды по имени */
export function organsOf(tab: RibbonTab): Organ[] {
  return tab.groups.flatMap((g) => g.organs);
}

/** Найти орган по команде во всей ленте */
export function findOrgan(tabs: RibbonTab[], id: string): Organ | null {
  for (const t of tabs) for (const o of organsOf(t)) if (o.id === id) return o;
  return null;
}
