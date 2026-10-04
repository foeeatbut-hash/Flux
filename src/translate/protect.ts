/**
 * Что переводить нельзя.
 *
 * Самая частая порча технического перевода — не кривая грамматика, а тронутый
 * код. `AHU-01` превращается в `AHU 01`, `Ø108×4` — в `O108x4`, `1 250,5` — в
 * `1250.5`, и ведомость перестаёт сходиться с чертежом. Поэтому перед переводом
 * такие куски вынимаются из строки и заменяются ячейками, а после — ставятся
 * обратно ровно теми же знаками, какими были.
 *
 * Ячейка — один символ из области частного использования, и номер ячейки — это
 * сам символ, а не цифры рядом с ним. Цифры внутри метки были бы бедой: узор
 * чисел нашёл бы их и вынул метку из метки.
 */

/** Первая ячейка; дальше подряд. Область частного использования — не текст. */
const SLOT_BASE = 0xe010;
const SLOT_MAX = 1500;
const SLOT_RE = /[\uE010-\uE5FF]/g;

export interface SlotValues extends Array<string> {
  /** Internal marker map travels with slots for the existing two-argument API. */
  markers?: string[];
}

export interface Protected {
  masked: string;
  slots: SlotValues;
  /** Marker characters selected to avoid colliding with literal source text. */
  markers: string[];
}

/**
 * Узоры по убыванию жадности: адрес почты должен сработать раньше, чем точка в
 * нём разберётся как число, а размер `Ø108×4` — раньше отдельных чисел.
 *
 * Границы слова заданы явными просмотрами, а не `\b`: `\b` в JavaScript не
 * считает кириллицу буквой, и на `ГОСТ 21.408` он срабатывает посреди слова.
 */
const EDGE = '(?<![0-9A-Za-zА-Яа-яЁё])';
const EDGE_END = '(?![0-9A-Za-zА-Яа-яЁё])';

const PATTERNS: RegExp[] = [
  // Адрес почты и ссылка
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
  /https?:\/\/\S+/gi,
  // Номер документа: 22062-PEQ-0371-E02
  new RegExp(`${EDGE}[0-9A-ZА-Я]{2,}(?:-[0-9A-ZА-Я]{1,6}){2,}${EDGE_END}`, 'g'),
  // Тег оборудования и код ВДР с позицией: AHU-01, P-101А, В2-14
  new RegExp(`${EDGE}[A-ZА-Я]{1,5}-\\d{1,4}[A-ZА-Яa-zа-я]?${EDGE_END}`, 'g'),
  // Размеры и обозначения: Ø108×4, DN50, PN16, IP54, ГОСТ 21.408
  /Ø\s?\d+(?:[.,]\d+)?(?:\s?[×xх]\s?\d+(?:[.,]\d+)?)*/g,
  new RegExp(`${EDGE}(?:DN|PN|IP|SDR|ISO|ГОСТ|ТУ|СНиП|СП)\\s?[-\\d.]*\\d${EDGE_END}`, 'gi'),
  new RegExp(`${EDGE}\\d+(?:[.,]\\d+)?\\s?[×xх]\\s?\\d+(?:[.,]\\d+)?(?:\\s?[×xх]\\s?\\d+(?:[.,]\\d+)?)?${EDGE_END}`, 'g'),
  // Дата в любом из привычных видов
  new RegExp(`${EDGE}\\d{1,2}[./-]\\d{1,2}[./-]\\d{2,4}${EDGE_END}`, 'g'),
  new RegExp(`${EDGE}\\d{4}-\\d{2}-\\d{2}${EDGE_END}`, 'g'),
  // Число: с разделителем разрядов, дробной частью, диапазоном
  new RegExp(`${EDGE}\\d+(?:[   ]\\d{3})*(?:[.,]\\d+)?(?:\\s?[…-]\\s?\\d+(?:[.,]\\d+)?)?${EDGE_END}`, 'g'),
];

/** Вынуть из строки то, что переводу не подлежит. */
export function protect(text: string): Protected {
  let masked = String(text || '');
  const slots: SlotValues = [];
  const markers: string[] = [];
  const used = new Set<number>();
  for (const ch of masked) {
    const code = ch.charCodeAt(0);
    if (code >= SLOT_BASE && code < SLOT_BASE + SLOT_MAX) used.add(code);
  }
  const available = Array.from({ length: SLOT_MAX }, (_, i) => SLOT_BASE + i)
    .filter((code) => !used.has(code));
  for (const re of PATTERNS) {
    masked = masked.replace(re, (hit) => {
      if (slots.length >= available.length) return hit;
      slots.push(hit);
      const marker = String.fromCharCode(available[slots.length - 1]);
      markers.push(marker);
      return marker;
    });
  }
  Object.defineProperty(slots, 'markers', { value: markers, enumerable: false });
  return { masked, slots, markers };
}

/** Поставить вынутое обратно. */
export function restore(masked: string, slots: string[], markers?: string[]): string {
  const actualMarkers = markers || (slots as SlotValues).markers
    || slots.map((_, i) => String.fromCharCode(SLOT_BASE + i));
  const byMarker = new Map(actualMarkers.map((marker, i) => [marker, slots[i]]));
  return String(masked || '').replace(SLOT_RE, (ch) => byMarker.get(ch) ?? ch);
}

/** Это ячейка защиты, а не слово: словарю её показывать не надо. */
export function isSlot(token: string): boolean {
  if (token.length !== 1) return false;
  const code = token.charCodeAt(0);
  return code >= SLOT_BASE && code < SLOT_BASE + SLOT_MAX;
}

/**
 * В строке не осталось ничего, кроме защищённого, — переводить нечего. Так
 * отсекаются ячейки таблиц с номерами позиций, датами, кодами и размерами:
 * гнать их через словарь значит засорять память переводов пустышками.
 */
export function nothingToTranslate(text: string): boolean {
  const { masked } = protect(text);
  const rest = masked.replace(SLOT_RE, ' ');
  return !/[0-9A-Za-zА-Яа-яЁё㐀-䶿一-鿿]/.test(rest);
}
