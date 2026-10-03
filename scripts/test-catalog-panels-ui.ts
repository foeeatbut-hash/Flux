/** Проверка повторного сохранения и конфликтов двух редакторских панелей. API — отдельная подмена. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '../node_modules/playwright-core/index.mjs';
import { seedCatalog } from '../catalog/seed';

async function main() {
  const root = process.cwd(); const port = 4196;
  const vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--config', path.join(root, 'scripts/fixtures/catalog-ui/vite.config.ts'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore' });
  const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const catalog = seedCatalog();
  const versioned = (list: any[]) => list.map(d => ({ ...d, _publishedHash: 'fixture-published-hash' }));
  const records: Record<string, any[]> = { component: versioned(catalog.components), tagRule: versioned(catalog.tagRules) };
  const errors: string[] = []; const requests: Array<{ entity: string; document: any; status: number }> = [];
  let revision = 0;
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('409')) errors.push(m.text()); });
  await page.route('**/api/**', async route => {
    const req = route.request(); const url = new URL(req.url()); let body: any = {}; let status = 200;
    if (url.pathname === '/api/catalog') body = { ...catalog, meta: {}, stamp: 'fixture' };
    else if (url.pathname === '/api/catalog/workspace') body = { catalog: { ...catalog, components: records.component, tagRules: records.tagRule }, drafts: [], rights: { edit: true, import: true, publish: true }, grants: [] };
    else if (url.pathname === '/api/catalog/stamp') body = { stamp: 'fixture' };
    else if (url.pathname === '/api/catalog/learn') body = { learned: [] };
    else if (req.method() === 'PUT' && /^\/api\/catalog\/(component|tagRule)\//.test(url.pathname)) {
      const entity = url.pathname.split('/')[3]; const doc = req.postDataJSON(); const current = records[entity].find(d => d.id === doc.id);
      if (current?._draftVersion && current._draftVersion !== doc._draftVersion) { status = 409; body = { error: 'Черновик изменён коллегой' }; }
      else {
        const saved = { ...doc, _draftVersion: `fixture-draft-${++revision}` }; delete saved._publishedHash;
        records[entity] = records[entity].map(d => d.id === doc.id ? saved : d); body = { ok: true, revision: saved._draftVersion };
      }
      requests.push({ entity, document: doc, status });
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const until = async (condition: () => boolean) => { for (let i = 0; i < 80; i++) { if (condition()) return; await delay(100); } throw new Error('Не дождались тестового запроса'); };
  const remote = async (entity: string, id: string, patch: any) => {
    records[entity] = records[entity].map(d => d.id === id ? { ...d, ...patch, _draftVersion: `remote-${++revision}` } : d);
    await page.evaluate(() => window.dispatchEvent(new Event('catalog:workspace-changed')));
  };
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}`)).ok) break; } catch {} await delay(200); }
    await page.goto(`http://127.0.0.1:${port}`);
    await page.getByRole('button', { name: 'Владелец', exact: true }).click();
    await page.getByRole('button', { name: 'Управление каталогом' }).click();
    const tools = page.getByRole('combobox', { name: 'Инструмент редактора' });
    await tools.selectOption('components');
    const row = page.locator('tr[role="button"]').first(); const firstCode = (await row.locator('td').first().innerText()).trim();
    const component = records.component.find(d => d.code === firstCode)!; await row.click();
    const title = page.getByRole('textbox', { name: 'Название модели', exact: true });
    console.log('Компонент: первое сохранение');
    await title.fill('Первое сохранение'); await page.getByRole('button', { name: 'Сохранить', exact: true }).click(); await until(() => requests.length === 1);
    await title.fill('Второе сохранение'); await page.getByRole('button', { name: 'Сохранить', exact: true }).click(); await until(() => requests.length === 2);
    assert.equal(requests[1].status, 200); assert.ok(requests[1].document._draftVersion, 'второе сохранение отправляет ревизию первого');
    await title.fill('Моя несохранённая правка'); const originalToken = records.component.find(d => d.id === component.id)._draftVersion;
    await remote('component', component.id, { title: { ru: 'Правка коллеги' } });
    await page.getByRole('alert').filter({ hasText: 'Ваши значения сохранены' }).waitFor();
    assert.equal(await title.inputValue(), 'Моя несохранённая правка');
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click(); await until(() => requests.length === 3);
    assert.equal(requests[2].document._draftVersion, originalToken); assert.equal(requests[2].status, 409, 'грязная форма не принимает чужую свежую CAS-ревизию');
    console.log('Компонент: повтор и конфликт пройдены; правила тегов');
    await tools.selectOption('tags');
    const tagRow = page.locator('tbody tr').first(); const tagInputs = tagRow.locator('input');
    const tagCode = await tagInputs.nth(0).inputValue(); const rule = records.tagRule.find(d => d.code === tagCode)!;
    await tagInputs.nth(1).fill('Первое правило'); await page.getByRole('button', { name: 'Сохранить', exact: true }).click(); await until(() => requests.length === 4);
    console.log('Правила тегов: первое сохранение прошло');
    await tagInputs.nth(1).fill('Второе правило'); await page.getByRole('button', { name: 'Сохранить', exact: true }).click(); await until(() => requests.length === 5);
    assert.equal(requests[4].status, 200); assert.ok(requests[4].document._draftVersion);
    await delay(200); await remote('tagRule', rule.id, { label: { ru: 'Новые данные коллеги' } });
    await page.waitForFunction(() => [...document.querySelectorAll('input')].some(e => e.value === 'Новые данные коллеги'));
    assert.equal(await tagInputs.nth(1).inputValue(), 'Новые данные коллеги', 'чистая форма принимает целую запись, а не только токен');
    await tagInputs.nth(1).fill('Моя правка правила'); const tagToken = records.tagRule.find(d => d.id === rule.id)._draftVersion;
    await remote('tagRule', rule.id, { label: { ru: 'Ещё одна правка коллеги' } });
    await page.getByRole('alert').filter({ hasText: 'Ваши значения сохранены' }).waitFor();
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click(); await until(() => requests.length === 6);
    assert.equal(requests[5].document._draftVersion, tagToken); assert.equal(requests[5].status, 409);
    assert.deepEqual(errors, [], 'включая отсутствие бесконечного effect/Maximum update depth');
    console.log('Редакторские панели: повторные сохранения, clean refresh и dirty CAS-конфликты прошли');
  } catch (e) { console.error('Тестовые запросы:', JSON.stringify(requests.map(r => ({ entity: r.entity, status: r.status, version: r.document._draftVersion })))); await page.screenshot({ path: '/tmp/catalog-panels-ui-failure.png' }); throw e; }
  finally { await browser.close(); vite.kill('SIGTERM'); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
