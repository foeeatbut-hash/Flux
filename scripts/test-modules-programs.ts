/**
 * Обращение программы к другой программе (`flux.programs.call`): две и более подписанные программы в настоящем кэше выпусков,
 * мост окна → сторона окна (moduleProgramCall) → главный процесс (ModuleProgramCalls) → очередь расчёта (ModuleCompute).
 *
 * Движки подставные: логика вызываемой программы на Python — функция по её идентификатору, а ПОДПИСАННЫЙ файл logic/main.py при этом
 * честно доставляется через `fetchFile` из проверенного выпуска. Настоящие Pyodide и WebAssembly проверяют наборы
 * test-modules-python / -wasm / -compute-native: здесь проверяется то, что вокруг них — разрешения, отказы, пределы, журнал.
 * Метод на TypeScript исполняется ПОДПИСАННЫМ build/logic.js, собранным настоящим esbuild, в новом контексте `vm` на каждый вызов
 * (модель хоста: без сети и `flux`, без состояния между вызовами, остановка по времени); настоящий изолированный кадр, Worker и
 * CSP проверяет test-modules-ts-host в Chromium.
 *
 * Каждая защита проверена мутацией: копия исходника с одной выключенной проверкой прогоняется через ту же батарею проверок,
 * и батарея обязана упасть. Мутант, который «проходит», означает, что проверка ничего не ловит.
 *
 * Запуск: npx tsx scripts/test-modules-programs.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { themeKeys, type ModuleManifest } from '../modules/contract';
import { validMessage } from '../modules/schemas';
import { createModuleBridge } from '../modules/bridge';
import { buildModuleLogic, buildPageAssets } from '../modules/build';
import { executionProblem } from '../modules/trust/execution';
import { PROGRAM_LIMITS, needsControls, needsLogicBuild, programPolicyTarget } from '../modules/programs/model';
import { ComputeError, LIMITS, LOGIC_BUILD_FILE } from '../modules/engine/types';
import { ComputeScheduler } from '../modules/engine/scheduler';
import { splitChunks } from '../modules/trust/bundle';
import { ModuleCache } from '../electron/moduleCache';
import { ModuleSelection } from '../electron/moduleSelection';
import { ModuleJournal } from '../electron/moduleJournal';
import { ModuleGrants } from '../electron/moduleGrants';
import { ModuleProgramCalls, currentRelease } from '../electron/moduleProgramCalls';
import type { VerifiedModule } from '../electron/moduleConnections';
import { INVOKE_CHANNELS } from '../electron/ipcAllow';
import { ModuleCompute } from '../src/services/moduleCompute';
import { createProgramCaller } from '../src/services/moduleProgramCall';
import { hexOf, moduleBundle, newKey, releaseEnvelope, revocationEnvelope } from './fixtures/moduleTrust';

let passed = 0;
const check = (name: string, condition: unknown) => { assert.ok(condition, name); passed++; console.log(`  ✓ ${name}`); };
let completed = false;
process.on('exit', () => { if (!completed) { console.error('ПРОВАЛ: проверка вызова программ не дошла до конца'); process.exitCode = 1; } });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-programs-'));
const root = newKey(), dev = hexOf(newKey());

// ── Подписанные выпуски ─────────────────────────────────────────────────────
const cache = new ModuleCache(path.join(dir, 'data'), hexOf(root));
const selection = new ModuleSelection(path.join(dir, 'selection.json'));
const DOES = 'Берёт у калькулятора курсов пересчёт сумм для отчёта';
const permit = (...programs: string[]) => programs.map(program => ({ kind: 'program', program, does: DOES }));
const controls = JSON.stringify({ version: 1, cases: [{ name: 'один', input: { v: 1 }, expect: { state: {}, calc: { out: { ok: true } } } }] });
const EXPORTS = ['convert', 'rateOn', 'setRate', 'slow', 'huge', 'crash', 'late', 'bad', 'relay'];
const TS_EXPORTS = ['convert', 'setRate', 'count', 'spin', 'huge', 'crash', 'bad', 'sealed'];
/** Логика метода на TypeScript: то, что разработчик пишет в logic/main.ts. Собирается настоящим esbuild (modules/build.ts), как build/logic.js */
const TS_LOGIC = `
let counter = 0;
const out = (value: unknown) => ({ state: {}, calc: { out: value } });
export function compute(input: { export: string; data: any }) {
  const g = globalThis as any, data = input.data;
  switch (input.export) {
    case 'convert': case 'setRate': return out({ value: Math.round(data.amount * (data.rate ?? 1) * 100) / 100, by: 'ts' });
    case 'count': g.__seen = (g.__seen ?? 0) + 1; return out({ module: ++counter, global: g.__seen });
    case 'spin': for (;;) { /* бесконечный цикл */ }
    case 'huge': return out({ text: 'я'.repeat(300000) });
    case 'crash': throw new Error('СЕКРЕТ-В-ОШИБКЕ');
    case 'bad': return undefined;
    case 'sealed': return out({ fetch: typeof g.fetch, xhr: typeof g.XMLHttpRequest, socket: typeof g.WebSocket, require: typeof g.require, process: typeof g.process, flux: typeof g.flux, document: typeof g.document });
    default: return out({ by: 'ts', method: input.export });
  }
}
`;
let tsBuilt = '';
async function tsLogicBuild() {
  if (tsBuilt) return tsBuilt;
  const folder = path.join(dir, 'ts-logic');
  fs.mkdirSync(path.join(folder, 'logic'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'logic/main.ts'), TS_LOGIC);
  return tsBuilt = await buildModuleLogic(folder, { id: 'x', name: 'x', version: '1.0.0', author: 'A', contractVersion: 3, entries: ['start'], reads: [], logic: 'logic/main.ts',
    exports: [{ method: 'convert', does: 'Метод считает значение по входным данным' }] } as unknown as ModuleManifest);
}
async function publish(id: string, version: string, patch: Record<string, unknown> = {}, channel: 'production' | 'test' = 'production') {
  const python = patch.language === 'python', typescript = patch.ts === true;
  const { ts: _flag, ...manifestPatch } = patch;
  const manifest = { id, name: `Программа ${id}`, contractVersion: 3, ...manifestPatch };
  // build/logic.js несёт метку выпуска: по ней видно, чья подписанная логика исполнилась
  const extra = python ? { 'logic/main.py': `# логика ${id} ${version}\n`, 'examples/controls.json': controls }
    : typescript ? { 'logic/main.ts': TS_LOGIC, 'build/logic.js': `${await tsLogicBuild()}/* логика ${id} ${version} */\n`, 'examples/controls.json': controls } : {};
  const bundle = moduleBundle(version, extra, { ...manifest, ...(python ? { logic: 'logic/main.py' } : {}) });
  const signature = releaseEnvelope(root, bundle, { moduleId: id, version, author: dev, channel, contractVersion: 3, language: python ? 'python' : undefined });
  const result = await cache.install({ id: `rel-${id}-${version}`, moduleId: id, version, signature }, splitChunks(bundle));
  assert.ok(result.ok, `${id}@${version}: ${result.why}`);
}
const exportsOf = (...methods: string[]) => ({ language: 'python', exports: methods.map(method => ({ method, does: `Метод ${method} считает значение по входным данным` })) });
const tsExportsOf = (...methods: string[]) => ({ ts: true, exports: methods.map(method => ({ method, does: `Метод ${method} считает значение по входным данным` })) });

