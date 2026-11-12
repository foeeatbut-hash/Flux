/**
 * Страница программы (договор v2): свой экран кодом вместо формы.
 *
 * Разработчик кладёт в пакет `ui/index.html` и свои скрипты, стили, картинки и шрифты; Flux показывает их
 * в том же изолированном кадре, что и форму. Всё лежит в пакете, а значит подписано вместе с ним. Файл
 * без зависимостей: его читают и Node (проверка выпуска), и главный процесс, и Studio.
 */
import type { BundleFiles } from '../trust/bundle';

/**
 * Первая версия Flux со страницами (договор v2). Старый Flux не знает ни `ui`, ни v2 и скажет лишь «манифест не соответствует»;
 * поэтому программа-страница обязана объявить `store.requires.flux` не ниже этой версии, и Store прячет установку на старых клиентах.
 */
export const PAGE_MIN_FLUX = '1.21.0';
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
  /** Страница шлёт сигнал раз в beatMs; нет сигнала дольше hangMs (30 с: фоновые таймеры и тяжёлый расчёт не должны давать ложную тревогу) — «программа не отвечает» */
  beatMs: 2000,
  hangMs: 30_000,
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

/**
 * «Не отвечает»: считаем только страницу, которая уже подала сигнал (без клиента flux.v1.js сигнала нет и не будет),
 * и только пока окно видно — у скрытого и свёрнутого окна таймеры замедляются, тишина там ничего не значит.
 */
export function pageHung(s: { beats: number; lastBeat: number; now: number; hidden: boolean; hangMs: number }): boolean {
  return s.beats > 0 && !s.hidden && s.now - s.lastBeat > s.hangMs;
}

/** Имя файла для «отдать пользователю»: без путей и управляющих знаков */
export const SAVE_NAME = /^[^\\/:*?"<>|\u0000-\u001f]{1,100}$/;
/** Расширения, которыми файл на Windows можно запустить: страница не должна подсовывать такое даже с вопросом человеку */
export const SAVE_DENIED_EXT = ['exe', 'com', 'bat', 'cmd', 'lnk', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'msi', 'msp', 'scr', 'pif', 'hta', 'cpl', 'reg', 'dll', 'jar', 'sh', 'url', 'inf', 'gadget', 'application', 'appref-ms', 'ps1xml', 'msc', 'sys', 'drv'];
const RESERVED = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;
/** Причина словами, почему имя не годится, либо '' */
export function saveNameProblem(name: string): string {
  if (!SAVE_NAME.test(name) || /^\.+$/.test(name)) return 'недопустимое имя файла';
  if (/[. ]$/.test(name) || /^\s/.test(name)) return 'имя не может начинаться с пробела и заканчиваться пробелом или точкой';
  if (RESERVED.test(name.split('.')[0].trim())) return 'зарезервированное имя Windows';
  const parts = name.toLowerCase().split('.');
  if (parts.length > 1 && parts.slice(1).some(ext => SAVE_DENIED_EXT.includes(ext.trim()))) return 'исполняемый или сценарный тип файла';
  return '';
}
