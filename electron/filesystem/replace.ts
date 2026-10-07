import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WindowsFilesError } from './paths';

const runFile = promisify(execFile);
// ReplaceFile сохраняет ACL, потоки и атрибуты оригинала; rename временной копии
// на NTFS мог бы незаметно заменить индивидуальные права файла правами папки.
const REPLACE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$stage = 'compile'
$guard = $null
$writerLock = $null
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FluxFileReplacement {
  [DllImport("kernel32.dll", EntryPoint="ReplaceFileW", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool ReplaceFile(string replaced, string replacement, IntPtr backup, UInt32 flags, IntPtr exclude, IntPtr reserved);
}
'@
$stage = 'lock'
# The folder, rather than its UNC spelling, identifies this lock. A mapped drive
# and an UNC path therefore serialize saves to the same physical file.
$name = [IO.Path]::GetFileName($env:FLUX_REPLACE_ORIGINAL).ToUpperInvariant()
$nameHasher = [Security.Cryptography.SHA256]::Create()
try { $nameHash = [BitConverter]::ToString($nameHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($name))).Replace('-', '').ToLowerInvariant() } finally { $nameHasher.Dispose() }
$lockPath = [IO.Path]::Combine([IO.Path]::GetDirectoryName($env:FLUX_REPLACE_ORIGINAL), '.flux-write-' + $nameHash + '.lock')
# Windows releases the handle and deletes the lock after a crash, too. Never
# expire or forcibly remove a live lock: it could overwrite another writer.
$writerLock = [IO.FileStream]::new($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 1, [IO.FileOptions]::DeleteOnClose)
$stage = 'open'
$guard = [IO.File]::Open($env:FLUX_REPLACE_ORIGINAL, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::Read -bor [IO.FileShare]::Delete))
try {
  $stage = 'hash'
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { $digest = [BitConverter]::ToString($algorithm.ComputeHash($guard)).Replace('-', '').ToLowerInvariant() } finally { $algorithm.Dispose() }
  if ($digest -ne $env:FLUX_REPLACE_BASE_SHA256) {
    [Console]::Error.WriteLine('FLUX_REPLACE_CONFLICT')
    exit 2
  }
  $stage = 'replace'
  if (-not [FluxFileReplacement]::ReplaceFile($env:FLUX_REPLACE_ORIGINAL, $env:FLUX_REPLACE_TEMPORARY, [IntPtr]::Zero, 0, [IntPtr]::Zero, [IntPtr]::Zero)) {
    $failure = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    [Console]::Error.WriteLine('FLUX_REPLACE_STAGE=' + $stage)
    [Console]::Error.WriteLine('FLUX_REPLACE_ERROR=' + $failure)
    exit 1
  }
} finally { if ($null -ne $guard) { $guard.Dispose(); $guard = $null } }
} catch {
  $exception = $_.Exception
  while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
  [Console]::Error.WriteLine('FLUX_REPLACE_STAGE=' + $stage)
  [Console]::Error.WriteLine('FLUX_REPLACE_MANAGED=' + $exception.GetType().FullName)
  [Console]::Error.WriteLine('FLUX_REPLACE_HRESULT=' + $exception.HResult)
  exit 3
} finally {
  if ($null -ne $guard) { $guard.Dispose() }
  if ($null -ne $writerLock) { $writerLock.Dispose() }
}

`;
export interface WindowsReplacementDiagnostic { stage?: string; win32?: string; managedType?: string; hResult?: string; exitCode?: number | string; timedOut?: boolean }
function diagnosticOf(error: any): WindowsReplacementDiagnostic {
  const stderr = String(error.stderr || '');
  const marker = (name: string, pattern = '[A-Za-z0-9_.-]+') => new RegExp(`FLUX_REPLACE_${name}=(${pattern})`).exec(stderr)?.[1];
  return { stage: marker('STAGE'), win32: marker('ERROR', '[0-9]+'), managedType: marker('MANAGED'), hResult: marker('HRESULT', '-?[0-9]+'),
    exitCode: typeof error.code === 'number' || typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : undefined, timedOut: !!error.killed };
}
function replacementFailure(code: string, message: string, error: any): WindowsFilesError {
  return Object.assign(new WindowsFilesError(code, message), { nativeDiagnostic: diagnosticOf(error) });
}
const ENCODED_REPLACE = Buffer.from(REPLACE_SCRIPT, 'utf16le').toString('base64');
export async function replaceWindowsFile(temporary: string, original: string, baseSha256: string): Promise<void> {
  if (process.platform !== 'win32') { await fs.rename(temporary, original); return; }
  try {
    await runFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED_REPLACE], {
      env: { ...process.env, FLUX_REPLACE_ORIGINAL: original, FLUX_REPLACE_TEMPORARY: temporary, FLUX_REPLACE_BASE_SHA256: baseSha256 },
      // Каждое сохранение запускает PowerShell и компилирует замену заново (Add-Type):
      // на холодной машине это занимает 15 секунд и больше — прежний предел обрывал
      // первое сохранение на CI. Обрыв здесь — отказ в сохранении, поэтому предел с запасом
      windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024,
    });
  } catch (error: any) {
    if (String(error.stderr || '').includes('FLUX_REPLACE_CONFLICT')) throw replacementFailure('CONFLICT', 'Файл изменился перед записью Windows. Откройте свежую версию или сохраните копию.', error);
    if (diagnosticOf(error).stage === 'lock') throw replacementFailure('EBUSY', 'Другой участник сохраняет файл или папка не разрешает запись. Ваши правки сохранены в редакторе; повторите сохранение или создайте копию.', error);
    const nativeCode = /FLUX_REPLACE_ERROR=(\d+)/u.exec(String(error.stderr || ''))?.[1];
    if (nativeCode === '5' || nativeCode === '32' || nativeCode === '33') throw replacementFailure('EBUSY', 'Windows не разрешила заменить занятый файл. Закройте его в другой программе и повторите сохранение.', error);
    throw replacementFailure('NATIVE_REPLACE_FAILED', 'Windows не выполнила сохранение с сохранением прав файла. Исходник и восстановимая версия сохранены; проверьте журнал Windows и повторите действие.', error);
  }
}
