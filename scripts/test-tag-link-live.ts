import { testCredentials } from './testCredentials';
/**
 * Ссылка на тег ставит его карточку в центр холста.
 *
 * Что стережёт (src/screens/Registry.tsx, глубокая ссылка ?tag= и ?focus=):
 * по такой ссылке сюда ведут теги из письма, Проводника и чата, и открывается
 * она новым окном, которое ещё раскрывается и растёт. Раньше центр считался
 * по первому, маленькому размеру холста, и после разворота карточка стояла
 * сбоку или за краем — человек щёлкал П3, а видел другие теги.
 *
 * Нужен поднятый сервер. Запуск: npx tsx scripts/test-tag-link-live.ts
 */
import { loginPage } from './officeHarness';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const ADMIN = testCredentials();
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let f = 0, p = 0;
const ok = (n: string, c: boolean, d?: unknown) =>
  (c ? (p++, console.log('  ✓', n)) : (f++, console.error('  ✗', n, d === undefined ? '' : JSON.stringify(d).slice(0, 300))));
const api = async (method: string, url: string, token: string, body?: any) => {
  const res = await fetch(BASE + url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.json().catch(() => ({}));
};

(async () => {
  const { chromium } = await import('playwright-core');
  const login = await api('POST', '/api/login', '', ADMIN);
  const token = login.token;
  if (!token) { console.error('вход не удался'); process.exit(2); }
  // Свой проект с тегами вдали от начала холста: иначе центр совпал бы случайно
  const stamp = Date.now().toString(36);
  const proj = (await api('POST', '/api/projects', token, { name: `__проба ссылки ${stamp}` })).project;
  const codes = Array.from({ length: 12 }, (_, i) => `ЛТ${i + 1}`);
  await api('POST', `/api/projects/${proj.id}/tags/bulk-import`, token, { rows: codes.map((identifier) => ({ identifier })) });

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    await page.addInitScript(([k, pr]: any) => { try { localStorage.setItem(k, JSON.stringify(pr)); } catch (_) {} }, [`max_active_project_${login.user.id}`, proj]);
    await loginPage(page, BASE, ADMIN);
    for (const code of ['ЛТ12', 'ЛТ7']) {
      await page.goto(`${BASE}/#/registry?tag=${encodeURIComponent(code)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
      // Окно разворачивается уже после перехода — как растущее новое окно
      const max = page.locator('[aria-label="Развернуть"]').last();
      if (await max.isVisible().catch(() => false)) await max.click();
      await page.waitForTimeout(1800);
      const r: any = await page.evaluate(`(() => {
        const card = Array.from(document.querySelectorAll('[id^="tag-card-"]')).find((e) => (e.textContent || '').trim().startsWith(${JSON.stringify(code)}));
        const board = Array.from(document.querySelectorAll('[data-win] *')).find((e) => /scale\\(/.test(e.style.transform || ''));
        if (!card || !board) return null;
        const c = card.getBoundingClientRect(), b = board.parentElement.getBoundingClientRect();
        return { dx: Math.round(c.x + c.width / 2 - (b.x + b.width / 2)), dy: Math.round(c.y + c.height / 2 - (b.y + b.height / 2)) };
      })()`);
      ok(`карточка ${code} в центре холста после разворота окна`, !!r && Math.abs(r.dx) < 40 && Math.abs(r.dy) < 40, r);
    }
  } finally {
    await browser.close();
    await api('DELETE', `/api/projects/${proj.id}`, token);
  }
  console.log(`\n${p} проверок пройдено, ${f} провалено`);
  process.exit(f ? 1 : 0);
})();
