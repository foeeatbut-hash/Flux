import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { bundledModules } from './bundled';
import { validManifest } from './schemas';
import Ajv from 'ajv';
import standaloneCode from 'ajv/dist/standalone';
import { messageSchemas } from './schemas';

export async function buildModuleAssets(css: string, fonts: Record<string, string | Uint8Array>) {
  const assets: Record<string, string | Uint8Array> = {};
  const validator = new Ajv({ strict: false, code: { source: true } });
  for (const [key, schema] of Object.entries(messageSchemas)) validator.addSchema(schema, key);
  const staticValidation = standaloneCode(validator, Object.fromEntries(Object.keys(messageSchemas).map(key => [key, key])))
    + '\nexports.validMessage = (type, value) => !!exports[type]?.(value);';
  for (const manifest of bundledModules) {
    if (!validManifest(manifest)) throw new Error('Манифест фикстуры не соответствует договору v1');
    const fixture = path.resolve('modules/fixtures', manifest.id);
    const worker = await build({
      entryPoints: ['modules/runtime/worker.ts'], bundle: true, write: false, platform: 'browser', format: 'iife',
      alias: { 'module-logic': path.join(fixture, manifest.logic) },
    });
    const frame = await build({
      entryPoints: ['modules/runtime/frame.ts'], bundle: true, write: false, platform: 'browser', format: 'iife',
      define: {
        __MODULE_FORM__: fs.readFileSync(path.join(fixture, 'form.json'), 'utf8'),
        __MODULE_WORKER__: JSON.stringify(worker.outputFiles[0].text),
      },
      plugins: [{ name: 'static-contract-validators', setup(plugin) {
        // CSP модуля запрещает eval/new Function: Ajv выполняет генерацию только при сборке.
        plugin.onResolve({ filter: /^\.\.\/schemas$/ }, () => ({ path: 'validators', namespace: 'module-validators' }));
        plugin.onLoad({ filter: /.*/, namespace: 'module-validators' }, () => ({
          contents: staticValidation, loader: 'js', resolveDir: process.cwd(),
        }));
      } }],
    });
    const prefix = `modules/${manifest.id}/`;
    assets[`${prefix}runtime.js`] = frame.outputFiles[0].text;
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
  return assets;
}
