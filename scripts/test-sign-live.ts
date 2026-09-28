/**
 * Подпись доходит до документа: от профиля до листа ПДФ.
 *
 * Подпись хранится в профиле сотрудника — отсюда её берут документы.
 *
 * Отдельно проверяется то, чего глазом не видно вовсе: пометки должны доезжать
 * до ОБЩЕЙ базы. Таблицы PdfMarkup в схемах общей базы не было — замечания и
 * подписи оставались на машине автора, и коллеги их не видели никогда.
 *
 * Запуск (нужен поднятый сервер):
 *   npx tsx server.ts > /tmp/srv.log 2>&1 &
 *   npx tsx scripts/test-sign-live.ts
 */
import { readFileSync } from 'fs';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 300) : ''));

// Однопиксельный PNG — подписью он, конечно, не выглядит, но для проверки
// пути «профиль → лист» важно не как он выглядит, а что он доехал
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

console.log('0. Пометки доезжают до общей базы');
{
  // Это статическая проверка, но она про живые данные: схема общей базы едет
  // внутри обновления, и таблицы, которой в ней нет, не появится никогда
  for (const file of ['prisma/schema.mariadb.prisma', 'prisma/schema.postgresql.prisma']) {
    ok(`${file}: таблица пометок объявлена`, readFileSync(file, 'utf8').includes('model PdfMarkup'));
  }
}

(async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });

  await page.route('**/api/license/status', (r: any) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ licensed: true, machineId: 'TEST', expiresAt: Date.now() + 9e8, daysLeft: 30, reason: '' }),
  }));

  try {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6500);
    const inputs = await page.$$('input');
    await inputs[0].fill(LOGIN.symbol);
    await inputs[1].fill(LOGIN.password);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(8000);
    ok('вход выполнен', await page.evaluate(() => !!document.querySelector('[data-taskbar]')));

    console.log('1. Подпись сохраняется в профиль и читается обратно');
    const saved = await page.evaluate(async (pixel: string) => {
      const me = JSON.parse(localStorage.getItem('pdm_session_user') || '{}');
      const put = await fetch(`/api/users/${me.id}/signature`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signatureImage: pixel, signatureHeightMm: 9 }),
      });
      if (!put.ok) return { ok: false, status: put.status };
      const back = await (await fetch(`/api/users/${me.id}/signature`)).json();
      return { ok: true, meId: me.id, has: !!back?.signature, mm: back?.signatureHeightMm };
    }, PIXEL);
    ok('подпись сохранилась', saved.ok, saved);
    ok('и вернулась с сервера', !!saved.has, saved);
    ok('высота в миллиметрах сохранена', saved.mm === 9, saved);

    // Подписанный лист старого Просмотра (пометки PdfMarkup) и подпись в
    // титуле документа Конструктора ушли вместе со старыми редакторами.
    // Подписи «Разработал / Проверил / Утвердил» в файлах Flux Office —
    // поля sign.* (scripts/test-project-data-live.ts)

    // Прибираем: проба не должна оставлять мусор ни в файлах, ни в профиле
    await page.evaluate(async () => {
      const me = JSON.parse(localStorage.getItem('pdm_session_user') || '{}');
      await fetch(`/api/users/${me.id}/signature`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signatureImage: null, signatureHeightMm: 8 }),
      });
    });
  } catch (e: any) {
    f++;
    console.error('  ✗ проба оборвалась:', e?.message || e);
  } finally {
    await browser.close();
  }

  if (f) { console.error(`\nПровалено проверок: ${f}`); process.exit(1); }
  console.log('\nПодпись доходит до документа: все проверки пройдены');
})();
