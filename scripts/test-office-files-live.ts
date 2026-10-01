import { testCredentials } from './testCredentials';
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
const LOGIN = testCredentials();

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
  return { status: res.status, json, buf, headers: res.headers };
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
    ok('общий файл в корне не привязан к проекту', meta.json?.projectId === null, meta.json);

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

    console.log('\n4. Два сохранения из одной версии');
    const beforeRace = await call('GET', `/api/office/files/${id}/versions`);
    const versionsBeforeRace = beforeRace.json?.versions || [];
    const contenderA = Buffer.from('вариант А');
    const contenderB = Buffer.from('вариант Б');
    const race = await Promise.all([
      call('PUT', `/api/office/files/${id}/content`, contenderA, { 'X-Base-Sha256': sha(small) }),
      call('PUT', `/api/office/files/${id}/content`, contenderB, { 'X-Base-Sha256': sha(small) }),
    ]);
    const winnerIndex = race.findIndex((result) => result.status === 200);
    const loserIndex = race.findIndex((result) => result.status === 409);
    ok('из одной базы прошла ровно одна запись', winnerIndex >= 0 && loserIndex >= 0
      && race.filter((result) => result.status === 200).length === 1
      && race.filter((result) => result.status === 409).length === 1, race.map((result) => result.status));
    const winnerBytes = winnerIndex === 0 ? contenderA : contenderB;
    const raceCurrent = await call('GET', `/api/files/${id}/raw`);
    ok('победившие байты остались в файле', winnerIndex >= 0 && raceCurrent.buf.equals(winnerBytes), {
      status: race[winnerIndex]?.status, length: raceCurrent.buf.length,
    });
    const afterRaceVersions = await call('GET', `/api/office/files/${id}/versions`);
    const versionsAfterRace = afterRaceVersions.json?.versions || [];
    const capturedPrestate = versionsAfterRace.find((version: any) => version.sha256 === sha(small));
    ok('конкурентная запись сохранила исходное содержимое ровно один раз',
      versionsAfterRace.length === versionsBeforeRace.length + 1
        && versionsAfterRace.filter((version: any) => version.sha256 === sha(small)).length === 1
        && capturedPrestate?.size === small.length,
      { before: versionsBeforeRace.length, after: versionsAfterRace.length, capturedPrestate });

    console.log('\n5. Запись через API во время общей сессии');
    const sharedOpen = await call('GET', `/api/office/files/${id}/open`);
    const staleBaseSha = sharedOpen.headers.get('x-base-sha256') || '';
    const sessionKey = sharedOpen.headers.get('x-collab-session') || '';
    ok('общий файл открылся с базой и ключом сеанса', sharedOpen.status === 200 && !!staleBaseSha && !!sessionKey,
      { status: sharedOpen.status, staleBaseSha, hasSession: !!sessionKey });
    const externalBytes = Buffer.from('содержимое, записанное вне сеанса');
    const externalChunk = await call('POST', `/api/files/${id}/chunk`, {
      idx: 0, data: externalBytes.toString('base64'),
    });
    const externalDone = await call('POST', `/api/files/${id}/done`, { count: 1 });
    ok('внешняя запись через Проводник прошла', externalChunk.status === 200 && externalDone.status === 200,
      { chunk: externalChunk.status, done: externalDone.status });
    const staleSave = await call('PUT', `/api/office/files/${id}/content`, Buffer.from('устаревшая правка'), {
      'X-Base-Sha256': staleBaseSha,
      'X-Office-Session': sessionKey,
    });
    ok('устаревший PUT получает 409 и не считается записью сеанса',
      staleSave.status === 409 && staleSave.json?.bySession === false, staleSave.json);
    const externalCurrent = await call('GET', `/api/files/${id}/raw`);
    ok('внешние байты не затёрты устаревшей версией', externalCurrent.buf.equals(externalBytes));

    console.log('\n6. Копия рядом («Сохранить как»)');
    const mine = Buffer.from('мой вариант');
    const sourceBeforeCopy = await call('GET', `/api/files/${id}/raw`);
    const cp = await call('POST', `/api/office/files/${id}/copy?name=${encodeURIComponent('../../Копия:*.docx')}`, mine);
    ok('копия заведена', cp.status === 200 && !!cp.json?.id, cp.json);
    if (cp.json?.id) created.push(cp.json.id);
    ok('имя без пути и запрещённых знаков, расширение на месте', cp.json?.name === 'Копия.docx', cp.json?.name);
    ok('хеш копии верный', cp.json?.sha256 === sha(mine), cp.json);
    const cpBytes = await call('GET', `/api/files/${cp.json?.id}/raw`);
    ok('в копии — мой вариант', cpBytes.buf.equals(mine), { длина: cpBytes.buf.length });
    const orig = await call('GET', `/api/files/${id}/raw`);
    ok('исходник не тронут', orig.buf.equals(sourceBeforeCopy.buf));
    const cp2 = await call('POST', `/api/office/files/${id}/copy?name=${encodeURIComponent('Копия.docx')}`, mine);
    if (cp2.json?.id) created.push(cp2.json.id);
    ok('второе то же имя — свободное «(2)»', cp2.json?.name === 'Копия (2).docx', cp2.json?.name);

    console.log('\n7. Чужой личный файл');
    const stamp = Date.now().toString(36);
    const pass = `Пр${stamp}!7`;
    const mk2 = await call('POST', '/api/users', { symbol: `ofc${stamp}`, name: 'Проба Офис', password: pass, role: 'ENGINEER_VENT' });
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
    // Чужой личный файл для постороннего не существует (server/fileAccess.ts):
    // «нельзя» выдавало бы, что такой файл есть
    const foreign = await call('PUT', `/api/office/files/${pid}/content`, second, { 'X-Base-Sha256': sha(first.subarray(0, 100)) });
    ok('чужой личный файл не перезаписать', foreign.status === 404, [foreign.status, foreign.json]);
    const foreignCopy = await call('POST', `/api/office/files/${pid}/copy?name=x.docx`, second);
    ok('и копию в чужую личную папку не положить', foreignCopy.status === 404, foreignCopy.status);
    const foreignChunk = await call('POST', `/api/files/${pid}/chunk`, { idx: 0, data: second.toString('base64') });
    ok('и кусками Проводника тоже', foreignChunk.status === 404, foreignChunk.status);
    token = keepAdmin;
    const still2 = await call('GET', `/api/files/${pid}/raw`);
    ok('личный файл цел', still2.buf.equals(first.subarray(0, 100)));
    await call('DELETE', `/api/users/${mateId}`);

    console.log('\n8. Без входа');
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
