/**
 * Ручная сборка маленьких .wasm для проверок: без компиляторов, детерминированно.
 *
 * Нужна, чтобы проверять границы (запрещённый импорт, память без максимума,
 * бесконечный цикл, рост памяти) на модулях, которые написаны именно для
 * этого. Настоящие примеры на C, C++, Rust, Go и C# лежат в modules/fixtures.
 */
const leb = (n: number): number[] => {
  const out: number[] = [];
  do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n);
  return out;
};
const str = (s: string) => { const b = [...Buffer.from(s, 'utf8')]; return [...leb(b.length), ...b]; };
const vec = (items: number[][]) => [...leb(items.length), ...items.flat()];
const section = (id: number, body: number[]) => [id, ...leb(body.length), ...body];

type Val = 'i32' | 'i64' | 'f64';
const VAL: Record<Val, number> = { i32: 0x7f, i64: 0x7e, f64: 0x7c };
export interface WasmSpec {
  types: Array<{ params: Val[]; results: Val[] }>;
  imports?: Array<{ module: string; name: string; type: number } | { module: string; name: string; memory: { min: number; max?: number } }>;
  /** Тела функций: индекс типа и байты кода (без локальных переменных, если не заданы) */
  funcs: Array<{ type: number; code: number[]; locals?: Array<[number, Val]> }>;
  memory?: { min: number; max?: number };
  exports: Array<{ name: string; kind: 'func' | 'memory'; index: number }>;
  data?: Array<{ at: number; bytes: number[] }>;
}

export function buildWasm(spec: WasmSpec): Uint8Array {
  const out: number[] = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
  out.push(...section(1, vec(spec.types.map(t => [0x60, ...vec(t.params.map(p => [VAL[p]])), ...vec(t.results.map(p => [VAL[p]]))]))));
  if (spec.imports?.length) {
    out.push(...section(2, vec(spec.imports.map(i => 'memory' in i
      ? [...str(i.module), ...str(i.name), 2, ...(i.memory.max === undefined ? [0, ...leb(i.memory.min)] : [1, ...leb(i.memory.min), ...leb(i.memory.max)])]
      : [...str(i.module), ...str(i.name), 0, ...leb(i.type)]))));
  }
  out.push(...section(3, vec(spec.funcs.map(f => leb(f.type)))));
  if (spec.memory) {
    const m = spec.memory;
    out.push(...section(5, vec([m.max === undefined ? [0, ...leb(m.min)] : [1, ...leb(m.min), ...leb(m.max)]])));
  }
  out.push(...section(7, vec(spec.exports.map(e => [...str(e.name), e.kind === 'func' ? 0 : 2, ...leb(e.index)]))));
  out.push(...section(10, vec(spec.funcs.map(f => {
    const body = [...vec((f.locals || []).map(([n, t]) => [...leb(n), VAL[t]])), ...f.code, 0x0b];
    return [...leb(body.length), ...body];
  }))));
  if (spec.data?.length) {
    out.push(...section(11, vec(spec.data.map(d => [0, 0x41, ...sleb(d.at), 0x0b, ...leb(d.bytes.length), ...d.bytes]))));
  }
  return new Uint8Array(out);
}
const sleb = (n: number): number[] => {
  const out: number[] = [];
  for (;;) {
    const b = n & 0x7f; n >>= 7;
    if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) { out.push(b); return out; }
    out.push(b | 0x80);
  }
};

const OUT_AT = 2048;
const text = (s: string) => [...Buffer.from(s, 'utf8')];
const ok = '{"state":{},"calc":{"out":{"ok":true}}}';

/**
 * Модуль по контракту Flux с заданным телом `flux_run`. Выход — постоянная
 * строка в памяти; `flux_alloc` отдаёт область 1024..2047 для входа.
 */
export function fluxModule(opts: {
  run?: number[]; runLocals?: Array<[number, Val]>; memory?: { min: number; max?: number } | null; extraImports?: WasmSpec['imports'];
  output?: string;
} = {}): Uint8Array {
  const output = opts.output ?? ok;
  const imports = opts.extraImports || [];
  const funcImports = imports.filter(i => 'type' in i).length;
  return buildWasm({
    types: [{ params: ['i32'], results: ['i32'] }, { params: ['i32', 'i32'], results: ['i32'] }, { params: [], results: ['i32'] }, { params: ['i32', 'i32'], results: [] }],
    imports,
    funcs: [
      { type: 0, code: [0x41, ...sleb(1024)] },
      { type: 1, code: opts.run ?? [0x41, ...sleb(output.length)], locals: opts.runLocals },
      { type: 2, code: [0x41, ...sleb(OUT_AT)] },
    ],
    memory: opts.memory === null ? undefined : (opts.memory ?? { min: 1, max: 4 }),
    exports: [
      { name: 'memory', kind: 'memory', index: 0 },
      { name: 'flux_alloc', kind: 'func', index: funcImports },
      { name: 'flux_run', kind: 'func', index: funcImports + 1 },
      { name: 'flux_output', kind: 'func', index: funcImports + 2 },
    ],
    data: [{ at: OUT_AT, bytes: text(output) }],
  });
}
export const WASM_OPS = { loop: 0x03, br: 0x0c, end: 0x0b, i32const: 0x41, memoryGrow: [0x40, 0x00], drop: 0x1a, i32add: 0x6a, brIf: 0x0d, lt_s: 0x48, localGet: 0x20, localSet: 0x21, unreachable: 0x00 };
export { leb as wasmLeb, sleb as wasmSleb };
