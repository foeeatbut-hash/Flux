/**
 * Подсказки и проверка кода по договору.
 *
 * Полные ошибки типов даёт настоящий компилятор по файлу `.d.ts` из договора (contractTypes.ts) —
 * при выпуске. В самом редакторе работает лёгкая проверка без компилятора (он весит десятки
 * мегабайт, а Studio открывается без сети): неизвестные и неразрешённые данные Flux, значения,
 * не объявленные в договоре, и автодополнение по тем же схемам.
 */
import { dataSchemas } from '../../../modules/schemas';
import { resources } from '../../../modules/contract';
import { isResource, stepSchema, unwrapSchema, valueType, type Schema } from './contractModel';
import type { CodeLanguage, ContractDraft } from './types';

export interface CodeIssue { line: number; column: number; length: number; severity: 'error' | 'warning'; message: string }
export interface Completion { label: string; detail?: string; kind: 'property' | 'function' | 'variable' | 'text' }
export interface CompletionResult { from: number; options: Completion[] }

export const isScript = (language: CodeLanguage) => language === 'typescript' || language === 'javascript';

const placeOf = (text: string, offset: number) => {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  return { line, column: offset - (before.lastIndexOf('\n') + 1) + 1 };
};

/** Находит обращения, которые договор не разрешает. Строки и комментарии не разбираются: проверка лёгкая и осторожная */
export function checkScript(text: string, contract: ContractDraft): CodeIssue[] {
  const issues: CodeIssue[] = [];
  const push = (offset: number, length: number, severity: CodeIssue['severity'], message: string) =>
    issues.push({ ...placeOf(text, offset), length, severity, message });
  for (const match of text.matchAll(/\bflux\s*\.\s*read\s*\(\s*(['"`])([^'"`]*)\1/g)) {
    const name = match[2];
    const at = match.index! + match[0].lastIndexOf(name);
    if (!isResource(name)) push(at, name.length, 'error', `У Flux нет данных «${name}». Доступны: ${resources.join(', ')}`);
    else if (!contract.reads.includes(name)) push(at, name.length, 'error', `Данные «${name}» не разрешены договором: добавьте их в «Что читает подпрограмма»`);
  }
  const scan = (pattern: RegExp, declared: string[], where: string) => {
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      if (declared.includes(name)) continue;
      push(match.index! + match[0].lastIndexOf(name), name.length, 'error', `«${name}» не объявлено в договоре (${where}). Объявите его или поправьте имя`);
    }
  };
  scan(/(?<![\w$.])state\s*\.\s*([A-Za-z_$][\w$]*)/g, contract.state.map(value => value.name), 'состояние');
  scan(/(?<![\w$.])calc\s*\.\s*out\s*\.\s*([A-Za-z_$][\w$]*)/g, contract.outputs.map(value => value.name), 'выходы расчёта');
  for (const match of text.matchAll(/(?<![\w$.])calc\s*\.\s*out\s*=\s*\{([^}]*)\}/g)) {
    const body = match[1];
    for (const key of body.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:/g)) {
      if (contract.outputs.some(value => value.name === key[1])) continue;
      push(match.index! + match[0].indexOf(body) + key.index! + key[0].lastIndexOf(key[1]), key[1].length, 'error', `«${key[1]}» не объявлено в договоре (выходы расчёта)`);
    }
  }
  return issues.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** Для языков без типов: проверяется только то, что видно по тексту (чтение неразрешённых данных) */
export function checkOther(text: string, contract: ContractDraft): CodeIssue[] {
  const issues: CodeIssue[] = [];
  for (const match of text.matchAll(/(?:\[\s*|\.get\(\s*)(['"])(project|equipment|tag|specification|catalog)\1/g)) {
    const name = match[2];
    if (contract.reads.includes(name as never)) continue;
    const offset = match.index! + match[0].lastIndexOf(name);
    issues.push({ ...placeOf(text, offset), length: name.length, severity: 'warning', message: `Данные «${name}» не разрешены договором: расчёт их не получит` });
  }
  return issues;
}

export const checkCode = (language: CodeLanguage, text: string, contract: ContractDraft) =>
  isScript(language) ? checkScript(text, contract) : checkOther(text, contract);

const propertyOptions = (schema: Schema | null): Completion[] => {
  const current = schema && unwrapSchema(schema);
  if (!current || current.type !== 'object') return [];
  return Object.entries<Schema>(current.properties).map(([label, child]) => ({ label, kind: 'property' as const, detail: valueType(child) }));
};

/** Автодополнение для TypeScript и JavaScript; `before` — текст от начала файла до курсора */
export function completeScript(before: string, contract: ContractDraft): CompletionResult | null {
  const tail = (match: RegExpMatchArray, offset: number) => before.length - (match[offset] ?? '').length;
  let match = /\bflux\s*\.\s*read\s*\(\s*['"`]([\w]*)$/.exec(before);
  if (match) return { from: tail(match, 1), options: contract.reads.map(label => ({ label, kind: 'text', detail: 'данные Flux' })) };
  match = /\bflux\s*\.\s*on\s*\(\s*['"`]([\w]*)$/.exec(before);
  if (match) return { from: tail(match, 1), options: [{ label: 'changed', kind: 'text', detail: 'данные изменились' }] };
  match = /(?<![\w$.])flux\s*\.\s*([\w]*)$/.exec(before);
  if (match) return { from: tail(match, 1), options: [
    { label: 'read', kind: 'function', detail: 'прочитать данные Flux' }, { label: 'on', kind: 'function', detail: 'подписаться на изменения' },
  ] };
  match = /(?<![\w$.])state\s*\.\s*([\w]*)$/.exec(before);
  if (match) return { from: tail(match, 1), options: contract.state.map(value => ({ label: value.name, kind: 'property', detail: value.type })) };
  match = /(?<![\w$.])calc\s*\.\s*out\s*\.\s*([\w]*)$/.exec(before);
  if (match) return { from: tail(match, 1), options: contract.outputs.map(value => ({ label: value.name, kind: 'property', detail: value.type })) };
  match = /(?<![\w$.])calc\s*\.\s*([\w]*)$/.exec(before);
  if (match) return { from: tail(match, 1), options: [{ label: 'out', kind: 'property', detail: 'результат расчёта' }] };
  // Переменная, в которую прочитали данные Flux: x?.params[0].key
  const chain = /([A-Za-z_$][\w$]*)((?:\s*\??\.\s*[A-Za-z_$][\w$]*|\[[^\]]*\])*)\s*\??\.\s*([\w]*)$/.exec(before);
  if (chain) {
    const [, name, steps, partial] = chain;
    const declaration = [...before.matchAll(new RegExp(`(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\s*=\\s*await\\s+flux\\s*\\.\\s*read\\s*\\(\\s*['"\`](\\w+)['"\`]`, 'g'))].pop();
    if (declaration && isResource(declaration[1]) && contract.reads.includes(declaration[1])) {
      let schema: Schema | null = dataSchemas[declaration[1]];
      for (const step of steps.matchAll(/\[[^\]]*\]|([A-Za-z_$][\w$]*)/g)) {
        if (!schema) break;
        schema = step[0].startsWith('[') ? stepSchema(schema, ['0']) : stepSchema(schema, [step[1]]);
      }
      const options = propertyOptions(schema);
      if (options.length) return { from: before.length - partial.length, options };
    }
  }
  return null;
}
