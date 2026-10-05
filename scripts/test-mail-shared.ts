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

async function cleanupCall(method: string, path: string, token: string, body?: any) {
  try { return await call(method, path, token, body); }
  catch { return { status: 0, json: {} as any }; }
}

async function login(symbol: string, password: string): Promise<string> {
  const r = await call('POST', '/api/login', '', { symbol, password });
  return r.json?.token || '';
}

const SHARED_MAIL = 'проверка-общая@flux.invalid';
const PERSONAL_MAIL = 'проверка-личная@flux.invalid';
const MAIL_FIXTURE_SKIP_REASON = 'нужна изолированная почтовая фикстура с seed-письмом в общем ящике и письмом с вложением; без неё проверки переписки и связи со смежными программами неполны';
type OwnedResource = { id: string; actorToken: string };
class SkippedMailRun extends Error {}

/** Убрать за собой всё, что набор завёл сам. Чужого не трогаем. */
async function cleanup(admin: string, made: {
  shared: any; personal: any; mate: any; authorizedMate: any; legacyMate: any;
  sharedMine: boolean; personalMine: boolean; mateMine: boolean; authorizedMateMine: boolean; legacyMateMine: boolean;
  sharedOriginalLabel?: string; sharedLabelChanged: boolean;
  createdNotes: OwnedResource[]; createdFiles: OwnedResource[];
  claimedThreadKey?: string;
}) {
  if (made.claimedThreadKey && made.shared?.id) {
    try {
      const released = await cleanupCall('POST', '/api/mail/shared/claim', admin, { accountId: made.shared.id, threadKey: made.claimedThreadKey, on: false });
      eq('current run released its own thread claim', released.status, 200);
    } catch { eq('current run thread claim release completed', false, true); }
  }
  for (const item of [...made.createdNotes].reverse()) {
    try {
      const r = await call('DELETE', `/api/notes/${encodeURIComponent(item.id)}`, item.actorToken);
      eq('created note cleanup', r.status, 200);
    } catch { eq('created note cleanup request completed', false, true); }
  }
  for (const item of [...made.createdFiles].reverse()) {
    try {
      const r = await call('DELETE', `/api/files/${encodeURIComponent(item.id)}`, item.actorToken);
      eq('created file cleanup', r.status, 200);
    } catch { eq('created file cleanup request completed', false, true); }
  }
  if (made.sharedLabelChanged && !made.sharedMine && made.shared?.id && made.sharedOriginalLabel !== undefined) {
    try {
      const restored = await cleanupCall('PUT', `/api/mail/accounts/${encodeURIComponent(made.shared.id)}`, admin, { label: made.sharedOriginalLabel });
      eq('reused shared mailbox label restored', restored.status, 200);
    } catch { eq('reused shared mailbox label restore request completed', false, true); }
  }
  if (made.sharedMine && made.shared?.id) {
    try {
      const r = await cleanupCall('DELETE', `/api/mail/accounts/${made.shared.id}`, admin);
      eq('созданный общей фикстурой ящик удалён', r.status, 200);
      eq('удаление ящика подтверждено сервером', r.json?.ok, true);
    } catch { eq('created shared mailbox cleanup request completed', false, true); }
  }
  if (made.personalMine && made.personal?.id) {
    const r = await cleanupCall('DELETE', `/api/mail/accounts/${made.personal.id}`, admin);
    eq('созданный личный ящик удалён', r.status, 200);
    eq('удаление личного ящика подтверждено сервером', r.json?.ok, true);
  }
  for (const [label, row, owns] of [
    ['обычный сотрудник', made.mate, made.mateMine],
    ['сотрудник с новым правом', made.authorizedMate, made.authorizedMateMine],
    ['сотрудник с прежним правом', made.legacyMate, made.legacyMateMine],
  ] as const) {
    if (!owns || !row?.id) continue;
    const r = await cleanupCall('DELETE', `/api/users/${encodeURIComponent(row.id)}`, admin);
    eq(`${label} удалён по ID, созданному текущим прогоном`, r.status, 200);
    eq(`удаление профиля «${label}» подтверждено`, r.json?.success, true);
  }
}

