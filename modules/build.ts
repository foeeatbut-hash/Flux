import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { bundledModules } from './bundled';
import { validManifest } from './schemas';
import { validateModuleForm } from './validateForm';
import Ajv from 'ajv';
import standaloneCode from 'ajv/dist/standalone';
import { messageSchemas } from './schemas';
import { MODULE_COMPUTE_HOST, MODULE_SHELL_DIR } from './protocol';
import type { ModuleManifest } from './contract';
import { languageOf } from './engine/types';

function staticValidators() {
  const validator = new Ajv({ strict: false, code: { source: true } });
  for (const [key, schema] of Object.entries(messageSchemas)) validator.addSchema(schema, key);
  return standaloneCode(validator, Object.fromEntries(Object.keys(messageSchemas).map(key => [key, key])))
    + '\nexports.validMessage = (type, value) => !!exports[type]?.(value);';
}

/**
 * runtime.js модуля из его папки: frame + форма + Worker с логикой. Тот же
 * путь для встроенных примеров и для пакета запроса на публикацию
 * (`build/runtime.js`), чтобы владелец проверял исходники, из которых
 * собрано ровно это.
 */
export async function buildModuleRuntime(dir: string, manifest: ModuleManifest, staticValidation = staticValidators()): Promise<string> {
  if (!validManifest(manifest)) throw new Error('Манифест модуля не соответствует договору v1');
  const form = JSON.parse(fs.readFileSync(path.join(dir, 'form.json'), 'utf8'));
  validateModuleForm(form, manifest.id, manifest.reads);
  const language = languageOf(manifest);
  // Python и WebAssembly исполняет окно Flux (src/services/moduleCompute.ts): в iframe Worker с логикой не нужен
  const worker = language === 'typescript' ? await build({
    entryPoints: ['modules/runtime/worker.ts'], bundle: true, write: false, platform: 'browser', format: 'iife',
    alias: { 'module-logic': path.join(dir, manifest.logic) },
  }) : null;
  const frame = await build({
    entryPoints: ['modules/runtime/frame.ts'], bundle: true, write: false, platform: 'browser', format: 'iife',
    define: {
      __MODULE_FORM__: JSON.stringify(form),
      __MODULE_WORKER__: JSON.stringify(worker ? worker.outputFiles[0].text : ''),
      __MODULE_LANGUAGE__: JSON.stringify(language),
    },
    plugins: [{ name: 'static-contract-validators', setup(plugin) {
      // CSP модуля запрещает eval/new Function: Ajv выполняет генерацию только при сборке.
      plugin.onResolve({ filter: /^\.\.\/schemas$/ }, () => ({ path: 'validators', namespace: 'module-validators' }));
      plugin.onLoad({ filter: /.*/, namespace: 'module-validators' }, () => ({
        contents: staticValidation, loader: 'js', resolveDir: process.cwd(),
      }));
    } }],
  });
  return frame.outputFiles[0].text;
}

export async function buildModuleAssets(css: string, fonts: Record<string, string | Uint8Array>) {
  const assets: Record<string, string | Uint8Array> = {};
  const staticValidation = staticValidators();
  for (const manifest of bundledModules) {
    if (!validManifest(manifest)) throw new Error('Манифест фикстуры не соответствует договору v1');
    assets[`modules/${manifest.id}/runtime.js`] = await buildModuleRuntime(path.resolve('modules/fixtures', manifest.id), manifest, staticValidation);
    shellAssets(assets, `modules/${manifest.id}/`, css, fonts);
  }
  // Общая оболочка для выпусков из базы: index.html, стили и шрифты те же, что у
  // встроенных, а runtime.js берётся из проверенного выпуска (electron/modules.ts)
  shellAssets(assets, `modules/${MODULE_SHELL_DIR}/`, css, fonts);
  Object.assign(assets, await buildComputeAssets());
  return assets;
}

/** Файлы Pyodide, которые уходят в portable: ядро и стандартная библиотека. Остальное (тесты, карты, консоль) не нужно */
export const PYODIDE_FILES = ['pyodide.js', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'] as const;

/**
 * Хост общей среды Python (`flux-module://_compute/`): страница, скрипт хоста со
 * встроенным Worker'ом и файлы Pyodide из пакета npm. Pyodide кладётся в
 * сборку, а не берётся из интернета: сеть подпрограммам закрыта, а Flux
 * должен работать офлайн.
 */
export async function buildComputeAssets(): Promise<Record<string, string | Uint8Array>> {
  const assets: Record<string, string | Uint8Array> = {};
  const prefix = `modules/${MODULE_COMPUTE_HOST}/`;
  const worker = await build({ entryPoints: ['modules/compute/pythonWorker.ts'], bundle: true, write: false, platform: 'browser', format: 'iife', minify: true });
  const host = await build({
    entryPoints: ['modules/compute/hostFrame.ts'], bundle: true, write: false, platform: 'browser', format: 'iife', minify: true,
    define: { __PYTHON_WORKER__: JSON.stringify(worker.outputFiles[0].text) },
  });
  assets[`${prefix}host.js`] = host.outputFiles[0].text;
  assets[`${prefix}index.html`] = '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Среда Python</title></head><body><script src="./host.js"></script></body></html>';
  const pyodide = path.dirname(path.resolve('node_modules/pyodide/package.json'));
  for (const file of PYODIDE_FILES) {
    const source = path.join(pyodide, file);
    if (!fs.existsSync(source)) throw new Error(`Нет ${file} в node_modules/pyodide: выполните npm ci`);
    assets[`${prefix}pyodide/${file}`] = fs.readFileSync(source);
  }
  return assets;
}

function shellAssets(assets: Record<string, string | Uint8Array>, prefix: string, css: string, fonts: Record<string, string | Uint8Array>) {
  let inlineFont = 0;
  // Vite встраивает маленькие подмножества Inter в CSS. Выносим их в свои
  // файлы, чтобы CSP не пришлось открывать data: для ресурсов модуля.
  assets[`${prefix}flux.css`] = css.replace(/data:font\/woff2;base64,([A-Za-z0-9+/=]+)/g, (_url, encoded: string) => {
    const file = `inline-font-${++inlineFont}.woff2`;
    assets[`${prefix}${file}`] = new Uint8Array(Buffer.from(encoded, 'base64'));
    return `./${file}`;
  });
  assets[`${prefix}index.html`] = '<!doctype html><html lang="ru" style="background:var(--flux-surface)">'
    + '<head><meta charset="utf-8"><link rel="stylesheet" href="./flux.css"></head>'
    + '<body style="margin:0;min-height:100vh;background:var(--flux-surface);color:var(--flux-text)">'
    + '<main id="module-root" style="font-size:13px;padding:12px">Загрузка…</main>'
    + '<script src="./runtime.js"></script></body></html>';
  for (const [file, source] of Object.entries(fonts)) assets[`${prefix}${path.basename(file)}`] = source;
}
