// Словарь распознавания: синонимы полей, типы оборудования, единицы измерения,
// валидация значений. Расширяется без изменения логики recognize.ts.

import { resolveSymbol } from './symbols';

export type ValueKind = 'number' | 'code' | 'text' | 'dims' | 'enum';

export interface FieldDef {
  id: string;
  /** Каноническая подпись для карточки оборудования */
  label: string;
  /** Куда идёт значение: свойство позиции или характеристика */
  target: 'name' | 'brand' | 'system' | 'qty' | 'spec' | 'tag';
  group: string;
  synonyms: string[];
  kind: ValueKind;
  units?: string[];
  /** Разумный диапазон для чисел — защита от мусора под якорем */
  range?: [number, number];
}

// Порядок синонимов не важен; сравнение идёт по нормализованной подписи (см. normalizeLabel)
export const FIELDS: FieldDef[] = [
  { id: 'name', label: 'Наименование', target: 'name', group: 'Общие',
    synonyms: ['наименование', 'название', 'изделие', 'оборудование', 'наименование оборудования', 'наименование изделия', 'позиция', 'предмет закупки', 'тип системы'],
    kind: 'text' },
  { id: 'brand', label: 'Марка', target: 'brand', group: 'Общие',
    synonyms: ['марка', 'тип', 'типоразмер', 'модель', 'артикул', 'обозначение', 'маркировка', 'марка типоразмер', 'тип модель', 'исполнение модель', 'индекс', 'назв'],
    kind: 'code' },
  { id: 'system', label: 'Система', target: 'system', group: 'Общие',
    synonyms: ['система', 'номер системы', 'обслуживаемая система', '系统'],
    kind: 'code' },
  // Технологическая позиция (тег) — не название и не марка: это адрес изделия
  // в проекте. В бланке их бывает несколько в одной ячейке через запятую или
  // с новой строки: один лист на пять одинаковых вентиляторов.
  { id: 'tag', label: 'Тег', target: 'tag', group: 'Общие',
    synonyms: ['тег', 'тэг', 'теговый номер', 'tag номер', 'номер тега', 'tag n', 'tag no', 'tag number',
      'технологическая позиция', 'позиционное обозначение', 'номер позиции', 'поз',
      'код системы', 'обозначение системы'],
    kind: 'code' },
  { id: 'qty', label: 'Количество', target: 'qty', group: 'Общие',
    synonyms: ['количество', 'кол во', 'кол-во', 'шт', 'число', 'колво'],
    kind: 'number', units: ['шт', 'компл'], range: [0.001, 1000000] },
  { id: 'manufacturer', label: 'Производитель', target: 'spec', group: 'Общие',
    synonyms: ['производитель', 'изготовитель', 'завод изготовитель', 'поставщик', 'фирма'],
    kind: 'text' },

  // ── Аэродинамика/гидравлика ──
  { id: 'airflow', label: 'Расход воздуха', target: 'spec', group: 'Аэродинамика',
    synonyms: ['расход', 'расход воздуха', 'производительность', 'производительность по воздуху', 'подача', 'воздухопроизводительность', 'объемный расход'],
    kind: 'number', units: ['м3/ч', 'м³/ч', 'л/с', 'тыс. м3/ч'], range: [1, 2000000] },
  { id: 'pressure', label: 'Давление', target: 'spec', group: 'Аэродинамика',
    synonyms: ['давление', 'напор', 'полное давление', 'статическое давление', 'располагаемое давление', 'потери давления', 'сопротивление'],
    kind: 'number', units: ['па', 'кпа', 'мм вод ст', 'бар'], range: [1, 100000] },
  { id: 'waterflow', label: 'Расход теплоносителя', target: 'spec', group: 'Гидравлика',
    synonyms: ['расход воды', 'расход теплоносителя', 'расход жидкости'],
    kind: 'number', units: ['л/с', 'м3/ч', 'кг/с', 'л/ч'], range: [0.001, 100000] },
  { id: 'massflow', label: 'Массовый расход', target: 'spec', group: 'Гидравлика',
    synonyms: ['массовый расход', 'расход по массе', 'производительность по массе'],
    kind: 'number', units: ['кг/ч', 'кг/с', 'т/ч'], range: [0.001, 1000000] },

  // ── Электрика ──
  { id: 'power', label: 'Мощность', target: 'spec', group: 'Электрика',
    synonyms: ['мощность', 'мощность двигателя', 'потребляемая мощность', 'установленная мощность', 'номинальная мощность', 'эл мощность', 'электрическая мощность'],
    kind: 'number', units: ['квт', 'вт'], range: [0.001, 10000] },
  { id: 'voltage', label: 'Напряжение', target: 'spec', group: 'Электрика',
    synonyms: ['напряжение', 'питание', 'напряжение питания', 'питающее напряжение', 'сеть'],
    kind: 'number', units: ['в', 'v', 'вольт'], range: [5, 1000] },
  { id: 'current', label: 'Ток', target: 'spec', group: 'Электрика',
    synonyms: ['ток', 'номинальный ток', 'рабочий ток', 'потребляемый ток'],
    kind: 'number', units: ['а', 'a'], range: [0.01, 5000] },
  { id: 'rpm', label: 'Частота вращения', target: 'spec', group: 'Электрика',
    synonyms: ['обороты', 'частота вращения', 'скорость вращения', 'число оборотов'],
    kind: 'number', units: ['об/мин', 'об мин', 'rpm'], range: [50, 50000] },

  // ── Тепло ──
  { id: 'heatpower', label: 'Тепловая мощность', target: 'spec', group: 'Тепло',
    synonyms: ['тепловая мощность', 'теплопроизводительность', 'холодопроизводительность', 'мощность нагрева', 'мощность охлаждения'],
    kind: 'number', units: ['квт', 'вт', 'ккал/ч'], range: [0.01, 50000] },
  { id: 'temp', label: 'Температура', target: 'spec', group: 'Тепло',
    synonyms: ['температура', 'температура среды', 'рабочая температура', 'температура теплоносителя', 'темп воздуха'],
    kind: 'number', units: ['°c', 'с', 'c', 'град'], range: [-100, 1200] },

  // ── Конструкция ──
  // «Длина» держит и высоту с шириной: в бланках это один вид величины
  // (линейный размер), а какой именно — говорит подпись, она и сохраняется.
  { id: 'length', label: 'Длина', target: 'spec', group: 'Конструкция',
    synonyms: ['длина', 'высота', 'ширина', 'глубина', 'длина корпуса', 'высота корпуса', 'ширина корпуса', 'длина блока'],
    kind: 'number', units: ['мм', 'см', 'м'], range: [0.1, 100000] },
  { id: 'dims', label: 'Габариты', target: 'spec', group: 'Конструкция',
    synonyms: ['габариты', 'размеры', 'габаритные размеры', 'размер', 'шхвхг', 'вхшхг', 'дхшхв', 'lxbxh'],
    kind: 'dims', units: ['мм', 'см', 'м'] },
  { id: 'size', label: 'Присоединительный размер', target: 'spec', group: 'Конструкция',
    synonyms: ['сечение', 'присоединительный размер', 'диаметр', 'ду', 'dn', 'условный проход', 'типоразмер сечения', 'присоединение'],
    kind: 'dims', units: ['мм'] },
  { id: 'weight', label: 'Масса', target: 'spec', group: 'Конструкция',
    synonyms: ['масса', 'вес', 'масса нетто', 'вес нетто'],
    kind: 'number', units: ['кг', 'г', 'т'], range: [0.01, 100000] },
  { id: 'material', label: 'Материал', target: 'spec', group: 'Конструкция',
    synonyms: ['материал', 'материал корпуса', 'корпус', 'исполнение корпуса'],
    kind: 'text' },
  { id: 'noise', label: 'Уровень шума', target: 'spec', group: 'Конструкция',
    synonyms: ['шум', 'уровень шума', 'звуковое давление', 'уровень звукового давления', 'шумовые характеристики'],
    kind: 'number', units: ['дб', 'дб(а)', 'дба'], range: [1, 200] },
  { id: 'filterclass', label: 'Класс фильтрации', target: 'spec', group: 'Конструкция',
    synonyms: ['класс фильтра', 'класс очистки', 'класс фильтрации', 'степень очистки'],
    kind: 'code' },
  { id: 'climate', label: 'Климатическое исполнение', target: 'spec', group: 'Конструкция',
    synonyms: ['климатическое исполнение', 'клим исполнение', 'климат исп', 'клим исп', 'климатическое исполнение гост'],
    kind: 'code' },
  { id: 'explosion', label: 'Взрывозащита', target: 'spec', group: 'Конструкция',
    synonyms: ['взрывозащита', 'взрывозащищенное исполнение', 'исполнение по взрывозащите'],
    kind: 'text' },
  { id: 'ip', label: 'Степень защиты', target: 'spec', group: 'Электрика',
    synonyms: ['степень защиты', 'ip', 'класс защиты'],
    kind: 'code' },
  { id: 'speed', label: 'Скорость воздуха', target: 'spec', group: 'Аэродинамика',
    synonyms: ['скорость', 'скорость воздуха', 'скорость в сечении'],
    kind: 'number', units: ['м/с', 'м/c'], range: [0.01, 100] },
];

