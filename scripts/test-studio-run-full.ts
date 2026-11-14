/**
 * Studio: полный запуск программы на действиях оболочки (этап 2, пункт б), главный процесс без Electron.
 *
 * Что доказывается:
 * - заготовки на TypeScript, C, C++, Rust, Go и C# (modules/fixtures) запускаются через действия службы разработчика и считают
 *   верно на настоящем движке Studio (контрольные примеры «статистики параметров»); у TypeScript расчёт идёт как метод
 *   второй программы (в форме его считает окно программы — это проверяют наборы интерфейса);
 * - пределы расчёта (время, память WebAssembly, размер файла и ответа) — те же константы, что у Flux, куча потока JavaScript
 *   ограничена; логика TypeScript исполняется без process, require, fetch и import() наружу;
 * - подключения HTTP, WebSocket и COM (подставной) идут кодом Flux: успех, отказ человека, молчание, необъявленное, закрытый адрес,
 *   белый список COM, пределы; решение помнится в памяти и привязано к тексту разрешения; файлы Flux не читаются и не пишутся;
 * - вторая программа: установка в тестовую базу, вызов на WebAssembly и TypeScript, каждый отказ, Python — FAILED с подсказкой;
 * - файл пользователю: диалог главного процесса, имя и размер как у Flux;
 * - закрытие запуска закрывает сокеты и объекты COM, снимает вопросы.
 * Мутации главных защит: копия файла с одной сломанной защитой обязана уронить хотя бы одну проверку своей батареи.
 * Чего здесь нет и что проверяется на Windows: настоящий COM (PowerShell), системные диалоги Electron.
 *
 * Запуск: npx tsx scripts/test-studio-run-full.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import esbuild from 'esbuild';
import { runControls } from '../modules/engine/controls';
import { ComputeError } from '../modules/engine/types';
import { DeveloperService } from '../studio/shell/developer';
import { ALL_ACTIONS } from '../studio/shell/actions';
import { createControlsEngine } from '../studio/shared/controlsEngine';
import type { SafeStorageLike } from '../studio/shared/keyring';
import type { ProjectFiles } from '../studio/shared/templates';
import { RunConnections } from '../studio/shell/runConnections';
import { RunPrograms } from '../studio/shell/runPrograms';
import { RunFileSaver } from '../studio/shell/runSaveFile';
import { FakeCom } from './fixtures/fakeCom';
import { languageFiles, statsControls, logicBytes, type FixtureLanguage } from './fixtures/moduleLanguages';
import {
  connectionsBattery, declarations, engineBattery, methodsOf, programsBattery, saveBattery, startServers, tally, wasmConstant,
  type Impl, type Servers, type Tally,
} from './fixtures/studioRunBatteries';

const { buildDeveloperAssets } = require('../studio/build-assets.cjs');
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-studio-runfull-'));
const enc = (value: string) => new TextEncoder().encode(value);
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const storage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: plain => Buffer.from(plain, 'utf8').reverse(),
  decryptString: data => Buffer.from(data).reverse().toString('utf8'),
};
const DOES = 'Берёт у калькулятора курсов пересчёт сумм для отчёта';

interface Env { app: string; templatesRoot: string; runtimeDir: string; engine: ReturnType<typeof createControlsEngine>; workerFile: string }

/** Проект из заготовки языка: файлы пакета без build/ (его собирает Studio сама) */
function projectFiles(lang: FixtureLanguage, patch: Record<string, unknown>, extra: Record<string, Uint8Array | string> = {}): ProjectFiles {
  const out: ProjectFiles = {};
  for (const [name, data] of Object.entries(languageFiles(lang, patch, extra))) if (!name.startsWith('build/')) out[name] = typeof data === 'string' ? enc(data) : data;
  return out;
}