async function main() {
  await selection.load(); await selection.activate('u1');
  await publish('rates', '1.0.0', exportsOf(...EXPORTS));
  await publish('prices', '1.0.0', exportsOf('convert'));
  await publish('chain', '1.0.0', { ...exportsOf('relay'), permissions: permit('rates') });
  await publish('bare', '1.0.0', { language: 'python' });
  await publish('ghosted', '1.0.0', exportsOf('convert'));
  await publish('beta', '1.0.0', exportsOf('convert'), 'test');
  await publish('broken', '1.0.0', exportsOf('convert'));
  await publish('tsrates', '1.0.0', tsExportsOf(...TS_EXPORTS));
  await publish('tscontrols', '1.0.0', tsExportsOf('convert'));
  await publish('report', '1.0.0', { permissions: permit('rates', 'chain', 'bare', 'ghosted', 'absent', 'beta', 'broken', 'tsrates', 'tscontrols', 'tsbig') });
  await publish('plain-caller', '1.0.0', {});
  for (const id of ['rates', 'prices', 'chain', 'bare', 'beta', 'broken', 'tsrates', 'tscontrols', 'report', 'plain-caller']) await selection.install(id, '1.0.0', { dirty: false });
  // 'ghosted' лежит в кэше проверенных, но человек её не ставил
  console.log('1. Подписанные выпуски');
  check('выпуски проверены и лежат в кэше', (await cache.runnable(['production', 'test'])).size === 11);
  const mine = await cache.resolve(selection.versions(), selection.channels);
  check('у человека запускаются установленные из рабочего канала; чужая, не установленная и тестовая — нет', mine.has('rates') && mine.has('report') && !mine.has('ghosted') && !mine.has('beta'));
  check('манифест exports и permissions дошёл из подписанного пакета', (mine.get('rates')!.manifest.exports || []).length === EXPORTS.length && (mine.get('report')!.manifest.permissions || []).length === 10);

  console.log('2. Батарея проверок на настоящих классах');
  const real = await battery('настоящий', ModuleProgramCalls, createModuleBridge);
  for (const name of real.passed) { passed++; console.log(`  ✓ ${name}`); }
  assert.deepEqual(real.failed, [], `батарея на настоящем коде упала: ${real.failed.join('; ')}`);

  console.log('3. Мутации: каждая защита выключается по одной, батарея обязана упасть');
  const mutants: Array<{ name: string; file: 'electron/moduleProgramCalls.ts' | 'modules/bridge.ts' | 'modules/programs/caller.ts' | 'src/services/moduleCompute.ts'; from: string; to: string }> = [
    { name: 'нет проверки разрешения program (главный процесс)', file: 'electron/moduleProgramCalls.ts', from: "if (!hasProgramPermission(caller.manifest, program)) return refuse('NOT_ALLOWED');", to: '' },
    { name: 'нет запрета администратора на обращение к программе', file: 'electron/moduleProgramCalls.ts', from: 'if (this.deps.deniedByPolicy?.(request.moduleId, programPolicyTarget(program))) {', to: 'if (false as boolean) {' },
    { name: 'нет запрета вызова самой себя', file: 'electron/moduleProgramCalls.ts', from: "if (program === request.moduleId) return refuse('NOT_ALLOWED');", to: '' },
    { name: 'нет запрета вложенного вызова', file: 'electron/moduleProgramCalls.ts', from: "if ((this.serving.get(request.moduleId) || 0) > 0) return refuse('NOT_ALLOWED');", to: '' },
    { name: 'нет предела 20 в секунду', file: 'electron/moduleProgramCalls.ts', from: '++slot.calls > PROGRAM_LIMITS.perSecond ||', to: '' },
    { name: 'нет предела 4 одновременно (главный процесс)', file: 'electron/moduleProgramCalls.ts', from: 'slot.inFlight >= PROGRAM_LIMITS.inFlight ||', to: '' },
    { name: 'нет предела 256 КиБ на данные (главный процесс)', file: 'electron/moduleProgramCalls.ts', from: '(bytes as number) > PROGRAM_LIMITS.bytes', to: 'false' },
    { name: 'не проверяется метод в exports', file: 'electron/moduleProgramCalls.ts', from: "if (!exportsOf(callee.manifest).some(e => e.method === method)) return refuse('NO_METHOD');", to: '' },
    { name: 'контрольные примеры вызываемой не проверяются перед методом (окно)', file: 'modules/programs/caller.ts', from: "if (await ipc.controls(begun.manifest) !== 'ok') throw new ComputeError('CONTROLS');", to: '' },
    { name: 'файл логики TypeScript больше 1 МиБ не останавливается окном', file: 'src/services/moduleCompute.ts', from: "if (target.language === 'typescript' && source.bytes.length > LIMITS.tsFileBytes) throw new ComputeError('ABI', 'файл логики больше 1 МиБ');", to: '' },
    { name: 'вызываемая берётся без проверки «установлена»', file: 'electron/moduleProgramCalls.ts', from: 'const release = installed[moduleId] ? runnable.get(moduleId) : undefined;', to: 'const release = runnable.get(moduleId);' },
    { name: 'вызываемая берётся без проверки контрольных примеров', file: 'electron/moduleProgramCalls.ts', from: 'return release && !blocked(release) ?', to: 'return release ?' },
    { name: 'место в пределах не освобождается по итогу', file: 'electron/moduleProgramCalls.ts', from: 'slot.inFlight = Math.max(0, slot.inFlight - 1);', to: '' },
    { name: 'зависшие вызовы не освобождают место сами', file: 'electron/moduleProgramCalls.ts', from: 'if (now - item.started > PROGRAM_LIMITS.staleMs) this.finish', to: 'if (false) this.finish' },
    { name: 'нет записи в журнал вызываемой', file: 'electron/moduleProgramCalls.ts', from: "this.record(item.callee, item.calleeVersion, item.user, 'export'", to: "void (item.callee, item.calleeVersion, item.user, 'export'" },
    { name: 'в журнал попадает содержимое метода', file: 'electron/moduleProgramCalls.ts', from: '`программа «${item.callee}» · ${item.method}`, outcome, ms', to: '`программа «${item.callee}» · ${item.method} ${JSON.stringify(item)}`, outcome, ms' },
    { name: 'окно не проверяет разрешение program', file: 'modules/bridge.ts', from: "if (!hasProgramPermission(options.manifest, message.call.program) || message.call.program === options.manifest.id) { fail('NOT_ALLOWED'); return; }", to: '' },
    { name: 'окно не ограничивает 4 вызова одновременно', file: 'modules/bridge.ts', from: 'calling.size >= PROGRAM_LIMITS.inFlight ||', to: '' },
    { name: 'окно не ограничивает данные 256 КиБ', file: 'modules/bridge.ts', from: ' || messageBytes(message.call.data ?? null) > PROGRAM_LIMITS.bytes', to: '' },
    { name: 'окно не ограничивает ответ 256 КиБ', file: 'modules/bridge.ts', from: 'messageBytes((reply as { data: unknown }).data ?? null) > PROGRAM_LIMITS.bytes || !validMessage', to: '!validMessage' },
  ];
  const stamp = `__mutant_${process.pid}`;
  let n = 0;
  for (const mutant of mutants) {
    const source = fs.readFileSync(mutant.file, 'utf8');
    assert.ok(source.includes(mutant.from), `мутант «${mutant.name}»: фрагмент не найден в ${mutant.file}`);
    const target = path.join(path.dirname(mutant.file), `${stamp}_${++n}.ts`);
    fs.writeFileSync(target, source.replace(mutant.from, mutant.to));
    try {
      const loaded = require(path.resolve(target));
      const is = (file: string) => mutant.file === file;
      const result = await battery(mutant.name, is('electron/moduleProgramCalls.ts') ? loaded.ModuleProgramCalls : ModuleProgramCalls,
        is('modules/bridge.ts') ? loaded.createModuleBridge : createModuleBridge, is('electron/moduleProgramCalls.ts') ? loaded.currentRelease : currentRelease,
        is('src/services/moduleCompute.ts') ? loaded.ModuleCompute : ModuleCompute, is('modules/programs/caller.ts') ? ((options: any, deps: any) => loaded.createProgramCallerWith(options, deps)) as typeof createProgramCaller : createProgramCaller);
      check(`мутация «${mutant.name}» замечена (${result.failed.length} проверок упало)`, result.failed.length > 0);
    } finally { fs.rmSync(target, { force: true }); }
  }

  console.log('3б. Проверка выпуска: методы на TypeScript требуют собранный build/logic.js и контрольные примеры');
  const exec = executionBattery(executionProblem);
  for (const name of exec.passed) { passed++; console.log(`  ✓ ${name}`); }
  assert.deepEqual(exec.failed, [], `проверка выпуска на настоящем коде упала: ${exec.failed.join('; ')}`);
  const execMutants: Array<{ name: string; from: string; to: string }> = [
    { name: 'метод на TypeScript не требует собранного файла', from: "if (!built?.length) return `exports: методам на TypeScript нужен собранный ${LOGIC_BUILD_FILE} (соберите программу в Studio или Flux)`;", to: '' },
    { name: 'метод на TypeScript не требует исходника', from: "if (!logic?.length) return `exports: методам на TypeScript нужен исходник ${LOGIC_FILES.typescript}`;", to: '' },
    { name: 'нет предела размера build/logic.js', from: "if (built.length > LIMITS.tsFileBytes) return `${LOGIC_BUILD_FILE} больше 1 МиБ`;", to: '' },
    { name: 'build/logic.js не обязан быть текстом UTF-8', from: "if (text === null) return `${LOGIC_BUILD_FILE} не в кодировке UTF-8`;", to: 'if (text === null) return "";' },
    { name: 'build/logic.js может быть чем угодно', from: "if (!text.includes('__fluxLogic')) return `${LOGIC_BUILD_FILE} не похож на собранную логику: его собирает Flux или Studio`;", to: '' },
    { name: 'метод на TypeScript без контрольных примеров', from: "if (!files[CONTROLS_FILE]?.length) return `Для методов на TypeScript нужны контрольные примеры: ${CONTROLS_FILE}`;", to: '' },
    { name: 'требования к методам на TypeScript выключены целиком', from: 'if (needsLogicBuild(manifest)) {', to: 'if (false as boolean) {' },
    { name: 'требования применяются и к TypeScript без exports (ломают прежние выпуски)', from: 'if (needsLogicBuild(manifest)) {', to: "if (languageOf(manifest) === 'typescript') {" },
  ];
  for (const mutant of execMutants) {
    const source = fs.readFileSync('modules/trust/execution.ts', 'utf8');
    assert.ok(source.includes(mutant.from), `мутант «${mutant.name}»: фрагмент не найден`);
    const target = path.join('modules/trust', `${stamp}_exec_${++n}.ts`);
    fs.writeFileSync(target, source.replace(mutant.from, mutant.to));
    try {
      // Мутант может не только вернуть «годно», но и упасть на пустом месте: падение — тоже замеченная поломка
      const result = (() => { try { return executionBattery(require(path.resolve(target)).executionProblem); } catch { return { passed: [], failed: ['упало'] }; } })();
      check(`мутация «${mutant.name}» замечена (${result.failed.length} проверок упало)`, result.failed.length > 0);
    } finally { fs.rmSync(target, { force: true }); }
  }
  const sample = [{ method: 'convert', does: 'Метод считает значение по входным данным' }];
  check('needsLogicBuild и needsControls: только TypeScript с exports', needsLogicBuild({ exports: sample }) && !needsLogicBuild({}) && !needsLogicBuild({ language: 'python', exports: sample })
    && needsControls({ language: 'wasm' }) && needsControls({ exports: sample }) && !needsControls({}));

  console.log('3а. Версия вызываемой — та, что запускается у человека');
  await publish('rates', '1.1.0', exportsOf(...EXPORTS));
  await selection.install('rates', '1.1.0', { dirty: false });
  const liveRunnable = await cache.resolve(selection.versions(), selection.channels);
  check('выбранная человеком версия 1.1.0 запускается', liveRunnable.get('rates')?.claim.version === '1.1.0');
  check('вызываемая — новая версия, которую выбрал человек', currentRelease(liveRunnable, selection.installed, () => false, 'rates')?.version === '1.1.0');
  await cache.addRevocations([revocationEnvelope(root, 'release', 'rates@1.1.0')]);
  check('выпуск отозван владельцем — вызов идёт на прошлую проверенную версию', currentRelease(await cache.resolve(selection.versions(), selection.channels), selection.installed, () => false, 'rates')?.version === '1.0.0');

  console.log('4. Клиент flux.programs.call и канал IPC');
  const clientCode = (await buildPageAssets())['modules/_flux/flux.v1.js'] as string;
  const posted: any[] = [];
  let onMessage: ((e: any) => void) | null = null;
  const parentWin = { postMessage: (m: any) => posted.push(m) };
  const sandbox: any = {
    window: { name: 's', addEventListener: (t: string, f: any) => { if (t === 'message') onMessage = f; }, innerWidth: 800, innerHeight: 600 },
    document: { documentElement: { style: { setProperty() {} }, dataset: {} }, addEventListener() {} }, location: { hash: '#s', origin: 'null', pathname: '/' },
    parent: parentWin, setInterval: () => 0, setTimeout, clearTimeout, atob, TextEncoder, TextDecoder, Uint8Array, JSON, console,
  };
  sandbox.window.parent = parentWin; sandbox.globalThis = sandbox;
  vm.runInNewContext(clientCode, sandbox);
  const flux = sandbox.flux;
  const p1 = flux.programs.call('rates', 'convert', { amount: 5 });
  const m1 = posted.at(-1);
  check('сообщение program: идентификатор, метод и данные внутри call, на верхнем уровне метода нет', m1.type === 'program' && m1.call.program === 'rates' && m1.call.method === 'convert' && m1.call.data.amount === 5 && m1.method === undefined && validMessage('program', m1));
  onMessage!({ source: parentWin, data: { flux: 'module', session: 's', type: 'program-result', id: m1.id, data: { value: 4.5 } } });
  check('ответ program-result приходит значением', (await p1).value === 4.5);
  const p2 = flux.programs.call('rates', 'convert');
  const m2 = posted.at(-1);
  check('без данных уходит пустой объект', JSON.stringify(m2.call.data) === '{}');
  onMessage!({ source: parentWin, data: { flux: 'module', session: 's', type: 'program-error', id: m2.id, code: 'NOT_INSTALLED' } });
  const error: any = await p2.then(() => null, (e: any) => e);
  check('program-error — FluxError с кодом и понятным текстом', error?.name === 'FluxError' && error.code === 'NOT_INSTALLED' && /не установлена/.test(error.message));
  check('каналы IPC для главного процесса разрешены окну Flux', INVOKE_CHANNELS.has('modules:program-begin') && INVOKE_CHANNELS.has('modules:program-end'));
  check('схема отвергает лишнее и чужие коды', !validMessage('program', { ...m1, call: { ...m1.call, extra: 1 } }) && !validMessage('program', { ...m1, call: { program: 'Rates', method: 'convert' } })
    && !validMessage('program', { ...m1, call: { program: 'rates', method: 'Convert' } }) && !validMessage('program-error', { flux: 'module', v: 1, session: 's', type: 'program-error', id: 'p-1', code: 'DENIED' }));
  completed = true;
  console.log(`\nВСЕ ТЕСТЫ ПРОЙДЕНЫ (${passed})`);
}

