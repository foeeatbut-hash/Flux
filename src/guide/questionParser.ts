/**
 * Разбор вопроса сотрудника без нейросети (ТЗ v3 §9).
 *
 * Pipeline: предобработка → сущности и фильтры → намерение. Парсер НЕ ходит на
 * сервер и не решает сам, что делать: он отдаёт структурированный запрос, а
 * engine.ts (и за ним сервер) валидируют и исполняют. При неоднозначности
 * парсер честно говорит «неоднозначно», а не выбирает первый попавшийся объект.
 */
import { stripPoliteness, fixKeyboardLayout } from '../assistant/inputRepair';
import { parse, stem } from '../assistant/nlp';

// ── Словари: типизированные, корректируемые (ТЗ §9.1) ──

export interface FieldType {
  canonical: string;
  keys: string[];
  units: string[];
  stems: string[];
  /** Тип величины: только для него разрешён пересчёт единиц (ТЗ §11.5) */
  quantity?: 'airflow' | 'pressure' | 'power';
}

/** Характеристики: словарь привязан к классу оборудования и нормализованным единицам. */
export const FIELDS: FieldType[] = [
  { canonical: 'Расход воздуха', keys: ['расход', 'расход воздуха', 'производительность'], units: ['м³/ч', 'л/с'], stems: ['расход', 'производительн'], quantity: 'airflow' },
  { canonical: 'Полное давление', keys: ['полное давление', 'давление', 'напор'], units: ['Па', 'кПа'], stems: ['давлени', 'напор'], quantity: 'pressure' },
  { canonical: 'Питание', keys: ['питание', 'электропитание', 'напряжение питания'], units: ['В'], stems: ['питани', 'напряжени'] },
  { canonical: 'Класс фильтра', keys: ['класс фильтра', 'класс'], units: [''], stems: ['класс'] },
  { canonical: 'Мощность', keys: ['мощность', 'электрическая мощность'], units: ['кВт', 'Вт'], stems: ['мощност'], quantity: 'power' },
];

export interface EquipmentType { canonical: string; category: string; stems: string[] }

/** Классы оборудования: разговорные формы → каноничный тип. Корни без окончания:
 *  «приточ» покрывает приточку/приточки/приточек/приточная. */
export const EQUIPMENT_TYPES: EquipmentType[] = [
  { canonical: 'ПРИТОЧНАЯ УСТАНОВКА', category: 'AHU', stems: ['приточ', 'приточная установка'] },
  { canonical: 'ВЕНТИЛЯТОР', category: 'FAN', stems: ['вентилятор', 'венттяж', 'улитк', 'вытяж'] },
  { canonical: 'КЛАПАН', category: 'VALVE', stems: ['клапан', 'заслонк'] },
  { canonical: 'ФИЛЬТР', category: 'AHU', stems: ['фильтр'] },
  { canonical: 'ВОЗДУШНАЯ ЗАВЕСА', category: 'CURTAIN', stems: ['завес'] },
];

export interface NumericFilter { value: number; op: '>' | '<' | '>=' | '<=' | '=' }

export interface ParsedQuestion {
  raw: string;
  normalized: string;
  /** Точные коды тегов: сохраняются как ввели, без «исправлений» (ТЗ §9) */
  codes: string[];
  fields: FieldType[];
  equipmentTypes: EquipmentType[];
  /** Имя системы/установки: П1, В2, К1 — для уточнения неоднозначности (ТЗ §8.2) */
  systemNames: string[];
  tokens: string[];
  stems: string[];
  intent: QuestionIntent;
  numeric?: NumericFilter;
  unit?: string;
  /** Продолжение вопроса: «их», «а только без тегов», «выгрузи» — контекст прошлого ответа */
  isFollowUp: boolean;
  /** Просьба перевести единицу: «в л/с» */
  convertTo?: string;
}

export type QuestionIntent =
  | 'tag_lookup'
  | 'tag_duplicates'
  | 'equipment_no_tag'
  | 'equipment_missing_field'
  | 'equipment_characteristic'
  | 'equipment_list'
  | 'project_count'
  | 'project_summary'
  | 'procurement_state'
  | 'equipment_revision'
  | 'document_search'
  | 'open_export'
  | 'knowledge_howto'
  | 'knowledge_where'
  | 'glossary'
  | 'troubleshoot'
  | 'open_section'
  | 'start_tour'
  | 'unknown';

