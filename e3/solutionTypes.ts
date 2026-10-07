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

export interface E3SolutionBook {
  version: number;
  solutions: E3Solution[];
  features: E3Feature[];
  dictionary: E3Dictionary;
  rules: E3FeatureRule[];
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