function makeService(Service: typeof DeveloperService, env: Env, extra: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(temp, 'svc-'));
  const events: Array<{ ch: string; data: any }> = [];
  const com = new FakeCom();
  const picks: Array<{ title: string; defaultName: string }> = [];
  const service = new Service({
    dir: path.join(dir, 'data'), storage, version: '1.0.0', session: () => null,
    assets: { templatesRoot: env.templatesRoot, runtimeDir: env.runtimeDir }, engine: env.engine, home: path.join(dir, 'projects'),
    emit: (ch, data) => events.push({ ch, data }), com: () => com, askTimeoutMs: 3000, fluxDataDir: () => path.join(dir, 'flux-data'),
    pickSaveFile: async options => { picks.push(options); return path.join(dir, options.defaultName); },
    ...extra,
  } as any);
  const create = (id: string, lang: FixtureLanguage, patch: Record<string, unknown> = {}, more: Record<string, Uint8Array | string> = {}) =>
    service.drafts.create(id, projectFiles(lang, { id, ...patch }, more), { template: 'folder' });
  const call = (action: string, args: Record<string, unknown> = {}): Promise<any> => service.handle(action as never, args);
  return { dir, events, com, picks, service, create, call, flux: path.join(dir, 'flux-data') };
}

/** Служба целиком: вопрос о подключении событием и ответ действием, закрытие запуска, замена запуска, выход из Studio */
async function serviceBattery(Service: typeof DeveloperService, env: Env, s: Servers, print = false): Promise<Tally> {
  const t = tally(print), d = declarations(s);
  const { service, events, create, call, dir } = makeService(Service, env);
  create('svc-run', 'typescript', { connections: [d.http(), d.ws, d.fso] });
  const asks = () => events.filter(e => e.ch === 'studio:run' && e.data.kind === 'connectAsk').map(e => e.data);
  const until = async (fn: () => unknown) => { for (let i = 0; i < 100 && !fn(); i++) await wait(20); return !!fn(); };
  const ping = { op: 'http', method: 'GET', path: '/api/ping' };
  const open = { op: 'ws-open', path: '/' };
  t.check('новые действия объявлены в списке окна', ['runConnect', 'runConnectAnswer', 'runStop', 'runProgram', 'runSaveFile', 'testPrograms', 'testProgramInstall', 'testProgramRemove'].every(a => ALL_ACTIONS.includes(a)));

  await call('runStart', { id: 'svc-run' });
  const p1 = call('runConnect', { connection: 'live', call: open });
  await until(() => asks().length === 1);
  const q = asks()[0];
  t.check('вопрос ушёл окну событием studio:run с текстами из манифеста', q && q.ask.connection === 'live' && q.ask.app === 'Сервер событий' && typeof q.id === 'string');
  t.check('ответ окна принят действием runConnectAnswer', (await call('runConnectAnswer', { id: q.id, decision: 'once' })).answered === true && (await call('runConnectAnswer', { id: q.id, decision: 'once' })).answered === false);
  t.check('после ответа подключение открывается', await p1.then((r: any) => r.ok === true) && s.sockets() === 1);
  await call('runStop');
  await until(() => s.sockets() === 0);
  t.check('runStop закрыл сокет запуска', s.sockets() === 0);
  t.check('после runStop подключения отказывают', await call('runConnect', { connection: 'live', call: open }).then((r: any) => r.code === 'DENIED'));
  t.check('после runStop программа не запущена: чтение и расчёт отказывают', await call('runRead', { resource: 'project' }).then(() => false, () => true));

  await call('runStart', { id: 'svc-run' });
  const before = asks().length;
  const p2 = call('runConnect', { connection: 'api', call: ping });
  await until(() => asks().length === before + 1);
  await call('runStop');
  t.check('закрытие запуска снимает вопрос: NOT_ALLOWED, окно получило connectAskClose', await p2.then((r: any) => r.code === 'NOT_ALLOWED') && events.some(e => e.data.kind === 'connectAskClose'));

  await call('runStart', { id: 'svc-run' });
  const p3 = call('runConnect', { connection: 'live', call: open });
  await until(() => asks().length === before + 2);
  await call('runConnectAnswer', { id: asks()[before + 1].id, decision: 'always' });
  t.check('«всегда» открывает подключение', await p3.then((r: any) => r.ok === true) && s.sockets() === 1);
  await call('runStart', { id: 'svc-run' });
  await until(() => s.sockets() === 0);
  t.check('новый запуск закрыл подключения прежнего', s.sockets() === 0);
  t.check('решение «всегда» помнится и в новом запуске: вопроса нет', await call('runConnect', { connection: 'live', call: open }).then((r: any) => r.ok === true) && asks().length === before + 2);
  service.dispose();
  await until(() => s.sockets() === 0);
  t.check('выход из Studio закрыл подключения', s.sockets() === 0);

  const second = makeService(Service, env, { askTimeoutMs: 100 });
  second.create('svc-save', 'typescript');
  const bytes = enc('файл');
  t.check('без запуска файл не принимается', await second.call('runSaveFile', { name: 'a.txt', mime: 'text/plain', bytes }).then(() => false, (e: any) => /не запущена/.test(e.message)));
  await second.call('runStart', { id: 'svc-save' });
  t.check('файл: диалог главного процесса с названием программы, запись по выбору человека', await second.call('runSaveFile', { name: 'a.txt', mime: 'text/plain', bytes }) === 'saved'
    && fs.readFileSync(path.join(second.dir, 'a.txt'), 'utf8') === 'файл' && /Статистика/.test(second.picks[0].title));
  t.check('недопустимое имя — отказ словами, диалога нет', await second.call('runSaveFile', { name: 'x.exe', bytes }).then(() => false, (e: any) => /Недопустимое имя/.test(e.message)) && second.picks.length === 1);
  second.service.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
  return t;
}