const inc = (s: string, ...needles: string[]): boolean => needles.some((n) => s.includes(n));

/** Намерение по словам-сигналам: порядок = приоритет обработки (ТЗ §9).
 *  Сигналы ищутся в нормализованной строке, а не в стемах: «сколько», «покажи»
 *  и «без» — стоп-слова для поиска, но для намерения это ключевые слова. */
function detectIntent(normalized: string, codes: string[], fields: FieldType[], types: EquipmentType[]): QuestionIntent {
  // Точный тег — всегда важнее прочего: неправильный объект недопустим
  if (codes.length) {
    if (inc(normalized, 'дубл', 'повтор')) return 'tag_duplicates';
    // Файлы/документы по тегу — отдельное намерение (ТЗ §12.2, §12.7)
    if (inc(normalized, 'файл', 'документ', 'бланк', 'чертеж', 'паспорт')) return 'document_search';
    // Ревизия по тегу/позиции
    if (inc(normalized, 'ревиз', 'версия', 'история измен', 'что изменил', 'конфликт')) return 'equipment_revision';
    // «Какой расход у <тег>» — спрашивают значение, а не карточку целиком
    if (fields.length) return 'equipment_characteristic';
    return 'tag_lookup';
  }
  if (inc(normalized, 'что так', 'что значит', 'расшифруй')) return 'glossary';
  if (inc(normalized, 'дубл', 'повторн')) return 'tag_duplicates';
  if (inc(normalized, 'без тег', 'нет тег', 'непривяз', 'тег без')) return 'equipment_no_tag';
  if (inc(normalized, 'ревиз', 'версия у', 'какая версия', 'история измен', 'что изменилось', 'что поменялось', 'конфликт ревиз')) return 'equipment_revision';
  if (inc(normalized, 'файл', 'документ', 'бланк', 'чертеж', 'паспорт') && (codes.length || inc(normalized, 'у ', 'найди', 'покажи', 'какие', 'связан'))) return 'document_search';
  if (inc(normalized, 'не заполнен', 'не указан', 'пуст', 'нет значен', 'без расхода', 'без питания', 'без давления', 'без класс', 'без мощности')) return 'equipment_missing_field';
  // «Покажи, как …» — просят демонстрацию, а не список оборудования
  if (inc(normalized, 'покажи как', 'покажи действие', 'демонстрац', 'покажи на экране')) return 'start_tour';
  // Штатная выгрузка/ведомость (ТЗ §12.9, §16.2)
  if (inc(normalized, 'открой выгрузк', 'создай ведомост', 'сделай таблицу', 'сформируй список', 'сделай ведомост', 'ведомость по', 'таблица тегов', 'выгрузка по')) return 'open_export';
  if (fields.length && (inc(normalized, 'какой', 'покажи', 'найди', 'скажи', 'значение', 'у как', 'какое', 'расход', 'давлени', 'питани', 'класс', 'мощност') || inc(normalized, ' у ') || /\bу\s+\S/.test(normalized))) return 'equipment_characteristic';
  if (inc(normalized, 'скольк', 'числ ', 'итого')) {
    if (inc(normalized, 'заказ', 'закуп')) return 'procurement_state';
    if (types.length || inc(normalized, 'тег', 'установ', 'вентилятор', 'клапан', 'фильтр', 'компонент', 'систем', 'оборудован', 'моноблок', 'завес', 'файл', 'документ')) return 'project_count';
    return 'project_summary';
  }
  if (inc(normalized, 'сводк', 'статистик', 'общая картина', 'что в проекте', 'сколько всего')) return 'project_summary';
  if (inc(normalized, 'закуп', 'заказан', 'незаказан', 'поставщик', 'на каком этапе', 'этапе закуп')) return 'procurement_state';
  if (inc(normalized, 'покажи', 'список', 'какие', 'перечисли') && (types.length || inc(normalized, 'тег', 'оборудован', 'установ', 'файл', 'документ'))) return 'equipment_list';
  if (inc(normalized, 'открой', 'перейд', 'зайди', 'покажи раздел')) return 'open_section';
  if (inc(normalized, 'почему', 'ошибк', 'не работает', 'не проходит', 'не удается', 'не удалось', 'не читается', 'что делать')) return 'troubleshoot';
  if (inc(normalized, 'что так', 'что значит', 'зачем', 'расшифруй', 'что такое')) return 'glossary';
  if (inc(normalized, 'где')) return 'knowledge_where';
  if (inc(normalized, 'как')) return 'knowledge_howto';
  return 'unknown';
}

