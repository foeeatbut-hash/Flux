/**
 * Сохранение из Flux Office: целиком, со сверкой версии и откатом.
 *
 * Что стережёт (server/routes/officeFiles.ts, fileChunks.ts):
 *   - сохранение с верным хешем записывает новое и кладёт прежнее в FileVersion;
 *   - с неверным — 409, содержимое не тронуто: чужая правка не затирается;
 *   - файл короче прежнего читается без старого хвоста;
 *   - перезапись кусками Проводника с числом кусков тоже без хвоста;
 *   - «Сохранить как» кладёт копию рядом со свободным и чистым именем;
 *   - чужой личный файл не перезаписать ни целиком, ни кусками;
 *   - без входа — 401.
 *
 * Запуск (сервер поднят): npx tsx scripts/test-office-files-live.ts
 */
import { createHash } from 'node:crypto';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };

let f = 0;
const ok = (n: string, c: boolean, d?: unknown) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d === undefined ? '' : JSON.stringify(d).slice(0, 300))));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let token = '';
const call = async (method: string, url: string, body?: any, headers: Record<string, string> = {}) => {
  const raw = Buffer.isBuffer(body);
  const res = await fetch(BASE + url, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(raw ? { 'Content-Type': 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: raw ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* байты */ }
  return { status: res.status, json, buf };
};

(async () => {
  const created: string[] = [];
  try {
    console.log('0. Вход');
    const login = await call('POST', '/api/login', LOGIN);
    token = login.json?.token || '';
    ok('вход выполнен', !!token, login.status);

    console.log('\n1. Файл в Проводнике');
    const first = Buffer.from('ПЕРВАЯ ВЕРСИЯ '.repeat(20000));
    const mk = await call('POST', '/api/files', { name: `__проба офиса ${Date.now()}.docx`, filePath: '/shared/__проба.docx' });
    const id = mk.json?.id || mk.json?.file?.id;
    ok('файл заведён', !!id, mk.json);
    if (!id) throw new Error('нет файла');
    created.push(id);
    ok('первое содержимое легло', (await call('POST', `/api/files/${id}/chunk`, { idx: 0, data: first.toString('base64') })).status === 200);
    await call('POST', `/api/files/${id}/done`, { count: 1 });

    const meta = await call('GET', `/api/office/files/${id}/meta`);
    ok('хеш совпадает с загруженным', meta.json?.sha256 === sha(first), meta.json);

    console.log('\n2. Сохранение со сверкой');
    const second = Buffer.from('вторая');
    const noBase = await call('PUT', `/api/office/files/${id}/content`, second);
    ok('без базового хеша — отказ', noBase.status === 400, noBase.json);
    const wrong = await call('PUT', `/api/office/files/${id}/content`, second, { 'X-Base-Sha256': 'deadbeef' });
    ok('с чужим хешем — 409', wrong.status === 409, wrong.json);
    ok('в ответе нынешний хеш', wrong.json?.currentSha256 === sha(first), wrong.json);
    const still = await call('GET', `/api/files/${id}/raw`);
    ok('после отказа содержимое прежнее', sha(still.buf) === sha(first));

    const saved = await call('PUT', `/api/office/files/${id}/content`, second, { 'X-Base-Sha256': sha(first) });
    ok('с верным хешем — записано', saved.status === 200 && saved.json?.version === 1, saved.json);
    const now = await call('GET', `/api/files/${id}/raw`);
    ok('файл короче прежнего читается без старого хвоста', now.buf.equals(second), { длина: now.buf.length });

    const versions = await call('GET', `/api/office/files/${id}/versions`);
    const v1 = versions.json?.versions?.[0];
    ok('прежнее лежит в откате', v1?.version === 1 && v1?.sha256 === sha(first) && v1?.size === first.length, versions.json);

    const same = await call('PUT', `/api/office/files/${id}/content`, second, { 'X-Base-Sha256': sha(second) });
    ok('то же содержимое — без новой версии', same.json?.unchanged === true, same.json);

    console.log('\n3. Перезапись кусками Проводника');
    const big = Buffer.from('Д'.repeat(300000));
    const piece = 100000;
    for (let i = 0, idx = 0; i < big.length; i += piece, idx++) {
      await call('POST', `/api/files/${id}/chunk`, { idx, data: big.subarray(i, i + piece).toString('base64') });
    }
    await call('POST', `/api/files/${id}/done`, { count: Math.ceil(big.length / piece) });
    const small = Buffer.from('коротко');
    await call('POST', `/api/files/${id}/chunk`, { idx: 0, data: small.toString('base64') });
    const done = await call('POST', `/api/files/${id}/done`, { count: 1 });
    ok('размер посчитан по новому содержимому', done.json?.size === small.length, done.json);
    const back = await call('GET', `/api/files/${id}/raw`);
    ok('хвоста прежнего файла нет', back.buf.equals(small), { длина: back.buf.length });

    console.log('\n4. Копия рядом («Сохранить как»)');
    const mine = Buffer.from('мой вариант');
    const cp = await call('POST', `/api/office/files/${id}/copy?name=${encodeURIComponent('../../Копия:*.docx')}`, mine);
    ok('копия заведена', cp.status === 200 && !!cp.json?.id, cp.json);
    if (cp.json?.id) created.push(cp.json.id);
    ok('имя без пути и запрещённых знаков, расширение на месте', cp.json?.name === 'Копия.docx', cp.json?.name);
    ok('хеш копии верный', cp.json?.sha256 === sha(mine), cp.json);
    const cpBytes = await call('GET', `/api/files/${cp.json?.id}/raw`);
    ok('в копии — мой вариант', cpBytes.buf.equals(mine), { длина: cpBytes.buf.length });
    const orig = await call('GET', `/api/files/${id}/raw`);
    ok('исходник не тронут', orig.buf.equals(small));
    const cp2 = await call('POST', `/api/office/files/${id}/copy?name=${encodeURIComponent('Копия.docx')}`, mine);
    if (cp2.json?.id) created.push(cp2.json.id);
    ok('второе то же имя — свободное «(2)»', cp2.json?.name === 'Копия (2).docx', cp2.json?.name);

    console.log('\n5. Чужой личный файл');
    const stamp = Date.now().toString(36);
    const pass = `Пр${stamp}!7`;
    const mk2 = await call('POST', '/api/users', { symbol: `ofc${stamp}`, name: 'Проба Офис', password: pass, role: 'USER' });
    const mateId = mk2.json?.user?.id || mk2.json?.id;
    ok('второй сотрудник заведён', !!mateId, mk2.json);
    const personal = await call('POST', '/api/files', { name: `__личное ${stamp}.docx`, scope: 'PERSONAL', filePath: '/personal/x.docx' });
    const pid = personal.json?.file?.id;
    if (pid) created.push(pid);
    await call('POST', `/api/files/${pid}/chunk`, { idx: 0, data: first.subarray(0, 100).toString('base64') });
    await call('POST', `/api/files/${pid}/done`, { count: 1 });
    const keepAdmin = token;
    token = (await call('POST', '/api/login', { symbol: `ofc${stamp}`, password: pass })).json?.token || '';
    ok('второй сотрудник вошёл', !!token);
    const foreign = await call('PUT', `/api/office/files/${pid}/content`, second, { 'X-Base-Sha256': sha(first.subarray(0, 100)) });
    ok('чужой личный файл не перезаписать', foreign.status === 403, [foreign.status, foreign.json]);
    const foreignCopy = await call('POST', `/api/office/files/${pid}/copy?name=x.docx`, second);
    ok('и копию в чужую личную папку не положить', foreignCopy.status === 403, foreignCopy.status);
    const foreignChunk = await call('POST', `/api/files/${pid}/chunk`, { idx: 0, data: second.toString('base64') });
    ok('и кусками Проводника тоже', foreignChunk.status === 403, foreignChunk.status);
    token = keepAdmin;
    const still2 = await call('GET', `/api/files/${pid}/raw`);
    ok('личный файл цел', still2.buf.equals(first.subarray(0, 100)));
    await call('DELETE', `/api/users/${mateId}`);

    console.log('\n6. Без входа');
    const keep = token; token = '';
    const anon = await call('PUT', `/api/office/files/${id}/content`, second, { 'X-Base-Sha256': sha(small) });
    ok('без входа — не записано', anon.status === 401 || anon.status === 403, anon.status);
    token = keep;
  } catch (e: any) {
    ok('проба оборвалась', false, String(e?.message || e));
  } finally {
    for (const id of created) await call('DELETE', `/api/files/${id}`).catch(() => {});
  }
  console.log(f ? `\nПРОВАЛОВ: ${f}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
  process.exit(f ? 1 : 0);
})();
