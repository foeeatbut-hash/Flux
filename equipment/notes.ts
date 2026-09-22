/**
 * Примечание расчёта: где в нём теги и кому они принадлежат.
 *
 * Разбор написан по настоящим файлам заказчика, а не по догадкам. Заметка в
 * выгрузке выглядит так:
 *
 *   "Освещение внутри блока не устанавливать","Таг-номер 3700-B01-FA-001A"
 *   "Таг-номер вентилятор 3700-B01-BL-001A, 3700-B01-BL-002A"
 *   "Класс уровня протечки по CEN EN 1751 - 3","Таг-номер клапана 3700-B01-DW-001A",
 *   "Таг-номер привода 3700-B01-DWD-001, 3700-B01-DWD-007, 3700-B01-DWD-004"
 *
 * Отсюда три правила, на которых держится модуль:
 *
 *   1. **Слово рядом с маркером называет владельца.** «Таг-номер клапана» —
 *      это тег клапана, а не блока, в примечании которого он записан.
 *   2. **Порядок тегов — это порядок позиций.** Два вентилятора в блоке и два
 *      тега подряд: первый тег первому вентилятору, второй — второму.
 *   3. **Расхождения не выравниваются.** Три тега привода при двух приводах —
 *      это данные, а не ошибка разбора: лишние показываются человеку с
 *      выбором, а не выбрасываются и не прилепляются к первому попавшемуся.
 *
 * Модуль чистый: ни базы, ни сети, ни React. Проверяется скриптом
 * `scripts/test-equipment-notes.ts` на настоящих формулировках.
 */

import { roleByWord, type RoleId } from './roles.js';
import { startsWithCode, tokensOf, validateTag, type TagPolicy, DEFAULT_TAG_POLICY } from './tagPolicy.js';

/** Одна фраза примечания: текст и где он лежит в исходной строке. */
export interface NotePhrase {
  text: string;
  start: number;
  end: number;
}

/**
 * Разбить примечание на фразы.
 *
 * В выгрузке фразы берутся в кавычки и разделяются запятыми, но встречаются и
 * переносы строк, и просто текст без кавычек. Берём то, что есть: кавычки,
 * если они есть, иначе строки.
 */
export function splitNote(note: unknown): NotePhrase[] {
  const src = String(note ?? '');
  if (!src.trim()) return [];

  const out: NotePhrase[] = [];
  const quoted = /"([^"]*)"|«([^»]*)»/g;
  let m: RegExpExecArray | null;
  while ((m = quoted.exec(src))) {
    const text = (m[1] ?? m[2] ?? '').trim();
    if (text) out.push({ text, start: m.index, end: m.index + m[0].length });
  }
  if (out.length) return out;

  let at = 0;
  for (const line of src.split(/\r?\n/)) {
    const text = line.trim();
    if (text) out.push({ text, start: at, end: at + line.length });
    at += line.length + 1;
  }
  return out;
}

/**
 * Маркер «здесь дальше тег»: как это пишут инженеры на самом деле.
 *
 * Граница слова задана явным перечнем, а не `\b`: в JavaScript граница слова
 * считается по латинице, и после кириллического «номер» она не срабатывает
 * вовсе — маркер не находился бы никогда.
 */
const MARKER = /^(?:таг[-\s]?номер|тег[-\s]?номер|тэг[-\s]?номер|таг|тег|тэг|tag(?:\s*no\.?)?)(?=[\s:,;.—–-]|$)/i;

export interface TagPhrase {
  /** Кому адресованы теги: роль из слова после маркера. Пусто — самому блоку */
  role: RoleId | '';
  /** Слово, по которому роль определена — для колонки «доказательства» */
  word: string;
  /** Написания тегов по порядку, как в тексте */
  tags: string[];
  phrase: NotePhrase;
}

/** Как искать теги в примечании. */
export interface PhraseOptions {
  policy?: TagPolicy;
  /**
   * Коды проекта: «3700», «3700-B01».
   *
   * Известен код — тегом считается любое слово, которое с него начинается, в
   * любом месте фразы: так владелец и описал правило, «тег начинается с кода
   * проекта». Маркер «Таг-номер» при этом не обязателен. Кода нет — работает
   * прежнее правило: тег идёт после маркера.
   */
  prefixes?: string[];
}

