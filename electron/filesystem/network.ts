import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
