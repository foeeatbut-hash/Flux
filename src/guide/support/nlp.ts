// Понимание русской речи для Flux Guide: основа слова (стеммер),
// допуск опечаток (Левенштейн), синонимы бытовой речи → термины программы.
// Полностью локально, без внешних библиотек.

// ── Стемминг: сведение словоформ к общей основе ──────────────────────────────
// Упрощённый Портер-подобный: срезаем типовые окончания. Цель не лингвистическая
// точность, а чтобы «вентиляторов/вентилятору/вентиляторы» → один корень.

const ADJ_ENDINGS = ['ыми', 'ими', 'его', 'ого', 'ему', 'ому', 'ая', 'яя', 'ое', 'ее', 'ый', 'ий', 'ой', 'ом', 'ем', 'ых', 'их', 'ую', 'юю', 'ые', 'ие'];
const NOUN_ENDINGS = ['иями', 'ями', 'ами', 'иях', 'ях', 'ах', 'ов', 'ев', 'ий', 'ие', 'ье', 'ем', 'ом', 'ам', 'ям', 'ах', 'ию', 'ью', 'ия', 'ье', 'а', 'я', 'о', 'е', 'у', 'ю', 'ы', 'и', 'ь', 'й'];
const VERB_ENDINGS = ['ила', 'ыла', 'ена', 'ейте', 'уйте', 'ите', 'или', 'ыли', 'ей', 'уй', 'ил', 'ыл', 'им', 'ем', 'ешь', 'нно', 'ать', 'ять', 'еть', 'уть', 'ешь', 'ишь', 'ю', 'ет', 'ют', 'ат', 'ят', 'ла', 'на', 'ть', 'но'];

export function stem(word: string): string {
  let w = word.toLowerCase().replace(/ё/g, 'е');
  if (w.length <= 4) return w;
  const tryStrip = (endings: string[], minLen: number) => {
    for (const e of endings) {
      if (w.length - e.length >= minLen && w.endsWith(e)) {
        w = w.slice(0, -e.length);
        return true;
      }
    }
    return false;
  };
  // Сначала прилагательные/причастия, затем глаголы, затем существительные
  tryStrip(ADJ_ENDINGS, 4) || tryStrip(VERB_ENDINGS, 4) || tryStrip(NOUN_ENDINGS, 3);
  // Убираем удвоенную «н» и мягкий знак на конце основы
  w = w.replace(/нн$/, 'н').replace(/ь$/, '');
  return w;
}

// ── Расстояние Левенштейна (порог опечаток) ──────────────────────────────────

export function levenshtein(a: string, b: string): number {
  const la = a.length, lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  if (Math.abs(la - lb) > 2) return 3; // дальше порога — не считаем точно
  let prev = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    const cur = [i];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[lb];
}

/** Основа-опечатка: совпадение с допуском (для слов ≥5 букв — 1 ошибка) */
export function fuzzyEqual(a: string, b: string): boolean {
  if (a === b) return true;
  const minLen = Math.min(a.length, b.length);
  if (minLen < 4) return false;
  const maxEdits = minLen >= 7 ? 2 : 1;
  return levenshtein(a, b) <= maxEdits;
}

// ── Синонимы бытовой речи → канонические термины программы ────────────────────
// Ключ (стем) → список канонических стемов, которые он должен активировать.

const SYNONYMS: Record<string, string[]> = {
  // оборудование
  'коробк': ['установк', 'аху', 'ahu'],
  'движок': ['двигател', 'мотор'],
  'моторчик': ['двигател'],
  'крыльчатк': ['вентилятор'],
  'улитк': ['вентилятор'],
  'калорифер': ['нагревател', 'теплообменник'],
  'обдув': ['вентилятор'],
  // закупки
  'просрочк': ['закупк', 'этап'],
  'заказ': ['закупк'],
  'купил': ['закупк'],
  'оплат': ['закупк'],
  'поставк': ['закупк', 'поставщик'],
  // проблемы
  'проблем': ['критичн', 'внимани', 'конфликт'],
  'ошибк': ['критичн', 'конфликт'],
  'косяк': ['критичн', 'дубл'],
  'неправильн': ['критичн', 'конфликт'],
  'красн': ['критичн'],
  // дубли
  'повтор': ['дубл'],
  'копи': ['дубл'],
  'одинаков': ['дубл'],
  // общее
  'штук': ['сколько', 'количеств'],
  'итог': ['сколько', 'сводк'],
  'всего': ['сколько'],
  'готовност': ['сводк', 'статус'],
  'сотрудник': ['пользовател'],
  'коллег': ['пользовател'],
};

