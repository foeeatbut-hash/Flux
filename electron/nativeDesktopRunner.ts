import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { NATIVE_DESKTOP_SCRIPT } from './nativeDesktopSource';

const runFile = promisify(execFile);

/** Windows ограничивает командную строку 32767 символами. Код помощника
 * записывается целиком в отдельную временную папку, без данных renderer. */
export async function runNativeDesktopScript(action: 'snapshot' | 'open' | 'public-desktop', nativeId = ''): Promise<unknown> {
  const directory = await mkdtemp(join(tmpdir(), 'flux-shell-helper-'));
  try {
    const script = join(directory, 'desktop.ps1');
    // Windows PowerShell 5.1 распознаёт UTF-8 по BOM.
    await writeFile(script, '\uFEFF' + NATIVE_DESKTOP_SCRIPT, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const result = await runFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script], {
      env: { ...process.env, FLUX_DESKTOP_ACTION: action, FLUX_DESKTOP_ITEM: nativeId },
      windowsHide: true, timeout: 25000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8',
    }).catch((cause: any) => {
      const marker = String(cause?.stderr || '').match(/FLUX_DESKTOP_NATIVE_FAILED:([a-z-]{1,32}):([A-Za-z]{1,48}):([A-F0-9]{8})/);
      const error = new Error('Не удалось прочитать рабочий стол Windows.');
      Object.assign(error, { code: marker ? `SHELL_${marker[1].replace(/-/g, '_').toUpperCase()}_${marker[3]}` : 'SHELL_HELPER_FAILED' });
      throw error;
    });
    return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
  } finally { await rm(directory, { recursive: true, force: true }); }
}
