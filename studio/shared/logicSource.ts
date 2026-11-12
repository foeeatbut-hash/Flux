/**
 * Логика на TypeScript → JavaScript для запуска в Studio.
 *
 * В упакованной Studio компилятора esbuild нет, поэтому одиночный файл `logic/main.ts`
 * переводится компилятором TypeScript в CommonJS. Объявления типов стираются, а
 * подключение других файлов (`import './x'`) в этой версии не поддерживается: Worker
 * программы получает один скрипт. Такой проект проверка перед отправкой отклоняет
 * с понятной причиной, а не падает при запуске.
 */
import ts from 'typescript';

export interface CompiledLogic { code: string; problem: string }

export function compileLogic(source: string, fileName = 'logic/main.ts'): CompiledLogic {
  const result = ts.transpileModule(source, {
    fileName, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: false, sourceMap: false },
  });
  const syntax = (result.diagnostics || []).find(d => d.category === ts.DiagnosticCategory.Error);
  if (syntax) {
    const at = syntax.file && syntax.start !== undefined ? syntax.file.getLineAndCharacterOfPosition(syntax.start).line + 1 : 0;
    return { code: '', problem: `${at ? `Строка ${at}: ` : ''}${ts.flattenDiagnosticMessageText(syntax.messageText, '\n').slice(0, 200)}` };
  }
  // После перевода остаётся `require(...)` ровно там, где подключён другой файл или пакет
  const required = [...result.outputText.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map(m => m[1]);
  if (required.length) return { code: '', problem: `Логика на TypeScript — один файл: уберите подключение «${required[0]}» и перенесите код в logic/main.ts.` };
  return { code: result.outputText, problem: '' };
}
