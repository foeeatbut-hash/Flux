/**
 * Пакет модуля — все файлы подпрограммы одним набором байт.
 *
 * В пакете ВСЁ, что владелец проверяет и что потом работает: исходный код
 * (`logic/…`), `manifest.json`, `form.json`, свои данные, контрольные примеры
 * (`examples/…`) и собранный `build/runtime.js`. Выпуск — это тот же пакет,
 * что пришёл в запросе, байт в байт: владелец подписывает ровно то, что
 * смотрел, и не может случайно выпустить другое.
 *
 * Формат — канонический JSON `{"files":{путь: base64},"v":1}`: один и тот же
 * набор файлов даёт одни и те же байты, значит, и один хеш.
 *
 * Без зависимостей: пакет читает и окно владельца (показ файлов и разницы).
 */
import { MODULE_BUNDLE_MAX, MODULE_CHUNK_BYTES } from './claims';

export type BundleFiles = Record<string, Uint8Array>;
/** Файл, который запускает оболочка: frame + форма + Worker с логикой, собранные из исходников пакета */
export const RUNTIME_FILE = 'build/runtime.js';
const MAX_FILES = 2000;

/** Только простые относительные пути: никаких `..`, абсолютных путей и скрытых имён Windows */
export function validBundlePath(path: string): boolean {
  if (typeof path !== 'string' || path.length > 240) return false;
  const segments = path.split('/');
  return segments.length <= 12 && segments.every((s) => /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(s) && !/\.$/.test(s));
}

const toBase64 = (bytes: Uint8Array) => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
const fromBase64 = (text: string) => {
  const raw = atob(text), out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

export function packBundle(files: Record<string, Uint8Array | string>): Uint8Array {
  const paths = Object.keys(files).sort();
  if (!paths.length || paths.length > MAX_FILES) throw new Error('В пакете нет файлов или их слишком много');
  const encoder = new TextEncoder();
  const body = paths.map((path) => {
    if (!validBundlePath(path)) throw new Error(`Недопустимый путь в пакете: ${path}`);
    const value = files[path];
    return `${JSON.stringify(path)}:${JSON.stringify(toBase64(typeof value === 'string' ? encoder.encode(value) : value))}`;
  }).join(',');
  const bytes = encoder.encode(`{"files":{${body}},"v":1}`);
  if (bytes.length > MODULE_BUNDLE_MAX) throw new Error('Пакет модуля больше 32 МБ');
  return bytes;
}

export function unpackBundle(bytes: Uint8Array): BundleFiles {
  if (!bytes.length || bytes.length > MODULE_BUNDLE_MAX) throw new Error('Пакет модуля пуст или слишком велик');
  let value: any;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Error('Пакет модуля повреждён'); }
  if (!value || value.v !== 1 || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)
    || Object.keys(value).length !== 2) throw new Error('Пакет модуля в неизвестном формате');
  const out: BundleFiles = {};
  const paths = Object.keys(value.files);
  if (!paths.length || paths.length > MAX_FILES) throw new Error('В пакете нет файлов или их слишком много');
  for (const path of paths) {
    if (!validBundlePath(path) || typeof value.files[path] !== 'string') throw new Error(`Недопустимый файл в пакете: ${path}`);
    out[path] = fromBase64(value.files[path]);
  }
  // Пакет обязан быть каноническим: иначе один набор файлов давал бы разные хеши
  const canonical = packBundle(out);
  if (canonical.length !== bytes.length || canonical.some((b, i) => b !== bytes[i])) throw new Error('Пакет модуля записан не в каноническом виде');
  return out;
}

export function splitChunks(bytes: Uint8Array, size = MODULE_CHUNK_BYTES): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, Math.min(bytes.length, i + size)));
  return out;
}

export function joinChunks(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

export const bundleText = (files: BundleFiles, path: string): string | null => {
  const bytes = files[path];
  if (!bytes) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
};
