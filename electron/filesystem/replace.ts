import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WindowsFilesError } from './paths';

const runFile = promisify(execFile);
// ReplaceFile сохраняет ACL, потоки и атрибуты оригинала; rename временной копии
// на NTFS мог бы незаметно заменить индивидуальные права файла правами папки.
const REPLACE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FluxFileReplacement {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool ReplaceFile(string replaced, string replacement, string backup, UInt32 flags, IntPtr exclude, IntPtr reserved);
}
'@
$guard = [IO.File]::Open($env:FLUX_REPLACE_ORIGINAL, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::Read -bor [IO.FileShare]::Delete))
try {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { $digest = [BitConverter]::ToString($algorithm.ComputeHash($guard)).Replace('-', '').ToLowerInvariant() } finally { $algorithm.Dispose() }
  if ($digest -ne $env:FLUX_REPLACE_BASE_SHA256) {
    [Console]::Error.WriteLine('FLUX_REPLACE_CONFLICT')
    exit 2
  }
  if (-not [FluxFileReplacement]::ReplaceFile($env:FLUX_REPLACE_ORIGINAL, $env:FLUX_REPLACE_TEMPORARY, $null, 0, [IntPtr]::Zero, [IntPtr]::Zero)) {
    $failure = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    [Console]::Error.WriteLine('FLUX_REPLACE_ERROR=' + $failure)
    exit 1
  }
} finally { $guard.Dispose() }

`;
const ENCODED_REPLACE = Buffer.from(REPLACE_SCRIPT, 'utf16le').toString('base64');
export async function replaceWindowsFile(temporary: string, original: string, baseSha256: string): Promise<void> {
  if (process.platform !== 'win32') { await fs.rename(temporary, original); return; }
  try {
    await runFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED_REPLACE], {
      env: { ...process.env, FLUX_REPLACE_ORIGINAL: original, FLUX_REPLACE_TEMPORARY: temporary, FLUX_REPLACE_BASE_SHA256: baseSha256 },
      windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024,
    });
  } catch (error: any) {
    if (String(error.stderr || '').includes('FLUX_REPLACE_CONFLICT')) throw new WindowsFilesError('CONFLICT', 'Файл изменился перед записью Windows. Откройте свежую версию или сохраните копию.');
    const nativeCode = /FLUX_REPLACE_ERROR=(\d+)/u.exec(String(error.stderr || ''))?.[1];
    if (nativeCode === '5' || nativeCode === '32' || nativeCode === '33') throw new WindowsFilesError('EBUSY', 'Windows не разрешила заменить занятый файл. Закройте его в другой программе и повторите сохранение.');
    throw new WindowsFilesError('NATIVE_REPLACE_FAILED', 'Windows не выполнила сохранение с сохранением прав файла. Исходник и восстановимая версия сохранены; проверьте журнал Windows и повторите действие.');
  }
}
