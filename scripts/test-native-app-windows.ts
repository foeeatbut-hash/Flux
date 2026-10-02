import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { internalAppHref, NATIVE_APP_OPEN, NATIVE_APP_LIST, NATIVE_APP_LOCATION, NATIVE_APP_CLOSE_REPLY } from '../workspace/nativeApps';

async function main() {
  const handlers = new Map<string, Function>();
  const windows: MockWindow[] = [];
  const timers: { callback: () => void; cleared: boolean }[] = [];
  let dialogs = 0;
  class MockWindow extends EventEmitter {
    id = windows.length + 1; destroyed = false; minimized = false; focused = false;
    messages: any[] = []; url = ''; title = 'Flux'; options: any;
    webContents = Object.assign(new EventEmitter(), { id: this.id, send: (...args: any[]) => this.messages.push(args), setWindowOpenHandler() {} });
    constructor(options: any) { super(); this.options = options; windows.push(this); }
    isDestroyed() { return this.destroyed; } isMinimized() { return this.minimized; }
    isFocused() { return this.focused; } getTitle() { return this.title; }
    restore() { this.minimized = false; } show() {} focus() { this.focused = true; }
    minimize() { this.minimized = true; }
    async loadURL(url: string) { this.url = url; }
    close() { let stopped = false; this.emit('close', { preventDefault() { stopped = true; } }); if (!stopped) { this.destroyed = true; this.emit('closed'); } }
  }
  const electron = {
    app: { isPackaged: false }, BrowserWindow: MockWindow,
    dialog: { showMessageBox: async () => { dialogs++; return { response: 0 }; } },
    ipcMain: { handle: (name: string, fn: Function) => handlers.set(name, fn) },
    screen: { getCursorScreenPoint: () => ({x:-1000,y:100}), getDisplayNearestPoint: () => ({ workArea:{x:-1920,y:0,width:1920,height:1040} }) },
  };
  const bundle = await build({ entryPoints:['electron/nativeApps.ts'],bundle:true,platform:'node',format:'cjs',write:false,external:['electron'] });
  const module = {exports:{} as any}; const require = createRequire(import.meta.url);
  vm.runInNewContext(bundle.outputFiles[0].text, {module,exports:module.exports,URL,URLSearchParams,
    setTimeout:(callback:()=>void)=>{timers.push({callback,cleared:false});return timers.length;},
    clearTimeout:(id:number)=>{if(timers[id-1])timers[id-1].cleared=true;},
    require:(name:string)=> name === 'electron' ? electron : require(name)});
  let authenticated = true;
  const nativeWindows = module.exports.setupNativeAppWindows({isTrusted:(event:any)=>event.trusted,mayRead:()=>authenticated,getMainWindow:()=>null,preload:'/preload.js',rendererFile:'/index.html'});
  const call = (name: string, event: any, ...args: any[]) => handlers.get(name)!(event,...args);
  await assert.rejects(() => call(NATIVE_APP_OPEN,{trusted:false},'/tags'));
  for (const href of ['//evil.test','https://evil.test','/native-app?x=1','/a\\b','/a\n']) assert.equal(internalAppHref(href),null);
  assert.equal(internalAppHref('/tags?tag=1'),'/tags?tag=1');
  const trusted = {trusted:true};
  const id = await call(NATIVE_APP_OPEN,trusted,'/tags');
  assert.equal(windows.length,1); assert.ok(windows[0].options.x < 0);
  assert.equal(windows[0].options.webPreferences.sandbox,true);
  assert.equal(await call(NATIVE_APP_OPEN,trusted,'/tags'),id); assert.equal(windows.length,1);
  const own = {trusted:true,sender:windows[0].webContents};
  assert.equal(await call(NATIVE_APP_LOCATION,trusted,id,'/equipment'),false);
  assert.equal(await call(NATIVE_APP_LOCATION,own,id,'/equipment'),true);
  assert.equal((await call(NATIVE_APP_LIST,trusted))[0].href,'/equipment');
  assert.equal(await call(NATIVE_APP_OPEN,trusted,'/equipment'),id);
  windows[0].close(); assert.equal(windows[0].destroyed,false);
  assert.equal(await call(NATIVE_APP_CLOSE_REPLY,trusted,id,true),false);
  assert.equal(await call(NATIVE_APP_CLOSE_REPLY,own,id,false),false); assert.equal(windows[0].destroyed,false);
  windows[0].close(); authenticated=false;
  assert.equal(await call(NATIVE_APP_CLOSE_REPLY,own,id,true),true); assert.equal(windows[0].destroyed,true);
  authenticated=true;
  const secondId = await call(NATIVE_APP_OPEN,trusted,'/projects');
  const second = windows[1]; const secondOwn = {trusted:true,sender:second.webContents};
  const preflight = nativeWindows.approveCloseAll();
  assert.equal(second.destroyed,false, 'Предварительная проверка не уничтожает окно приложения');
  assert.equal(await call(NATIVE_APP_CLOSE_REPLY,secondOwn,secondId,true),true);
  assert.equal(await preflight,true);
  assert.equal(second.destroyed,false, 'Ответ стража подтверждает выход обновления, оставляя окно живым');
  const thirdId = await call(NATIVE_APP_OPEN,trusted,'/notes');
  const third = windows[2]; third.close();
  const timeout = timers.find(timer=>!timer.cleared)!; timeout.cleared=true; timeout.callback();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(dialogs,1, 'Молчание renderer показывает запасной системный вопрос');
  assert.equal(third.destroyed,false, 'Запасной вопрос по умолчанию оставляет окно открытым');
  third.close();
  assert.equal(await call(NATIVE_APP_CLOSE_REPLY,{trusted:true,sender:third.webContents},thirdId,true),true);
  assert.equal(third.destroyed,true);
  console.log('✓ Native windows validate origins, preserve identity on navigation, choose cursor monitor, and wait for their own close guard even after session expiry');
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
