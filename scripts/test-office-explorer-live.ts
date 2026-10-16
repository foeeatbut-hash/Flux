/**
 * Панель Flux над файлами Проводника (/windows-file): настоящие редакторы
 * GenOffice, настоящий сервис файлов Windows и сеанс локальной книги в
 * оболочке; мостом в браузере служит заглушка window.electron, за которой
 * стоят реальные модули. Проверяются байты файла НА ДИСКЕ: привязка, план,
 * заполнение, сохранение из редактора и то, что связи Flux переживают его.
 * Запуск: node --import tsx scripts/test-guide-server.ts --office-explorer
 */
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { chromium } from 'playwright-core';
import { WindowsFilesService } from '../electron/filesystem/service';
import { LocalOfficeSessions, type LocalOfficeRequest } from '../electron/localOfficeSessions';
import { readOfficeBindings } from '../server/officeBindings';
import { listDocxFields, listDocxMarkers } from '../server/officeFields';
import { makeDocxWithTable, makeXlsxWithManualRow, loginPage } from './officeHarness';

void (async () => {
  type Fixture = { baseUrl: string; projectId: string; dataDir: string; admin: { symbol: string; password: string } };
  const metadataPath = resolve(process.argv[2] || process.env.FLUX_FIXTURE_META || '');
  if (!process.env.FLUX_OFFICE_NATIVE_READY) { console.error('Нужны пересобранные редакторы: FLUX_OFFICE_NATIVE_READY=1'); process.exit(2); }
  if (((await stat(metadataPath)).mode & 0o077) !== 0) throw new Error('Fixture metadata должен быть доступен только владельцу (0600)');
  const fixture = JSON.parse(await readFile(metadataPath, 'utf8')) as Fixture;
  if (!/^https?:\/\/(127\.0\.0\.1|localhost):\d+$/.test(fixture.baseUrl) || !fixture.dataDir.startsWith('/tmp/flux-guide-server-')) throw new Error('Тест принимает только одноразовый стенд Guide');
  await chmod(metadataPath, 0o600);
  const BASE = fixture.baseUrl.replace(/\/$/, '');
  const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  let failures = 0;
  const fieldRefreshOnly = process.env.FLUX_OFFICE_EXPLORER_ONLY === 'field-refresh';
  const fieldRefreshDone = Symbol('field-refresh-done');
  const check = (label: string, good: unknown, detail?: unknown) => {
    if (good) console.log(`  ✓ ${label}`);
    else { failures++; console.error(`  ✗ ${label}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600)); }
  };
  const waitFor = async (probe: () => Promise<boolean>, timeout = 15000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await probe().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 250)); }
    return probe().catch(() => false);
  };
  const evaluateBrowserCode = (page: any, code: string) => page.evaluate((source: string) => (0, eval)(source), code);

  // Настоящие модули за заглушкой моста: файлы Windows и сеанс локальной книги
  const root = await mkdtemp(join(tmpdir(), 'flux-office-explorer-'));
  const desktop = join(root, 'desktop'), userData = join(root, 'private');
  await mkdir(desktop); await mkdir(userData);
  const files = await WindowsFilesService.create({ userData, knownFolders: { desktop }, trashItem: async () => {}, showItemInFolder: () => {}, openPath: async () => '' });
  const rootId = (await files.roots())[0].id;
  const pending: any[] = [];
  const sessions = new LocalOfficeSessions({ files, userData, resourcesDir: resolve('genoffice-server'), onEvent(_owner, event) { pending.push(event); } });
  const auth = { mayRead: () => true, mayWrite: () => true };
  await writeFile(join(desktop, 'one.docx'), await makeDocxWithTable());
  await writeFile(join(desktop, 'one.xlsx'), await makeXlsxWithManualRow());
  const disk = async (name: string) => Buffer.from((await files.read({ rootId, relativePath: name })).base64, 'base64');
  const diskText = async (name: string, part: string) => (await JSZip.loadAsync(await disk(name))).file(part)?.async('string').then((text) => text || '') ?? '';
  const diskXml = async (name: string) => {
    const zip = await JSZip.loadAsync(await disk(name));
    return (await Promise.all(Object.values(zip.files).filter((entry) => !entry.dir && entry.name.endsWith('.xml')).map((entry) => entry.async('string')))).join('\n');
  };

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const errors: string[] = [];
  const failed: string[] = [];
  const serverCalls: string[] = [];
  const fieldRefreshResponses: Array<{
    status: number;
    error?: string;
    changedCount?: number;
    skippedCount?: number;
    skipped?: Array<{ key: string; why: string }>;
    unchanged?: boolean;
    responseHashValid?: boolean;
    payloadHashMatches?: boolean;
  }> = [];
  let fieldRefreshRequestBaseHash = '';
  let token = '';
  const api = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(`${BASE}${route}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    let json: any = null;
    try { json = JSON.parse(bytes.toString('utf8')); } catch { /* Ответ может быть двоичным. */ }
    return { status: response.status, bytes, json };
  };
  let context: any = null;
  let page: any = null;
  // Диспетчер окон потребляет хеш адреса один раз, поэтому каждый файл — в свежей странице
  const dark = process.env.FLUX_EXPLORER_DARK === '1';
  const shot = async (name: string) => { await page.screenshot({ path: `/tmp/office-explorer-${name}-${dark ? 'dark' : 'light'}.png` }).catch(() => {}); };
  const freshPage = async () => {
    await context?.close().catch(() => {});
    context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    page = await context.newPage();
    page.on('pageerror', (error: any) => errors.push(`pageerror: ${error?.message || error}`.slice(0, 500)));
    page.on('response', async (response: any) => {
      if (response.status() >= 400 && !/\/api\/(license|auth|presence)/.test(response.url())) failed.push(`${response.status()} ${response.url()}`);
      if (new URL(response.url()).pathname === '/api/project-data/office-local/update-fields') {
        let error: string | undefined;
        let result: any = null;
        let responseHashValid: boolean | undefined;
        let payloadHashMatches: boolean | undefined;
        if (response.status() >= 400) {
          try { error = String((await response.json())?.error || '').slice(0, 240) || undefined; } catch { error = 'non-JSON error response'; }
        } else {
          try {
            result = await response.json();
            responseHashValid = typeof result?.sha256 === 'string' && /^[a-f\d]{64}$/i.test(result.sha256);
            if (typeof result?.base64 === 'string' && responseHashValid) {
              const bytes = Buffer.from(result.base64, 'base64');
              const canonical = bytes.toString('base64') === result.base64;
              payloadHashMatches = canonical && createHash('sha256').update(bytes).digest('hex') === result.sha256;
            } else payloadHashMatches = false;
          } catch { error = 'non-JSON success response'; }
        }
        fieldRefreshResponses.push({
          status: response.status(),
          ...(error ? { error } : {}),
          ...(result ? {
            changedCount: Array.isArray(result.changed) ? result.changed.length : -1,
            skippedCount: Array.isArray(result.skipped) ? result.skipped.length : -1,
            skipped: Array.isArray(result.skipped) ? result.skipped.slice(0, 3).map((item: any) => ({ key: String(item?.key || '').slice(0, 100), why: String(item?.why || '').slice(0, 160) })) : [],
            unchanged: typeof result.unchanged === 'boolean' ? result.unchanged : undefined,
            responseHashValid,
            payloadHashMatches,
          } : {}),
        });
        if (fieldRefreshResponses.length > 4) fieldRefreshResponses.shift();
      }
    });
    page.on('request', (request: any) => {
      if (/office-local|office-state|\/api\/files/.test(request.url())) serverCalls.push(`${request.method()} ${new URL(request.url()).pathname}`);
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/project-data/office-local/update-fields') {
        try { fieldRefreshRequestBaseHash = String(request.postDataJSON()?.baseHash || ''); } catch { fieldRefreshRequestBaseHash = ''; }
      }
    });
    await page.exposeFunction('__fluxWindowsFiles', async (request: any) => {
      try {
        if (request.action === 'read') return { ok: true, data: await files.read(request.ref) };
        if (request.action === 'write') return { ok: true, data: await files.write(request.ref, request.base64, request.baseSha256) };
        return { ok: false, error: { code: 'UNSUPPORTED_TEST_ACTION', message: `Не поддержано стендом: ${request.action}` } };
      } catch (error: any) { return { ok: false, error: { code: error?.code || 'ERROR', message: String(error?.message || error) } }; }
    });
    await page.exposeFunction('__fluxLocalOffice', async (request: LocalOfficeRequest) => {
      try { return { ok: true, data: await sessions.handle(1, request, auth) }; }
      catch (error: any) { return { ok: false, error: { code: error?.code || 'NATIVE_ERROR', message: String(error?.message || error) } }; }
    });
    await page.exposeFunction('__fluxLocalOfficeEvents', async () => pending.splice(0));
    // Имена скачиваемых файлов: headless-Chromium стенда отдаёт «download» вместо кириллического имени, поэтому смотрим на атрибут ссылки
    await page.addInitScript(`(() => { const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) (window.__downloadNames = window.__downloadNames || []).push(this.download); return click.call(this); }; })();`);
    // Строкой: tsx добавляет в функции служебные вызовы, которых нет в странице
    await page.addInitScript(`window.electron = {
      windowsFiles: { invoke: (request) => window.__fluxWindowsFiles(request), onChanged: () => () => undefined },
      localOffice: {
        invoke: (request) => window.__fluxLocalOffice(request),
        onEvent: (callback) => {
          let active = true;
          const timer = window.setInterval(async () => { for (const event of await window.__fluxLocalOfficeEvents()) if (active) callback(event); }, 80);
          return () => { active = false; window.clearInterval(timer); };
        },
      },
    };`);
    await loginPage(page, BASE, fixture.admin, dark);
  };

  const panel = () => page.getByRole('complementary', { name: 'Flux Office' });
  const fieldRefreshFailureDetails = async (docs: any, refreshToastObserved: boolean) => {
    const frame = page.locator('iframe').first();
    const [fileBytes, bindings, ui, toastCapture] = await Promise.all([
      disk('one.docx'),
      readOfficeBindings(await disk('one.docx')),
      (async () => ({
        refreshToast: await page.getByText(/Обновлено полей:/).count() > 0,
        editorMarkerVisible: (await docs.locator('.ProseMirror').first().innerText().catch(() => '')).includes('REFRESH_KEEP'),
        frame: await frame.evaluate((el: HTMLIFrameElement) => ({ title: el.title, src: el.getAttribute('src'), ready: !!el.contentDocument?.body })).catch(() => null),
      }))(),
      evaluateBrowserCode(page, `(() => {
        const w = window;
        w.__fluxFieldRefreshToastStop?.();
        const messages = w.__fluxFieldRefreshToastMessages || [];
        const rawPrefs = Object.keys(localStorage).filter(key => key.startsWith('notif_prefs_')).map(key => {
          try { return JSON.parse(localStorage.getItem(key) || '{}')?.popups !== false; } catch { return null; }
        });
        return {
          messages: messages.slice(-6).map(item => ({ tone: item.tone, message: String(item.message).slice(0, 200) })),
          popupSetting: rawPrefs.length === 0 ? { source: 'defaultPrefs', popups: true } : rawPrefs.length === 1
            ? { source: 'notif_prefs_*', popups: rawPrefs[0] } : { source: 'multiple-notif_prefs_*', popups: null },
        };
      })()`).catch(() => ({ messages: [], popupSetting: { source: 'unavailable', popups: null } })),
    ]);
    const diskHash = createHash('sha256').update(fileBytes).digest('hex');
    const [markers, fields, documentXml] = await Promise.all([
      listDocxMarkers(fileBytes),
      listDocxFields(fileBytes),
      (await JSZip.loadAsync(fileBytes)).file('word/document.xml')?.async('string') || Promise.resolve(''),
    ]);
    const paragraphs = [...documentXml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)].map((paragraph) =>
      [...paragraph[1].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((text) => text[1]
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")).join(''));
    let lifecycle: unknown[] = [];
    try {
      const downloadEvent = page.waitForEvent('download', { timeout: 3000 });
      await evaluateBrowserCode(page, 'window.__fluxDiagnostics?.save?.()');
      const download = await downloadEvent;
      const path = await download.path();
      if (path) lifecycle = (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(event => event?.event === 'office.lifecycle').slice(-8).map(event => ({
        time: String(event.time || '').slice(0, 32),
        app: event.data?.app,
        stage: String(event.data?.stage || '').slice(0, 40),
        instance: event.data?.instance,
        sequence: event.data?.sequence,
        frameLoad: event.data?.frameLoad,
        width: event.data?.width,
        height: event.data?.height,
        ready: event.data?.ready,
        dirtyKnown: event.data?.dirtyKnown,
        dirty: event.data?.dirty,
        timeout: event.data?.timeout,
        outcome: event.data?.outcome,
      }));
    } catch { /* Diagnostics are optional in the live test renderer. */ }
    return {
      checks: { ...ui, refreshToastObserved, diskMarkerPresent: (await diskText('one.docx', 'word/document.xml')).includes('REFRESH_KEEP') },
      refreshResponses: fieldRefreshResponses.slice(-4),
      request: { baseHashValid: /^[a-f\d]{64}$/i.test(fieldRefreshRequestBaseHash), baseHashMatchesCurrentDisk: fieldRefreshRequestBaseHash === diskHash },
      toastCapture,
      docxRecognition: {
        markerCount: markers.length,
        markerHasProjectName: markers.includes('project.name'),
        fieldCount: fields.length,
        fieldHasProjectName: fields.some((field) => field.key === 'project.name'),
        paragraphHasLiteralProjectNameMarker: paragraphs.some((paragraph) => paragraph.includes('{{project.name}}')),
      },
      disk: { sha256: diskHash, anchors: bindings?.anchors.length ?? null, rows: bindings?.rows.length ?? null },
      lifecycle,
      browserErrors: errors.slice(-4).map(error => error.slice(0, 300)),
    };
  };
  const ribbonButton = (frame: any, command: string) => frame.locator(`[data-flux-command="${command}"]`);
  /** Нажать кнопку ленты; если редактор переключил вкладку (курсор в таблице), сначала выбрать вкладку Flux */
  const ribbonClick = async (frame: any, command: string) => {
    if (await ribbonButton(frame, command).count() === 0) await frame.locator('button.ribbon-tab[aria-label="Flux"], .ribbon-tabs button[aria-label="Flux"]').first().evaluate((el: any) => el.click());
    // Узкая лента (рядом открыта панель) прячет часть кнопок под полосой прокрутки: нажимаем средствами DOM, а мышью — в open() и в снимке ленты
    await ribbonButton(frame, command).evaluate((el: any) => el.click());
  };
  const open = async (name: string, title: string) => {
    await page.goto(`${BASE}/#/windows-file?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(name)}`, { waitUntil: 'domcontentloaded' });
    const frame = page.frameLocator(`iframe[title="${title}"]`);
    await frame.locator('body').waitFor({ state: 'visible', timeout: 60000 });
    await page.getByText('Открывается локальный редактор…').waitFor({ state: 'detached', timeout: 90000 });
    // Команда «Поля проекта» существует на ленте Office и открывает панель; её кнопка «Закрыть панель» возвращает к выборке данных.
    await ribbonClick(frame, 'project-fields');
    await panel().waitFor({ timeout: 15000 });
    const projectDataPanel = page.getByRole('complementary', { name: 'Данные проекта' });
    await projectDataPanel.waitFor({ timeout: 15000 });
    await projectDataPanel.getByRole('button', { name: 'Закрыть панель' }).click();
    await panel().getByLabel('Проект для данных Flux').waitFor({ timeout: 15000 });
    return frame;
  };
  const chooseProject = async () => {
    const picker = panel().getByLabel('Проект для данных Flux');
    await picker.waitFor({ timeout: 15000 });
    await picker.selectOption(fixture.projectId);
    await panel().getByRole('button', { name: /1\. Выборка/ }).waitFor();
  };
  const changeFanHighPower = async (value: string) => {
    const rows = await api('POST', '/api/project-data/office/query', { projectId: fixture.projectId, query: { entity: 'element', columns: ['name', 'param:Вентиляция|Мощность двигателя'], filters: [], sort: [], limit: 50, excludedEntityIds: [] } });
    const fan = rows.json?.rows?.find((row: any) => row.values?.name?.value === 'FAN_HIGH');
    const id = fan?.entityId ? decodeURIComponent(String(fan.entityId).split(':').at(-1) || '') : '';
    const oldValue = String(fan?.values?.['param:Вентиляция|Мощность двигателя']?.value ?? '');
    if (!id) throw new Error('В тестовом проекте нет FAN_HIGH для сценария смены источника');
    const changed = await api('POST', `/api/equipment/component/${encodeURIComponent(id)}/override`, { group: 'Вентиляция', key: 'Мощность двигателя', value });
    if (changed.status !== 200) throw new Error(`Не удалось изменить FAN_HIGH через API: ${changed.status}`);
    return oldValue;
  };
  const fillFromProject = async (label: string, beforePreview?: () => Promise<void>) => {
    await page.getByRole('button', { name: /1\. Выборка/ }).click();
    await panel().getByRole('button', { name: 'Обновить выборку' }).click();
    check(`${label}: выборка показывает оборудование проекта`, await waitFor(async () => (await panel().getByRole('grid', { name: 'Предпросмотр выборки' }).getByText(/FAN_HIGH/).count()) > 0, 20000));
    await panel().getByRole('checkbox', { name: 'Выбрать все строки' }).check();
    await page.getByRole('button', { name: /3\. Обновление/ }).click();
    check(`${label}: на вкладке «Обновление» нет выпуска ревизий для файла Проводника`, await panel().getByRole('button', { name: /Выпустить/ }).count() === 0 && await panel().getByText(/Ревизии файла|Выпущенная ревизия/i).count() === 0);
    await beforePreview?.();
    await panel().getByRole('button', { name: 'Предпросмотр заполнения' }).click();
    const confirm = panel().getByRole('button', { name: 'Подтвердить и заполнить' });
    const planned = await confirm.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false);
    check(`${label}: предпросмотр построен по присланным байтам`, planned, await panel().getByRole('alert').allTextContents().catch(() => []));
    return confirm;
  };
  const applied = async (confirm: any, label: string) => {
    await waitFor(async () => confirm.isEnabled(), 10000);
    await confirm.click();
    check(`${label}: заполнение подтверждено без ошибок`, await waitFor(async () => (await panel().getByRole('status').filter({ hasText: /Обновлено значений/ }).count()) > 0, 30000), await panel().getByRole('alert').allTextContents().catch(() => []));
    check(`${label}: ошибок панели нет`, (await panel().getByRole('alert').count()) === 0, await panel().getByRole('alert').allTextContents());
  };

  /** Группы и кнопки вкладки Flux (ТЗ §3): состав, порядок и серые «Скоро» */
  const checkRibbon = async (frame: any, label: string) => {
    // Без панели ленте хватает ширины; в таблице Word сам переключает вкладку на «Макет», поэтому вкладку выбираем явно
    await page.getByRole('button', { name: 'Закрыть Flux' }).click();
    await frame.getByRole('button', { name: 'Flux', exact: true }).click();
    const groups = await frame.locator('[data-flux-group]').evaluateAll((els: any[]) => els.map((el) => ({
      name: el.getAttribute('data-flux-group'),
      buttons: [...el.querySelectorAll('[data-flux-command]')].map((b: any) => ({ id: b.getAttribute('data-flux-command'), label: b.getAttribute('aria-label'), disabled: b.disabled, soon: !!b.querySelector('.flux-soon') })),
    })));
    check(`${label}: группы ленты — Переводчик, Данные, Шаблоны, Документ`, JSON.stringify(groups.map((g: any) => g.name)) === JSON.stringify(['Переводчик', 'Данные', 'Шаблоны', 'Документ']), groups.map((g: any) => g.name));
    const labels = groups.flatMap((g: any) => g.buttons.map((b: any) => b.label));
    check(`${label}: кнопки ленты по ТЗ §3 и §13`, JSON.stringify(labels) === JSON.stringify(['Переводчик', 'Английская версия', 'Поля проекта', 'Шаблоны', 'Закреплённые', 'Сохранить как', 'Обновить шаблон', 'Обновить данные', 'Выпустить', 'Исходная шапка', 'Выгрузить']), labels);
    const byId = Object.fromEntries(groups.flatMap((g: any) => g.buttons).map((b: any) => [b.id, b]));
    check(`${label}: «Исходная шапка» неактивна без шаблона, подсказка «У файла нет шаблона»`, byId['reset-header']?.disabled === true && (await ribbonButton(frame, 'reset-header').getAttribute('title')) === 'У файла нет шаблона');
    check(`${label}: «Поля проекта» и «Английская версия» для файла Проводника неактивны`, byId['project-fields']?.disabled === false && byId['english']?.disabled === true, [byId['project-fields'], byId['english']]);
    check(`${label}: «Выпустить» для файла Проводника неактивна`, byId['issue']?.disabled === true);
    check(`${label}: на ленте нет строки операторов`, (await frame.locator('[data-flux-command]').count()) === labels.length);
    await shot('ribbon');
  };
  const dialog = (name: string) => page.getByRole('dialog', { name });
  /** «Сохранить как» → «Шаблоны» → «Открыть» → сохранить схему → «Исходная шапка» */
  const templateFlow = async (frame: any, label: string, file: string) => {
    await ribbonClick(frame, 'save-template');
    await dialog('Сохранить шапку как шаблон').getByLabel('Название шаблона').fill(`Шапка ${label}`);
    await dialog('Сохранить шапку как шаблон').getByLabel('Для всех').check();
    await dialog('Сохранить шапку как шаблон').getByRole('button', { name: 'Сохранить', exact: true }).click();
    check(`${label}: «Сохранить как» создаёт общий шаблон`, await waitFor(async () => (await dialog('Сохранить шапку как шаблон').count()) === 0) && await waitFor(async () => (await panel().getByRole('status').filter({ hasText: `Шаблон «Шапка ${label}» сохранён` }).count()) > 0), await panel().allTextContents());
    await ribbonClick(frame, 'templates');
    check(`${label}: в окне «Шаблоны» виден общий шаблон`, await waitFor(async () => (await dialog('Шаблоны шапки').getByText(`Шапка ${label}`).count()) > 0) && (await dialog('Шаблоны шапки').getByText('Общий').count()) > 0);
    await shot(`templates-${label}`);
    await dialog('Шаблоны шапки').locator('li', { hasText: `Шапка ${label}` }).getByRole('button', { name: 'Открыть' }).click();
    check(`${label}: шаблон сопоставлен с документом и ждёт сохранения схемы`, await waitFor(async () => (await panel().getByText(/Шаблон сопоставлен с этим документом/).count()) > 0, 20000), await panel().allTextContents());
    await panel().getByRole('button', { name: /Сохранить схему/ }).click();
    const applied = await waitFor(async () => !!(await readOfficeBindings(await disk(file)))?.template, 45000);
    const bindings = await readOfficeBindings(await disk(file));
    check(`${label}: в части Flux файла лежат templateId и снимок схемы с датой`, applied && !!bindings?.template?.templateId && !Number.isNaN(Date.parse(bindings!.template!.appliedAt)) && bindings!.template!.anchors.length === bindings!.anchors.length, bindings?.template);
    check(`${label}: «Исходная шапка» стала активной`, await waitFor(async () => (await ribbonButton(frame, 'reset-header').isEnabled())), await ribbonButton(frame, 'reset-header').getAttribute('title'));
    // Правка шапки после шаблона: текст рядом с меткой, записанный той же записью схемы
    await panel().getByRole('button', { name: /2\. Поля и шапка/ }).click();
    await panel().getByRole('button', { name: 'Добавить текст после части 1' }).first().click();
    await panel().getByLabel('Текст заголовка 2').first().fill('ПРАВКА_ПОСЛЕ_ШАБЛОНА');
    await panel().getByRole('button', { name: /Сохранить схему/ }).click();
    const edited = await waitFor(async () => JSON.stringify((await readOfficeBindings(await disk(file)))?.anchors) !== JSON.stringify(bindings?.anchors), 45000);
    const fileText = async () => file.endsWith('.docx') ? diskText(file, 'word/document.xml') : diskXml(file);
    check(`${label}: текст правки попал в документ`, await waitFor(async () => (await fileText()).includes('ПРАВКА_ПОСЛЕ_ШАБЛОНА'), 30000));
    check(`${label}: правка шапки после шаблона записана, снимок шаблона не изменился`, edited && JSON.stringify((await readOfficeBindings(await disk(file)))?.template?.anchors) === JSON.stringify(bindings?.template?.anchors));
    // «Исходная шапка»: возврат к снимку без переоткрытия
    const frameBefore = await page.locator('iframe').first().evaluate((el: any) => { el.__same = true; return true; });
    await ribbonClick(frame, 'reset-header');
    await page.getByRole('button', { name: 'Вернуть', exact: true }).click();
    const restored = await waitFor(async () => { const b = await readOfficeBindings(await disk(file)); return !!b && JSON.stringify(b.anchors) === JSON.stringify(b.template?.anchors); }, 45000);
    const after = await readOfficeBindings(await disk(file));
    check(`${label}: «Исходная шапка» вернула шапку к снимку шаблона, шаблон остался применённым`, restored && after?.template?.templateId === bindings?.template?.templateId, { anchors: after?.anchors, snapshot: after?.template?.anchors });
    check(`${label}: правка шапки после шаблона отброшена и в самом документе`, await waitFor(async () => !(await fileText()).includes('ПРАВКА_ПОСЛЕ_ШАБЛОНА'), 30000));
    check(`${label}: возврат не переоткрывал редактор и не тронул данные в строках`, frameBefore && await page.locator('iframe').first().evaluate((el: any) => el.__same === true) && (after?.rows.length || 0) === (bindings?.rows.length || 0) && JSON.stringify(after?.rows) === JSON.stringify(bindings?.rows));
    return bindings;
  };

  /** «Вставить все» и выгрузка XLSX / CSV из выборки (перенос возможностей старой панели) */
  const insertAndExport = async (frame: any, label: string, where: () => Promise<void>, inserted: () => Promise<boolean>) => {
    await where();
    await panel().getByRole('button', { name: /1\. Выборка/ }).click();
    await panel().getByRole('button', { name: 'Обновить выборку' }).click();
    await panel().getByRole('grid', { name: 'Предпросмотр выборки' }).getByText(/FAN_HIGH/).first().waitFor({ timeout: 30000 });
    await page.evaluate(() => { (window as any).__cmdResults = []; window.addEventListener('message', (e) => { const m: any = e.data; if (m?.payload?.channel === 'flux:command-result') (window as any).__cmdResults.push(m.payload.args[0]); }); });
    await panel().getByRole('button', { name: 'Вставить все' }).click();
    check(`${label}: «Вставить все» вставила таблицу выборки в документ`, await waitFor(async () => (await panel().getByRole('status').filter({ hasText: 'Таблица вставлена' }).count()) > 0, 30000) && await waitFor(inserted, 30000), { status: await panel().getByRole('status').allTextContents(), results: await page.evaluate(() => (window as any).__cmdResults), toast: ((await page.locator('body').innerText()).match(/[^\n]*(Выделите|только для чтения|Допускается|не вставлена|не ответил)[^\n]*/g) || []), cell: await frame.locator('body').evaluate(() => { const wb = (window as any).__fluxSheets?.univerRef?.current?.univerAPI?.getActiveWorkbook?.(); return wb?.getActiveCell?.()?.getA1Notation?.() ?? 'нет активной ячейки'; }).catch((e: any) => String(e)) });
    await ribbonClick(frame, 'export');
    const exportDialog = dialog('Выгрузить: Оборудование');
    await exportDialog.waitFor({ timeout: 10000 });
    const [xlsx] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), exportDialog.getByRole('button', { name: 'XLSX', exact: true }).click()]);
    const namesAfterXlsx: string[] = await page.evaluate(() => (window as any).__downloadNames || []);
    check(`${label}: выгрузка XLSX скачала файл «Flux — Оборудование — <дата>.xlsx»`, /^Flux — Оборудование — \d{2}-\d{2}-\d{4}\.xlsx$/.test(namesAfterXlsx.at(-1) || ''), namesAfterXlsx);
    const xlsxZip = await JSZip.loadAsync(await readFile((await xlsx.path())!));
    // SheetJS кладёт строки либо в sharedStrings, либо в сам лист — смотрим оба места
    const sharedStrings = `${await xlsxZip.file('xl/sharedStrings.xml')?.async('string') || ''}${await xlsxZip.file('xl/worksheets/sheet1.xml')?.async('string') || ''}`;
    check(`${label}: в XLSX выгрузки есть данные оборудования`, sharedStrings.includes('FAN_HIGH') && sharedStrings.includes('FAN_LOW'), { files: Object.keys(xlsxZip.files), strings: sharedStrings.slice(0, 300) });
    const [csv] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), exportDialog.getByRole('button', { name: 'CSV', exact: true }).click()]);
    const csvText = await readFile((await csv.path())!, 'utf8');
    const namesAfterCsv: string[] = await page.evaluate(() => (window as any).__downloadNames || []);
    check(`${label}: выгрузка CSV названа «Flux — Оборудование — <дата>.csv»`, /^Flux — Оборудование — \d{2}-\d{2}-\d{4}\.csv$/.test(namesAfterCsv.at(-1) || ''), namesAfterCsv);
    check(`${label}: в CSV заголовки и строки оборудования`, csvText.split('\n').filter(Boolean).length >= 3 && csvText.includes('FAN_HIGH') && csvText.includes('FAN_LOW'), { lines: csvText.split('\n').length, tail: csvText.slice(-300) });
    await exportDialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
  };

  try {
    const login = await api('POST', '/api/login', fixture.admin);
    token = String(login.json?.token || '');
    if (login.status !== 200 || !token) throw new Error('Не удалось войти в одноразовый стенд теста.');
    await freshPage();

    console.log('\n1. DOCX из Проводника: новая панель Flux, привязка, предпросмотр, заполнение');
    const docs = await open('one.docx', 'Flux Office — Документ');
    check('открыта новая панель Flux Office (не прежняя)', await panel().count() === 1 && await panel().getByRole('button', { name: 'Источники и перевод' }).count() === 0);
    check('кнопки выпуска ревизии в панели нет', await panel().getByRole('button', { name: /Выпустить/ }).count() === 0);
    await chooseProject();
    const editor = docs.locator('.ProseMirror').first();
    await editor.waitFor({ timeout: 20000 });
    await editor.locator('table tr').first().locator('td,th').nth(1).click();
    await page.getByRole('button', { name: /2\. Поля и шапка/ }).click();
    await panel().getByLabel('Найти поле Flux').fill('Расход воздуха');
    await panel().getByRole('button', { name: /Расход воздуха/ }).first().click();
    await waitFor(async () => panel().getByRole('button', { name: 'Привязать поле' }).isEnabled());
    await panel().getByRole('button', { name: 'Привязать поле' }).click();
    check('привязка записана в сам файл (customXml) без переоткрытия', await waitFor(async () => ((await readOfficeBindings(await disk('one.docx')))?.anchors.length || 0) > 0, 30000), await panel().getByRole('alert').allTextContents().catch(() => []));
    check('редактор остался на месте: документ не перезапускался', await docs.locator('.ProseMirror').first().isVisible());
    await panel().getByRole('button', { name: /1\. Выборка/ }).click();
    await panel().getByRole('button', { name: 'Обновить выборку' }).click();
    await docs.locator('.ProseMirror').first().click();
    await ribbonClick(docs, 'project-fields');
    const projectFields = page.getByRole('complementary', { name: 'Данные проекта' });
    const insertProjectFieldButton = projectFields.getByRole('button', { name: 'Вставить' }).first();
    await insertProjectFieldButton.waitFor({ timeout: 15000 });
    await evaluateBrowserCode(page, `(() => {
      const w = window;
      w.__fluxFieldRefreshToastMessages = [];
      const seen = new WeakSet();
      document.querySelectorAll('.fx-pop').forEach(element => seen.add(element));
      const collect = root => {
        const candidates = [];
        if (root instanceof Element && root.matches('.fx-pop')) candidates.push(root);
        root.querySelectorAll?.('.fx-pop').forEach(element => candidates.push(element));
        for (const element of candidates) {
          if (seen.has(element)) continue;
          seen.add(element);
          const message = element.querySelector('p')?.textContent || '';
          const icon = element.querySelector('svg')?.getAttribute('class') || '';
          const tone = icon.includes('text-rose-') ? 'error' : icon.includes('text-emerald-') ? 'success' : 'info';
          w.__fluxFieldRefreshToastMessages.push({ tone, message: message.slice(0, 200) });
          if (w.__fluxFieldRefreshToastMessages.length > 6) w.__fluxFieldRefreshToastMessages.shift();
        }
      };
      const observer = new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => { if (node instanceof Element) collect(node); })));
      observer.observe(document.body, { childList: true, subtree: true });
      w.__fluxFieldRefreshToastStop = () => observer.disconnect();
    })()`);
    await insertProjectFieldButton.click();
    const projectNameMarker = '{{project.name}}';
    const projectNameInserted = await waitFor(async () => (await docs.locator('.ProseMirror').first().innerText().catch(() => '')).includes(projectNameMarker), 15000);
    if (!projectNameInserted) {
      const setupDetails = { phase: 'project-field-insert', expectedKey: 'project.name', editorHasExactMarker: false, ...(await fieldRefreshFailureDetails(docs, false)) };
      console.error('OFFICE_FIELD_REFRESH_DIAGNOSTIC', JSON.stringify(setupDetails));
      await writeFile('/tmp/office-explorer-field-refresh-diagnostic.json', JSON.stringify(setupDetails, null, 2), { mode: 0o600 });
      check('локальная панель вставила точное поле проекта в DOCX', false, setupDetails);
      throw fieldRefreshDone;
    }
    check('локальная панель вставила точное поле проекта в DOCX', true);
    const projectFieldEditor = docs.locator('.ProseMirror').first();
    await projectFieldEditor.click();
    await page.keyboard.press('Control+s');
    const projectNameSaved = await waitFor(async () => {
      const savedBytes = await disk('one.docx');
      const [savedMarkers, savedFields] = await Promise.all([listDocxMarkers(savedBytes), listDocxFields(savedBytes)]);
      return savedMarkers.includes('project.name') || savedFields.some((field) => field.key === 'project.name');
    }, 30000);
    if (!projectNameSaved) {
      const setupDetails = { phase: 'project-field-save', expectedKey: 'project.name', editorHasExactMarker: true, ...(await fieldRefreshFailureDetails(docs, false)) };
      console.error('OFFICE_FIELD_REFRESH_DIAGNOSTIC', JSON.stringify(setupDetails));
      await writeFile('/tmp/office-explorer-field-refresh-diagnostic.json', JSON.stringify(setupDetails, null, 2), { mode: 0o600 });
      check('сохранённый DOCX распознаёт поле project.name', false, setupDetails);
      throw fieldRefreshDone;
    }
    check('сохранённый DOCX распознаёт поле project.name', true);
    await projectFieldEditor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('REFRESH_KEEP');
    await ribbonClick(docs, 'project-fields');
    if (fieldRefreshOnly && failures) throw fieldRefreshDone;
    await page.getByRole('button', { name: 'Обновить поля' }).click();
    let refreshToastObserved = false;
    const refreshPassed = await waitFor(async () => {
      const refreshToastShown = (await page.getByText(/Обновлено полей:/).count()) > 0;
      if (refreshToastShown) refreshToastObserved = true;
      return refreshToastShown
        && (await docs.locator('.ProseMirror').first().innerText().catch(() => '')).includes('REFRESH_KEEP')
        && (await diskText('one.docx', 'word/document.xml')).includes('REFRESH_KEEP');
    }, 45000);
    const refreshDetails = refreshPassed ? undefined : await fieldRefreshFailureDetails(docs, refreshToastObserved);
    if (refreshDetails) {
      const diagnostic = JSON.stringify(refreshDetails);
      console.error('OFFICE_FIELD_REFRESH_DIAGNOSTIC', diagnostic);
      await writeFile('/tmp/office-explorer-field-refresh-diagnostic.json', JSON.stringify(refreshDetails, null, 2), { mode: 0o600 });
    }
    check('обновление полей сохранило несохранённую правку и перечитало DOCX', refreshPassed, refreshDetails);
    if (fieldRefreshOnly && !refreshPassed) throw fieldRefreshDone;
    await page.getByRole('button', { name: 'Закрыть панель' }).click();
    const before = await disk('one.docx');
    const originalFanPower = await changeFanHighPower('1500');
    try {
      await panel().getByRole('button', { name: 'Обновить выборку' }).click();
      const fieldRefreshSourcePassed = await waitFor(async () =>
        (await panel().getByRole('status').filter({ hasText: 'Данные обновлены' }).count()) > 0
        && (await panel().getByRole('grid', { name: 'Предпросмотр выборки' }).getByText('1500').count()) > 0, 20000);
      if (!fieldRefreshSourcePassed) {
        const fieldRefreshSourceState = await evaluateBrowserCode(page, `(() => {
          const statusText = Array.from(document.querySelectorAll('[role="status"]')).map(element => element.textContent || '').join(' ').slice(-300);
          const grid = document.querySelector('[role="grid"][aria-label="Предпросмотр выборки"]');
          const gridText = grid?.textContent || '';
          return {
            updatedStatusVisible: statusText.includes('Данные обновлены'),
            gridRowCount: grid?.querySelectorAll('[role="row"]').length ?? null,
            has900: gridText.includes('900'),
            has1200: gridText.includes('1200'),
            has1500: gridText.includes('1500'),
          };
        })()`).catch(() => ({ updatedStatusVisible: false, gridRowCount: null, has900: false, has1200: false, has1500: false }));
        const fieldRefreshSourceDetails = { phase: 'source-409-preview', fieldRefreshSourceState, recentServerCalls: serverCalls.slice(-6).map(call => call.slice(0, 240)), ...(await fieldRefreshFailureDetails(docs, false)) };
        console.error('OFFICE_FIELD_REFRESH_DIAGNOSTIC', JSON.stringify(fieldRefreshSourceDetails));
        await writeFile('/tmp/office-explorer-field-refresh-diagnostic.json', JSON.stringify(fieldRefreshSourceDetails, null, 2), { mode: 0o600 });
      }
      check('открытый DOCX перечитал изменившийся источник после 409', fieldRefreshSourcePassed);
      if (fieldRefreshOnly) throw fieldRefreshDone;
      const staleConfirm = await fillFromProject('DOCX после изменения источника', async () => {
        await changeFanHighPower('1600');
      });
      check('409 предпросмотра перестроил свежий план и оставил подтверждение человеку', await staleConfirm.isVisible());
      check('свежий предпросмотр не записывает файл до подтверждения', before.equals(await disk('one.docx')));
    } finally {
      await changeFanHighPower(originalFanPower);
    }
    await panel().getByRole('button', { name: /1\. Выборка/ }).click();
    await panel().getByRole('button', { name: 'Обновить выборку' }).click();
    await waitFor(async () => (await panel().getByRole('status').filter({ hasText: 'Данные обновлены' }).count()) > 0, 20000);
    const confirm = await fillFromProject('DOCX');
    check('предпросмотр не меняет файл на диске', before.equals(await disk('one.docx')));
    await applied(confirm, 'DOCX');
    await shot('docx');

    console.log('\n1а. Лента Flux, шаблоны, «Исходная шапка», «Вставить все», выгрузка (DOCX из Проводника)');
    await checkRibbon(docs, 'DOCX');
    await templateFlow(docs, 'DOCX', 'one.docx');
    check('байты DOCX на диске содержат значения источника 900 и 1200 (панель записала их сама)', await waitFor(async () => { const xml = await diskText('one.docx', 'word/document.xml'); return /900/.test(xml) && /1200/.test(xml); }, 30000));
    // Правка после схемы: редактор сохраняет пакет, открытый до записи схемы, и без переноса часть Flux пропала бы
    await docs.locator('.ProseMirror').first().click();
    await page.keyboard.press('Control+End'); await page.keyboard.type('EDIT_AFTER_FLUX');
    await page.keyboard.press('Control+s');
    check('правка после привязки попала в файл', await waitFor(async () => (await diskText('one.docx', 'word/document.xml')).includes('EDIT_AFTER_FLUX'), 30000));
    const wordBindings = await readOfficeBindings(await disk('one.docx'));
    check('сохранение из редактора не потеряло схему и строки Flux', (wordBindings?.anchors.length || 0) > 0 && (wordBindings?.rows.length || 0) >= 2, wordBindings && { anchors: wordBindings.anchors.length, rows: wordBindings.rows.length });
    const wordXml = await diskText('one.docx', 'word/document.xml');
    check('ручная строка и текст рядом с таблицей сохранены', wordXml.includes('Ручная строка') && wordXml.includes('Текст после поля'));
    await insertAndExport(docs, 'DOCX', async () => { await docs.locator('.ProseMirror').first().click(); await page.keyboard.press('Control+End'); },
      async () => (await docs.locator('.ProseMirror').first().innerText()).includes('FAN_HIGH'));

    console.log('\n2. XLSX из Проводника: сеанс локальной книги, привязка, заполнение, сохранение');
    await freshPage();
    const sheets = await open('one.xlsx', 'Flux Office — Таблица');
    check('открыта новая панель Flux Office', await panel().count() === 1 && await panel().getByRole('button', { name: 'Источники и перевод' }).count() === 0);
    check('кнопки выпуска ревизии в панели нет', await panel().getByRole('button', { name: /Выпустить/ }).count() === 0);
    await chooseProject();
    check('книга загружена в редактор', await waitFor(async () => sheets.locator('body').evaluate(() => {
      const api = (window as any).__fluxSheets?.univerRef?.current?.univerAPI;
      return api?.getActiveWorkbook?.()?.getSheets?.().find((sheet: any) => sheet.getSheetName() === 'Перечень')?.getRange('A5')?.getValues?.()?.[0]?.[0] === 'MANUAL_KEEP';
    }), 45000));
    const nameBox = sheets.locator('input.univer-box-border').first();
    // Выбор ячейки сообщает дополнению только щелчок по сетке
    const canvas = sheets.locator('canvas[id^="univer-sheet-main-canvas_"]').first();
    await canvas.click({ position: { x: 45, y: 20 }, timeout: 10000 });
    await nameBox.fill('A1'); await nameBox.press('Enter');
    await page.getByRole('button', { name: /2\. Поля и шапка/ }).click();
    await panel().getByLabel('Найти поле Flux').fill('Расход воздуха');
    await panel().getByRole('button', { name: /Расход воздуха/ }).first().click();
    await waitFor(async () => panel().getByRole('button', { name: 'Привязать поле' }).isEnabled());
    await panel().getByRole('button', { name: 'Привязать поле' }).click();
    check('привязка записана в файл XLSX и сеанс книги принял новую версию', await waitFor(async () => ((await readOfficeBindings(await disk('one.xlsx')))?.anchors.length || 0) > 0, 45000), await panel().getByRole('alert').allTextContents().catch(() => []));
    const xlsxConfirm = await fillFromProject('XLSX');
    await applied(xlsxConfirm, 'XLSX');
    await shot('xlsx');
    await checkRibbon(sheets, 'XLSX');
    await templateFlow(sheets, 'XLSX', 'one.xlsx');
    check('байты XLSX на диске содержат значения источника 900 и 1200 и ручную ячейку (панель записала их сама)', await waitFor(async () => { const xml = await diskXml('one.xlsx'); return /900/.test(xml) && /1200/.test(xml) && xml.includes('MANUAL_KEEP'); }, 45000));
    // Правка после схемы: сеанс книги пишет свою копию и не должен потерять часть Flux
    await nameBox.fill('H9'); await nameBox.press('Enter');
    await canvas.focus();
    await page.keyboard.type('EDIT_AFTER_FLUX'); await page.keyboard.press('Enter');
    await page.keyboard.press('Control+s');
    check('правка после привязки попала в файл', await waitFor(async () => (await diskXml('one.xlsx')).includes('EDIT_AFTER_FLUX'), 45000));
    const sheetBindings = await readOfficeBindings(await disk('one.xlsx'));
    check('сохранение книги не потеряло схему и строки Flux', (sheetBindings?.anchors.length || 0) > 0 && (sheetBindings?.rows.length || 0) >= 2, sheetBindings && { anchors: sheetBindings.anchors.length, rows: sheetBindings.rows.length });
    check('книга остаётся открытой и сохраняемой: повторное сохранение без конфликта', await (async () => {
      await page.keyboard.press('Control+s');
      await page.waitForTimeout(1500);
      return (await page.getByText(/Файл изменён вне этого окна/).count()) === 0;
    })());
    await insertAndExport(sheets, 'XLSX', async () => { await nameBox.fill('A30'); await nameBox.press('Enter'); },
      async () => sheets.locator('body').evaluate(() => {
        const sheet = (window as any).__fluxSheets?.univerRef?.current?.univerAPI?.getActiveWorkbook?.()?.getActiveSheet?.();
        return JSON.stringify(sheet?.getRange(0, 0, 80, 26).getValues?.() || []).includes('FAN_HIGH');
      }));

    console.log('\n3. Общее');
    check('ничего не создано на сервере как файл проекта', !serverCalls.some((call) => /POST \/api\/files|office-state/.test(call)), serverCalls);
    check('панель вызывала только маршруты по содержимому', serverCalls.some((call) => /office-local\/state/.test(call)) && serverCalls.some((call) => /office-local\/preview/.test(call)) && serverCalls.some((call) => /office-local\/confirm/.test(call)), [...new Set(serverCalls)]);
    check('на диске нет временных файлов записи', !(await readdir(desktop)).some((name) => name.startsWith('.flux-')), await readdir(desktop));
    check('ошибок браузера нет', errors.length === 0, errors);
    check('ответов сервера с ошибкой нет', failed.length === 0, failed);
  } catch (error) {
    if (error === fieldRefreshDone) { /* Narrow diagnostic profile stops after the target assertions. */ }
    else {
      failures++; console.error('✗ прогон прерван', error);
      await page.screenshot({ path: '/tmp/office-explorer-failure.png', fullPage: true }).catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
    await sessions.dispose().catch(() => {});
    files.close();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
  console.log(failures ? `\nФайлы Проводника: провалов ${failures}` : '\nФайлы Проводника: всё прошло');
  process.exit(failures ? 1 : 0);
})();
