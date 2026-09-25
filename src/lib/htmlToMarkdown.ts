/**
 * HTML → Markdown для Блокнота.
 *
 * Заметки хранились HTML прежнего редактора, письма приходят HTML. Новый
 * Блокнот (редактор Markdown Flux Office) пишет и читает Markdown, поэтому
 * старая заметка переводится при первом открытии, а письмо — при переносе в
 * Блокнот. Перевод свой и без DOM: он нужен и окну, и серверу (письмо
 * переводит сервер), и лишняя библиотека ради сотни строк ни к чему.
 *
 * Что переводится: заголовки, абзацы и переносы, жирный/курсив/зачёркнутый,
 * код, ссылки, картинки, списки (вложенные, нумерованные, с галочками),
 * цитаты, таблицы, черта. Всё прочее (стили, span, div, шрифты) — просто
 * текст: смысл важнее вида. script/style вырезаются целиком.
 */

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»',
  mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', deg: '°', times: '×', minus: '−',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Похоже ли содержимое заметки на HTML прежнего редактора, а не на Markdown */
export function looksLikeHtml(s: string): boolean {
  const t = String(s || '').trim();
  if (!t) return false;
  return /^<(p|div|h[1-6]|ul|ol|table|br|blockquote|pre|span|b|strong|i|em|hr|img|a)\b[^>]*>/i.test(t)
    || /<\/(p|div|li|td|h[1-6])>/i.test(t);
}

interface Node { tag: string; attrs: Record<string, string>; children: Array<Node | string> }

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) out[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  return out;
}

const lastIndex = <T,>(a: T[], f: (x: T) => boolean): number => {
  for (let i = a.length - 1; i >= 0; i--) if (f(a[i])) return i;
  return -1;
};

const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'col', 'wbr', 'source']);

/** Разбор в дерево: терпит незакрытые теги, как браузер */
function parse(html: string): Node {
  const root: Node = { tag: '#root', attrs: {}, children: [] };
  const stack: Node[] = [root];
  const src = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '');
  const re = /<\/?([a-zA-Z][\w-]*)([^>]*)>|([^<]+)|(<)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[3] !== undefined || m[4] !== undefined) { top.children.push(m[3] ?? '<'); continue; }
    const tag = m[1].toLowerCase();
    if (m[0][1] === '/') {
      const at = stack.map((n) => n.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      continue;
    }
    const node: Node = { tag, attrs: parseAttrs(m[2] || ''), children: [] };
    // Новый пункт списка или строка закрывает предыдущий незакрытый
    if (tag === 'li' || tag === 'tr' || tag === 'td' || tag === 'th' || tag === 'p') {
      const same = tag === 'td' || tag === 'th' ? ['td', 'th'] : [tag];
      const tags = stack.map((n) => n.tag);
      const at = lastIndex(tags, (t) => same.includes(t));
      const wall = lastIndex(tags, (t) => ['ul', 'ol', 'table', 'tbody', 'thead', 'tr', 'blockquote', 'div'].includes(t));
      if (at > 0 && at > wall) stack.length = at;
    }
    // Вершина могла смениться: незакрытый пункт только что закрыт
    stack[stack.length - 1].children.push(node);
    if (!VOID.has(tag) && !/\/\s*$/.test(m[2] || '')) stack.push(node);
  }
  return root;
}