/** Расширяет набор стемов синонимами (для поиска и распознавания намерения) */
export function expandSynonyms(stems: string[]): Set<string> {
  const out = new Set(stems);
  for (const s of stems) {
    const syn = SYNONYMS[s];
    if (syn) for (const x of syn) out.add(x);
    // частичное совпадение ключа синонима (напр. «коробки» → стем «коробк»)
    for (const key of Object.keys(SYNONYMS)) {
      if ((s.startsWith(key) || key.startsWith(s)) && s.length >= 4) {
        for (const x of SYNONYMS[key]) out.add(x);
      }
    }
  }
  return out;
}

// ── Стоп-слова и токенизация ─────────────────────────────────────────────────

const STOPWORDS = new Set([
  'покажи', 'показать', 'дай', 'мне', 'нужны', 'нужен', 'нужно', 'все', 'всё', 'весь',
  'вся', 'список', 'найди', 'найти', 'сколько', 'выгрузи', 'выведи', 'хочу', 'это',
  'и', 'в', 'на', 'по', 'для', 'с', 'со', 'про', 'есть', 'какие', 'какой', 'что',
  'a', 'the', 'мой', 'моя', 'мои', 'там', 'тут', 'где', 'как', 'ну', 'вот', 'бы',
]);

export interface Parsed {
  raw: string;
  lower: string;
  tokens: string[];        // очищенные слова
  stems: string[];         // основы слов (без стоп-слов)
  expanded: Set<string>;   // основы + синонимы
  codes: string[];         // коды тегов/марок (3700-K02, ВР-80)
}

// \b в JS не работает с кириллицей, поэтому границу задаём вручную: начало строки
// или не-код-символ слева, не-код-символ или конец справа
const CODE_RE = /(?:^|[^A-Za-zА-Яа-я0-9./-])([A-Za-zА-Яа-я0-9]{2,}(?:[-./][A-Za-zА-Яа-я0-9]+){1,})(?=[^A-Za-zА-Яа-я0-9./-]|$)/g;

export function parse(text: string): Parsed {
  const raw = text.trim();
  const lower = raw.toLowerCase().replace(/ё/g, 'е');
  const codes = Array.from(raw.matchAll(CODE_RE)).map(m => m[1]).filter(c => /\d/.test(c));
  const tokens = lower
    .replace(/[^\wа-я\s-]/gi, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  const stems = tokens.filter(w => w.length >= 3).map(stem);
  const expanded = expandSynonyms(stems);
  return { raw, lower, tokens, stems, expanded, codes };
}

/** Поле содержит любой из стемов (с допуском опечатки по словам поля) */
export function fieldMatchesStems(fieldValue: string | undefined, stems: string[]): boolean {
  if (!fieldValue || stems.length === 0) return false;
  const fieldStems = fieldValue.toLowerCase().replace(/ё/g, 'е')
    .replace(/[^\wа-я\s-]/gi, ' ').split(/\s+/).filter(Boolean).map(stem);
  for (const s of stems) {
    for (const fs of fieldStems) {
      if (fs.includes(s) || s.includes(fs) || fuzzyEqual(fs, s)) return true;
    }
  }
  return false;
}

/** Есть ли в запросе (с синонимами) любой из искомых стемов-намерения */
export function hasIntent(p: Parsed, intentStems: string[]): boolean {
  for (const want of intentStems) {
    if (p.expanded.has(want)) return true;
    for (const s of p.expanded) {
      if (s.startsWith(want) || want.startsWith(s) || fuzzyEqual(s, want)) return true;
    }
  }
  return false;
}
