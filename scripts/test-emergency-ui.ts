/**
 * Скрытый раздел «Экстренная установка» в настоящем окне Flux: открывается сочетанием CapsLock + Shift + Ctrl,
 * работает при недоступном сервере и без входа, принимает только подписанный пакет.
 *
 * Окно — настоящее (Vite), все запросы к серверу обрываются: раздел обязан работать, пока сервер лежит.
 * За мостом главного процесса стоит НАСТОЯЩАЯ логика проверки (electron/emergencyInstall.ts) над настоящими
 * файлами пакетов; подставлены только системный диалог выбора файла и запуск помощника подмены.
 * Ключи одноразовые. Снимки — в FLUX_EMERGENCY_SHOTS (по умолчанию /tmp/u8-shots), в git не кладутся.
 *
 * Запуск: FLUX_UI_URL=http://127.0.0.1:5188 FLUX_CHROME=... npx tsx scripts/test-emergency-ui.ts
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChrome } from './chromePath';
import { writePackage } from '../electron/updatePackage';
import { createEmergencyInstaller } from '../electron/emergencyInstall';

const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5188';
const SHOTS = process.env.FLUX_EMERGENCY_SHOTS || '/tmp/u8-shots';
let passed = 0;
const ok = (name: string, value: unknown, detail?: unknown) => { assert.ok(value, `${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 300)}`}`); passed++; console.log(`  ✓ ${name}`); };

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const pair = () => {
  const p = crypto.generateKeyPairSync('ed25519');
  const der = p.publicKey.export({ format: 'der', type: 'spki' });
  return { priv: p.privateKey, hex: der.subarray(der.length - 32).toString('hex') };
};
const sign = (priv: crypto.KeyObject, m: object) => { const head = `FLUXUPD1.${b64url(JSON.stringify(m))}`; return `${head}.${b64url(crypto.sign(null, Buffer.from(head), priv))}`; };

async function main() {
  const chrome = findChrome();
  if (!chrome) { console.log('FLUX_VERIFY_SKIP: нет Chromium'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-emergency-ui-'));
  fs.mkdirSync(SHOTS, { recursive: true });
  const owner = pair(), stranger = pair();
  const bytes = crypto.randomBytes(5.5 * 1024 * 1024); bytes[0] = 0x4d; bytes[1] = 0x5a;
  const exe = path.join(dir, 'Flux.exe'); fs.writeFileSync(exe, bytes);
  const manifest = { version: '1.30.0', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), iat: Date.now() };
  const good = path.join(dir, 'Flux-1.30.0.fluxupdate');
  await writePackage(exe, good, { signature: sign(owner.priv, manifest), keyHex: owner.hex });
  const wrongKey = path.join(dir, 'stranger.fluxupdate');
  await writePackage(exe, wrongKey, { signature: sign(stranger.priv, manifest), keyHex: stranger.hex });
  const raw = fs.readFileSync(good);
  const cut = path.join(dir, 'cut.fluxupdate'); fs.writeFileSync(cut, raw.subarray(0, raw.length - 4096));
  const newer = path.join(dir, 'newer.fluxupdate'); fs.writeFileSync(newer, Buffer.concat([Buffer.from('FLUXPKG2\nx\n'), bytes.subarray(0, 100)]));

  const portable = path.join(dir, 'Flux-portable.exe'); fs.writeFileSync(portable, 'прежняя программа');
  const queue: Array<string | null> = [];
  const spawned: Array<{ exe: string; args: string[] }> = [];
  let quits = 0, page: any;
  const installer = createEmergencyInstaller({
    keyHex: owner.hex, current: () => '1.29.0', tempDir: dir, portableExe: () => portable, pid: 777,
    pickFile: async () => queue.shift() ?? null,
    spawnHelper: async (e, args) => { spawned.push({ exe: e, args }); },
    approveClose: async () => true, quit: () => { quits++; }, log: () => {},
    onProgress: p => { void page?.evaluate(`window.__emergencyProgress && window.__emergencyProgress(${Number(p)})`).catch(() => {}); },
  });

  const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));
    // Сервера нет: любой запрос к API обрывается, как при поломке встроенного сервера
    let apiAttempts = 0;
    await page.route('**/api/**', (route: any) => { apiAttempts++; return route.abort(); });
    await page.exposeFunction('__emergencyPick', () => installer.pick());
    await page.exposeFunction('__emergencyInstall', () => installer.install());
    await page.exposeFunction('__emergencyDiscard', () => { installer.discard(); return { ok: true }; });
    // Строкой, а не функцией: сборщик набора подмешивает в тело функции служебные вызовы, которых в окне нет
    await page.addInitScript(`window.electron = { emergencyUpdate: {
      pick: () => window.__emergencyPick(), install: () => window.__emergencyInstall(), discard: () => window.__emergencyDiscard(),
      onProgress: (fn) => { window.__emergencyProgress = fn; return () => { window.__emergencyProgress = undefined; }; },
    } };`);
    await page.goto(BASE);
    await page.waitForTimeout(800);

    console.log('Раздел скрыт и открывается только сочетанием трёх клавиш');
    const dialog = page.getByTestId('emergency-update');
    ok('до сочетания раздела нет нигде на экране', await dialog.count() === 0 && !(await page.locator('body').innerText()).includes('Экстренная установка'));
    ok('сервер при этом недоступен (запросы к API оборваны)', apiAttempts > 0, apiAttempts);
    for (const [name, keys] of [['Shift + Ctrl', ['Shift', 'Control']], ['CapsLock + Shift', ['CapsLock', 'Shift']], ['CapsLock + Ctrl', ['CapsLock', 'Control']], ['одна клавиша CapsLock', ['CapsLock']]] as const) {
      for (const k of keys) await page.keyboard.down(k);
      for (const k of [...keys].reverse()) await page.keyboard.up(k);
      ok(`${name}: раздел не открывается`, await dialog.count() === 0);
    }
    for (const [name, order] of [['Shift, Ctrl, затем CapsLock', ['Shift', 'Control', 'CapsLock']], ['CapsLock, Ctrl, затем Shift', ['CapsLock', 'Control', 'Shift']]] as const) {
      for (const k of order) await page.keyboard.down(k);
      await dialog.waitFor();
      ok(`${name}: раздел открылся, хотя входа и сервера нет`, await dialog.isVisible());
      for (const k of [...order].reverse()) await page.keyboard.up(k);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      ok(`${name}: Esc закрывает раздел`, await dialog.count() === 0);
    }
    await page.evaluate(() => { for (const k of ['CapsLock']) document.dispatchEvent(new KeyboardEvent('keyup', { code: k })); });

    const open = async () => {
      for (const k of ['Shift', 'Control', 'CapsLock']) await page.keyboard.down(k);
      for (const k of ['CapsLock', 'Control', 'Shift']) await page.keyboard.up(k);
      await dialog.waitFor();
    };
    const measure = async (label: string) => {
      const r = await page.evaluate(() => {
        const box = document.querySelector('[data-testid="emergency-update"]')!.closest('.fx-dialog') as HTMLElement;
        const rect = box.getBoundingClientRect();
        const sizes = [...box.querySelectorAll<HTMLElement>('*')].filter(e => e.childNodes.length && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent!.trim())).map(e => {
          const cs = getComputedStyle(e); return { size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight), text: e.textContent!.trim().slice(0, 30) };
        });
        return { rect: { l: rect.left, t: rect.top, r: rect.right, b: rect.bottom }, vw: innerWidth, vh: innerHeight, sizes, hscroll: document.documentElement.scrollWidth > innerWidth, bg: getComputedStyle(box).backgroundColor };
      });
      ok(`${label}: окно целиком в пределах экрана`, r.rect.l >= 0 && r.rect.t >= 0 && r.rect.r <= r.vw && r.rect.b <= r.vh, r.rect);
      ok(`${label}: текст не мельче 12 px и вес не больше 600`, r.sizes.every((s: any) => s.size >= 12 && s.weight <= 600), r.sizes.filter((s: any) => s.size < 12 || s.weight > 600));
      ok(`${label}: горизонтальной прокрутки нет`, !r.hscroll);
      ok(`${label}: фон окна сплошной`, !/rgba\(.*,\s*0(\.\d+)?\)$/.test(r.bg) || /rgba\(.*,\s*0\.[89]/.test(r.bg), r.bg);
    };

    console.log('Отказы: голый exe, чужая подпись, обрезанный и более новый пакет');
    await open();
    for (const [name, file, pattern] of [['голый exe', exe, /обычный exe без подписи/], ['чужая подпись', wrongKey, /Подпись пакета не подтверждена/], ['обрезанный пакет', cut, /обрезан/], ['формат новее известного', newer, /более новой версией Flux Studio/]] as const) {
      queue.push(file);
      await page.getByRole('button', { name: 'Выбрать файл' }).click();
      const error = page.getByTestId('emergency-error');
      await error.waitFor();
      ok(`${name}: понятный отказ по-русски`, pattern.test(await error.innerText()), await error.innerText());
      ok(`${name}: кнопки установки нет`, await page.getByRole('button', { name: 'Установить и перезапустить' }).count() === 0);
      ok(`${name}: помощник не запущен, программа не закрывается, временных папок нет`, spawned.length === 0 && quits === 0 && fs.readdirSync(dir).every(n => !n.startsWith('flux-update-')));
    }
    await measure('отказ');
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t: string) => document.documentElement.classList.toggle('dark', t === 'dark'), theme);
      await page.waitForTimeout(500); // цвета кнопок переходят плавно: снимок сразу после смены темы поймал бы середину перехода
      await page.screenshot({ path: path.join(SHOTS, `emergency-error-${theme}.png`) });
    }
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    queue.push(null);
    await page.getByRole('button', { name: 'Выбрать файл' }).click();
    await page.waitForTimeout(300);
    ok('отказ в системном диалоге не показывает ошибку', await page.getByTestId('emergency-error').count() === 0);

    console.log('Подписанный пакет: проверка, установка, закрытие программы');
    queue.push(good);
    await page.getByRole('button', { name: 'Выбрать файл' }).click();
    const ready = page.getByTestId('emergency-ready');
    await ready.waitFor();
    const readyText = await ready.innerText();
    ok('показаны версия пакета, текущая версия, размер и имя файла', /1\.30\.0/.test(readyText) && /1\.29\.0/.test(readyText) && /Flux-1\.30\.0\.fluxupdate/.test(readyText) && /МБ/.test(readyText), readyText);
    ok('предупреждение сохранить нужное перед установкой есть', /сохраните всё нужное/.test(readyText));
    ok('до нажатия помощник не запущен и файл программы не тронут', spawned.length === 0 && fs.readFileSync(portable, 'utf8') === 'прежняя программа');
    await measure('готово к установке');
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t: string) => document.documentElement.classList.toggle('dark', t === 'dark'), theme);
      await page.waitForTimeout(500); // цвета кнопок переходят плавно: снимок сразу после смены темы поймал бы середину перехода
      await page.screenshot({ path: path.join(SHOTS, `emergency-ready-${theme}.png`) });
    }
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await page.getByRole('button', { name: 'Установить и перезапустить' }).click();
    await page.getByTestId('emergency-started').waitFor();
    ok('установка запущена: помощник получил проверенный exe, цель и подпись', spawned.length === 1 && spawned[0].args.includes(portable) && spawned[0].args.some(a => a.startsWith('FLUXUPD1.')) && quits === 1);
    ok('установленный файл — ровно подписанный', fs.readFileSync(spawned[0].exe).equals(bytes));
    ok('страница не падала с ошибками', errors.length === 0, errors);

    console.log('Окно без моста главного процесса (в браузере)');
    const plain = await context.newPage();
    await plain.route('**/api/**', (route: any) => route.abort());
    await plain.goto(BASE); await plain.waitForTimeout(500);
    for (const k of ['Shift', 'Control', 'CapsLock']) await plain.keyboard.down(k);
    await plain.getByTestId('emergency-update').waitFor();
    ok('без главного процесса раздел честно говорит, что работает только в программе Flux', /только в программе Flux для Windows/.test(await plain.getByTestId('emergency-update').innerText()));
    ok('кнопки выбора файла без моста нет', await plain.getByRole('button', { name: 'Выбрать файл' }).count() === 0);
  } finally { await browser.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  console.log(`\nЭкстренная установка, интерфейс — ${passed} проверок пройдено, снимки: ${SHOTS}`);
}
main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
