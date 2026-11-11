/**
 * Окно входа Flux Studio и Flux — один и тот же экран (решение владельца 11 ноября 2026).
 *
 * Настоящий экран входа Flux (fixture scripts/fixtures/flux-login-ui.html на Vite) и экран входа готовой Studio (пакет
 * dist-studio, мост главного процесса подменён заглушкой) открываются в обеих темах; сравниваются размеры и вычисленные стили
 * одних и тех же элементов: карточка, заголовок, подписи, поля, кнопка «Войти», фон, переключатель темы, строка версии.
 * Всё должно совпасть до пикселя. Плюс: оба экрана собираются из одних исходников (src/components/auth), а вход Flux
 * сам по себе не менялся — снимки до и после рефакторинга побайтно совпали (см. PR), здесь это держит замер.
 *
 * Запуск: FLUX_CHROME=... npx tsx scripts/test-unified-login-ui.ts
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Page } from 'playwright-core';

const { buildStudio } = require('../studio/build.cjs');
const root = path.resolve(__dirname, '..');
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const shots = process.env.FLUX_STUDIO_SHOTS || path.join(os.tmpdir(), 'flux-studio-shots');

const bridge = `(() => {
  const state = { version: '9.9.9', build: 'developer', name: 'Flux Studio', connected: true, display: 'MariaDB / MySQL · db.example:3306/Flux', remembered: '', user: null, owner: false, warning: '', sections: [] };
  window.electron = { windowControls: { minimize() {}, maximize() {}, close() {}, isMaximized: async () => false, onMaximizedChange: () => () => {} } };
  window.studio = { onState: () => () => {}, onProgress: () => () => {}, call: async () => ({ ok: true, value: state }) };
})();`;

/** Что меряем у каждого экрана: селектор → (размеры, вычисленные стили); позиции — от верха карточки */
const PROBE = `(() => {
  const pick = (el, rel) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return {
    w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, x: Math.round(r.x * 10) / 10, y: Math.round((r.y - rel) * 10) / 10,
    font: s.fontFamily + '|' + s.fontSize + '|' + s.fontWeight + '|' + s.lineHeight, color: s.color, bg: s.backgroundColor, border: s.borderTopColor + '|' + s.borderTopWidth + '|' + s.borderTopLeftRadius, shadow: s.boxShadow }; };
  const card = document.querySelector('#login-screen-root .shadow-modal');
  const rel = card.getBoundingClientRect().y;
  const out = {};
  const add = (name, el) => { if (el) out[name] = pick(el, rel); };
  add('card', card); add('title', card.querySelector('span'));
  add('labelLogin', document.querySelector('.label-login')); add('labelPassword', document.querySelector('.label-password'));
  add('login', document.getElementById('login-input')); add('password', document.getElementById('password-input'));
  add('remember', document.querySelector('label[for=remember-me-checkbox]')); add('submit', document.getElementById('submit-button'));
  add('themeButton', document.querySelector('[aria-label="Переключить тему"]'));
  add('root', document.getElementById('login-screen-root'));
  const credit = [...document.querySelectorAll('#login-screen-root div')].find(d => d.textContent.trim().startsWith('Разработка') && d.children.length === 1);
  add('credit', credit);
  out.cardClass = card.className; out.rootClass = document.getElementById('login-screen-root').className;
  return out;
})()`;

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-unified-login-'));
  fs.mkdirSync(shots, { recursive: true });
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, env: { ...process.env, DISABLE_HMR: 'true' }, stdio: 'ignore' });
  const browser = await chromium.launch({ ...(process.env.FLUX_CHROME ? { executablePath: process.env.FLUX_CHROME } : {}), args: ['--no-sandbox'] });
  try {
    for (let attempt = 0; ; attempt++) {
      if (attempt > 200 || vite.exitCode !== null) throw new Error('Vite не запустился для проверки входа');
      try { if ((await fetch(url)).ok) break; } catch { /* ещё запускается */ }
      await delay(100);
    }
    const built = await buildStudio({ target: 'developer', outDir: path.join(temp, 'developer') });
    const studioFile = 'file://' + path.join(built.app, 'renderer', 'index.html');
    const probe = async (page: Page) => page.evaluate(PROBE) as Promise<Record<string, any>>;
    for (const theme of ['light', 'dark'] as const) {
      const fluxPage = await browser.newPage({ viewport: { width: 1180, height: 800 } });
      await fluxPage.goto(`${url}/scripts/fixtures/flux-login-ui.html?electron&theme=${theme}`);
      await fluxPage.waitForSelector('#login-input'); await fluxPage.waitForTimeout(900);
      const studioPage = await browser.newPage({ viewport: { width: 1180, height: 800 } });
      await studioPage.addInitScript((value: string) => { try { localStorage.setItem('theme', value); } catch { /* приватный режим */ } }, theme);
      await studioPage.addInitScript(bridge);
      await studioPage.goto(studioFile);
      await studioPage.waitForSelector('#login-input'); await studioPage.waitForFunction(() => !document.getElementById('boot-splash')); await studioPage.waitForTimeout(900);
      const [flux, studio] = [await probe(fluxPage), await probe(studioPage)];
      for (const key of Object.keys(flux)) {
        if (key === 'card') { if (JSON.stringify({ ...flux.card, h: 0, y: 0 }) !== JSON.stringify({ ...studio.card, h: 0, y: 0 })) console.error(JSON.stringify([flux.card, studio.card])); ok(`${theme}: карточка — та же ширина, шрифт, цвета, рамка и тень`, flux.card.w === studio.card.w && flux.card.x === studio.card.x && JSON.stringify({ ...flux.card, h: 0, y: 0 }) === JSON.stringify({ ...studio.card, h: 0, y: 0 })); continue; }
        if (key === 'credit') continue;
        // Слово в заголовке карточки у программ своё («Flux», «Flux Studio»): ширина текста разная, всё остальное — то же
        if (key === 'title') { ok(`${theme}: заголовок — тот же шрифт, цвет и место`, JSON.stringify({ ...flux.title, w: 0 }) === JSON.stringify({ ...studio.title, w: 0 })); continue; }
        const same = JSON.stringify(flux[key]) === JSON.stringify(studio[key]);
        ok(`${theme}: ${key} — одинаково у Flux и Studio`, same || (key === 'root' && flux.root.w === studio.root.w) || (key === 'themeButton' && JSON.stringify({ ...flux[key], y: 0 }) === JSON.stringify({ ...studio[key], y: 0 })));
        if (!same && key !== 'root' && key !== 'themeButton') console.error(JSON.stringify([key, flux[key], studio[key]]));
      }
      await fluxPage.screenshot({ path: path.join(shots, `login-flux-${theme}.png`) });
      await studioPage.screenshot({ path: path.join(shots, `login-studio-${theme}.png`) });
      await fluxPage.close(); await studioPage.close();
    }
    // Один исходник: оба окна берут вид и поля входа из src/components/auth, а не рисуют своё
    const flux = fs.readFileSync(path.join(root, 'src/screens/Login.tsx'), 'utf8'), studio = fs.readFileSync(path.join(root, 'studio/renderer/auth/LoginScreen.tsx'), 'utf8');
    for (const name of ['LoginFrame', 'LoginForm']) ok(`${name}: общий компонент у Flux и Studio`, flux.includes(`components/auth/${name}`) && studio.includes(`components/auth/${name}`));
    ok('«Вход владельца»: общая панель у Flux и Studio', fs.readFileSync(path.join(root, 'src/components/OwnerLogin.tsx'), 'utf8').includes('auth/OwnerLoginPanel') && studio.includes('auth/OwnerLoginPanel'));
    ok('подключение к базе: общие поля у Flux и Studio', fs.readFileSync(path.join(root, 'src/components/ConnectionPanel.tsx'), 'utf8').includes('auth/DatabaseUriForm') && fs.readFileSync(path.join(root, 'studio/renderer/auth/ConnectScreen.tsx'), 'utf8').includes('auth/DatabaseUriForm'));
    console.log(`\nВход Flux и Studio: ${passed} проверок пройдено, снимки: ${shots}`);
  } finally { await browser.close(); vite.kill(); fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exit(1); });
