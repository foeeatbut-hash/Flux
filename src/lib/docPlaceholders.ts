/**
 * Подстановки в шаблонах Конструктора.
 *
 * Шаблон — это документ (таблица или текст), в котором вместо конкретных
 * значений написаны метки вида {{документ.название}}. Когда шаблон
 * применяют к документу или нажимают «Обновить подстановки», метки
 * заменяются реальными данными: названием документа, ревизией, датами,
 * реквизитами проекта, ФИО и инициалами сотрудника.
 *
 * Замена идёт по снимку документа целиком: снимок — это дерево из объектов,
 * массивов и строк, и метки могут лежать где угодно — в ячейке таблицы, в
 * абзаце текста, в колонтитуле. Поэтому обходим дерево, а не разбираем
 * формат движка: так подстановки работают одинаково в таблице и в тексте и
 * не ломаются при обновлении редактора.
 */

export interface PlaceholderContext {
  documentName?: string;
  documentNumber?: string;
  revision?: string;
  projectName?: string;
  projectCode?: string;
  userName?: string;
  userSymbol?: string;
  userRole?: string;
  /** Точка отсчёта для дат; по умолчанию — сейчас. Нужна для проверок. */
  now?: Date;
}

export interface PlaceholderDef {
  key: string;
  label: string;
  hint: string;
  group: 'Документ' | 'Проект' | 'Дата' | 'Сотрудник';
  resolve: (ctx: Required<Pick<PlaceholderContext, 'now'>> & PlaceholderContext) => string;
}

// Родительный падеж — для дат («2 августа 2026 г.»)
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
// Именительный — для штампов и шапок («август 2026»)
const MONTHS_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

const two = (n: number) => String(n).padStart(2, '0');

/** ФИО «Раупов Хусрав Хусравович» → «Раупов Х. Х.» */
export function initialsOf(fullName: string): string {
  const clean = String(fullName || '').replace(/\s*\(.*\)\s*$/, '').trim();
  if (!clean) return '';
  const parts = clean.split(/\s+/);
  const surname = parts[0];
  const rest = parts.slice(1).filter(Boolean).map((p) => `${p.charAt(0).toUpperCase()}.`);
  return [surname, ...rest].join(' ').trim();
}

export const PLACEHOLDERS: PlaceholderDef[] = [
  // ── Документ ──
  { key: 'документ.название', group: 'Документ', label: 'Название документа',
    hint: 'Как документ назван в Flux Office',
    resolve: (c) => c.documentName || '' },
  { key: 'документ.номер', group: 'Документ', label: 'Номер документа',
    hint: 'Обозначение документа, если задано',
    resolve: (c) => c.documentNumber || '' },
  { key: 'документ.ревизия', group: 'Документ', label: 'Ревизия',
    hint: 'Текущая ревизия документа',
    resolve: (c) => c.revision || '' },

  // ── Проект ──
  { key: 'проект.название', group: 'Проект', label: 'Название проекта',
    hint: 'Активный проект программы',
    resolve: (c) => c.projectName || '' },
  { key: 'проект.код', group: 'Проект', label: 'Код проекта',
    hint: 'Шифр проекта, если задан',
    resolve: (c) => c.projectCode || '' },

  // ── Дата ──
  { key: 'дата.сегодня', group: 'Дата', label: 'Сегодня, цифрами',
    hint: 'Подставится дата, когда обновляли подстановки',
    resolve: (c) => `${two(c.now.getDate())}.${two(c.now.getMonth() + 1)}.${c.now.getFullYear()}` },
  { key: 'дата.прописью', group: 'Дата', label: 'Сегодня прописью',
    hint: 'Для титулов и писем',
    resolve: (c) => `${c.now.getDate()} ${MONTHS[c.now.getMonth()]} ${c.now.getFullYear()} г.` },
  { key: 'дата.месяц', group: 'Дата', label: 'Месяц и год',
    hint: 'Для штампов основной надписи',
    resolve: (c) => `${MONTHS_NOM[c.now.getMonth()]} ${c.now.getFullYear()}` },
  { key: 'дата.год', group: 'Дата', label: 'Год',
    hint: 'Четыре цифры',
    resolve: (c) => String(c.now.getFullYear()) },

  // ── Сотрудник ──
  { key: 'сотрудник.фио', group: 'Сотрудник', label: 'ФИО целиком',
    hint: 'Кто обновляет документ',
    resolve: (c) => String(c.userName || '').replace(/\s*\(.*\)\s*$/, '').trim() },
  { key: 'сотрудник.инициалы', group: 'Сотрудник', label: 'Фамилия и инициалы',
    hint: '«Раупов Х. Х.» — для подписи в штампе',
    resolve: (c) => initialsOf(c.userName || '') },
  { key: 'сотрудник.табельный', group: 'Сотрудник', label: 'Табельный номер',
    hint: 'Логин сотрудника в программе',
    resolve: (c) => c.userSymbol || '' },
  { key: 'сотрудник.должность', group: 'Сотрудник', label: 'Роль в программе',
    hint: 'Администратор, инженер и т.д.',
    resolve: (c) => c.userRole || '' },
];

const BY_KEY = new Map(PLACEHOLDERS.map((p) => [p.key, p]));

/** Метка в тексте документа: {{ключ}} */
export const placeholderToken = (key: string) => `{{${key}}}`;

const TOKEN_RE = /\{\{\s*([a-zA-Zа-яА-ЯёЁ0-9._-]+)\s*\}\}/g;

/**
 * Заменяет метки в одной строке. Неизвестные метки оставляем как есть —
 * человек мог написать свою, и молча стирать её нельзя.
 */
export function fillString(text: string, ctx: PlaceholderContext): string {
  if (!text || text.indexOf('{{') === -1) return text;
  const full = { ...ctx, now: ctx.now || new Date() };
  return text.replace(TOKEN_RE, (whole, key) => {
    const def = BY_KEY.get(String(key).trim().toLowerCase());
    if (!def) return whole;
    const value = def.resolve(full as any);
    return value === '' ? whole : value;
  });
}

/**
 * Обходит снимок документа и заменяет метки во всех строках.
 * Возвращает новый снимок и число замен — по нему показываем результат.
 */
export function fillSnapshot<T>(snapshot: T, ctx: PlaceholderContext): { result: T; replaced: number } {
  let replaced = 0;
  const walk = (node: any): any => {
    if (typeof node === 'string') {
      const next = fillString(node, ctx);
      if (next !== node) replaced++;
      return next;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: any = {};
      for (const k of Object.keys(node)) out[k] = walk(node[k]);
      return out;
    }
    return node;
  };
  return { result: walk(snapshot), replaced };
}

/** Сколько меток осталось незаполненными — для подсказки в редакторе. */
export function countTokens(snapshot: any): number {
  let n = 0;
  const walk = (node: any) => {
    if (typeof node === 'string') {
      const m = node.match(TOKEN_RE);
      if (m) n += m.length;
      return;
    }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object') { for (const k of Object.keys(node)) walk(node[k]); }
  };
  walk(snapshot);
  return n;
}