/** Продолжение вопроса: «их», «а только без тегов», «выгрузи», «сколько их» —
 *  намерение определяется по прошлому ответу (ТЗ §36.4). */
const FOLLOWUP_RE = /^(а|и|ну)?\s*(их|они|оно|него|нее|её|эти|только|сколько их|покажи их|выгрузи|в эксель|в excel|в слово|экспортируй|а сейчас|еще|снова)/i;

const UNIT_RE = /(м³\/ч|м3\/ч|м\^3\/ч|л\/с|па|кпа|квт|вт|н·м)/;
const CONVERT_RE = /(?:переведи|пересчитай|в единицах)?\s*(?:в|во)\s+(м³\/ч|м3\/ч|м\^3\/ч|л\/с)\b/;
/** Имя системы/установки: П1, В12, К3 — латиница или кириллица + номер. */
const SYSTEM_RE = /(?:^|\s)([пвк]|приточн\w*|вытяжн\w*)\s?(\d{1,2})\b/i;

export function parseQuestion(text: string): ParsedQuestion {
  const raw = String(text || '');
  // Раскладка и опечатки чинятся до разбора; коды тегов после этого остаются
  // прежними — repairTypos не трогает слова с цифрами и короткие коды
  const repaired = fixKeyboardLayout(stripPoliteness(raw.trim())) || raw;
  const normalized = repaired.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  // Разбор идёт по исходному регистру: коды тегов должны остаться ровно такими,
  // как ввели (латинская B и кириллическая В — разные коды, ТЗ §9)
  const p = parse(repaired);

  const fields = FIELDS.filter((f) => f.stems.some((st) => p.stems.some((s) => s.startsWith(st)) || normalized.includes(st)));

  const types: EquipmentType[] = [];
  for (const t of EQUIPMENT_TYPES) {
    const hit = p.stems.some((s) => t.stems.some((needle) => needle.trim() && (s.startsWith(needle.trim()) || s.includes(needle.trim()))))
      || t.stems.some((needle) => needle.trim() && normalized.includes(needle.trim()))
      || (t.canonical === 'ПРИТОЧНАЯ УСТАНОВКА' && /\bпу\b/.test(normalized));
    if (hit) types.push(t);
  }

  // Системы: «у П1», «в системе П1», «П2»
  const systemNames: string[] = [];
  for (const m of normalized.matchAll(new RegExp(SYSTEM_RE.source, 'gi'))) {
    const letter = (m[1] || '').trim().charAt(0).toUpperCase();
    const name = `${letter}${m[2]}`;
    if (!systemNames.includes(name)) systemNames.push(name);
  }

  // Число со знаком сравнения: «больше 1000», «менее 500», «не менее 2»
  let numeric: NumericFilter | undefined;
  const numMatch = /(?:больше|более|свыше)\s+(\d[\d\s]*)|(?:меньше|менее)\s+(\d[\d\s]*)|(?:не\s+менее|от)\s+(\d[\d\s]*)|(?:не\s+более|до)\s+(\d[\d\s]*)/.exec(normalized);
  if (numMatch) {
    if (numMatch[1]) numeric = { value: Number(numMatch[1].replace(/\s/g, '')), op: '>' };
    else if (numMatch[2]) numeric = { value: Number(numMatch[2].replace(/\s/g, '')), op: '<' };
    else if (numMatch[3]) numeric = { value: Number(numMatch[3].replace(/\s/g, '')), op: '>=' };
    else if (numMatch[4]) numeric = { value: Number(numMatch[4].replace(/\s/g, '')), op: '<=' };
  }
  const unitMatch = UNIT_RE.exec(normalized);
  const convertMatch = CONVERT_RE.exec(normalized);

  return {
    raw,
    normalized,
    codes: p.codes,
    fields,
    equipmentTypes: types,
    systemNames,
    tokens: p.tokens,
    stems: p.stems,
    intent: detectIntent(normalized, p.codes, fields, types),
    numeric,
    unit: unitMatch ? unitMatch[1] : undefined,
    isFollowUp: FOLLOWUP_RE.test(normalized) && normalized.split(/\s+/).length <= 6,
    convertTo: convertMatch ? convertMatch[1] : undefined,
  };
}

export { stem };
