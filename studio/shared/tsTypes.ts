/**
 * Сверка типов проекта Studio настоящим компилятором TypeScript.
 *
 * Чистая часть: компилятор и текст стандартной библиотеки приходят параметрами, диска нет — файлы проекта лежат в памяти
 * (виртуальный хост). Запускается в постоянном рабочем потоке (tsTypeWorker.ts): программа компилятора от прошлой сверки
 * переиспользуется (oldProgram), а разобранные файлы, текст которых не менялся, берутся из кэша — повторная сверка
 * после правки одного файла в разы быстрее первой.
 *
 * Что сверяется: все .ts/.tsx проекта (tsEntries) в строгом режиме (`strict`, `noEmit`). JS-файлы проекта не сверяются:
 * `allowJs` нужен только затем, чтобы подключённый из .ts файл .js не превращался в ошибку «нет объявлений типов».
 */
import type * as TS from 'typescript';
import type { ProjectFiles } from './templates';
import { tsEntries, type TsProblem } from './tsBuild';

/** Файлы стандартной библиотеки, нужные страницам и логике: ES2022 и типы браузера (document, fetch, WebAssembly) */
export const TS_LIB_ROOTS = ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'];
const PROJECT_DIR = '/project';
const LIB_DIR = '/tslib';
/** Подключение несуществующего файла и пакета уже объясняет сборка (esbuild) понятнее, второй раз то же самое не показываем */
const REPORTED_BY_BUILD = new Set([2307, 2792]);
const decoder = new TextDecoder();

export interface TypeChecker {
  /** `ambient` — описания, которых нет среди файлов проекта (путь → текст), например types/flux.d.ts страницы */
  check(files: ProjectFiles, ambient?: Record<string, string>): TsProblem[];
}

export function createTypeChecker(ts: typeof TS, libs: Record<string, string>): TypeChecker {
  // Без стандартной библиотеки компилятор молча считает Promise, Array и прочее неизвестными и теряет типы: лучше упасть сразу
  for (const name of TS_LIB_ROOTS) if (typeof libs[name] !== 'string') throw new Error(`В потоке сверки типов нет файла ${name}`);
  // Разобранные файлы: ключ — полный путь; тот же объект дерева возвращается, пока текст не изменился
  const parsed = new Map<string, { text: string; file: TS.SourceFile }>();
  let previous: TS.Program | undefined;

  const options: TS.CompilerOptions = {
    strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: TS_LIB_ROOTS, types: [], skipLibCheck: true, allowJs: true, checkJs: false, resolveJsonModule: true, esModuleInterop: true,
    moduleDetection: ts.ModuleDetectionKind.Force, allowImportingTsExtensions: true, jsx: ts.JsxEmit.Preserve, forceConsistentCasingInFileNames: true,
  };

  return {
    check(files, ambient = {}) {
      const texts = new Map<string, string>();
      for (const [path, bytes] of Object.entries(files)) texts.set(`${PROJECT_DIR}/${path}`, decoder.decode(bytes));
      for (const [path, text] of Object.entries(ambient)) if (!texts.has(`${PROJECT_DIR}/${path}`)) texts.set(`${PROJECT_DIR}/${path}`, text);
      const dirs = new Set<string>([PROJECT_DIR, LIB_DIR]);
      for (const full of texts.keys()) for (let i = full.lastIndexOf('/'); i > 0; i = full.lastIndexOf('/', i - 1)) dirs.add(full.slice(0, i));
      const readText = (full: string) => full.startsWith(`${LIB_DIR}/`) ? libs[full.slice(LIB_DIR.length + 1)] : texts.get(full);

      const host: TS.CompilerHost = {
        getSourceFile(name, languageVersion) {
          const text = readText(name);
          if (text === undefined) return undefined;
          const hit = parsed.get(name);
          if (hit && hit.text === text) return hit.file;
          const file = ts.createSourceFile(name, text, languageVersion, true, /\.tsx$/.test(name) ? ts.ScriptKind.TSX : undefined);
          parsed.set(name, { text, file });
          return file;
        },
        getDefaultLibFileName: () => `${LIB_DIR}/lib.es2022.d.ts`,
        getDefaultLibLocation: () => LIB_DIR,
        writeFile: () => {},
        getCurrentDirectory: () => PROJECT_DIR,
        getCanonicalFileName: name => name,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => '\n',
        fileExists: name => readText(name) !== undefined,
        readFile: name => readText(name),
        directoryExists: name => dirs.has(name),
        getDirectories: () => [],
        realpath: name => name,
      };

      // Корни: файлы TypeScript проекта и все описания .d.ts (в том числе подставленные)
      const sources = tsEntries(files).map(path => `${PROJECT_DIR}/${path}`);
      const declarations = [...texts.keys()].filter(full => /\.d\.ts$/.test(full));
      const program = ts.createProgram({ rootNames: [...sources, ...declarations], options, host, oldProgram: previous });
      previous = program;
      // Кэш разобранных файлов не должен копить удалённые файлы проекта
      for (const name of parsed.keys()) if (!name.startsWith(`${LIB_DIR}/`) && !texts.has(name)) parsed.delete(name);

      const problems: TsProblem[] = [];
      for (const full of sources) {
        const file = program.getSourceFile(full);
        if (!file) continue;
        // Семантика по файлу с ошибкой синтаксиса даёт лавину ложных ошибок: такой файл показываем только с синтаксисом
        const syntax = program.getSyntacticDiagnostics(file);
        const found = syntax.length ? syntax : program.getSemanticDiagnostics(file);
        for (const d of found) {
          if (REPORTED_BY_BUILD.has(d.code) || d.start === undefined) continue;
          const at = file.getLineAndCharacterOfPosition(d.start);
          const text = ts.flattenDiagnosticMessageText(d.messageText, '\n').split('\n').slice(0, 3).join(' ');
          problems.push({ path: full.slice(PROJECT_DIR.length + 1), line: at.line + 1, column: at.character + 1, text: `TS${d.code}: ${text}`.slice(0, 300) });
        }
      }
      return problems;
    },
  };
}
