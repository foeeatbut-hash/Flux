/**
 * Типы справочника типовых решений E3 (docs/e3-integration.md, раздел 5).
 *
 * Отдельным файлом, чтобы разбор, подбор и сервер читали одни и те же типы, не
 * тянув друг друга. Снаружи всё берётся из `e3/solutions.ts`.
 */
import type { E3FieldKey } from './attributes';

/** Типовое решение: готовый блок схемы E3 (.e3p) */
export interface E3Solution {
  /** «08.01.38» — ключ: по нему решение находится при повторной загрузке файла */
  id: string;
  mainClass: string;
  subclass: string;
  /** Краткое обозначение («К») */
  short: string;
  /** Название схемы = имя блока в базе E3 */
  name: string;
  description: string;
  pdf: string;
  e3p: string;
  twoLevel: boolean;
  /** «Есть в САПР» — справка, выгрузку не ограничивает */
  inCad: boolean;
  items: string;
  symbols: string;
  note: string;
  /** Ответы на признаки класса: id признака → значение */
  features: Record<string, string>;
  /** Человек просмотрел разбор названия и согласен с ним */
  featuresConfirmed: boolean;
  /** Правили руками: загрузка файла такие поля не перезаписывает */
  edited?: boolean;
  /** Снято загрузкой («нет в файле → снять»); физически не удаляется */
  removed?: boolean;
  /**
   * Ручной состав блока: если задан, он сильнее правил IO (`ioRules`). Настройка
   * Flux — загрузка файла её не трогает, как и признаки.
   */
  recipeOverride?: E3RecipeLine[];
}

/** Откуда берётся ответ: подбор ОВ, решение КИП по проекту, раскладка листа */
export type E3FeatureKind = 'ov' | 'profile' | 'layout';

/** Признак: вопрос с вариантами ответа, общий для решений одного класса */
export interface E3Feature {
  /** Латиницей через точку: `valve.drive` — id одинаковых по смыслу признаков разных классов различаются */
  id: string;
  mainClass: string;
  title: string;
  values: string[];
  kind: E3FeatureKind;
  hint: string;
  /** Ответ, когда в названии решения признака нет («нет», «без»). Пусто — признак обязан быть назван */
  absent?: string;
}

/** Словарь сокращений: код → описание */
export type E3Dictionary = Record<string, string>;

/** Что читать у позиции Flux, чтобы получить значение для правила */
export type E3RuleSource =
  | { kind: 'field'; key: E3FieldKey }
  | { kind: 'param'; name: string; unit?: string }
  /** Число подпозиций роли у позиции: приводов у клапана, вентиляторов в блоке */
  | { kind: 'count'; role: string }
  | { kind: 'child-param'; role: string; name: string; unit?: string }
  | { kind: 'child-field'; role: string; key: E3FieldKey };

/**
 * Правило: «как из данных позиции получить ответ на признак». `when` — значение
 * целиком (числа сравниваются как числа) или `~часть` (содержит); первое
 * совпадение выигрывает. Признак `@class` выбирает основной класс там, где тип
 * Flux отвечает двум (вентилятор / вентилятор ЕС).
 */
export interface E3FeatureRule {
  mainClass: string;
  featureId: string;
  source: E3RuleSource;
  table: { when: string; answer: string }[];
  /** Ответ, если ни одна строка таблицы не подошла или у позиции нет данных */
  otherwise?: string;
}

/** Профиль: порог вида «до 7,5 кВт — ПП, больше — ПЧИ» */
export interface E3ProfileThreshold {
  source: E3RuleSource;
  steps: { upTo: number; answer: string }[];
  above: string;
}
/** Профиль автоматизации проекта: id признака → ответ или порог */
export type E3Profile = Record<string, string | E3ProfileThreshold>;

// ── Таблица IO и рецепт блока (docs/e3-integration.md, 5.4 и 5.9) ───────────

/** Число сигналов по видам: дискретные и аналоговые, входы и выходы */
export interface E3IoSignals { di: number; do: number; ai: number; ao: number }

/**
 * Строка листа «Таблица IO»: вид устройства и сколько сигналов он даёт БПУ.
 * Поля из файла (группа, наименование, обозначение, числа, описания) обновляет
 * загрузка; `component` — необязательная справка (имя изделия E3), настройка Flux:
 * в файле её нет, и файл её не трогает. Таблица нужна для счёта сигналов.
 */
export interface E3IoRow extends E3IoSignals {
  /** Стабильный ключ из группы и наименования (`ioRowId`): по нему строка находится при повторной загрузке */
  id: string;
  group: string;
  name: string;
  /** «Обозначение»: PT, TS… — у части строк пусто */
  code: string;
  notes: { di: string; do: string; ai: string; ao: string };
  /** Необязательная справка: имя изделия E3. Блок в E3 называется по решению, а не по строке IO */
  component?: string;
  /** Поля из файла правили руками: загрузка файла их не перезапишет */
  edited?: boolean;
}

