import { spawn } from 'node:child_process';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import osaContent from '../catalog/packs/source-data/osa.json';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '../node_modules/playwright-core/index.mjs';
import { seedCatalog } from '../catalog/seed';
import { veza2026Pack } from '../catalog/packs/veza2026';

const root = process.cwd();
const fixture = path.join(root, 'scripts/fixtures/catalog-ui');
const port = 4196;
const url = `http://127.0.0.1:${port}`;
const published = seedCatalog();
const merge = <T extends { id: string }>(current: T[], incoming: T[]) => {
  const rows = new Map(current.map((row) => [row.id, row]));
  incoming.forEach((row) => rows.set(row.id, { ...rows.get(row.id), ...row }));
  return [...rows.values()];
};
for (const key of ['classes', 'manufacturers', 'families', 'components', 'tagRules'] as const) {
  (published[key] as any) = merge(published[key] as any, veza2026Pack[key] as any);
}
const osaReader = published.families.find(f => f.id === 'veza-osa-300')!;
osaReader.sections = [{ id: 'fixture-osa-content', title: 'ОСА 040: подбор, размеры и масса', kind: 'selection', text: osaContent.pages[12].text, source: { ...osaContent.pages[12].source, assetId: '11111111-1111-1111-1111-111111111111' } }];
const draftOnly = {
  ...published.families.find((f) => f.code === 'ОСА 300')!,
  id: 'ui-draft-only', code: 'DRAFT-ONLY-UI', title: { ru: 'Только черновик интерфейса' },
  status: 'draft', params: [], positions: [{ key: 'article', label: { ru: 'Артикул' }, formats: ['DRAFT-ONLY-UI'] }],
};
const ownerDraft = {
  entity: 'family', id: 'ui-family-draft', operation: 'save', document: { ...draftOnly, title: { ru: 'Новая версия черновика' } },
  before: { ...draftOnly, title: { ru: 'Старая версия черновика' } }, baseHash: 'published-hash',
  revision: 'draft-r1', state: 'review', authorId: 'author-fixture', reviewedById: 'reviewer-fixture', updatedAt: '2026-10-03T12:00:00Z',
};
const list = { id: 'fixture-list', projectId: 'catalog-ui-project', classId: 'fan', name: 'Вентиляторы · тест', header: {}, orderNos: {}, templateId: null, lang: 'ru', items: 1, qty: 1, updatedAt: '2026-10-03T12:00:00Z' };
const builderItems = [{ id: 'fixture-item', classId: 'fan', tags: [], qty: 1, familyId: 'veza-osa-300', values: { fanSize: '050', wheelMod: 'Б', wheelIndex: '50', execution: 'Н', motorIndex: '00400', poles: '2', climate: 'У1', body: '02' }, designation: 'ОСА300-050/Б-50-Н-00400/2-У1-02', status: 'matched', sort: 1 }];
let accessSaved = 0;
let policyRequired = true;
let policyWrites = 0;
const expectedHttp: string[] = [];

