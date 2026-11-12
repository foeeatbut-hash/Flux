/**
 * Какое разрешение сети нужно адресу, написанному в коде программы: подсказка для проверки перед отправкой (Studio).
 *
 * Чистый разбор строки, без DNS и без Node: имя сайта всегда считается интернетом, потому что куда оно
 * разрешится, станет известно только во Flux. Окончательно решает главный процесс (modules/permissions/netAddress.ts),
 * эта подсказка лишь не даёт отправить программу, которая заведомо упрётся в отказ.
 */
export type LiteralNeed = 'internet' | 'lan' | 'closed';

export function needOfLiteralUrl(raw: string): LiteralNeed | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return 'closed';
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254)) return 'closed';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return 'lan';
    return 'internet';
  }
  if (host.includes(':')) {
    if (host === '::' || host === '::1' || host.startsWith('::ffff:') || /^fe[89ab]/.test(host) || host.startsWith('ff')) return 'closed';
    return /^f[cd]/.test(host) ? 'lan' : 'internet';
  }
  return 'internet';
}