/** Как правило находит строку IO: пустые поля не проверяются, остальные должны совпасть */
export interface E3IoRowRef {
  /** Группа целиком («Приводы») */
  group?: string;
  /** Часть наименования («пружинный, с бк») */
  name?: string;
  /** Обозначение: сначала совпадение всего набора кодов, потом вхождение кода */
  code?: string;
}

/** Сколько изделий даёт правило */
export type E3IoCount =
  | { kind: 'one' }
  /** Число из признака решения («Число приводов», «Число ступеней»): n = min(cap, max(0, значение + offset)) */
  | { kind: 'feature'; feature: string; offset?: number; cap?: number }
  /** Число подпозиций роли у позиции Flux */
  | { kind: 'children'; role: string };

/** Условие правила: признак решения принимает одно из значений (или не принимает — `not`) */
export interface E3IoCond { feature: string; values: string[]; not?: boolean }

/**
 * Правило связи: «если решение класса X отвечает на признаки так, в блоке стоит
 * изделие по этой строке IO столько раз». Правила — данные книги: правятся в
 * каталоге, стартовый набор — `e3/ioDefaults.ts`.
 */
export interface E3IoRule {
  /** Ключ правила (латиницей через точку), по нему правило правится и ищется при «Добавить недостающее» */
  id: string;
  title: string;
  mainClass: string;
  when: E3IoCond[];
  /** Роль изделия в блоке («Привод», «Двигатель») */
  role: string;
  row: E3IoRowRef;
  count: E3IoCount;
  /** Подпозиция Flux, которой отвечает каждое изделие: у клапана с двумя приводами — ПРИВОД № 1 и № 2 */
  fromRole?: string;
}

/** Строка ручного состава: изделие по строке IO, столько-то штук */
export interface E3RecipeLine { role: string; row: E3IoRowRef; count: number; fromRole?: string }

export interface E3RecipeItem {
  role: string;
  ioRowId?: string;
  /** Необязательная справка из строки IO: имя изделия E3. Что вставлять, она не решает — это имя решения */
  component?: string;
  fromPosition?: { role: string; index: number };
  signals: E3IoSignals;
  /** Почему изделие в блоке: какое правило и какие ответы его вызвали */
  why: string;
}

export interface E3Recipe {
  solutionId: string;
  /** Имя блока в базе E3: название схемы решения — оно и есть единица вставки (решение владельца) */
  block: string;
  items: E3RecipeItem[];
  total: E3IoSignals;
  issues: string[];
}

export interface E3IoPlan {
  added: number;
  changed: { id: string; fields: string[] }[];
  same: number;
  /** Есть в каталоге, нет в файле: остаются */
  missing: string[];
  /** Поля правили руками, файл их поменял бы — оставлены */
  editedKept: string[];
  /** Замечания к самому листу уходят в `issues` плана, здесь только счёт */
}

export interface E3SolutionBook {
  version: number;
  solutions: E3Solution[];
  features: E3Feature[];
  dictionary: E3Dictionary;
  rules: E3FeatureRule[];
  /** Лист «Таблица IO»: сигналы по видам устройств */
  ioTable: E3IoRow[];
  /** Правила «решение и признаки → строки IO» */
  ioRules: E3IoRule[];
  /** Тип Flux (equipment/classes) → основные классы файла */
  classMap: Record<string, string[]>;
  updatedAt: string;
  updatedById?: string;
}

export interface E3SolutionPlan {
  added: E3Solution[];
  changed: { id: string; fields: string[]; before: E3Solution; after: E3Solution }[];
  same: number;
  /** Есть в каталоге, нет в файле */
  missing: string[];
  /** Правились руками, а файл их поменял бы — оставлены как есть */
  editedKept: string[];
  /** Словарь: новые коды, и коды, у которых описание в файле другое (в каталоге оставлено своё) */
  dictionaryAdded: string[];
  dictionaryDiffers: string[];
  /** Лист «Таблица IO»: есть только если файл его принёс */
  io?: E3IoPlan;
  issues: string[];
}

/** Позиция проекта для подбора: данные приходят готовыми, модуль чистый */
export interface E3Position {
  id: string;
  /** Тип Flux (equipment/classes) */
  cls: string;
  role?: string;
  tag?: string;
  parentTag?: string;
  /** Значение по источнику `field` или `param`; пусто — нет данных */
  read: (source: E3RuleSource) => string;
  /** Ответы раскладки листа, если они известны */
  layout?: Record<string, string>;
}

export type E3AnswerFrom = 'manual' | 'ov' | 'profile' | 'layout';
export interface E3Answer { feature: string; value: string; from: E3AnswerFrom }
export interface E3Selection {
  status: 'one' | 'many' | 'none';
  solution?: E3Solution;
  candidates: E3Solution[];
  answers: E3Answer[];
  /** Признак, на который нет ответа и по которому кандидаты различаются: его и надо спросить */
  missingFeature?: string;
  /** Ни одного решения: ближайшие и чем они отличаются */
  nearest: { solution: E3Solution; diff: { feature: string; want: string; have: string }[] }[];
}
