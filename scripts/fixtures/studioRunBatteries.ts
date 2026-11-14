/**
 * Батареи проверок полного запуска в Studio (scripts/test-studio-run-full.ts): каждая принимает реализацию классов параметром,
 * поэтому тот же набор прогоняется на настоящих файлах и на мутантах (копии с одной сломанной защитой): мутант обязан уронить
 * хотя бы одну проверку своей батареи.
 *
 * Серверы настоящие и локальные; COM подставной (scripts/fixtures/fakeCom.ts); движок Studio — настоящий рабочий поток.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import type { ModuleManifest } from '../../modules/contract';
import { LIMITS } from '../../modules/engine/types';
import { PAGE_LIMITS } from '../../modules/page/model';
import type { ConnectDecision, RunEvent } from '../../studio/shared/runActions';
import type { RunConnections } from '../../studio/shell/runConnections';
import type { RunPrograms } from '../../studio/shell/runPrograms';
import type { RunFileSaver } from '../../studio/shell/runSaveFile';
import type { createControlsEngine } from '../../studio/shared/controlsEngine';
import { RunJournal } from '../../studio/shell/runJournal';
import { fluxModule, WASM_OPS as OP, wasmSleb } from './wasmBuilder';
import { FakeCom } from './fakeCom';

export interface Impl {
  RunConnections: typeof RunConnections; RunPrograms: typeof RunPrograms; RunFileSaver: typeof RunFileSaver;
  createControlsEngine: typeof createControlsEngine; workerFile: string;
}
export interface Tally { check(name: string, value: unknown): void; failed: string[]; count: number }
export function tally(print = false): Tally {
  const t: Tally = { failed: [], count: 0, check(name, value) { t.count++; if (print) console.log(`  ${value ? '✓' : '✗'} ${name}`); if (!value) t.failed.push(name); } };
  return t;
}
const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Серверы ───────────────────────────────────────────────────────────────────
export interface Servers { apiPort: number; wsPort: number; hits: () => number; sockets: () => number; close: () => Promise<void> }
export async function startServers(): Promise<Servers> {
  let hits = 0, sockets = 0;
  const api = http.createServer((q, r) => { hits++; r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ path: q.url })); });
  await new Promise<void>(r => api.listen(0, '127.0.0.1', () => r()));
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(r => wss.on('listening', r));
  wss.on('connection', socket => { sockets++; socket.on('close', () => { sockets--; }); socket.on('message', d => socket.send(`эхо:${d}`)); });
  return {
    apiPort: (api.address() as any).port, wsPort: (wss.address() as any).port, hits: () => hits, sockets: () => sockets,
    close: async () => { wss.close(); api.close(); },
  };
}

const NAMES = { app: 'Сервер расчётов', does: 'Отправляет на сервер расчётов номер проекта и получает ответ' };
export const declarations = (s: Servers) => ({
  http: (access = 'send') => ({ id: 'api', kind: 'http', url: `http://127.0.0.1:${s.apiPort}`, pathPrefix: '/api', ...NAMES, access }),
  ws: { id: 'live', kind: 'ws', url: `ws://127.0.0.1:${s.wsPort}`, pathPrefix: '/', app: 'Сервер событий', does: 'Получает уведомления о расчётах', access: 'read' },
  fso: { id: 'fso', kind: 'com', progId: 'Scripting.FileSystemObject', allowDangerous: true, app: 'Файловые имена Windows', does: 'Разбирает имена файлов на части, не читая и не записывая диск', access: 'read' },
  meta: { id: 'meta', kind: 'http', url: 'http://169.254.169.254:80', pathPrefix: '/', ...NAMES, access: 'read' },
});
export const runManifest = (connections: unknown[], extra: Record<string, unknown> = {}): ModuleManifest =>
  ({ id: 'conn-run', name: 'Запуск с подключениями', version: '1.0.0', author: 'Разработчик', contractVersion: 1, entries: ['start'], reads: [], logic: 'logic/main.ts', connections, ...extra }) as unknown as ModuleManifest;

// ── Подключения ───────────────────────────────────────────────────────────────
export async function connectionsBattery(impl: Impl, s: Servers, print = false): Promise<Tally> {
  const t = tally(print), d = declarations(s);
  const rig = (policy: ConnectDecision | 'ignore', connections: unknown[] = [d.http(), d.ws, d.fso, d.meta]) => {
    const events: RunEvent[] = [], com = new FakeCom();
    const state = { policy, ctx: { id: 'run-1', manifest: runManifest(connections) } as { id: string; manifest: ModuleManifest } | null };
    const rc: RunConnections = new impl.RunConnections({
      current: () => state.ctx, journal: new RunJournal(), com: () => com, askTimeoutMs: 150,
      emit: e => { events.push(e); if (e.kind === 'connectAsk' && state.policy !== 'ignore') { const decision = state.policy; setImmediate(() => rc.answer(e.id, decision)); } },
    });
    return { rc, events, state, com, asks: () => events.filter(e => e.kind === 'connectAsk').length };
  };
  const ping = { op: 'http', method: 'GET', path: '/api/ping' };
  const code = (r: any) => r.ok ? 'ok' : r.code;
  const touched: string[] = [];
  const realWrite = fs.promises.writeFile, realRename = fs.promises.rename, realRead = fs.promises.readFile;
  const note = (file: unknown) => { touched.push(String(file)); };
  fs.promises.writeFile = ((file: any, ...rest: any[]) => { note(file); return (realWrite as any)(file, ...rest); }) as any;
  fs.promises.rename = ((a: any, ...rest: any[]) => { note(a); return (realRename as any)(a, ...rest); }) as any;
  fs.promises.readFile = ((file: any, ...rest: any[]) => { note(file); return (realRead as any)(file, ...rest); }) as any;
  try {
    // Человек не ответил: отказ без запоминания, окно получило вопрос и его снятие, до сервера вызов не дошёл
    const a = rig('ignore'); const h0 = s.hits();
    t.check('нет ответа человека — NOT_ALLOWED, сервер не тронут', code(await a.rc.call({ connection: 'api', call: ping })) === 'NOT_ALLOWED' && s.hits() === h0);
    t.check('вопрос ушёл окну и был снят по истечении времени', a.asks() === 1 && a.events.some(e => e.kind === 'connectAskClose'));
    t.check('молчание не запоминается: следующий вызов снова спрашивает', code(await a.rc.call({ connection: 'api', call: ping })) === 'NOT_ALLOWED' && a.asks() === 2);
    const ask = a.events.find(e => e.kind === 'connectAsk') as Extract<RunEvent, { kind: 'connectAsk' }>;
    t.check('вопрос строится по манифесту: тексты объявления и вид, без чужих полей', ask.ask.app === NAMES.app && ask.ask.does === NAMES.does && ask.ask.kind === 'http' && ask.ask.access === 'send' && ask.ask.connection === 'api');
    t.check('ответ на снятый вопрос не принимается', a.rc.answer(ask.id, 'always') === false);

    // «Не разрешать» запоминается
    const n = rig('never');
    t.check('«не разрешать» — NOT_ALLOWED', code(await n.rc.call({ connection: 'api', call: ping })) === 'NOT_ALLOWED' && s.hits() === h0);
    t.check('«не разрешать» помнится: второй вызов без вопроса', code(await n.rc.call({ connection: 'api', call: ping })) === 'NOT_ALLOWED' && n.asks() === 1 && s.hits() === h0);

    // «Всегда»: данные приходят, вопрос один, память живёт дольше запуска и привязана к тексту разрешения
    const y = rig('always');
    const first: any = await y.rc.call({ connection: 'api', call: { op: 'http', method: 'POST', path: '/api/calc?x=1', body: 'привет' } });
    t.check('«всегда»: ответ сервера как есть', first.ok && first.data.status === 200 && JSON.parse(first.data.body).path === '/api/calc?x=1');
    t.check('второй вызов без вопроса', code(await y.rc.call({ connection: 'api', call: ping })) === 'ok' && y.asks() === 1);
    await y.rc.closeRun('run-1'); y.state.ctx = { id: 'run-2', manifest: runManifest([d.http(), d.ws, d.fso, d.meta]) };
    t.check('«всегда» помнится и в новом запуске той же программы', code(await y.rc.call({ connection: 'api', call: ping })) === 'ok' && y.asks() === 1);
    y.state.ctx = { id: 'run-2', manifest: runManifest([d.http('write'), d.ws, d.fso, d.meta]) };
    t.check('текст разрешения изменился (читать → изменять) — вопрос заново', code(await y.rc.call({ connection: 'api', call: ping })) === 'ok' && y.asks() === 2);

    // «Только сейчас»: до закрытия запуска
    const o = rig('once');
    t.check('«только сейчас» пропускает', code(await o.rc.call({ connection: 'api', call: ping })) === 'ok' && code(await o.rc.call({ connection: 'api', call: ping })) === 'ok' && o.asks() === 1);
    await o.rc.closeRun('run-1'); o.state.ctx = { id: 'run-2', manifest: runManifest([d.http(), d.ws, d.fso, d.meta]) };
    t.check('«только сейчас» кончилось с запуском: вопрос заново', code(await o.rc.call({ connection: 'api', call: ping })) === 'ok' && o.asks() === 2);

    // Параллельные вызовы делят один вопрос
    const p = rig('always');
    await Promise.all([p.rc.call({ connection: 'api', call: ping }), p.rc.call({ connection: 'api', call: ping }), p.rc.call({ connection: 'api', call: ping })]);
    t.check('три вызова подряд — один вопрос, а не три окна', p.asks() === 1);

    // Ответ окна: только три решения, чужое слово не принимается и вопрос остаётся
    const w = rig('ignore'); const pending = w.rc.call({ connection: 'api', call: ping }); await wait(20);
    const asked = w.events.find(e => e.kind === 'connectAsk') as any;
    t.check('неизвестное решение не принимается, вопрос не снят', w.rc.answer(asked.id, 'allow-everything') === false && w.rc.answer(asked.id, undefined) === false && w.rc.answer(42, 'always') === false);
    t.check('после этого верный ответ принимается', w.rc.answer(asked.id, 'never') === true && code(await pending) === 'NOT_ALLOWED');

    // Необъявленное, вид вызова, закрытый адрес, белый список COM
    const u = rig('always'); const h1 = s.hits();
    t.check('необъявленное подключение — DENIED без вопроса и без обращения к серверу', code(await u.rc.call({ connection: 'nope', call: ping })) === 'DENIED' && u.asks() === 0 && s.hits() === h1);
    t.check('вид вызова не совпадает с объявлением (COM на HTTP) — DENIED', code(await u.rc.call({ connection: 'api', call: { op: 'com-open' } })) === 'DENIED');
    t.check('адрес внутри вызова (чужая форма) — DENIED', code(await u.rc.call({ connection: 'api', call: { ...ping, url: 'http://evil.test' } })) === 'DENIED');
    t.check('путь вне префикса — TARGET, сервер не тронут', code(await u.rc.call({ connection: 'api', call: { op: 'http', method: 'GET', path: '/admin' } })) === 'TARGET' && s.hits() === h1);
    t.check('адрес облачных метаданных закрыт даже объявленным и разрешённым — TARGET', code(await u.rc.call({ connection: 'meta', call: { op: 'http', method: 'GET', path: '/latest' } })) === 'TARGET');
    const bad = rig('always', [{ ...d.fso, allowDangerous: undefined }]);
    t.check('опасный COM без allowDangerous: объявление не принимается, всё DENIED, помощник не тронут', code(await bad.rc.call({ connection: 'fso', call: { op: 'com-open' } })) === 'DENIED' && bad.com.calls.length === 0);
    const shell = rig('always', [{ ...d.fso, id: 'sh', progId: 'WScript.Shell', allowDangerous: undefined }]);
    t.check('WScript.Shell без флага — DENIED', code(await shell.rc.call({ connection: 'sh', call: { op: 'com-open' } })) === 'DENIED');
    const nobody = new impl.RunConnections({ current: () => null, emit: () => {}, journal: new RunJournal(), com: () => new FakeCom() });
    t.check('запуска нет — DENIED со строкой для журнала', await nobody.call({ connection: 'api', call: ping }).then((r: any) => r.code === 'DENIED' && /не запущена/.test(r.line)));
    const line: any = await u.rc.call({ connection: 'nope', call: ping });
    t.check('у отказа есть строка для журнала запуска', typeof line.line === 'string' && /nope/.test(line.line) && !/url|127\.0\.0\.1/.test(line.line));
    t.check('отказ человека: строка про отсутствие политики администратора в Studio', /Политики администратора в Studio нет/.test(((await n.rc.call({ connection: 'api', call: ping })) as any).line));

    // Пределы
    const l = rig('always'); await l.rc.call({ connection: 'api', call: ping });
    const burst = await Promise.all(Array.from({ length: 30 }, () => l.rc.call({ connection: 'api', call: ping })));
    t.check('частота и одновременные вызовы: сверх пределов — LIMIT', burst.filter(r => code(r) === 'LIMIT').length >= 10);

    // WebSocket и COM: открыть, пользоваться, закрыть запуск — всё закрылось
    const c = rig('always'); await wait(1100);
    const open: any = await c.rc.call({ connection: 'live', call: { op: 'ws-open', path: '/events' } });
    await c.rc.call({ connection: 'live', call: { op: 'ws-send', socket: open.data.socket, data: 'ку' } });
    const got: any = await c.rc.call({ connection: 'live', call: { op: 'ws-recv', socket: open.data.socket, timeoutMs: 3000 } });
    t.check('WebSocket: открыть, послать, получить', open.ok && got.ok && got.data.data === 'эхо:ку' && s.sockets() === 1);
    const handle: any = await c.rc.call({ connection: 'fso', call: { op: 'com-open' } });
    const base: any = await c.rc.call({ connection: 'fso', call: { op: 'com-call', handle: handle.data.handle, name: 'GetBaseName', args: ['C:\\dir\\файл.txt'] } });
    t.check('COM: открыть объект, вызвать метод', handle.ok && base.ok && base.data.value === 'файл');
    t.check('чужой номер объекта COM — DENIED', code(await c.rc.call({ connection: 'fso', call: { op: 'com-call', handle: 999, name: 'GetBaseName', args: ['x'] } })) === 'DENIED');
    await c.rc.closeRun('run-1'); await wait(150);
    t.check('закрытие запуска закрыло сокет', s.sockets() === 0);
    t.check('закрытие запуска освободило объект COM', c.com.released.includes(handle.data.handle));
    const m = rig('always'); await wait(1100);
    const many: any[] = [];
    for (let i = 0; i < 5; i++) many.push(await m.rc.call({ connection: 'fso', call: { op: 'com-open' } }));
    t.check('открытых подключений не больше четырёх — пятое LIMIT', many.slice(0, 4).every(r => r.ok) && code(many[4]) === 'LIMIT');
    await m.rc.shutdown();

    t.check('файлы Flux (grants.json, journal.json, selection.json) не читались и не писались', !touched.some(f => /grants\.json|journal\.json|selection\.json/.test(f)));
  } finally { fs.promises.writeFile = realWrite; fs.promises.rename = realRename; fs.promises.readFile = realRead; }
  return t;
}

// ── Вторая программа ──────────────────────────────────────────────────────────
const DOES = 'Берёт у калькулятора курсов пересчёт сумм для отчёта';
export const methodsOf = (...methods: string[]) => methods.map(method => ({ method, does: `Метод ${method} считает значение по входным данным` }));
export const TS_CALLEE = `
let counter = 0;
const out = (value: unknown) => ({ state: {}, calc: { out: value } });
export async function compute(input: { export?: string; data: any }) {
  switch (input.export) {
    case 'convert': return out({ value: Math.round(input.data.amount * input.data.rate * 100) / 100, by: 'typescript', calls: ++counter });
    case 'spin': for (;;) { /* бесконечный цикл */ }
    case 'huge': return out({ text: 'я'.repeat(300000) });
    case 'crash': throw new Error('СЕКРЕТ-В-ОШИБКЕ');
    case 'mem': { const keep: number[][] = []; for (let i = 0; i < 60; i++) keep.push(new Array(1_000_000).fill(7)); return out({ survived: keep.length }); }
    case 'keys': return out({ keys: Object.keys(input).sort() });
    case 'probe': {
      const escape = (() => { try { return (globalThis as any).constructor.constructor('return typeof process')(); } catch { return 'blocked'; } })();
      const imported = await (0, eval)('import("node:fs")').then(() => 'imported', () => 'blocked');
      return out({ process: typeof process, require: typeof require, fetch: typeof fetch, flux: typeof (globalThis as any).flux, escape, imported });
    }
    default: return out({ method: input.export });
  }
}
`;
const WASM_OUT = '{"state":{},"calc":{"out":{"ok":true,"by":"wasm"}}}';
export const wasmConstant = () => fluxModule({ output: WASM_OUT });
export const wasmSpinning = () => fluxModule({ output: WASM_OUT, run: [OP.loop, 0x40, OP.br, 0, OP.end, OP.i32const, ...wasmSleb(WASM_OUT.length)] });
const calleeFiles = (id: string, language: 'typescript' | 'python' | 'wasm', methods: string[], logic: Uint8Array | string) => {
  const file = language === 'typescript' ? 'logic/main.ts' : language === 'python' ? 'logic/main.py' : 'logic/main.wasm';
  const manifest = { id, name: `Программа ${id}`, version: '1.0.0', author: 'Автор', contractVersion: 3, entries: ['start'], reads: [], logic: file, ...(language === 'typescript' ? {} : { language }), exports: methodsOf(...methods) };
  return { manifest: manifest as unknown as ModuleManifest, files: { 'manifest.json': enc(JSON.stringify(manifest)), [file]: typeof logic === 'string' ? enc(logic) : logic } };
};
export const callerManifest = (programs: string[]) => ({ id: 'caller-app', name: 'Вызывающая', version: '1.0.0', author: 'Автор', contractVersion: 3, entries: ['start'], reads: [], logic: 'logic/main.ts',
  permissions: programs.map(program => ({ kind: 'program', program, does: DOES })) }) as unknown as ModuleManifest;

export async function programsBattery(impl: Impl, print = false): Promise<Tally> {
  const t = tally(print);
  const engine = impl.createControlsEngine({ workerFile: impl.workerFile, timeoutMs: 1500 });
  const journal = new RunJournal();
  let clock = 1_000_000;
  const state = { ctx: { id: 'run-p', manifest: callerManifest(['rates-ts', 'rates-wasm', 'rates-spin', 'rates-py', 'ghost']) } as { id: string; manifest: ModuleManifest } | null };
  const rp: RunPrograms = new impl.RunPrograms({ current: () => state.ctx, engine, journal, now: () => clock });
  rp.install(calleeFiles('rates-ts', 'typescript', ['convert', 'spin', 'huge', 'crash', 'keys', 'probe'], TS_CALLEE));
  rp.install(calleeFiles('rates-wasm', 'wasm', ['convert'], wasmConstant()));
  rp.install(calleeFiles('rates-spin', 'wasm', ['spin'], wasmSpinning()));
  rp.install(calleeFiles('rates-py', 'python', ['convert'], 'def compute(input):\n    return {"state": {}, "calc": {"out": {}}}\n'));
  rp.install(calleeFiles('rates-other', 'wasm', ['convert'], wasmConstant()));
  const call = (program: string, method: string, data?: unknown) => { clock += 150; return rp.call({ call: { program, method, data } }); };
  const code = (r: any) => r.ok ? 'ok' : r.code;

  const ts: any = await call('rates-ts', 'convert', { amount: 5, rate: 0.9 });
  t.check('метод на TypeScript отвечает', ts.ok && ts.data.value === 4.5 && ts.data.by === 'typescript');
  t.check('состояния между вызовами нет: счётчик снова 1', ((await call('rates-ts', 'convert', { amount: 1, rate: 1 })) as any).data.calls === 1);
  const wasm: any = await call('rates-wasm', 'convert', { amount: 5 });
  t.check('метод на WebAssembly отвечает', wasm.ok && wasm.data.by === 'wasm');
  t.check('метод видит только export и data', JSON.stringify(((await call('rates-ts', 'keys', { a: 1 })) as any).data.keys) === '["data","export"]');
  const probe: any = await call('rates-ts', 'probe');
  t.check('в методе на TypeScript нет process, require, fetch, flux и import() наружу', probe.ok && probe.data.process === 'undefined' && probe.data.require === 'undefined' && probe.data.fetch === 'undefined'
    && probe.data.flux === 'undefined' && probe.data.imported === 'blocked' && probe.data.escape !== 'object');
  t.check('вызываемая не установлена — NOT_INSTALLED', code(await call('ghost', 'convert')) === 'NOT_INSTALLED');
  t.check('нет разрешения program — NOT_ALLOWED', code(await call('rates-other', 'convert')) === 'NOT_ALLOWED');
  t.check('вызов самой себя — NOT_ALLOWED', code(await call('caller-app', 'convert')) === 'NOT_ALLOWED');
  t.check('метод не объявлен в exports — NO_METHOD', code(await call('rates-wasm', 'other')) === 'NO_METHOD');
  t.check('данные больше 256 КиБ — LIMIT', code(await call('rates-ts', 'convert', { text: 'я'.repeat(300 * 1024) })) === 'LIMIT');
  t.check('ответ больше 256 КиБ — LIMIT', code(await call('rates-ts', 'huge')) === 'LIMIT');
  const [spinTs, spinWasm] = await Promise.all([call('rates-ts', 'spin'), call('rates-spin', 'spin')]);
  t.check('бесконечный метод на TypeScript — TIMEOUT', code(spinTs) === 'TIMEOUT');
  t.check('бесконечный метод на WebAssembly — TIMEOUT', code(spinWasm) === 'TIMEOUT');
  const crash: any = await call('rates-ts', 'crash', { secret: 'СЕКРЕТ-ДАННЫЕ' });
  t.check('падение метода — FAILED; код и подпись ошибки не уходят программе, а строка для журнала есть', crash.code === 'FAILED' && !JSON.stringify({ ok: crash.ok, code: crash.code }).includes('СЕКРЕТ') && /FAILED/.test(crash.line));
  const py: any = await call('rates-py', 'convert');
  t.check('метод на Python — FAILED и подсказка про «Запустить во Flux»', py.code === 'FAILED' && /Запустить во Flux/.test(py.line) && /Python/.test(py.line));
  const shape: any = await rp.call({ call: { program: 'Rates', method: 'bad method' } });
  t.check('вызов неверной формы — FAILED со строкой про форму', shape.code === 'FAILED' && /неверной формы/.test(shape.line));
  t.check('журнал не хранит содержимое вызовов', !JSON.stringify(journal.entries).includes('СЕКРЕТ'));
  t.check('отказы без Python: строка для журнала называет программу и метод', ((await call('ghost', 'convert')) as any).line.includes('«ghost».convert'));
  const before = clock;
  const burst = await Promise.all(Array.from({ length: 30 }, () => rp.call({ call: { program: 'rates-wasm', method: 'convert' } })));
  t.check('сверх 4 одновременных и 20 в секунду — LIMIT', burst.filter(r => code(r) === 'LIMIT').length >= 5 && clock === before);
  clock += 5000;
  t.check('после паузы вызовы снова идут', code(await call('rates-wasm', 'convert')) === 'ok');
  rp.remove('rates-wasm');
  t.check('убранная программа — NOT_INSTALLED', code(await call('rates-wasm', 'convert')) === 'NOT_INSTALLED' && rp.isInstalled('rates-wasm') === false && rp.isInstalled('rates-ts') === true);
  state.ctx = null;
  t.check('запуска нет — отказ словами', await rp.call({ call: { program: 'rates-ts', method: 'convert' } }).then(() => false, (e: any) => /не запущена/.test(e.message)));
  return t;
}

// ── Файл пользователю ─────────────────────────────────────────────────────────
export async function saveBattery(impl: Impl, print = false): Promise<Tally> {
  const t = tally(print);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-run-save-'));
  const written: string[] = [];
  let dialogs = 0, choose: (options: { title: string; defaultName: string }) => Promise<string | null> = async o => path.join(dir, o.defaultName);
  const saver: RunFileSaver = new impl.RunFileSaver(async o => { dialogs++; return choose(o); }, async (file, bytes) => {
    written.push(file);
    // Мутант может пропустить относительный путь: в рабочую папку набор не пишет никогда
    if (path.isAbsolute(file)) fs.writeFileSync(file, bytes);
  });
  const bytes = enc('содержимое');
  const refuses = (args: any) => saver.save('Программа', args).then(() => false, () => true);
  t.check('сохранение: диалог главного процесса, файл записан по выбранному пути', await saver.save('Программа', { name: 'отчёт.txt', mime: 'text/plain', bytes }) === 'saved' && fs.readFileSync(path.join(dir, 'отчёт.txt'), 'utf8') === 'содержимое' && dialogs === 1);
  let title = '';
  choose = async o => { title = o.title; return null; };
  t.check('отказ человека — cancelled, файла нет, в заголовке диалога название программы и размер', await saver.save('Калькулятор', { name: 'b.txt', bytes }) === 'cancelled' && !fs.existsSync(path.join(dir, 'b.txt')) && /Калькулятор/.test(title) && /КБ/.test(title));
  const before = dialogs;
  for (const name of ['../x.txt', 'a/b.txt', 'run.exe', 'a.bat', 'CON', 'con.txt', ' пробел.txt', 'точка.', '', 'x'.repeat(300)]) {
    t.check(`недопустимое имя «${name.slice(0, 12)}» — отказ до диалога`, await refuses({ name, bytes }));
  }
  t.check('диалог для плохих имён не открывался', dialogs === before);
  t.check('не байты — отказ', await refuses({ name: 'a.txt', bytes: 'строка' }) && await refuses({ name: 'a.txt', mime: 5, bytes }));
  const big = new Uint8Array(PAGE_LIMITS.saveChars + 1);
  t.check('файл больше предела Flux — cancelled без диалога', await saver.save('П', { name: 'big.bin', bytes: big }) === 'cancelled' && dialogs === before);
  choose = async o => path.join(dir, o.defaultName);
  t.check('ровно предел — принимается', await saver.save('П', { name: 'edge.bin', bytes: new Uint8Array(PAGE_LIMITS.saveChars) }) === 'saved');
  choose = async () => path.join(dir, 'переименован.exe');
  const w0 = written.length;
  t.check('человек переименовал в исполняемый тип — отказ, файл не записан', await refuses({ name: 'a.txt', bytes }) && written.length === w0 && !fs.existsSync(path.join(dir, 'переименован.exe')));
  choose = async () => 'относительный.txt';
  t.check('относительный путь из диалога — отказ', await refuses({ name: 'a.txt', bytes }) && written.length === w0);
  const releases: Array<(v: string | null) => void> = [];
  choose = () => new Promise<string | null>(r => { releases.push(r); });
  const first = saver.save('П', { name: 'one.txt', bytes });
  await wait(10);
  // Без защиты второй запрос тоже ждал бы диалога вечно: ждём его недолго, а не до конца набора
  const second = await Promise.race([saver.save('П', { name: 'two.txt', bytes }), wait(300).then(() => 'висит')]);
  t.check('второй запрос при открытом диалоге — cancelled, окно не дублируется', second === 'cancelled');
  releases.forEach(r => r(path.join(dir, 'one.txt')));
  t.check('первый после этого сохраняется', await first === 'saved');
  const none = new impl.RunFileSaver(undefined);
  t.check('нет диалога — cancelled', await none.save('П', { name: 'a.txt', bytes }) === 'cancelled');
  fs.rmSync(dir, { recursive: true, force: true });
  return t;
}

// ── Движок Studio: пределы Flux ───────────────────────────────────────────────
export async function engineBattery(impl: Impl, print = false): Promise<Tally> {
  const t = tally(print);
  const make = (options: Record<string, unknown> = {}) => impl.createControlsEngine({ workerFile: impl.workerFile, ...options });
  const tsFiles = (source: string) => ({ 'logic/main.ts': enc(source) });
  const codeOf = (promise: Promise<unknown>) => promise.then(() => 'ok', (e: any) => String(e?.code || 'CRASH'));
  const dflt = make();
  t.check('время расчёта — та же константа, что у Flux (LIMITS.timeoutMs)', dflt.limits?.timeoutMs === LIMITS.timeoutMs);
  t.check('куча потока JavaScript — 256 МиБ', dflt.limits?.heapMb === 256);
  const short = make({ timeoutMs: 1200 });
  t.check('бесконечный цикл TypeScript — TIMEOUT', await codeOf(short.compute('typescript', tsFiles(TS_CALLEE), 'logic/main.ts', { export: 'spin' })) === 'TIMEOUT');
  t.check('бесконечный цикл WebAssembly — TIMEOUT', await codeOf(short.compute('wasm', { 'logic/main.wasm': wasmSpinning() }, 'logic/main.wasm', { export: 'x' })) === 'TIMEOUT');
  t.check('память потока TypeScript ограничена: 480 МиБ не помещаются — MEMORY', await codeOf(make({ timeoutMs: 20_000 }).compute('typescript', tsFiles(TS_CALLEE), 'logic/main.ts', { export: 'mem' })) === 'MEMORY');
  t.check('собранный JS больше 1 МиБ не запускается — ABI', await codeOf(dflt.compute('typescript', tsFiles(`export function compute() { return { state: {}, calc: { out: {} } }; }\n// ${'х'.repeat(1_100_000)}`), 'logic/main.ts', {})) === 'ABI');
  const mem = (memory: { min: number; max?: number }) => ({ 'logic/main.wasm': fluxModule({ memory }) });
  t.check('память WebAssembly ровно в пределе Flux — считает', await codeOf(dflt.compute('wasm', mem({ min: 1, max: LIMITS.wasmMaxPages }), 'logic/main.wasm', {})) === 'ok');
  t.check('максимум памяти больше предела Flux — ABI', await codeOf(dflt.compute('wasm', mem({ min: 1, max: LIMITS.wasmMaxPages + 1 }), 'logic/main.wasm', {})) === 'ABI');
  t.check('память без максимума — ABI', await codeOf(dflt.compute('wasm', mem({ min: 1 }), 'logic/main.wasm', {})) === 'ABI');
  const probe: any = await dflt.compute('typescript', tsFiles(TS_CALLEE), 'logic/main.ts', { export: 'probe' });
  t.check('логика TypeScript исполняется без process, require, fetch и import() наружу', probe.calc.out.process === 'undefined' && probe.calc.out.require === 'undefined' && probe.calc.out.fetch === 'undefined'
    && probe.calc.out.imported === 'blocked' && probe.calc.out.escape !== 'object');
  return t;
}
