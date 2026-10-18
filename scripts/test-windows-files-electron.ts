import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

const repo = process.cwd();
const logPath = path.join(os.tmpdir(), 'flux-windows-files-electron.log');
const printLogTail = async (filename: string) => {
  const text = await readFile(filename, 'utf8').catch(() => '');
  return text.split(/\r?\n/u).slice(-50).join('\n');
};

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'flux-windows-files-electron-'));
  try {
  const buildResult = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:electron'], {
    cwd: repo, encoding: 'utf8', timeout: 8 * 60_000, maxBuffer: 20 * 1024 * 1024,
    ...(process.platform === 'win32' ? { shell: true } : {}),
  });
  const buildLog = `${buildResult.stdout || ''}\n${buildResult.stderr || ''}`;
  await writeFile(`${logPath}.build`, buildLog, 'utf8');
  assert.equal(buildResult.status, 0, `npm run build:electron failed; log: ${logPath}.build\n${buildLog.split(/\r?\n/u).slice(-35).join('\n')}`);

  const appDir = path.join(temp, 'electron-app');
  const desktop = path.join(temp, 'desktop');
  const documents = path.join(temp, 'documents');
  const downloads = path.join(temp, 'downloads');
  const userData = path.join(temp, 'user-data');
  await Promise.all([mkdir(appDir, { recursive: true }), mkdir(desktop), mkdir(documents), mkdir(downloads), mkdir(userData)]);
  await symlink(path.join(repo, 'node_modules'), path.join(appDir, 'node_modules'), 'junction');
  await writeFile(path.join(desktop, 'Fixture.txt'), 'before');
  await writeFile(path.join(appDir, 'package.json'), JSON.stringify({ name: 'flux-electron-files-test', version: '1.0.0', main: 'main.cjs' }));
  const mainEntry = path.join(repo, 'scripts/fixtures/windows-files-electron-main.ts');
  await build({
    entryPoints: [mainEntry], outfile: path.join(appDir, 'main.cjs'), bundle: true,
    platform: 'node', format: 'cjs', external: ['electron'], packages: 'external',
  });

  const require = createRequire(path.join(repo, 'package.json'));
  const electronBinary = require('electron') as string;
  const nodeModules = path.join(repo, 'node_modules');
  const args = ['--disable-gpu'];
  if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) args.unshift('--no-sandbox');
  args.push(appDir);
  const electron = spawnSync(electronBinary, args, {
    cwd: repo, encoding: 'utf8', timeout: 90_000, maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_PATH: [nodeModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
      FLUX_FILES_TEST_USER_DATA: userData,
      FLUX_FILES_TEST_DESKTOP: desktop,
      FLUX_FILES_TEST_DOCUMENTS: documents,
      FLUX_FILES_TEST_DOWNLOADS: downloads,
      FLUX_FILES_TEST_PRELOAD: path.join(repo, 'dist-electron/preload.js'),
    },
  });
  const output = `${electron.stdout || ''}\n${electron.stderr || ''}`;
  await writeFile(logPath, output, 'utf8');
  if (electron.error || electron.status !== 0) {
    const tail = await printLogTail(logPath);
    throw new Error(`Real Electron preload/IPC test failed (status ${electron.status ?? 'spawn error'}); full log: ${logPath}\n${tail}`);
  }
  assert.match(output, /ELECTRON_FILES_IPC_PASS/u, `Electron exited without success marker; log: ${logPath}`);
  console.log('✓ Реальный Electron preload → IPC → WindowsFilesService: список, чтение, запись, копирование, переименование, перенос и удаление');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
