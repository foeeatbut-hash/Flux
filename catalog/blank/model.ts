/**
 * Шаблон выходного бланка — то, что собирает Конструктор бланков.
 *
 * Бланки E06-2001…2003 делались копированием листов, и каждое копирование
 * приносило дефект: колонки «Ширина / Высота / Кол-во / TAG» съезжали между
 * листами (D/E у одних, E/F у других), номер бланк-заказа оставался от соседнего
 * листа, колонтитул — от прошлой ревизии, после удаления блока — `#REF!`.
 *
 * Поэтому шаблон — не лист Excel, а описание: какие листы, из каких блоков,
 * какие поля в каких колонках. Лист на каждое семейство собирается из одного
 * описания, и колонки у всех семейств одинаковы по построению, а номер
 * документа и ревизия в колонтитуле берутся из выпуска, а не из прошлого файла.
 *
 * Модуль чистый: окно рисует предпросмотр, Excel и PDF из одного и того же.
 */
import type { Text2 } from '../model';

export type BlankLang = 'ru' | 'en' | 'ru+en';

/**
 * Выражение: текст с полями в фигурных скобках и фильтрами через «|».
 * `{doc.orderNo}-{n}-КОМ`, `{item.tags|join: }`, `{spec.pressure|default:-}`.
 * Поля ищутся сначала в строке таблицы, потом в группе (лист), потом в
 * документе — так одно и то же `{family.code}` работает и в шапке, и в строке.
 */
export type Expr = string;

/** Подпись или выражение на двух языках: `{ ru: 'Кол-во', en: 'Qty' }` */
export type LabelText = Text2;

export interface TableColumn {
  id: string;
  title: LabelText;
  value: Expr;
  /** Сколько колонок сетки занимает */
  span: number;
  align?: 'left' | 'center' | 'right';
  /** Выпадающий список в Excel */
  options?: string[];
}

export interface FieldPair {
  id: string;
  label: LabelText;
  value: Expr;
}

export interface SpecRow {
  id: string;
  label: LabelText;
  value: Expr;
  unit?: LabelText;
  options?: string[];
}

interface BlockBase {
  id: string;
  /** Заголовок блока отдельной строкой: «Информация по электроприводу» */
  title?: LabelText;
  /** Показывать блок, только если выражение непустое: `{group.hasActuators}` */
  visibleIf?: Expr;
  /** Разрыв страницы перед блоком */
  breakBefore?: boolean;
}

export type Block =
  | (BlockBase & { type: 'title'; text: LabelText; logo?: string; logoRight?: string; height?: number })
  | (BlockBase & { type: 'fields'; pairs: FieldPair[]; labelSpan: number; valueSpan: number })
  | (BlockBase & { type: 'table'; source: TableSource; columns: TableColumn[]; emptyText?: string })
  | (BlockBase & { type: 'specs'; rows: SpecRow[]; labelSpan: number; valueSpan: number; unitSpan: number })
  | (BlockBase & { type: 'text'; text: LabelText; tone?: 'normal' | 'note' | 'bold' })
  | (BlockBase & { type: 'signatures'; rows: FieldPair[] })
  | (BlockBase & { type: 'spacer'; rows?: number });

export type BlockType = Block['type'];

/**
 * Откуда строки таблицы:
 *  items     — позиции листа (клапаны);
 *  actuators — приводы позиций листа (по строке на позицию с приводом);
 *  heating   — обогрев позиций листа;
 *  revisions — история выпусков документа;
 *  families  — перечень листов (для титула: что в комплекте).
 */
export type TableSource = 'items' | 'actuators' | 'heating' | 'revisions' | 'families';

/** Как позиции раскладываются по листам */
export type SheetRepeat = 'none' | 'family' | 'family-exec';

export interface SheetTemplate {
  id: string;
  /** Имя листа — выражение: `{family.code}{group.execSuffix}` */
  name: Expr;
  repeat: SheetRepeat;
  blocks: Block[];
  /** Сквозные строки: сколько первых строк повторять на каждой странице */
  printTitleRows?: number;
}

export interface BlankStyle {
  font: string;
  size: number;
  titleSize: number;
  /** Заливка заголовков таблиц, шестнадцатеричный цвет без # */
  headFill: string;
  labelFill: string;
  border: 'thin' | 'none';
}

export interface PageSetup {
  paper: 'A4' | 'A3';
  orientation: 'portrait' | 'landscape';
  fitWidth: boolean;
  /** Поля, мм */
  margins: { top: number; bottom: number; left: number; right: number };
  /** Колонтитул: выражения; `{page}` и `{pages}` — номер и число страниц */
  footer: { left?: Expr; center?: Expr; right?: Expr };
  header?: { left?: Expr; center?: Expr; right?: Expr };
}

export interface BlankTemplate {
  version: 1;
  name: string;
  /** Класс оборудования, для которого шаблон (пусто — для любого) */
  classId?: string;
  /** Ширины колонок сетки в символах, как в Excel */
  columns: number[];
  style: BlankStyle;
  page: PageSetup;
  sheets: SheetTemplate[];
  /** Картинки шаблона (логотипы): id → data:URL */
  assets?: Record<string, string>;
}

// ── Сетка — результат отрисовки ─────────────────────────────────────────────

export type CellStyle = 'title' | 'section' | 'label' | 'value' | 'head' | 'cell' | 'cellC' | 'unit' | 'note' | 'bold' | 'sign' | 'plain';

export interface GridCell {
  r: number;
  c: number;
  v: string | number;
  s: CellStyle;
  /** Объединение: сколько строк и колонок */
  rs?: number;
  cs?: number;
  options?: string[];
  /** Блок шаблона, из которого ячейка — для щелчка в предпросмотре */
  block?: string;
}

export interface GridImage {
  r: number;
  c: number;
  cs: number;
  rs: number;
  src: string;
}

export interface SheetGrid {
  name: string;
  columns: number[];
  cells: GridCell[];
  rowCount: number;
  /** Высоты строк, пункты (оценка по длине текста) */
  rowHeights: Record<number, number>;
  breaks: number[];
  images: GridImage[];
  printTitleRows?: number;
  page: PageSetup;
  /** Колонтитул, уже с подставленными полями (кроме {page}/{pages}) */
  footer: { left: string; center: string; right: string };
  header: { left: string; center: string; right: string };
  style: BlankStyle;
}
