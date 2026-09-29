/**
 * Ввоз тегов не кладёт новые карточки поверх старых.
 *
 * Что стережёт (server/routes/tags.ts, bulk-import): второй ввоз в проект
 * раскладывался по той же сетке от угла холста, что и первый, и карточки
 * ложились друг на друга (П5 на П1, П6 на П3). Ссылка на тег из письма
 * центрировала холст на П3, а сверху лежал П6.
 *
 * Нужен поднятый сервер. Запуск: npx tsx scripts/test-tag-import-layout-live.ts
 */
const BASE = process.env.FLUX_API || 'http://localhost:3000';
const ADMIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };

let f = 0, p = 0;
const ok = (n: string, c: boolean, d?: unknown) =>
  (c ? (p++, console.log('  ✓', n)) : (f++, console.error('  ✗', n, d === undefined ? '' : JSON.stringify(d).slice(0, 300))));
const api = async (method: string, url: string, token: string, body?: any) => {
  const res = await fetch(BASE + url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.json().catch(() => ({}));
};

(async () => {
  const token = (await api('POST', '/api/login', '', ADMIN)).token;
  if (!token) { console.error('вход не удался'); process.exit(2); }
  const proj = (await api('POST', '/api/projects', token, { name: `__проба раскладки ${Date.now().toString(36)}` })).project;
  try {
    await api('POST', `/api/projects/${proj.id}/tags/bulk-import`, token, { rows: Array.from({ length: 8 }, (_, i) => ({ identifier: `А${i + 1}` })) });
    await api('POST', `/api/projects/${proj.id}/tags/bulk-import`, token, { rows: Array.from({ length: 5 }, (_, i) => ({ identifier: `Б${i + 1}` })) });
    const got = await api('GET', `/api/projects/${proj.id}/tags`, token);
    const list: any[] = Array.isArray(got) ? got : got.tags || [];
    const spots = new Map<string, string[]>();
    for (const t of list) {
      const m = JSON.parse(t.metadata || '{}');
      const k = `${m.x},${m.y}`;
      spots.set(k, [...(spots.get(k) || []), t.identifier]);
    }
    const clash = Array.from(spots.values()).filter((v) => v.length > 1);
    ok('все 13 тегов на холсте', list.length === 13, list.length);
    ok('ни одна карточка второго ввоза не легла на первую', clash.length === 0, clash);
    const maxA = Math.max(...list.filter((t) => t.identifier.startsWith('А')).map((t) => JSON.parse(t.metadata).y));
    const minB = Math.min(...list.filter((t) => t.identifier.startsWith('Б')).map((t) => JSON.parse(t.metadata).y));
    ok('второй ввоз — рядами ниже первого', minB > maxA, { maxA, minB });
  } finally {
    await api('DELETE', `/api/projects/${proj.id}`, token);
  }
  console.log(`\n${p} проверок пройдено, ${f} провалено`);
  process.exit(f ? 1 : 0);
})();
