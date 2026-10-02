/** Проверка URI до записи: некорректная строка не должна запускать Flux с пустой или чужой схемой. */
export function validateDatabaseUri(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > 4096 || /[\\\u0000-\u001f\u007f]/.test(value) || value.includes('#') || /%(?![0-9a-f]{2})/i.test(value)) return null;
  let uri: URL;
  try { uri = new URL(value); } catch { return null; }
  if (!['mysql:', 'mariadb:', 'postgres:', 'postgresql:'].includes(uri.protocol)) return null;
  let databaseName: string;
  try { databaseName = decodeURIComponent(uri.pathname.slice(1)); } catch { return null; }
  if (!uri.hostname || !databaseName || /[\\/]/.test(databaseName) || !/^\/[^/]+$/.test(uri.pathname)) return null;
  if (uri.port && (!/^\d+$/.test(uri.port) || Number(uri.port) < 1 || Number(uri.port) > 65535)) return null;
  // URL нормализует порты, поэтому явно указанный порт проверяется и в исходной строке.
  const authority = value.slice(value.indexOf('://') + 3).split(/[/?#]/, 1)[0];
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  const explicitPort = hostPort.startsWith('[') ? hostPort.match(/^\[[^\]]+\]:(.*)$/)?.[1] : hostPort.match(/:(.*)$/)?.[1];
  if (explicitPort !== undefined && (!/^\d+$/.test(explicitPort) || Number(explicitPort) < 1 || Number(explicitPort) > 65535)) return null;
  return value;
}
