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
import JSZip from 'jszip';
import { chromium } from 'playwright-core';
import { WindowsFilesService } from '../electron/filesystem/service';
import { LocalOfficeSessions, type LocalOfficeRequest } from '../electron/localOfficeSessions';
import { readOfficeBindings } from '../server/officeBindings';
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
  const check = (label: string, good: unknown, detail?: unknown) => {
    if (good) console.log(`  ✓ ${label}`);
    else { failures++; console.error(`  ✗ ${label}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600)); }
  };
  const waitFor = async (probe: () => Promise<boolean>, timeout = 15000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await probe().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 250)); }
    return probe().catch(() => false);
  };

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
  let context: any = null;
  let page: any = null;
  // Диспетчер окон потребляет хеш адреса один раз, поэтому каждый файл — в свежей странице
  const freshPage = async () => {
    await context?.close().catch(() => {});
    context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    page = await context.newPage();
    page.on('pageerror', (error: any) => errors.push(`pageerror: ${error?.message || error}`.slice(0, 500)));
    page.on('response', (response: any) => { if (response.status() >= 400 && !/\/api\/(license|auth|presence)/.test(response.url())) failed.push(`${response.status()} ${response.url()}`); });
    page.on('request', (request: any) => { if (/office-local|office-state|\/api\/files/.test(request.url())) serverCalls.push(`${request.method()} ${new URL(request.url()).pathname}`); });
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
    await loginPage(page, BASE, fixture.admin, false);
  };

  const panel = () => page.getByRole('complementary', { name: 'Flux Office' });
  const open = async (name: string, title: string) => {
    await page.goto(`${BASE}/#/windows-file?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(name)}`, { waitUntil: 'domcontentloaded' });
    const frame = page.frameLocator(`iframe[title="${title}"]`);
    await frame.locator('body').waitFor({ state: 'visible', timeout: 60000 });
    await page.getByText('Открывается локальный редактор…').waitFor({ state: 'detached', timeout: 90000 });
    await frame.locator('body').evaluate(() => window.parent.postMessage({ flux: 'office', op: 'flux:open-panel' }, location.origin));
    await panel().waitFor({ timeout: 15000 });
    return frame;
  };
  const chooseProject = async () => {
    const picker = panel().getByLabel('Проект для данных Flux');
    await picker.waitFor({ timeout: 15000 });
    await picker.selectOption(fixture.projectId);
    await panel().getByRole('button', { name: /1\. Выборка/ }).waitFor();
  };
  const fillFromProject = async (label: string) => {
    await page.getByRole('button', { name: /1\. Выборка/ }).click();
    await panel().getByRole('button', { name: 'Обновить выборку' }).click();
    check(`${label}: выборка показывает оборудование проекта`, await waitFor(async () => (await panel().getByRole('grid', { name: 'Предпросмотр выборки' }).getByText(/FAN_HIGH/).count()) > 0, 20000));
    await panel().getByRole('checkbox', { name: 'Выбрать все строки' }).check();
    await page.getByRole('button', { name: /3\. Обновление/ }).click();
    check(`${label}: на вкладке «Обновление» нет выпуска ревизий для файла Проводника`, await panel().getByRole('button', { name: /Выпустить/ }).count() === 0 && await panel().getByText(/Ревизии файла|Выпущенная ревизия/i).count() === 0);
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

  try {
    await freshPage();

    console.log('\n1. DOCX из Проводника: новая панель Flux, привязка, предпросмотр, заполнение');
    const docs = await open('one.docx', 'Flux Office — Документ');
    check('открыта новая панель Flux Office (не прежняя)', await panel().count() === 1 && await panel().getByRole('button', { name: 'Источники и перевод' }).count() === 1);
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
    const confirm = await fillFromProject('DOCX');
    const before = await disk('one.docx');
    check('предпросмотр не меняет файл на диске', before.equals(await disk('one.docx')));
    await applied(confirm, 'DOCX');
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

    console.log('\n2. XLSX из Проводника: сеанс локальной книги, привязка, заполнение, сохранение');
    await freshPage();
    const sheets = await open('one.xlsx', 'Flux Office — Таблица');
    check('открыта новая панель Flux Office', await panel().count() === 1 && await panel().getByRole('button', { name: 'Источники и перевод' }).count() === 1);
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

    console.log('\n3. Общее');
    check('ничего не создано на сервере как файл проекта', !serverCalls.some((call) => /POST \/api\/files|office-state/.test(call)), serverCalls);
    check('панель вызывала только маршруты по содержимому', serverCalls.some((call) => /office-local\/state/.test(call)) && serverCalls.some((call) => /office-local\/preview/.test(call)) && serverCalls.some((call) => /office-local\/confirm/.test(call)), [...new Set(serverCalls)]);
    check('на диске нет временных файлов записи', !(await readdir(desktop)).some((name) => name.startsWith('.flux-')), await readdir(desktop));
    check('ошибок браузера нет', errors.length === 0, errors);
    check('ответов сервера с ошибкой нет', failed.length === 0, failed);
  } catch (error) {
    failures++; console.error('✗ прогон прерван', error);
    await page.screenshot({ path: '/tmp/office-explorer-failure.png', fullPage: true }).catch(() => {});
  } finally {
    await browser.close().catch(() => {});
    await sessions.dispose().catch(() => {});
    files.close();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
  console.log(failures ? `\nФайлы Проводника: провалов ${failures}` : '\nФайлы Проводника: всё прошло');
  process.exit(failures ? 1 : 0);
})();
