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

  console.log('\n2.1. Приложенное читается обратно');
  // Без этого весь остальной путь бессмыслен: файл доехал до общей базы, но
  // открыть его не может никто — карточка показывает имя, а смотреть нечего.
  //
  // Оба участника заводятся здесь свои: администратор за день проверок
  // упирается в предел «двадцать обращений в час», и раздел падал бы не по
  // делу. И ни у кого из них нет права разбора — иначе «чужое вложение
  // недоступно» проверяло бы не то: разбирающему оно доступно по праву.
  {
    const pass = `p${stamp}B!`;
    const plain: Record<string, any> = {};
    for (const feat of FEATURES) plain[feat.id] = { enabled: feat.id !== 'feedback.triage', until: null };

    const who = async (suffix: string) => {
      const symbol = `fbc${stamp}${suffix}`;
      await api('POST', '/api/users', admin, {
        symbol, name: `Проба Вложений ${suffix}`, password: pass, role: 'USER',
        permissions: JSON.stringify(plain),
      });
      return (await api('POST', '/api/login', '', { symbol, password: pass })).json?.token || '';
    };
    const author = await who('a');
    const other = await who('b');
    ok('автор и посторонний заведены', !!author && !!other);

    const little = Buffer.alloc(4096);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(little, 0);
    for (let i = 8; i < little.length; i++) little[i] = (i * 17 + 3) & 0xff;
    const own = await api('POST', '/api/feedback/uploads', author, {
      clientRequestId: randomUUID(), kind: 'IMAGE',
      name: `своё ${stamp}.png`, size: little.length, sha256: sha(little),
    });
    const ownId = own.json?.data?.uploadId;
    await putChunk(author, ownId, 0, little, sha(little));
    const built = await api('POST', `/api/feedback/uploads/${ownId}/complete`, author, {});
    ok('файл автора собран', built.status === 200, built.json?.error);

    const report = await api('POST', '/api/feedback/reports', author, {
      schemaVersion: 1, clientRequestId: randomUUID(),
      deploymentId: meta.json?.data?.deploymentId,
      type: 'BUG', title: '__проверка чтения вложения',
      description: 'Обращение заведено, чтобы скачать вложение обратно.',
      sectionKey: '/settings', incidentAt: new Date().toISOString(), appVersion: '0.0.0',
      frequency: 'ONCE', impact: 'LOW', uploadIds: [ownId],
      consent: { technicalEvents: true, appContext: true, reviewedAt: new Date().toISOString() },
    });
    ok('обращение с вложением заведено', report.status === 201, [report.status, report.json?.error]);
    const card = await api('GET', `/api/feedback/reports/${report.json?.data?.id}`, author);
    const attachment = (card.json?.data?.attachments || [])[0];
    ok('вложение видно в карточке', !!attachment?.id, card.json?.data?.attachments);

    const back = await fetch(`${BASE}/api/feedback/attachments/${attachment?.id}`, {
      headers: { Authorization: `Bearer ${author}` },
    });
    ok('автору вложение отдаётся', back.status === 200, back.status);
    const got = Buffer.from(await back.arrayBuffer());
    ok('байт в байт то же, что отправляли', got.equals(little), [got.length, little.length]);
    ok('тип файла назван честно', String(back.headers.get('Content-Type')).startsWith('image/png'),
      back.headers.get('Content-Type'));
    ok('браузеру запрещено угадывать тип',
      back.headers.get('X-Content-Type-Options') === 'nosniff');
    ok('имя файла доезжает', String(back.headers.get('Content-Disposition')).includes('filename*=UTF-8'),
      back.headers.get('Content-Disposition'));

    const stranger = await fetch(`${BASE}/api/feedback/attachments/${attachment?.id}`, {
      headers: { Authorization: `Bearer ${other}` },
    });
    // Чужое вложение отвечает «не найдено», а не «нельзя»: иначе по ответам
    // перебирается, что вообще существует
    ok('постороннему вложение не отдаётся', stranger.status === 404, stranger.status);

    const admins = await fetch(`${BASE}/api/feedback/attachments/${attachment?.id}`, {
      headers: { Authorization: `Bearer ${admin}` },
    });
    ok('разбирающему — отдаётся', admins.status === 200, admins.status);
  }

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

  console.log('\n6.1. Уборка берёт брошенное и не трогает приложенное');
  {
    // База здесь подставная, и это намеренно: проверяется не то, умеет ли
    // Prisma удалять, а что именно уборка выбирает и чего не трогает. Ходить
    // настоящим клиентом в ту же базу, с которой работает поднятый сервер,
    // значит проверять две вещи разом и не понять, какая сломалась
    const { sweepUploads } = await import('../server/feedback/cleanup');
    const { setPrisma } = await import('../server/context');

    const now = new Date();
    const past = new Date(now.getTime() - 60_000);
    const future = new Date(now.getTime() + 60_000);
    const uploads = [
      { id: 'brosh', status: 'OPEN', expiresAt: past },
      { id: 'gotov', status: 'READY', expiresAt: past },
      { id: 'prilozh', status: 'ATTACHED', expiresAt: past },
      { id: 'svezh', status: 'OPEN', expiresAt: future },
    ];
    const attachments = [
      { id: 'a-staroe', uploadId: 'u-staroe', expiresAt: past, expiredAt: null },
      { id: 'a-vechnoe', uploadId: 'u-vechnoe', expiresAt: null, expiredAt: null },
      { id: 'a-uzhe', uploadId: 'u-uzhe', expiresAt: past, expiredAt: past },
    ];
    const deleted: string[] = [];
    const touched: Array<[string, any]> = [];

    const matches = (row: any, where: any): boolean => {
      for (const [field, cond] of Object.entries(where || {})) {
        const value = (row as any)[field];
        if (cond && typeof cond === 'object') {
          const c: any = cond;
          if (c.in && !c.in.includes(value)) return false;
          if (c.lt !== undefined && !(value && new Date(value) < new Date(c.lt))) return false;
          if (c.not === null && value === null) return false;
        } else if (value !== cond) return false;
      }
      return true;
    };

    setPrisma({
      feedbackUpload: {
        findMany: async ({ where, take }: any) => uploads.filter((u) => matches(u, where)).slice(0, take),
        update: async ({ where, data }: any) => { touched.push([`upload:${where.id}`, data]); return {}; },
      },
      feedbackAttachment: {
        findMany: async ({ where, take }: any) => attachments.filter((a) => matches(a, where)).slice(0, take),
        update: async ({ where, data }: any) => { touched.push([`attachment:${where.id}`, data]); return {}; },
      },
      feedbackUploadChunk: {
        deleteMany: async ({ where }: any) => { deleted.push(where.uploadId); return { count: 1 }; },
      },
    });

    const swept = await sweepUploads(now);
    ok('брошенные разобраны', swept.dropped === 2, swept);
    ok('куски брошенных удалены', deleted.includes('brosh') && deleted.includes('gotov'), deleted);
    ok('приложенное к обращению не тронуто', !deleted.includes('prilozh'), deleted);
    ok('живая загрузка не тронута', !deleted.includes('svezh'), deleted);
    ok('загрузка помечена, а не удалена',
      touched.some(([k, d]) => k === 'upload:brosh' && d.status === 'EXPIRED'), touched);

    ok('просроченное вложение разобрано', swept.expired === 1, swept);
    ok('его куски удалены', deleted.includes('u-staroe'), deleted);
    ok('бессрочное вложение не тронуто', !deleted.includes('u-vechnoe'), deleted);
    ok('уже помеченное второй раз не разбирается', !deleted.includes('u-uzhe'), deleted);
    ok('у вложения ставится время, а сама запись остаётся',
      touched.some(([k, d]) => k === 'attachment:a-staroe' && !!d.expiredAt), touched);

    // Возвращаем настоящего клиента: дальше проверки снова ходят по HTTP
    setPrisma(null);
  }

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
