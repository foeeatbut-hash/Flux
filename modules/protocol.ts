import { FLUX_ASSET_FILE, PAGE_URL_FILE, pageTypeOf } from './page/model';
export const MODULE_SCHEME = 'flux-module';
export const MODULE_SANDBOX = 'allow-scripts';
/** Папка общей оболочки в dist/modules: index.html, стили и шрифты для выпусков из базы. Не имя модуля — у тех нет «_» */
export const MODULE_SHELL_DIR = '_shell';
/** Изолированный хост общей среды Python (modules/compute): страница, её скрипт и файлы Pyodide из portable */
export const MODULE_COMPUTE_HOST = '_compute';
// Заголовок сохраняет изоляцию, даже если атрибут iframe когда-нибудь
// ошибочно изменят. Разрешения обеих sandbox складываются ограничительно.
export const MODULE_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "font-src 'self'", 'worker-src blob:', "connect-src 'none'", "img-src 'none'",
  "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');
/**
 * CSP хоста Python. Отличается от CSP подпрограммы двумя пунктами и только
 * ими: `wasm-unsafe-eval` (иначе нельзя скомпилировать Pyodide) и `connect-src 'self'`
 * (Pyodide сам читает свои файлы с этого же адреса). Сети наружу, хранилищ и
 * IPC всё так же нет; в хост не попадает ничего, кроме Python-кода из проверенных
 * выпусков, который присылает окно Flux.
 */
export const COMPUTE_CSP = MODULE_CSP
  .replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'")
  .replace("connect-src 'none'", "connect-src 'self'");
/**
 * CSP страницы программы (договор v2). Скрипты, стили, шрифты и картинки — только из пакета; сети нет, eval нет.
 * В отличие от формы нет 'unsafe-inline' для стилей: стили страницы лежат файлами (CSSOM из скрипта работает,
 * атрибут style и тег style — нет). data: и blob: разрешены для картинок и воркеров — рисовать canvas/SVG/WebGL
 * можно из самой страницы; connect-src 'none' закрывает fetch и сокеты, а значит и чтение этих blob: через fetch.
 */
export const PAGE_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'", "script-src 'self'", "style-src 'self'",
  "font-src 'self'", "img-src 'self' data: blob:", "media-src 'self' data: blob:", "worker-src 'self' blob:", "connect-src 'none'",
  "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');
export const moduleHeaders = (type: string, host = false, page = false) => ({
  'Content-Type': type, 'Content-Security-Policy': host ? COMPUTE_CSP : page ? PAGE_CSP : MODULE_CSP,
  'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
});
export function moduleAssetPath(rawUrl: string, moduleIds: readonly string[]): { id: string; file: string } | null {
  try {
    const url = new URL(rawUrl);
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (url.protocol !== `${MODULE_SCHEME}:` || url.username || url.password || url.port || !moduleIds.includes(url.hostname)) return null;
    if (url.hostname === MODULE_COMPUTE_HOST) {
      // Хост Python отдаёт только свою страницу, скрипт и файлы Pyodide
      return /^(?:index\.html|host\.js|pyodide\/[a-zA-Z0-9_.-]{1,64})$/.test(file) ? { id: url.hostname, file } : null;
    }
    // Файлы логики и контрольные примеры отдаются из проверенного пакета (electron/modules.ts)
    // Страница программы (договор v2): файлы ui/… из проверенного пакета и клиент/набор Flux из _flux/
    if (PAGE_URL_FILE.test(file) && pageTypeOf(file) || FLUX_ASSET_FILE.test(file)) return { id: url.hostname, file };
    if (!/^(?:index\.html|runtime\.js|flux\.css|logic\.py|logic\.wasm|controls\.json|[a-zA-Z0-9_-]+\.woff2)$/.test(file)) return null;
    return { id: url.hostname, file };
  } catch (_) { return null; }
}

/**
 * Программа-приложение (договор v2) состоит из нескольких страниц пакета: переход разрешён только со страницы
 * (ui/…) на другую страницу (ui/…) той же программы. Всё остальное — внешние адреса, другие программы, служебные
 * файлы — по-прежнему запрещено.
 */
export function pageNavigationAllowed(from: string, to: string): boolean {
  try {
    const a = new URL(from), b = new URL(to);
    return a.protocol === `${MODULE_SCHEME}:` && b.protocol === a.protocol && a.hostname === b.hostname && !b.username && !b.password && !b.port
      && PAGE_URL_FILE.test(a.pathname.slice(1)) && PAGE_URL_FILE.test(b.pathname.slice(1)) && /\.html$/.test(b.pathname);
  } catch (_) { return false; }
}
