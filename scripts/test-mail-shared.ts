import { testCredentials } from './testCredentials';
/**
 * Общий ящик компании: проверки правил на живом сервере.
 *
 * Здесь проверяется то, ради чего общий ящик и отличается от личного:
 *
 *  - «прочитано» у каждого своё. Флаг \Seen в IMAP один на всех, и без
 *    отдельного хранения открытое одним письмо пропадало бы из непрочитанных
 *    у остальных девяти;
 *  - переписку нельзя молча перехватить у того, кто её ведёт;
 *  - чужой личный ящик не виден никому, включая администратора;
 *  - сцепка с программой: вложение ложится в Проводник, письмо — в Блокнот.
 *
 * Что набору нужно, он заводит сам: второго сотрудника и личный ящик. Ждать,
 * что они окажутся в базе, нельзя — прогон стал бы зависеть от того, что там
 * лежало, и падал бы на чистой установке. Письма завести нечем: они приходят
 * только с почтового сервера. Без синтетических seed-писем весь набор
 * выводит SKIP, а не PASS: проверки переписки и межпрограммной связи неполны.
 *
 * За собой набор прибирает: заведённое им — удаляет.
 *
 * Нужен поднятый сервер: `npx tsx server.ts`.
 */
const BASE = process.env.FLUX_API || 'http://localhost:3000';
const ADMIN = testCredentials();

let ok = 0;
let fail = 0;
const eq = (name: string, got: any, want: any) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { ok++; console.log(`  ✓ ${name}`); } else {
    fail++;
    console.log(`  ✗ ${name}\n      получили: ${g}\n      ожидали:  ${w}`);
  }
};

async function call(method: string, path: string, token: string, body?: any) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json: json as any };
}

async function login(symbol: string, password: string): Promise<string> {
  const r = await call('POST', '/api/login', '', { symbol, password });
  return r.json?.token || '';
}

const SHARED_MAIL = 'проверка-общая@flux.invalid';
const PERSONAL_MAIL = 'проверка-личная@flux.invalid';
const MATE_SYMBOL = 'FluxTestMate';
const MAIL_FIXTURE_SKIP_REASON = 'нужна изолированная почтовая фикстура с seed-письмом в общем ящике и письмом с вложением; без неё проверки переписки и связи со смежными программами неполны';

/** Убрать за собой всё, что набор завёл сам. Чужого не трогаем. */
async function cleanup(admin: string, made: {
  shared: any; personal: any; mate: any;
  sharedMine: boolean; personalMine: boolean; mateMine: boolean;
}) {
  if (made.sharedMine && made.shared?.id) await call('DELETE', `/api/mail/accounts/${made.shared.id}`, admin);
  if (made.personalMine && made.personal?.id) await call('DELETE', `/api/mail/accounts/${made.personal.id}`, admin);
  if (made.mateMine && made.mate?.id) await call('DELETE', `/api/users/${made.mate.id}`, admin);
}

