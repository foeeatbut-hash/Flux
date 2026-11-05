export const MODULE_SCHEME = 'flux-module';
export const MODULE_SANDBOX = 'allow-scripts';
// Заголовок сохраняет изоляцию, даже если атрибут iframe когда-нибудь
// ошибочно изменят. Разрешения обеих sandbox складываются ограничительно.
export const MODULE_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "font-src 'self'", 'worker-src blob:', "connect-src 'none'", "img-src 'none'",
  "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');
export const moduleHeaders = (type: string) => ({
  'Content-Type': type, 'Content-Security-Policy': MODULE_CSP,
  'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
});
export function moduleAssetPath(rawUrl: string, moduleIds: readonly string[]): { id: string; file: string } | null {
  try {
    const url = new URL(rawUrl);
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (url.protocol !== `${MODULE_SCHEME}:` || url.username || url.password || url.port || !moduleIds.includes(url.hostname)) return null;
    if (!/^(?:index\.html|runtime\.js|flux\.css|[a-zA-Z0-9_-]+\.woff2)$/.test(file)) return null;
    return { id: url.hostname, file };
  } catch (_) { return null; }
}
