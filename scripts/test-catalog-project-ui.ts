import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '../node_modules/playwright-core/index.mjs';

const root = process.cwd();
const port = 4198;
const url = `http://127.0.0.1:${port}/catalog-project-stand.html`;
const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), path.join(root, 'scripts/fixtures'), '--config', path.join(root, 'scripts/fixtures/catalog-ui/vite.config.ts'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'ignore' });
const family = { id: 'common-1', classId: 'fan', manufacturerId: 'maker', code: 'FAN-1', title: { ru: 'Вентилятор' }, kind: '', typeLabel: { ru: 'Вентилятор' }, shapes: [], params: [], positions: [], rules: [], specs: [], match: { kinds: [] }, designationMode: 'free', status: 'draft' };
const catalog = { classes: [{ id: 'fan', code: 'fan', title: { ru: 'Вентиляторы' }, itemName: { ru: 'Вентилятор' }, facts: [] }], manufacturers: [{ id: 'maker', name: 'Завод', shortName: 'Завод' }], components: [], tagRules: [], meta: {} };
let projectFamily: any = null;
let revision = 1;
let pending: any = null;
let before: any = null;
let commonDraft: any = null;
let saveAttempts = 0;
const requests: any[] = [];
const difference = { path: ['title', 'ru'], before: 'Вентилятор', after: 'Проектный вентилятор' };
const view = (source: string) => ({ ...catalog, families: source === 'common' ? [family] : projectFamily ? [projectFamily] : [], rows: source !== 'common' && projectFamily ? [{ id: projectFamily.id, code: projectFamily.code, basedOnFamilyId: 'common-1', basedOnRevision: '1', revision: String(revision), overrides: [difference], updateAvailable: true }] : [], canEdit: true, lastPlanId: before ? 'plan-1' : null });
async function main() {
  const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] }).catch(error => { server.kill(); throw error; });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => { if (msg.type() === 'error' && !(msg.text().includes('503') && msg.location().url.includes('/api/catalog/family/'))) errors.push(msg.text()); });
  await page.route('**/api/catalog/project**', async route => {
    const request = route.request(); const target = new URL(request.url()); const body = request.method() === 'POST' ? request.postDataJSON() : null;
    if (body) requests.push({ path: target.pathname, ...body });
    let result: any;
    if (request.method() === 'GET') result = view(target.searchParams.get('source') || 'project');
    else if (target.pathname.endsWith('/plan')) {
      pending = body;
      result = { id: 'plan-1', operation: body.operation, expiresAt: '2026-12-01T00:00:00Z', rows: [{ id: 'project-1', code: body.document?.code || family.code, before: projectFamily, after: body.document || family, action: body.operation, differences: [difference], conflicts: body.operation === 'update' ? [difference] : [] }] };
    } else if (target.pathname.endsWith('/apply')) {
      before = projectFamily;
      projectFamily = { ...(pending.document || family), id: 'project-1', projectId: 'project-fixture', basedOnFamilyId: 'common-1', basedOnRevision: '1', baseDataJson: '{}', overridesJson: '[]', _draftVersion: 'project-version' }; revision++;
      result = view('project');
    } else { projectFamily = before; before = null; result = view('project'); }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.route('**/api/catalog/family/**', async route => {
    const request = route.request(); const document = request.postDataJSON();
    requests.push({ path: new URL(request.url()).pathname, method: request.method(), document });
    saveAttempts++;
    if (saveAttempts === 1) { await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Временно недоступно' }) }); return; }
    commonDraft = { entity: 'family', id: document.id, document, revision: 'draft-r1' };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, id: document.id, revision: commonDraft.revision }) });
  });
  await page.route('**/api/catalog/workspace/discard', async route => {
    const body = route.request().postDataJSON(); requests.push({ path: '/api/catalog/workspace/discard', ...body });
    if (!commonDraft || body.entity !== commonDraft.entity || body.id !== commonDraft.id || body.revision !== commonDraft.revision) { await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Черновик изменён' }) }); return; }
    commonDraft = null; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  const evidence = process.env.FLUX_EVIDENCE_DIR || '/tmp/flux-catalog-project-ui';
  await mkdir(evidence, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const measurements: any[] = [];
  const capture = async (stage: string) => {
    const stageMeasurements: any[] = [];
    for (const width of [1440, 1024]) for (const theme of ['light', 'dark']) for (const opacity of ['normal', 'opaque']) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: opacity === 'opaque' ? 'reduce' : 'no-preference' }] });
      const geometry = await page.evaluate(() => {
        const content = document.querySelector('#root > div')!;
        return { scroll: document.documentElement.scrollWidth, width: innerWidth,
          background: getComputedStyle(content).backgroundColor, opacity: getComputedStyle(content).opacity,
          toolbar: [...document.querySelectorAll('.fx-tools')].map(el => el.getBoundingClientRect().height).filter(Boolean),
          rows: [...document.querySelectorAll('.fx-li')].map(el => el.getBoundingClientRect().height).filter(Boolean),
          fields: [...document.querySelectorAll('.fx-input')].map(el => el.getBoundingClientRect().height).filter(Boolean),
          small: [...document.querySelectorAll('button,input,select')].filter(el => { const rect = el.getBoundingClientRect(); return rect.width && (rect.left < 0 || rect.right > innerWidth); }).length };
      });
      const label = `${stage}: ${width} ${theme} ${opacity}`;
      assert.ok(geometry.scroll <= geometry.width && geometry.small === 0, `всё помещается: ${label}`);
      assert.equal(geometry.opacity, '1', label);
      assert.ok(geometry.background !== 'rgba(0, 0, 0, 0)', `фон сплошной: ${label}`);
      assert.ok(geometry.toolbar.every(height => height === 40), `панель 40 px: ${label}: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.rows.every(height => height === 32), `строки 32 px: ${label}`);
      if (stage === 'editor') assert.ok(geometry.fields.length > 0 && geometry.fields.every(height => height === 32), `поля формы 32 px: ${label}`);
      const measurement = { stage, width, theme, transparency: opacity, ...geometry };
      stageMeasurements.push(measurement); measurements.push(measurement);
      await page.screenshot({ path: path.join(evidence, `project-${stage}-${width}-${theme}-${opacity}.png`) });
    }
    for (const width of [1440, 1024]) for (const opacity of ['normal', 'opaque']) {
      const light = stageMeasurements.find(m => m.width === width && m.transparency === opacity && m.theme === 'light');
      const dark = stageMeasurements.find(m => m.width === width && m.transparency === opacity && m.theme === 'dark');
      assert.notEqual(light.background, dark.background, `темы действительно различаются: ${stage} ${width} ${opacity}`);
    }
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { if (server.exitCode !== null) throw new Error(`Vite завершился: ${server.exitCode}`); try { if ((await fetch(url)).ok) { ready = true; break; } } catch {} await delay(200); }
    assert.ok(ready, 'фикстура запустилась');
    await page.goto(url); await page.getByText('Позиций пока нет').waitFor();
    await page.getByRole('button', { name: 'Общий каталог' }).click(); await page.getByRole('button', { name: 'Взять из общего' }).click();
    await page.getByText('Предпросмотр изменений').waitFor(); assert.equal(requests.at(-1).operation, 'take'); assert.equal(requests.at(-1).familyId, 'common-1');
    assert.equal(requests.filter(request => request.path.endsWith('/apply')).length, 0, 'предпросмотр не применяет план');
    assert.equal(projectFamily, null, 'позиция не появляется до подтверждения');
    await page.getByRole('button', { name: 'Применить' }).click(); await page.getByText('Проектные отличия').waitFor();
    await capture('view');
    await page.getByRole('button', { name: 'Изменить' }).click(); await page.getByLabel('Название', { exact: true }).first().fill('Проектный вентилятор');
    await page.getByRole('button', { name: 'Добавить параметр' }).click(); await page.getByLabel('Ключ', { exact: true }).first().fill('pressure'); await page.getByLabel('Название', { exact: true }).nth(1).fill('Давление'); await page.getByLabel('Тип', { exact: true }).selectOption('number'); await page.getByLabel('По умолчанию', { exact: true }).pressSequentially('250.5');
    assert.equal(await page.getByLabel('По умолчанию', { exact: true }).inputValue(), '250.5', 'десятичный разделитель сохраняется при наборе');
    await page.getByRole('button', { name: 'Добавить характеристику' }).click(); await page.getByLabel('Ключ', { exact: true }).nth(1).fill('material'); await page.getByLabel('Название', { exact: true }).nth(2).fill('Материал'); await page.getByLabel('Значение').fill('Сталь');
    await capture('editor');
    await page.getByRole('button', { name: 'Предпросмотр' }).click(); await page.getByText('Предпросмотр изменений').waitFor(); assert.equal(requests.at(-1).expectedRevision, '2'); assert.equal(requests.at(-1).document.specs[0].value.ru, 'Сталь'); assert.equal(requests.at(-1).document.params[0].default, 250.5);
    await capture('preview');
    await page.getByRole('button', { name: 'Применить' }).click(); await page.getByRole('button', { name: 'Обновить до новой ревизии общего' }).click();
    await page.getByText('Общий каталог изменил эти поля; проектные значения будут сохранены.').first().waitFor(); assert.equal(requests.at(-1).operation, 'update');
    await page.getByRole('button', { name: 'Назад' }).click(); await page.getByRole('button', { name: 'Сбросить к общему' }).click(); await page.getByText('Предпросмотр изменений').waitFor(); assert.equal(requests.at(-1).operation, 'reset');
    await page.getByRole('button', { name: 'Назад' }).click();
    const projectBeforeProposal = structuredClone(projectFamily);
    const publishedBeforeProposal = structuredClone(family);
    const writesBeforeProposal = requests.length;
    await page.getByRole('button', { name: 'Подготовить черновик для общего каталога…' }).click();
    await page.getByText('Черновик увидят редакторы общего каталога.', { exact: false }).waitFor();
    assert.equal(requests.length, writesBeforeProposal, 'предпросмотр общего черновика не записывает данные');
    await capture('common-draft');
    await page.getByRole('button', { name: 'Создать черновик' }).click();
    await page.getByRole('alert').waitFor(); assert.match(await page.getByRole('alert').innerText(), /Временно недоступно/);
    const firstSave = requests.at(-1);
    await page.getByRole('button', { name: 'Создать черновик' }).click();
    await page.getByText('Черновик подготовлен; откройте Панель разработчика для обычной публикации.').waitFor();
    const secondSave = requests.at(-1);
    assert.equal(secondSave.method, 'PUT'); assert.equal(secondSave.document.id, firstSave.document.id);
    assert.match(secondSave.document.id, /^global-/); assert.notEqual(secondSave.document.id, projectFamily.id);
    assert.equal(secondSave.document.classId, projectFamily.classId); assert.equal(secondSave.document.manufacturerId, projectFamily.manufacturerId);
    assert.ok(!Object.keys(secondSave.document).some(key => key.startsWith('_') || key.startsWith('basedOn') || ['projectId', 'baseDataJson', 'overridesJson'].includes(key)));
    assert.deepEqual(projectFamily, projectBeforeProposal); assert.deepEqual(family, publishedBeforeProposal);
    await page.getByRole('button', { name: 'Отменить черновик' }).click();
    await page.getByRole('button', { name: 'Подготовить черновик для общего каталога…' }).waitFor();
    assert.equal(requests.at(-1).revision, 'draft-r1'); assert.equal(requests.at(-1).id, secondSave.document.id); assert.equal(requests.at(-1).entity, 'family');
    assert.equal(commonDraft, null); assert.deepEqual(projectFamily, projectBeforeProposal); assert.deepEqual(family, publishedBeforeProposal);
    assert.ok(!requests.some(request => request.path.endsWith('/publish')));
    await writeFile(path.join(evidence, 'measurements.json'), JSON.stringify(measurements, null, 2));
    await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/catalog/project/undo')), page.getByRole('button', { name: 'Отменить последнее изменение' }).click()]);
    assert.equal(requests.at(-1).path, '/api/catalog/project/undo');
    await page.getByRole('button', { name: 'Своя позиция' }).click();
    await page.getByLabel('Код', { exact: true }).fill('CUSTOM-1'); await page.getByLabel('Название', { exact: true }).fill('Своя модель');
    await page.getByLabel('Класс оборудования').selectOption('fan'); await page.getByLabel('Изготовитель').selectOption('maker');
    await page.getByRole('button', { name: 'Предпросмотр' }).click(); await page.getByText('Предпросмотр изменений').waitFor();
    assert.equal(requests.at(-1).operation, 'create'); assert.equal(requests.at(-1).document.designationMode, 'free'); assert.deepEqual(requests.at(-1).document.positions, []);
    await page.getByRole('button', { name: 'Применить' }).click(); await page.getByText('Своя модель').waitFor();
    assert.deepEqual(errors, []); console.log('Каталог проекта: сценарии и геометрия проверены');
  } finally { await browser.close(); server.kill(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
