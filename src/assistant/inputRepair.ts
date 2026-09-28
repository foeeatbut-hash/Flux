import { FIELDS } from '../import/dictionary';
import { STOPWORDS, ROUTE_WORDS } from './queryWords';

/**
 * Починка ввода до разбора: раскладка клавиатуры, опечатки, вежливая обёртка.
 * Чистые функции — текст внутрь, текст наружу, ни хранилища, ни React.
 */

// ── Исправление перепутанной раскладки клавиатуры ────────────────────────────
// «gjrf;b ntub» → «покажи теги», «покажи ntub» → «покажи теги», «щзут» → «open».
// Конвертируем только те слова, которые после конвертации становятся знакомыми,
// или явно выглядят как «мусор» в текущей раскладке (латиница без гласных).
const EN2RU: Record<string, string> = {
  q: 'й', w: 'ц', e: 'у', r: 'к', t: 'е', y: 'н', u: 'г', i: 'ш', o: 'щ', p: 'з',
  '[': 'х', ']': 'ъ', a: 'ф', s: 'ы', d: 'в', f: 'а', g: 'п', h: 'р', j: 'о',
  k: 'л', l: 'д', ';': 'ж', "'": 'э', z: 'я', x: 'ч', c: 'с', v: 'м', b: 'и',
  n: 'т', m: 'ь', ',': 'б', '.': 'ю', '`': 'ё',
};
const RU2EN: Record<string, string> = {};
for (const [en, ru] of Object.entries(EN2RU)) RU2EN[ru] = en;

function convertLayout(word: string, map: Record<string, string>): string {
  let out = '';
  for (const ch of word) {
    const lower = ch.toLowerCase();
    const rep = map[lower];
    out += rep === undefined ? ch : (ch === lower ? rep : rep.toUpperCase());
  }
  return out;
}

// Знакомые русские слова: команды помощника + синонимы полей словаря
let VOCAB_RU: string[] | null = null;
function vocabRu(): string[] {
  if (!VOCAB_RU) {
    const words = new Set<string>([
      'покажи', 'показать', 'найди', 'найти', 'сколько', 'выгрузи', 'выведи', 'открой',
      'характеристики', 'данные', 'параметры', 'оборудование', 'теги', 'тег', 'дубли',
      'дубликаты', 'проект', 'проекты', 'файл', 'файлы', 'папка', 'заметка', 'заметки',
      'чат', 'сотрудники', 'критичные', 'позиции', 'позиция', 'этап', 'заказан', 'куплен',
      'закупки', 'менеджмент', 'проводник', 'блокнот', 'справочник', 'помощь', 'привет',
      'умеешь', 'создай', 'создать', 'вентилятор', 'вентиляторы', 'клапан', 'клапаны',
      'фильтр', 'нагреватель', 'охладитель', 'установка', 'кондиционер', 'сводка', 'демонстрация',
    ]);
    for (const f of FIELDS) {
      for (const w of f.label.toLowerCase().split(/\s+/)) if (w.length >= 3) words.add(w);
      for (const syn of f.synonyms) for (const w of syn.split(/\s+/)) if (w.length >= 3) words.add(w);
    }
    VOCAB_RU = [...words];
  }
  return VOCAB_RU;
}
function isKnownRu(token: string): boolean {
  if (token.length < 3) return false;
  const p = Math.min(5, token.length);
  const head = token.slice(0, p);
  return vocabRu().some(w => w.slice(0, p) === head);
}
const VOCAB_EN = ['show', 'open', 'find', 'help', 'tags', 'tag', 'files', 'file', 'create',
  'equipment', 'project', 'projects', 'chat', 'notes', 'note', 'export', 'excel', 'word', 'demo'];

