import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.cwd();
const fixture = path.join(root, 'scripts/fixtures/office-cell-actions-ui');
const output = process.env.OFFICE_CELL_ACTIONS_UI_DIR || '/tmp/flux-office-cell-actions-ui';
mkdirSync(output, { recursive: true });

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate local Vite port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

const port = await freePort();
const url = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--config', path.join(fixture, 'vite.config.ts'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, env: { ...process.env, DISABLE_HMR: 'true' }, stdio: 'ignore' });
let check: ReturnType<typeof spawn> | undefined;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (vite.exitCode !== null) throw new Error(`Office cell actions fixture Vite exited early (${vite.exitCode})`);
    try { if ((await fetch(url)).ok) { ready = true; break; } } catch { /* starting */ }
    await delay(100);
  }
  if (!ready) throw new Error('Office cell actions fixture Vite server did not start');
  check = spawn(process.execPath, [path.join(fixture, 'check.mjs')], { cwd: root, env: { ...process.env, OFFICE_CELL_ACTIONS_UI_URL: url, OFFICE_CELL_ACTIONS_UI_DIR: output }, stdio: 'inherit' });
  const code = await new Promise<number>((resolve, reject) => {
    check!.once('error', reject);
    check!.once('exit', (status, signal) => status === null ? reject(new Error(`Office cell actions UI browser check stopped (${signal})`)) : resolve(status));
  });
  check = undefined;
  if (code !== 0) throw new Error(`Office cell actions UI browser check failed (${code})`);
} finally {
  check?.kill('SIGTERM');
  vite.kill('SIGTERM');
}
