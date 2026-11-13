/**
 * Сборка TypeScript проекта внутри Studio (пункт «Собрать»).
 *
 * Компилятор — esbuild-wasm: он работает на WebAssembly, без собственных программ и без интернета.
 * Этот файл — чистая часть: он получает компилятор параметром и файлы проекта целиком, ничего не читает с диска,
 * поэтому его проверяют обычным набором. Сам компилятор запускается в изолированном потоке (tsBuildWorker.ts).
 *
 * Что делает esbuild и чего не делает: он разбирает синтаксис и подключения файлов, но типы не сверяет. Типы сверяет
 * отдельно настоящий компилятор TypeScript в своём потоке (tsTypes.ts, tsTypeWorker.ts), а tsBuildHost.ts складывает
 * оба списка проблем: ошибка типа вроде `const a: number = 'x'` останавливает сборку так же, как опечатка в синтаксисе,
 * подключение несуществующего файла и пакет, которого в проекте нет.
 */
import type { ProjectFiles } from './templates';

export interface TsProblem { path: string; line: number; column: number; text: string }
export interface TsBuildResult {
  ok: boolean;
  problems: TsProblem[];
  /** Исходный путь → готовый JavaScript одного файла со всеми подключёнными файлами проекта */
  outputs: Record<string, string>;
  /** Сколько файлов TypeScript собиралось */
  entries: string[];
}

/** Часть интерфейса esbuild, которая нужна сборке (настоящий esbuild-wasm или заглушка проверки) */
export interface EsbuildLike {
  build(options: Record<string, unknown>): Promise<{ outputFiles?: Array<{ text: string }> }>;
}

const NAMESPACE = 'project';
export const isTsSource = (path: string) => /\.(ts|tsx)$/.test(path) && !/\.d\.ts$/.test(path);
const decoder = new TextDecoder();
const LOADERS: Record<string, string> = { ts: 'ts', tsx: 'tsx', js: 'js', mjs: 'js', jsx: 'jsx', json: 'json', css: 'css', txt: 'text' };
const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.jsx', '.json'];

/** Файлы, с которых начинается сборка: все .ts/.tsx проекта кроме объявлений типов (.d.ts) */
export const tsEntries = (files: ProjectFiles): string[] => Object.keys(files).filter(isTsSource).sort();

/** Приводит `./a/../b.ts` к `b.ts`; null — путь выходит за пределы проекта */
export function normalize(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (!out.length) return null; out.pop(); } else out.push(part);
  }
  return out.join('/');
}

/**
 * Какой файл проекта имеется в виду в `import … from './x'`: сам файл, файл с одним из расширений или index в папке.
 * null — такого файла нет; именно эту ошибку человек видит чаще всего.
 */
export function resolveImport(importer: string, spec: string, has: (path: string) => boolean): string | null {
  const base = normalize(`${importer.includes('/') ? importer.slice(0, importer.lastIndexOf('/')) : ''}/${spec}`);
  if (base === null) return null;
  const candidates = [base, ...EXTENSIONS.map(ext => base + ext), ...EXTENSIONS.map(ext => `${base}/index${ext}`)];
  // .js в подключении часто означает «собранный из .ts» (так принято в TypeScript): пробуем и файл с другим расширением
  if (/\.(?:m?js)$/.test(base)) candidates.push(base.replace(/\.(?:m?js)$/, '.ts'), base.replace(/\.(?:m?js)$/, '.tsx'));
  return candidates.find(has) ?? null;
}

/** Куда ложится собранный файл страницы: `src/app.ts` → `ui/app.js`. Файлы вне `src/` в страницу не попадают */
export function emittedPath(source: string): string | null {
  const m = /^src\/(.+)\.(?:ts|tsx)$/.exec(source);
  return m ? `ui/${m[1]}.js` : null;
}

/** Файлы проекта плюс собранные файлы страницы (то, что видит запуск, проверка и отправка); исходные файлы не меняются */
export function withBuilt(files: ProjectFiles, result: TsBuildResult): ProjectFiles {
  const next: ProjectFiles = { ...files };
  for (const [source, code] of Object.entries(result.outputs)) {
    const target = emittedPath(source);
    if (target && !(target in files)) next[target] = new TextEncoder().encode(code);
  }
  return next;
}

/** Строка для человека: «src/app.ts:12:5: сообщение» — по такой записи «Проблемы» открывают файл на строке */
export const problemLine = (p: TsProblem) => `${p.path}:${p.line}${p.column ? `:${p.column}` : ''}: ${p.text}`;

const clean = (file: string) => file.replace(new RegExp(`^${NAMESPACE}:`), '');

export async function runTsBuild(esbuild: EsbuildLike, files: ProjectFiles): Promise<TsBuildResult> {
  const entries = tsEntries(files);
  const outputs: Record<string, string> = {};
  const problems: TsProblem[] = [];
  const seen = new Set<string>();
  const add = (p: TsProblem) => { const key = `${p.path}\0${p.line}\0${p.column}\0${p.text}`; if (!seen.has(key)) { seen.add(key); problems.push(p); } };
  const has = (path: string) => Object.prototype.hasOwnProperty.call(files, path);

  const plugin = {
    name: 'project-files',
    setup(build: any) {
      build.onResolve({ filter: /.*/ }, (args: any) => {
        if (args.kind === 'entry-point') return { path: args.path, namespace: NAMESPACE };
        if (!args.path.startsWith('.') && !args.path.startsWith('/')) {
          return { errors: [{ text: `Пакет «${args.path}» недоступен: в Studio подключаются только файлы проекта (./файл)` }] };
        }
        const importer = clean(args.importer || '');
        const found = args.path.startsWith('/') ? null : resolveImport(importer, args.path, has);
        if (!found) return { errors: [{ text: `Файла «${args.path}» нет в проекте` }] };
        return { path: found, namespace: NAMESPACE };
      });
      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, (args: any) => {
        const ext = args.path.slice(args.path.lastIndexOf('.') + 1).toLowerCase();
        return { contents: decoder.decode(files[args.path]), loader: LOADERS[ext] || 'text' };
      });
    },
  };

  for (const entry of entries) {
    try {
      const built = await esbuild.build({
        entryPoints: [entry], bundle: true, write: false, format: 'iife', target: 'es2022', platform: 'browser',
        logLevel: 'silent', sourcemap: false, charset: 'utf8', plugins: [plugin], outdir: 'out',
      });
      outputs[entry] = built.outputFiles?.[0]?.text ?? '';
    } catch (error: any) {
      const list: any[] = Array.isArray(error?.errors) ? error.errors : [];
      if (!list.length) add({ path: entry, line: 0, column: 0, text: String(error?.message || error).slice(0, 300) });
      for (const e of list) {
        const where = e.location;
        // Строка у esbuild с единицы, столбец с нуля; человеку столбец показываем с единицы
        add({ path: where ? clean(String(where.file)) : entry, line: where ? where.line : 0, column: where ? where.column + 1 : 0, text: String(e.text).slice(0, 300) });
      }
    }
  }
  return { ok: problems.length === 0, problems, outputs: problems.length ? {} : outputs, entries };
}
