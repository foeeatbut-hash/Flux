/**
 * Сборка runtime.js подпрограммы без esbuild.
 *
 * Во Flux runtime.js собирает esbuild (modules/build.ts). Упакованная Studio компилятора не
 * везёт, поэтому всё тяжёлое сделано при сборке самой Studio (studio/build-assets.cjs):
 * окно подпрограммы (`frame`) и Worker (`worker`) собраны один раз с метками вместо формы и
 * Worker'а (и переменной вместо языка), а здесь метки заменяются настоящими значениями. Получается тот же
 * runtime.js, что собрал бы modules/build.ts: тот же код frame.ts и worker.ts.
 *
 * Логика на TypeScript переводится в CommonJS (logicSource.ts) и дописывается перед Worker'ом
 * как значение `globalThis.__fluxLogic`, которое Worker читает вместо `import 'module-logic'`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { languageOf } from '../../modules/engine/types';
import type { ModuleManifest } from '../../modules/contract';
import { compileLogic } from './logicSource';
import type { ProjectFiles } from './templates';

export interface RuntimeTemplates { frame: string; worker: string; html: string; css: string; /** Клиент flux.* и набор Flux для страниц (договор v2); пусто в сборке без них */ pageClient: string; pageCss: string }

export const SENTINELS = { form: '"@@FLUX_MODULE_FORM@@"', worker: '"@@FLUX_MODULE_WORKER@@"' } as const;

export function loadRuntimeTemplates(dir: string): RuntimeTemplates {
  const read = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8');
  const optional = (name: string) => { try { return read(name); } catch { return ''; } };
  return { frame: read('frame.js'), worker: read('worker.js'), html: read('index.html'), css: read('flux.css'), pageClient: optional('flux.v1.js'), pageCss: optional('flux-ui.v1.css') };
}

export function assembleRuntime(templates: RuntimeTemplates, manifest: ModuleManifest, files: ProjectFiles): { runtime: string; problem: string } {
  const language = languageOf(manifest);
  let form: unknown;
  try { form = JSON.parse(Buffer.from(files['form.json'] || new Uint8Array()).toString('utf8')); }
  catch { return { runtime: '', problem: 'form.json не читается как JSON' }; }
  let worker = '';
  if (language === 'typescript') {
    const compiled = compileLogic(Buffer.from(files[manifest.logic] || new Uint8Array()).toString('utf8'), manifest.logic);
    if (compiled.problem) return { runtime: '', problem: compiled.problem };
    worker = `globalThis.__fluxLogic=(function(){var module={exports:{}},exports=module.exports;${compiled.code}\n;return module.exports;})();\n${templates.worker}`;
  }
  const put = (text: string, sentinel: string, value: string) => {
    if (!text.includes(sentinel)) throw new Error(`В шаблоне окна подпрограммы нет метки ${sentinel}: пересоберите Studio`);
    return text.split(sentinel).join(value);
  };
  // split/join вместо replace: в значении встречаются «$&» и подобное, которое replace понял бы как шаблон
  let runtime = put(templates.frame, SENTINELS.form, JSON.stringify(form));
  runtime = put(runtime, SENTINELS.worker, JSON.stringify(worker));
  // Язык — переменная, а не метка: см. studio/build-assets.cjs
  return { runtime: `globalThis.__fluxLanguage=${JSON.stringify(language)};\n${runtime}`, problem: '' };
}
