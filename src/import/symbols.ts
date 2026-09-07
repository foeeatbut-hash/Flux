// ── Справочник условных обозначений бланков ──────────────────────────────────
// В инженерных бланках величина подписана не словом, а символом: «L = 5000 м³/ч»,
// «N = 1,5 кВт», «n = 1450 об/мин». Одна и та же буква значит разное:
//   L, м³/ч → расход воздуха, а L, мм → длина;
//   N (заглавная) → мощность, а n (строчная) → частота вращения;
//   Q, кВт → тепловая мощность, а Q, м³/ч → расход.
// Поэтому величина определяется ТРОЙКОЙ «символ + регистр + единица», а не буквой.
//
// Стартовый набор лежит здесь, правки отдела — в базе (AppSetting, как алиасы
// Конструктора) и подмешиваются через setSymbolRules. Модуль — лист: ничего не
// импортирует, поэтому его видят и словарь, и распознаватель, и проверки.

export interface SymbolRule {
  /** Символ так, как он написан в бланке: «L», «N», «n», «ΔP», «Pполн» */
  symbol: string;
  /** Величина: id поля словаря (FieldDef.id) */
  field: string;
  /** Человеческая подпись для карточки: «Расход воздуха», «Частота вращения» */
  label: string;
  /**
   * Единицы, при которых правило срабатывает (в любом написании — сравнение
   * идёт по свёрнутой форме). Пустой список = «подходит к любой единице»:
   * такое правило берётся, только если по единице не нашлось точного.
   */
  units?: string[];
  /**
   * Регистр важен: N — мощность, n — обороты. По умолчанию не важен,
   * потому что в большинстве бланков регистр случаен.
   */
  caseSensitive?: boolean;
}

// ── Стартовый набор ──────────────────────────────────────────────────────────
// Данные, не логика: строку сюда добавляет инженер, а не программист.
export const BASE_SYMBOLS: SymbolRule[] = [
  // Расход
  { symbol: 'L', field: 'airflow', label: 'Расход воздуха', units: ['м³/ч', 'м3/ч', 'л/с', 'м³/с', 'м3/с'] },
  { symbol: 'Q', field: 'airflow', label: 'Расход', units: ['м³/ч', 'м3/ч', 'л/с'] },
  { symbol: 'V', field: 'airflow', label: 'Расход воздуха', units: ['м³/ч', 'м3/ч'] },
  { symbol: 'G', field: 'massflow', label: 'Массовый расход', units: ['кг/ч', 'кг/с', 'т/ч'] },
  { symbol: 'Gв', field: 'waterflow', label: 'Расход теплоносителя', units: ['л/с', 'м³/ч', 'м3/ч', 'л/ч'] },

  // Давление
  { symbol: 'P', field: 'pressure', label: 'Давление', units: ['Па', 'кПа', 'бар', 'мм вод ст'] },
  { symbol: 'Pполн', field: 'pressure', label: 'Полное давление', units: ['Па', 'кПа'] },
  { symbol: 'Pст', field: 'pressure', label: 'Статическое давление', units: ['Па', 'кПа'] },
  { symbol: 'Pсеть', field: 'pressure', label: 'Давление сети', units: ['Па', 'кПа'] },
  { symbol: 'Pс', field: 'pressure', label: 'Давление сети', units: ['Па', 'кПа'] },
  { symbol: 'ΔP', field: 'pressure', label: 'Потери давления', units: ['Па', 'кПа', 'бар', 'мм вод ст'] },
  { symbol: 'H', field: 'pressure', label: 'Напор', units: ['Па', 'кПа', 'мм вод ст'] },

  // Электрика: единственное место, где регистр решает
  { symbol: 'N', field: 'power', label: 'Мощность', units: ['кВт', 'Вт', 'кВА'], caseSensitive: true },
  { symbol: 'n', field: 'rpm', label: 'Частота вращения', units: ['об/мин', 'rpm'], caseSensitive: true },
  { symbol: 'Nу', field: 'power', label: 'Установленная мощность', units: ['кВт', 'Вт'] },
  { symbol: 'Ny', field: 'power', label: 'Установленная мощность', units: ['кВт', 'Вт'] },
  { symbol: 'U', field: 'voltage', label: 'Напряжение', units: ['В', 'кВ'] },
  { symbol: 'I', field: 'current', label: 'Ток', units: ['А'] },

  // Тепло
  { symbol: 'Q', field: 'heatpower', label: 'Тепловая мощность', units: ['кВт', 'Вт', 'ккал/ч'] },
  { symbol: 'Qт', field: 'heatpower', label: 'Тепловая мощность', units: ['кВт', 'Вт', 'ккал/ч'] },
  { symbol: 't', field: 'temp', label: 'Температура', units: ['°C', 'C', 'К'] },

  // Конструкция
  { symbol: 'L', field: 'length', label: 'Длина', units: ['мм', 'см', 'м'] },
  { symbol: 'B', field: 'length', label: 'Ширина', units: ['мм', 'см', 'м'] },
  { symbol: 'b', field: 'length', label: 'Ширина', units: ['мм', 'см', 'м'] },
  { symbol: 'H', field: 'length', label: 'Высота', units: ['мм', 'см', 'м'] },
  { symbol: 'h', field: 'length', label: 'Высота', units: ['мм', 'см', 'м'] },
  { symbol: 'D', field: 'size', label: 'Диаметр', units: ['мм', 'см'] },
  { symbol: 'Ø', field: 'size', label: 'Диаметр', units: ['мм', 'см'] },
  { symbol: 'DN', field: 'size', label: 'Условный проход', units: ['мм'] },
  { symbol: 'Ду', field: 'size', label: 'Условный проход', units: ['мм'] },
  { symbol: 'M', field: 'weight', label: 'Масса', units: ['кг', 'г', 'т'] },
  { symbol: 'Мсум', field: 'weight', label: 'Масса', units: ['кг', 'т'] },
  { symbol: 'm', field: 'weight', label: 'Масса', units: ['кг', 'г', 'т'] },

  // Прочее
  { symbol: 'v', field: 'speed', label: 'Скорость', units: ['м/с'] },
  { symbol: 'w', field: 'speed', label: 'Скорость', units: ['м/с'] },
  { symbol: 'Lp', field: 'noise', label: 'Уровень звукового давления', units: ['дБ', 'дБ(А)'] },
  { symbol: 'LpA', field: 'noise', label: 'Уровень звукового давления', units: ['дБ', 'дБ(А)'] },
];

