/**
 * Разбор JSON с номерами строк.
 *
 * JSON.parse называет только позицию в символах и по-английски; инженеру нужна строка и понятная
 * фраза. Разбор строгий, как у JSON.parse (комментариев и висящих запятых нет): то, что принял
 * этот разбор, примет и Flux. Вместе со значением запоминаются места ключей и значений, чтобы
 * ошибку схемы показать на той строке, где она допущена.
 */
export interface TextPlace { line: number; column: number }
export interface JsonProblem extends TextPlace { message: string }
export type JsonPath = Array<string | number>;

export interface ParsedJson {
  ok: boolean;
  value?: unknown;
  problem?: JsonProblem;
  /** Место значения по пути; несуществующий путь — ближайший существующий родитель */
  place(path: JsonPath, key?: boolean): TextPlace;
}

const keyOf = (path: JsonPath) => JSON.stringify(path);

export function parseJson(text: string): ParsedJson {
  const values = new Map<string, number>();
  const keys = new Map<string, number>();
  let i = 0;

  const placeAt = (offset: number): TextPlace => {
    let line = 1, start = 0;
    for (let at = 0; at < offset && at < text.length; at++) if (text[at] === '\n') { line++; start = at + 1; }
    return { line, column: offset - start + 1 };
  };
  class Stop extends Error { constructor(public offset: number, message: string) { super(message); } }
  const fail = (message: string, offset = i): never => { throw new Stop(offset, message); };
  const skip = () => { while (i < text.length && /[ \t\r\n]/.test(text[i])) i++; };
  const describe = (ch: string | undefined) => ch === undefined ? 'конец текста' : `«${ch}»`;

  const string = (): string => {
    const begin = i;
    i++;
    let out = '';
    for (;;) {
      if (i >= text.length || text[i] === '\n') fail('Строка не закрыта кавычкой «"»', begin);
      const ch = text[i];
      if (ch === '"') { i++; return out; }
      if (ch === '\\') {
        const next = text[i + 1];
        const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (next === 'u') {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('После «\\u» нужны четыре шестнадцатеричные цифры', i);
          out += String.fromCharCode(parseInt(hex, 16)); i += 6; continue;
        }
        if (next === undefined || !(next in map)) fail(`Недопустимая последовательность «\\${next ?? ''}» в строке`, i);
        out += map[next]; i += 2; continue;
      }
      if (ch < ' ') fail('Внутри строки недопустим управляющий символ', i);
      out += ch; i++;
    }
  };

  const number = (): number => {
    const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!match) fail(`Ожидалось число, найден ${describe(text[i])}`);
    i += match![0].length;
    return Number(match![0]);
  };

  const value = (path: JsonPath): unknown => {
    skip();
    values.set(keyOf(path), i);
    const ch = text[i];
    if (ch === '{') {
      i++; skip();
      const out: Record<string, unknown> = {};
      if (text[i] === '}') { i++; return out; }
      for (;;) {
        skip();
        if (text[i] === '}') fail('Лишняя запятая перед «}»', i);
        if (text[i] !== '"') fail(`Ожидалось имя поля в кавычках, найден ${describe(text[i])}`);
        const at = i;
        const name = string();
        keys.set(keyOf([...path, name]), at);
        skip();
        if (text[i] !== ':') fail(`После имени «${name}» ожидалось «:», найден ${describe(text[i])}`);
        i++;
        if (Object.hasOwn(out, name)) fail(`Поле «${name}» повторяется`, at);
        Object.defineProperty(out, name, { value: value([...path, name]), enumerable: true, writable: true, configurable: true });
        skip();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return out; }
        fail(`Ожидалось «,» или «}», найден ${describe(text[i])}`);
      }
    }
    if (ch === '[') {
      i++; skip();
      const out: unknown[] = [];
      if (text[i] === ']') { i++; return out; }
      for (;;) {
        skip();
        if (text[i] === ']') fail('Лишняя запятая перед «]»', i);
        out.push(value([...path, out.length]));
        skip();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return out; }
        fail(`Ожидалось «,» или «]», найден ${describe(text[i])}`);
      }
    }
    if (ch === '"') return string();
    for (const [word, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(word, i)) { i += word.length; return result; }
    }
    if (ch === undefined) fail('Текст оборвался: ожидалось значение');
    if (ch === '-' || (ch >= '0' && ch <= '9')) return number();
    return fail(ch === ',' || ch === '}' || ch === ']' ? `Здесь пропущено значение: найден ${describe(ch)}` : `Неожиданный символ ${describe(ch)}`);
  };

  const near = (path: JsonPath, map: Map<string, number>): TextPlace => {
    for (let n = path.length; n >= 0; n--) {
      const offset = map.get(keyOf(path.slice(0, n)));
      if (offset !== undefined) return placeAt(offset);
    }
    return { line: 1, column: 1 };
  };
  const place = (path: JsonPath, key = false): TextPlace => (key && keys.has(keyOf(path)) ? near(path, keys) : near(path, values));

  try {
    skip();
    if (i >= text.length) throw new Stop(0, 'Файл пуст: ожидалось описание формы в фигурных скобках');
    const result = value([]);
    skip();
    if (i < text.length) fail(`После описания формы лишний текст: ${describe(text[i])}`);
    return { ok: true, value: result, place };
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    return { ok: false, problem: { ...placeAt(error.offset), message: error.message }, place };
  }
}
