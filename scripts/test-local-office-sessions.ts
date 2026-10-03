/** Capability, ownership and persistence tests. No corporate API or customer files. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WindowsFilesService } from '../electron/filesystem/service';
import { LocalOfficeSessions, type LocalOfficeHost, type LocalOfficeEvent } from '../electron/localOfficeSessions';

class TestHost implements LocalOfficeHost {
  paths = new Map<number, string>();
  sent: { id: number; channel: string; args: unknown[] }[] = [];
  private next = 1;
  private sinks = new Set<(id: number, channel: string, args: unknown[]) => void>();
  private copies = new Map<number, (ok: boolean) => void>();
  afterSave?: () => void;
  start() {}
  open(path: string) { const id = this.next++; this.paths.set(id, path); return id; }
  onSend(fn: (id: number, channel: string, args: unknown[]) => void) { this.sinks.add(fn); return () => { this.sinks.delete(fn); }; }
  send(id: number, channel: string, args: unknown[]) {
    this.sent.push({ id, channel, args });
    if (channel === 'pdf:save-as-result') { this.copies.get(id)?.(args[0] === true); this.copies.delete(id); }
  }
  emit(id: number, channel: string, args: unknown[]) { for (const fn of this.sinks) fn(id, channel, args); }
  async invoke(id: number, channel: string, args: any[], saveTarget?: string, commit?: () => Promise<void>) {
    if (channel === 'pdf:consume-pending') return this.paths.get(id);
    if (channel === 'pdf:read-file') return readFile(args[0]);
    if (channel === 'workbook:select') return { sessionId: 'synthetic-native-session', path: this.paths.get(id) };
    if (channel === 'pdf:save' || channel === 'workbook:save') {
      const path = saveTarget || args[0]?.targetPath || this.paths.get(id)!;
      await writeFile(path, args[0]?.bytes || 'native edited bytes');
      this.afterSave?.();
      await commit?.();
      return saveTarget ? { canceled: true, fluxCopySaved: true } : { ok: true };
    }
    return {};
  }
  requestCopy(id: number, target: string) {
    return new Promise<boolean>(resolve => { this.copies.set(id, resolve); this.emit(id, 'pdf:save-as-request', [target]); });
  }
  close(id: number) { this.paths.delete(id); this.copies.get(id)?.(false); this.copies.delete(id); }
}
async function main() {
const testRoot = await mkdtemp(join(tmpdir(), 'flux-local-office-test-'));
const desktop = join(testRoot, 'desktop'); const userData = join(testRoot, 'private');
await mkdir(desktop); await mkdir(userData);
const files = await WindowsFilesService.create({ userData, knownFolders: { desktop }, trashItem: async () => {}, showItemInFolder: () => {}, openPath: async () => '' });
const rootId = (await files.roots())[0].id;
const pdf = new TestHost(); const sheets = new TestHost();
const events: {owner: number; event: LocalOfficeEvent}[] = [];
const officeDiagnostics: any[] = [];
const manager = new LocalOfficeSessions({ files, userData, loadHost: app => app === 'pdf' ? pdf : sheets,
  onEvent: (owner, event) => { events.push({owner,event}); }, onDiagnostic: event => officeDiagnostics.push(event), copyTimeoutMs: 50 });
let licensed = true;
const auth = { mayRead: () => true, mayWrite: () => licensed };
const ref = (name: string) => ({ rootId, relativePath: name });
let count = 0;
const check = (name: string, condition: unknown) => { assert.ok(condition, name); count++; console.log('✓ '+name); };
const rejected = async (name: string, code: string, work: () => Promise<unknown>) => {
  await assert.rejects(work, (e: any) => e.code === code); count++; console.log('✓ '+name);
};
try {
  await writeFile(join(desktop, 'source.pdf'), 'original pdf');
  await writeFile(join(desktop, 'source.xlsx'), 'original xlsx');
  const p = await manager.handle(10, {action:'open',app:'pdf',ref:ref('source.pdf')}, auth);
  const x = await manager.handle(20, {action:'open',app:'sheets',ref:ref('source.xlsx')}, auth);
  check('Native PDF/Sheets ID collision does not collide with exposed session IDs', p.session !== x.session && [...pdf.paths.keys()][0] === [...sheets.paths.keys()][0]);
  const originalPath = await manager.handle(10,{action:'invoke',session:p.session,channel:'pdf:consume-pending'},auth);
  check('Native editing file is private userData, separate from Windows original', originalPath.startsWith(userData) && originalPath !== join(desktop,'source.pdf'));
  check('Private directory permissions', process.platform === 'win32' || ((await stat(join(userData,'local-office'))).mode & 0o777) === 0o700);
  await rejected('Another webContents cannot invoke another session','SESSION_NOT_FOUND',()=>manager.handle(20,{action:'invoke',session:p.session,channel:'pdf:read-file',args:[originalPath]},auth));
  await rejected('Another webContents cannot close another session','SESSION_NOT_FOUND',()=>manager.handle(20,{action:'close',session:p.session},auth));
  await rejected('Forged read path denied','PATH_NOT_GRANTED',()=>manager.handle(10,{action:'invoke',session:p.session,channel:'pdf:read-file',args:[join(desktop,'source.xlsx')]},auth));
  await rejected('Forged save target denied','PATH_NOT_GRANTED',()=>manager.handle(10,{action:'invoke',session:p.session,channel:'pdf:save',args:[{path:originalPath,targetPath:join(desktop,'source.xlsx')}]},auth));
  await rejected('Generated/arbitrary file operations denied','CHANNEL_DISABLED',()=>manager.handle(20,{action:'invoke',session:x.session,channel:'workbook:open-for-merge',args:[[join(desktop,'source.pdf')]]},auth));
  await rejected('External printer denied','CHANNEL_DISABLED',()=>manager.handle(20,{action:'invoke',session:x.session,channel:'workbook:print'},auth));
  for (const [channel, args] of [
    ['workbook:pending-edits', [3]], ['workbook:close-save-result', [true]], ['workbook:recovery-prompt-reply', [false]],
  ] as [string, unknown[]][]) {
    const before = sheets.sent.length;
    const sent = await manager.handle(20, { action: 'send', session: x.session, channel, args }, auth);
    check(`Known Sheets lifecycle send reaches its native session (${channel})`, sent.sent && sheets.sent.length === before + 1 && sheets.sent.at(-1)?.channel === channel);
  }
  const sendsBeforeReady = sheets.sent.length;
  const ready = await manager.handle(20,{action:'send',session:x.session,channel:'sheets:mcp-ready'},auth);
  check('Sheets startup readiness is consumed locally without native forwarding', ready.sent && sheets.sent.length === sendsBeforeReady);
  await rejected('MCP result send stays disabled in local mode','CHANNEL_DISABLED',()=>manager.handle(20,{action:'send',session:x.session,channel:'sheets:mcp-result',args:[{requestId:'x',result:'data'}]},auth));
  check('Rejected send never reaches the native session', sheets.sent.length === sendsBeforeReady);
  check('Rejected send diagnostic identifies channel without arguments', officeDiagnostics.at(-1)?.action === 'send' && officeDiagnostics.at(-1)?.unknownChannel === 'sheets:mcp-result' && !('args' in officeDiagnostics.at(-1)));
  await rejected('Readiness signal cannot smuggle a payload','INVALID_REQUEST',()=>manager.handle(20,{action:'send',session:x.session,channel:'sheets:mcp-ready',args:['unexpected']},auth));
  pdf.emit(1,'pdf:save-as-flow',[true]); sheets.emit(1,'workbook:pending-edits',[3]);
  check('Events stay with app+native ID owner', events.at(-2)?.owner === 10 && events.at(-1)?.owner === 20 && events.at(-2)?.event.session === p.session);
  await manager.handle(10,{action:'invoke',session:p.session,channel:'pdf:save',args:[{path:originalPath,bytes:'saved pdf'}]},auth);
  check('Native saved bytes persist through Windows capability',await readFile(join(desktop,'source.pdf'),'utf8') === 'saved pdf');
  await writeFile(join(desktop,'source.pdf'),'external edit');
  await rejected('External edits trigger CAS conflict without overwriting','CONFLICT',()=>manager.handle(10,{action:'invoke',session:p.session,channel:'pdf:save',args:[{path:originalPath,bytes:'our pending edit'}]},auth));
  check('Conflict keeps external bytes',await readFile(join(desktop,'source.pdf'),'utf8') === 'external edit');
  // Copy waits for a reentrant native invoke and separate result acknowledgement.
  const copy = manager.handle(10,{action:'copy',session:p.session,name:'copy.pdf'},auth);
  while (!events.some(e=>e.event.channel === 'pdf:save-as-request')) await new Promise(r=>setTimeout(r,1));
  const copyPath = events.find(e=>e.event.channel === 'pdf:save-as-request')!.event.args[0];
  await manager.handle(10,{action:'invoke',session:p.session,channel:'pdf:save',args:[{path:originalPath,targetPath:copyPath,bytes:'our pending edit'}]},auth);
  await manager.handle(10,{action:'send',session:p.session,channel:'pdf:save-as-result',args:[true]},auth);
  check('PDF reentrant copy completes without deadlock',!!(await copy).copy);
  check('SaveAs after conflict creates sibling and preserves original',await readFile(join(desktop,'copy.pdf'),'utf8')==='our pending edit' && await readFile(join(desktop,'source.pdf'),'utf8')==='external edit');
  const canceled = await manager.handle(10,{action:'copy',session:p.session,name:'canceled.pdf'},auth);
  check('Timed-out/canceled PDF copy does not create a file',canceled.canceled && !(await readdir(desktop)).includes('canceled.pdf'));
  const sheetResult = await manager.handle(20,{action:'invoke',session:x.session,channel:'workbook:save',copyName:'copy.xlsx',args:[{mode:'save-as',bytes:'copied xlsx'}]},auth);
  check('Sheet SaveAs preserves original and session',sheetResult.fluxCopySaved && await readFile(join(desktop,'source.xlsx'),'utf8')==='original xlsx' && sheets.paths.size===1);
  const recovery = await manager.handle(20,{action:'invoke',session:x.session,channel:'workbook:write-recovery',args:[{bytes:'recovery xlsx'}]},auth);
  check('Sheet recovery stays inside private session, no Windows file write',recovery.ok && !(await readdir(desktop)).includes('recovery.xlsx') && await readFile(join([...sheets.paths.values()][0], '..', 'recovery.xlsx'),'utf8')==='recovery xlsx');
  licensed = false;
  check('Expired licence allows read',!!await manager.handle(20,{action:'invoke',session:x.session,channel:'workbook:select'},auth));
  await rejected('Expired licence blocks save','READ_ONLY',()=>manager.handle(20,{action:'invoke',session:x.session,channel:'workbook:save',args:[{mode:'save'}]},auth));
  licensed = true; sheets.afterSave = () => { licensed = false; };
  await rejected('Licence is rechecked after native save before original write','READ_ONLY',()=>manager.handle(20,{action:'invoke',session:x.session,channel:'workbook:save',args:[{mode:'save',bytes:'forbidden write'}]},auth));
  check('Revocation during save preserves original',await readFile(join(desktop,'source.xlsx'),'utf8')==='original xlsx');
  licensed = true; sheets.afterSave = undefined;
  const draft = await files.createDraft({rootId,relativePath:''},'draft.xlsx',Buffer.from('draft original').toString('base64'));
  const d = await manager.handle(30,{action:'open',app:'sheets',ref:draft.ref},auth);
  const draftCopy = await manager.handle(30,{action:'invoke',session:d.session,channel:'workbook:save',copyName:'draft copy.xlsx',args:[{mode:'save-as',bytes:'draft copy'}]},auth);
  check('Flux draft copy remains Flux-only in same parent',draftCopy.copy.file.storage==='flux' && !(await readdir(desktop)).includes('draft copy.xlsx'));
  await manager.closeOwner(10);
  check('Destroying owner closes its native hosts only',pdf.paths.size===0 && sheets.paths.size===2);
  await rejected('Destroyed owner cannot reopen','SESSION_CLOSED',()=>manager.handle(10,{action:'open',app:'pdf',ref:ref('source.pdf')},auth));
  await rejected('Closed session no longer receives calls','SESSION_NOT_FOUND',()=>manager.handle(40,{action:'invoke',session:p.session,channel:'pdf:consume-pending'},auth));
  const p2=await manager.handle(50,{action:'open',app:'pdf',ref:ref('source.pdf')},auth);
  const waitingCopy=manager.handle(50,{action:'copy',session:p2.session,name:'closed.pdf'},auth);
  await new Promise(r=>setTimeout(r,1));
  await manager.closeOwner(50);
  check('Destroying owner cancels pending reentrant PDF copy', (await waitingCopy).canceled && !(await readdir(desktop)).includes('closed.pdf'));
  await manager.dispose();
  check('Dispose removes all private session files',manager.size===0 && (await readdir(join(userData,'local-office'))).length===0);
  console.log(`${count} local Office capability/persistence checks passed`);
} finally { await manager.dispose(); files.close(); await rm(testRoot,{recursive:true,force:true}); }

}
void main().catch(error => { console.error(error); process.exitCode = 1; });
