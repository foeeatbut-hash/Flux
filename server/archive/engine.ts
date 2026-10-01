import { execFile as execFileCb, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { parse7zListing, type ArchiveEntry } from './safety.js';

const execFile = promisify(execFileCb);
const requireFromApp = createRequire(join(process.cwd(), 'package.json'));
const MAX_STDOUT = 16 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

export function archiveEnginePath(): string {
  const resources = (process as any).resourcesPath || process.env.FLUX_RESOURCES_PATH;
  const bundled = resources && join(resources, 'archive', process.platform === 'win32' ? '7z.exe' : '7zz');
  if (bundled && existsSync(bundled)) return bundled;
  const pkg = requireFromApp('7zip-bin-full') as { path7z?: string };
  const path = pkg.path7z;
  if (!path) throw new Error('Архивный движок не установлен для этой платформы');
  return path;
}

export async function run7z(args: string[], options: { cwd?: string; timeout?: number } = {}): Promise<string> {
  try {
    const result = await execFile(archiveEnginePath(), args, {
      cwd: options.cwd,
      timeout: options.timeout || TIMEOUT_MS,
      maxBuffer: MAX_STDOUT,
      windowsHide: true,
      encoding: 'utf8',
    });
    return String(result.stdout || '');
  } catch (error: any) {
    const output = `${error?.stdout || ''}\n${error?.stderr || ''}`.toLowerCase();
    if (/wrong password|password is incorrect|can not open encrypted archive|data error in encrypted file/.test(output)) {
      throw new Error('Пароль неверен или архив повреждён');
    }
    if (error?.killed || error?.code === 'ETIMEDOUT') throw new Error('Операция с архивом превысила лимит времени');
    if (error?.code === 'ENOENT') throw new Error('Архивный движок недоступен');
    if (/can not open file as archive|is not archive|unexpected end of archive|headers error/.test(output)) {
      throw new Error('Архив повреждён или имеет неподдерживаемый формат');
    }
    // Не отдаём имя файла, пароль, временный путь или вывод утилиты.
    throw new Error('Не удалось обработать архив');
  }
}

export async function listArchive(file: string, password?: string, timeoutMs = TIMEOUT_MS): Promise<ArchiveEntry[]> {
  const args = ['l', '-slt', '-sccUTF-8'];
  if (password) args.push(`-p${password}`);
  args.push('--', file);
  const output = await run7z(args, { timeout: timeoutMs });
  if (/^Volumes = [2-9]\d*$/m.test(output)) throw new Error('Многотомные архивы пока не поддерживаются');
  return parse7zListing(output);
}

/** Extract with a live filesystem budget: archive metadata can understate output size. */
export async function run7zBounded(
  args: string[], root: string, limits = { bytes: 512 * 1024 * 1024, entries: 5000, timeoutMs: TIMEOUT_MS },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(archiveEnginePath(), args, { cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let stopped = false; let finished = false;
    const stop = (reason: string) => {
      if (finished || stopped) return;
      stopped = true;
      clearTimeout(timer);
      clearInterval(meter);
      child.kill();
      reject(new Error(reason));
    };
    const timer = setTimeout(() => stop('Операция с архивом превысила лимит времени'), limits.timeoutMs);
    let meterBusy = false;
    const meter = setInterval(async () => {
      if (meterBusy || stopped || finished) return;
      meterBusy = true;
      try {
        let bytes = 0; let count = 0;
        const walk = async (dir: string): Promise<void> => {
          for (const item of await readdir(dir, { withFileTypes: true })) {
            const path = join(dir, item.name); const stat = await lstat(path);
            if (stat.isSymbolicLink() || stat.nlink > 1) throw new Error('Архив содержит ссылки; распаковка запрещена');
            if (stat.isDirectory()) { count++; await walk(path); }
            else if (stat.isFile()) { bytes += stat.size; count++; }
            if (bytes > limits.bytes) throw new Error('Распакованный архив превышает предел 512 МБ');
            if (count > limits.entries) throw new Error('В архиве слишком много элементов');
          }
        };
        await walk(root);
      } catch (err: any) { stop(err?.message || 'Распаковка превышает допустимый размер'); }
      finally { meterBusy = false; }
    }, 50);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > MAX_STDOUT) stop('Слишком большой ответ архивного движка');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > MAX_STDOUT) stop('Слишком большой ответ архивного движка');
    });
    child.on('error', () => stop('Архивный движок недоступен'));
    child.on('close', (code) => {
      finished = true; clearTimeout(timer); clearInterval(meter);
      if (stopped) return;
      if (code === 0) resolve(stdout);
      else {
        const output = `${stdout}\n${stderr}`.toLowerCase();
        if (/wrong password|password is incorrect|data error in encrypted file/.test(output)) reject(new Error('Пароль неверен или архив повреждён'));
        else reject(new Error('Архив повреждён или имеет неподдерживаемый формат'));
      }
    });
  });
}
