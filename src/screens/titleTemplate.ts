// ── Конструктор шаблона титула ────────────────────────────────────────────
// Инженер собирает титульный лист из «ссылок» (полей) — дата, страница, номер и
// наименование документа, ревизия, код проекта и т.д. — и может писать формулы,
// комбинируя поля. Шаблон сохраняется отдельным документом (kind=TEMPLATE,
// bindings.subtype='title', bindings.html). Когда шаблон присвоен документу и тот
// сохранён, титул подставляет значения ИМЕННО этого документа (см. renderTitleHtml).

import { renderFormula, type Formula, type FormulaContext, type FormulaSegment } from '../lib/docFormula';

export interface TitleContext {
  [key: string]: string | number;
}

/** Каталог формул документа: идентификатор → формула. Читается один раз. */
export type FormulaCatalog = Record<string, Formula>;

// Каталог полей титула: что можно вставить как «ссылку». dotted-имена совпадают
// с ключами полей данных проекта (office/fieldKeys.ts).
export const TITLE_FIELDS: { key: string; title: string; group: string }[] = [
  { key: 'doc.name', title: 'Название документа', group: 'Документ' },
  { key: 'doc.code', title: 'Номер / шифр', group: 'Документ' },
  { key: 'doc.revision', title: 'Ревизия', group: 'Документ' },
  { key: 'doc.title', title: 'Наименование', group: 'Документ' },
  { key: 'page', title: 'Номер страницы', group: 'Страница' },
  { key: 'pages', title: 'Всего страниц', group: 'Страница' },
  { key: 'date', title: 'Дата', group: 'Дата' },
  { key: 'dateTime', title: 'Дата и время', group: 'Дата' },
  { key: 'year', title: 'Год', group: 'Дата' },
  { key: 'author', title: 'Автор', group: 'Прочее' },
  { key: 'project.code', title: 'Код проекта', group: 'Проект' },
  { key: 'project.name', title: 'Название проекта', group: 'Проект' },
  { key: 'project.customer', title: 'Заказчик', group: 'Проект' },
  { key: 'project.contractor', title: 'Подрядчик', group: 'Проект' },
];

export const fieldTitle = (key: string): string =>
  TITLE_FIELDS.find((f) => f.key === key)?.title || key;

// ── Крошечный безопасный вычислитель формул ────────────────────────────────
// Поддержка: + - * / , & (склейка), скобки, числа, строки в кавычках и имена
// полей (dotted) из контекста. Никакого eval — свой разбор по грамматике.
function evalFormula(expr: string, ctx: TitleContext): string {
  let i = 0;
  const s = expr;
  const skip = () => { while (i < s.length && /\s/.test(s[i])) i++; };

  const parsePrimary = (): any => {
    skip();
    if (s[i] === '(') { i++; const v = parseExpr(); skip(); if (s[i] === ')') i++; return v; }
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i++]; let str = '';
      while (i < s.length && s[i] !== q) { str += s[i++]; }
      i++; return str;
    }
    // число
    const numMatch = /^[0-9]+(\.[0-9]+)?/.exec(s.slice(i));
    if (numMatch) { i += numMatch[0].length; return parseFloat(numMatch[0]); }
    // имя поля (буквы/цифры/точка/подчёркивание)
    const idMatch = /^[A-Za-zА-Яа-я_][A-Za-zА-Яа-я0-9_.]*/.exec(s.slice(i));
    if (idMatch) {
      i += idMatch[0].length;
      const raw = ctx[idMatch[0]];
      const n = typeof raw === 'number' ? raw : (raw != null && /^-?[0-9]+(\.[0-9]+)?$/.test(String(raw)) ? parseFloat(String(raw)) : undefined);
      return n != null ? n : String(raw ?? '');
    }
    return '';
  };

  const parseMul = (): any => {
    let v = parsePrimary();
    skip();
    while (s[i] === '*' || s[i] === '/') {
      const op = s[i++]; const r = parsePrimary();
      v = op === '*' ? Number(v) * Number(r) : Number(r) ? Number(v) / Number(r) : '';
      skip();
    }
    return v;
  };

  const parseExpr = (): any => {
    let v = parseMul();
    skip();
    while (s[i] === '+' || s[i] === '-' || s[i] === '&') {
      const op = s[i++]; const r = parseMul();
      if (op === '&') v = String(v) + String(r);
      else if (op === '+') v = (typeof v === 'number' && typeof r === 'number') ? v + r : String(v) + String(r);
      else v = Number(v) - Number(r);
      skip();
    }
    return v;
  };

  try {
    const out = parseExpr();
    return typeof out === 'number' ? (Number.isInteger(out) ? String(out) : String(Math.round(out * 100) / 100)) : String(out);
  } catch (_) { return ''; }
}

