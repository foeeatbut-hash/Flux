import fs from 'node:fs';
import path from 'node:path';

export { validateDatabaseUri } from '../shared/databaseUri';

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
