/**
 * «Собрать»: TypeScript проекта собирается внутри Studio (esbuild-wasm в рабочем потоке).
 *
 * Что доказывается (каждая проверка падает при поломке соответствующего места):
 * - чистые помощники: нормализация пути, поиск подключаемого файла, куда ложится собранный файл страницы;
 * - настоящая сборка в потоке: несколько файлов собираются в один; ошибки приходят по файлам, строкам и столбцам;
 *   несуществующий файл и пакет — понятные ошибки; зависшая сборка останавливается по времени;
 * - wasm-файл лежит рядом с потоком (на диске, не в сети), поэтому сборка работает без интернета;
 * - сверка типов настоящим компилятором TypeScript в отдельном постоянном потоке: ошибка типа в логике, в странице и в вызове
 *   flux.* (поле, ресурс, тип ответа) называет файл, строку, столбец и код; верный проект проходит; JS-файлы не сверяются;
 *   повторная сверка идёт по кэшу; зависшая сверка останавливается понятной проблемой;
 *   мутация «сверка выключена» (поток, который ничего не находит) этими же случаями обнаруживается;
 * - служба разработчика: «Собрать», «Запустить», «Проверить» и отправка сами собирают проект; ошибка сборки
 *   останавливает запуск и отправку и попадает в отчёт проверки строкой «файл:строка»; страница получает ui/*.js из src/*.ts.
 *
 * Запуск: npx tsx scripts/test-studio-tsbuild.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { DeveloperService } from '../studio/shell/developer';
import { createControlsEngine } from '../studio/shared/controlsEngine';
import { createTsBuilder } from '../studio/shared/tsBuildHost';
import { emittedPath, isTsSource, normalize, problemLine, resolveImport, tsEntries, withBuilt } from '../studio/shared/tsBuild';
import { ALL_ACTIONS } from '../studio/shell/actions';
import { fluxPageTypes } from '../modules/page/types';
import { TEMPLATE_IDS } from '../studio/shared/templates';

const require = createRequire(import.meta.url);
const { buildDeveloperAssets, buildTsWorker } = require('../studio/build-assets.cjs');
const esbuild = require('esbuild');
const timed = async <T>(run: () => Promise<T>): Promise<[T, number]> => { const t = performance.now(); const value = await run(); return [value, Math.round(performance.now() - t)]; };

let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const enc = (s: string) => new TextEncoder().encode(s);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-studio-tsbuild-'));

async function main() {
  console.log('Чистые помощники');
  ok('нормализация пути', normalize('./a/../b.ts') === 'b.ts' && normalize('a//b/./c') === 'a/b/c' && normalize('../x') === null);
  const has = (p: string) => ['src/a.ts', 'src/lib/index.ts', 'src/data.json', 'src/old.ts'].includes(p);
  ok('подключение с расширением и без', resolveImport('src/main.ts', './a', has) === 'src/a.ts' && resolveImport('src/main.ts', './a.ts', has) === 'src/a.ts');
  ok('подключение папки (index)', resolveImport('src/main.ts', './lib', has) === 'src/lib/index.ts');
  ok('подключение json', resolveImport('src/main.ts', './data.json', has) === 'src/data.json');
  ok('«.js» в подключении означает собранный .ts', resolveImport('src/main.ts', './old.js', has) === 'src/old.ts');
  ok('несуществующий файл и выход за проект → null', resolveImport('src/main.ts', './nope', has) === null && resolveImport('main.ts', '../x', has) === null);
  ok('файлы TypeScript без объявлений типов', isTsSource('a/b.ts') && isTsSource('c.tsx') && !isTsSource('x.d.ts') && !isTsSource('x.js'));
  ok('входы сборки отсортированы', tsEntries({ 'z.ts': enc(''), 'a.ts': enc(''), 'a.js': enc(''), 'types.d.ts': enc('') }).join() === 'a.ts,z.ts');
  ok('src/extra.ts → ui/extra.js, прочее — никуда', emittedPath('src/extra.ts') === 'ui/extra.js' && emittedPath('src/deep/x.tsx') === 'ui/deep/x.js' && emittedPath('logic/main.ts') === null);
  ok('withBuilt добавляет файл страницы и не затирает свой', (() => {
    const files = { 'ui/a.js': enc('mine') };
    const merged = withBuilt(files, { ok: true, problems: [], entries: [], outputs: { 'src/a.ts': 'x', 'src/b.ts': 'y', 'logic/main.ts': 'z' } });
    return new TextDecoder().decode(merged['ui/a.js']) === 'mine' && new TextDecoder().decode(merged['ui/b.js']) === 'y' && !('ui/main.js' in merged) && files['ui/a.js'] !== undefined && !('ui/b.js' in files);
  })());
  ok('строка проблемы «файл:строка:столбец: текст»', problemLine({ path: 'src/a.ts', line: 3, column: 7, text: 'плохо' }) === 'src/a.ts:3:7: плохо');

  console.log('Настоящая сборка в рабочем потоке');
  const app = path.join(temp, 'app');
  const assetsMap = await buildDeveloperAssets({ app, esbuild });
  ok('поток и wasm собраны вместе со Studio', 'tsBuildWorker' in assetsMap && fs.existsSync(path.join(app, 'ts-build-worker.cjs')) && fs.statSync(path.join(app, 'esbuild.wasm')).size > 1_000_000);
  const workerOnly = path.join(temp, 'worker-only.cjs');
  await buildTsWorker({ esbuild, outfile: workerOnly });
  ok('поток собирается отдельно (для проверок)', fs.existsSync(workerOnly));
  const builder = createTsBuilder({ workerFile: path.join(app, 'ts-build-worker.cjs'), wasmFile: path.join(app, 'esbuild.wasm'), typesWorkerFile: path.join(app, 'ts-type-worker.cjs'), timeoutMs: 60_000 });

  const good = await builder.build({
    'src/main.ts': enc("import { twice } from './lib/math';\nimport table from './table.json';\nexport const answer: number = twice(21) + table.extra;\n(globalThis as any).out = answer;"),
    'src/lib/math.ts': enc('export const twice = (n: number): number => n * 2;'),
    'src/table.json': enc('{"extra": 0}'),
    'src/types.d.ts': enc('declare const x: number;'),
  });
  ok('несколько файлов собираются без ошибок', good.ok && good.problems.length === 0);
  ok('собирается только файл TypeScript, не .d.ts и не .json', good.entries.join() === 'src/lib/math.ts,src/main.ts');
  ok('подключённые файлы вошли в сборку', /twice/.test(good.outputs['src/main.ts']) && !/import /.test(good.outputs['src/main.ts']));
  ok('собранный файл исполняется', (() => { const g: any = {}; new Function('globalThis', good.outputs['src/main.ts'])(g); return g.out === 42; })());

  const bad = await builder.build({
    'src/a.ts': enc('export const a = 1;\nconst x: = 2;\n'),
    'src/b.ts': enc("import './missing';\nimport 'left-pad';\nexport const b = 1;"),
  });
  ok('ошибки не пропускаются', !bad.ok && Object.keys(bad.outputs).length === 0);
  const at = (path: string, line: number) => bad.problems.find(p => p.path === path && p.line === line);
  ok('синтаксис: файл, строка и столбец', (() => { const p = at('src/a.ts', 2); return !!p && p.column > 0; })());
  ok('нет файла: сказано каким', bad.problems.some(p => p.path === 'src/b.ts' && p.line === 1 && /missing/.test(p.text) && /нет в проекте/.test(p.text)));
  ok('пакет вместо файла: понятная причина', bad.problems.some(p => p.path === 'src/b.ts' && p.line === 2 && /left-pad/.test(p.text) && /только файлы проекта/.test(p.text)));
  ok('в пути нет служебного пространства имён', bad.problems.every(p => !p.path.includes(':')));

  const slow = createTsBuilder({ workerFile: path.join(app, 'ts-build-worker.cjs'), wasmFile: path.join(app, 'esbuild.wasm'), typesWorkerFile: path.join(app, 'ts-type-worker.cjs'), timeoutMs: 5 });
  const stopped = await slow.build({ 'src/a.ts': enc('export const a = 1;') });
  ok('сборка, не уложившаяся во время, останавливается понятной проблемой', !stopped.ok && /не уложилась/.test(stopped.problems[0].text));
  const lost = await createTsBuilder({ workerFile: path.join(app, 'ts-build-worker.cjs'), wasmFile: path.join(temp, 'нет.wasm'), typesWorkerFile: path.join(app, 'ts-type-worker.cjs') }).build({ 'a.ts': enc('1') });
  ok('нет wasm-файла: проблема, а не зависание', !lost.ok && /не запустилась/.test(lost.problems[0].text));

  console.log('Сверка типов');
  ok('поток сверки собран, компилятор и библиотека внутри одного файла', fs.existsSync(path.join(app, 'ts-type-worker.cjs')) && 'tsTypeWorker' in assetsMap);
  const pageProject = (src: string, extra: Record<string, Uint8Array> = {}) => ({ 'ui/index.html': enc('<html></html>'), 'types/flux.d.ts': enc(fluxPageTypes()), 'src/app.ts': enc(src), ...extra });
  const wrap = (body: string) => `export async function main() {\n${body}\n}\n`;
  const problemAt = (r: { problems: any[] }, file: string, line: number, re: RegExp) => r.problems.find(p => p.path === file && p.line === line && p.column > 0 && re.test(p.text));

  const logicBad = await builder.build({ 'logic/main.ts': enc("export function compute(input: { a: number }) {\n  const n: number = 'x';\n  return { n, a: input.a };\n}\n") });
  ok('ошибка типа в логике: файл, строка, столбец и код', !logicBad.ok && !!problemAt(logicBad, 'logic/main.ts', 2, /^TS2322: /));
  ok('ошибка типов не даёт собранного файла', Object.keys(logicBad.outputs).length === 0);
  const pageBad = await builder.build(pageProject(wrap("  const n: number = 'сорок два';\n  return n;")));
  ok('ошибка типа в странице', !pageBad.ok && !!problemAt(pageBad, 'src/app.ts', 2, /TS2322/));
  const fluxField = await builder.build(pageProject(wrap("  const eq = await flux.read('equipment');\n  return eq?.nme;")));
  ok('flux.*: не то поле ответа', !fluxField.ok && !!problemAt(fluxField, 'src/app.ts', 3, /nme/));
  const fluxResource = await builder.build(pageProject(wrap("  await flux.read('equipmnt');")));
  ok('flux.*: ресурса нет в договоре', !fluxResource.ok && !!problemAt(fluxResource, 'src/app.ts', 2, /equipmnt/));
  const fluxType = await builder.build(pageProject(wrap("  const answer: number = await flux.dialogs.confirm({ title: 'a', text: 'b' });\n  return answer;")));
  ok('flux.*: не тот тип ответа', !fluxType.ok && !!problemAt(fluxType, 'src/app.ts', 2, /boolean/));
  const fluxCall = await builder.build(pageProject(wrap("  await flux.windows.open(5);")));
  ok('flux.*: неверный вызов', !fluxCall.ok && !!problemAt(fluxCall, 'src/app.ts', 2, /number/));
  const noTypesFile = await builder.build({ 'ui/index.html': enc('<html></html>'), 'src/app.ts': enc(wrap("  await flux.read('equipmnt');")) });
  ok('у страницы без своего types/flux.d.ts описание flux.* подставляется то же', !noTypesFile.ok && !!problemAt(noTypesFile, 'src/app.ts', 2, /equipmnt/));
  const formNoFlux = await builder.build({ 'logic/main.ts': enc('export const n = flux.read;\n') });
  ok('у формы без страницы глобального flux нет: обращение к нему — ошибка', !formNoFlux.ok && !!problemAt(formNoFlux, 'logic/main.ts', 1, /flux/));
  const strictNull = await builder.build({ 'logic/main.ts': enc('export function f(a: string | null) {\n  return a.length;\n}\n') });
  ok('строгий режим: null не пропускается', !strictNull.ok && !!problemAt(strictNull, 'logic/main.ts', 2, /null/));

  const goodPage = await builder.build(pageProject(wrap("  const eq = await flux.read('equipment');\n  const name: string | undefined = eq?.name;\n  const yes: boolean = await flux.dialogs.confirm({ title: 'a', text: 'b' });\n  await flux.windows.open('index.html');\n  document.title = name ?? String(yes);\n  flux.log.info('готово');"), { 'src/helper.ts': enc('export const twice = (n: number) => n * 2;\n') }));
  ok('верная страница с flux.*, document и строгими типами проходит', goodPage.ok && goodPage.problems.length === 0 && 'src/app.ts' in goodPage.outputs);
  const jsOnly = await builder.build({ 'ui/app.js': enc('const n = 1; n.nothing(); flux.read(5);\n'), 'logic/main.ts': enc('export const a = 1;\n') });
  ok('JS-файлы проекта не сверяются', jsOnly.ok);
  const jsImported = await builder.build({ 'src/a.ts': enc("import { f } from './b.js';\nexport const x: number = f(1);\n"), 'src/b.js': enc('export const f = (n) => n + 1;\n') });
  ok('подключённый .js не превращается в ошибку «нет объявлений типов»', jsImported.ok);
  const both = await builder.build({ 'src/a.ts': enc("export const a: number = 'x';\n"), 'src/b.ts': enc("import './missing';\nexport const b: string = 1;\n") });
  ok('ошибки типов и сборки показываются вместе', !both.ok && both.problems.some(p => p.path === 'src/a.ts' && /TS2322/.test(p.text)) && both.problems.some(p => p.path === 'src/b.ts' && /нет в проекте/.test(p.text)) && both.problems.some(p => p.path === 'src/b.ts' && p.line === 2 && /TS2322/.test(p.text)));
  ok('синтаксическая ошибка не дублируется сверкой типов', bad.problems.filter(p => p.path === 'src/a.ts' && p.line === 2).length === 1);

  // Кэш программы: тот же проект второй раз и проект с одним изменённым файлом идут не медленнее первой (холодной) сверки
  const big = (n: number) => ({ 'src/m.ts': enc(`export const v: number = ${n};\n`), ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`src/f${i}.ts`, enc(`export const f${i} = (a: number): number => a + ${i};\n`)])) });
  const coldBuilder = createTsBuilder({ workerFile: path.join(app, 'ts-build-worker.cjs'), wasmFile: path.join(app, 'esbuild.wasm'), typesWorkerFile: path.join(app, 'ts-type-worker.cjs') });
  const [c1, cold] = await timed(() => coldBuilder.build(big(1)));
  const [c2, same] = await timed(() => coldBuilder.build(big(1)));
  const [c3, edited] = await timed(() => coldBuilder.build(big(2)));
  console.log(`  время «Собрать» (esbuild и типы), мс: холодная ${cold}, повтор ${same}, правка одного файла ${edited}`);
  ok('кэш: повторные сборки проходят и не медленнее холодной', c1.ok && c2.ok && c3.ok && same <= cold && edited <= cold);
  coldBuilder.close?.();

  // Предел времени: сверка, не уложившаяся, — понятная проблема, а не зависание
  const tight = createTsBuilder({ workerFile: path.join(app, 'ts-build-worker.cjs'), wasmFile: path.join(app, 'esbuild.wasm'), typesWorkerFile: path.join(app, 'ts-type-worker.cjs'), typeTimeoutMs: 1 });
  const cut = await tight.build({ 'src/a.ts': enc('export const a = 1;') });
  ok('сверка типов, не уложившаяся во время, останавливается понятной проблемой', !cut.ok && cut.problems.some(p => /Сверка типов не уложилась/.test(p.text)) && Object.keys(cut.outputs).length === 0);
  tight.close?.();
  const noWorker = createTsBuilder({ workerFile: path.join(app, 'ts-build-worker.cjs'), wasmFile: path.join(app, 'esbuild.wasm'), typesWorkerFile: path.join(temp, 'нет.cjs') });
  const noWorkerResult = await noWorker.build({ 'src/a.ts': enc('export const a = 1;') });
  ok('нет файла потока сверки: проблема, а не зависание и не молчаливый пропуск', !noWorkerResult.ok && noWorkerResult.problems.some(p => /Сверка типов/.test(p.text)));

  // Мутация «сверка выключена»: поток, который ничего не находит. Те же случаи должны его обнаружить
  const stub = path.join(temp, '__mutant_types-off.cjs');
  fs.writeFileSync(stub, "const { parentPort } = require('node:worker_threads');\nparentPort.on('message', m => parentPort.postMessage({ id: m.id, ok: true, problems: [] }));\n");
  const mutant = createTsBuilder({ workerFile: path.join(app, 'ts-build-worker.cjs'), wasmFile: path.join(app, 'esbuild.wasm'), typesWorkerFile: stub });
  const catches = async (b: typeof builder) => !(await b.build({ 'logic/main.ts': enc("export const n: number = 'x';\n") })).ok && !(await b.build(pageProject(wrap("  await flux.read('equipmnt');")))).ok;
  ok('мутация «сверка выключена» обнаруживается теми же случаями', (await catches(builder)) && !(await catches(mutant)));
  mutant.close?.();

  console.log('Служба разработчика');
  const storage = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s).reverse(), decryptString: (b: Buffer) => Buffer.from(b).reverse().toString() };
  const dialogs: Array<{ title: string; filters: unknown[] }> = [];
  const picked: { path: string | null } = { path: null };
  const service = new DeveloperService({
    dir: path.join(temp, 'data'), storage, version: '1.0.0', session: () => ({ origin: 'http://127.0.0.1:1', token: 'token-dev-long-enough', user: { id: 'dev', name: 'Разработчик' }, owner: false }),
    assets: { templatesRoot: path.join(app, 'templates'), runtimeDir: path.join(app, 'runtime') },
    engine: createControlsEngine({ workerFile: path.join(app, 'controls-worker.cjs'), timeoutMs: 5000 }),
    tsBuilder: builder,
    // Диалог выбора файла главного процесса: подставляется проверкой (flux.openFile в запуске Studio)
    pickDataFile: async options => { dialogs.push(options); return picked.path; },
  });
  const call = (action: string, args: Record<string, unknown> = {}): Promise<any> => service.handle(action as never, args);
  ok('действие «build» объявлено', ALL_ACTIONS.includes('build'));
  await call('draftCreate', { template: 'typescript', id: 'logic-demo', name: 'Логика', kind: 'form' });
  const first = await call('build', { id: 'logic-demo' });
  ok('«Собрать» проекта-шаблона проходит', first.ok && first.files.includes('logic/main.ts'));
  // Заготовки всех языков (формой и страницей) и пример собираются без ошибок типов; строгость не ослабляется — чинится заготовка
  for (const template of TEMPLATE_IDS) for (const kind of template === 'translator' ? ['form'] : ['form', 'page']) {
    const id = `t-${template}-${kind}`;
    await call('draftCreate', { template, id, name: `Заготовка ${template}`, kind });
    const [made, ms] = await timed(() => call('build', { id }));
    if (template === 'typescript' || template === 'translator') console.log(`  «Собрать» ${template}/${kind}: ${ms} мс`);
    ok(`заготовка ${template} (${kind}) собирается без ошибок типов`, made.ok && made.problems.length === 0 && (template !== 'typescript' && template !== 'translator' || made.files.length > 0));
  }
  await call('draftSave', { id: 'logic-demo', path: 'logic/helper.ts', text: 'export const n: number = ;\n' });
  const broken = await call('build', { id: 'logic-demo' });
  ok('«Собрать» называет файл и строку', !broken.ok && broken.problems.some((p: any) => p.path === 'logic/helper.ts' && p.line === 1));
  const run = await call('runStart', { id: 'logic-demo' }).catch((e: Error) => e);
  ok('«Запустить» сама собирает и останавливается на ошибке с файлом и строкой', run instanceof Error && /logic\/helper\.ts:1:/.test(run.message));
  const report = await call('check', { id: 'logic-demo' });
  ok('«Проверить» кладёт ошибку сборки в отчёт строкой «файл:строка»', !report.ok && report.items.some((i: any) => i.id === 'build' && i.status === 'fail' && /^logic\/helper\.ts:1:\d+: /.test(i.detail)));
  const sent = await call('publish', { id: 'logic-demo' }).catch((e: Error) => e);
  ok('отправка не проходит мимо ошибки сборки', sent instanceof Error && /Сборка TypeScript не прошла/.test(sent.message));
  await call('draftSave', { id: 'logic-demo', path: 'logic/helper.ts', text: 'export const n: number = 1;\n' });
  const fixed = await call('runStart', { id: 'logic-demo' });
  ok('после исправления запуск идёт', typeof fixed.session === 'string');

  await call('draftCreate', { template: 'typescript', id: 'page-demo', name: 'Страница', kind: 'page' });
  await call('draftSave', { id: 'page-demo', path: 'src/extra.ts', text: "import { hello } from './hello';\n(globalThis as any).fluxPageTs = hello('мир');\n" });
  await call('draftSave', { id: 'page-demo', path: 'src/hello.ts', text: 'export const hello = (who: string): string => `привет, ${who}`;\n' });
  const page = await call('runStart', { id: 'page-demo' });
  ok('страница запускается', typeof page.session === 'string');
  const served = service.asset('flux-module://run/ui/extra.js');
  ok('запуск отдаёт ui/extra.js, собранный из src/extra.ts', !!served && /привет/.test(Buffer.from(served.body as Uint8Array).toString('utf8')));
  ok('исходник .ts в черновик страницы не подмешивается, а собранный файл на диск не пишется', !fs.existsSync(path.join((await call('draftTree', { id: 'page-demo' })).folder, 'ui/extra.js')));

  console.log('flux.openFile в запуске Studio');
  const dataFile = path.join(temp, 'выбранный.csv'); fs.writeFileSync(dataFile, 'a;b');
  picked.path = dataFile;
  const reply = await call('runPickFile', { accept: ['.csv'] });
  ok('диалог главного процесса назван по программе и отдаёт имя и содержимое только выбранного файла', reply.ok === true && reply.name === 'выбранный.csv' && Buffer.from(reply.data, 'base64').toString() === 'a;b' && !JSON.stringify(reply).includes(temp) && /Страница/.test(dialogs[0].title));
  picked.path = null;
  ok('отказ человека — CANCELLED', (await call('runPickFile', {})).code === 'CANCELLED');
  ok('неверное расширение — DENIED, диалог не показан', (await call('runPickFile', { accept: ['csv'] })).code === 'DENIED' && dialogs.length === 2);
  await call('runStart', { id: 'logic-demo' });
  ok('запущена форма, а не страница — файл не выдаётся', await call('runPickFile', {}).then(() => false, (e: Error) => /со своим экраном/.test(e.message)));
  ok('действие «runPickFile» объявлено', ALL_ACTIONS.includes('runPickFile'));


  console.log('flux.net.fetch в запуске Studio');
  const NET_DOES = 'Показывает курсы валют из открытого сервиса';
  const own = Object.values(os.networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal)?.address;
  const withPermission = async (kind: string | null) => {
    const manifest = JSON.parse((await call('draftFile', { id: 'page-demo', path: 'manifest.json' })).text);
    delete manifest.permissions;
    if (kind) { manifest.permissions = [{ kind, does: NET_DOES }]; manifest.contractVersion = 3; } else manifest.contractVersion = 2;
    await call('draftSave', { id: 'page-demo', path: 'manifest.json', text: JSON.stringify(manifest, null, 2) });
    await call('runStart', { id: 'page-demo' });
  };
  const net = (url: string, method = 'GET') => call('runNet', { call: { url, method } });
  const hits: string[] = [];
  const probe = http.createServer((req, res) => { hits.push(req.url || ''); res.end('курс'); });
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const loopPort = (probe.address() as any).port;
  await withPermission(null);
  ok('без permissions Studio отвечает так же, как Flux: DENIED, до сервера не доходит', (await net(`http://127.0.0.1:${loopPort}/x`)).code === 'DENIED' && hits.length === 0);
  await withPermission('internet');
  ok('адрес этого компьютера закрыт даже с internet', (await net(`http://127.0.0.1:${loopPort}/x`)).code === 'TARGET' && (await net(`http://localhost:${loopPort}/x`)).code === 'TARGET' && hits.length === 0);
  ok('метаданные облака закрыты даже с internet', (await net('http://169.254.169.254/latest/meta-data/')).code === 'TARGET');
  ok('частный адрес при одном internet закрыт', (await net('http://192.168.1.1/')).code === 'TARGET');
  ok('кривой вызов — DENIED', (await call('runNet', { call: { url: 'http://x.invalid/', method: 'GET', extra: 1 } })).code === 'DENIED');
  if (own) {
    const other = http.createServer((req, res) => { hits.push(`own:${req.method} ${req.url}`); res.end('курс'); });
    await new Promise<void>(r => other.listen(0, own, r));
    const port = (other.address() as any).port;
    const { netAddressAllowed } = await import('../modules/permissions/netAddress');
    const kind = netAddressAllowed(own, { internet: true, lan: false }) ? 'internet' : 'lan';
    await withPermission(kind);
    const reply = await net(`http://${own}:${port}/rates`);
    ok(`настоящий запрос к адресу компьютера ${own} (${kind}): ответ получен`, reply.ok === true && reply.data.status === 200 && reply.data.body === 'курс' && hits.includes('own:GET /rates'));
    await withPermission(kind === 'internet' ? 'lan' : 'internet');
    const refused = await net(`http://${own}:${port}/rates2`);
    ok('другое разрешение того же адреса не открывает', refused.code === 'TARGET' && !hits.includes('own:GET /rates2'));
    other.close();
  } else console.log('  (пропуск: у контейнера нет сетевого адреса кроме петли — положительный запрос проверен в test-modules-net)');
  await call('runStart', { id: 'logic-demo' });
  ok('запущена форма, а не страница — сеть не выдаётся', await net('http://example.com/').then(() => false, (e: Error) => /со своим экраном/.test(e.message)));
  probe.close();

  console.log(`\nПройдено: ${passed}`);
  fs.rmSync(temp, { recursive: true, force: true });
}

main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