// Типы оборудования: слово в тексте → equipType + категория раздела «Оборудование»
export interface EquipTypeDef { id: string; category: string; label: string; words: string[]; composite?: boolean }

export const EQUIP_TYPES: EquipTypeDef[] = [
  { id: 'ahu', category: 'AHU', label: 'Приточная установка', composite: true,
    words: ['приточная установка', 'приточно-вытяжная', 'вентиляционная установка', 'центральный кондиционер', 'пву', 'ahu', 'кондиционер центральный', 'вентустановка'] },
  { id: 'fan', category: 'FAN', label: 'Вентилятор',
    words: ['вентилятор', 'вентиляторы', 'fan'] },
  { id: 'valve', category: 'VALVE', label: 'Клапан',
    words: ['клапан', 'заслонка', 'воздушный клапан', 'противопожарный клапан', 'обратный клапан', 'кпу', 'valve'] },
  { id: 'curtain', category: 'CURTAIN', label: 'Воздушная завеса',
    words: ['завеса', 'воздушная завеса', 'тепловая завеса'] },
  { id: 'heater', category: 'AHU', label: 'Калорифер',
    words: ['калорифер', 'нагреватель', 'воздухонагреватель', 'охладитель', 'воздухоохладитель', 'теплообменник'] },
  { id: 'filter', category: 'AHU', label: 'Фильтр',
    words: ['фильтр', 'фильтры'] },
  { id: 'silencer', category: 'AHU', label: 'Шумоглушитель',
    words: ['шумоглушитель', 'глушитель'] },
  { id: 'recuperator', category: 'AHU', label: 'Рекуператор',
    words: ['рекуператор', 'роторный теплообменник', 'пластинчатый теплообменник'] },
  { id: 'pump', category: 'FAN', label: 'Насос',
    words: ['насос', 'насосы'] },
  { id: 'grille', category: 'VALVE', label: 'Решётка',
    words: ['решетка', 'решётка', 'диффузор', 'анемостат'] },
];

