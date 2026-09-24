/**
 * Модель Каталога оборудования — общий договор окна и сервера.
 *
 * Каталог живёт в программе, а не в проекте: он один на всех и растёт по
 * классам оборудования. Первый класс — клапаны; дальше вентиляторы, решётки и
 * всё, что подбирается в Конструкторе. Поэтому модель не знает ни одного
 * клапанного слова — они живут в данных класса (catalog/valve/*).
 *
 * Каталог производителя описывает изделие не таблицей, а строкой обозначения:
 * `КПУ-1Н-О-В-1000*800-2*ф-ЭПВ24-СН-КК-0-0-0-0-0`. Каждая позиция строки —
 * параметр со своим списком кодов, а между позициями действуют правила
 * («ВН только со стеновым», «ЭМП только в общепромышленном исполнении»).
 * Поэтому семейство здесь — не набор колонок, а три вещи: позиции обозначения,
 * параметры с допустимыми кодами и правила между ними. Из этих трёх частей
 * мастер строит шаги, подбор — варианты, а бланк — строку «Наименование».
 *
 * Модуль чистый: ни React, ни express, ни Node — его читают окно, сервер и
 * наборы проверок (scripts/test-catalog-*.ts).
 */

export type Lang = 'ru' | 'en';

/** Подпись на двух языках. Английской может не быть — тогда берётся русская */
export interface Text2 {
  ru: string;
  en?: string;
}

export const t2 = (ru: string, en?: string): Text2 => (en ? { ru, en } : { ru });

export function textOf(t: Text2 | string | undefined | null, lang: Lang = 'ru'): string {
  if (!t) return '';
  if (typeof t === 'string') return t;
  return (lang === 'en' ? t.en || t.ru : t.ru) || '';
}

/**
 * Признаки изделия — общий язык описания, подбора и правил.
 *
 * Описание из MTO («Fire damper… EI 60… normally open… 24 V DC») разбирается в
 * признаки, коды каталога несут такие же признаки (`МН24` — это
 * {actuator:'reversible', voltage:24, brand:'НЕМАН'}), и подбор сравнивает
 * одно с другим. Какие признаки бывают, объявляет класс (`FactDef`): словарь
 * описания и затравка каталога обязаны говорить на языке своего класса.
 *
 * `kind` и `shape` общие для всех классов: род изделия внутри класса и форма
 * сечения — по ним подбор отсекает заведомо чужие семейства.
 */
export type FactValue = string | number | boolean | undefined;
export type Facts = Record<string, FactValue>;

/** Объявление признака класса: как он называется и какие значения бывают */
export interface FactDef {
  key: string;
  label: Text2;
  type: 'bool' | 'number' | 'choice' | 'text';
  unit?: string;
  values?: Array<{ code: string; label: Text2 }>;
  /** Признак важен для подбора: противоречие по нему отбрасывает семейство */
  hard?: boolean;
  /** Вес признака при подборе (по умолчанию 1) */
  weight?: number;
  /**
   * Числовой признак — «не меньше требуемого»: огнестойкость EI 90 закрывает
   * требование EI 60. Так бланки и делались: MTO просит EI 60, а ставится
   * КПУ-1Н с EI 90, потому что меньшего в каталоге нет
   */
  atLeast?: boolean;
}

/**
 * Класс оборудования: клапаны, вентиляторы, решётки…
 *
 * Класс объявляет свой язык признаков и свои коды типа в теге. Семейства,
 * компоненты и шаблоны бланков привязываются к классу, поэтому новый класс
 * добавляется данными — без правки подбора и конструктора.
 */
export interface EquipmentClass {
  id: string;
  /** Короткий код класса: valve, fan… */
  code: string;
  title: Text2;
  /** Как называется одна позиция: «клапан», «вентилятор» */
  itemName: Text2;
  /** Значок lucide по имени — окно само подставит картинку */
  icon?: string;
  facts: FactDef[];
  sort?: number;
}

/** Код позиции обозначения: то, что пишется в строку */
export interface ParamValue {
  code: string;
  label: Text2;
  /** Что значит этот код — для подбора по описанию и для правил */
  facts?: Facts;
  /** Как этот код ещё называют в описаниях: «НО», «нормально открытый», «normally open» */
  synonyms?: string[];
  note?: string;
  /** Код из старой редакции каталога: разбирается, но в новые клапаны не предлагается */
  deprecated?: boolean;
}

export type ParamKind = 'choice' | 'number' | 'text';

export interface ParamDef {
  key: string;
  label: Text2;
  kind: ParamKind;
  values?: ParamValue[];
  /** Код по умолчанию (для choice) или число */
  default?: string | number;
  unit?: string;
  hint?: string;
  /** Параметр размера: W — ширина, H — высота, D — диаметр */
  size?: 'W' | 'H' | 'D';
  /** Шаг мастера, в котором параметр спрашивается */
  step?: WizardStep;
  min?: number;
  max?: number;
}

