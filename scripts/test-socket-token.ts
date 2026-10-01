/**
 * Живая связь переживает повторный вход.
 *
 * Проверка написана по поломке, которая выглядела как «статус в сети не
 * работает». Сокет получает токен ОДИН РАЗ, при создании, и при
 * переподключении шлёт тот же самый. Пока пересоздание было привязано только к
 * личности человека, повторный вход (истёк тридцатидневный срок токена,
 * перезапустили сервер, сбросили сессию) оставлял сокет со старым токеном
 * навсегда: сервер его не пускал, а HTTP работал — там токен читается на
 * каждом запросе. Снаружи: чат живой, а «в сети» нет ни у кого.
 *
 * Запуск (нужен поднятый сервер и playwright-core):
 *   npx tsx server.ts > /tmp/srv.log 2>&1 &
 *   npx tsx scripts/test-socket-token.ts
 */
const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 240) : ''));

(async () => {
  let chromium: any;
  try { ({ chromium } = await import('playwright-core')); }
  catch { console.error('playwright-core не установлен.'); process.exit(2); }
  try {
    const h = await fetch(BASE + '/api/health');
    if (!h.ok) throw new Error('health ' + h.status);
  } catch (e: any) {
    console.error(`Сервер на ${BASE} не отвечает (${e?.message || e}).`);
    process.exit(2);
  }

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.route('**/api/license/status', (r: any) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ licensed: true, machineId: 'TEST', expiresAt: Date.now() + 9e8, daysLeft: 30, reason: '' }),
  }));

  /** Кто в сети по мнению самой программы */
  const onlineCount = () => page.evaluate(() => {
    const w = window as any;
    return (w.__pdmPresence?.getState?.().online || []).length;
  });

  try {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    await page.locator('input').first().fill(LOGIN.symbol);
    await page.locator('input[type="password"]').first().fill(LOGIN.password);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(6000);

    console.log('1. Связь есть и записана в журнал');
    const j1 = await page.evaluate(() => {
      const w = window as any;
      return (w.__pdmLogStore?.getState?.().logs || []).map((l: any) => `${l.context}:${l.message}`).join('\n');
    });
    ok('в журнале есть отметка о живой связи', /Связь.*установлена/.test(j1), j1.slice(-300));
    ok('в журнале названы версии сервера и программы', /Сервер:/.test(j1), j1.slice(-300));

    console.log('2. Повторный вход не убивает живую связь');
    // Тот же человек входит заново — токен другой. Сокет обязан пересоздаться
    const fresh = await page.evaluate(async (login) => {
      const r = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(login),
      });
      const d = await r.json();
      return d.success && document.cookie.includes('flux_csrf=') ? 'cookie-session' : '';
    }, LOGIN);
    ok('новая cookie-сессия получена', !!fresh, fresh);

    await page.waitForTimeout(7000);
    const j2 = await page.evaluate(() => {
      const w = window as any;
      return (w.__pdmLogStore?.getState?.().logs || []).map((l: any) => `${l.context}:${l.message}`).join('\n');
    });
    const connects = (j2.match(/Связь.*установлена/g) || []).length;
    ok('связь установлена заново с новым токеном', connects >= 2, connects);
    ok('в журнале нет отказа «не пускают»', !/не устанавливается/.test(j2), j2.slice(-300));

    void onlineCount;
  } finally {
    await browser.close();
  }

  console.log(f ? `\nПровалено проверок: ${f}` : '\nПроверка живой связи пройдена');
  process.exit(f ? 1 : 0);
})();
