/** Измеряет iframe живого WindowsFileHost после вставки Flux и сохранения для DOCX и XLSX. */
import { createServer } from 'vite';

const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const check = (name: string, condition: unknown, details?: unknown) => {
  if (!condition) throw new Error(`✗ ${name}${details === undefined ? '' : `: ${JSON.stringify(details)}`}`);
  console.log(`✓ ${name}`);
};

const frameHtml = (app: 'docs' | 'sheets') => `<!doctype html><html><head><style>
html,body{height:100%;margin:0;font:14px sans-serif}.ribbon{height:42px;border-bottom:1px solid #bbb;display:flex;align-items:center;padding:0 12px}
.canvas{height:calc(100% - 43px);overflow:auto;padding:18px;background:#fff;color:#222}
</style></head><body><header class="ribbon">${app === 'docs' ? 'Документ' : 'Таблица'}</header><main class="canvas" id="canvas">Исходное содержимое</main><script>
window.__frameInstance=Math.random().toString(36).slice(2);window.__frameReady=0;window.__frameLoads=0;window.__dirty=false;
window.addEventListener('load',()=>window.__frameLoads++);
const send=(op,payload)=>window.parent.postMessage({flux:'office',op,payload},location.origin);
const dirty=()=>{window.__dirty=true;${app === 'sheets' ? "send('ipc-send',{channel:'workbook:pending-edits',args:[1]});" : ''}};
window.addEventListener('message',event=>{
 if(event.source!==window.parent||event.data?.flux!=='office')return;const m=event.data;
 if(m.event==='closeCheck')send('closeCheck',{dirty:true});
 if(m.event==='closeSave'){
  send('save',{bytes:[80,75,1,2],fixture:true});
  const reply=event=>{if(event.source!==window.parent||event.data?.flux!=='office'||event.data.reply===undefined)return;window.removeEventListener('message',reply);send('closeSaveResult',event.data.error?false:true);};window.addEventListener('message',reply);
 }
 if(m.event==='insertTable'){
  dirty();document.getElementById('canvas').textContent='TAG-42 · Насос';send('flux:table-inserted',{ok:true});
 }
 if(m.event==='ipc'&&m.payload?.channel==='flux:insert-table'){
  const command=m.payload.args?.[0]||{};dirty();document.getElementById('canvas').textContent='TAG-42 · Насос';
  send('ipc-send',{channel:'flux:command-result',args:[{id:command.id,ok:true}]});
 }
 if(m.event==='ipc'&&m.payload?.channel==='workbook:close-save-request'){
  window.__dirty=false;window.parent.postMessage({flux:'office',op:'ipc-send',payload:{channel:'workbook:close-save-result',args:[true]}},location.origin);
 }
});
send('hello',{});setTimeout(()=>{window.__frameReady++;${app === 'sheets' ? "send('ipc-send',{channel:'flux:editor-ready',args:[{app:'sheets'}]});" : "send('flux:editor-ready',{});"}},60);
</script></body></html>`;

