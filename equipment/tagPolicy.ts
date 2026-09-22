/**
 * Правило тегов проекта: что считается тегом и что с ним делать.
 *
 * Модуль общий — его читают окно, сервер и импорт. Второй экземпляр этих
 * правил означал бы, что окно принимает тег, который сервер отвергнет, или
 * наоборот; разойдясь однажды, они разойдутся навсегда.
 *
 * Главное решение здесь — **порядок**: сначала проверка, потом сравнение.
 * Прежняя `normalizeTag` заменяла кириллические буквы латинскими ДО всего
 * остального, и запрет кириллицы был невыполним в принципе: «В» превращалась
 * в «B» и проходила любую проверку. Поэтому:
 *
 *   — `validateTag` не подменяет ни одной буквы. Она говорит «нельзя» и
 *     показывает, где именно и чем это чинится;
 *   — `identityKey` отличает теги друг от друга и не знает о двойниках:
 *     «3700-B01-001B» и «3700-B01-001В» — разные теги, если кириллица
 *     разрешена, и второго просто не существует, если запрещена;
 *   — `similarityKey` с двойниками остаётся, но только чтобы сказать
 *     «похоже на…». Он ничего не создаёт и ничего не соединяет.
 *
 * Модуль чистый: ни node, ни React, ни базы (см. scripts/test-architecture.ts).
 */

// ── Политика проекта ────────────────────────────────────────────────────────

/**
 * Простая маска вместо регулярного выражения.
 *
 * Регулярное выражение, пришедшее от пользователя, — это способ занять сервер
 * на минуту одной строкой. Маска описывает то же, что инженер и так держит в
 * голове: приставка, сколько частей, есть ли буква на конце.
 */
export interface TagMask {
  /** Приставка проекта: «3700». Пусто — любая */
  prefix?: string;
  /** Сколько частей, разделённых дефисом. 0 — любое число */
  segments?: number;
  /** Допускается ли буквенный суффикс у последней части: «001A» */
  letterSuffix?: boolean;
}

export interface TagPolicy {
  /** Разрешены ли кириллические буквы. По умолчанию — нет */
  allowCyrillic: boolean;
  /** Приставки проекта: код проекта и дополнительные */
  prefixes: string[];
  masks: TagMask[];
  /** Версия правила: план импорта запоминает её и сверяет перед записью */
  version: number;
}

export const DEFAULT_TAG_POLICY: TagPolicy = {
  allowCyrillic: false,
  prefixes: [],
  masks: [],
  version: 1,
};

/** Политика из хранимого JSON. Отсутствующее читается как «запрещено». */
export function tagPolicyOf(raw: unknown): TagPolicy {
  const src: any = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!src || typeof src !== 'object') return { ...DEFAULT_TAG_POLICY };
  return {
    allowCyrillic: src.allowCyrillic === true,
    prefixes: Array.isArray(src.prefixes)
      ? src.prefixes.map((p: unknown) => String(p || '').trim()).filter(Boolean).slice(0, 20)
      : [],
    masks: Array.isArray(src.masks)
      ? src.masks.slice(0, 20).map((m: any) => ({
        prefix: m?.prefix ? String(m.prefix).trim() : undefined,
        segments: Number.isFinite(Number(m?.segments)) ? Math.max(0, Math.trunc(Number(m.segments))) : 0,
        letterSuffix: m?.letterSuffix !== false,
      }))
      : [],
    version: Number.isFinite(Number(src.version)) ? Math.max(1, Math.trunc(Number(src.version))) : 1,
  };
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch (_) { return null; }
}

// ── Символы ─────────────────────────────────────────────────────────────────

/** Предел длины тега. Один и тот же в окне, в API, в базе и в импорте. */
export const TAG_MAX = 120;

const LATIN = /[A-Za-z]/;
const DIGIT = /[0-9]/;
/** Кириллица по письменности, а не по диапазону А–Я: «ё», «і», «ў» тоже буквы */
const CYRILLIC = /\p{Script=Cyrillic}/u;
const LETTER = /\p{Letter}/u;
/** Невидимое: нулевой пробел, мягкий перенос, метка порядка байтов и прочее */
const INVISIBLE = new RegExp('[\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\uFEFF]');
/** Типографские тире, которые человек не отличает от дефиса на глаз */
const DASHES = new RegExp('[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]');

/**
 * Латинский двойник кириллической буквы — ТОЛЬКО для подсказки и похожести.
 *
 * Ни одна запись, ни одно сравнение идентичности этой картой не пользуется.
 * «Ж» здесь нет намеренно: у неё нет двойника, и предлагать «ZH» — это
 * транслитерация, а не исправление раскладки.
 */
const LOOKALIKE: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X',
};

export type TagProblemCode =
  | '' | 'empty' | 'long' | 'space' | 'invisible' | 'dash' | 'hyphen-edge' | 'hyphen-double'
  | 'cyrillic-off' | 'foreign' | 'char';

