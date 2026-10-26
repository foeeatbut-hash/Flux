import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
/**
 * Экран «Сотрудники»: список — главное, обновления — отдельная вкладка;
 * версия программы стоит колонкой, а метка «устарела» ведёт к назначению.
 * SHOT=путь — снимок экрана в обеих темах (с суффиксом -dark).
 */
const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
let checks = 0;
const check = (label: string, condition: boolean) => { assert.ok(condition, label); checks++; };
async function run() {
  const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    const people = [['Раупов Хусрав', '4519', 'ENGINEER_VENT'], ['Цыбуковский Антон', '2201', 'ENGINEER_VENT'], ['Иванова Мария', '3310', 'ADMIN']];
    const users = people.map(([name, symbol, role], i) => ({ id: `u${i}`, name, symbol, role, isActive: true, hasSignature: i === 0, createdAt: new Date(2026, 0, 5 + i).toISOString() }));
    const release = { version: '2.0.0', generation: 'g', signature: 's', sha256: 'a'.repeat(64) };
    const devices = [
      { deviceId: 'dev-aaaaaaaa', userId: 'u1', name: 'Цыбуковский Антон', symbol: '2201', isActive: true, version: '1.20.15', platform: 'win32', arch: 'x64', lastSeen: Date.now(), offline: false, status: 'idle', code: '', commandId: null, action: null, deadline: null, targetVersion: null },
      { deviceId: 'dev-bbbbbbbb', userId: 'u0', name: 'Раупов Хусрав', symbol: '4519', isActive: true, version: '2.0.0', platform: 'win32', arch: 'x64', lastSeen: Date.now(), offline: false, status: 'idle', code: '', commandId: null, action: null, deadline: null, targetVersion: null },
    ];
    await page.route('**/api/**', async route => {
      const url = route.request().url();
      if (url.endsWith('/updates/devices')) return route.fulfill({ json: { inst: 'company', devices, releases: [release] } });
      if (url.endsWith('/updates/delegation')) return route.fulfill({ json: { inst: 'company', userId: 'owner', code: 'grant', grant: { publicKey: 'a'.repeat(64), expiresAt: Date.now() + 3600000, maxMinutes: 60, maxTargets: 100 } } });
      if (url.endsWith('/users')) return route.fulfill({ json: users });
      if (url.endsWith('/roles')) return route.fulfill({ json: [] });
      return route.fulfill({ json: [] });
    });
    await page.goto(`${BASE}/scripts/fixtures/users-screen-ui.html`);
    await page.locator('.fx-table').getByText('Раупов Хусрав', { exact: true }).waitFor();
    check('Блока обновлений над списком нет', await page.getByText('Версии и обновления').count() === 0);
    await page.getByText('устарела', { exact: true }).waitFor();
    check('Метка «устарела» только у сотрудника со старой версией', await page.getByText('устарела', { exact: true }).count() === 1);
    check('Колонка «Версия» в таблице', await page.getByRole('columnheader', { name: 'Версия' }).count() === 1);
    const heights = await page.$$eval('.fx-table tbody tr', rows => rows.map(r => Math.round(r.getBoundingClientRect().height)));
    check(`Строки списка одной высоты: ${heights}`, new Set(heights).size === 1);
    const shot = process.env.SHOT;
    const snap = async (name: string) => {
      if (!shot) return;
      for (const dark of [false, true]) {
        await page.evaluate(d => document.documentElement.classList.toggle('dark', d), dark);
        await page.screenshot({ path: shot.replace(/\.png$/, `${name}${dark ? '-dark' : ''}.png`) });
      }
      await page.evaluate(() => document.documentElement.classList.remove('dark'));
    };
    await snap('');
    await page.getByText('устарела', { exact: true }).click();
    await page.getByRole('button', { name: 'Назначить обновление', exact: true }).waitFor();
    await page.getByText('dev-aaaa').waitFor();
    check('Из метки «устарела» открыта вкладка с выбранным устройством', await page.getByRole('checkbox').isChecked());
    await snap('-updates');
    await page.getByRole('tab', { name: 'Список' }).click();
    await page.getByRole('button', { name: 'Добавить сотрудника' }).waitFor();
    check(`Нет ошибок: ${errors.join('; ')}`, errors.length === 0);
    console.log(`${checks} проверок экрана сотрудников пройдено, 0 провалено`);
  } finally { await browser.close(); }
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
