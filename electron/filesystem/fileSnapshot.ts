import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { WindowsFilesError } from './paths';

/** Версия вычисляется потоково: ограничение редактора 64 МБ не относится к операциям Проводника. */
export async function snapshotFile(source: string, destination?: string): Promise<{ sha256: string; size: number }> {
  const input = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let output: Awaited<ReturnType<typeof fs.open>> | undefined;
  let owned: { dev: bigint; ino: bigint } | undefined;
  let complete = false;
  try {
    const before = await input.stat({ bigint: true });
    if (!before.isFile()) throw new WindowsFilesError('NOT_FILE', 'Заменять можно только обычные файлы.');
    if (destination) { output = await fs.open(destination, 'wx', 0o600); const stat = await output.stat({ bigint: true }); owned = { dev: stat.dev, ino: stat.ino }; }
    const digest = createHash('sha256'); const buffer = Buffer.alloc(256 * 1024); let size = 0;
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead)); size += bytesRead;
      if (output) for (let offset = 0; offset < bytesRead;) { const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, null); if (!bytesWritten) throw new WindowsFilesError('WRITE_FAILED', 'Не удалось записать копию файла.'); offset += bytesWritten; }
    }
    const after = await input.stat({ bigint: true }); const named = await fs.lstat(source, { bigint: true });
    if (named.isSymbolicLink() || before.dev !== named.dev || before.ino !== named.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(size) !== before.size) throw new WindowsFilesError('CONFLICT', 'Файл изменился во время копирования. Проверьте свежую версию.');
    if (output) { await output.sync(); const target = await fs.lstat(destination!, { bigint: true }); if (target.isSymbolicLink() || target.dev !== owned!.dev || target.ino !== owned!.ino) throw new WindowsFilesError('CONFLICT', 'Копия заменена другой программой.'); }
    complete = true; return { sha256: digest.digest('hex'), size };
  } finally {
    await input.close(); await output?.close();
    if (!complete && destination && owned) { const stat = await fs.lstat(destination, { bigint: true }).catch(() => null); if (stat?.dev === owned.dev && stat?.ino === owned.ino && !stat.isSymbolicLink()) await fs.rm(destination); }
  }
}
