import { app, utilityProcess } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Portable содержит нативные модули для Electron, поэтому запускает API тем же движком. */
export function startCompanyServer(): void {
  const data = process.env.VENT_APP_DATA || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'pdm-app');
  fs.mkdirSync(data, { recursive: true });
  const logFile = path.join(data, 'company-server.log');
  const write = (value: string) => fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${value}\n`);
  try {
    const child = utilityProcess.fork(path.join(__dirname, '../dist/server.cjs'), [], {
      env: { ...process.env, NODE_ENV: 'production', FLUX_RESOURCES_PATH: process.resourcesPath, VENT_APP_DATA: data, FLUX_EMBEDDED: '0', FLUX_LISTEN_HOST: '127.0.0.1' },
      stdio: 'pipe', serviceName: 'flux-company-server',
    });
    child.stdout?.on('data', value => write(String(value).trimEnd()));
    child.stderr?.on('data', value => write(String(value).trimEnd()));
    child.once('exit', code => { write(`Сервер завершился: ${code}`); app.exit(code || 0); });
    app.on('will-quit', () => child.kill());
    write('Запуск локального обработчика общей БД для владельца. Подключения только с этого компьютера.');
  } catch (error: any) {
    write(`Не удалось запустить API: ${error.message}`);
    app.exit(1);
  }
}
