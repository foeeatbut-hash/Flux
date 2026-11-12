/**
 * Проверка перед отправкой: обращения программ друг к другу (`flux.programs.call`) и методы `exports`.
 *
 * Как и для сети (checks.ts, `netItem`): то, что заведомо упрётся в отказ у людей, ловится здесь. Идентификаторы из переменных
 * в коде не видны — их проверит запуск и главный процесс Flux; письменные `flux.programs.call('rates', …)` сверяются с `permissions`.
 */
import type { ModuleManifest } from '../../modules/contract';
import { EXPORT_METHOD, PROGRAM_ID, exportsOf } from '../../modules/programs/model';
import { programTargetsOf } from '../../modules/permissions/registry';
import type { CheckItem } from './checks';

const item = (id: string, title: string, status: 'ok' | 'fail', detail: string): CheckItem => ({ id, title, status, detail });

/** Код страницы: каждое обращение названо в `permissions` (kind program), и каждое разрешение используется */
export function programsItem(manifest: ModuleManifest, scripts: string[]): CheckItem | null {
  const declared = new Set(programTargetsOf(manifest));
  let calls = 0, literal = 0;
  const named = new Set<string>();
  const problems: string[] = [];
  for (const body of scripts) {
    calls += [...body.matchAll(/\bprograms\s*\.\s*call\s*\(/g)].length;
    for (const m of body.matchAll(/\bprograms\s*\.\s*call\s*\(\s*(['"`])([^'"`$\\]*)\1\s*(?:,\s*(['"`])([^'"`$\\]*)\3)?/g)) {
      named.add(m[2]); literal++;
      if (!PROGRAM_ID.test(m[2])) problems.push(`flux.programs.call('${m[2].slice(0, 40)}'): идентификатор программы — латиница, цифры и дефис, с маленькой буквы`);
      else if (m[2] === manifest.id) problems.push('flux.programs.call к самой себе: так нельзя, метод вызывается только у другой программы');
      else if (!declared.has(m[2])) problems.push(`flux.programs.call('${m[2]}') без разрешения: добавьте в permissions manifest.json { "kind": "program", "program": "${m[2]}", "does": "…" } (формат contractVersion 3)`);
      if (m[4] !== undefined && !EXPORT_METHOD.test(m[4])) problems.push(`метод «${m[4].slice(0, 40)}» вызвать нельзя: имя — латиница с маленькой буквы и цифры, до 40 знаков`);
    }
  }
  if (!calls && !declared.size) return null;
  if (!calls) problems.push(`разрешения на программы (${[...declared].join(', ')}) объявлены, но flux.programs.call в коде не вызывается: люди соглашаются на каждое разрешение, не просите лишнего`);
  // Если все обращения написаны словами, лишнее разрешение видно; идентификатор из переменной проверке не виден — его проверит запуск
  else if (literal === calls) for (const id of declared) if (!named.has(id)) problems.push(`разрешение на программу «${id}» объявлено, но в коде такого обращения нет: люди соглашаются на каждое разрешение, не просите лишнего`);
  return item('page-programs', 'Страница: обращения к другим программам и разрешения', problems.length ? 'fail' : 'ok',
    problems.join('; ') || `обращений flux.programs.call: ${calls}; нужные разрешения объявлены (${[...declared].join(', ')}); вызываемая программа должна быть установлена у человека и объявлять метод в exports`);
}

/** Манифест вызываемой программы: методы исполняются логикой Python или WebAssembly, и имя каждого есть в коде */
export function exportsItem(manifest: ModuleManifest, language: string, logicText: string): CheckItem | null {
  const methods = exportsOf(manifest);
  if (!methods.length) return null;
  if (language === 'typescript') {
    return item('exports', 'Методы для других программ (exports)', 'fail', 'методы exports исполняются логикой на Python или WebAssembly вне окна программы; у TypeScript такого пути нет — перенесите расчёт в logic/main.py или logic/main.wasm');
  }
  const missing = language === 'python' ? methods.filter(e => !logicText.includes(e.method)).map(e => e.method) : [];
  return item('exports', 'Методы для других программ (exports)', missing.length ? 'fail' : 'ok',
    missing.length ? `метод «${missing.join('», «')}» объявлен в exports, но его имени нет в logic/main.py: логика получает { "export": имя, "data": … } и обязана ответить на каждый объявленный метод`
      : `методов: ${methods.length} (${methods.map(e => e.method).join(', ')}); вход { "export", "data" }, ответ — calc.out; подключений, сети и данных Flux у метода нет`);
}