const optionsOf = (opts: TagPolicy | PhraseOptions | undefined): { policy: TagPolicy; prefixes: string[] } => {
  if (opts && 'allowCyrillic' in opts) return { policy: opts as TagPolicy, prefixes: [] };
  const o = (opts || {}) as PhraseOptions;
  return {
    policy: o.policy || DEFAULT_TAG_POLICY,
    prefixes: (o.prefixes || []).map((p) => String(p || '').trim()).filter(Boolean),
  };
};

/**
 * Теги фразы по коду проекта — с ролью у каждого.
 *
 * Роль — ближайшее слово роли ПЕРЕД тегом. Фраза читается слева направо, и
 * «Таг-номер клапана 3700-…-DW-001A, привода 3700-…-DWD-001» даёт клапану его
 * тег, а приводу — свой. Слово роли после тега на тег не влияет: «3700-…,
 * фильтр» — это пояснение, а не адрес.
 */
function coded(phrase: NotePhrase, prefixes: string[]): TagPhrase[] {
  const out: TagPhrase[] = [];
  let role: RoleId | '' = '';
  let word = '';
  for (const t of tokensOf(phrase.text)) {
    if (prefixes.some((p) => startsWithCode(t.raw, p))) {
      const last = out[out.length - 1];
      if (last && last.role === role) last.tags.push(t.raw);
      else out.push({ role, word, tags: [t.raw], phrase });
      continue;
    }
    const guess = roleByWord(t.raw);
    if (guess) { role = guess; word = t.raw; }
  }
  return out;
}

/**
 * Тег-фразы примечания.
 *
 * Фраза без тега остаётся обычным примечанием: «Освещение внутри блока не
 * устанавливать» — это распоряжение производству, и превращать его во что-то
 * ещё программа не должна.
 */
