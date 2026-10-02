/** Stage replacement beside the portable executable; restore its original bytes on failed rename. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function stageExecutable(source: string, target: string): { staged: string; backup: string } {
  if (!path.isAbsolute(target) || !/\.exe$/i.test(target) || path.resolve(source) === path.resolve(target)) throw new Error('Некорректный путь замены программы');
  const suffix = crypto.randomUUID();
  const staged = `${target}.flux-${suffix}.new`, backup = `${target}.flux-${suffix}.bak`;
  try {
    fs.copyFileSync(source, staged, fs.constants.COPYFILE_EXCL);
    const fd = fs.openSync(staged, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return { staged, backup };
  } catch (e) { try { fs.unlinkSync(staged); } catch (_) {} throw e; }
}

export function replaceExecutable(target: string, staged: string, backup: string): void {
  fs.renameSync(target, backup);
  try { fs.renameSync(staged, target); }
  catch (e) { fs.renameSync(backup, target); throw e; }
}

export function restoreExecutable(target: string, backup: string): void {
  if (!fs.existsSync(backup)) return;
  const failed = `${target}.flux-failed-${crypto.randomUUID()}`;
  if (fs.existsSync(target)) fs.renameSync(target, failed);
  try { fs.renameSync(backup, target); }
  catch (e) { if (fs.existsSync(failed)) fs.renameSync(failed, target); throw e; }
  try { fs.unlinkSync(failed); } catch (_) {}
}
