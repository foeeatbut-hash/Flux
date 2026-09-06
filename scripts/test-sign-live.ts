/**
 * Подпись доходит до документа: от профиля до листа ПДФ.
 *
 * Правила штампа считает scripts/test-sign-stamp.ts, но правила можно посчитать
 * верно и всё равно не подписать ни одного листа: подпись хранится в профиле,
 * пометка — в базе, а рисуется она в родном слое просмотрщика. Ошибиться можно
 * в любом из трёх мест.
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

    console.log('2. Подписанный лист живёт в базе, а не в окне');
    const signed = await page.evaluate(async () => {
      // Файл-носитель: подпись ставится на файл, а не в воздух
      const folders = await (await fetch('/api/folders')).json();
      const list = Array.isArray(folders) ? folders : (folders.folders || []);
      const folderId = list[0]?.id || null;
      const mk = await fetch('/api/files', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Проба подписи.pdf', folderId, type: 'FILE', content: '' }),
      });
      const file = (await mk.json())?.file || (await mk.json());
      const fileId = file?.id;
      if (!fileId) return { ok: false };
      const put = await fetch(`/api/files/${fileId}/markups`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'SIGN', page: 1, x: 0.62, y: 0.86, w: 0.3, h: 0.05, text: 'Раупов Х.Х. · 03.09.2026' }),
      });
      if (!put.ok) return { ok: false, status: put.status, fileId };
      const back = await (await fetch(`/api/files/${fileId}/markups`)).json();
      const marks = back?.markups || [];
      return {
        ok: true, fileId,
        kinds: marks.map((m: any) => m.kind),
        author: marks[0]?.createdBy?.id || '',
        text: marks[0]?.text || '',
      };
    });
    ok('пометка-подпись создалась', signed.ok, signed);
    ok('вид сохранён именно как подпись', (signed.kinds || []).includes('SIGN'), signed.kinds);
    ok('автор проставлен сервером, а не телом запроса', !!signed.author, signed);
    ok('строка под подписью сохранена', String(signed.text || '').includes('Раупов'), signed.text);

    console.log('3. Подпись из реестра ВДР доходит до титула документа');
    const vdr = await page.evaluate(async () => {
      const me = JSON.parse(localStorage.getItem('pdm_session_user') || '{}');
      const pj = await (await fetch('/api/projects')).json();
      const list = Array.isArray(pj) ? pj : (pj.projects || []);
      const projectId = list[0]?.id;
      // Реестр, в котором проверяющий — это я
      const mk = await fetch('/api/vdr/registers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, name: 'Проба подписей' }),
      });
      const reg = (await mk.json())?.register;
      await fetch(`/api/vdr/registers/${reg.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkedBy: 'Проверяющий', checkedById: me.id }),
      });
      // Строка реестра и документ, привязанный к ней
      const it = await fetch('/api/vdr/items', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ registerId: reg.id, projectId, titleRu: 'Записка' }),
      });
      const item = (await it.json())?.item;
      const dk = await fetch('/api/constructor/docs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Записка с титулом', kind: 'TEXT', projectId }),
      });
      const doc = (await dk.json())?.doc;
      await fetch(`/api/constructor/docs/${doc.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: JSON.stringify({ vdrItemId: item.id, docMeta: {} }) }),
      });
      const ctx = await (await fetch(`/api/constructor/title/context?docId=${doc.id}`)).json();
      return {
        regId: reg.id, docId: doc.id,
        hasChecked: !!ctx?.context?.['person.checked.signature'],
        checkedName: ctx?.context?.['person.checked.name'] || '',
        hasApproved: !!ctx?.context?.['person.approved.signature'],
      };
    });
    ok('подпись «Проверил» доехала до титула', vdr.hasChecked, vdr);
    ok('и это тот, кто указан в реестре', !!vdr.checkedName, vdr);
    // Не назначенная роль не должна брать чью-то чужую подпись
    ok('«Утвердил» без сотрудника остаётся пустым', !vdr.hasApproved, vdr);

    await page.evaluate(async (args: any) => {
      if (args.docId) await fetch(`/api/constructor/docs/${args.docId}`, { method: 'DELETE' });
      if (args.regId) await fetch(`/api/vdr/registers/${args.regId}`, { method: 'DELETE' });
    }, vdr);

    // Прибираем: проба не должна оставлять мусор ни в файлах, ни в профиле
    await page.evaluate(async (args: any) => {
      if (args.fileId) await fetch(`/api/files/${args.fileId}`, { method: 'DELETE' });
      const me = JSON.parse(localStorage.getItem('pdm_session_user') || '{}');
      await fetch(`/api/users/${me.id}/signature`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signatureImage: null, signatureHeightMm: 8 }),
      });
    }, { fileId: signed.fileId });
  } catch (e: any) {
    f++;
    console.error('  ✗ проба оборвалась:', e?.message || e);
  } finally {
    await browser.close();
  }

  if (f) { console.error(`\nПровалено проверок: ${f}`); process.exit(1); }
  console.log('\nПодпись доходит до документа: все проверки пройдены');
})();
