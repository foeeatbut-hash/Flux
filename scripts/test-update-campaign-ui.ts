import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
let checks = 0;
const check = (label: string, condition: boolean) => { assert.ok(condition, label); checks++; };
async function run() {
  const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    const errors: string[] = [];
    const expectedNetworkErrors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', message => { if (message.type() !== 'error') return; const text = message.text(); if (text.includes('Failed to load resource') && text.includes('503 (Service Unavailable)')) expectedNetworkErrors.push(text); else errors.push(text); });
    let scenario = 'normal';
    const commands: any[] = [];
    const release = { version: '2.0.0', generation: 'release-generation', signature: 'signed-release', sha256: 'a'.repeat(64) };
    const devices = Array.from({ length: 27 }, (_, i) => ({ deviceId: `device-${String(i).padStart(2, '0')}`, userId: `employee${i}`, name: `Сотрудник ${i}`, symbol: String(i), isActive: true, version: '1.0.0', platform: 'win32', arch: 'x64', lastSeen: Date.now(), offline: false, status: 'idle', code: '', commandId: null, action: null, deadline: null, targetVersion: null }));
    await page.route('**/api/updates/**', async route => {
      const url = route.request().url();
      if (scenario === 'failure') return route.fulfill({ status: 503, json: { error: 'Проверка состояния временно недоступна' } });
      if (url.endsWith('/devices')) return route.fulfill({ json: { inst: 'company', devices: scenario === 'cancel' ? [{ ...devices[0], version: '2.0.0', commandId: 'scheduled-one', action: 'schedule', targetVersion: '2.0.0', commandRelease: { ...release, releaseSignature: release.signature } }] : devices, releases: scenario === 'cancel' ? [] : [release] } });
      if (url.endsWith('/delegation')) return route.fulfill({ json: { inst: 'company', userId: 'admin', code: 'grant', grant: { publicKey: (scenario === 'mismatch' ? 'b' : 'a').repeat(64), expiresAt: Date.now() + 3600000, maxMinutes: 60, maxTargets: 100 } } });
      if (url.endsWith('/campaigns')) { commands.push(route.request().postDataJSON()); return route.fulfill({ json: { success: true } }); }
      return route.fulfill({ status: 404, json: {} });
    });
    await page.goto(`${BASE}/scripts/fixtures/update-campaign-ui.html`);
    const bulk = page.getByRole('button', { name: /Выбрать всех устаревших/ });
    await bulk.waitFor();
    await page.getByText('1 / 2', { exact: true }).waitFor();
    check('Первой страницей ограничены только строки, а не массовый выбор', await page.locator('details').count() === 26);
    await bulk.click();
    await page.getByRole('button', { name: 'Назначить обновление', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    check('Массовый выбор включает вторую страницу', await page.getByRole('dialog').innerText().then(s => s.includes('Устройств: 27')));
    await page.getByRole('button', { name: 'Отмена', exact: true }).click();
    await page.evaluate(() => (window as any).__filterEmployees(['employee0']));
    await page.getByRole('button', { name: 'Назначить обновление', exact: true }).click();
    check('Смена фильтра исключает ранее выбранных скрытых сотрудников', await page.getByRole('dialog').innerText().then(s => s.includes('Устройств: 1')));
    await page.getByRole('button', { name: 'Подтвердить назначение' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    check('Подписываются и отправляются только устройства текущего фильтра', commands.length === 1 && commands[0].command.targets.length === 1 && commands[0].command.targets[0].userId === 'employee0');
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>('button')].some(b => b.textContent === 'Проверить состояние' && !b.disabled));
    await page.setViewportSize({ width: 768, height: 850 });
    for (const dark of [false, true]) {
      await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), dark);
      await page.screenshot({ path: `/tmp/update-campaign-${dark ? 'dark' : 'light'}.png` });
      check(`${dark ? 'Тёмная' : 'Светлая'} тема не расширяет страницу`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    }
    await page.setViewportSize({ width: 1280, height: 850 });
    scenario = 'cancel';
    await page.getByRole('button', { name: 'Проверить состояние' }).click();
    await page.getByText('Сотрудник 0 · 2.0.0 · устройств: 1', { exact: true }).click();
    const checkbox = page.getByRole('checkbox');
    check('Актуальная версия с назначением выбирается для отмены без доступного выпуска', await checkbox.isEnabled());
    await checkbox.check();
    await page.getByRole('button', { name: 'Отменить выбранные назначения' }).click();
    await page.getByRole('button', { name: 'Отменить назначения', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    check('Отмена отправляет предыдущую голову и подпись исходного выпуска', commands.length === 2 && commands[1].command.action === 'cancel' && commands[1].command.targets[0].previous === 'scheduled-one' && commands[1].releaseSignature === release.signature);
    scenario = 'mismatch';
    await page.getByRole('button', { name: 'Проверить состояние' }).click();
    await page.getByRole('status').waitFor();
    await bulk.click();
    check('Чужой ключ разрешения блокирует назначение', await page.getByRole('button', { name: 'Назначить обновление', exact: true }).isDisabled());
    scenario = 'normal';
    await page.getByRole('button', { name: 'Проверить состояние' }).click();
    await page.getByRole('status').waitFor({ state: 'detached' });
    scenario = 'failure';
    await page.getByRole('button', { name: 'Проверить состояние' }).click();
    await page.getByRole('status').waitFor();
    check('Ошибка обновления состояния снимает разрешение на назначение', await page.getByRole('button', { name: 'Назначить обновление', exact: true }).isDisabled());
    check('Ожидаемые ошибки 503 ограничены двумя запросами сценария отказа', expectedNetworkErrors.length === 2);
    check(`Нет ошибок приложения или консоли: ${errors.join('; ')}`, errors.length === 0);
    console.log(`${checks} проверок браузерной панели пройдено, 0 провалено`);
  } finally { await browser.close(); }
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
