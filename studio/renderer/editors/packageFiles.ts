/**
 * Файлы пакета программы ↔ модель редакторов.
 *
 * Оболочка Studio отдаёт текстовые файлы проекта (путь → содержимое). Форма — form.json; читает
 * программа — `reads` в manifest.json; значения state и calc.out, которые программа объявляет
 * в договоре, лежат в contract.json (свой файл пакета: манифест схемой не расширяется). Если
 * contract.json ещё нет, значения выводятся из привязок формы и из кода — как стартовое описание.
 */
import { resources } from '../../../modules/contract';
import { isResource } from './contractModel';
import type { CodeFile, CodeLanguage, ContractDraft, ContractValue, ValueType } from './types';

export const FORM_FILE = 'form.json';
export const MANIFEST_FILE = 'manifest.json';
export const CONTRACT_FILE = 'contract.json';
export const CODE_FALLBACK = 'В проекте нет файлов кода, которые Studio умеет открывать (TypeScript, JavaScript, Python, Rust, C, C++, Go, C#).';

const EXTENSIONS: Record<string, CodeLanguage> = {
  ts: 'typescript', mts: 'typescript', js: 'javascript', mjs: 'javascript', cjs: 'javascript', py: 'python', rs: 'rust',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', c: 'c', h: 'c', go: 'go', cs: 'csharp',
};

export function languageOfPath(path: string): CodeLanguage | null {
  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1].toLowerCase();
  return extension ? EXTENSIONS[extension] ?? null : null;
}

/** Файлы кода проекта: logic/main.* первым, дальше по имени; примеры и описание пакета — не код */
export function codeFiles(files: Record<string, string>): CodeFile[] {
  const out: CodeFile[] = [];
  for (const [path, text] of Object.entries(files)) {
    const language = languageOfPath(path);
    if (language && !path.startsWith('examples/') && !path.endsWith('.d.ts')) out.push({ path, language, text });
  }
  const rank = (path: string) => path.startsWith('logic/main.') ? 0 : path.startsWith('logic/') ? 1 : 2;
  return out.sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
}

const NAME = /^[A-Za-z_$][\w$]*$/;
const TYPES: ValueType[] = ['string', 'number', 'integer', 'boolean', 'object', 'array'];

function values(raw: unknown): ContractValue[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ContractValue[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { name, type, items, unit, description } = item as Record<string, unknown>;
    if (typeof name !== 'string' || !NAME.test(name) || seen.has(name) || !TYPES.includes(type as ValueType)) continue;
    seen.add(name);
    out.push({
      name, type: type as ValueType,
      ...(type === 'array' && TYPES.includes(items as ValueType) ? { items: items as ValueType } : {}),
      ...(typeof unit === 'string' && unit ? { unit } : {}), ...(typeof description === 'string' && description ? { description } : {}),
    });
  }
  return out;
}

const parse = (text: string | undefined): any => { try { return text === undefined ? undefined : JSON.parse(text); } catch { return undefined; } };

/** Имена state.* и calc.out.* из привязок формы и из кода: стартовое описание договора */
export function inferValues(files: Record<string, string>): { state: ContractValue[]; outputs: ContractValue[] } {
  const state = new Set<string>(), outputs = new Set<string>();
  const bind = (path: unknown) => {
    if (typeof path !== 'string') return;
    const [root, a, b] = path.split('.');
    if (root === 'state' && a && NAME.test(a)) state.add(a);
    if (root === 'calc' && a === 'out' && b && NAME.test(b)) outputs.add(b);
  };
  const form = parse(files[FORM_FILE]);
  for (const group of form?.groups ?? []) for (const field of group?.fields ?? []) bind(field?.bind);
  for (const file of codeFiles(files)) {
    if (file.language !== 'typescript' && file.language !== 'javascript') continue;
    for (const match of file.text.matchAll(/(?<![\w$.])state\s*\.\s*([A-Za-z_$][\w$]*)/g)) state.add(match[1]);
    for (const match of file.text.matchAll(/(?<![\w$.])calc\s*\.\s*out\s*\.\s*([A-Za-z_$][\w$]*)/g)) outputs.add(match[1]);
    for (const match of file.text.matchAll(/(?<![\w$.])calc\s*\.\s*out\s*=\s*\{([^}]*)\}/g)) for (const key of match[1].matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:/g)) outputs.add(key[1]);
  }
  const typed = (names: Set<string>): ContractValue[] => [...names].sort().map(name => ({ name, type: 'string' as const }));
  return { state: typed(state), outputs: typed(outputs) };
}

export function contractFromFiles(files: Record<string, string>): ContractDraft {
  const manifest = parse(files[MANIFEST_FILE]);
  const reads = Array.isArray(manifest?.reads) ? resources.filter(resource => manifest.reads.includes(resource)) : [];
  const saved = parse(files[CONTRACT_FILE]);
  if (saved && typeof saved === 'object') return { version: 1, reads, state: values(saved.state), outputs: values(saved.outputs) };
  return { version: 1, reads, ...inferValues(files) };
}

/** Что записать в проект, когда договор изменился: reads в manifest.json и значения в contract.json */
export function contractChanges(files: Record<string, string>, next: ContractDraft): { changed: Record<string, string>; error: string } {
  const changed: Record<string, string> = {
    [CONTRACT_FILE]: `${JSON.stringify({ version: 1, state: next.state, outputs: next.outputs }, null, 2)}\n`,
  };
  const manifest = parse(files[MANIFEST_FILE]);
  if (!manifest || typeof manifest !== 'object') return { changed, error: 'manifest.json не читается как JSON: список «Что читает программа» не сохранён.' };
  const reads = next.reads.filter(isResource);
  if (JSON.stringify(manifest.reads) !== JSON.stringify(reads)) changed[MANIFEST_FILE] = `${JSON.stringify({ ...manifest, reads }, null, 2)}\n`;
  return { changed, error: '' };
}
