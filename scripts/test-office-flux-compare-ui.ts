import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Перенос возможностей старой панели в новую: «Вставить все», XLSX, CSV, имена
 * файлов — на одних и тех же данных старая FluxPanel и новая FluxOfficePanel
 * дают одинаковый результат. Страница и сверка — scripts/fixtures/office-flux-panel-ui/compare.*
 */
const root = process.cwd();
const fixture = path.join(root, 'scripts/fixtures/office-flux-panel-ui');

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

void (async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--config', path.join(fixture, 'vite.config.ts'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'ignore' });
  let code = 1;
  try {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (vite.exitCode !== null) throw new Error('Vite стенда сверки не запустился');
      try { if ((await fetch(url)).ok) break; } catch { /* запускается */ }
      await delay(100);
    }
    const check = spawn(process.execPath, [path.join(fixture, 'compare.mjs')], { cwd: root, env: { ...process.env, OFFICE_ADDON_UI_URL: url }, stdio: 'inherit' });
    [code] = (await once(check, 'exit')) as [number];
  } finally { vite.kill('SIGTERM'); }
  process.exitCode = code;
})().catch((error) => { console.error(error); process.exitCode = 1; });