async function main() {
const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--config', path.join(fixture, 'vite.config.ts'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'ignore' });
const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on('requestfailed', (r) => errors.push(`requestfailed:${r.url()}:${r.failure()?.errorText}`));
page.on('pageerror', (e) => errors.push(`pageerror:${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('403')) errors.push(`console:${m.text()}`); });
page.on('response', (r) => { if (r.status() >= 400) { const p = new URL(r.url()).pathname; if (r.status() === 403 && p === '/api/catalog/import') expectedHttp.push(`${r.status()} ${p}`); else errors.push(`http${r.status()}:${p}`); } });
page.route('**/api/**', async (route) => {
  const req = route.request(); const p = new URL(req.url()).pathname; const method = req.method();
  if (p === '/api/catalog/assets/11111111-1111-1111-1111-111111111111') { await route.fulfill({ status: 200, contentType: 'application/pdf', path: path.join(root, 'public/catalog-documents/osa.pdf') }); return; }
  let body: any = {};
  if (p === '/api/catalog' && method === 'GET') {
    const empty = await page.evaluate(() => !!(window as any).__catalogFixtureEmpty);
    body = { ...(empty ? { classes: [], manufacturers: [], families: [], components: [], tagRules: [] } : published), meta: {}, stamp: empty ? 'published-fixture-empty' : 'published-fixture-r1' };
  }
  else if (p === '/api/catalog/stamp') body = { stamp: await page.evaluate(() => (window as any).__catalogFixtureEmpty ? 'published-fixture-empty' : 'published-fixture-r1') };
  else if (p === '/api/catalog/learn') body = { learned: [] };
  else if (p === '/api/blank-templates') body = { templates: [] };
  else if (p === '/api/catalog/workspace' && method === 'GET') {
    const role = await page.evaluate(() => (window as any).__catalogFixtureRole || 'reader');
    const remote = await page.evaluate(() => !!(window as any).__catalogFixtureRemote);
    let workspaceFamilies = [...published.families, draftOnly];
    if (remote) workspaceFamilies = workspaceFamilies.map((family) => family.id === 'veza-osa-300' ? { ...family, title: { ru: 'Удалённое обновление от коллеги' }, _draftVersion: 'draft-r2' } as any : family);
    body = { catalog: { ...published, families: workspaceFamilies }, drafts: role === 'owner' ? [ownerDraft] : [], rights: role === 'owner' ? { edit: true, import: true, publish: true } : { edit: false, import: false, publish: false }, grants: [], policy: { requireSecondReview: policyRequired } };
  }
  else if (p === '/api/catalog/policy' && method === 'PUT') { policyRequired = !!req.postDataJSON().requireSecondReview; policyWrites++; await page.evaluate((count) => { (window as any).__catalogPolicyWrites = count; }, policyWrites); body = { ok: true }; }
  else if (p === '/api/catalog/access' && method === 'GET') body = { users: [{ id: 'engineer-1', name: 'Инженер вентиляции', role: 'ENGINEER_VENT' }], grants: [{ userId: 'engineer-1', action: 'edit', classId: 'valve' }], version: 'access-r1' };
  else if (p === '/api/catalog/access' && method === 'PUT') { accessSaved++; body = { ok: true, version: 'access-r2' }; }
  else if (p === '/api/catalog/import' && method === 'POST') {
    const payload = req.postDataJSON();
    if (payload.mode === 'plan') body = { plan: [{ entity: 'family', id: 'osa-300', code: 'ОСА 300', action: 'update' }, { entity: 'family', id: 'osa-301', code: 'ОСА 301', action: 'same' }], preview: 'fixture-plan' };
    else { expectedHttp.push('403 apply refused'); await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Импорт в черновики отклонён тестовой политикой доступа' }) }); return; }
  }
  else if (p === '/api/builder/lists' && method === 'GET') body = { lists: await page.evaluate(() => (window as any).__catalogFixtureEmpty ? [] : null).then((empty) => empty === null ? [list] : empty ? [] : [list]) };
  else if (p === '/api/builder/lists/fixture-list') body = { list, items: builderItems };
  else if (p.startsWith('/api/builder/')) body = { ok: true, items: builderItems, list, batchId: 'fixture-batch' };
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
});

async function waitServer() {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`vite exited ${server.exitCode}`);
    try { const response = await fetch(url); if (response.ok) return; } catch { /* startup */ }
    await delay(200);
  }
  throw new Error('Vite fixture did not start');
}
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
async function checkGeometry(label: string, width: number) {
  const value = await page.evaluate(() => {
    const app = document.querySelector('#root > div') as HTMLElement | null;
    const visibleOffscreen = [...(app?.querySelectorAll('button,input,select,[role="tab"]') || [])].filter((el) => {
      const r = el.getBoundingClientRect(); return r.width > 0 && (r.left < -1 || r.right > innerWidth + 1);
    }).map((el) => (el as HTMLElement).innerText || (el as HTMLInputElement).ariaLabel || el.tagName);
    return { viewport: innerWidth, bodyW: document.documentElement.scrollWidth, bodyH: document.documentElement.scrollHeight, appW: app?.clientWidth || 0, appScrollW: app?.scrollWidth || 0, visibleOffscreen };
  });
  assert(value.bodyW <= width + 1 && value.appScrollW <= value.appW + 4 && !value.visibleOffscreen.length, `${label} overflow: ${JSON.stringify(value)}`);
  return value;
}
async function setTheme(theme: string) { await page.evaluate((t) => document.documentElement.classList.toggle('dark', t === 'dark'), theme); }
async function shot(screen: string, width: number, theme: string) {
  await page.setViewportSize({ width, height: 1000 }); await setTheme(theme); await page.waitForTimeout(200);
  const geom = await checkGeometry(`${screen}/${theme}`, width);
  const p = `/tmp/catalog-ui-${screen}-${width}-${theme}.png`; await page.screenshot({ path: p, fullPage: false });
  return { width, theme, screenshot: p, geometry: geom };
}

try {
  await waitServer();
  await page.goto(url); await page.getByRole('navigation', { name: 'Проверка экранов' }).waitFor();
  await page.waitForTimeout(1200);
  await page.getByRole('textbox', { name: 'Поиск моделей' }).fill('ОСА 300');
  if (!await page.getByText('ОСА 300', { exact: false }).count()) throw new Error(`catalog family not rendered; body=${(await page.locator('body').innerText()).slice(0,1800)} errors=${errors.join(';')}`);
  assert(!(await page.getByText('Только черновик интерфейса', { exact: false }).count()), 'viewer rendered workspace-only draft data');
  assert(await page.getByRole('button', { name: 'Управление каталогом' }).count() === 0, 'reader unexpectedly sees management controls');
  assert(await page.getByText('Требовать вторую проверку семейства или компонента', { exact: true }).count() === 0, 'viewer unexpectedly sees publication policy controls');
  await page.getByRole('button', { name: /ОСА300/ }).first().click();
  assert(await page.getByText('осевой', { exact: true }).count() > 0, 'choice facts still render raw codes instead of Russian labels');
  await page.waitForFunction(() => { const canvas = document.querySelector('canvas'); return canvas && canvas.width > 500 && canvas.height > 500; });
  await page.waitForTimeout(500);
  assert(!await page.getByText('Открываем иллюстрацию…', { exact: true }).count(), 'vector PDF illustration did not render');
  const screenshots: any[] = [];
  for (const width of [1024, 1440]) for (const theme of ['light', 'dark']) screenshots.push(await shot('reader', width, theme));
  await page.getByRole('button', { name: 'Характеристики', exact: true }).click();
  assert(await page.getByText('Типоразмер', { exact: false }).count(), 'published table characteristics are missing');
  await page.getByRole('button', { name: 'Маркировка', exact: true }).click();
  await page.getByRole('button', { name: 'Устройство и применение', exact: true }).click();
  assert(!await page.getByText('Файл ещё не загружен', { exact: true }).count(), 'reader exposes technical upload status');
  assert(!await page.getByText('печатная стр.', { exact: false }).count(), 'reader exposes source page references');
  await page.getByRole('button', { name: 'Сообщить', exact: true }).first().click();
  const issueDialog = page.getByRole('dialog', { name: 'Сообщить о неточности' });
  await issueDialog.waitFor();
  assert(await issueDialog.getByText('veza-osa-300-availability/040/fanSize', { exact: true }).count(), 'table report is missing stable table/row/column path');
  assert(await issueDialog.getByText('040', { exact: true }).count(), 'table report is missing current cell value');
  assert(!await issueDialog.getByText('ОСА 300/301, осевые вентиляторы.pdf', { exact: false }).count(), 'issue dialog exposes internal PDF provenance');
  await issueDialog.getByRole('button', { name: 'Отмена' }).click();
  await page.getByRole('button', { name: 'Добавить к сравнению', exact: true }).first().click();
  assert(await page.getByText(/Сравнение/).count(), 'model comparison panel did not open');

  await page.getByRole('button', { name: 'Владелец', exact: true }).click();
  await page.getByRole('button', { name: 'Управление каталогом' }).click();
  await page.getByText('Каталог оборудования', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Публикации' }).click();
  const policyToggle = page.getByRole('checkbox', { name: /Требовать вторую проверку семейства или компонента/ });
  assert(await policyToggle.isVisible(), 'owner cannot access second-review publication policy');
  assert(await policyToggle.isChecked(), 'workspace second-review policy was not reflected in the owner view');
  const changesButton = page.getByRole('button', { name: /^Показать изменения/ }).first();
  await changesButton.click();
  assert(await page.getByText('Название', { exact: false }).count() > 0, 'expanded draft diff has no human-readable changed field');
  assert(await page.getByText('Старая версия черновика', { exact: true }).count() > 0, 'expanded draft diff omits previous value');
  assert(await page.getByText('Новая версия черновика', { exact: true }).count() > 0, 'expanded draft diff omits proposed value');
  await policyToggle.click();
  await page.waitForFunction(() => (window as any).__catalogPolicyWrites === 1);
  await page.waitForFunction(() => { const input = document.querySelector('input[type="checkbox"]') as HTMLInputElement | null; return input?.checked === false; });
  assert(!(await policyToggle.isChecked()), 'owner policy toggle did not save the disabled state');
  await policyToggle.click();
  await page.waitForFunction(() => (window as any).__catalogPolicyWrites === 2);
  await page.waitForFunction(() => { const input = document.querySelector('input[type="checkbox"]') as HTMLInputElement | null; return input?.checked === true; });
  assert(policyWrites === 2, 'owner policy control did not persist both changes');
  assert(await policyToggle.isChecked(), 'owner policy control did not reflect the saved policy');
  for (const width of [1024, 1440]) for (const theme of ['light', 'dark']) screenshots.push(await shot('publications', width, theme));
  await page.getByRole('button', { name: 'Каталоги НЕМАН и ВЕЗА: предпросмотр' }).click();
  await page.getByRole('heading', { name: 'Предпросмотр справочника НЕМАН и ВЕЗА' }).waitFor();
  await page.getByRole('button', { name: 'Сохранить черновики' }).click();
  await page.getByRole('alert').filter({ hasText: 'Импорт в черновики отклонён' }).waitFor();
  assert(expectedHttp.includes('403 apply refused'), 'refused import was not exercised');
  await page.getByRole('button', { name: 'Доступ сотрудников' }).click();
  await page.getByRole('heading', { name: 'Права каталога' }).waitFor();
  await page.getByRole('button', { name: 'Добавить правило' }).click();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Права каталога сохранены' }).waitFor();
  assert(accessSaved === 1, 'access editor did not persist its grant edit');

  await page.getByRole('button', { name: 'Редактор', exact: true }).click();
  await page.getByRole('combobox', { name: 'Инструмент редактора' }).selectOption('families');
  await page.getByRole('combobox', { name: 'Тип оборудования' }).selectOption('fan');
  await page.getByRole('button', { name: /ОСА300/ }).first().click();
  await page.getByRole('button', { name: 'Источники и таблицы', exact: true }).click();
  assert(await page.getByText('Таблицы характеристик', { exact: true }).count(), 'table source editor missing');
  assert(await page.getByText('Файл ещё не загружен.', { exact: true }).count(), 'source editor did not show unuploaded state');
  const tableNames = await page.getByRole('textbox', { name: 'Название таблицы' }).evaluateAll((items) => items.map((item) => (item as HTMLInputElement).value));
  assert(tableNames.some((name) => name.includes('ОСА 300')), `table source editor did not load named table: ${tableNames.join(' | ')}`);
  assert(await page.getByRole('checkbox', { name: 'Строка сверена с источником' }).count() > 0, 'verified row control missing from table editor');
  await page.getByRole('button', { name: 'Обзор', exact: true }).last().click();
  const titleField = page.getByRole('textbox', { name: 'Название', exact: true });
  await titleField.fill('Моя несохранённая правка');
  await page.evaluate(() => { (window as any).__catalogFixtureRemote = true; window.dispatchEvent(new Event('catalog:workspace-changed')); });
  await page.getByRole('alert').filter({ hasText: 'Запись изменилась в каталоге' }).waitFor();
  assert(await titleField.inputValue() === 'Моя несохранённая правка', 'external workspace update overwrote unsaved local editor data');
  await page.getByText('Сравнить версии', { exact: true }).click();
  assert(await page.getByText('Удалённое обновление от коллеги', { exact: true }).count(), 'editor conflict comparison omitted latest workspace version');
  assert(await page.getByText('Моя несохранённая правка', { exact: true }).count(), 'editor conflict comparison omitted local unsaved version');

  await page.getByRole('button', { name: 'Конструктор', exact: true }).click();
  await page.getByText('Вентиляторы · тест', { exact: true }).last().waitFor();
  await page.getByRole('combobox', { name: 'Вид оборудования для новой спецификации' }).selectOption('fan');
  for (const width of [1024, 1440]) for (const theme of ['light', 'dark']) screenshots.push(await shot('builder', width, theme));
  assert(await page.getByText('ОСА300-050/Б-50-Н-00400/2-У1-02', { exact: false }).count(), 'populated builder selection item is missing');
  await page.evaluate(() => (window as any).__setEmpty(true));
  await page.getByRole('button', { name: 'Читатель', exact: true }).click();
  await page.getByRole('button', { name: 'Каталог', exact: true }).click();
  await page.getByText('Модели не найдены. Измените поиск или фильтры.', { exact: true }).waitFor();
  assert(await page.getByText('0 моделей · 0 комплектующих', { exact: true }).count(), 'published empty catalog state did not render');
  assert(!errors.length, `browser errors or unhandled HTTP failures: ${errors.join('; ')}`);
  await mkdir('/tmp', { recursive: true });
  const report = { result: 'passed', screenshots, assertions: ['reader hides workspace draft-only records', 'reader has no owner publication policy controls', 'choice facts use Russian labels', 'owner can view/toggle publication second-review policy', 'expanded publication diff shows changed field, previous and proposed values', 'four reader tabs and sources render', 'comparison panel opens', 'published table rendered', 'table cell issue includes stable row/column, current value and source', 'workspace import refusal surfaced', 'access rule saved', 'source editor shows documents/tables and missing-upload state', 'editor preserves local edits and offers remote conflict comparison', 'builder new-list type set to active list class; populated item visible', 'published empty catalog state renders', 'visible interactive controls fit 1024/1440 in light/dark'], expectedHttp, errors };
  await writeFile('/tmp/catalog-ui-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile('/tmp/catalog-ui-report.json', JSON.stringify({ result: 'failed', error: String(error), expectedHttp, errors }, null, 2));
  throw error;
} finally { await browser.close(); server.kill('SIGTERM'); }
}
void main();