async function main() {
  const app = path.join(temp, 'app');
  await buildDeveloperAssets({ app, esbuild });
  const workerFile = path.join(app, 'controls-worker.cjs');
  const env: Env = { app, templatesRoot: path.join(app, 'templates'), runtimeDir: path.join(app, 'runtime'), workerFile, engine: createControlsEngine({ workerFile, timeoutMs: 20_000 }) };
  const real: Impl = { RunConnections, RunPrograms, RunFileSaver, createControlsEngine, workerFile };
  const servers = await startServers();
  const report = (name: string, t: Tally) => { passed += t.count; assert.deepEqual(t.failed, [], `${name}: упало ${t.failed.join('; ')}`); };

  console.log('Заготовки: запуск через действия оболочки на настоящем движке Studio');
  {
    const { service, create, call, flux, dir } = makeService(DeveloperService, env);
    const controls = statsControls();
    const permissions = ['stats-callee', 'callee-wasm', 'callee-py', 'callee-bad', 'callee-exports'].map(program => ({ kind: 'program', program, does: DOES }));
    for (const lang of ['typescript', 'c', 'cpp', 'rust', 'go', 'csharp'] as const) {
      const id = `stats-${lang}`;
      create(id, lang, lang === 'typescript' ? { permissions } : {});
      const started = await call('runStart', { id });
      ok(`${lang}: runStart отвечает, язык ${started.language}`, started.session && started.language === (lang === 'typescript' ? 'typescript' : 'wasm'));
      if (lang === 'typescript') continue;
      const result = await runControls(controls, async input => {
        const reply = await call('runCompute', { input });
        if (reply.code) throw new ComputeError(reply.code);
        return reply.output;
      });
      ok(`${lang}: расчёт верен (${result.passed} из ${controls.cases.length} контрольных примеров)`, result.ok && result.passed === controls.cases.length);
    }

    console.log('TypeScript: расчёт тем же движком как метод второй программы, тестовые программы');
    // Метод — тот же расчёт, вход берётся из data: так вызывающая программа передаёт то, что считает «статистика»
    const source = Buffer.from(logicBytes('typescript')).toString('utf8').replace('export function compute(input: Input)', 'function statsCompute(input: Input)')
      + '\nexport function compute(i: any) { return statsCompute(i && i.export ? i.data : i); }\n';
    create('stats-callee', 'typescript', { exports: methodsOf('stats') }, { 'logic/main.ts': source });
    create('callee-wasm', 'c', { exports: methodsOf('convert') }, { 'logic/main.wasm': wasmConstant() });
    create('callee-py', 'python', { exports: methodsOf('convert') });
    create('callee-bad', 'typescript', { exports: methodsOf('convert') }, { 'logic/main.ts': 'export function compute( {' });
    create('callee-exports', 'typescript', { exports: [{ method: 'Плохое имя', does: 'x' }] });
    const rows = await call('testPrograms');
    ok('testPrograms: все свои черновики, exports и отметка «установлена» ложная', rows.length === 11 && rows.every((r: any) => r.installed === false)
      && rows.find((r: any) => r.id === 'callee-wasm').exports[0].method === 'convert' && rows.find((r: any) => r.id === 'callee-wasm').language === 'wasm'
      && rows.find((r: any) => r.id === 'callee-py').language === 'python' && rows.find((r: any) => r.id === 'stats-callee').exports.length === 1);
    const refuses = (action: string, args: Record<string, unknown>, pattern: RegExp) => call(action, args).then(() => false, (e: any) => pattern.test(e.message));
    ok('установка того, что не собирается, — отказ словами', await refuses('testProgramInstall', { id: 'callee-bad' }, /Сборка не прошла/));
    ok('установка с неверным exports — отказ словами', await refuses('testProgramInstall', { id: 'callee-exports' }, /exports/));
    ok('неверный идентификатор — отказ', await refuses('testProgramInstall', { id: '../x' }, /идентификатор/i));
    ok('после отказов ничего не установлено', (await call('testPrograms')).every((r: any) => !r.installed));
    await call('runStart', { id: 'stats-typescript' });
    ok('до установки вторая программа — NOT_INSTALLED со строкой для журнала', await call('runProgram', { call: { program: 'stats-callee', method: 'stats', data: {} } }).then((r: any) => r.code === 'NOT_INSTALLED' && /установите/.test(r.line)));
    for (const id of ['stats-callee', 'callee-wasm', 'callee-py']) await call('testProgramInstall', { id });
    const installed = await call('testPrograms');
    ok('установленные отмечены в списке', ['stats-callee', 'callee-wasm', 'callee-py'].every(id => installed.find((r: any) => r.id === id).installed === true) && installed.filter((r: any) => r.installed).length === 3);
    const viaProgram = await runControls(controls, async input => {
      const reply = await call('runProgram', { call: { program: 'stats-callee', method: 'stats', data: input } });
      if (!reply.ok) throw new ComputeError('CRASH', reply.code);
      return { state: {}, calc: { out: reply.data } };
    });
    ok(`typescript: расчёт верен как метод второй программы (${viaProgram.passed} из ${controls.cases.length})`, viaProgram.ok && viaProgram.passed === controls.cases.length);
    ok('метод на WebAssembly отвечает', await call('runProgram', { call: { program: 'callee-wasm', method: 'convert', data: { amount: 1 } } }).then((r: any) => r.ok && r.data.by === 'wasm'));
    ok('метод на Python — FAILED и подсказка про «Запустить во Flux»', await call('runProgram', { call: { program: 'callee-py', method: 'convert' } }).then((r: any) => r.code === 'FAILED' && /Запустить во Flux/.test(r.line)));
    ok('метод вне exports — NO_METHOD', await call('runProgram', { call: { program: 'callee-wasm', method: 'nope' } }).then((r: any) => r.code === 'NO_METHOD'));
    ok('чужая программа без разрешения program — NOT_ALLOWED', await call('runProgram', { call: { program: 'stats-go', method: 'x' } }).then((r: any) => r.code === 'NOT_ALLOWED'));
    await call('testProgramRemove', { id: 'callee-wasm' });
    ok('убранная — снова NOT_INSTALLED, список обновился', await call('runProgram', { call: { program: 'callee-wasm', method: 'convert' } }).then((r: any) => r.code === 'NOT_INSTALLED')
      && (await call('testPrograms')).find((r: any) => r.id === 'callee-wasm').installed === false);
    await call('runStop');
    ok('после runStop вызов программы отказывает словами', await refuses('runProgram', { call: { program: 'stats-callee', method: 'stats' } }, /не запущена/));
    ok('папка данных Flux не появилась и не тронута', !fs.existsSync(flux));
    ok('среди данных Studio нет файлов решений, журнала и выбора Flux', !fs.readdirSync(path.join(dir, 'data')).some(f => /grants|journal|selection/.test(f)));
    service.dispose();
  }

  console.log('Движок Studio: пределы Flux');
  report('движок', await engineBattery(real, true));
  console.log('Подключения: настоящие локальные серверы и подставной COM');
  report('подключения', await connectionsBattery(real, servers, true));
  console.log('Вторая программа: настоящий движок');
  report('вторая программа', await programsBattery(real, true));
  console.log('Файл пользователю');
  report('файл', await saveBattery(real, true));
  console.log('Служба разработчика целиком');
  report('служба', await serviceBattery(DeveloperService, env, servers, true));

  console.log('Мутации главных защит (копия файла с одной сломанной защитой обязана уронить проверку)');
  type Kind = 'connections' | 'programs' | 'save' | 'engine' | 'worker' | 'service';
  const mutants: Array<{ name: string; file: string; from: string; to: string; kind: Kind }> = [
    { name: 'решение человека не записывается', file: 'studio/shell/runConnections.ts', from: 'await this.grants.decide(USER, run.manifest.id, decl.id, grantKey(decl), `${OWNER}:${run.id}`, decision);', to: '', kind: 'connections' },
    { name: 'молчание человека запоминается как отказ', file: 'studio/shell/runConnections.ts', from: "if (!decl || !decision || this.deps.current()?.id !== run.id) return refuse('NOT_ALLOWED');", to: "if (!decl) return refuse('NOT_ALLOWED');", kind: 'connections' },
    { name: 'параллельные вызовы задают столько вопросов, сколько их было', file: 'studio/shell/runConnections.ts', from: 'if (existing) return existing;', to: '', kind: 'connections' },
    { name: 'закрытие запуска не закрывает подключения', file: 'studio/shell/runConnections.ts', from: 'await this.service.closeSession(OWNER, runId);', to: '', kind: 'connections' },
    { name: 'ответ окна принимается с любым словом', file: 'studio/shell/runConnections.ts', from: '!(CONNECT_DECISIONS as readonly unknown[]).includes(decision)', to: 'false', kind: 'connections' },
    { name: 'решения пишутся в grants.json', file: 'studio/shell/runConnections.ts', from: 'new ModuleGrants(null)', to: "new ModuleGrants(require('node:path').join(require('node:os').tmpdir(), 'grants.json'))", kind: 'connections' },
    { name: 'метод на Python без подсказки', file: 'studio/shell/runPrograms.ts', from: "python && reply.code === 'FAILED'", to: 'false', kind: 'programs' },
    { name: 'убранная программа остаётся', file: 'studio/shell/runPrograms.ts', from: 'remove(id: string): boolean { return this.installed.delete(id); }', to: 'remove(id: string): boolean { return true; }', kind: 'programs' },
    { name: 'всё считается установленным', file: 'studio/shell/runPrograms.ts', from: 'isInstalled(id: string): boolean { return this.installed.has(id); }', to: 'isInstalled(id: string): boolean { return true; }', kind: 'programs' },
    { name: 'форма вызова не проверяется', file: 'studio/shell/runPrograms.ts', from: "if (!validMessage('program', envelope))", to: 'if (false as boolean)', kind: 'programs' },
    { name: 'метод считает не та программа', file: 'studio/shell/runPrograms.ts', from: 'const program = this.installed.get(target.moduleId);', to: 'const program = [...this.installed.values()][0];', kind: 'programs' },
    { name: 'плохое имя файла доходит до диалога', file: 'studio/shell/runSaveFile.ts', from: 'if (problem) throw new StudioFailure(', to: 'if (false as boolean) throw new StudioFailure(', kind: 'save' },
    { name: 'нет предела размера файла', file: 'studio/shell/runSaveFile.ts', from: "if (bytes.length > PAGE_LIMITS.saveChars) return 'cancelled';", to: '', kind: 'save' },
    { name: 'выбранное человеком имя не проверяется', file: 'studio/shell/runSaveFile.ts', from: 'if (!path.isAbsolute(chosen) || chosenProblem) throw', to: 'if (false as boolean) throw', kind: 'save' },
    { name: 'несколько диалогов сохранения сразу', file: 'studio/shell/runSaveFile.ts', from: "if (!this.dialog || this.open) return 'cancelled';", to: "if (!this.dialog) return 'cancelled';", kind: 'save' },
    { name: 'время расчёта не из константы Flux', file: 'studio/shared/controlsEngine.ts', from: 'options.timeoutMs ?? COMPUTE_LIMITS.timeoutMs', to: 'options.timeoutMs ?? 120_000', kind: 'engine' },
    { name: 'куча потока вдвое больше', file: 'studio/shared/controlsEngine.ts', from: 'heapMb: 256 } as const', to: 'heapMb: 512 } as const', kind: 'engine' },
    { name: 'нет предела файла логики TypeScript', file: 'studio/shared/controlsEngine.ts', from: 'if (Buffer.byteLength(compiled.code) > LIMITS.tsFileBytes) throw', to: 'if (false as boolean) throw', kind: 'engine' },
    { name: 'логика видит process', file: 'studio/shared/controlsWorker.ts', from: 'vm.createContext(Object.create(null))', to: 'vm.createContext({ process })', kind: 'worker' },
    { name: 'контекст логики создан из обычного объекта (выход через constructor)', file: 'studio/shared/controlsWorker.ts', from: 'vm.createContext(Object.create(null))', to: 'vm.createContext({})', kind: 'worker' },
    { name: 'runStop не закрывает подключения', file: 'studio/shell/developer.ts', from: 'await this.runHost.closeRun(run.id);', to: '', kind: 'service' },
    { name: 'новый запуск не закрывает прежний', file: 'studio/shell/developer.ts', from: 'await this.stopRun();\n    this.run = {', to: 'this.run = {', kind: 'service' },
    { name: 'выход из Studio не закрывает подключения', file: 'studio/shell/developer.ts', from: 'void this.runHost.shutdown();', to: '', kind: 'service' },
  ];
  const stamp = `__mutant_${process.pid}`;
  let n = 0;
  for (const mutant of mutants) {
    const source = fs.readFileSync(mutant.file, 'utf8');
    assert.ok(source.includes(mutant.from), `мутант «${mutant.name}»: фрагмент не найден в ${mutant.file}`);
    const target = path.join(path.dirname(mutant.file), `${stamp}_${++n}.ts`);
    fs.writeFileSync(target, source.replace(mutant.from, mutant.to));
    let outcome: Tally;
    try {
      if (mutant.kind === 'worker') {
        const worker = path.join(temp, `worker-${n}.cjs`);
        await esbuild.build({ entryPoints: [target], outfile: worker, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
        outcome = await engineBattery({ ...real, workerFile: worker });
      } else {
        const loaded = require(path.resolve(target));
        const impl: Impl = { ...real, RunConnections: loaded.RunConnections ?? RunConnections, RunPrograms: loaded.RunPrograms ?? RunPrograms, RunFileSaver: loaded.RunFileSaver ?? RunFileSaver, createControlsEngine: loaded.createControlsEngine ?? createControlsEngine };
        outcome = mutant.kind === 'connections' ? await connectionsBattery(impl, servers) : mutant.kind === 'programs' ? await programsBattery(impl)
          : mutant.kind === 'save' ? await saveBattery(impl) : mutant.kind === 'engine' ? await engineBattery(impl) : await serviceBattery(loaded.DeveloperService, env, servers);
      }
    } catch (error: any) {
      // Мутант ломает защиту так, что батарея не доходит до конца, — это тоже замеченная поломка
      outcome = { count: 0, failed: [`батарея прервалась: ${String(error?.message || error).slice(0, 120)}`], check() {} };
    } finally {
      fs.rmSync(target, { force: true });
      if (mutant.name === 'решения пишутся в grants.json') for (const f of fs.readdirSync(os.tmpdir())) if (/^grants\.json/.test(f)) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
    }
    ok(`мутация «${mutant.name}» замечена (${outcome.failed.length} проверок упало)`, outcome.failed.length > 0);
  }

  await servers.close();
  fs.rmSync(temp, { recursive: true, force: true });
  console.log(`\nПройдено проверок: ${passed}`);
}
main().then(() => process.exit(0)).catch(e => { console.error('✗', e?.stack || e); process.exit(1); });
