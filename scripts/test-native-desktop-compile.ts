import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NATIVE_DESKTOP_SCRIPT } from '../electron/nativeDesktopSource';

async function main() {
  if (process.platform !== 'win32') { console.log('Windows native compilation requires Windows; not verified here.'); return; }
  const result = await promisify(execFile)('powershell.exe', [
    '-NoLogo','-NoProfile','-NonInteractive','-STA','-EncodedCommand',Buffer.from(NATIVE_DESKTOP_SCRIPT,'utf16le').toString('base64'),
  ], { env:{...process.env,FLUX_DESKTOP_ACTION:'public-desktop',FLUX_DESKTOP_ITEM:''}, windowsHide:true, timeout:30_000, maxBuffer:64*1024 });
  const folder = JSON.parse(result.stdout.trim().replace(/^\uFEFF/,''));
  assert.equal(typeof folder?.path,'string');
  assert.ok(folder.path.length > 0);
  console.log('✓ Windows compiled the native Shell helper and resolved PublicDesktop without requiring Explorer to run');
}
void main().catch(error => { console.error(error); process.exitCode=1; });