export interface TagCheck {
  ok: boolean;
  /** Написание, которое будет сохранено: обрезаны внешние пробелы, NFC */
  identifier: string;
  /** Чем теги отличаются друг от друга */
  identityKey: string;
  /** Что не так — человеческими словами */
  problem: string;
  code: TagProblemCode;
  /** Номер знака, на котором споткнулись; -1 — знак ни при чём */
  at: number;
  /** Предложение исправления. Пусто — предложить нечего */
  fix: string;
}

const okCheck = (identifier: string): TagCheck => ({
  ok: true, identifier, identityKey: identityKeyOf(identifier), problem: '', code: '', at: -1, fix: '',
});

const bad = (
  identifier: string, code: TagProblemCode, problem: string, at = -1, fix = '',
): TagCheck => ({ ok: false, identifier, identityKey: '', problem, code, at, fix });

/**
 * Годится ли строка как тег этого проекта.
 *
 * Ничего не исправляет молча. Если исправление очевидно (кириллическая «В»
 * вместо латинской «B», типографское тире вместо дефиса) — оно предлагается
 * отдельным полем, и записывать его будет человек, а не программа.
 */
export function validateTag(raw: unknown, policy: TagPolicy = DEFAULT_TAG_POLICY): TagCheck {
  const trimmed = String(raw ?? '').trim();
  const identifier = trimmed.normalize('NFC');
  if (!identifier) return bad('', 'empty', 'Тег пустой');

  const chars = [...identifier];
  if (chars.length > TAG_MAX) {
    return bad(identifier, 'long', `Тег длиннее ${TAG_MAX} знаков`, TAG_MAX);
  }

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (/\s/.test(ch)) return bad(identifier, 'space', 'В теге есть пробел', i, identifier.replace(/\s+/g, ''));
    if (INVISIBLE.test(ch)) {
      return bad(identifier, 'invisible', 'В теге есть невидимый знак', i,
        chars.filter((c) => !INVISIBLE.test(c)).join(''));
    }
    if (DASHES.test(ch)) {
      return bad(identifier, 'dash', 'В теге длинное тире вместо дефиса', i,
        chars.map((c) => (DASHES.test(c) ? '-' : c)).join(''));
    }
    if (ch === '-' || DIGIT.test(ch) || LATIN.test(ch)) continue;
    if (CYRILLIC.test(ch)) {
      if (policy.allowCyrillic) continue;
      const twin = LOOKALIKE[ch] || '';
      return bad(
        identifier, 'cyrillic-off',
        `В теге есть кириллическая буква «${ch}». `
        + (twin ? `Используйте латинскую «${twin}» ` : 'Замените её латинской буквой ')
        + 'или разрешите кириллицу в настройках проекта.',
        i,
        twin ? chars.map((c) => LOOKALIKE[c] || c).join('') : '',
      );
    }
    if (LETTER.test(ch)) {
      return bad(identifier, 'foreign', `Буква «${ch}» не из разрешённых письменностей`, i);
    }
    return bad(identifier, 'char', `Знак «${ch}» в теге не разрешён`, i);
  }

  if (identifier.startsWith('-') || identifier.endsWith('-')) {
    return bad(identifier, 'hyphen-edge', 'Тег не может начинаться или заканчиваться дефисом', -1,
      identifier.replace(/^-+|-+$/g, ''));
  }
  if (identifier.includes('--')) {
    return bad(identifier, 'hyphen-double', 'В теге два дефиса подряд', identifier.indexOf('--') + 1,
      identifier.replace(/-{2,}/g, '-'));
  }

  return okCheck(identifier);
}

/**
 * Чем теги отличаются друг от друга.
 *
 * Регистр не различает — «ahu-1» и «AHU-1» это один тег. Алфавит различает:
 * подменять кириллицу латиницей здесь значило бы объявить два разных тега
 * одним и потерять один из них при записи.
 */
export const identityKeyOf = (raw: string): string =>
  String(raw ?? '').trim().normalize('NFC').toLowerCase();

/**
 * Ключ похожести — для подсказки «не это ли вы имели в виду».
 *
 * Здесь двойники как раз сводятся, а разделители убираются вовсе. Ни создать,
 * ни связать теги по этому ключу нельзя: он существует, чтобы показать
 * человеку список и дать выбрать.
 */
export const similarityKeyOf = (raw: string): string =>
  [...identityKeyOf(raw)].map((c) => LOOKALIKE[c] ?? c).join('').replace(/-/g, '');

// ── Маски и приставки ───────────────────────────────────────────────────────

/** Подходит ли тег под маску: приставка, число частей, буквенный суффикс. */
export function matchesMask(identifier: string, mask: TagMask): boolean {
  const parts = identifier.split('-');
  if (mask.prefix && parts[0] !== mask.prefix) return false;
  if (mask.segments && parts.length !== mask.segments) return false;
  if (mask.letterSuffix === false && /[A-Za-z\p{Script=Cyrillic}]$/u.test(identifier)) return false;
  return true;
}

/** Начинается ли тег с одной из приставок проекта — по ГРАНИЦЕ части. */
export function hasProjectPrefix(identifier: string, policy: TagPolicy): boolean {
  const head = identifier.split('-')[0];
  return policy.prefixes.some((p) => head === p);
}

// ── Извлечение из текста ────────────────────────────────────────────────────