// ── Батарея проверки выпуска ────────────────────────────────────────────────

/** `executionProblem` на пакетах методов для других программ: требования к TypeScript и неизменность прежних выпусков */
function executionBattery(problem: typeof executionProblem) {
  const passedChecks: string[] = [], failed: string[] = [];
  const ok = (name: string, condition: unknown) => { (condition ? passedChecks : failed).push(name); };
  const enc = (text: string) => new TextEncoder().encode(text);
  const manifest = { id: 'ts-methods', name: 'ТС', version: '1.0.0', author: 'A', contractVersion: 3, entries: ['start'], reads: [], logic: 'logic/main.ts',
    exports: [{ method: 'convert', does: 'Метод считает значение по входным данным' }] } as unknown as ModuleManifest;
  const full = (): Record<string, Uint8Array> => ({ 'logic/main.ts': enc('export function compute() {}'), 'build/logic.js': enc('globalThis.__fluxLogic={}'), 'examples/controls.json': enc(controls) });
  const without = (name: string) => { const files = full(); delete files[name]; return files; };
  ok('TypeScript с exports: полный пакет проходит', problem(manifest, full()) === '');
  ok('нет build/logic.js — отказ, причина названа', /build\/logic\.js/.test(problem(manifest, without('build/logic.js'))));
  ok('пустой build/logic.js — отказ', problem(manifest, { ...full(), 'build/logic.js': new Uint8Array() }) !== '');
  ok('нет logic/main.ts — отказ', problem(manifest, without('logic/main.ts')) !== '');
  ok('нет контрольных примеров — отказ', /контрольные примеры/.test(problem(manifest, without('examples/controls.json'))));
  ok('build/logic.js больше 1 МиБ — отказ', problem(manifest, { ...full(), 'build/logic.js': enc(`globalThis.__fluxLogic={}/*${'x'.repeat(LIMITS.tsFileBytes)}*/`) }) !== '');
  ok('build/logic.js не UTF-8 — отказ', problem(manifest, { ...full(), 'build/logic.js': Uint8Array.from([0xff, 0xfe, 0x00]) }) !== '');
  ok('build/logic.js без __fluxLogic — отказ', problem(manifest, { ...full(), 'build/logic.js': enc('alert(1)') }) !== '');
  const plain = { ...manifest, exports: undefined } as unknown as ModuleManifest;
  ok('TypeScript без exports: прежний пакет без build/logic.js и без примеров проходит', problem(plain, { 'logic/main.ts': enc('x') }) === '' && problem(plain, {}) === '');
  ok('Python с exports по-прежнему требует свои файлы, а не build/logic.js', problem({ ...manifest, language: 'python', logic: 'logic/main.py' } as unknown as ModuleManifest, { 'logic/main.py': enc('x = 1'), 'examples/controls.json': enc(controls) }) === '');
  return { passed: passedChecks, failed };
}

