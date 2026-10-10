/** Настоящий GenOffice Docs внутри WindowsFileHost: вставка Flux, сохранение и закрытие. */
import { createServer } from 'vite';
import { makeDocx } from './officeHarness';

const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const check = (name: string, value: unknown, detail?: unknown) => {
  if (!value) throw new Error(`✗ ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  console.log(`✓ ${name}`);
};

async function main() {
  const vite = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/*'] } } });
  await vite.listen();
  const address = vite.httpServer?.address();
  const base = address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : '';
  if (!base) throw new Error('Не получен адрес тестового сервера');
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1240, height: 900 } });
    const errors: string[] = [];
    const officeNavigations: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('framenavigated', frame => { if (frame.url().includes('/genoffice/docs/index.html')) officeNavigations.push(frame.url()); });
    await page.route('**/api/projects/local-project/tags', route => route.fulfill({ json: { tags: [{ id: 'tag-42', identifier: 'TAG-42', name: 'Насос' }] } }));
    const docx = await makeDocx();
    await page.addInitScript((base64: string) => {
      (window as any).__fixtureDocxBase64 = base64;
    }, docx.toString('base64'));
    await page.goto(`${base}/scripts/fixtures/windows-file-docx.html`);
    const iframe = page.locator('iframe[title="Flux Office — Документ"]');
    await iframe.waitFor({ timeout: 20000 });
    const child = page.frames().find(frame => frame.url().includes('/genoffice/docs/index.html'));
    if (!child) throw new Error(`Не найдено настоящее окно GenOffice Docs: ${JSON.stringify(page.frames().map(frame => frame.url()))}`);
    const editor = child.locator('.ProseMirror').first();
    await editor.waitFor({ timeout: 45000 });
    await page.getByText('Открывается локальный редактор…').waitFor({ state: 'detached', timeout: 45000 });
    const initialBody = await editor.innerText();
    check('настоящий DOCX открыт в GenOffice', initialBody.includes('Проба Flux Office') && initialBody.includes('Вторая строка бланка'), initialBody);
    const initial = await iframe.evaluate(el => {
      const node = el as HTMLIFrameElement, rect = node.getBoundingClientRect();
      (window as any).__initialOfficeFrame = node;
      return { rect: [rect.width, rect.height], body: node.contentDocument?.body?.innerText.slice(0, 160), src: node.getAttribute('src') };
    });
    const frameToken = await child.evaluate(() => { (window as any).__localDocxFrameToken = crypto.randomUUID(); return (window as any).__localDocxFrameToken; });
    check('iframe готов и имеет ненулевой размер', initial.rect[0] > 0 && initial.rect[1] > 0, initial);
    await child.evaluate(() => window.parent.postMessage({ flux: 'office', op: 'flux:open-panel' }, location.origin));
    await page.getByRole('button', { name: 'Вставить все' }).waitFor({ timeout: 15000 });
    await page.evaluate(() => {
      (window as any).__insertEvents = [];
      window.addEventListener('message', (event) => { if (event.data?.flux === 'office') (window as any).__insertEvents.push(event.data.op); });
    });
    await page.getByRole('button', { name: 'Вставить все' }).click();
    await page.getByRole('status').filter({ hasText: 'Таблица вставлена' }).waitFor({ timeout: 15000 });
    await page.waitForFunction(() => {
      const frame = document.querySelector('iframe[title="Flux Office — Документ"]') as HTMLIFrameElement | null;
      return (frame?.contentDocument?.body?.innerText || '').includes('TAG-42');
    }, null, { timeout: 15000 });
    const afterInsert = await iframe.evaluate(el => {
      const node = el as HTMLIFrameElement, rect = node.getBoundingClientRect();
      return { sameNode: node === (window as any).__initialOfficeFrame, rect: [rect.width, rect.height], body: node.contentDocument?.body?.innerText.slice(-260) };
    });
    const tokenAfterInsert = await page.frames().find(frame => frame.url().includes('/genoffice/docs/index.html'))?.evaluate(() => (window as any).__localDocxFrameToken);
    check('после вставки таблицы документ и iframe остаются на месте', afterInsert.sameNode && tokenAfterInsert === frameToken && afterInsert.rect[0] > 0 && afterInsert.rect[1] > 0 && /TAG-42/.test(afterInsert.body || ''), { ...afterInsert, tokenAfterInsert });
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.waitForFunction(() => (window as any).__disk?.calls.some((call: any) => call.action === 'write'), null, { timeout: 45000 });
    const saved = await iframe.evaluate(el => {
      const node = el as HTMLIFrameElement, rect = node.getBoundingClientRect();
      return { sameNode: node === (window as any).__initialOfficeFrame, rect: [rect.width, rect.height], body: node.contentDocument?.body?.innerText.slice(-260) };
    });
    const tokenAfterSave = await page.frames().find(frame => frame.url().includes('/genoffice/docs/index.html'))?.evaluate(() => (window as any).__localDocxFrameToken);
    check('после сохранения документ не стал пустым и iframe не перезапустился', saved.sameNode && tokenAfterSave === frameToken && saved.rect[0] > 0 && saved.rect[1] > 0 && /TAG-42/.test(saved.body || ''), { ...saved, tokenAfterSave });
    const currentDisk = await page.evaluate(() => ({ calls: (window as any).__disk.calls, bytes: (window as any).__disk.content.base64 }));
    check('сохранённые DOCX-байты прошли через локальный мост', currentDisk.calls.some((call: any) => call.action === 'write') && currentDisk.bytes.length > 1000);
    const lifecycle = await page.evaluate(() => (window as any).__insertEvents);
    check('вставка и сохранение не перезапускали документ во фрейме', officeNavigations.length === 1, officeNavigations);
    check('после сохранения локальное окно можно закрыть без потери правок', await page.evaluate(() => (window as any).__tryCloseAfterIframeCheck()), lifecycle);
    check('ошибок браузера нет', errors.length === 0, errors);
  } finally { await browser.close(); await vite.close(); }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