async function main() {
  const vite = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/*'] } } });
  await vite.listen();
  const address = vite.httpServer?.address();
  const base = address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : '';
  if (!base) throw new Error('Не получен адрес тестового сервера');
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    for (const app of ['docs', 'sheets'] as const) {
      const page = await browser.newPage({ viewport: { width: 1120, height: 760 } });
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route(`**/genoffice/${app}/index.html`, route => route.fulfill({ contentType: 'text/html', body: frameHtml(app) }));
      await page.route('**/api/projects/local-project/tags', route => route.fulfill({ json: { tags: [{ id: 'tag-42', identifier: 'TAG-42', name: 'Насос' }] } }));
      await page.goto(`${base}/scripts/fixtures/windows-file-office-lifecycle.html?app=${app}`);
      const frame = page.locator(`iframe[title="Flux Office — ${app === 'docs' ? 'Документ' : 'Таблица'}"]`);
      await frame.waitFor();
      await page.getByText('Открывается локальный редактор…').waitFor({ state: 'detached', timeout: 10000 });
      const child = page.frames().find(item => item.url().includes(`/genoffice/${app}/index.html`));
      if (!child) throw new Error(`${app}: не найден iframe редактора`);
      await child.evaluate(() => window.parent.postMessage({ flux: 'office', op: 'flux:open-panel' }, location.origin));
      await page.getByRole('complementary', { name: 'Flux' }).waitFor();
      await page.getByRole('button', { name: 'Вставить все' }).waitFor({ timeout: 10000 });
      const initial = await frame.evaluate(el => {
        const node = el as HTMLIFrameElement, r = node.getBoundingClientRect(), s = getComputedStyle(node);
        const win = node.contentWindow as any;
        (window.parent as any).__savedIframeNode = node;
        return { instance: win.__frameInstance, ready: win.__frameReady, loads: win.__frameLoads, rect: [r.width, r.height], display: s.display, visibility: s.visibility };
      });
      check(`${app}: перед действием iframe загрузился и имеет площадь`, initial.ready === 1 && initial.loads === 1 && initial.rect[0] > 0 && initial.rect[1] > 0 && initial.display !== 'none' && initial.visibility !== 'hidden', initial);
      await page.getByRole('button', { name: 'Вставить все' }).click();
      await page.getByRole('status').filter({ hasText: 'Таблица вставлена' }).waitFor({ timeout: 10000 });
      await page.waitForFunction(() => {
        const el = document.querySelector('iframe') as HTMLIFrameElement | null;
        return (el?.contentDocument?.querySelector('#canvas')?.textContent || '').includes('TAG-42');
      });
      const afterInsert = await frame.evaluate(el => {
        const node = el as HTMLIFrameElement, r = node.getBoundingClientRect(), s = getComputedStyle(node);
        return { sameNode: node === (window.parent as any).__savedIframeNode, instance: (node.contentWindow as any).__frameInstance, ready: (node.contentWindow as any).__frameReady, loads: (node.contentWindow as any).__frameLoads, rect: [r.width, r.height], display: s.display, visibility: s.visibility, canvas: node.contentDocument?.querySelector('#canvas')?.textContent };
      });
      check(`${app}: вставка сохранила iframe и данные редактора`, afterInsert.sameNode && afterInsert.instance === initial.instance && afterInsert.ready === 1 && afterInsert.loads === 1 && afterInsert.canvas?.includes('TAG-42'), afterInsert);
      await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
      if (app === 'docs') await page.waitForFunction(() => (window as any).__lifecycle.calls.some((x: any) => x.area === 'files' && x.request.action === 'write'));
      else await page.waitForFunction(() => (window as any).__lifecycle.nativeCalls.some((x: any) => x.request.action === 'send' && x.request.channel === 'workbook:close-save-result'));
      const afterSave = await frame.evaluate(el => {
        const node = el as HTMLIFrameElement, r = node.getBoundingClientRect(), s = getComputedStyle(node);
        return { sameNode: node === (window.parent as any).__savedIframeNode, instance: (node.contentWindow as any).__frameInstance, ready: (node.contentWindow as any).__frameReady, loads: (node.contentWindow as any).__frameLoads, rect: [r.width, r.height], display: s.display, visibility: s.visibility, canvas: node.contentDocument?.querySelector('#canvas')?.textContent };
      });
      check(`${app}: сохранение оставило iframe и геометрию редактора`, afterSave.sameNode && afterSave.instance === initial.instance && afterSave.ready === 1 && afterSave.loads === 1 && afterSave.rect[0] > 0 && afterSave.rect[1] > 0 && afterSave.display !== 'none' && afterSave.visibility !== 'hidden' && afterSave.canvas?.includes('TAG-42'), afterSave);
      check(`${app}: оболочка сохранила панель и файл`, await page.getByText('Только в Flux').isVisible() && await page.getByRole('button', { name: 'Сохранить', exact: true }).isVisible());
      check(`${app}: страница не выдала ошибок`, errors.length === 0, errors);
      await page.close();
    }
  } finally { await browser.close(); await vite.close(); }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