// Слова-маркеры мусорных блоков (шапки, подписи, реквизиты).
// «Лист 3» / «стр. 5» ловятся отдельным регэкспом в classifyParagraph,
// чтобы не задеть «Опросный лист на…».
export const GARBAGE_MARKERS = [
  'утвержда', 'соглас', 'подпись', 'расшифровка', 'должность', 'печать', 'реквизит',
  'страница', 'инн', 'кпп', 'огрн', 'р/с', 'бик',
];

// Административные поля бланков-заказов и опросных листов (включая двуязычные шапки
// CONTRACTOR/OWNER/VENDOR). Это реквизиты документа, а не характеристики оборудования —
// в карточку они не попадают. Проверяется по подписи поля.
export const ADMIN_LABEL_RE = new RegExp(
  '(заказчик|подрядчик|исполнитель|менеджер|выполнил|проверил|подготовил|утвердил|согласовал|разработал'
  + '|contractor|owner|vendor|checker|approved|prepared|buyer|purchase\\s*order|material\\s*requisition'
  + '|заказ на закупку|заказная спецификация|номер контракта|проекта подрядчика|описание установки'
  + '|document|документа|№ документа|опросного листа|№ опросного|ревиз|rev\\b|причина выпуска|reason for issue'
  + '|дата заявки|заявка|телефон|факс|fax|e-?mail|почта|адрес|код проверки|статус|status|acceptance'
  + '|plant\\b|описание изменения|название документа|title of document|бланк[- ]?заказ|объект|код здания'
  + '|входящий|record of revisions|учет ревизий|лист технических данных|подпись|signature|дата|date\\b'
  // «проект» — только само слово, без «проектная документация». Границу
  // задаём классом букв: \b в JavaScript кириллицу словом не считает, и
  // «проект\b» не совпадало ни с чем вообще — подпись «Проект» проходила мимо
  + '|организация|проект(?![а-яё])|project\\b|номер б/з|шифр|стадия)',
  'i'
);

// Подписи, из которых даже в административной шапке извлекается польза:
// технологическая позиция (тег) и производитель
// Здесь была та же ловушка, и она стоила дороже: «технологическ\w*» не
// совпадало с «технологическАЯ», потому что \w кириллицу не берёт, — то есть
// самая частая подпись в русских опросных листах не распознавалась никогда.
export const ADMIN_TAG_RE = /(tag\s*n|технологическ[а-яё]*\s*позици|код системы)/i;
export const ADMIN_VENDOR_RE = /(vendor|поставщик|производитель|изготовитель)/i;

/**
 * Качество текста: доля «нормальных» символов (кириллица/латиница/цифры/пунктуация).
 * Бинарный мусор, прочитанный как текст («Y4±)HJА%p¼×Ñ@…»), даёт низкое значение —
 * такие строки/страницы отбрасываются или уходят в OCR.
 */