const esc = (x: string) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Часть значения формулы → HTML. Подпись остаётся картинкой: в файле Ворда она
// живёт как data-URI, поэтому доходит до получателя вместе с документом.
const segHtml = (s: FormulaSegment): string =>
  s.kind === 'image'
    ? `<img src="${s.src}" alt="подпись" style="height:${s.heightMm}mm;vertical-align:baseline" />`
    : esc(s.text);

// Подстановка значений в HTML шаблона: чипы <span data-field="..."> и
// <span data-formula="..."> заменяются на значения из контекста. Остальная
// вёрстка (текст, стили, выравнивание) сохраняется как есть.
export function renderTitleHtml(templateHtml: string, ctx: TitleContext, catalog: FormulaCatalog = {}): string {
  if (!templateHtml) return '';
  let html = templateHtml;
  // Именованные формулы: подпись становится картинкой, остальное — текстом.
  // Удалённая формула не ломает документ: остаётся зачёркнутая метка, чтобы
  // человек увидел, что здесь было значение, и заменил его осознанно.
  html = html.replace(/<span[^>]*data-formula-id="([^"]*)"[^>]*>([\s\S]*?)<\/span>/g, (_m, id, label) => {
    const out = renderFormula(catalog[decodeAttr(id)], ctx as FormulaContext, catalog);
    if (out.kind === 'missing') {
      return `<span style="text-decoration:line-through;opacity:.55" title="Формула удалена">${label}</span>`;
    }
    // rich — сборка с подписью внутри: «Раупов Х.Х.» и рядом картинка
    if (out.kind === 'rich') return out.segments.map(segHtml).join('');
    return segHtml(out);
  });
  // Старые формулы-выражения
  html = html.replace(/<span[^>]*data-formula="([^"]*)"[^>]*>[\s\S]*?<\/span>/g, (_m, expr) =>
    esc(evalFormula(decodeAttr(expr), ctx)));
  // Простые поля
  html = html.replace(/<span[^>]*data-field="([^"]*)"[^>]*>[\s\S]*?<\/span>/g, (_m, key) =>
    esc(String(ctx[key] ?? '')));
  return html;
}

/**
 * Какие формулы стоят на листе. По ним подтягиваем каталог и сотрудников:
 * без этого именованные плашки печатались зачёркнутыми, а подпись выбранного
 * сотрудника — пустой, потому что его не было в контексте.
 */
export function usedFormulaIds(templateHtml: string): string[] {
  const out = new Set<string>();
  const re = /data-formula-id="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(templateHtml || '')))) {
    const id = decodeAttr(m[1]).trim();
    if (id) out.add(id);
  }
  return [...out];
}

// Атрибуты в HTML экранированы (&quot; и т.д.) — раскодируем для формулы
function decodeAttr(x: string): string {
  return String(x || '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// HTML-чип поля для вставки в contenteditable редактор титула
export function fieldChipHtml(key: string): string {
  return `<span data-field="${key}" contenteditable="false" class="tt-chip">${esc(fieldTitle(key))}</span>`;
}
/**
 * Плашка именованной формулы. В документе видно название, настройка живёт в
 * карточке формулы. Идентификатор, а не название, — чтобы переименование не
 * ломало уже расставленные плашки.
 */
export function namedChipHtml(formula: { id: string; name: string; kind?: string }): string {
  const cls = formula.kind === 'signature' ? 'tt-chip tt-chip-sign' : 'tt-chip tt-chip-fx';
  return `<span data-formula-id="${esc(formula.id)}" contenteditable="false" class="${cls}">${esc(formula.name)}</span>`;
}

export function formulaChipHtml(expr: string): string {
  const safe = String(expr).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<span data-formula="${safe}" contenteditable="false" class="tt-chip tt-chip-fx">ƒ ${esc(expr)}</span>`;
}
