/**
 * Что владелец может править сам в запросе на публикацию (решение руководителя, этап 4в).
 *
 * Только `manifest.json` и файлы данных (`data/…`, `examples/…`). Исходный код (`logic/…`), `form.json` и
 * собранный `build/runtime.js` владелец не правит: форма и логика вшиты в runtime.js при сборке, правка не
 * пересобирает его, и подписанный выпуск содержал бы код, не соответствующий исполняемому. Для кода есть только «Вернуть на доработку».
 *
 * Без зависимостей: проверяют и окно владельца, и его главный процесс, и сервер.
 */
import { bundleText, type BundleFiles } from './bundle';

export const OWNER_EDITABLE_FILES = ['manifest.json'] as const;
export const OWNER_EDITABLE_DIRS = ['data/', 'examples/'] as const;

export const ownerMayEdit = (path: string): boolean =>
  (OWNER_EDITABLE_FILES as readonly string[]).includes(path) || OWNER_EDITABLE_DIRS.some((dir) => path.startsWith(dir));

const same = (a?: Uint8Array, b?: Uint8Array) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

/** Пути, которые правка изменила, добавила или удалила, хотя владельцу они не разрешены */
export function ownerEditViolations(parent: BundleFiles, edited: BundleFiles): string[] {
  const paths = new Set([...Object.keys(parent), ...Object.keys(edited)]);
  return [...paths].filter((path) => !same(parent[path], edited[path]) && !ownerMayEdit(path)).sort();
}

/** Файлы, которые окно предлагает править: разрешённые и читаемые как текст */
export const ownerEditablePaths = (files: BundleFiles): string[] => Object.keys(files).filter((p) => ownerMayEdit(p) && bundleText(files, p) !== null).sort();

export const OWNER_EDIT_REFUSAL = 'Владелец правит только manifest.json и файлы данных. Исходный код, form.json, contract.json и build/runtime.js — только через «Вернуть на доработку».';