// ── Правки отдела ────────────────────────────────────────────────────────────
// Приходят с сервера общим списком (см. /api/import/symbols). Правило отдела
// перекрывает стартовое с тем же символом+единицей — свой бланк важнее общего.
let EXTRA: SymbolRule[] = [];

export function setSymbolRules(rules: SymbolRule[] | undefined | null): void {
  EXTRA = Array.isArray(rules) ? rules.filter(r => r && r.symbol && r.field) : [];
  INDEX = null;
}

export function symbolRules(): SymbolRule[] {
  return [...EXTRA, ...BASE_SYMBOLS];
}

// ── Свёртка написаний ────────────────────────────────────────────────────────

/** Единица к сравниваемому виду: «м3/ч», «M3/H», «м³/ч.» → «м3/ч» */
export function foldUnit(u: string): string {
  return String(u ?? '')
    .toLowerCase()
    .replace(/³/g, '3').replace(/²/g, '2')
    .replace(/[\s .]/g, '')
    .replace(/[()]/g, '');
}

// Латинские двойники кириллицы в символах: «Р» (кириллица) в «Рполн» — это «P».
const LOOKALIKE: Record<string, string> = {
  'А': 'A', 'В': 'B', 'С': 'C', 'Е': 'E', 'Н': 'H', 'К': 'K', 'М': 'M',
  'О': 'O', 'Р': 'P', 'Т': 'T', 'Х': 'X',
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x',
};

/**
 * Символ к сравниваемому виду. Регистр СОХРАНЯЕТСЯ (N ≠ n), убираются только
 * пробелы, точки и кириллические двойники латинских букв. «Δ» и «d» в приросте
 * давления — одно и то же: ΔP, dP, DP, Δp сходятся в один ключ.
 */
export function foldSymbol(s: string): string {
  const t = String(s ?? '').trim().replace(/[\s  .]/g, '').replace(/^[Δ∆]/, 'd');
  return [...t].map(ch => LOOKALIKE[ch] ?? ch).join('');
}

/** Похоже ли на условное обозначение, а не на слово: «L», «ΔP», «Nу», «Pполн» */
export function looksLikeSymbol(s: string): boolean {
  const t = String(s ?? '').trim().replace(/[\s.]/g, '');
  if (!t || t.length > 8) return false;
  if (/\d/.test(t)) return false;
  // Первый знак — буква или Δ/Ø, дальше — короткий индекс
  return /^[A-Za-zА-Яа-яΔØ][A-Za-zА-Яа-я]{0,5}$/.test(t);
}

// ── Разрешение ───────────────────────────────────────────────────────────────

export interface SymbolMatch {
  /** id поля словаря */
  field: string;
  /** человеческая подпись */
  label: string;
  /** символ, как он был написан в бланке */
  symbol: string;
  /** единица решила однозначно (иначе — догадка по единственному правилу) */
  byUnit: boolean;
  /** другие величины того же символа — повод спросить инженера в предпросмотре */
  rivals?: { field: string; label: string }[];
}