/** Что это за находка и что с ней делать дальше. */
export type CandidateVerdict =
  /** Точное совпадение с реестром проекта или уверенное попадание в маску */
  | 'accepted'
  /** Похоже на тег, но решает человек */
  | 'review'
  /** Тег, но записать его нельзя: алфавит или формат */
  | 'invalid'
  /** Не тег: модель, стандарт, позиция, номер */
  | 'reference';

export interface TagCandidate {
  /** Как написано в тексте */
  raw: string;
  /** Написание после trim/NFC — то, что будет сохранено */
  identifier: string;
  verdict: CandidateVerdict;
  /** Почему так решено — словами, для колонки «доказательства» */
  why: string;
  /** Где нашли: смещения в исходном тексте */
  start: number;
  end: number;
  /** Код отказа, если это отказ */
  code: TagProblemCode;
  fix: string;
}

/** Слово-маркер рядом с кодом: «тег 3700-B01-001» */
const MARKER = /(^|[^\p{Letter}])(тег|тэг|поз|позиция|tag)\.?\s*$/iu;

/**
 * Токен — это слово целиком.
 *
 * Отсюда правило, ради которого всё и написано: из `13700-B01-001` нельзя
 * достать `3700`, а из `3700-B01-001Ж` — обрезанный `3700-B01-001`. Тег либо
 * совпал целиком, либо это не он.
 */
const TOKEN = new RegExp('[\\p{Letter}\\p{Number}][\\p{Letter}\\p{Number}\\-\u2010-\u2015\u00AD\u200B]*', 'gu');

export interface ExtractOptions {
  /** Реестр проекта: точное совпадение сильнее любой маски */
  registry?: string[];
  /** Ограничение на число находок в одном тексте */
  limit?: number;
}

/**
 * Найти в тексте кандидатов в теги.
 *
 * Возвращает ВСЕ находки с причинами, а не только удачные: инженеру важно
 * видеть, что программа нашла «ТРВ-68-R410A» и сочла это моделью, — иначе
 * непонятно, почему тега нет.
 */
export function extractCandidates(
  text: unknown, policy: TagPolicy = DEFAULT_TAG_POLICY, opts: ExtractOptions = {},
): TagCandidate[] {
  const source = String(text ?? '');
  if (!source.trim()) return [];
  const limit = opts.limit ?? 50;
  const known = new Set((opts.registry || []).map(identityKeyOf));

  const out: TagCandidate[] = [];
  const seen = new Set<string>();
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(source)) && out.length < limit) {
    const raw = m[0];
    const start = m.index;
    const end = start + raw.length;
    // Одни цифры — это количество, позиция или год, но не тег
    if (!LETTER.test(raw)) continue;
    // Слово без единой цифры тегом не бывает: «Материал», «Фильтр»
    if (!DIGIT.test(raw)) continue;

    const check = validateTag(raw, policy);
    const key = `${check.identifier}@${start}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const marked = MARKER.test(source.slice(Math.max(0, start - 20), start));
    const exact = known.has(identityKeyOf(check.identifier));

    if (!check.ok) {
      /**
       * Запрещённый тег показываем, но не всякую строку объявляем запрещённым
       * тегом. «ТРВ-68-R410A» — это модель клапана, и сообщение «в теге есть
       * кириллическая буква» рядом с ней сбивает с толку: инженер начинает
       * искать тег там, где его никто не писал. Поэтому «нельзя» говорится
       * только про то, что похоже на попытку назвать тег: приставка проекта,
       * слово «тег» рядом или похожий на существующий тег код.
       */
      const intended = marked
        || hasProjectPrefix(check.identifier, policy)
        || known.has(identityKeyOf(check.identifier))
        || (!!check.fix && known.has(identityKeyOf(check.fix)));
      out.push(intended
        ? {
          raw, identifier: check.identifier, verdict: 'invalid' as const, why: check.problem,
          start, end, code: check.code, fix: check.fix,
        }
        : {
          raw, identifier: check.identifier, verdict: 'reference' as const,
          why: 'Похоже на модель или стандарт, а не на тег проекта',
          start, end, code: check.code, fix: check.fix,
        });
      continue;
    }

    const byPrefix = hasProjectPrefix(check.identifier, policy);
    const byMask = policy.masks.length > 0 && policy.masks.some((mask) => matchesMask(check.identifier, mask));
    const hyphened = check.identifier.includes('-');

    let verdict: CandidateVerdict = 'reference';
    let why = 'Похоже на модель или обозначение, а не на тег проекта';
    if (exact) { verdict = 'accepted'; why = 'Точное совпадение с тегом проекта'; }
    else if (byPrefix && (byMask || policy.masks.length === 0) && hyphened) {
      verdict = 'review'; why = 'Подходит под приставку проекта — подтвердите';
    } else if (byMask && hyphened) { verdict = 'review'; why = 'Подходит под формат проекта — подтвердите'; }
    else if (marked && hyphened) { verdict = 'review'; why = 'Рядом сказано «тег» — подтвердите'; }

    out.push({ raw, identifier: check.identifier, verdict, why, start, end, code: '', fix: '' });
  }
  return out;
}