export type WizardStep = 'purpose' | 'size' | 'fire' | 'execution' | 'drive' | 'options';

export const WIZARD_STEPS: Array<{ id: WizardStep; title: Text2 }> = [
  { id: 'purpose', title: t2('Назначение', 'Purpose') },
  { id: 'size', title: t2('Размер', 'Size') },
  { id: 'fire', title: t2('Огнестойкость и тип', 'Fire rating & type') },
  { id: 'execution', title: t2('Исполнение', 'Execution') },
  { id: 'drive', title: t2('Привод', 'Actuator') },
  { id: 'options', title: t2('Опции', 'Options') },
];

/**
 * Позиция строки обозначения.
 *
 * `formats` — как позиция пишется, шаблоном с параметрами в фигурных скобках:
 * `{purpose}`, `{W}*{H}`, `{driveCount}*{driveEx}{drive}`. Вариантов может быть
 * несколько: прямоугольный клапан пишет `{W}*{H}`, круглый — `{D}`; переходник
 * пишется `{adapterN}*{adapterD}` или кодом `1*000`. При сборке берётся первый
 * вариант, у которого заданы все параметры, при разборе пробуются все.
 */
export interface Position {
  key: string;
  label: Text2;
  formats: string[];
  /** Позицию можно пропустить целиком (в каталоге она бывает не всегда) */
  optional?: boolean;
  /**
   * Обе записи позиции законны, и какую выбрать — решает не программа:
   * привод КЕДР пишут и «1*SM24-S2-V», и «SM24-S2-V». Разобранная запись
   * запоминается (значение `~позиция`) и при сборке повторяется, иначе
   * пересборка молча меняла бы строку, уже согласованную с заводом
   */
  rememberFormat?: boolean;
}

/** Ключ значения, в котором хранится выбранная запись позиции */
export const formatKey = (position: string) => `~${position}`;

// ── Правила ─────────────────────────────────────────────────────────────────

/** Условие: над значениями параметров, размерами и признаками выбранных кодов */
export interface Cond {
  all?: Cond[];
  any?: Cond[];
  not?: Cond;
  /** Параметр (или W/H/D) */
  param?: string;
  /** Значение параметра из списка */
  in?: Array<string | number>;
  /** Параметр задан / не задан */
  set?: boolean;
  /** Сравнение для чисел */
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  /** Признак выбранных кодов: {fact:'ex', eq:true} */
  fact?: string;
  eq?: string | number | boolean;
  /** Форма сечения */
  shape?: 'rect' | 'round';
}

/**
 * Правило каталога. Проверяется одно и то же с двух сторон: мастер серит
 * недопустимые коды с причиной, проверка ведомости сообщает об ошибке.
 *
 * Вид правила — в поле `then`:
 *  - allow  — параметр при условии принимает только эти коды;
 *  - forbid — эти коды при условии запрещены;
 *  - range  — размер при условии в пределах min/max, с шагом или рядом;
 *  - require — параметр при условии обязателен;
 *  - warn   — не ошибка, а предупреждение (сверить с заводом).
 */
export interface Rule {
  id: string;
  when?: Cond;
  then:
    | { allow: { param: string; values: string[] } }
    | { forbid: { param: string; values: string[] } }
    | { range: { param: 'W' | 'H' | 'D'; min?: number; max?: number; step?: number; series?: number[] } }
    | { require: { param: string } }
    | { warn: string };
  message: string;
  /** Где в каталоге это сказано: «стр. 13» — чтобы инженер мог сверить */
  source?: string;
}

/**
 * Профиль подбора: чем семейство отличается от соседей.
 *
 * Подбор не угадывает по названию — он сравнивает признаки. Здесь записано,
 * какие признаки семейство обслуживает (kinds/functions), без каких его не
 * бывает (require), что его исключает (exclude), и косвенные приметы — код типа
 * в теге (DF, DN…) и префикс кода продукции из MTO (VVFIP…).
 */
export interface MatchProfile {
  kinds: string[];
  functions?: string[];
  shapes?: Array<'rect' | 'round'>;
  require?: Facts;
  exclude?: Facts;
  prefer?: Facts;
  tagTypes?: string[];
  productPrefixes?: string[];
  keywords?: string[];
  /** Поправка к весу: у «универсального» семейства ниже, чтобы узкое побеждало при равенстве */
  bias?: number;
}

