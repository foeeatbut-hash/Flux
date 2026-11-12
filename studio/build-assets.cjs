'use strict';
/**
 * Заготовки, без которых Studio не запускает и не проверяет программы, — собираются вместе с самой Studio.
 *
 * В упакованной программе компилятора esbuild нет, поэтому окно программы, её Worker, рабочий поток
 * контрольных примеров и файлы заготовок проектов готовятся здесь, при сборке (см. studio/shared/runtime.ts).
 * Файл подключается из studio/build.cjs и из проверок, которые собирают заготовки во временный каталог.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const SENTINEL = { form: '@@FLUX_MODULE_FORM@@', worker: '@@FLUX_MODULE_WORKER@@' };
/** Какие папки modules/fixtures нужны заготовкам проектов: по языку и общие форма с контрольными примерами */
const TEMPLATE_DIRS = ['typescript', 'python', 'c', 'cpp', 'rust', 'go', 'csharp', 'stats', 'translator'];
const SKIP = new Set(['target', 'node_modules', 'bin', 'obj']);

function copyTemplate(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const source = path.join(from, entry.name);
    if (entry.isDirectory()) copyTemplate(source, path.join(to, entry.name));
    else fs.copyFileSync(source, path.join(to, entry.name));
  }
}

/** Проверщики сообщений моста: код генерирует Ajv при сборке, потому что CSP окон Studio и программы запрещает eval */
async function loadStaticValidation(esbuild) {
  const validators = await esbuild.build({
    entryPoints: [path.join(root, 'studio/shared/validatorSource.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent',
  });
  const holder = { exports: {} };
  new Function('module', 'exports', 'require', validators.outputFiles[0].text)(holder, holder.exports, require);
  return holder.exports.staticValidators();
}

/**
 * Рабочий поток сборки TypeScript. В потоке подставляется браузерная сборка пакета esbuild-wasm:
 * основная запускала бы отдельную программу esbuild, а не wasm. Возвращает карту сборки.
 */
async function buildTsWorker({ esbuild, outfile }) {
  const built = await esbuild.build({
    entryPoints: [path.join(root, 'studio/shared/tsBuildWorker.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', metafile: true,
    alias: { 'esbuild-wasm': path.join(root, 'node_modules/esbuild-wasm/lib/browser.js') },
  });
  return built.metafile;
}

/** Возвращает карты сборки (для проверки бандла) */
async function buildDeveloperAssets({ app, esbuild }) {
  const metafiles = {};
  const staticValidation = await loadStaticValidation(esbuild);

  const dir = path.join(app, 'runtime');
  fs.mkdirSync(dir, { recursive: true });
  const browser = { bundle: true, write: false, platform: 'browser', format: 'iife', logLevel: 'silent', metafile: true };
  const worker = await esbuild.build({
    ...browser, entryPoints: [path.join(root, 'modules/runtime/worker.ts')], alias: { 'module-logic': path.join(root, 'studio/shared/logicShim.cjs') },
  });
  metafiles.runtimeWorker = worker.metafile;
  const frame = await esbuild.build({
    ...browser, entryPoints: [path.join(root, 'modules/runtime/frame.ts')],
    define: {
      __MODULE_FORM__: JSON.stringify(SENTINEL.form), __MODULE_WORKER__: JSON.stringify(SENTINEL.worker),
      // Язык нельзя подставить меткой-строкой: esbuild сравнит её с 'typescript' при сборке и вырежет ветку.
      // Поэтому это переменная окна, которую runtime.ts задаёт первой строкой готового runtime.js
      __MODULE_LANGUAGE__: 'globalThis.__fluxLanguage',
    },
    plugins: [{ name: 'static-contract-validators', setup(plugin) {
      plugin.onResolve({ filter: /^\.\.\/schemas$/ }, () => ({ path: 'validators', namespace: 'module-validators' }));
      plugin.onLoad({ filter: /.*/, namespace: 'module-validators' }, () => ({ contents: staticValidation, loader: 'js', resolveDir: root }));
    } }],
  });
  metafiles.runtimeFrame = frame.metafile;
  fs.writeFileSync(path.join(dir, 'frame.js'), frame.outputFiles[0].text);
  fs.writeFileSync(path.join(dir, 'worker.js'), worker.outputFiles[0].text);
  fs.copyFileSync(path.join(root, 'studio/shared/moduleShell.css'), path.join(dir, 'flux.css'));
  // Клиент flux.* и набор Flux для страниц программ (договор v2): те же файлы, что Flux отдаёт по /_flux/
  const pageClient = await esbuild.build({ ...browser, entryPoints: [path.join(root, 'modules/page/client.ts')], minify: true });
  metafiles.pageClient = pageClient.metafile;
  fs.writeFileSync(path.join(dir, 'flux.v1.js'), pageClient.outputFiles[0].text);
  fs.copyFileSync(path.join(root, 'modules/page/flux-ui.v1.css'), path.join(dir, 'flux-ui.v1.css'));
  // Страница окна программы — та же, что у Flux (modules/build.ts, shellAssets)
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html lang="ru" style="background:var(--flux-surface)">'
    + '<head><meta charset="utf-8"><link rel="stylesheet" href="./flux.css"></head>'
    + '<body style="margin:0;min-height:100vh;background:var(--flux-surface);color:var(--flux-text)">'
    + '<main id="module-root" style="font-size:13px;padding:12px">Загрузка…</main>'
    + '<script src="./runtime.js"></script></body></html>');

  const controls = await esbuild.build({
    entryPoints: [path.join(root, 'studio/shared/controlsWorker.ts')], outfile: path.join(app, 'controls-worker.cjs'),
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', metafile: true,
  });
  metafiles.controlsWorker = controls.metafile;

  // Сборка TypeScript: рабочий поток с esbuild-wasm и сам wasm-файл (из пакета esbuild-wasm, интернет не нужен)
  metafiles.tsBuildWorker = await buildTsWorker({ esbuild, outfile: path.join(app, 'ts-build-worker.cjs') });
  fs.copyFileSync(path.join(root, 'node_modules/esbuild-wasm/esbuild.wasm'), path.join(app, 'esbuild.wasm'));

  for (const name of TEMPLATE_DIRS) copyTemplate(path.join(root, 'modules/fixtures', name), path.join(app, 'templates', name));
  return metafiles;
}

module.exports = { buildDeveloperAssets, buildTsWorker, loadStaticValidation, SENTINEL };