export function tagPhrasesOf(note: unknown, opts: TagPolicy | PhraseOptions = DEFAULT_TAG_POLICY): TagPhrase[] {
  const { policy, prefixes } = optionsOf(opts);
  const out: TagPhrase[] = [];
  for (const phrase of splitNote(note)) {
    if (prefixes.length) {
      const found = coded(phrase, prefixes);
      if (found.length) { out.push(...found); continue; }
    }
    const m = MARKER.exec(phrase.text);
    if (!m) continue;
    let rest = phrase.text.slice(m[0].length).trim().replace(/^[:—–-]\s*/, '');

    // Слово роли идёт сразу за маркером: «Таг-номер клапана 3700-…»
    let role: RoleId | '' = '';
    let word = '';
    const first = rest.split(/[\s,]+/)[0] || '';
    const guess = roleByWord(first);
    if (guess) {
      role = guess;
      word = first;
      rest = rest.slice(first.length).trim().replace(/^[:—–-]\s*/, '');
    }

    const tags = rest
      .split(/[,;]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      // Хвост вроде «и др.» тегом не является: в нём нет ни цифры, ни дефиса
      .filter((t) => /[0-9]/.test(t) && validateTag(t, policy).identifier.length > 1);

    if (tags.length) out.push({ role, word, tags, phrase });
  }
  return out;
}

// ── Распределение тегов по позициям ─────────────────────────────────────────

/** Место, которому можно назначить тег. */
export interface TagSlot {
  /** Ключ позиции — тот же, которым пользуется план импорта */
  key: string;
  role: RoleId;
  /** Порядок в файле: по нему и раздаются теги */
  order: number;
  /** Номер экземпляра, если позиций несколько: «Вентилятор №2» */
  instanceNo?: number;
  /** Название позиции — для объяснений человеку */
  title?: string;
}

export type AssignVerdict =
  /** Тег назначен позиции */
  | 'assigned'
  /** Тег есть, позиции под него нет */
  | 'no-slot'
  /** Написание не проходит правила проекта */
  | 'invalid';

export interface TagAssignment {
  identifier: string;
  role: RoleId | '';
  /** Слово, по которому названа роль: «привода», «ПТС» */
  word: string;
  verdict: AssignVerdict;
  /** Кому назначен — пусто, если назначать было некому */
  slotKey: string;
  /** Словами: почему так */
  why: string;
  /** Предложенное исправление написания, если оно очевидно */
  fix: string;
  /** Откуда взят: текст фразы и смещения */
  evidence: { text: string; start: number; end: number };
}

export interface DistributeResult {
  assignments: TagAssignment[];
  /** Позиции, которым тега не досталось */
  untagged: TagSlot[];
}

/**
 * Раздать теги примечания позициям.
 *
 * Порядок — единственное правило раздачи: первый тег роли достаётся первой
 * позиции этой роли, второй — второй. Никакой «умной» подгонки по названию
 * модели тут нет и быть не должно: выдумав соответствие один раз, программа
 * будет ошибаться в нём молча и всегда.
 */
export function distribute(
  note: unknown,
  slots: TagSlot[],
  opts: TagPolicy | PhraseOptions = DEFAULT_TAG_POLICY,
  blockRole: RoleId = 'БЛОК',
): DistributeResult {
  const { policy } = optionsOf(opts);
  const assignments: TagAssignment[] = [];
  const taken = new Set<string>();
  const byRole = new Map<RoleId, TagSlot[]>();
  for (const s of [...slots].sort((a, b) => a.order - b.order)) {
    if (!byRole.has(s.role)) byRole.set(s.role, []);
    byRole.get(s.role)!.push(s);
  }

  for (const phrase of tagPhrasesOf(note, opts)) {
    const role = (phrase.role || blockRole) as RoleId;
    const queue = (byRole.get(role) || []).filter((s) => !taken.has(s.key));
    let at = 0;

    for (const raw of phrase.tags) {
      const check = validateTag(raw, policy);
      const evidence = { text: phrase.phrase.text, start: phrase.phrase.start, end: phrase.phrase.end };
      if (!check.ok) {
        assignments.push({
          identifier: check.identifier, role: phrase.role, word: phrase.word, verdict: 'invalid',
          slotKey: '', why: check.problem, fix: check.fix, evidence,
        });
        continue;
      }
      const slot = queue[at];
      if (!slot) {
        assignments.push({
          identifier: check.identifier, role: phrase.role, word: phrase.word, verdict: 'no-slot', slotKey: '',
          why: queue.length
            ? `Тегов для роли «${role}» больше, чем позиций: лишний тег нужно отнести к позиции вручную`
            : `Позиции с ролью «${role}» в этом блоке нет — заведите её или отнесите тег к другой`,
          fix: '', evidence,
        });
        continue;
      }
      at++;
      taken.add(slot.key);
      assignments.push({
        identifier: check.identifier, role: phrase.role, word: phrase.word, verdict: 'assigned', slotKey: slot.key,
        why: slot.instanceNo
          ? `Тег ${at} по порядку — позиции «${slot.title || slot.key}» (экземпляр ${slot.instanceNo})`
          : `Тег относится к позиции «${slot.title || slot.key}»`,
        fix: '', evidence,
      });
    }
  }

  return { assignments, untagged: slots.filter((s) => !taken.has(s.key)) };
}

// ── Порядок позиций ─────────────────────────────────────────────────────────

/**
 * Сравнение тегов по алфавиту «по-человечески».
 *
 * Обычное сравнение строк ставит «001A», «002A», «010A» правильно, но
 * «B01-9» перед «B01-10»: цифры сравниваются посимвольно. Здесь числа
 * сравниваются числами — так, как их читает инженер.
 */
export function compareTags(a: string, b: string): number {
  const parts = (s: string) => String(s || '').toLowerCase().match(/\d+|\D+/g) || [];
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i];
    const q = y[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      const d = parseInt(p, 10) - parseInt(q, 10);
      if (d) return d < 0 ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Позиции по алфавиту тега; без тега — после тегированных, в порядке файла.
 *
 * Схему состава этим НЕ сортируют: она показывает, как установка собрана
 * физически, и алфавит там был бы враньём.
 */
export function byTagOrder<T extends { tag?: string; order?: number }>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const at = String(a.tag || '');
    const bt = String(b.tag || '');
    if (at && bt) return compareTags(at, bt);
    if (at) return -1;
    if (bt) return 1;
    return (a.order || 0) - (b.order || 0);
  });
}
