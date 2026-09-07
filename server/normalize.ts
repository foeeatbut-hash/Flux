// ── Общий словарь нормализации (Фаза 4 «Импорт бланков 2.0», §5 дизайна) ──
// Один источник правды для чисел и единиц: используется импортом, планом
// импорта и Конструктором, чтобы одинаковые данные из разных бланков сходились.
// Работает в Node (сервер) без внешних зависимостей.

// Число из русской/европейской записи: «1 250,5», «0,50», «1250.5 мм» → 1250.5.
// Возвращает null для нечисловых строк.
export function parseRuNumber(v: any): number | null {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v ?? '').replace(/[\s ]/g, '').replace(',', '.').match(/^-?\d+(\.\d+)?/);
  return s ? parseFloat(s[0]) : null;
}

// «1250» (число как строка) vs «230/400 В» (составное) — истинное число только
// если вся значимая часть строки — число (для типизации ячеек и сравнений)
export function isPlainNumber(v: any): boolean {
  if (typeof v === 'number') return isFinite(v);
  const s = String(v ?? '').replace(/[\s ]/g, '').replace(',', '.');
  return s !== '' && /^-?\d+(\.\d+)?$/.test(s);
}

// ── Канонизация ЕДИНИЦ (только нотация одной и той же величины) ──
// «м3/ч», «m3/h», «куб.м/ч» → «м³/ч». Значение НЕ пересчитывается и единица НЕ
// конвертируется в другую (кПа остаётся кПа) — тихие конверсии в инженерных
// данных недопустимы (§5.3 дизайна, авто-конверсия отвергнута).
const UNIT_CANON: { canon: string; forms: string[] }[] = [
  { canon: 'м³/ч', forms: ['м3/ч', 'м³/ч', 'm3/h', 'м3/час', 'м³/час', 'куб.м/ч', 'куб.м/час', 'нм3/ч', 'm³/h'] },
  { canon: 'м³',   forms: ['м3', 'м³', 'm3', 'куб.м', 'куб.метр'] },
  { canon: 'м²',   forms: ['м2', 'м²', 'm2', 'кв.м'] },
  { canon: 'м/с',  forms: ['м/с', 'm/s', 'м/сек'] },
  { canon: 'л/с',  forms: ['л/с', 'l/s', 'л/сек'] },
  { canon: 'л/ч',  forms: ['л/ч', 'l/h', 'л/час'] },
  { canon: 'л',    forms: ['л', 'l', 'литр'] },
  { canon: 'мм',   forms: ['мм', 'mm'] },
  { canon: 'см',   forms: ['см', 'cm'] },
  { canon: 'м',    forms: ['м', 'm', 'метр'] },
  { canon: 'Па',   forms: ['па', 'pa'] },
  { canon: 'кПа',  forms: ['кпа', 'kpa'] },
  { canon: 'МПа',  forms: ['мпа', 'mpa'] },
  { canon: 'бар',  forms: ['бар', 'bar'] },
  { canon: 'мм.вод.ст.', forms: ['мм.вод.ст', 'мм.вод.ст.', 'ммвс', 'ммводст', 'мм вод.ст.'] },
  { canon: 'кВт',  forms: ['квт', 'kw', 'kвт'] },
  { canon: 'МВт',  forms: ['мвт', 'mw'] },
  { canon: 'Вт',   forms: ['вт', 'w'] },
  { canon: 'кВт·ч', forms: ['квт*ч', 'квтч', 'kwh', 'квт·ч'] },
  { canon: 'А',    forms: ['а', 'a', 'ампер'] },
  { canon: 'В',    forms: ['в', 'v', 'вольт'] },
  { canon: 'кВ',   forms: ['кв', 'kv'] },
  { canon: 'Гц',   forms: ['гц', 'hz'] },
  { canon: 'об/мин', forms: ['об/мин', 'об/м', 'об.мин', 'rpm', 'об_мин'] },
  { canon: '°C',   forms: ['°c', 'c', '°с', 'с', 'град', 'градc', 'градс', 'degc'] },
  { canon: 'K',    forms: ['к', 'k', 'кельвин'] },
  { canon: '%',    forms: ['%', 'проц'] },
  { canon: 'кг',   forms: ['кг', 'kg'] },
  { canon: 'г',    forms: ['г', 'g', 'гр'] },
  { canon: 'т',    forms: ['т', 't', 'тонн'] },
  { canon: 'кг/ч', forms: ['кг/ч', 'kg/h', 'кг/час'] },
  { canon: 'кг/м³', forms: ['кг/м3', 'кг/м³', 'kg/m3'] },
  { canon: 'дБ(А)', forms: ['дб(а)', 'дба', 'db(a)', 'dba'] },
  { canon: 'дБ',   forms: ['дб', 'db'] },
  { canon: 'шт',   forms: ['шт', 'шт.', 'pcs', 'ед'] },
  { canon: 'мин',  forms: ['мин', 'min'] },
  { canon: 'ч',    forms: ['ч', 'час', 'h'] },
  { canon: 'с',    forms: ['сек', 'с', 'sec', 's'] },
];

// Быстрый индекс нормализованной формы → каноническая (первое вхождение выигрывает)
const UNIT_INDEX = new Map<string, string>();
for (const { canon, forms } of UNIT_CANON) {
  for (const f of forms) {
    const key = f.toLowerCase().replace(/[\s ]/g, '');
    if (!UNIT_INDEX.has(key)) UNIT_INDEX.set(key, canon);
  }
}

/**
 * Знает ли словарь такую единицу. Нужна разбору таблиц: колонка «Ед. изм.»
 * узнаётся по содержимому, а не по подписи. Раньше у разбора Excel был свой
 * список единиц, и он расходился с этим — одна и та же «л/ч» в одном месте
 * считалась единицей, в другом нет.
 */
export function isKnownUnit(u: string): boolean {
  const raw = String(u ?? '').trim();
  if (!raw) return false;
  const key = raw.toLowerCase().replace(/[\s ]/g, '').replace(/\.$/, '');
  return UNIT_INDEX.has(key) || UNIT_INDEX.has(key + '.');
}

export function canonicalUnit(u: string): string {
  const raw = String(u ?? '').trim();
  if (!raw) return '';
  const key = raw.toLowerCase().replace(/[\s ]/g, '').replace(/\.$/, '');
  const hit = UNIT_INDEX.get(key) || UNIT_INDEX.get(key + '.');
  return hit || raw; // незнакомую единицу оставляем как есть
}

// ── Лёгкая основа русского слова (для сопоставления «похожих» ключей) ──
// Отрезает частые окончания; без внешних библиотек. Используется для поиска
// синонимов параметров при создании алиасов.
const RU_ENDINGS = ['ами', 'ями', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ах', 'ях', 'ам', 'ям', 'ов', 'ев', 'ой', 'ый', 'ий', 'ая', 'яя', 'ое', 'ее', 'ы', 'и', 'а', 'я', 'о', 'е', 'у', 'ю', 'ь'];
export function wordStem(w: string): string {
  let s = String(w || '').toLowerCase().trim();
  for (const end of RU_ENDINGS) {
    if (s.length > end.length + 2 && s.endsWith(end)) return s.slice(0, -end.length);
  }
  return s;
}

// Нормализованный ключ параметра для сравнения на похожесть (основы слов)
export function normalizeKey(key: string): string {
  return String(key || '')
    .toLowerCase()
    .replace(/[.,;:()«»"']/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(wordStem)
    .sort()
    .join(' ');
}