const run = async () => {
  console.log('1. Вход');
  const admin = await login(ADMIN.symbol, ADMIN.password);
  eq('администратор вошёл', Boolean(admin), true);
  if (!admin) { console.log('\nСервер не отвечает или пароль не тот'); process.exit(1); }

  console.log('\n2. Ящики, которых набору не хватает, он заводит сам');
  const before = await call('GET', '/api/mail/accounts', admin);
  const had: any[] = before.json?.accounts || [];
  eq('пароль наружу не отдаётся', had.every((a) => a.secret === undefined && a.secretNonce === undefined), true);

  let shared = had.find((a) => a.scope === 'SHARED');
  let sharedMine = false;
  if (!shared) {
    // active: false — ящик выдуманный, ждать по нему письма незачем
    const made = await call('POST', '/api/mail/accounts', admin, {
      scope: 'SHARED', label: 'Проверочная общая', email: SHARED_MAIL,
      password: 'проверка', imapHost: 'imap.invalid', smtpHost: 'smtp.invalid', active: false,
    });
    shared = made.json?.account;
    sharedMine = Boolean(shared);
    eq('общий ящик заведён', Boolean(shared), true);
  } else {
    console.log('  · общий ящик уже подключён — берём его');
  }
  if (!shared) { console.log('\nБез общего ящика проверять нечего'); process.exit(1); }

  let personal = had.find((a) => a.scope === 'PERSONAL');
  let personalMine = false;
  if (!personal) {
    const made = await call('POST', '/api/mail/accounts', admin, {
      email: PERSONAL_MAIL, password: 'проверка',
      imapHost: 'imap.invalid', smtpHost: 'smtp.invalid', active: false,
    });
    personal = made.json?.account;
    personalMine = Boolean(personal);
    eq('личный ящик заведён', Boolean(personal), true);
  }

  console.log('\n3. Второй сотрудник');
  // Смысл общего ящика виден только вдвоём — одного сеанса не хватит
  const pass = 'проверка-общего-ящика';
  // Проверка создаёт свой профиль и не меняет пароль существующего сотрудника.
  const madeMate = await call('POST', '/api/users', admin, {
    name: 'Проверочный Сотрудник', symbol: MATE_SYMBOL, password: pass, role: 'ENGINEER_VENT',
  });
  const mate = madeMate.json?.user || madeMate.json;
  const mateMine = Boolean(mate?.id);
  eq('второй сотрудник заведён', mateMine, true);
  if (!mate?.id) { console.log('\nНекому проверять общий доступ'); process.exit(1); }

  const mateToken = await login(mate.symbol, pass);
  eq('второй сотрудник вошёл', Boolean(mateToken), true);
  if (!mateToken) process.exit(1);

  console.log('\n4. Общий ящик виден обоим, личный — только владельцу');
  const mateAccounts = await call('GET', '/api/mail/accounts', mateToken);
  const mateList: any[] = mateAccounts.json?.accounts || [];
  eq('общий ящик виден второму', mateList.some((a) => a.id === shared.id), true);
  eq('чужой личный ящик не виден', mateList.some((a) => a.id === personal?.id), false);

  console.log('\n5. Прочитано — у каждого своё');
  const t1 = await call('GET', `/api/mail/threads?accountId=${shared.id}`, admin);
  const threads: any[] = t1.json?.threads || [];
  if (!threads.length) {
    console.log(`FLUX_VERIFY_SKIP: ${MAIL_FIXTURE_SKIP_REASON}`);
    await cleanup(admin, { shared, personal, mate, sharedMine, personalMine, mateMine });
    console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
    process.exit(fail ? 1 : 0);
  }

  const target = threads.find((t) => t.unread) || threads[0];
  await call('POST', '/api/mail/flag', admin, { ids: target.ids, flag: 'seen', on: true });

  const afterMe = await call('GET', `/api/mail/threads?accountId=${shared.id}`, admin);
  const mineNow = (afterMe.json?.threads || []).find((t: any) => t.threadKey === target.threadKey);
  eq('у меня письмо стало прочитанным', mineNow?.unread, false);

  const afterMate = await call('GET', `/api/mail/threads?accountId=${shared.id}`, mateToken);
  const mateNow = (afterMate.json?.threads || []).find((t: any) => t.threadKey === target.threadKey);
  // Ради этого и заведена отдельная таблица: иначе флаг IMAP погасил бы
  // непрочитанное сразу у всех
  eq('у коллеги оно осталось непрочитанным', mateNow?.unread, true);

  console.log('\n6. Переписку не перехватывают молча');
  const claim = await call('POST', '/api/mail/shared/claim', admin, {
    accountId: shared.id, threadKey: target.threadKey, on: true,
  });
  eq('взял в работу', claim.json?.state?.claimedById ? true : false, true);

  const steal = await call('POST', '/api/mail/shared/claim', mateToken, {
    accountId: shared.id, threadKey: target.threadKey, on: true,
  });
  eq('коллега получает отказ, а не молчаливый перехват', steal.status, 409);
  eq('и в отказе сказано, кто ведёт', String(steal.json?.error || '').includes('уже ведёт'), true);

  const release = await call('POST', '/api/mail/shared/claim', mateToken, {
    accountId: shared.id, threadKey: target.threadKey, on: false,
  });
  eq('и отпустить чужое тоже нельзя', release.status, 403);

  console.log('\n7. Пометка коллегам');
  const note = await call('POST', '/api/mail/shared/note', admin, {
    accountId: shared.id, threadKey: target.threadKey, note: 'Проверка ленты',
  });
  eq('пометка записана', (note.json?.activity || []).some((a: any) => a.note === 'Проверка ленты'), true);
  const seenByMate = await call('GET', `/api/mail/thread?accountId=${shared.id}&threadKey=${encodeURIComponent(target.threadKey)}`, mateToken);
  eq('и видна коллеге', (seenByMate.json?.activity || []).some((a: any) => a.note === 'Проверка ленты'), true);

  console.log('\n8. Настройки общего ящика — не всякому');
  const meddle = await call('PUT', `/api/mail/accounts/${shared.id}`, mateToken, { label: 'Переименовал' });
  eq('сотрудник без права не меняет общий ящик', meddle.status, 403);

  console.log('\n9. Чужой личный ящик недоступен по прямому обращению');
  if (personal) {
    const peek = await call('GET', `/api/mail/threads?accountId=${personal.id}`, mateToken);
    eq('писем не отдаёт', (peek.json?.threads || []).length, 0);
    const edit = await call('PUT', `/api/mail/accounts/${personal.id}`, mateToken, { label: 'Чужое' });
    eq('и править не даёт', edit.status, 404);
  }

  // Прибираем за собой: отпускаем переписку
  await call('POST', '/api/mail/shared/claim', admin, {
    accountId: shared.id, threadKey: target.threadKey, on: false,
  });

  console.log('\n10. Сцепка с программой');
  // Проверяется на любом письме с вложением — своём или из общего ящика.
  // Если таких писем в базе нет, раздел просто не с чем сцеплять.
  const allAccounts = [shared, personal].filter(Boolean);
  let withFile: { accountId: string; threadKey: string } | null = null;
  for (const a of allAccounts) {
    const r = await call('GET', `/api/mail/threads?accountId=${a.id}`, admin);
    const t = (r.json?.threads || []).find((x: any) => x.hasFiles);
    if (t) { withFile = { accountId: a.id, threadKey: t.threadKey }; break; }
  }

  if (!withFile) {
    console.log(`FLUX_VERIFY_SKIP: ${MAIL_FIXTURE_SKIP_REASON}`);
  } else {
    const one = await call('GET', `/api/mail/thread?accountId=${withFile.accountId}&threadKey=${encodeURIComponent(withFile.threadKey)}`, admin);
    const att = (one.json?.attachments || [])[0];
    const letter = (one.json?.messages || [])[0];
    eq('вложение нашлось', Boolean(att), true);

    const folders = await call('GET', '/api/mail/link/folders', admin);
    const folderId = (folders.json?.folders || [])[0]?.id || '';
    eq('есть куда сохранить', Boolean(folderId), true);

    const saved = await call('POST', `/api/mail/attachments/${att?.id}/to-explorer`, admin, { folderId });
    eq('вложение легло в Проводник', Boolean(saved.json?.file?.id), true);

    // Второй раз тот же файл не должен затирать первый
    const again = await call('POST', `/api/mail/attachments/${att?.id}/to-explorer`, admin, { folderId });
    eq('повтор не затирает — имя разведено',
      again.json?.file?.name !== saved.json?.file?.name, true);

    const note = await call('POST', `/api/mail/messages/${letter?.id}/to-note`, admin, {});
    eq('письмо стало заметкой', Boolean(note.json?.note?.id), true);

    // Чужому письму сцепка недоступна так же, как и само письмо
    const foreign = await call('POST', `/api/mail/messages/${letter?.id}/to-note`, mateToken, {});
    const mineOnly = personal && withFile.accountId === personal.id;
    if (mineOnly) eq('к чужому письму не прицепиться', foreign.status, 404);
    else eq('к письму общего ящика прицепиться можно', foreign.status, 200);
  }

  await cleanup(admin, { shared, personal, mate, sharedMine, personalMine, mateMine });

  console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
  process.exit(fail ? 1 : 0);
};

run().catch((err) => {
  console.error('\nСбой прогона:', err?.message || err);
  process.exit(1);
});