/** Значения блока характеристик бланка по умолчанию: «материал», «класс утечки»… */
export interface SpecDefault {
  key: string;
  label: Text2;
  value: Text2;
  unit?: string;
  /** Значение зависит от выбранного кода: {when, value} — первое подходящее */
  cases?: Array<{ when: Cond; value: Text2 }>;
}

export interface CatalogRef {
  file: string;
  pages?: string;
  edition?: string;
}

export type FamilyStatus = 'full' | 'partial' | 'draft';

/** Семейство изделий: КПУ-1Н, ГЕРМИК-С, ТЮЛЬПАН-1… */
export interface Family {
  id: string;
  /** Класс оборудования (EquipmentClass.id) */
  classId: string;
  manufacturerId: string;
  /** Код семейства, как он стоит в начале обозначения */
  code: string;
  title: Text2;
  /** Короткое описание назначения */
  description?: Text2;
  /** Род изделия внутри класса: у клапанов fire, air, check… */
  kind: string;
  /** Тип для бланка: «Клапан противопожарный», «Обратный клапан»… */
  typeLabel: Text2;
  shapes: Array<'rect' | 'round'>;
  params: ParamDef[];
  positions: Position[];
  rules: Rule[];
  match: MatchProfile;
  specs: SpecDefault[];
  /** Признаки семейства в целом: огнестойкость, давление и т.п. */
  facts?: Facts;
  /** Разделитель размера при выводе: `*` (каталог) или `х` (бланки) */
  sizeSep?: string;
  /** Старые обозначения и другие имена семейства */
  aliases?: string[];
  catalog?: CatalogRef;
  status: FamilyStatus;
  /** Что сверить с каталогом, если статус не full */
  todo?: string[];
  /** Эталонные обозначения — круговая проверка справочника */
  examples?: string[];
  version?: number;
  sort?: number;
}

export interface Manufacturer {
  id: string;
  name: string;
  shortName: string;
  country?: string;
  standard?: string;
  notes?: string;
}

/** Комплектующее: привод, коробка, кабельный ввод, обогрев */
export interface Component {
  id: string;
  classId: string;
  kind: 'actuator' | 'box' | 'gland' | 'heater' | 'frame' | 'other';
  code: string;
  title: Text2;
  manufacturer?: string;
  facts?: Facts;
  specs?: Array<{ label: Text2; value: string; unit?: string }>;
}

/** Правило тега: код типа в теге → что это за изделие */
export interface TagRule {
  id: string;
  classId: string;
  /** Код типа в теге: DF, DS, DV… */
  code: string;
  label: Text2;
  facts: Facts;
  /** Не клапан (решётки, диффузоры): строки с этим кодом импорт пропускает */
  skip?: boolean;
  /** Как из тега клапана получить тег привода: DF → DFD */
  actuatorCode?: string;
}

// ── Конфигурация одного клапана ─────────────────────────────────────────────

/** Значения параметров: коды выбора и числа размеров */
export type ValveValues = Record<string, string | number>;

export interface ValveConfig {
  familyId: string;
  values: ValveValues;
}

/** Каталог целиком — то, что приходит в окно одним запросом */
export interface Catalog {
  classes: EquipmentClass[];
  manufacturers: Manufacturer[];
  families: Family[];
  components: Component[];
  tagRules: TagRule[];
}

export function paramOf(f: Family, key: string): ParamDef | undefined {
  return f.params.find((p) => p.key === key);
}

export function valueOf(f: Family, key: string, code: string | number | undefined): ParamValue | undefined {
  if (code === undefined || code === '') return undefined;
  return paramOf(f, key)?.values?.find((v) => v.code === String(code));
}

/** Форма по заданным размерам: диаметр — круглый, иначе прямоугольный */
export function shapeOf(values: ValveValues): 'rect' | 'round' | undefined {
  if (num(values.D) > 0) return 'round';
  if (num(values.W) > 0 || num(values.H) > 0) return 'rect';
  return undefined;
}

export function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/** Признаки выбранных кодов, сведённые вместе (позже заданное перекрывает) */
export function factsOfConfig(f: Family, values: ValveValues): Facts {
  const out: Facts = { ...(f.facts || {}), kind: f.kind };
  for (const p of f.params) {
    if (p.kind !== 'choice') continue;
    const v = valueOf(f, p.key, values[p.key]);
    if (v?.facts) Object.assign(out, v.facts);
  }
  const shape = shapeOf(values);
  if (shape) out.shape = shape;
  return out;
}

/** Значения по умолчанию, дополненные заданными */
export function withDefaults(f: Family, values: ValveValues): ValveValues {
  const out: ValveValues = {};
  for (const p of f.params) {
    if (p.default !== undefined && p.default !== '') out[p.key] = p.default;
  }
  for (const [k, v] of Object.entries(values)) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}