export function fixKeyboardLayout(text: string): string {
  return text.split(/(\s+)/).map(tok => {
    const t = tok.trim();
    // Коды/теги (3700-B02…), короткие слова и числа не трогаем
    if (!t || t.length < 3 || /\d/.test(t) || /-/.test(t)) return tok;
    if (/^[a-z\[\];',.`]+$/i.test(t)) {
      // Латиница: возможно, русское слово в английской раскладке
      const conv = convertLayout(t, EN2RU);
      if (/^[а-яё]+$/i.test(conv)) {
        if (isKnownRu(conv.toLowerCase())) return conv;
        // без гласных в латинице, но с гласными после конвертации — почти наверняка раскладка
        if (!/[aeiouy]/i.test(t) && /[аеёиоуыэюя]/i.test(conv)) return conv;
      }
    } else if (/^[а-яё]+$/i.test(t)) {
      // Кириллица: возможно, английское слово в русской раскладке
      const conv = convertLayout(t, RU2EN).toLowerCase();
      if (/^[a-z]+$/.test(conv) && VOCAB_EN.includes(conv) && !isKnownRu(t.toLowerCase())) return conv;
    }
    return tok;
  }).join('');
}

// ═══════════ Живая речь ═══════════
// Помощник работает без интернета и без языковой модели: он разбирает
// запрос правилами. Чтобы это не выглядело общением с автоматом, здесь
// три вещи: понимание разговорных оборотов, починка опечаток и внятный
// ответ, когда вопрос действительно не про программу.

/** Расстояние Дамерау—Левенштейна с ранним выходом: опечатки в одно-два касания. */
function editDistance(a: string, b: string, limit = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const prev = new Array(b.length + 1);
  const cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let best = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (best > limit) return limit + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/** Словарь, по которому чиним опечатки: разделы, поля, частые глаголы. */
function repairVocabulary(): string[] {
  const words = new Set<string>();
  for (const r of ROUTE_WORDS) for (const st of r.stems) words.add(st);
  for (const w of ['покажи', 'открой', 'найди', 'выгрузи', 'сколько', 'дубли', 'заказано',
    'закупки', 'просрочено', 'вентилятор', 'насос', 'расход', 'напор', 'мощность',
    'ревизия', 'статус', 'отдел', 'проект', 'шаблон', 'подстановки', 'корзина']) words.add(w);
  try { for (const w of vocabRu()) if (w.length >= 5) words.add(w); } catch (_) {}
  return [...words];
}
let REPAIR_CACHE: string[] | null = null;

/**
 * Чинит очевидные опечатки: «покожи вентилчторы» → «покажи вентиляторы».
 * Правим только слова длиннее четырёх букв и только на одну-две ошибки,
 * иначе можно «исправить» осмысленное слово в чужое.
 */
export function repairTypos(text: string): string {
  if (!REPAIR_CACHE) REPAIR_CACHE = repairVocabulary();
  return text.split(/(\s+)/).map((chunk) => {
    const w = chunk.toLowerCase();
    if (w.length < 5 || !/^[а-яё-]+$/i.test(w)) return chunk;
    // Известное слово не трогаем: иначе «можешь» превращается в «модель».
    if (isKnownRu(w) || STOPWORDS.has(w)) return chunk;
    if (REPAIR_CACHE!.some((v) => w.startsWith(v) || v.startsWith(w))) return chunk;
    let best: string | null = null, bestD = 3;
    for (const v of REPAIR_CACHE!) {
      if (Math.abs(v.length - w.length) > 2) continue;
      // Две ошибки правим только когда слово начинается одинаково: иначе
      // «подсказать» «чинится» в «показать», а это другое слово и другой
      // ответ. Опечатки в первых буквах редки — там смотрит глаз.
      const d = editDistance(w, v, 2);
      if (d >= 2 && w.slice(0, 3) !== v.slice(0, 3)) continue;
      if (d < bestD) { bestD = d; best = v; }
    }
    return bestD <= 2 && best ? best : chunk;
  }).join('');
}

/**
 * Вежливая обёртка вокруг запроса: убираем «а можешь», «слушай»,
 * «будь добр» — они мешают разбору, но по-человечески их пишут постоянно.
 */
export function stripPoliteness(text: string): string {
  // Границы слова задаём через просмотр назад/вперёд: \b в JavaScript
  // считает буквой только латиницу, и на кириллице просто не срабатывает.
  const W = '(?<![\\p{L}])';
  const E = '(?![\\p{L}])';
  const drop = (body: string, tail = '[,\\s]*') =>
    new RegExp(`${W}(?:${body})${E}${tail}`, 'giu');
  return text
    // Формы «подсказать», «подскажешь», «подскажи-ка» пишут не реже
    // повелительного «подскажи», поэтому убираем корень целиком.
    .replace(drop('слушай(?:те)?|скажи(?:те)?|подскаж[а-яё]*|подсказ[а-яё]*|будь добр[а-яё]*|будьте добры|плиз'), '')
    .replace(drop('а\\s+(?:можешь|можете|мог бы|могли бы)'), '')
    .replace(drop('можешь|можете|не мог бы ты|не могли бы вы|мог бы ты|могли бы вы'), '')
    .replace(drop('пожалуйста|будьте любезны|очень нужно|хотел[аи]? бы узнать|хочу узнать'), '')
    .replace(/^[\s,]+/, '')
    .replace(/\s*,\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
