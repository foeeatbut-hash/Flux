import { testCredentials } from './testCredentials';
/**
 * Живой сценарий архива: создать ZIP из Проводника, затем править копию через
 * экран Архивов и сверить состав, пароль и неизменность исходного файла.
 * Запуск при поднятом сервере: npx tsx scripts/test-archives-live.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loginPage } from './officeHarness';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = testCredentials();
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
let token = '';

async function api(method: string, path: string, body?: unknown, raw = false): Promise<{ status: number; json: any; bytes: Buffer }> {
  const response = await fetch(BASE + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(raw ? { 'Content-Type': 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: raw ? body as Buffer : body === undefined ? undefined : JSON.stringify(body),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(bytes.toString('utf8')); } catch { /* Ответ может быть файлом */ }
  return { status: response.status, json, bytes };
}

(async () => {
  let browser: any;
  const createdFiles: string[] = [];
  const createdFolders: string[] = [];
  const errors: string[] = [];
  try {
    const login = await api('POST', '/api/login', LOGIN);
    token = login.json?.token || '';
    assert.ok(token, 'вход выполнен');
    const suffix = randomUUID().slice(0, 8);
    const folder = await api('POST', '/api/folders', { name: `__архивная проверка ${suffix}`, projectId: 'default' });
    assert.equal(folder.status, 200, JSON.stringify(folder.json));
    const folderId = String(folder.json?.folder?.id || '');
    assert.ok(folderId, 'тестовая папка создана');
    createdFolders.push(folderId);

    const upload = async (name: string, content: string) => {
      const made = await api('POST', `/api/office/files/new?where=folder&folderId=${encodeURIComponent(folderId)}&name=${encodeURIComponent(name)}`, Buffer.from(content), true);
      assert.equal(made.status, 200, JSON.stringify(made.json));
      const id = String(made.json?.id || '');
      assert.ok(id, `создан файл ${name}`);
      createdFiles.push(id);
      return { id, bytes: Buffer.from(content) };
    };
    const source = await upload(`__archive-source-${suffix}.txt`, 'source bytes stay exactly the same');
    const remove = await upload(`__archive-remove-${suffix}.txt`, 'this entry is removed');
    const addition = await upload(`__archive-add-${suffix}.txt`, 'new file from Flux');
    const sourceBefore = await api('GET', `/api/files/${source.id}/raw`);
    assert.ok(sourceBefore.bytes.equals(source.bytes), 'байты исходного файла сохранены до создания архива');

    ({ chromium: browser } = await import('playwright-core'));
    const browserInstance = await browser.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    browser = browserInstance;
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    page.on('pageerror', (e: Error) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m: any) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    await loginPage(page, BASE, LOGIN);
    await page.goto(`${BASE}/#/archives`, { waitUntil: 'domcontentloaded' });
    const sourceName = `__archive-source-${suffix}.txt`;
    const removeName = `__archive-remove-${suffix}.txt`;
    const addName = `__archive-add-${suffix}.txt`;
    await page.getByRole('button', { name: 'Создать архив', exact: true }).click();
    await page.getByText(sourceName, { exact: true }).locator('xpath=ancestor::label[1]').locator('input[type=checkbox]').check();
    await page.getByText(removeName, { exact: true }).locator('xpath=ancestor::label[1]').locator('input[type=checkbox]').check();
    await page.getByLabel('Имя архива').fill(`__archive-${suffix}`);
    const createResponse = page.waitForResponse((response: any) => response.url().includes('/api/archives/create') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Создать архив', exact: true }).last().click();
    const createdResponse = await createResponse;
    assert.ok(createdResponse.ok(), `ZIP создан: HTTP ${createdResponse.status()}`);
    const archiveRow = await createdResponse.json();
    assert.ok(archiveRow?.id && /\.zip$/i.test(String(archiveRow.name || '')), `API вернул ZIP: ${JSON.stringify(archiveRow)}`);
    await page.getByText(String(archiveRow.name), { exact: true }).waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Изменить копию', exact: true }).waitFor({ timeout: 20_000 });
    assert.equal(await page.getByRole('button', { name: 'Изменить копию', exact: true }).isEnabled(), true, 'открытый ZIP доступен для правки');
    const archiveId = String(archiveRow.id);
    createdFiles.push(archiveId);
    const archiveBytesBeforeEdit = await api('GET', `/api/files/${archiveId}/raw`);
    assert.equal(archiveBytesBeforeEdit.status, 200, 'исходный ZIP читается до правки');

    await page.getByRole('button', { name: 'Изменить копию', exact: true }).click();
    const renameInput = page.getByLabel(`Новое имя для ${sourceName}`);
    await renameInput.fill(`renamed-${suffix}.txt`);
    await page.getByLabel(`Новое имя для ${removeName}`).locator('xpath=ancestor::div[1]').getByLabel('Удалить').check();
    await page.getByLabel('Добавить файл Flux').selectOption(addition.id);
    await page.getByLabel('Пароль копии').fill(`pw-${suffix}`);
    await page.getByRole('button', { name: 'Предпросмотр', exact: true }).click();
    await page.getByRole('button', { name: 'Сохранить копию', exact: true }).waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Сохранить копию', exact: true }).click();
    await page.getByText(/Содержимое архива загружено/).waitFor({ timeout: 30_000 }).catch(() => {});

    const created = await api('GET', `/api/projects/default/folders`);
    const copy = (created.json?.folders || []).flatMap((f: any) => f.files || []).find((f: any) => String(f.name || '').startsWith(`__archive-${suffix} `) && String(f.name || '').endsWith('.zip'));
    assert.ok(copy?.id, 'сохранена отдельная копия ZIP');
    const copyId = String(copy.id);
    createdFiles.push(copyId);
    const sourceAfter = await api('GET', `/api/files/${archiveId}/raw`);
    assert.ok(sourceAfter.bytes.equals(archiveBytesBeforeEdit.bytes), 'исходный ZIP не изменился');
    const wrongPassword = await api('POST', `/api/archives/${copyId}/test`, { password: 'wrong' });
    assert.notEqual(wrongPassword.status, 200, `проверка архива отклонила неверный пароль: ${JSON.stringify(wrongPassword.json)}`);
    const correctPassword = await api('POST', `/api/archives/${copyId}/test`, { password: `pw-${suffix}` });
    assert.equal(correctPassword.status, 200, `проверка архива прошла с верным паролем: ${JSON.stringify(correctPassword.json)}`);
    const listing = await api('POST', `/api/archives/${copyId}/list`, { password: `pw-${suffix}` });
    assert.equal(listing.status, 200, JSON.stringify(listing.json));
    const names = (listing.json?.entries || []).map((entry: any) => entry.path);
    assert.ok(names.some((name: string) => name.endsWith(`renamed-${suffix}.txt`)), 'путь записи изменён');
    assert.ok(!names.some((name: string) => name.endsWith(removeName)), 'выбранная запись удалена');
    assert.ok(names.some((name: string) => name.endsWith(addName)), 'файл Flux добавлен');
    const meta = await api('GET', `/api/office/files/${copyId}/meta`);
    assert.equal(meta.json?.name, copy.name, 'метаданные копии доступны через office meta');
    assert.deepEqual(errors, [], 'в консоли браузера нет ошибок');
    console.log('Живой сценарий архива пройден: ZIP создан экраном, правка сохранила отдельную парольную копию, исходные байты не изменились.');
  } catch (error: any) {
    console.error('Живой сценарий архива не пройден:', error?.stack || error);
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
    for (const id of createdFiles.reverse()) await api('DELETE', `/api/files/${id}`).catch(() => {});
    for (const id of createdFolders.reverse()) await api('DELETE', `/api/folders/${id}`).catch(() => {});
  }
})();
