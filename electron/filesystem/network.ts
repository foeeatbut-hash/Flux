import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseNetUse, parseProviderName } from './locationKeys';

const runFile = promisify(execFile);
const script = Buffer.from(`$ErrorActionPreference='Stop'
$drive = [IO.DriveInfo]::new($env:FLUX_NETWORK_DRIVE)
[Console]::WriteLine(($drive.DriveType -eq [IO.DriveType]::Network).ToString().ToLowerInvariant())`, 'utf16le').toString('base64');
const cached = new Map<string, {at:number; value:Promise<boolean>}>();

/** Метка сети не выдаёт права: каждый read/write по-прежнему проверяет Windows. */
export function isNetworkFolder(filename: string): Promise<boolean> {
  if (/^(?:\\\\|\/\/)[^\\/]+[\\/]/u.test(filename)) return Promise.resolve(true);
  if (process.platform !== 'win32') return Promise.resolve(false);
  const drive = path.win32.parse(filename).root;
  if (!/^[a-z]:\\$/iu.test(drive)) return Promise.resolve(false);
  const key = drive.toUpperCase(), hit = cached.get(key);
  if (hit && Date.now()-hit.at < 60_000) return hit.value;
  // Команда фиксирована; буква диска передаётся как данные, без паролей SMB.
  const value = runFile('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',script],{
    env:{...process.env,FLUX_NETWORK_DRIVE:drive},windowsHide:true,timeout:3000,maxBuffer:1024,
  }).then(result=>result.stdout.trim() === 'true').catch(()=>false);
  cached.set(key,{at:Date.now(),value}); return value;
}

const uncScript = Buffer.from(`$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$id=$env:FLUX_NETWORK_DRIVE.TrimEnd('\\')
$disk=Get-CimInstance -ClassName Win32_LogicalDisk -Filter ("DeviceID='"+$id+"'")
if($disk -and $disk.ProviderName){[Console]::WriteLine($disk.ProviderName)}`, 'utf16le').toString('base64');
const uncCache = new Map<string, {at:number; value:Promise<string|null>}>();

/** Вывод консольной утилиты Windows: UTF-8, а у русской `net use` — кодовая страница 866. */
function decodeConsole(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { try { return new TextDecoder('ibm866').decode(bytes); } catch { return bytes.toString('latin1'); } }
}

/**
 * Сетевой диск → `\\сервер\ресурс` (для ключа места папки). Сначала WMI через PowerShell
 * (Unicode-безопасно), при отказе — разбор `net use X:`. Локальный диск и сбой дают null.
 * Работает только в Windows; вне неё разбор проверяется на образцах вывода (locationKeys).
 */
export function mappedDriveUnc(driveRoot: string): Promise<string | null> {
  if (process.platform !== 'win32' || !/^[a-z]:\\$/iu.test(driveRoot)) return Promise.resolve(null);
  const key = driveRoot.toUpperCase(), hit = uncCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const fromWmi = runFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', uncScript], {
    env: { ...process.env, FLUX_NETWORK_DRIVE: driveRoot }, windowsHide: true, timeout: 5000, maxBuffer: 4096,
  }).then(result => parseProviderName(result.stdout)).catch(() => null);
  const value = fromWmi.then(found => found || runFile('net.exe', ['use', key.slice(0, 2)], { windowsHide: true, timeout: 5000, maxBuffer: 8192, encoding: 'buffer' })
    .then(result => parseNetUse(decodeConsole(result.stdout as unknown as Buffer))).catch(() => null));
  uncCache.set(key, { at: Date.now(), value });
  return value;
}
