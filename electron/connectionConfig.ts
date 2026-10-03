import fs from 'node:fs';
import path from 'node:path';

export { validateDatabaseUri } from '../shared/databaseUri';

function readConfig(configPath: string): Record<string, unknown> {
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    const loaded: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) throw new Error('invalid-config');
    config = loaded as Record<string, unknown>;
  }
  return config;
}

/** Сохраняет конфигурацию заменой файла: после сбоя остаётся исходный JSON и его резервная копия. */
function writeConfig(configPath: string, config: Record<string, unknown>): void {
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

export function saveDatabaseConfig(configPath: string, databaseUrl: string): void {
  const config = readConfig(configPath);
  config.current_db_type = databaseUrl ? 'REMOTE' : 'LOCAL';
  config.database_url = databaseUrl;
  config.remote_server_url = '';
  writeConfig(configPath, config);
}

/** Apply a user-selected replacement SQLite path without touching either database file. */
export function saveLocalDatabasePathConfig(configPath: string, databasePath: string): void {
  const config = readConfig(configPath);
  config.current_db_type = 'LOCAL';
  config.database_url = '';
  config.remote_server_url = '';
  config.local_db_path = path.resolve(databasePath);
  writeConfig(configPath, config);
}
