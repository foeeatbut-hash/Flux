/**
 * Вложение к обращению доезжает целым.
 *
 * Проверять надо именно живьём: половина условий здесь про поведение при
 * обрыве связи, а обрыв — это не ветка кода, это повтор запроса.
 *
 * Главное, ради чего проверка: повторно присланный кусок не должен задваивать
 * файл, а кусок с другим содержимым под тем же номером не должен молча
 * склеиться с прежним. И то и другое даёт файл, который открывается, но
 * содержит мусор, — худший из возможных исходов.
 *
 * Нужен поднятый сервер: npx tsx server.ts
 */

import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { FEATURES } from '../src/lib/permissions';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };

let f = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond
    ? console.log('  ✓', name)
    : (f++, console.error('  ✗', name, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ''));

async function api(method: string, path: string, token: string, body?: any) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch (_) { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

async function putChunk(token: string, uploadId: string, index: number, bytes: Buffer, hash?: string) {
  const res = await fetch(`${BASE}/api/feedback/uploads/${uploadId}/chunks/${index}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      Authorization: `Bearer ${token}`,
      ...(hash === undefined ? {} : { 'X-Chunk-SHA256': hash }),
    },
    body: bytes as any,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function main() {
  try {
    const health = await fetch(`${BASE}/api/health`);
    if (!health.ok) throw new Error(String(health.status));
  } catch (_) {
    console.error(`Сервер на ${BASE} не отвечает. Поднимите его: npx tsx server.ts`);
    process.exit(2);
  }

  const admin = (await api('POST', '/api/login', '', LOGIN)).json?.token || '';
  if (!admin) { console.error('Не удалось войти'); process.exit(2); }
  const stamp = Date.now().toString(36).slice(-6);

  console.log('1. Что окно узнаёт до первого действия');
  const meta = await api('GET', '/api/feedback/meta', admin);
  ok('сведения отданы', meta.status === 200, meta.json);
  const chunkSize = meta.json?.data?.chunkSize || 0;
  ok('размер куска согласован', chunkSize >= 8 * 1024, chunkSize);
  ok('признак контура выдан', !!meta.json?.data?.deploymentId);
  ok('права названы', meta.json?.data?.rights?.create === true, meta.json?.data?.rights);
  ok('пределы отдаёт сервер, а не зашивает окно', meta.json?.data?.limits?.title?.max === 160);

  console.log('\n2. Файл едет кусками и собирается байт в байт');
  // Файл заведомо больше одного куска и с неровным хвостом: ровный размер
  // скрыл бы ошибку на последнем куске
  const file = Buffer.alloc(chunkSize * 2 + 777);
  for (let i = 0; i < file.length; i++) file[i] = (i * 31 + 7) & 0xff;
  // Похоже на PNG, чтобы проверка вида файла прошла
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(file, 0);
  const total = sha(file);
  const pieces: Buffer[] = [];
  for (let at = 0; at < file.length; at += chunkSize) pieces.push(file.slice(at, at + chunkSize));

  const started = await api('POST', '/api/feedback/uploads', admin, {
    clientRequestId: randomUUID(), kind: 'IMAGE', name: `снимок ${stamp}.png`, size: file.length, sha256: total,
  });
  ok('загрузка заведена', started.status === 201, started.json);
  const uploadId = started.json?.data?.uploadId;
  ok('кусков посчитано верно', started.json?.data?.chunkCount === pieces.length, started.json?.data);

  // Вразнобой: клиент шлёт параллельно, и порядок прихода не гарантирован
  const order = [1, 2, 0].filter((i) => i < pieces.length);
  for (const i of order) {
    const r = await putChunk(admin, uploadId, i, pieces[i], sha(pieces[i]));
    ok(`кусок ${i} принят`, r.status === 204, r);
  }
  const done = await api('POST', `/api/feedback/uploads/${uploadId}/complete`, admin, {});
  ok('файл собран', done.status === 200, done.json);
  ok('и признан картинкой по содержимому', done.json?.data?.verifiedMime === 'image/png', done.json?.data);
  ok('размер сошёлся', done.json?.data?.byteLength === file.length, done.json?.data);

  console.log('\n3. Обрыв связи и повторы');
  const again = await putChunk(admin, uploadId, 0, pieces[0], sha(pieces[0]));
  ok('повтор после сборки уже не принимается', again.status !== 204, again.status);

  const second = await api('POST', '/api/feedback/uploads', admin, {
    clientRequestId: randomUUID(), kind: 'FILE', name: `данные ${stamp}.txt`, size: 40, sha256: sha(Buffer.alloc(40)),
  });
  const twoId = second.json?.data?.uploadId;
  const part = Buffer.alloc(40);
  ok('кусок принят', (await putChunk(admin, twoId, 0, part, sha(part))).status === 204);
  // Обычное дело: клиент не дождался ответа и прислал тот же кусок ещё раз
  ok('тот же кусок ещё раз — молча принят',
    (await putChunk(admin, twoId, 0, part, sha(part))).status === 204);
  const other = Buffer.alloc(40, 1);
  const clash = await putChunk(admin, twoId, 0, other, sha(other));
  // А это уже другой файл: склеивать нельзя, иначе получится читаемый мусор
  ok('другой кусок под тем же номером отвергнут', clash.status === 409, clash.status);
  ok('и отказ назван по имени', clash.json?.error?.code === 'CHUNK_CONFLICT', clash.json?.error);

  const lied = await putChunk(admin, twoId, 0, part, sha(other));
  ok('несошедшийся отпечаток куска отвергнут', lied.status === 400, lied.status);

  console.log('\n4. Повтор заведения не плодит загрузок');
  const key = randomUUID();
  const a = await api('POST', '/api/feedback/uploads', admin, {
    clientRequestId: key, kind: 'FILE', name: `повтор ${stamp}.txt`, size: 10, sha256: sha(Buffer.alloc(10)),
  });
  const b = await api('POST', '/api/feedback/uploads', admin, {
    clientRequestId: key, kind: 'FILE', name: `повтор ${stamp}.txt`, size: 10, sha256: sha(Buffer.alloc(10)),
  });
  ok('второй раз вернулась та же загрузка', a.json?.data?.uploadId === b.json?.data?.uploadId,
    [a.json?.data?.uploadId, b.json?.data?.uploadId]);

  console.log('\n5. Чего не принимаем');
  const exe = await api('POST', '/api/feedback/uploads', admin, {
    clientRequestId: randomUUID(), kind: 'FILE', name: 'вирус.exe', size: 10, sha256: sha(Buffer.alloc(10)),
  });
  ok('исполняемое отвергнуто сразу по имени', exe.status === 415, [exe.status, exe.json?.error?.code]);

  // Разметка страницы под видом картинки: имя проходит, содержимое — нет
  const html = Buffer.from('<!DOCTYPE html><script>alert(1)</script>', 'utf8');
  const fake = await api('POST', '/api/feedback/uploads', admin, {
    clientRequestId: randomUUID(), kind: 'IMAGE', name: `подделка ${stamp}.png`, size: html.length, sha256: sha(html),
  });
  const fakeId = fake.json?.data?.uploadId;
  await putChunk(admin, fakeId, 0, html, sha(html));
  const fakeDone = await api('POST', `/api/feedback/uploads/${fakeId}/complete`, admin, {});
  ok('страница под видом картинки отвергнута', fakeDone.status === 415, [fakeDone.status, fakeDone.json?.error]);

  const short = await api('POST', '/api/feedback/uploads', admin, {
    clientRequestId: randomUUID(), kind: 'FILE', name: `недобор ${stamp}.txt`, size: chunkSize * 2, sha256: sha(Buffer.alloc(4)),
  });
  const shortId = short.json?.data?.uploadId;
  await putChunk(admin, shortId, 0, Buffer.alloc(chunkSize), sha(Buffer.alloc(chunkSize)));
  const shortDone = await api('POST', `/api/feedback/uploads/${shortId}/complete`, admin, {});
  ok('неполный файл не собирается', shortDone.status === 400, shortDone.json?.error?.message);

  console.log('\n6. Чужая загрузка недоступна');
  const pass = `p${stamp}A!`;
  const perms: Record<string, any> = {};
  for (const feat of FEATURES) perms[feat.id] = { enabled: true, until: null };
  const mate = await api('POST', '/api/users', admin, {
    symbol: `fb${stamp}`, name: 'Проба Обращений', password: pass, role: 'USER', permissions: JSON.stringify(perms),
  });
  const mateId = mate.json?.user?.id || mate.json?.id;
  const mateToken = (await api('POST', '/api/login', '', { symbol: `fb${stamp}`, password: pass })).json?.token || '';
  ok('второй сотрудник вошёл', !!mateToken, mate.json);

  const peek = await api('GET', `/api/feedback/uploads/${uploadId}`, mateToken);
  // Отвечаем «не найдено», а не «нельзя»: иначе по ответу можно перебрать,
  // какие загрузки существуют
  ok('чужую загрузку не видно', peek.status === 404, peek.status);
  const push = await putChunk(mateToken, uploadId, 0, pieces[0], sha(pieces[0]));
  ok('в чужую загрузку не дописать', push.status === 404, push.status);
  const kill = await api('DELETE', `/api/feedback/uploads/${uploadId}`, mateToken);
  ok('чужую загрузку не отменить', kill.status === 404, kill.status);

  console.log('\n7. Свою — отменить можно');
  const mineKill = await api('DELETE', `/api/feedback/uploads/${twoId}`, admin);
  ok('своя загрузка отменяется', mineKill.status === 200, mineKill.json);
  const after = await putChunk(admin, twoId, 1, part, sha(part));
  ok('в отменённую дописать нельзя', after.status === 409, after.status);

  if (mateId) await api('DELETE', `/api/users/${mateId}`, admin).catch(() => {});
  console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
  process.exit(f === 0 ? 0 : 1);
}

void main().catch((error) => { console.error(error); process.exit(1); });