const escapeText = (s: string): string => s.replace(/([\\`*_[\]<])/g, '\\$1');

function inline(n: Node | string, pre = false): string {
  if (typeof n === 'string') {
    const t = decodeEntities(n);
    return pre ? t : escapeText(t.replace(/\s+/g, ' '));
  }
  const kids = () => n.children.map((c) => inline(c, pre || n.tag === 'pre')).join('');
  const wrap = (mark: string) => {
    const body = kids();
    const trimmed = body.trim();
    if (!trimmed) return body;
    const lead = body.slice(0, body.indexOf(trimmed[0]));
    const tail = body.slice(body.lastIndexOf(trimmed[trimmed.length - 1]) + 1);
    return `${lead}${mark}${trimmed}${mark}${tail}`;
  };
  switch (n.tag) {
    // Жёсткий перенос строки Markdown — обратная косая в конце строки
    case 'br': return '\\\n';
    case 'b': case 'strong': return wrap('**');
    case 'i': case 'em': return wrap('*');
    case 's': case 'del': case 'strike': return wrap('~~');
    case 'code': return '`' + n.children.map((c) => inline(c, true)).join('').replace(/`/g, 'ˋ') + '`';
    case 'a': {
      const text = kids().trim();
      const href = n.attrs.href || '';
      if (!href || href.startsWith('javascript:')) return text;
      return `[${text || href}](${href.replace(/\s/g, '%20').replace(/\)/g, '%29')})`;
    }
    case 'img': {
      const src = n.attrs.src || '';
      return src && !src.startsWith('javascript:') ? `![${escapeText(n.attrs.alt || '')}](${src.replace(/\s/g, '%20')})` : '';
    }
    case 'input': return n.attrs.type === 'checkbox' ? ('checked' in n.attrs ? '[x] ' : '[ ] ') : '';
    default: return kids();
  }
}

const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'blockquote', 'pre', 'hr', 'section', 'article', 'header', 'footer', 'tr', 'thead', 'tbody']);

function hasBlocks(n: Node): boolean {
  return n.children.some((c) => typeof c !== 'string' && (BLOCK.has(c.tag) || hasBlocks(c)));
}

const clean = (s: string) => s.replace(/[ \t]+\n/g, '\n').replace(/\\\n(?=\s*(\n|$))/g, '\n').replace(/\n{3,}/g, '\n\n').trim().replace(/\\$/, '');

function list(n: Node, depth: number): string {
  const ordered = n.tag === 'ol';
  let i = Number(n.attrs.start) || 1;
  const pad = '   '.repeat(depth);
  const out: string[] = [];
  for (const c of n.children) {
    if (typeof c === 'string') { if (c.trim()) out.push(`${pad}- ${inline(c).trim()}`); continue; }
    if (c.tag !== 'li') { out.push(block(c, depth)); continue; }
    const own: Array<Node | string> = [];
    const nested: Node[] = [];
    for (const k of c.children) (typeof k !== 'string' && (k.tag === 'ul' || k.tag === 'ol') ? nested : own).push(k as any);
    let text = clean(own.map((k) => (typeof k !== 'string' && BLOCK.has(k.tag) ? block(k, depth + 1) : inline(k))).join('')).replace(/\n+/g, ' ');
    // Галочка прежнего редактора: data-checked у пункта
    if (c.attrs['data-checked'] !== undefined && !/^\[[ x]\] /.test(text)) text = (c.attrs['data-checked'] === 'true' ? '[x] ' : '[ ] ') + text;
    out.push(`${pad}${ordered ? `${i++}.` : '-'} ${text}`);
    for (const k of nested) out.push(list(k, depth + 1));
  }
  return out.join('\n');
}

function table(n: Node): string {
  const rows: string[][] = [];
  const walk = (x: Node) => {
    for (const c of x.children) {
      if (typeof c === 'string') continue;
      if (c.tag === 'tr') rows.push(c.children.filter((k): k is Node => typeof k !== 'string' && (k.tag === 'td' || k.tag === 'th'))
        .map((k) => clean(inline(k)).replace(/\n+/g, ' ').replace(/\|/g, '\\|')));
      else walk(c);
    }
  };
  walk(n);
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] || ' ').join(' | ')} |`;
  return [line(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
}

function block(n: Node | string, depth = 0): string {
  if (typeof n === 'string') return inline(n);
  switch (n.tag) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
      return `\n\n${'#'.repeat(Number(n.tag[1]))} ${clean(inline(n)).replace(/\n+/g, ' ')}\n\n`;
    case 'p': return `\n\n${clean(children(n, depth))}\n\n`;
    case 'hr': return '\n\n---\n\n';
    case 'br': return '\\\n';
    case 'ul': case 'ol': return `\n\n${list(n, depth)}\n\n`;
    case 'table': return `\n\n${table(n)}\n\n`;
    case 'pre': return `\n\n\`\`\`\n${decodeEntities(n.children.map((c) => (typeof c === 'string' ? c : inline(c, true))).join('')).replace(/\n$/, '')}\n\`\`\`\n\n`;
    case 'blockquote': return `\n\n${clean(children(n, depth)).split('\n').map((l) => `> ${l}`).join('\n')}\n\n`;
    case 'div': case 'section': case 'article': case 'header': case 'footer': case 'body': case 'html': case '#root':
      return hasBlocks(n) ? children(n, depth) : `\n\n${clean(children(n, depth))}\n\n`;
    default: return hasBlocks(n) ? children(n, depth) : inline(n);
  }
}

function children(n: Node, depth: number): string {
  return n.children.map((c) => (typeof c !== 'string' && (BLOCK.has(c.tag) || hasBlocks(c)) ? block(c, depth) : inline(c))).join('');
}

export function htmlToMarkdown(html: string): string {
  if (!html) return '';
  return clean(block(parse(String(html)))) + '\n';
}

/** Текст заметки для списка, поиска и карточек: без разметки Markdown и HTML */
export function noteText(content: string): string {
  const s = String(content || '');
  const md = looksLikeHtml(s) ? htmlToMarkdown(s) : s;
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\[[ x]\]\s/g, '')
    .replace(/^\|?\s*-{3,}.*$/gm, ' ')
    .replace(/[|*_~`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
