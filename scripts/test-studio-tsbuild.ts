/**
 * «Собрать»: TypeScript проекта собирается внутри Studio (esbuild-wasm в рабочем потоке).
 *
 * Что доказывается (каждая проверка падает при поломке соответствующего места):
 * - чистые помощники: нормализация пути, поиск подключаемого файла, куда ложится собранный файл страницы;
 * - настоящая сборка в потоке: несколько файлов собираются в один; ошибки приходят по файлам, строкам и столбцам;
 *   несуществующий файл и пакет — понятные ошибки; зависшая сборка останавливается по времени;
 * - wasm-файл лежит рядом с потоком (на диске, не в сети), поэтому сборка работает без интернета;
 * - служба разработчика: «Собрать», «Запустить», «Проверить» и отправка сами собирают проект; ошибка сборки
 *   останавливает запуск и отправку и попадает в отчёт проверки строкой «файл:строка»; страница получает ui/*.js из src/*.ts.
 *
 * Запуск: npx tsx scripts/test-studio-tsbuild.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DeveloperService } from '../studio/shell/developer';
import { createControlsEngine } from '../studio/shared/controlsEngine';
import { createTsBuilder } from '../studio/shared/tsBuildHost';
import { emittedPath, isTsSource, normalize, problemLine, resolveImport, tsEntries, withBuilt } from '../studio/shared/tsBuild';
import { ALL_ACTIONS } from '../studio/shell/actions';

const require = createRequire(import.meta.url);
const { buildDeveloperAssets, buildTsWorker } = require('../studio/build-assets.cjs');
const esbuild = require('esbuild');

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
  const builder = createTsBuilder({ workerFile: path.join(app, 'ts-build-worker.cjs'), wasmFile: path.join(app, 'esbuild.wasm'), timeoutMs: 60_000 });

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

  const slow = createTsBuilder({ workerFile: path.join(app, 'ts-build-worker.cjs'), wasmFile: path.join(app, 'esbuild.wasm'), timeoutMs: 5 });
  const stopped = await slow.build({ 'src/a.ts': enc('export const a = 1;') });
  ok('сборка, не уложившаяся во время, останавливается понятной проблемой', !stopped.ok && /не уложилась/.test(stopped.problems[0].text));
  const lost = await createTsBuilder({ workerFile: path.join(app, 'ts-build-worker.cjs'), wasmFile: path.join(temp, 'нет.wasm') }).build({ 'a.ts': enc('1') });
  ok('нет wasm-файла: проблема, а не зависание', !lost.ok && /не запустилась/.test(lost.problems[0].text));

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

  console.log(`\nПройдено: ${passed}`);
  fs.rmSync(temp, { recursive: true, force: true });
}

main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
