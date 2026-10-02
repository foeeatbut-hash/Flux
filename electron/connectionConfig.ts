import fs from 'node:fs';
import path from 'node:path';

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
  // WHATWG URL normalizes ports and may erase an explicitly written default.
  const authority = value.slice(value.indexOf('://') + 3).split(/[/?#]/, 1)[0];
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  const explicitPort = hostPort.startsWith('[') ? hostPort.match(/^\[[^\]]+\]:(.*)$/)?.[1] : hostPort.match(/:(.*)$/)?.[1];
  if (explicitPort !== undefined && (!/^\d+$/.test(explicitPort) || Number(explicitPort) < 1 || Number(explicitPort) > 65535)) return null;
  return value;
}

/** Сохраняет конфигурацию заменой файла: после сбоя остаётся исходный JSON и его резервная копия. */
export function saveDatabaseConfig(configPath: string, databaseUrl: string): void {
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    const loaded: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) throw new Error('invalid-config');
    config = loaded as Record<string, unknown>;
  }
  config.current_db_type = databaseUrl ? 'REMOTE' : 'LOCAL';
  config.database_url = databaseUrl;
  config.remote_server_url = '';

  const temporary = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  const backup = `${configPath}.bak`;
  let fd: number | undefined;
  try {
    if (fs.existsSync(configPath)) fs.copyFileSync(configPath, backup);
    fd = fs.openSync(temporary, 'w', 0o600);
    fs.writeFileSync(fd, JSON.stringify(config, null, 2), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, configPath);
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}