// ── Батарея проверок ────────────────────────────────────────────────────────

/** Подставная логика вызываемых программ: что получила, то и видно; `gates` держат вызов «в полёте», пока проверка не отпустит */
interface Rig { seen: any[]; gates: Array<() => void>; begins: number; controlled: string[] }
async function battery(label: string, PC: typeof ModuleProgramCalls, makeBridge: typeof createModuleBridge, current: typeof currentRelease = currentRelease, MC: typeof ModuleCompute = ModuleCompute, makeCaller: typeof createProgramCaller = createProgramCaller) {
  const passedChecks: string[] = [], failed: string[] = [];
  const ok = (name: string, condition: unknown) => { (condition ? passedChecks : failed).push(name); };
  const rig: Rig = { seen: [], gates: [], begins: 0, controlled: [] };
  let clock = 10_000_000;
  const journalFile = path.join(dir, `journal-${label.replace(/\W+/g, '_')}-${Math.random().toString(36).slice(2)}.json`);
  const journal = new ModuleJournal(journalFile, () => clock);
  const runnable = await cache.resolve(selection.versions(), selection.channels);
  const everything = await cache.runnable(['production', 'test']);
  const blocked = new Set(['broken']);
  const fabricated: Record<string, VerifiedModule> = {
    // Манифесты, которые настоящий выпуск не пропустил бы: проверка главного процесса не должна полагаться на проверку выпуска
    selfie: { version: '1.0.0', author: dev, verifiedAt: 1, manifest: { id: 'selfie', name: 'Сама', version: '1.0.0', author: 'A', contractVersion: 3, entries: ['start'], reads: [], logic: 'logic/main.py', language: 'python',
      permissions: permit('selfie') as never, exports: [{ method: 'convert', does: 'Метод считает значение по входным данным' }] } },
    // TypeScript-вызываемая, чей собранный файл больше предела: в подписанный выпуск такая не попадёт, но окно не должно полагаться на это
    tsbig: { version: '1.0.0', author: dev, verifiedAt: 1, manifest: { id: 'tsbig', name: 'ТС', version: '1.0.0', author: 'A', contractVersion: 3, entries: ['start'], reads: [], logic: 'logic/main.ts',
      exports: [{ method: 'convert', does: 'Метод считает значение по входным данным' }] } },
  };
  const resolve = async (id: string, version: string) => fabricated[id] ?? (runnable.get(id)?.claim.version === version
    ? { manifest: runnable.get(id)!.manifest, version, author: dev, verifiedAt: 1 } : null);
  const currentOf = async (id: string) => fabricated[id] && id === 'tsbig' ? fabricated[id] : current(runnable, selection.installed, release => blocked.has(release.manifest.id), id);
  // Политика администратора — настоящий ModuleGrants: тот же набор запретов, что у «@internet»/«@lan»
  const grants = new ModuleGrants(path.join(dir, `grants-${Math.random().toString(36).slice(2)}.json`));
  const programs = new PC({ resolve, current: currentOf, userId: () => 'u1', journal, now: () => clock, deniedByPolicy: (id, target) => grants.isDeniedByPolicy(id, target) });

  // Очередь расчёта: тот же ModuleCompute, что у окна; подписанные файлы логики доходят через fetchFile
  const files = (id: string) => id === 'tsbig' ? { [LOGIC_BUILD_FILE]: new Uint8Array(LIMITS.tsFileBytes + 1) } : (runnable.get(id) ?? everything.get(id))?.files;
  const compute = new MC({
    scheduler: new ComputeScheduler({ slots: 4, laneLimits: { python: 1 } }),
    wasm: { workers: 0, stopAll() {}, keepOnly() {}, async run() { throw new Error('нет'); } },
    python: {
      loaded: false, unload() {},
      async run(key, source, input) {
        const id = key.split('@')[0];
        const request = JSON.parse(input);
        rig.seen.push({ id, source, request });
        if (request.export === 'slow' || request.export === 'relay') await new Promise<void>(resolve => rig.gates.push(resolve));
        if (request.export === 'crash') throw new ComputeError('CRASH');
        if (request.export === 'late') throw new ComputeError('TIMEOUT');
        if (request.export === 'bad') return { output: 'не JSON', bootMs: 0 };
        if (request.export === 'huge') return { output: JSON.stringify({ state: {}, calc: { out: { text: 'я'.repeat(PROGRAM_LIMITS.bytes) } } }), bootMs: 0 };
        const out = request.export === 'convert' || request.export === 'setRate' ? { value: Math.round(request.data.amount * (request.data.rate ?? 1) * 100) / 100, by: id } : { by: id, method: request.export };
        return { output: JSON.stringify({ state: {}, calc: { out } }), bootMs: 0 };
      },
    },
    // Метод на TypeScript — подписанный build/logic.js, собранный настоящим esbuild, в новом контексте vm на каждый вызов: без сети и flux, без состояния
    ts: {
      loaded: false, unload() {},
      async run(source, input, _seed, timeoutMs) {
        const id = /логика ([a-z0-9-]+) /.exec(source)?.[1] ?? 'tsbig';
        rig.seen.push({ id, source, request: JSON.parse(input) });
        const context = vm.createContext({});
        try {
          vm.runInContext(source, context, { timeout: 300 });
          (context as any).__input = JSON.parse(input);
          const output = vm.runInContext('JSON.stringify(__fluxLogic.compute(__input))', context, { timeout: Math.min(timeoutMs, 300) });
          if (typeof output !== 'string') throw new ComputeError('BAD_OUTPUT');
          return { output };
        } catch (error) {
          if (error instanceof ComputeError) throw error;
          throw new ComputeError(/timed out/.test(String((error as Error).message)) ? 'TIMEOUT' : 'CRASH');
        }
      },
    },
    fetchFile: async (id, file) => {
      const logic = file === 'logic.py' ? files(id)?.['logic/main.py'] : file === 'logic.js' ? files(id)?.[LOGIC_BUILD_FILE] : undefined;
      if (!logic) throw new Error('нет файла');
      return logic;
    },
    sha256: async () => 'f'.repeat(64),
    pythonIdleMinutes: () => 5,
    onFailure: () => {},
  });
  const ipc = async (channel: string, data: any) => {
    if (channel === 'modules:program-begin') { rig.begins++; return programs.begin(data); }
    return { ok: programs.end(data) };
  };
  const callerFor = (id: string, version = '1.0.0') => makeCaller({ moduleId: id, version }, () => ({ invoke: ipc, compute: (target, input) => compute.compute(target, input, 'active'),
    controls: async manifest => { rig.controlled.push(manifest.id); return manifest.id === 'tscontrols' ? 'failed' : 'ok'; } }));
  const sent: any[] = [];
  const frame = { postMessage: (m: unknown) => sent.push(m) } as unknown as Window;
  const theme = Object.fromEntries(themeKeys.map(k => [k, '#000'])) as never;
  const bridgeOf = async (id: string, manifestOf?: ModuleManifest) => {
    const manifest = manifestOf ?? (fabricated[id]?.manifest ?? runnable.get(id)!.manifest);
    const bridge = makeBridge({ frame: () => frame, session: 's', manifest, context: () => ({ projectId: 'p', entry: 'start', entityId: null }), theme: () => theme, read: (async () => null) as never,
      program: callerFor(id) });
    await bridge.handle({ source: frame as never, origin: 'null', data: { flux: 'module', v: 1, session: 's', type: 'ready' } });
    return bridge;
  };
  /** Ждать условия не дольше секунды: сломанная защита должна ронять проверку, а не вешать набор */
  const until = async (condition: () => boolean) => { for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5)); };
  let seq = 0;
  /** Одно обращение через мост окна; ответ — сообщение, которое получила бы страница */
  const ask = async (bridge: Awaited<ReturnType<typeof bridgeOf>>, program: string, method: string, data: unknown = {}) => {
    const id = `p-${++seq}`;
    const before = sent.length;
    await bridge.handle({ source: frame as never, origin: 'null', data: { flux: 'module', v: 1, session: 's', id, type: 'program', call: { program, method, data } } });
    // Мост не ждёт расчёта в handle: ответ приходит отдельным сообщением
    for (let i = 0; i < 400 && !sent.slice(before).some(m => m.id === id); i++) await new Promise(resolve => setTimeout(resolve, 5));
    return sent.slice(before).find(m => m.id === id);
  };
  const outcome = (m: any) => m?.type === 'program-result' ? 'ok' : m?.type === 'program-error' ? m.code : `?${m?.type}`;
  const beginCode = (r: Awaited<ReturnType<typeof programs.begin>>) => 'code' in r ? r.code : 'ok';
  const tick = () => { clock += 1100; };

  const report = await bridgeOf('report');

  // Успех
  tick();
  let reply = await ask(report, 'rates', 'convert', { amount: 100, rate: 0.9, note: 'СЕКРЕТНЫЙ-МАРКЕР' });
  ok('успех: ответ — calc.out метода', reply?.type === 'program-result' && reply.data.value === 90 && reply.data.by === 'rates');
  const first = rig.seen.at(-1);
  ok('метод получил ровно { export, data }: ничего от Flux и от вызывающей', JSON.stringify(Object.keys(first.request).sort()) === '["data","export"]' && first.request.export === 'convert' && first.request.data.amount === 100);
  ok('исполнена подписанная логика вызываемой, а не вызывающей', first.id === 'rates' && first.source.includes('логика rates 1.0.0'));
  tick();
  reply = await ask(report, 'rates', 'setRate', { amount: 2, rate: 3 });
  ok('метод с «глагольным» именем (setRate) мост не принимает за запись', outcome(reply) === 'ok' && reply.data.value === 6);
  const entries = journal.recent(500);
  const caller = entries.find(e => e.moduleId === 'report' && e.outcome === 'ok' && e.detail.includes('convert'));
  const callee = entries.find(e => e.moduleId === 'rates' && e.outcome === 'ok' && e.detail.includes('convert'));
  ok('журнал вызывающей: кто, метод, длительность, объём, итог', !!caller && caller.category === 'connection' && caller.event === 'call' && caller.detail.includes('rates') && caller.bytesIn > 0 && caller.bytesOut > 0 && caller.ms >= 0 && caller.version === '1.0.0');
  ok('журнал вызываемой: из какой программы, метод, объём, итог', !!callee && callee.category === 'compute' && callee.event === 'export' && callee.detail.includes('report') && callee.bytesIn > 0 && callee.version === '1.0.0');
  ok('в журнале нет содержимого вызова и ответа: подписи только вида «программа «x» · метод» и «метод · из «y»»', !JSON.stringify(entries).includes('МАРКЕР') && !JSON.stringify(entries).includes('"value"')
    && entries.filter(e => e.event === 'call' || e.event === 'export').every(e => /^программа «[a-z0-9-]+» · [A-Za-z0-9]+$/.test(e.detail) || /^[A-Za-z0-9]+ · из «[a-z0-9-]+»$/.test(e.detail)));

  // Отказы
  tick();
  const before = rig.seen.length, b0 = rig.begins;
  reply = await ask(report, 'prices', 'convert', { amount: 1 });
  ok('NOT_ALLOWED: разрешения на эту программу нет в манифесте — останавливает окно, до главного процесса не доходит', outcome(reply) === 'NOT_ALLOWED' && rig.seen.length === before && rig.begins === b0);
  const plain = await bridgeOf('plain-caller');
  reply = await ask(plain, 'rates', 'convert', { amount: 1 });
  ok('NOT_ALLOWED: у программы нет раздела permissions вовсе', outcome(reply) === 'NOT_ALLOWED' && rig.seen.length === before && rig.begins === b0);
  const begins = rig.begins;
  const direct = await programs.begin({ moduleId: 'plain-caller', version: '1.0.0', call: { program: 'rates', method: 'convert', bytes: 2 } });
  ok('NOT_ALLOWED и в главном процессе: слова окна о разрешении в расчёт не идут', !direct.ok && beginCode(direct) === 'NOT_ALLOWED');
  const forged = await bridgeOf('plain-caller', runnable.get('report')!.manifest);
  reply = await ask(forged, 'rates', 'convert', { amount: 1 });
  ok('NOT_ALLOWED: окно с подменённым манифестом всё равно останавливает главный процесс', outcome(reply) === 'NOT_ALLOWED' && rig.begins === begins + 1 && rig.seen.length === before);
  ok('отказы записаны у вызывающей, вызываемая их не видит', journal.recent(500).some(e => e.moduleId === 'plain-caller' && e.outcome === 'denied') && !journal.recent(500).some(e => e.moduleId === 'rates' && e.outcome === 'denied'));
  tick();
  const wrongVersion = await programs.begin({ moduleId: 'report', version: '9.9.9', call: { program: 'rates', method: 'convert', bytes: 2 } });
  ok('NOT_ALLOWED: версия вызывающей, которой нет в проверенных', !wrongVersion.ok && beginCode(wrongVersion) === 'NOT_ALLOWED');
  const self = await programs.begin({ moduleId: 'selfie', version: '1.0.0', call: { program: 'selfie', method: 'convert', bytes: 2 } });
  ok('NOT_ALLOWED: вызов самой себя, даже если разрешение каким-то образом объявлено', !self.ok && beginCode(self) === 'NOT_ALLOWED');
  const shape = await programs.begin({ moduleId: 'report', version: '1.0.0', call: { program: 'Rates', method: 'convert', bytes: 2 } });
  ok('кривая форма вызова — FAILED, а не расчёт', !shape.ok && beginCode(shape) === 'FAILED');

  tick();
  ok('NOT_INSTALLED: программа есть в кэше, но человек её не ставил', outcome(await ask(report, 'ghosted', 'convert')) === 'NOT_INSTALLED');
  ok('NOT_INSTALLED: такой программы нет вовсе', outcome(await ask(report, 'absent', 'convert')) === 'NOT_INSTALLED');
  ok('NOT_INSTALLED: установлена, но выпуск в тестовом канале, а человеку открыт рабочий', outcome(await ask(report, 'beta', 'convert')) === 'NOT_INSTALLED');
  ok('NOT_INSTALLED: контрольные примеры выпуска на этом компьютере не сошлись', outcome(await ask(report, 'broken', 'convert')) === 'NOT_INSTALLED');
  ok('установленная без выбора человека не берётся из кэша: проверка слоя «установлена»', current(everything, selection.installed, () => false, 'ghosted') === null && current(everything, selection.installed, () => false, 'rates')?.version === '1.0.0');
  ok('отказ NOT_INSTALLED не запускал расчёт', !rig.seen.some(s => ['ghosted', 'beta', 'broken'].includes(s.id)));
  ok('NO_METHOD: метода нет в exports, хотя логика его знает', outcome(await ask(report, 'rates', 'ghost')) === 'NO_METHOD' && !rig.seen.some(s => s.request.export === 'ghost'));
  ok('NO_METHOD: у программы вообще нет exports', outcome(await ask(report, 'bare', 'convert')) === 'NO_METHOD');
  // Метод на TypeScript: исполняет подписанный build/logic.js вызываемой
  tick();
  const tsReport = await bridgeOf('report');
  reply = await ask(tsReport, 'tsrates', 'convert', { amount: 100, rate: 0.9, note: 'ТС-МАРКЕР' });
  ok('TypeScript: успех — ответ calc.out метода', reply?.type === 'program-result' && reply.data.value === 90 && reply.data.by === 'ts');
  const tsSeen = rig.seen.at(-1);
  ok('TypeScript: метод получил ровно { export, data }', JSON.stringify(Object.keys(tsSeen.request).sort()) === '["data","export"]' && tsSeen.request.data.amount === 100);
  ok('TypeScript: исполнен подписанный build/logic.js вызываемой, байт в байт', tsSeen.id === 'tsrates' && tsSeen.source.includes('логика tsrates 1.0.0') && tsSeen.source === Buffer.from(files('tsrates')![LOGIC_BUILD_FILE]).toString('utf8'));
  ok('TypeScript: контрольные примеры вызываемой проверены перед методом', rig.controlled.includes('tsrates'));
  ok('TypeScript: журнал вызываемой — «Расчёты», метод и вызывающая, без содержимого', journal.recent(500).some(e => e.moduleId === 'tsrates' && e.event === 'export' && e.outcome === 'ok' && e.detail === 'convert · из «report»') && !JSON.stringify(journal.recent(500)).includes('ТС-МАРКЕР'));
  const count1 = await ask(tsReport, 'tsrates', 'count'), count2 = await ask(tsReport, 'tsrates', 'count');
  ok('TypeScript: нет состояния между вызовами (переменная модуля и глобальная начинаются заново)', outcome(count1) === 'ok' && outcome(count2) === 'ok' && count1.data.module === 1 && count2.data.module === 1 && count1.data.global === 1 && count2.data.global === 1);
  const sealed = await ask(tsReport, 'tsrates', 'sealed');
  ok('TypeScript: у метода нет сети, require, process, flux и DOM (модель хоста; настоящую CSP проверяет test-modules-ts-host)', outcome(sealed) === 'ok' && Object.values(sealed.data).every(v => v === 'undefined'));
  ok('TypeScript: ошибка логики — FAILED, текст ошибки в ответе и журнале не виден', outcome(await ask(tsReport, 'tsrates', 'crash')) === 'FAILED' && !JSON.stringify(journal.recent(500)).includes('СЕКРЕТ'));
  ok('TypeScript: метод ничего не вернул — FAILED', outcome(await ask(tsReport, 'tsrates', 'bad')) === 'FAILED');
  ok('TypeScript: метода нет в exports — NO_METHOD, логика не запускалась', outcome(await ask(tsReport, 'tsrates', 'ghost')) === 'NO_METHOD' && !rig.seen.some(s => s.id === 'tsrates' && s.request.export === 'ghost'));
  tick();
  const tsSpin = await ask(tsReport, 'tsrates', 'spin');
  ok('TypeScript: бесконечный цикл — TIMEOUT, итог в журнале вызываемой', outcome(tsSpin) === 'TIMEOUT' && journal.recent(500).some(e => e.moduleId === 'tsrates' && e.event === 'export' && e.outcome === 'timeout'));
  ok('TypeScript: после остановки по времени следующий вызов работает', outcome(await ask(tsReport, 'tsrates', 'convert', { amount: 1 })) === 'ok');
  ok('TypeScript: ответ метода больше 256 КиБ — LIMIT', outcome(await ask(tsReport, 'tsrates', 'huge')) === 'LIMIT');
  const beforeControlled = rig.seen.length;
  ok('TypeScript: контрольные примеры не сошлись — FAILED, метод не исполнялся', outcome(await ask(tsReport, 'tscontrols', 'convert', { amount: 1 })) === 'FAILED' && rig.controlled.includes('tscontrols') && rig.seen.length === beforeControlled);
  ok('TypeScript: файл логики больше 1 МиБ — FAILED, метод не исполнялся', outcome(await ask(tsReport, 'tsbig', 'convert', { amount: 1 })) === 'FAILED' && !rig.seen.some(s => s.id === 'tsbig'));
  ok('FAILED: метод упал', outcome(await ask(report, 'rates', 'crash')) === 'FAILED');
  ok('FAILED: метод вернул не JSON', outcome(await ask(report, 'rates', 'bad')) === 'FAILED');
  ok('TIMEOUT: метод не уложился в предел расчёта', outcome(await ask(report, 'rates', 'late')) === 'TIMEOUT');
  ok('итог отказа записан в журнал обеих (исполнение началось)', journal.recent(500).some(e => e.moduleId === 'rates' && e.event === 'export' && e.outcome === 'timeout') && journal.recent(500).some(e => e.moduleId === 'report' && e.outcome === 'failed'));

  // Запрет администратора: `@program:<id>` сильнее разрешения program из подписанного манифеста
  tick();
  const policyBridge = await bridgeOf('report');
  const seenBeforePolicy = rig.seen.length;
  grants.setPolicy([{ moduleId: 'report', connection: programPolicyTarget('rates') }]);
  reply = await ask(policyBridge, 'rates', 'convert', { amount: 1, note: 'ПОЛИТИКА-МАРКЕР' });
  ok('запрет администратора: вызов rates — NOT_ALLOWED, хотя разрешение program объявлено и подписано', outcome(reply) === 'NOT_ALLOWED' && rig.seen.length === seenBeforePolicy);
  const policyEntries = journal.recent(500);
  ok('запрет администратора: в журнале вызывающей итог «denied-by-admin», без содержимого', policyEntries.some(e => e.moduleId === 'report' && e.outcome === 'denied-by-admin' && e.detail === 'программа «rates» · convert') && !JSON.stringify(policyEntries).includes('ПОЛИТИКА'));
  ok('запрет администратора: вызываемая ничего не знает — в её журнале записей нет, очередь пуста', !policyEntries.some(e => e.moduleId === 'rates' && e.detail.includes('report') && e.outcome !== 'ok' && e.outcome !== 'timeout' && e.outcome !== 'failed' && e.outcome !== 'limit') && programs.active === 0);
  const policyDirect = await programs.begin({ moduleId: 'report', version: '1.0.0', call: { program: 'rates', method: 'convert', bytes: 2 } });
  ok('запрет администратора действует и на главный процесс напрямую, слова окна не нужны', !policyDirect.ok && beginCode(policyDirect) === 'NOT_ALLOWED');
  ok('запрет другой пары не мешает: запрет на rates не закрывает report другую программу (tsrates)', outcome(await ask(policyBridge, 'tsrates', 'convert', { amount: 2 })) === 'ok');
  grants.setPolicy([{ moduleId: 'plain-caller', connection: programPolicyTarget('rates') }, { moduleId: 'report', connection: programPolicyTarget('prices') }, { moduleId: 'report', connection: 'rates' }, { moduleId: 'report', connection: '@lan' }]);
  tick();
  ok('запрет той же вызывающей на другую программу, чужой пары и одноимённого «подключения» rates вызов report→rates не затрагивает', outcome(await ask(policyBridge, 'rates', 'convert', { amount: 1 })) === 'ok');
  grants.setPolicy([{ moduleId: 'report', connection: programPolicyTarget('rates') }, { moduleId: 'report', connection: programPolicyTarget('tsrates') }]);
  tick();
  ok('запрет всем ролям и другим программам: обе пары отказывают', outcome(await ask(policyBridge, 'rates', 'convert', { amount: 1 })) === 'NOT_ALLOWED' && outcome(await ask(policyBridge, 'tsrates', 'convert', { amount: 1 })) === 'NOT_ALLOWED');
  grants.setPolicy([]);
  tick();
  ok('запрет снят — вызов снова проходит', outcome(await ask(policyBridge, 'rates', 'convert', { amount: 1 })) === 'ok');

  // Пределы (у каждого моста свой счёт сообщений за секунду, поэтому мост свой)
  tick();
  const report2 = await bridgeOf('report');
  const bigData = { text: 'я'.repeat(PROGRAM_LIMITS.bytes) };
  const callsBefore = rig.begins;
  ok('LIMIT: данные больше 256 КиБ останавливает окно', outcome(await ask(report2, 'rates', 'convert', bigData)) === 'LIMIT' && rig.begins === callsBefore);
  const bigDirect = await programs.begin({ moduleId: 'report', version: '1.0.0', call: { program: 'rates', method: 'convert', bytes: PROGRAM_LIMITS.bytes + 1 } });
  ok('LIMIT: и главный процесс — по заявленному окном размеру', !bigDirect.ok && beginCode(bigDirect) === 'LIMIT');
  const edge = await programs.begin({ moduleId: 'report', version: '1.0.0', call: { program: 'rates', method: 'convert', bytes: PROGRAM_LIMITS.bytes } });
  ok('ровно 256 КиБ ещё можно', edge.ok);
  if (edge.ok) programs.end({ ticket: edge.ticket, outcome: 'ok' });
  tick();
  ok('LIMIT: ответ метода больше 256 КиБ', outcome(await ask(report2, 'rates', 'huge')) === 'LIMIT');
  const stub = makeBridge({ frame: () => frame, session: 's', manifest: runnable.get('report')!.manifest, context: () => ({ projectId: 'p', entry: 'start', entityId: null }), theme: () => theme, read: (async () => null) as never,
    program: async () => ({ ok: true, data: { text: 'я'.repeat(PROGRAM_LIMITS.bytes) } }) });
  await stub.handle({ source: frame as never, origin: 'null', data: { flux: 'module', v: 1, session: 's', type: 'ready' } });
  ok('LIMIT: мост сам не отдаёт странице ответ больше 256 КиБ, даже если хост его вернул', outcome(await ask(stub, 'rates', 'convert')) === 'LIMIT');
  ok('после LIMIT место свободно', programs.active === 0 && outcome(await ask(report2, 'rates', 'convert', { amount: 1 })) === 'ok');

  // 4 одновременно: окно держит свой счёт, главный процесс — свой
  tick();
  rig.gates.length = 0;
  const report3 = await bridgeOf('report');
  const pending = Array.from({ length: 4 }, () => ask(report3, 'rates', 'slow'));
  await until(() => programs.active >= 4);
  const beginsBefore = rig.begins;
  const fifth = await ask(report3, 'rates', 'convert', { amount: 1 });
  ok('LIMIT: пятый одновременный вызов останавливает окно, главный процесс не вызван', outcome(fifth) === 'LIMIT' && rig.begins === beginsBefore && programs.active === 4);
  const mainFifth = await programs.begin({ moduleId: 'report', version: '1.0.0', call: { program: 'rates', method: 'convert', bytes: 2 } });
  ok('LIMIT: пятый одновременный и в главном процессе', !mainFifth.ok && beginCode(mainFifth) === 'LIMIT');
  ok('идущие вызовы доходят: ответы после освобождения', await (async () => {
    await until(() => rig.gates.length >= 1);
    for (let i = 0; i < 40 && pending.length; i++) { rig.gates.splice(0).forEach(open => open()); await new Promise(resolve => setTimeout(resolve, 5)); }
    return (await Promise.all(pending)).every(m => outcome(m) === 'ok');
  })());
  ok('все четыре завершены — места свободны', programs.active === 0);

  // Вложенный вызов: пока метод `chain` исполняется для report, сама `chain` вызовов не делает
  tick();
  rig.gates.length = 0;
  const relay = ask(await bridgeOf('report'), 'chain', 'relay');
  await until(() => programs.active >= 1);
  const chainWindow = await bridgeOf('chain');
  ok('вложенный вызов запрещён: метод chain не может обратиться к rates', outcome(await ask(chainWindow, 'rates', 'convert', { amount: 1 })) === 'NOT_ALLOWED');
  ok('запрет вложенного вызова записан у вызывающей', journal.recent(500).some(e => e.moduleId === 'chain' && e.outcome === 'denied'));
  await new Promise(resolve => setTimeout(resolve, 20));
  rig.gates.splice(0).forEach(open => open());
  ok('сам метод chain при этом доходит до конца', outcome(await relay) === 'ok');
  tick();
  ok('метод закончился — chain снова вправе вызывать rates', outcome(await ask(chainWindow, 'rates', 'convert', { amount: 1 })) === 'ok');

  // 20 в секунду
  clock += 5000;
  const report4 = await bridgeOf('report');
  const outcomes: string[] = [];
  for (let i = 0; i < PROGRAM_LIMITS.perSecond + 3; i++) outcomes.push(outcome(await ask(report4, 'rates', 'rateOn', { day: i })));
  ok('LIMIT: больше 20 вызовов в секунду', outcomes.slice(0, PROGRAM_LIMITS.perSecond).every(o => o === 'ok') && outcomes.slice(PROGRAM_LIMITS.perSecond).every(o => o === 'LIMIT'));
  tick();
  ok('через секунду счёт начинается заново', outcome(await ask(report4, 'rates', 'rateOn', { day: 99 })) === 'ok');

  // Вызовы без итога освобождают место сами
  tick();
  for (let i = 0; i < PROGRAM_LIMITS.inFlight; i++) await programs.begin({ moduleId: 'report', version: '1.0.0', call: { program: 'rates', method: 'convert', bytes: 2 } });
  const stuck = await programs.begin({ moduleId: 'report', version: '1.0.0', call: { program: 'rates', method: 'convert', bytes: 2 } });
  clock += PROGRAM_LIMITS.staleMs + 1;
  const after = await programs.begin({ moduleId: 'report', version: '1.0.0', call: { program: 'rates', method: 'convert', bytes: 2 } });
  ok('вызовы, которым окно не сообщило итог, освобождают место по истечении срока', !stuck.ok && beginCode(stuck) === 'LIMIT' && after.ok);
  if (after.ok) programs.end({ ticket: after.ticket, outcome: 'ok' });
  ok('итог неизвестного или уже закрытого вызова ничего не меняет', !programs.end({ ticket: 'pc-0', outcome: 'ok' }) && !(after.ok && programs.end({ ticket: after.ticket, outcome: 'ok' })));
  ok('зависшие записаны как timeout', journal.recent(500).some(e => e.moduleId === 'rates' && e.event === 'export' && e.outcome === 'timeout' && e.detail.includes('report')));

  return { label, passed: passedChecks, failed };
}

main().catch(e => { console.error(e); process.exit(1); });