const run = async () => {
  const createdNotes: OwnedResource[] = [];
  const createdFiles: OwnedResource[] = [];
  let admin = '';
  let shared: any;
  let personal: any;
  let mate: any;
  let authorizedMate: any;
  let legacyMate: any;
  let sharedMine = false;
  let personalMine = false;
  let mateMine = false;
  let authorizedMateMine = false;
  let legacyMateMine = false;
  let sharedOriginalLabel: string | undefined;
  let sharedLabelChanged = false;
  let runError = false;
  let claimedThreadKey = '';
  try {
  console.log('1. Вход');
  admin = await login(ADMIN.symbol, ADMIN.password);
  eq('администратор вошёл', Boolean(admin), true);
  if (!admin) throw new Error('Сервер не отвечает или пароль не тот');

  console.log('\n2. Ящики, которых набору не хватает, он заводит сам');
  const before = await call('GET', '/api/mail/accounts', admin);
  const had: any[] = before.json?.accounts || [];
  eq('пароль наружу не отдаётся', had.every((a) => a.secret === undefined && a.secretNonce === undefined), true);

  shared = had.find((a) => a.scope === 'SHARED');
  sharedOriginalLabel = shared?.label;
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
  if (!shared) throw new Error('Без общего ящика проверять нечего');

  personal = had.find((a) => a.scope === 'PERSONAL');
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
  const stamp = Date.now().toString(36);
  const pass = `проверка-общего-ящика-${stamp}`;
  // Проверка создаёт свой профиль и не меняет пароль существующего сотрудника.
  const madeMate = await call('POST', '/api/users', admin, {
    name: 'Проверочный Сотрудник', symbol: `FluxMailMate${stamp}`, password: pass, role: 'ENGINEER_VENT',
  });
  mate = madeMate.json?.user || madeMate.json;
  mateMine = Boolean(mate?.id);
  eq('второй сотрудник заведён', mateMine, true);
  if (!mate?.id) throw new Error('Некому проверять общий доступ');

  const grantSymbol = `FluxMailGrant${stamp}`;
  const madeAuthorizedMate = await call('POST', '/api/users', admin, {
    name: 'Проверочный Сотрудник с правом', symbol: grantSymbol,
    password: `${pass}-grant`, role: 'ENGINEER_VENT',
    permissions: { 'mail.shared.manage': { enabled: true, until: null } },
  });
  authorizedMate = madeAuthorizedMate.json?.user || madeAuthorizedMate.json;
  authorizedMateMine = Boolean(authorizedMate?.id);
  eq('сотрудник с явной выдачей заведён', authorizedMateMine, true);
  if (!authorizedMate?.id) throw new Error('Не создан сотрудник с явной выдачей');

  const legacySymbol = `FluxMailOld${stamp}`;
  const madeLegacyMate = await call('POST', '/api/users', admin, {
    name: 'Проверочный Сотрудник со старым правом', symbol: legacySymbol,
    password: `${pass}-legacy`, role: 'ENGINEER_VENT',
    permissions: { 'mail.shared': { enabled: true, until: null } },
  });
  legacyMate = madeLegacyMate.json?.user || madeLegacyMate.json;
  legacyMateMine = Boolean(legacyMate?.id);
  eq('сотрудник со старым ключом заведён', legacyMateMine, true);
  if (!legacyMate?.id) throw new Error('Не создан сотрудник со старым правом');

  const mateToken = await login(mate.symbol, pass);
  eq('второй сотрудник вошёл', Boolean(mateToken), true);
  if (!mateToken) throw new Error('Второй сотрудник не вошёл');
  const authorizedMateToken = await login(authorizedMate.symbol, `${pass}-grant`);
  eq('сотрудник с явной выдачей вошёл', Boolean(authorizedMateToken), true);
  if (!authorizedMateToken) throw new Error('Сотрудник с явной выдачей не вошёл');
  const legacyMateToken = await login(legacyMate.symbol, `${pass}-legacy`);
  eq('сотрудник со старым ключом вошёл', Boolean(legacyMateToken), true);
  if (!legacyMateToken) throw new Error('Сотрудник со старым правом не вошёл');

  const userRows = await call('GET', '/api/users', admin);
  const mateRow = (userRows.json || []).find((u: any) => u.id === mate.id);
  const permissionsOf = (value: any) => {
    try { return typeof value === 'string' ? JSON.parse(value) : value || {}; }
    catch { return {}; }
  };
  eq('новому инженеру новый ключ настройки общей почты не записан', permissionsOf(mateRow?.permissions)['mail.shared.manage'], undefined);

  console.log('\n4. Общий ящик виден обоим, личный — только владельцу');
  const mateAccounts = await call('GET', '/api/mail/accounts', mateToken);
  const mateList: any[] = mateAccounts.json?.accounts || [];
  eq('общий ящик виден второму', mateList.some((a) => a.id === shared.id), true);
  eq('чужой личный ящик не виден', mateList.some((a) => a.id === personal?.id), false);
  eq('сотрудник без права не получает признак canEdit', mateList.find((a) => a.id === shared.id)?.canEdit, false);
  const authorizedAccounts = await call('GET', '/api/mail/accounts', authorizedMateToken);
  eq('явная выдача открывает настройку в интерфейсе', (authorizedAccounts.json?.accounts || []).find((a: any) => a.id === shared.id)?.canEdit, true);
  const legacyAccounts = await call('GET', '/api/mail/accounts', legacyMateToken);
  eq('старый mail.shared не открывает настройку в интерфейсе', (legacyAccounts.json?.accounts || []).find((a: any) => a.id === shared.id)?.canEdit, false);

  console.log('\n5. Прочитано — у каждого своё');
  const t1 = await call('GET', `/api/mail/threads?accountId=${shared.id}`, admin);
  const threads: any[] = t1.json?.threads || [];
  if (!threads.length) {
    throw new SkippedMailRun(MAIL_FIXTURE_SKIP_REASON);
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
  if (claim.json?.state?.claimedById) claimedThreadKey = target.threadKey;
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
  const legacyMeddle = await call('PUT', `/api/mail/accounts/${shared.id}`, legacyMateToken, { label: 'Старый ключ' });
  eq('старый mail.shared не даёт менять общий ящик', legacyMeddle.status, 403);
  const afterDenied = await call('GET', '/api/mail/accounts', admin);
  eq('отказ не меняет название общего ящика', (afterDenied.json?.accounts || []).find((a: any) => a.id === shared.id)?.label, shared.label);

  const explicitLabel = `Проверочная выдача ${Date.now()}`;
  sharedLabelChanged = !sharedMine;
  const explicitEdit = await call('PUT', `/api/mail/accounts/${shared.id}`, authorizedMateToken, { label: explicitLabel });
  eq('инженер с явной выдачей может настроить общий ящик', explicitEdit.status, 200);
  const afterExplicit = await call('GET', '/api/mail/accounts', admin);
  eq('явная выдача сохраняет новое название', (afterExplicit.json?.accounts || []).find((a: any) => a.id === shared.id)?.label, explicitLabel);
  const adminEdit = await call('PUT', `/api/mail/accounts/${shared.id}`, admin, { label: shared.label });
  eq('администратор может вернуть прежнее название', adminEdit.status, 200);
  if (adminEdit.status === 200) sharedLabelChanged = false;
  const afterRestore = await call('GET', '/api/mail/accounts', admin);
  eq('после проверок название исходное', (afterRestore.json?.accounts || []).find((a: any) => a.id === shared.id)?.label, shared.label);

  console.log('\n9. Чужой личный ящик недоступен по прямому обращению');
  if (personal) {
    const peek = await call('GET', `/api/mail/threads?accountId=${personal.id}`, mateToken);
    eq('писем не отдаёт', (peek.json?.threads || []).length, 0);
    const edit = await call('PUT', `/api/mail/accounts/${personal.id}`, mateToken, { label: 'Чужое' });
    eq('и править не даёт', edit.status, 404);
  }

  // Прибираем за собой: отпускаем переписку
  const ownClaimRelease = await call('POST', '/api/mail/shared/claim', admin, {
    accountId: shared.id, threadKey: target.threadKey, on: false,
  });
  if (ownClaimRelease.status === 200) claimedThreadKey = '';

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
    if (saved.json?.file?.id) createdFiles.push({ id: String(saved.json.file.id), actorToken: admin });

    // Второй раз тот же файл не должен затирать первый
    const again = await call('POST', `/api/mail/attachments/${att?.id}/to-explorer`, admin, { folderId });
    eq('повтор не затирает — имя разведено',
      again.json?.file?.name !== saved.json?.file?.name, true);
    if (again.json?.file?.id) createdFiles.push({ id: String(again.json.file.id), actorToken: admin });

    const note = await call('POST', `/api/mail/messages/${letter?.id}/to-note`, admin, {});
    eq('письмо стало заметкой', Boolean(note.json?.note?.id), true);
    if (note.json?.note?.id) createdNotes.push({ id: String(note.json.note.id), actorToken: admin });

    if (note.json?.note?.id) {
      const fullNote = await call('GET', `/api/notes/${encodeURIComponent(note.json.note.id)}`, admin);
      const content = String(fullNote.json?.note?.content || '');
      eq('полная заметка перечитана отдельным запросом', fullNote.status, 200);
      eq('заметка содержит текст исходного письма', content.includes('Синтетическое письмо для проверки.'), true);
      eq('заметка не содержит внешнюю картинку из письма', content.includes('fixture.invalid/pixel.png'), false);
      eq('заметка не содержит исполняемую разметку письма', /window\.__fluxMailFixturePwned|javascript:|onerror/i.test(content), false);
    }

    // Чужому письму сцепка недоступна так же, как и само письмо
    const foreign = await call('POST', `/api/mail/messages/${letter?.id}/to-note`, mateToken, {});
    const mineOnly = personal && withFile.accountId === personal.id;
    if (mineOnly) eq('к чужому письму не прицепиться', foreign.status, 404);
    else eq('к письму общего ящика прицепиться можно', foreign.status, 200);
    if (!mineOnly && foreign.status === 200 && foreign.json?.note?.id) createdNotes.push({ id: String(foreign.json.note.id), actorToken: mateToken });
  }
  } catch (error) {
    if (error instanceof SkippedMailRun) console.log(`FLUX_VERIFY_SKIP: ${error.message}`);
    else {
      runError = true;
      console.error('\nСбой прогона:', error instanceof Error ? error.message : 'неизвестная ошибка');
    }
  } finally {
    if (admin) await cleanup(admin, {
      shared, personal, mate, authorizedMate, legacyMate,
      sharedMine, personalMine, mateMine, authorizedMateMine, legacyMateMine,
      sharedOriginalLabel, sharedLabelChanged, createdNotes, createdFiles,
      claimedThreadKey,
    });
  }

  console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
  process.exitCode = fail || runError ? 1 : 0;
};

run().catch((err) => {
  console.error('\nСбой прогона:', err?.message || err);
  process.exitCode = 1;
});
