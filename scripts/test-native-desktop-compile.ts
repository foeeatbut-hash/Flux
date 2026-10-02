import assert from 'node:assert/strict';
import { runNativeDesktopScript } from '../electron/nativeDesktopRunner';

async function main() {
  if (process.platform !== 'win32') { console.log('Windows native compilation requires Windows; not verified here.'); return; }
  const folder = await runNativeDesktopScript('public-desktop') as { path?: unknown };
  assert.equal(typeof folder?.path,'string');
  assert.ok(typeof folder.path === 'string' && folder.path.length > 0);
  console.log('✓ Windows compiled the native Shell helper and resolved PublicDesktop without requiring Explorer to run');
}
void main().catch(error => { console.error(error); process.exitCode=1; });
