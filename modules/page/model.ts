/**
 * Страница программы (договор v2): свой экран кодом вместо формы.
 *
 * Разработчик кладёт в пакет `ui/index.html` и свои скрипты, стили, картинки и шрифты; Flux показывает их
 * в том же изолированном кадре, что и форму. Всё лежит в пакете, а значит подписано вместе с ним. Файл
 * без зависимостей: его читают и Node (проверка выпуска), и главный процесс, и Studio.
 */
import type { BundleFiles } from '../trust/bundle';

export const PAGE_DIR = 'ui/';
export const PAGE_ENTRY = 'ui/index.html';
/** Клиент `flux.*` и набор Flux поставляет сам Flux (не копируется в пакет); версия в имени — старые страницы не ломаются */
export const FLUX_ASSET_DIR = '_flux';
export const FLUX_CLIENT_FILE = '_flux/flux.v1.js';
export const FLUX_UI_FILE = '_flux/flux-ui.v1.css';

export const PAGE_LIMITS = {
  files: 300,
  totalBytes: 8 * 1024 * 1024,
  fileBytes: 4 * 1024 * 1024,
  /** Сохранённое состояние окна страницы, байт JSON */
  stateBytes: 256 * 1024,
  /** Файл «отдать пользователю»: в пределах одного сообщения моста (1 МиБ) с запасом на base64 */
  saveChars: 700_000,
  /** Страница шлёт сигнал раз в beatMs; нет сигнала дольше hangMs — «программа не отвечает» */
  beatMs: 2000,
  hangMs: 10_000,
} as const;

/** Что разрешено лежать в ui/ и каким типом отдаётся. Остальное (в том числе .wasm) в страницу не входит */
export const PAGE_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json', txt: 'text/plain; charset=utf-8', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', ico: 'image/x-icon',
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf',
};
export const pageTypeOf = (file: string): string | null => PAGE_TYPES[file.slice(file.lastIndexOf('.') + 1).toLowerCase()] ?? null;

/** Адрес файла страницы в протоколе: ui/…, до 10 вложенных папок, простые имена; `..` и скрытые имена не проходят */
export const PAGE_URL_FILE = /^ui\/(?:[A-Za-z0-9_][A-Za-z0-9_-]{0,63}\/){0,10}[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
export const FLUX_ASSET_FILE = /^_flux\/(?:flux\.v1\.js|flux-ui\.v1\.css)$/;

export const pageFiles = (files: BundleFiles) => Object.keys(files).filter(f => f.startsWith(PAGE_DIR));

/** Причина словами, почему пакет со страницей не годится, либо '' */
export function pageProblem(files: BundleFiles, pages: readonly string[] = []): string {
  const list = pageFiles(files);
  if (!files[PAGE_ENTRY]?.length) return `В пакете нет ${PAGE_ENTRY}`;
  if (list.length > PAGE_LIMITS.files) return `В странице больше ${PAGE_LIMITS.files} файлов`;
  let total = 0;
  for (const file of list) {
    if (!pageTypeOf(file)) return `Файл страницы ${file}: такой тип не разрешён (html, js, css, json, txt, svg, png, jpg, webp, gif, ico, woff2, woff, ttf, otf)`;
    if (!PAGE_URL_FILE.test(file)) return `Недопустимое имя файла страницы: ${file}`;
    if (files[file].length > PAGE_LIMITS.fileBytes) return `Файл страницы ${file} больше ${PAGE_LIMITS.fileBytes / 1024 / 1024} МиБ`;
    total += files[file].length;
  }
  if (total > PAGE_LIMITS.totalBytes) return `Страница больше ${PAGE_LIMITS.totalBytes / 1024 / 1024} МиБ`;
  for (const page of pages) if (!files[PAGE_DIR + page]?.length) return `Страница ${page} объявлена в manifest.json, но файла ${PAGE_DIR}${page} в пакете нет`;
  try { new TextDecoder('utf-8', { fatal: true }).decode(files[PAGE_ENTRY]); } catch { return `${PAGE_ENTRY} не в кодировке UTF-8`; }
  return '';
}

export const PAGE_ERROR_CODES = ['DENIED', 'LIMIT', 'FAILED', 'CANCELLED'] as const;
export type PageErrorCode = typeof PAGE_ERROR_CODES[number];
export const PAGE_ERROR_NOTES: Record<PageErrorCode, string> = {
  DENIED: 'Программа не объявлена как страница, либо действие не разрешено.',
  LIMIT: 'Превышен предел (размер или частота).',
  FAILED: 'Действие не удалось выполнить.',
  CANCELLED: 'Пользователь отказался.',
};

/** Предел окон одной программы и размера сообщения между ними */
export const WINDOW_LIMITS = { windows: 5, messageBytes: 64 * 1024, paramsBytes: 8 * 1024 } as const;

/** Имя файла для «отдать пользователю»: без путей и управляющих знаков */
export const SAVE_NAME = /^[^\\/:*?"<>|\u0000-\u001f]{1,100}$/;