// Индекс: свёрнутый символ (и его строчная форма) → правила
type Index = { exact: Map<string, SymbolRule[]>; loose: Map<string, SymbolRule[]> };
let INDEX: Index | null = null;

function index(): Index {
  if (INDEX) return INDEX;
  const exact = new Map<string, SymbolRule[]>();
  const loose = new Map<string, SymbolRule[]>();
  for (const r of symbolRules()) {
    const key = foldSymbol(r.symbol);
    if (!key) continue;
    (exact.get(key) ?? exact.set(key, []).get(key)!).push(r);
    if (!r.caseSensitive) {
      const lk = key.toLowerCase();
      (loose.get(lk) ?? loose.set(lk, []).get(lk)!).push(r);
    }
  }
  INDEX = { exact, loose };
  return INDEX;
}

function lookup(key: string): SymbolRule[] {
  const idx = index();
  const out = [...(idx.exact.get(key) ?? [])];
  for (const r of idx.loose.get(key.toLowerCase()) ?? []) {
    if (!out.includes(r)) out.push(r);
  }
  return out;
}

// Символ с индексом: «Lв» (воздуха), «Pвс» (всасывание), «dpсеть», «Nдв».
// Индекс отбрасываем и величину берём у корня, но корень должен быть коротким
// (1–2 знака), иначе обычное слово случайно сойдёт за обозначение.
interface Found { rules: SymbolRule[]; suffix: string }

function findRules(symbol: string): Found {
  const key = foldSymbol(symbol);
  if (!key) return { rules: [], suffix: '' };
  const direct = lookup(key);
  if (direct.length) return { rules: direct, suffix: '' };
  for (const n of [2, 1]) {
    if (key.length <= n) continue;
    const hit = lookup(key.slice(0, n));
    if (hit.length) return { rules: hit, suffix: key.slice(n) };
  }
  return { rules: [], suffix: '' };
}

/** Правила, подходящие символу (с учётом регистра там, где он важен) */
export function rulesForSymbol(symbol: string): SymbolRule[] {
  return findRules(symbol).rules;
}

const rival = (r: SymbolRule) => ({ field: r.field, label: r.label });

/**
 * Величина по тройке «символ + регистр + единица».
 * Возвращает null, если символа нет в справочнике.
 *
 * Единица решает: «L, м³/ч» → расход, «L, мм» → длина. Без единицы величина
 * берётся, только если у символа одно значение; иначе возвращается первое,
 * но со списком соперников — предпросмотр обязан спросить инженера.
 */
export function resolveSymbol(symbol: string, unit?: string): SymbolMatch | null {
  const found = findRules(symbol);
  const all = found.rules;
  if (!all.length) return null;
  const raw = String(symbol ?? '').trim();
  const u = foldUnit(unit || '');
  // Индекс длиннее одного знака различает параметры одной величины
  // (dpсеть.вс и dpсеть.нг — разные потери): сохраняем его в подписи,
  // иначе оба параметра схлопнутся в одну строку «Потери давления».
  const name = (r: SymbolRule) => (found.suffix.length >= 2 ? `${r.label} (${raw})` : r.label);

  if (u) {
    const byUnit = all.filter(r => (r.units || []).some(x => foldUnit(x) === u));
    if (byUnit.length) {
      const rivals = byUnit.slice(1).filter(r => r.field !== byUnit[0].field).map(rival);
      return {
        field: byUnit[0].field, label: name(byUnit[0]), symbol: raw, byUnit: true,
        ...(rivals.length ? { rivals } : {}),
      };
    }
    // Единица известна, но ни одно правило её не знает: символ подсказать не может
    const free = all.filter(r => !r.units || r.units.length === 0);
    if (!free.length) return null;
    return { field: free[0].field, label: name(free[0]), symbol: raw, byUnit: false };
  }

  const fields = new Set(all.map(r => r.field));
  if (fields.size === 1) {
    return { field: all[0].field, label: name(all[0]), symbol: raw, byUnit: false };
  }
  // Символ без единицы, а величин несколько — это вопрос инженеру, а не догадка
  return {
    field: all[0].field, label: name(all[0]), symbol: raw, byUnit: false,
    rivals: all.slice(1).filter(r => r.field !== all[0].field).map(rival),
  };
}

/** Символ с единицей в подписи: «L, м³/ч», «N (кВт)» → { symbol, unit } */
export function splitSymbolUnit(raw: string): { symbol: string; unit: string } {
  const t = String(raw ?? '').trim();
  const m = t.match(/^(.{1,8}?)\s*[,(]\s*([^,()]{1,14}?)\s*\)?\s*$/);
  if (m && looksLikeSymbol(m[1])) return { symbol: m[1].trim(), unit: m[2].trim() };
  return { symbol: t, unit: '' };
}