export function textQuality(s: string): number {
  const t = (s || '').trim();
  if (!t) return 0;
  let good = 0;
  for (const ch of t) {
    if (/[а-яёА-ЯЁa-zA-Z0-9\s.,:;()\[\]{}\-+*/%№«»"'’=°³²×хx_·|!?&№@#™®]/u.test(ch)) good++;
  }
  return good / [...t].length;
}

/** Вырезает управляющие и заведомо мусорные символы из извлечённого текста */
export function sanitizeText(s: string): string {
  return (s || '')
    // управляющие (C0/C1), PUA, замещающий символ
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uE000-\uF8FF\uFFFD]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** «X X» (двуязычные бланки часто дублируют значение) → «X» */
export function dedupeRepeatedPhrase(s: string): string {
  const t = (s || '').trim();
  if (t.length < 6) return t;
  // Нечётная длина: середина — пробел, половинки равны
  if (t.length % 2 === 1) {
    const half = (t.length - 1) / 2;
    if (/\s/.test(t[half])) {
      const a = t.slice(0, half).trim();
      const b = t.slice(half + 1).trim();
      if (a && a === b) return a;
    }
  }
  return t;
}

// ── Формульные записи: «Lв=42860м³/ч; Pполн=250 Па; n=2130об/мин» ────────────
// Поле определяется ПО ЕДИНИЦЕ ИЗМЕРЕНИЯ (надёжнее, чем по символу:
// L=194 мм — длина, а Lв=140 м³/ч — расход). Символ остаётся в подписи.
const UNIT_TO_FIELD: { re: RegExp; fieldId: string }[] = [
  { re: /^(м3\/ч|м³\/ч|куб\.?\s*м\.?\/ч|м3\/час|l\/s|л\/с)$/i, fieldId: 'airflow' },
  { re: /^(па|кпа|pa)$/i, fieldId: 'pressure' },
  { re: /^(квт|вт|ква|kw|w)$/i, fieldId: 'power' },
  { re: /^(в|v|вольт)$/i, fieldId: 'voltage' },
  { re: /^(а|a)$/i, fieldId: 'current' },
  { re: /^(об\/мин|rpm)$/i, fieldId: 'rpm' },
  { re: /^(кг|kg|т)$/i, fieldId: 'weight' },
  { re: /^(дб|дба|дб\(а\))$/i, fieldId: 'noise' },
  { re: /^(°c|гр\.?c|c|с)$/i, fieldId: 'temp' },
  { re: /^(шт|компл)$/i, fieldId: 'qty' },
];

export interface FormulaParam {
  label: string; value: string; unit: string; fieldId?: string;
  /** подпись уже человеческая (из справочника обозначений) — не заменять */
  named?: boolean;
}

/**
 * Разбирает формульную строку бланка: «Lв=140 куб.м./ч; Pполн=250 Па, n=2130об/мин».
 * Возвращает параметры с полем, определённым по единице. Не-формульные строки → [].
 */
export function parseFormulaLine(line: string): FormulaParam[] {
  const out: FormulaParam[] = [];
  // Делим по ; и по запятой, если после неё идёт новый «символ=» (а не десятичная часть)
  const chunks = line.split(/;|,(?=\s*[A-Za-zА-Яа-яёΔ∆Ø][A-Za-zА-Яа-яё0-9_*.№]{0,12}\s*=)/);
  for (const chunk of chunks) {
    // Символ: буква (в т.ч. Δ, Ø) плюс индекс — кириллический тоже («Pполн»,
    // «dpсеть», «Nтэн»). \w кириллицу не берёт, поэтому класс выписан явно:
    // из-за этого целые строки бланка раньше не разбирались вовсе.
    // Значение может быть составным: «23150/14240» (приток/вытяжка), «4*35.1».
    const m = chunk.match(/^\s*([A-Za-zА-Яа-яёΔ∆Ø][A-Za-zА-Яа-яё0-9_*.№\s]{0,14}?)\s*=\s*[~≈]?\s*(-?[\d\s.,]+(?:\s*[/*x×]\s*-?[\d\s.,]+)*)\s*(.*?)\s*$/);
    if (!m) {
      // Отдельный токен степени защиты: IP54
      const ip = chunk.match(/^\s*(IP\s?\d{2})\s*$/i);
      if (ip) out.push({ label: 'Степень защиты', value: ip[1].replace(/\s/g, '').toUpperCase(), unit: '' });
      continue;
    }
    const sym = m[1].trim();
    const value = m[2].trim().replace(/\s+/g, '');
    const unitRaw = (m[3] || '').trim().replace(/\.$/, '');
    if (!/\d/.test(value)) continue;
    if (unitRaw.length > 14 || unitRaw.split(/\s+/).length > 3) continue; // не формула, а текст
    const unitKey = unitRaw.toLowerCase().replace(/[\s.]/g, '');
    const unit = UNIT_ALIASES[unitKey] || unitRaw;
    // Величину решает тройка «символ + регистр + единица»: «L=80 мм» — длина,
    // «L=5000 м³/ч» — расход, «N» — мощность, «n» — обороты. Справочник
    // обозначений редактируется отделом (см. symbols.ts).
    const sm = resolveSymbol(sym, unit);
    const fieldId = sm?.field || UNIT_TO_FIELD.find(u => u.re.test(unitKey))?.fieldId;
    out.push({ label: sm?.label || sym, value, unit, fieldId, ...(sm ? { named: true } : {}) });
  }
  // Строка считается формульной, только если распознано ≥1 параметра с единицей/полем
  return out.some(p => p.fieldId || p.unit) ? out : [];
}

/** Номера страниц/листов: «Лист 3 из 8», «стр. 5» */
export const PAGE_MARKER_RE = /^(?:лист|стр|страница|page)\.?\s*№?\s*\d+/i;

// ── Нормализация ─────────────────────────────────────────────────────────────

/** Нормализация подписи поля для сравнения со словарём */
// Латинские двойники кириллицы (OCR/раскладка): «Рaсход» (смешанный) → «расход».
// Сворачиваем ТОЛЬКО в токенах, где уже есть кириллица, чтобы не трогать «IP», «DN», «rpm».
const HOMOGLYPH: Record<string, string> = {
  a: 'а', e: 'е', o: 'о', p: 'р', c: 'с', y: 'у', x: 'х', k: 'к', m: 'м', t: 'т', h: 'н', b: 'в', n: 'п',
};
function foldHomoglyphs(s: string): string {
  return s.split(' ').map(tok => {
    if (!/[а-я]/.test(tok) || !/[a-z]/.test(tok)) return tok; // не смешанный — не трогаем
    return tok.replace(/[a-z]/g, ch => HOMOGLYPH[ch] || ch);
  }).join(' ');
}

export function normalizeLabel(raw: string): string {
  let s = (raw || '').toLowerCase().replace(/ё/g, 'е');
  s = s.replace(/\(.*?\)/g, ' ');            // скобки с пояснениями
  s = s.split(/[,;]/)[0];                     // «Расход, м³/ч» → «Расход»
  s = s.replace(/[.:*№"«»]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = foldHomoglyphs(s);                      // латинские двойники кириллицы
  return s;
}

/** Похожие кириллические буквы → латиница (для кодов/марок) */
const CYR_TO_LAT: Record<string, string> = {
  'А': 'A', 'В': 'B', 'С': 'C', 'Е': 'E', 'Н': 'H', 'К': 'K', 'М': 'M',
  'О': 'O', 'Р': 'P', 'Т': 'T', 'Х': 'X', 'У': 'Y',
  'а': 'a', 'в': 'b', 'с': 'c', 'е': 'e', 'о': 'o', 'р': 'p', 'х': 'x', 'у': 'y', 'к': 'k', 'м': 'm', 'н': 'h', 'т': 't',
};

export function normalizeCode(raw: string): { value: string; changed: boolean } {
  const src = (raw || '').trim();
  // Меняем только если строка выглядит как код: есть цифра
  if (!/\d/.test(src)) return { value: src, changed: false };
  // Однозначно латинские (не имеют кириллических двойников) и однозначно кириллические буквы
  const distinctLat = /[DFGIJLNQRSUVWZdfgijlnqrsuvwz]/.test(src);
  const distinctCyr = /[БГДЖЗИЙЛПФЦЧШЩЪЫЬЭЮЯбгджзийлпфцчшщъыьэюя]/.test(src);
  // Чисто кириллическая марка (ВЕРОСА-670-УХЛ3) или смесь с явной кириллицей — не трогаем
  if (distinctCyr || !distinctLat) return { value: src, changed: false };
  let out = '';
  let changed = false;
  for (const ch of src) {
    if (CYR_TO_LAT[ch] !== undefined) { out += CYR_TO_LAT[ch]; changed = true; }
    else out += ch;
  }
  return { value: out, changed };
}

/** Число из строки документа: «5 000,5» → 5000.5; «тыс.» → ×1000. NaN, если не число */
export function parseNumber(raw: string): number {
  let s = (raw || '').toLowerCase().replace(/\s| /g, '');
  const thousands = /тыс/.test(raw.toLowerCase());
  s = s.replace(',', '.');
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return NaN;
  let n = parseFloat(m[0]);
  if (thousands) n *= 1000;
  return n;
}

const UNIT_ALIASES: Record<string, string> = {
  'м3/ч': 'м³/ч', 'м3/час': 'м³/ч', 'm3/h': 'м³/ч', 'куб.м/ч': 'м³/ч', 'м³/час': 'м³/ч',
  'квт': 'кВт', 'kw': 'кВт', 'вт': 'Вт', 'w': 'Вт',
  'па': 'Па', 'pa': 'Па', 'кпа': 'кПа',
  'об/мин': 'об/мин', 'обмин': 'об/мин', 'rpm': 'об/мин', 'об.мин': 'об/мин',
  'дб': 'дБ', 'дб(а)': 'дБ(А)', 'дба': 'дБ(А)',
  'кг': 'кг', 'г': 'г', 'т': 'т',
  'мм': 'мм', 'см': 'см', 'м': 'м',
  'в': 'В', 'v': 'В', 'вольт': 'В', 'а': 'А',
  '°c': '°C', 'гр.c': '°C', 'град': '°C', 'c': '°C', 'с': '°C',
  'л/с': 'л/с', 'л/ч': 'л/ч', 'шт': 'шт', 'компл': 'компл',
  // дополнительные написания единиц (помогают распознать единицу из подписи)
  'мм вод ст': 'мм вод ст', 'мм в.ст': 'мм вод ст', 'ммвс': 'мм вод ст',
  'кгс/м2': 'кгс/м²', 'кгс/м²': 'кгс/м²', 'ккал/ч': 'ккал/ч',
  'м3/с': 'м³/с', 'м/с': 'м/с', 'м/c': 'м/с',
  // Канонические написания тоже должны быть ключами: без этого «Расход, м³/ч»
  // единицу из подписи не отдавал, а «254м2» не делился на число и единицу
  'м³/ч': 'м³/ч', 'м³/с': 'м³/с', 'м3': 'м³', 'м³': 'м³', 'м2': 'м²', 'м²': 'м²',
  'кг/ч': 'кг/ч', 'кг/с': 'кг/с', 'т/ч': 'т/ч', 'кг/м3': 'кг/м³', 'кг/м³': 'кг/м³',
  'кдж/кг': 'кДж/кг', 'г/кг': 'г/кг', 'кв': 'кВ', 'гц': 'Гц', 'ква': 'кВА',
  'мвт': 'МВт', 'бар': 'бар', 'сек': 'с', 'л': 'л', 'мм.рт.ст': 'мм рт.ст.',
};

/** Отделяет единицу измерения от значения: «5000 м3/ч» → { num: '5000', unit: 'м³/ч' } */
export function splitValueUnit(raw: string): { value: string; unit: string } {
  const s = (raw || '').trim();
  // Составные значения: пары «приток/вытяжка» (23150/14240 м³/ч) и габариты
  // (1000x500, 70х50х1,75) — не дробим на «первое число + мусорная единица»
  const comp = s.match(/^(-?\d[\d\s\u00A0.,]*(?:\s*[/xх×*]\s*\d[\d\s\u00A0.,]*)+)(.*)$/i);
  if (comp) {
    const value = comp[1].replace(/[\s\u00A0]+/g, '');
    const tail = (comp[2] || '').trim().replace(/^[,;]\s*/, '');
    if (!tail) return { value, unit: '' };
    const tailKey = tail.toLowerCase().replace(/\.$/, '');
    if (UNIT_ALIASES[tailKey]) return { value, unit: UNIT_ALIASES[tailKey] };
    // Короткий безцифровой хвост («°C», «Па») — тоже единица
    if (tail.length <= 8 && !/\d/.test(tail) && tail.split(/\s+/).length <= 2) return { value, unit: tail };
    // Хвост — не единица (материал, покрытие и т.п.): вся строка — значение
    return { value: s, unit: '' };
  }
  const m = s.match(/^(-?[\d\s\u00A0.,]+(?:тыс\.?)?)\s*([^\d\s].*)?$/i);
  if (!m) return { value: s, unit: '' };
  const unitRaw = (m[2] || '').trim().toLowerCase().replace(/\.$/, '');
  const unit = UNIT_ALIASES[unitRaw] || (m[2] || '').trim();
  // Хвост явно не единица измерения — многословный текст или текст с цифрами
  // («ОЦ с покрытием», «х50х1,75 ОЦ…»): оставляем всю строку как значение
  if (unit && !UNIT_ALIASES[unitRaw] && (/\d/.test(unit) || unit.length > 12 || unit.split(/\s+/).length > 2)) {
    return { value: s, unit: '' };
  }
  return { value: m[1].trim(), unit };
}

/** Единица из подписи: «Расход воздуха, м³/ч» → м³/ч */
export function unitFromLabel(rawLabel: string): string {
  const m = (rawLabel || '').match(/[,(]\s*([^,()]+?)\s*\)?\s*$/);
  if (m) {
    const candidate = m[1].trim().toLowerCase();
    if (UNIT_ALIASES[candidate]) return UNIT_ALIASES[candidate];
  }
  // выученная единица для этой подписи
  const learned = LEARNED[normalizeLabel(rawLabel)];
  return learned?.unit || '';
}

// ── Сопоставление подписи со словарём ────────────────────────────────────────

/** Дешёвое расстояние Левенштейна (для слов до ~24 символов, порог 1) */
export function lev1(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la > lb) i++;
    else if (lb > la) j++;
    else { i++; j++; }
  }
  return edits + (la - i) + (lb - j) <= 1;
}

export interface LabelMatch { field: FieldDef; score: number; }

// ── Выученный словарь (авто-обучение по файлам Excel/Word и подтверждениям) ───
// Заполняется извне (setLearned) перед распознаванием: нормализованная подпись → поле.
export interface LearnedEntry { field: string; unit?: string; n?: number }
let LEARNED: Record<string, LearnedEntry> = {};
export function setLearned(map: Record<string, LearnedEntry> | undefined | null): void {
  LEARNED = map || {};
}

// Обратная карта: единица измерения → поле, если она однозначно указывает на одно поле
// (напр. «м³/ч» → airflow). Позволяет учить подписи, которых ещё нет в словаре.
let UNIQUE_UNIT_FIELD: Record<string, string> | null = null;
export function fieldByUniqueUnit(rawUnit: string): string | null {
  if (!rawUnit) return null;
  if (!UNIQUE_UNIT_FIELD) {
    const counts: Record<string, Set<string>> = {};
    for (const f of FIELDS) for (const u of (f.units || [])) {
      const key = u.toLowerCase();
      (counts[key] = counts[key] || new Set()).add(f.id);
    }
    UNIQUE_UNIT_FIELD = {};
    for (const [u, set] of Object.entries(counts)) if (set.size === 1) UNIQUE_UNIT_FIELD[u] = [...set][0];
  }
  return UNIQUE_UNIT_FIELD[rawUnit.toLowerCase()] || null;
}

/** Ищет поле словаря по подписи; null — подпись не наша */
export function matchLabel(rawLabel: string): LabelMatch | null {
  const label = normalizeLabel(rawLabel);
  if (!label || label.length < 2) return null;
  // Выученный синоним: точное совпадение нормализованной подписи — высокий приоритет
  const learned = LEARNED[label];
  if (learned) {
    const lf = FIELDS.find(ff => ff.id === learned.field);
    if (lf) return { field: lf, score: 95 + label.length };
  }
  let best: LabelMatch | null = null;
  for (const f of FIELDS) {
    for (const syn of f.synonyms) {
      let score = 0;
      if (label === syn) score = 100 + syn.length;
      else if (label.startsWith(syn + ' ') || label.endsWith(' ' + syn) || label.includes(' ' + syn + ' ')) score = 60 + syn.length;
      else if (syn.includes(' ') && label.includes(syn)) score = 55 + syn.length;
      else if (syn.length >= 5 && label.split(' ').some(w => lev1(w, syn))) score = 40 + syn.length;
      if (score > 0 && (!best || score > best.score)) best = { field: f, score };
    }
  }
  // Обобщающее обучение: если словарь не дал совпадения, пробуем выученные подписи
  // по-нечёткому (подстрока или ≤1 опечатка) — ловит варианты написания одного бланка.
  if (!best) {
    const firstTok = (s: string) => s.split(' ').find(w => w.length >= 5) || '';
    const labelTok = firstTok(label);
    let lBest: { field: FieldDef; score: number } | null = null;
    for (const key in LEARNED) {
      if (key.length < 4) continue;
      let hit = false;
      if (label.includes(key) || key.includes(label)) hit = true;
      else if (Math.abs(key.length - label.length) <= 1 && lev1(key, label)) hit = true;
      else if (labelTok && firstTok(key).slice(0, 5) === labelTok.slice(0, 5)) hit = true; // общий корень первого слова
      if (hit) {
        const lf = FIELDS.find(ff => ff.id === LEARNED[key].field);
        const sc = 50 + Math.min(key.length, 20);
        if (lf && (!lBest || sc > lBest.score)) lBest = { field: lf, score: sc };
      }
    }
    if (lBest) return lBest;
  }
  // Отсечка: слишком слабое совпадение на длинной постороннней подписи — не считаем
  if (best && best.score < 45 && label.length > 30) return null;
  return best;
}

/** Лёгкий стемминг: отрезает типовое окончание («завесу» и «завеса» → «завес») */
export function stemRu(w: string): string {
  if (w.length <= 4) return w;
  return w.replace(/(иями|ями|ами|ыми|ими|ой|ей|ый|ий|ая|яя|ое|ее|ую|юю|ом|ем|ах|ях|ов|ев|ам|ям|а|я|о|е|ь|у|ю|ы|и)$/,'');
}

/** Определение типа оборудования по тексту (название, заголовок секции).
 * Сравнение по основам слов — «завеса/завесу/завесы» распознаются одинаково. */
export function detectEquip(text: string): EquipTypeDef | null {
  const t = ' ' + (text || '').toLowerCase().replace(/ё/g, 'е') + ' ';
  let best: EquipTypeDef | null = null;
  let bestLen = 0;
  for (const e of EQUIP_TYPES) {
    for (const w of e.words) {
      if (w.length <= bestLen) continue;
      // Каждое слово словарной фразы должно встретиться в тексте как основа
      const tokens = w.split(' ');
      const allFound = tokens.every(tok => {
        const stem = stemRu(tok);
        if (stem.length < 3) return t.includes(' ' + tok);
        return t.includes(stem);
      });
      if (allFound) { best = e; bestLen = w.length; }
    }
  }
  return best;
}

/** Обозначение системы в тексте: П1, В-2, ПВ3, ДУ1... (не климат-код У3/УХЛ3) */
export function findSystem(text: string): string | null {
  const m = (text || '').match(/(?:^|[\s,(«])((?:ПВ|ДУ|ДВ|ПД|П|В)\s?-?\d{1,3})(?=[\s.,;)»]|$)/);
  if (!m) return null;
  const code = m[1].replace(/\s/g, '');
  // «В3»/«П2» рядом с «климат»/«УХЛ» — это исполнение, не система
  if (/УХЛ|клим|исполнени/i.test(text) && /^[ВУ]\d$/.test(code)) return null;
  return code;
}

/** Код марки/тега: латиница-цифры с разделителями, минимум одна цифра */
export const CODE_RE = /([A-Za-zА-Яа-я0-9]{1,}(?:[\-./\\][A-Za-zА-Яа-я0-9,]{1,}){1,})/g;

/**
 * Список технологических позиций из одной ячейки бланка:
 * «3700-C01-BL-001A, 3700-C01-BL-001B; …» и через перевод строки.
 * Один лист выпускается на несколько одинаковых изделий, у каждого свой тег —
 * поэтому ячейка почти никогда не содержит ровно один код.
 */
export function splitTagList(raw: string): string[] {
  // Разделителем бывает и перевод строки, и пробел: до этого места текст уже
  // прошёл чистку, где перевод строки стал пробелом, — если делить только по
  // запятой, «3700-D01-DS-002 3700-D01-DS-003» останется одним «тегом» длиной
  // в сорок семь знаков и пропадёт целиком. В настоящем теге пробелов нет.
  return String(raw ?? '')
    .split(/[,;\n\s]+/)
    .map(t => t.trim().replace(/[.,;]+$/, ''))
    .filter(t => t.length >= 3 && t.length <= 40 && /\d/.test(t) && /[-./]/.test(t));
}

export function looksLikeCode(s: string): boolean {
  const t = (s || '').trim();
  if (t.length < 3 || t.length > 40) return false;
  if (!/\d/.test(t)) return false;
  if (/\s{2,}/.test(t)) return false;
  return /^[A-Za-zА-Яа-я0-9\-./\\,()×xх ]+$/.test(t) && /[-./\\]/.test(t);
}

// ── Валидация значения по типу поля ──────────────────────────────────────────

export type ValidationVerdict = 'ok' | 'suspicious' | 'reject';

export function validateValue(f: FieldDef, value: string, unit: string): ValidationVerdict {
  const v = (value || '').trim();
  if (!v) return 'reject';
  switch (f.kind) {
    case 'number': {
      // Значение должно НАЧИНАТЬСЯ с числа: «ВР-80» под якорем «Расход» — мусор,
      // хотя parseNumber и вытащил бы из него «-80»
      if (!/^[~≈<>±]?\s*[-+]?\s*\d/.test(v)) return 'reject';
      const n = parseNumber(v);
      if (isNaN(n)) return 'reject';
      if (f.range && (n < f.range[0] || n > f.range[1])) return 'suspicious';
      return 'ok';
    }
    case 'dims': {
      // «400х400», «1000×500×300», «Ø315», просто число
      if (/^\s*[øΦф]?\s*\d+([xх×*]\d+){0,2}\s*(мм|см|м)?\s*$/i.test(v.replace(/\s/g, ''))) return 'ok';
      if (!isNaN(parseNumber(v))) return 'ok';
      return 'reject';
    }
    case 'code': {
      if (v.length > 60) return 'reject';
      if (/\d/.test(v) || v.length <= 25) return 'ok';
      return 'suspicious';
    }
    case 'text': {
      if (v.length > 200) return 'suspicious';
      return 'ok';
    }
    default:
      return 'ok';
  }
}
