/** Настоящее окно выгрузки и книга Excel; оборудование синтетическое, запись — только тестовый файл. */
import { testCredentials } from './testCredentials';
import * as XLSX from 'xlsx';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { loginPage } from './officeHarness';
const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = testCredentials();
const CHROME = process.env.FLUX_CHROME || '/usr/bin/chromium';
let passed = 0; let failed = 0;
const ok = (name: string, value: boolean) => { if (value) { passed++; console.log('✓', name); } else { failed++; console.error('✗', name); } };
(async () => {
  const { chromium } = await import('playwright-core');
  const { createServer: createViteServer } = await import('vite');
  const auth = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(LOGIN) }).then(r => r.json());
  if (!auth.token) throw new Error('Не удалось войти в тестовый профиль');
  const api = (path: string, method = 'GET', body?: unknown) => fetch(BASE + path, { method, headers: { Authorization: `Bearer ${auth.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const list = await (await api('/api/projects')).json();
  const projects = Array.isArray(list) ? list : list.projects;
  const project = projects[0];
  let secondProject = projects[1];
  let createdProject = '';
  if (!secondProject) { const created = await (await api('/api/projects', 'POST', { name: `__Проба другого проекта выгрузки ${Date.now()}` })).json(); secondProject = created.project; createdProject = secondProject?.id || ''; }
  if (!project) throw new Error('Нужен синтетический проект в изолированной тестовой БД');
  console.log('Синтетический профиль доступен, запускается браузер');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const portProbe = createServer();
  await new Promise<void>(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const uiPort = (portProbe.address() as any).port as number;
  await new Promise<void>((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));
  const useTestOrigin = (proxy: any) => proxy.on('proxyReq', (request: any) => request.setHeader('origin', BASE));
  const vite = await createViteServer({ server: { host: '127.0.0.1', port: uiPort, strictPort: true, hmr: false, watch: { ignored: ['**/*'] }, proxy: {
    '/api': { target: BASE, changeOrigin: true, configure: useTestOrigin }, '/socket.io': { target: BASE, changeOrigin: true, ws: true, configure: useTestOrigin },
  } } });
  await vite.listen();
  const UI_BASE = `http://127.0.0.1:${uiPort}`;
  const made: string[] = []; const errors: string[] = [];
  let releaseTemplateRead!: () => void;
  let templateReadStarted!: () => void;
  const templateRead = new Promise<void>(resolve => { releaseTemplateRead = resolve; });
  const templateReadEntered = new Promise<void>(resolve => { templateReadStarted = resolve; });
  let releaseCloseTemplate!: () => void;
  let closeTemplateStarted!: () => void;
  const closeTemplate = new Promise<void>(resolve => { releaseCloseTemplate = resolve; });
  const closeTemplateEntered = new Promise<void>(resolve => { closeTemplateStarted = resolve; });
  let page: any;
  try {
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', e => errors.push(e.message));
    if (process.env.FLUX_EXPORT_DIAGNOSTIC) {
      page.on('response', (r: any) => { if (r.url().includes('/api/login')) console.log('EXPORT-LOGIN', r.status(), r.url()); });
      page.on('requestfailed', (r: any) => console.log('EXPORT-REQUEST-FAILED', r.url(), r.failure()?.errorText));
    }
    if (process.env.FLUX_EXPORT_DIAGNOSTIC) {
      page.on('console', (message: any) => { if (message.text().startsWith('EXPORT-DIAG')) console.log(message.text()); });
      await page.addInitScript(() => window.addEventListener('message', event => { if (JSON.stringify(event.data || {}).includes('refresh-export')) console.log('EXPORT-DIAG', JSON.stringify(event.data)); }));
    }
    page.on('response', async response => { if (response.url().includes('/api/office/files/new?') && response.ok()) { const value = await response.json().catch(() => null); if (value?.id) made.push(value.id); } });
    const fixture = { systems: [{ id: '__export_unit', name: 'Тестовая установка', category: 'AHU', monoblocks: [{ name: '', components: [1, 2].map(n => ({ id: `__export_drive_${n}`, itemCode: `drive${n}`, name: `Привод ${n}`, equipType: 'ПРИВОД', equipClass: 'ПРИВОД', tags: [{ identifier: `DRV-${n}` }], specs: JSON.stringify({ groups: [] }) })) }] }] };
    await page.route('**/api/equipment/view-templates', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ views: [
      { id: 'template-slow', name: 'Медленный шаблон', scope: 'PERSONAL', hasWorkbook: true, spec: {} },
      { id: 'template-next', name: 'Следующий шаблон', scope: 'PERSONAL', hasWorkbook: false, spec: {} },
      { id: 'template-fail', name: 'Недоступный шаблон', scope: 'PERSONAL', hasWorkbook: true, spec: {} },
      { id: 'template-close', name: 'Шаблон для закрытия', scope: 'PERSONAL', hasWorkbook: true, spec: {} },
    ] }) }));
    await page.route('**/api/equipment/view-templates/template-slow/workbook', async route => {
      templateReadStarted(); await templateRead; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
    });
    await page.route('**/api/equipment/view-templates/template-fail/workbook', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
    await page.route('**/api/equipment/view-templates/template-close/workbook', async route => {
      closeTemplateStarted(); await closeTemplate; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
    });
    await page.route(`**/api/projects/${project.id}/systems`, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) }));
    await loginPage(page, UI_BASE, LOGIN);
    await page.evaluate(`(() => { const u = JSON.parse(localStorage.getItem('pdm_session_user') || 'null'); if(u) localStorage.setItem('max_active_project_' + u.id, ${JSON.stringify(JSON.stringify(project))}); })()`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-taskbar]', { timeout: 60000 });
    await page.evaluate(`window.location.hash = '#/equipment-export?scope=all'`);
    const root = page.locator('[aria-label="Выгрузка данных"]:not([data-win])');
    await root.waitFor({ timeout: 60000 });
    const frame = root.locator('xpath=ancestor::*[@data-win][1]');
    await frame.getByRole('button', { name: 'Развернуть', exact: true }).click();
    ok('Выгрузка открылась собственным окном без модального фона', !(await root.getAttribute('role')) && await frame.count() === 1);
    const sheet = root.frameLocator('iframe[title="Flux Office — Таблица"]');
    await sheet.locator('input.univer-box-border').first().waitFor({ timeout: 90000 });
    ok('Книга открылась без дополнительного нажатия Создать', made.length === 1);
    await root.getByRole('tab', { name: 'Столбцы', exact: true }).click();
    await root.getByLabel('Заголовок столбца').first().fill('Обозначение');
    await root.getByRole('button', { name: '+ Столбец с формулой', exact: true }).click();
    await root.getByLabel('Формула столбца').fill('=1+2');
    ok('Изменение источника не перезаписывает книгу сразу', await root.getByText('Отбор изменён — обновите данные в листе').isVisible());
    await root.getByRole('tab', { name: 'Шаблоны', exact: true }).click();
    await root.getByLabel('Имя книги и шаблона').fill('__Проба выгрузки');
    const downloaded = page.waitForEvent('download', { timeout: 60000 });
    if (process.env.FLUX_EXPORT_DIAGNOSTIC) console.log('До обновления', await sheet.locator('body').evaluate(() => { const state = (window as any).__fluxSheets; const wb = state?.univerRef.current?.univerAPI?.getActiveWorkbook(); return { flags: state?.lazyWorkbookRef.current?.flags, cells: wb?.getActiveSheet()?.getRange(0, 0, 3, 9)?.getValues(), names: wb?.getDefinedNames().map((d: any) => [d.getName(), d.getFormulaOrRefString()]) }; }));
    await root.getByRole('button', { name: 'Скачать Excel', exact: true }).click();
    const artifact = await downloaded;
    if (process.env.FLUX_EXPORT_DIAGNOSTIC) await artifact.saveAs('/tmp/flux-export-check.xlsx');
    // GenOffice сохраняет формулы без кэшированного результата до пересчёта Excel.
    // SheetJS пропускает такие ячейки без sheetStubs, хотя <f> в XLSX присутствует.
    const saved = XLSX.read(readFileSync((await artifact.path())!), { type: 'buffer', sheetStubs: true });
    const exported = saved.Sheets[saved.SheetNames[0]];
    ok('Скачанный Excel содержит переименованный столбец', exported.A1?.v === 'Обозначение');
    ok('Скачанный Excel содержит настоящую формулу', Object.values(exported).some((cell: any) => cell?.f?.replace(/^=/, '') === '1+2'));
    if (!Object.values(exported).some((cell: any) => cell?.f?.replace(/^=/, '') === '1+2')) { console.error('Ячейки сохранённого листа', Object.entries(exported).filter(([key]) => /^[A-Z]+[123]$/.test(key))); }
    if (exported.A1?.v !== 'Обозначение' || !Object.values(exported).some((cell: any) => cell?.f?.replace(/^=/, '') === '1+2')) console.error('Первая ячейка файла', exported.A1, 'Состояние листа', await root.frameLocator('iframe[title="Flux Office — Таблица"]').locator('body').evaluate(() => { const state = (window as any).__fluxSheets; const wb = state?.univerRef.current?.univerAPI?.getActiveWorkbook(); return { cells: wb?.getActiveSheet()?.getRange(0, 0, 2, 9)?.getValues(), lazyKeys: Object.keys(state?.lazyWorkbookRef.current || {}) }; }));
    const nameBox = root.frameLocator('iframe[title="Flux Office — Таблица"]').locator('input.univer-box-border').first();
    await nameBox.fill('B2'); await nameBox.press('Enter'); await page.keyboard.type('Привод вручную'); await page.keyboard.press('Enter');
    await nameBox.fill('K2'); await nameBox.press('Enter'); await page.keyboard.type('=LEN(A2)'); await page.keyboard.press('Enter');
    await root.getByRole('tab', { name: 'Столбцы', exact: true }).click();
    await root.getByLabel('Заголовок столбца').first().fill('Тег оборудования');
    const nextDownload = page.waitForEvent('download', { timeout: 60000 });
    await root.getByRole('button', { name: 'Скачать Excel', exact: true }).click();
    const manualArtifact = await nextDownload;
    if (process.env.FLUX_EXPORT_DIAGNOSTIC) await manualArtifact.saveAs('/tmp/flux-export-manual-check.xlsx');
    const manualBook = XLSX.read(readFileSync((await manualArtifact.path())!), { type: 'buffer', sheetStubs: true });
    const manualSheet = manualBook.Sheets[manualBook.SheetNames[0]];
    if (process.env.FLUX_EXPORT_DIAGNOSTIC) console.log('Ручные ячейки', manualSheet.B2, manualSheet.K2, 'формулы редактора', await sheet.locator('body').evaluate(() => { const wb = (window as any).__fluxSheets?.univerRef.current?.univerAPI?.getActiveWorkbook(); return wb?.getActiveSheet()?.getRange(0, 0, 3, 12)?.getFormulas(); }));
    ok('Обновление сохраняет значение введённое в ячейку вручную', manualSheet.B2?.v === 'Привод вручную');
    ok('Обновление сохраняет ручную формулу со ссылкой на другую ячейку', manualSheet.K2?.f === 'LEN(A2)');
    ok('Повторное обновление сохраняет формулу шаблона', Object.values(manualSheet).some((cell: any) => cell?.f?.replace(/^=/, '') === '1+2'));
    const metadata = await (await api(`/api/office/files/${made[0]}/meta`)).json();
    ok('Рабочая книга записана в проект выбранной выгрузки', metadata.projectId === project.id);
    for (const width of [1920, 1440, 1280, 1100, 960, 600]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForTimeout(500);
      for (const theme of ['light', 'dark']) {
        await page.evaluate(`document.documentElement.classList.toggle('dark', ${theme === 'dark'})`);
        const geometry = await root.evaluate((el: HTMLElement) => { const book = el.querySelector('main')?.getBoundingClientRect(); const box = el.getBoundingClientRect(); return { overflow: el.scrollWidth > el.clientWidth + 2, book: book?.width || 0, right: book?.right || 0, limit: box.right }; });
        ok(`Лист доступен при ${width}px, ${theme}`, !geometry.overflow && geometry.book > 180 && geometry.right <= geometry.limit + 2);
      }
    }
    const before = await root.locator('main').boundingBox();
    await root.getByRole('button', { name: 'Параметры выгрузки', exact: true }).click();
    const after = await root.locator('main').boundingBox();
    ok('Сворачивание панели отдаёт место листу', !!before && !!after && after.width > before.width + 100);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: '/tmp/flux-export-workspace.png' });
    if (!secondProject) throw new Error('Не удалось подготовить проект B');
    await page.locator(`[aria-label="Активный проект: ${project.name}. Сменить"]`).first().click();
    await page.getByRole('option', { name: secondProject.name, exact: true }).click();
    await page.locator(`[aria-label="Активный проект: ${secondProject.name}. Сменить"]`).first().waitFor();
    const persistedResponse = await api(`/api/office/files/${made[0]}/open`);
    const persistedAfterSwitch = XLSX.read(Buffer.from(await persistedResponse.arrayBuffer()), { type: 'buffer', sheetStubs: true });
    const sheetAfterSwitch = persistedAfterSwitch.Sheets[persistedAfterSwitch.SheetNames[0]];
    ok('Смена global project не размонтирует открытое окно выгрузки', await root.isVisible());
    ok('При смене global project книга окна остаётся привязана к A с ручной формулой', sheetAfterSwitch.B2?.v === 'Привод вручную' && sheetAfterSwitch.K2?.f === 'LEN(A2)');
    const nextBook = page.waitForResponse(response => response.url().includes('/api/office/files/new?') && response.ok());
    await root.getByRole('button', { name: 'Новая книга', exact: true }).click();
    const nextFile = await (await nextBook).json();
    await root.frameLocator('iframe[title="Flux Office — Таблица"]').locator('input.univer-box-border').first().waitFor({ timeout: 60000 });
    await page.waitForFunction(() => document.querySelectorAll('iframe[title="Flux Office — Таблица"]').length > 0);
    const secondMetadata = await (await api(`/api/office/files/${nextFile.id}/meta`)).json();
    ok('После смены active project A→B новая книга окна A сохраняется в A', made.length === 2 && secondMetadata.projectId === project.id);
    const templateSelect = root.getByLabel('Шаблон выгрузки');
    await templateSelect.selectOption('template-slow');
    await templateReadEntered;
    ok('Пока читается шаблон, нельзя запустить второй выбор', await templateSelect.isDisabled());
    ok('Пока читается шаблон, кнопка выхода отключена', await root.getByRole('button', { name: 'К оборудованию', exact: true }).isDisabled());
    releaseTemplateRead();
    await templateSelect.waitFor({ state: 'visible' });
    await page.waitForFunction(() => !(document.querySelector('[aria-label="Шаблон выгрузки"]') as HTMLSelectElement)?.disabled);
    await templateSelect.selectOption('template-next');
    ok('После завершения чтения следующий шаблон можно выбрать', await templateSelect.inputValue() === 'template-next');
    await templateSelect.selectOption('template-fail');
    await page.waitForFunction(() => !(document.querySelector('[aria-label="Шаблон выгрузки"]') as HTMLSelectElement)?.disabled);
    ok('Ошибка чтения сохраняет прежний выбор шаблона', await templateSelect.inputValue() === 'template-next');
    await templateSelect.selectOption('');
    await root.getByRole('button', { name: 'Параметры выгрузки', exact: true }).click();
    await root.getByRole('tab', { name: 'Столбцы', exact: true }).click();
    ok('Возврат из шаблона восстанавливает текущий черновик с именем и формулой', await root.getByLabel('Заголовок столбца').first().inputValue() === 'Тег оборудования' && await root.getByLabel('Формула столбца').inputValue() === '=1+2');
    await templateSelect.selectOption('template-close');
    await closeTemplateEntered;
    await frame.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.waitForTimeout(300);
    ok('Крестик окна ждёт завершения загрузки шаблона', await frame.isVisible());
    releaseCloseTemplate();
    await frame.waitFor({ state: 'detached', timeout: 15000 });
    ok('После выбора шаблона крестик закрывает окно', await frame.count() === 0);
    ok('Нет ошибок браузера', errors.length === 0);
    if (errors.length) console.error(errors.slice(0, 3));
  } catch (error) {
    if (page) {
      await page.screenshot({ path: '/tmp/flux-export-failure.png' }).catch(() => undefined);
      console.error('Ошибки браузера', errors);
      console.error('Office iframe', await Promise.all(page.frames().filter((f: any) => f !== page.mainFrame()).map(async (f: any) => ({ url: f.url(), body: (await f.locator('body').innerText().catch(() => '')).slice(0, 2500) }))));
      console.error((await page.locator('body').innerText().catch(() => '')).slice(-4000));
    }
    throw error;
  } finally {
    await browser.close();
    await vite.close();
    for (const id of made) await api(`/api/files/${id}`, 'DELETE');
    if (createdProject) await api(`/api/projects/${createdProject}`, 'DELETE');
  }
  console.log(`${passed} проверок пройдено, ${failed} провалено`); process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
