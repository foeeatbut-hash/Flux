import { testCredentials } from './testCredentials';
/**
 * Живая проверка Каталога и Конструктора через HTTP.
 *
 * Требует поднятого сервера (npx tsx server.ts). Проходит путь инженера по
 * API: каталог засеян, ведомость заводится, пакет пишется и отменяется,
 * выпуск записывается и не задваивается, теги проекта заводятся по плану,
 * правка каталога оставляет снимок и откатывается. Свои записи убирает.
 *
 * Запуск: FLUX_API=http://localhost:3100 npx tsx scripts/test-builder-live.ts
 */
const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = testCredentials();

let token = '';
// Id позиций — свои на каждый прогон: строки прошлого прогона остаются в
// мягко удалённой ведомости, и постоянный «live-1» упирался в первичный ключ
const R = `live-${Date.now().toString(36)}`;
let f = 0;
const ok = (n: string, c: boolean, d?: unknown) => (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 500) : '')));

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

(async () => {
  console.log('1. Вход и каталог');
  token = (await call('POST', '/api/login', LOGIN)).json?.token || '';
  ok('вошли', token.length > 20);
  const cat = await call('GET', '/api/catalog');
  ok('каталог отдаётся', cat.status === 200, cat.status);
  ok('класс «Клапаны» засеян', cat.json?.classes?.some((c: any) => c.code === 'valve'), cat.json?.classes);
  ok('семейства ВЕЗА засеяны (не меньше 30)', (cat.json?.families?.length || 0) >= 30, cat.json?.families?.length);
  ok('правила тегов засеяны', (cat.json?.tagRules?.length || 0) >= 7, cat.json?.tagRules?.length);
  ok('метка версии каталога есть', typeof cat.json?.stamp === 'string' && cat.json.stamp.length > 0);
  const stamp1 = (await call('GET', '/api/catalog/stamp')).json?.stamp;
  ok('метка без правок не меняется', stamp1 === cat.json?.stamp, [stamp1, cat.json?.stamp]);
  const tpls = await call('GET', '/api/blank-templates');
  ok('шаблон «Бланк-заказ ВЕЗА» по умолчанию', tpls.json?.templates?.some((t: any) => t.isDefault && t.layout?.sheets?.length >= 3), tpls.json?.templates?.map((t: any) => t.name));

  console.log('2. Ведомость и пакеты');
  const listProjects = async () => { const j = (await call('GET', '/api/projects')).json; return (Array.isArray(j) ? j : j?.projects || []) as any[]; };
  let projects = await listProjects();
  // Пробный проект заводим, только если своих нет, — и потом за собой убираем
  let ownProject = '';
  if (!projects.some((p) => !p.system)) {
    ownProject = ((j) => j?.project?.id || j?.id || '')((await call('POST', '/api/projects', { name: 'Проверка Конструктора' })).json);
    projects = await listProjects();
  }
  const project = projects.find((p) => !p.system && p.name !== 'Проверка Конструктора') || projects.find((p) => !p.system) || projects[0];
  ok('есть проект', !!project?.id);
  const created = await call('POST', '/api/builder/lists', { projectId: project.id, classId: 'cls-valve', name: 'Проверка — клапаны' });
  const listId = created.json?.list?.id;
  ok('ведомость заведена', created.status === 200 && !!listId, created);
  ok('объект взят из проекта', created.json?.list?.header?.object === project.name, created.json?.list?.header);
  const a1 = await call('POST', `/api/builder/lists/${listId}/apply`, {
    title: 'Проверка: две позиции',
    upserts: [
      { id: `${R}-1`, classId: 'cls-valve', tags: ['9999-T01-DF-001', '9999-T01-DF-002'], qty: 2, familyId: 'veza-kpu-1n', values: { purpose: 'О', exec: 'В', W: 900, H: 400, type: '2*ф', drive: 'ЭПВ24' }, designation: '', status: 'matched', sort: 1 },
      { id: `${R}-2`, classId: 'cls-valve', tags: ['9999-T01-DV-001'], qty: 1, familyId: 'veza-germik-p', values: { H: 600, W: 1000, drive: 'РУЧКА' }, designation: '', status: 'matched', sort: 2 },
    ],
  });
  ok('пакет записан', a1.status === 200 && !!a1.json?.batchId && a1.json?.items?.length === 2, a1);
  let list = (await call('GET', `/api/builder/lists/${listId}`)).json;
  ok('позиции читаются обратно с тегами', list?.items?.length === 2 && list.items[0].tags.length === 2, list?.items);
  const a2 = await call('POST', `/api/builder/lists/${listId}/apply`, { title: 'Проверка: кол-во', upserts: [{ ...list.items[0], qty: 7 }] });
  list = (await call('GET', `/api/builder/lists/${listId}`)).json;
  ok('правка записана', list.items.find((i: any) => i.id === `${R}-1`)?.qty === 7);
  const undo = await call('POST', `/api/builder/batches/${a2.json?.batchId}/undo`);
  list = (await call('GET', `/api/builder/lists/${listId}`)).json;
  ok('отмена вернула количество', undo.status === 200 && list.items.find((i: any) => i.id === `${R}-1`)?.qty === 2, list.items);
  const again = await call('POST', `/api/builder/batches/${a2.json?.batchId}/undo`);
  ok('отменённое второй раз не отменяется', again.status === 409, again.status);
  const rm = await call('POST', `/api/builder/lists/${listId}/apply`, { title: 'Проверка: снять', upserts: [], removeIds: [`${R}-2`] });
  ok('позиция снята', (await call('GET', `/api/builder/lists/${listId}`)).json?.items?.length === 1);
  await call('POST', `/api/builder/batches/${rm.json?.batchId}/undo`);
  ok('снятие отменяется', (await call('GET', `/api/builder/lists/${listId}`)).json?.items?.length === 2);

  console.log('3. Выпуск');
  const is1 = await call('POST', `/api/builder/lists/${listId}/issues`, { rev: '0', date: '2026-09-23', reason: 'Проверка', diffText: 'Добавлены: …' });
  ok('ревизия 0 выпущена', is1.status === 200, is1);
  const is2 = await call('POST', `/api/builder/lists/${listId}/issues`, { rev: '0', date: '2026-09-23', reason: 'Повтор' });
  ok('та же ревизия второй раз не выпускается', is2.status === 409, is2.status);
  const issues = (await call('GET', `/api/builder/lists/${listId}/issues?snapshots=1`)).json?.issues || [];
  ok('в выпуске снимок позиций', issues[0]?.snapshot?.items?.length === 2, issues[0]);
  ok('позиции отмечены выпущенными', (await call('GET', `/api/builder/lists/${listId}`)).json?.items?.every((i: any) => i.status === 'issued'));

  console.log('4. Теги проекта');
  const plan = await call('POST', `/api/builder/lists/${listId}/tag-plan`);
  const links = plan.json?.links || [];
  ok('план тегов построен', plan.status === 200 && links.length === 3, plan);
  const applied = await call('POST', `/api/builder/lists/${listId}/tag-apply`, { links: links.filter((l: any) => l.action === 'create' || l.action === 'link') });
  ok('теги заведены или привязаны', applied.status === 200 && applied.json.created + applied.json.linked === 3, applied.json);
  const plan2 = await call('POST', `/api/builder/lists/${listId}/tag-plan`);
  ok('повторный план — только привязка, без новых', (plan2.json?.links || []).every((l: any) => l.action === 'link'), plan2.json?.links?.map((l: any) => l.action));
  const item = (await call('GET', `/api/builder/lists/${listId}`)).json?.items?.find((i: any) => i.id === `${R}-1`);
  ok('у позиции записаны ссылки на теги', Object.keys(item?.tagIds || {}).length === 2, item?.tagIds);

  console.log('5. Правка каталога: снимок и откат');
  const fam = cat.json.families.find((x: any) => x.id === 'veza-klara');
  const workspace1 = (await call('GET', '/api/catalog/workspace')).json;
  const publishedFamily = workspace1.catalog?.families?.find((x: any) => x.id === 'veza-klara');
  const put = await call('PUT', '/api/catalog/family/veza-klara', {
    ...fam, description: { ru: 'Проверка правки' }, _publishedHash: publishedFamily?._publishedHash,
  });
  ok('изменение существующего семейства принято в черновик по опубликованной версии', put.status === 200 && !!put.json?.revision, put);
  const workspace2 = (await call('GET', '/api/catalog/workspace')).json;
  const draft = (workspace2.drafts || []).find((x: any) => x.entity === 'family' && x.id === 'veza-klara');
  const cat2 = await call('GET', '/api/catalog');
  ok('черновик виден автору, опубликованный каталог не меняется', draft?.document?.description?.ru === 'Проверка правки' && cat2.json.families.find((x: any) => x.id === 'veza-klara')?.description?.ru === fam.description?.ru, draft);
  const discard = await call('POST', '/api/catalog/workspace/discard', { entity: 'family', id: 'veza-klara', revision: draft?.revision });
  ok('черновик отменяется без изменения опубликованного семейства', discard.status === 200 && !(await call('GET', '/api/catalog/workspace')).json?.drafts?.some((x: any) => x.entity === 'family' && x.id === 'veza-klara'), discard.json);
  const bad = await call('PUT', '/api/catalog/family/veza-broken', { id: 'veza-broken', classId: 'cls-valve', code: '', positions: [], params: [] });
  ok('семейство без кода не сохраняется', bad.status === 400, bad);

  console.log('6. Обучение');
  await call('POST', '/api/catalog/learn', { classId: 'cls-valve', signature: 'проверка подписи # x #', familyId: 'veza-klara', values: { exec: 'Н', W: 500 } });
  const learned = (await call('GET', '/api/catalog/learn?classId=cls-valve')).json?.learned || [];
  const mine = learned.find((l: any) => l.signature === 'проверка подписи # x #');
  ok('выбор запомнен', !!mine);
  ok('размер не запоминается', mine && mine.values.W === undefined && mine.values.exec === 'Н', mine);
  if (mine) await call('DELETE', `/api/catalog/learn/${mine.id}`);

  console.log('8. Две правки одной позиции');
  {
    const cur = (await call('GET', `/api/builder/lists/${listId}`)).json.items.find((i: any) => i.id === `${R}-1`);
    const first = await call('POST', `/api/builder/lists/${listId}/apply`, { title: 'Проверка: первая правка', upserts: [{ ...cur, qty: 3 }] });
    ok('правка по свежей версии записана', first.status === 200, first);
    const late = await call('POST', `/api/builder/lists/${listId}/apply`, { title: 'Проверка: устаревшая правка', upserts: [{ ...cur, qty: 9 }] });
    ok('правка по устаревшей версии отклонена (409)', late.status === 409 && (late.json?.stale || []).includes(`${R}-1`), late);
    ok('и ничего не затёрла', (await call('GET', `/api/builder/lists/${listId}`)).json.items.find((i: any) => i.id === `${R}-1`)?.qty === 3);
  }

  console.log('9. Связь с тегами: проверка на сервере и отмена');
  {
    await call('POST', `/api/builder/lists/${listId}/apply`, { title: 'Проверка: третья позиция', upserts: [{ id: `${R}-3`, classId: 'cls-valve', tags: ['9999-T01-DF-009'], qty: 1, familyId: 'veza-kpu-1n', values: { W: 500, H: 500 }, designation: '', status: 'matched', sort: 3 }] });
    const made = await call('POST', `/api/builder/lists/${listId}/tag-apply`, { links: [{ blockKey: `${R}-3`, identifier: '9999-T01-DF-009', action: 'create' }] });
    ok('тег заведён, пакет отмены есть', made.status === 200 && made.json?.created === 1 && !!made.json?.batchId, made.json);
    const findTag = async () => {
      const t = (await call('GET', `/api/projects/${project.id}/tags`)).json;
      return (Array.isArray(t) ? t : t?.tags || []).find((x: any) => x.identifier === '9999-T01-DF-009');
    };
    ok('тег виден в проекте', !!(await findTag()));
    const und = await call('POST', `/api/builder/batches/${made.json?.batchId}/undo`);
    ok('отмена снимает заведённый тег', und.status === 200 && und.json?.removedTags === 1 && !(await findTag()), und.json);
    const foreign = await call('POST', `/api/builder/lists/${listId}/tag-apply`, { links: [{ blockKey: `${R}-3`, identifier: '9999-T01-DF-009', action: 'link', existingTagId: 'чужой-тег' }] });
    ok('тег не из проекта не привязывается', foreign.status === 200 && foreign.json?.linked === 0 && foreign.json?.refused?.length === 1, foreign.json);
    const amb = await call('POST', `/api/builder/lists/${listId}/tag-apply`, { links: [{ blockKey: `${R}-3`, identifier: '9999-T01-DF-009', action: 'ambiguous' }] });
    ok('неоднозначное без выбора не пишется', amb.json?.created === 0 && amb.json?.refused?.length === 1, amb.json);
  }

  console.log('10. Двойной выпуск одной ревизии');
  {
    const both = await Promise.all([1, 2].map(() => call('POST', `/api/builder/lists/${listId}/issues`, { rev: '7', date: '2026-09-24', reason: 'Двойное нажатие' })));
    ok('записан ровно один выпуск ревизии 7', both.filter((r) => r.status === 200).length === 1 && both.filter((r) => r.status === 409).length === 1, both.map((r) => r.status));
    const is = (await call('GET', `/api/builder/lists/${listId}/issues?snapshots=1`)).json?.issues || [];
    const last = is.find((x: any) => x.rev === '7');
    ok('в снимке выпуска номера б/з, шаблон и язык', !!last?.snapshot && 'orderNos' in last.snapshot && 'lang' in last.snapshot, last?.snapshot && Object.keys(last.snapshot));
  }

  console.log('11. Права обычного сотрудника');
  {
    const stamp = Date.now().toString(36);
    const symbol = `builder-${stamp}`;
    const made = await call('POST', '/api/users', {
      name: `Проверка Конструктора ${stamp}`, symbol, password: 'проверка', role: 'ENGINEER_VENT',
      // Запись прав «из прошлого»: новых ключей Конструктора в ней нет
      permissions: { 'tags.manage': { enabled: true, until: null } },
    });
    const uid = made.json?.user?.id || made.json?.id || '';
    ok('сотрудник заведён', !!uid, made);
    const permissionProject = (await call('POST', '/api/projects', { name: `Проверка прав Конструктора ${stamp}` })).json?.project;
    const joined = permissionProject?.id ? await call('POST', `/api/projects/${permissionProject.id}/members`, { userIds: [uid] }) : { status: 0, json: null };
    ok('сотрудник добавлен в свой тестовый проект', joined.status === 200 && joined.json?.count === 1, joined.json);
    const adminToken = token;
    token = (await call('POST', '/api/login', { symbol, password: 'проверка' })).json?.token || '';
    ok('сотрудник вошёл', !!token);
    ok('каталог ему виден', (await call('GET', '/api/catalog')).status === 200);
    const own = await call('POST', '/api/builder/lists', { projectId: permissionProject?.id, classId: 'cls-valve', name: 'Проверка прав' });
    ok('ведомость заводит без записи о праве', own.status === 200, own.status);
    const fam = (await call('GET', '/api/catalog')).json.families.find((x: any) => x.id === 'veza-klara');
    ok('правка Каталога без выдачи — 403', (await call('PUT', '/api/catalog/family/veza-klara', fam)).status === 403);

    token = adminToken;
    const grantSymbol = `builder-grant-${stamp}`;
    const grantUser = await call('POST', '/api/users', {
      name: `Проверка выдачи Конструктора ${stamp}`, symbol: grantSymbol, password: 'проверка', role: 'ENGINEER_VENT',
      permissions: {
        'builder.edit': { enabled: true, until: null },
        'builder.issue': { enabled: true, until: '2000-01-01T00:00:00.000Z' },
      },
    });
    const grantUid = grantUser.json?.user?.id || grantUser.json?.id || '';
    ok('сотрудник с явной выдачей создан', grantUser.status === 200 && !!grantUid, grantUser);
    const grantJoined = grantUid ? await call('POST', `/api/projects/${permissionProject?.id}/members`, { userIds: [grantUid] }) : { status: 0, json: null };
    ok('сотрудник с явной выдачей включён в проект', grantJoined.status === 200, grantJoined.json);
    token = (await call('POST', '/api/login', { symbol: grantSymbol, password: 'проверка' })).json?.token || '';
    const grantList = await call('POST', '/api/builder/lists', { projectId: permissionProject?.id, classId: 'cls-valve', name: 'Проверка явной выдачи' });
    ok('явный builder.edit разрешает создать ведомость', grantList.status === 200 && !!grantList.json?.list?.id, grantList);
    const grantListId = grantList.json?.list?.id;
    const grantIssuesBefore = grantListId ? (await call('GET', `/api/builder/lists/${grantListId}/issues`)).json?.issues || [] : [];
    const expiredIssue = grantListId ? await call('POST', `/api/builder/lists/${grantListId}/issues`, { rev: 'expired-issue-grant', date: '2026-10-04' }) : { status: 0, json: null };
    const grantIssuesAfter = grantListId ? (await call('GET', `/api/builder/lists/${grantListId}/issues`)).json?.issues || [] : [];
    ok('истёкший builder.issue отклонён без выпуска', expiredIssue.status === 403 && expiredIssue.json?.feature === 'builder.issue' && grantIssuesAfter.length === grantIssuesBefore.length, [expiredIssue, grantIssuesBefore.length, grantIssuesAfter.length]);
    token = adminToken;
    if (grantListId) await call('DELETE', `/api/builder/lists/${grantListId}`);
    token = adminToken;
    // Администратор фикстуры имеет только право заводить сотрудников, не
    // управлять уже созданными. Поэтому задаём явный запрет в начальной
    // записи пользователя, а не молча игнорируем неразрешённый PUT.
    const deniedSymbol = `builder-deny-${stamp}`;
    const deniedUser = await call('POST', '/api/users', {
      name: `Проверка запрета Конструктора ${stamp}`, symbol: deniedSymbol, password: 'проверка', role: 'ENGINEER_VENT',
      permissions: {
        'builder.edit': { enabled: false, until: null },
        'builder.issue': { enabled: true, until: null },
        'tags.manage': { enabled: true, until: null },
      },
    });
    const deniedUid = deniedUser.json?.user?.id || deniedUser.json?.id || '';
    ok('сотрудник с явным запретом создан и право сохранено', deniedUser.status === 200 && !!deniedUid && JSON.parse(deniedUser.json?.permissions || '{}')?.['builder.edit']?.enabled === false, deniedUser);
    const deniedJoined = deniedUid ? await call('POST', `/api/projects/${permissionProject?.id}/members`, { userIds: [deniedUid] }) : { status: 0, json: null };
    ok('запрещённый сотрудник включён в тестовый проект', deniedJoined.status === 200, deniedJoined.json);

    // Под администратором готовим ведомость и позицию, чтобы отдельно
    // проверить, что отказанные запросы не меняют уже существующие данные.
    const protectedList = (await call('POST', '/api/builder/lists', { projectId: permissionProject?.id, classId: 'cls-valve', name: 'Защищённая ведомость' })).json?.list;
    const protectedListId = protectedList?.id;
    const protectedSeed = await call('POST', `/api/builder/lists/${protectedListId}/apply`, {
      title: 'Исходная позиция', upserts: [{ id: `${R}-denied`, classId: 'cls-valve', tags: ['9999-T03-DF-001'], qty: 2, values: {}, designation: '', status: 'draft', sort: 1 }],
    });

    token = (await call('POST', '/api/login', { symbol: deniedSymbol, password: 'проверка' })).json?.token || '';
    ok('сотрудник с запретом вошёл', !!token);
    const denied = await call('POST', '/api/builder/lists', { projectId: permissionProject?.id, classId: 'cls-valve', name: 'Проверка прав 2' });
    ok('явный запрет builder.edit — 403', denied.status === 403 && denied.json?.feature === 'builder.edit', denied);
    const beforeDeniedWrite = (await call('GET', `/api/builder/lists/${protectedListId}`)).json?.items?.find((i: any) => i.id === `${R}-denied`);
    const deniedUpdate = await call('PUT', `/api/builder/lists/${protectedListId}`, { name: 'Это имя не должно записаться' });
    ok('запрет PUT ведомости — 403', deniedUpdate.status === 403 && deniedUpdate.json?.feature === 'builder.edit', deniedUpdate);
    const deniedApply = await call('POST', `/api/builder/lists/${protectedListId}/apply`, {
      title: 'Не должно записаться', upserts: [{ ...beforeDeniedWrite, qty: 99 }],
    });
    const afterDeniedWrite = (await call('GET', `/api/builder/lists/${protectedListId}`)).json?.items?.find((i: any) => i.id === `${R}-denied`);
    ok('запрет apply — 403 и позиция не меняется', deniedApply.status === 403 && afterDeniedWrite?.qty === beforeDeniedWrite?.qty, [deniedApply, beforeDeniedWrite?.qty, afterDeniedWrite?.qty]);
    const deniedUndo = await call('POST', `/api/builder/batches/${protectedSeed.json?.batchId}/undo`);
    const afterDeniedUndo = (await call('GET', `/api/builder/lists/${protectedListId}`)).json?.items?.find((i: any) => i.id === `${R}-denied`);
    ok('запрет отмены пакета — 403 и позиция остаётся', deniedUndo.status === 403 && afterDeniedUndo?.qty === beforeDeniedWrite?.qty, [deniedUndo, afterDeniedUndo?.qty]);
    const deniedTagApply = await call('POST', `/api/builder/lists/${protectedListId}/tag-apply`, { links: [{ blockKey: `${R}-denied`, identifier: '9999-T03-DF-001', action: 'create' }] });
    ok('запрет builder.edit блокирует применение связей даже при tags.manage', deniedTagApply.status === 403 && deniedTagApply.json?.feature === 'builder.edit', deniedTagApply);
    if (deniedTagApply.json?.batchId) await call('POST', `/api/builder/batches/${deniedTagApply.json.batchId}/undo`);
    const deniedDelete = await call('DELETE', `/api/builder/lists/${protectedListId}`);
    ok('запрет удаления — 403, ведомость остаётся', deniedDelete.status === 403 && (await call('GET', `/api/builder/lists/${protectedListId}`)).status === 200, deniedDelete);
    const beforeTagPlan = await call('POST', `/api/builder/lists/${protectedListId}/tag-plan`, {});
    ok('план связей тегов остаётся чтением без builder.edit', beforeTagPlan.status === 200, beforeTagPlan);
    const issuesBeforeEditIndependent = (await call('GET', `/api/builder/lists/${protectedListId}/issues`)).json?.issues || [];
    const independentIssue = await call('POST', `/api/builder/lists/${protectedListId}/issues`, { rev: 'issue-without-edit', date: '2026-10-04' });
    const issuesAfterEditIndependent = (await call('GET', `/api/builder/lists/${protectedListId}/issues`)).json?.issues || [];
    ok('builder.issue позволяет выпустить снимок отдельно от builder.edit', independentIssue.status === 200 && issuesAfterEditIndependent.length === issuesBeforeEditIndependent.length + 1, [independentIssue, issuesBeforeEditIndependent.length, issuesAfterEditIndependent.length]);

    token = adminToken;
    if (own.json?.list?.id) await call('DELETE', `/api/builder/lists/${own.json.list.id}`);
    if (protectedListId) await call('DELETE', `/api/builder/lists/${protectedListId}`);
    if (permissionProject?.id) await call('DELETE', `/api/projects/${permissionProject.id}`);
    if (deniedUid) await call('DELETE', `/api/users/${deniedUid}`);
    if (grantUid) await call('DELETE', `/api/users/${grantUid}`);
    await call('DELETE', `/api/users/${uid}`);
  }

  console.log('12. Загрузка каталога из файла отменяется');
  {
    const mf = cat.json.manufacturers[0]?.id;
    const fam = { id: `${R}-fam`, classId: 'cls-valve', manufacturerId: mf, code: 'ПРОВЕРКА-1', title: { ru: 'Проверка' }, kind: 'air', typeLabel: { ru: 'Проверка' }, shapes: ['rect'], params: [], positions: [{ key: 'series', label: { ru: 'Серия' }, formats: ['ПРОВЕРКА-1'] }], rules: [], match: { kinds: [] }, specs: [], status: 'draft' };
    const packet = { format: 'flux-catalog', mode: 'plan', families: [fam] };
    const planOnly = await call('POST', '/api/catalog/import', packet);
    ok('план загрузки ничего не пишет', planOnly.json?.plan?.[0]?.action === 'new' && !(await call('GET', '/api/catalog')).json.families.some((x: any) => x.id === fam.id));
    const applied = await call('POST', '/api/catalog/import', { ...packet, mode: 'apply', preview: planOnly.json?.preview });
    const importedWorkspace = (await call('GET', '/api/catalog/workspace')).json;
    const importedDraft = (importedWorkspace.drafts || []).find((x: any) => x.entity === 'family' && x.id === fam.id);
    ok('загрузка записала новый семейство в черновики, не в опубликованный каталог', applied.status === 200 && !!importedDraft && !(await call('GET', '/api/catalog')).json.families.some((x: any) => x.id === fam.id), importedDraft);
    const discardImported = importedDraft ? await call('POST', '/api/catalog/workspace/discard', { entity: 'family', id: fam.id, revision: importedDraft.revision }) : { status: 0, json: null };
    ok('импортированный черновик отменяется и уходит из рабочей области', discardImported.status === 200 && !(await call('GET', '/api/catalog/workspace')).json?.drafts?.some((x: any) => x.entity === 'family' && x.id === fam.id), discardImported.json);
  }

  console.log('13. Удаление проекта уносит его ведомости');
  {
    const tmpRes = (await call('POST', '/api/projects', { name: `Проверка удаления ${Date.now().toString(36)}` })).json;
    const tmp = tmpRes?.project?.id || tmpRes?.id;
    const l = (await call('POST', '/api/builder/lists', { projectId: tmp, classId: 'cls-valve', name: 'Ведомость на удаление' })).json?.list?.id;
    await call('POST', `/api/builder/lists/${l}/apply`, { title: 'Позиция', upserts: [{ id: `del-${Date.now()}`, classId: 'cls-valve', tags: ['9999-T02-DF-001'], qty: 1, values: {}, designation: '', status: 'draft', sort: 1 }] });
    ok('ведомость во временном проекте есть', (await call('GET', `/api/builder/lists/${l}`)).status === 200);
    await call('DELETE', `/api/projects/${tmp}`);
    ok('после удаления проекта её нет', (await call('GET', `/api/builder/lists/${l}`)).status === 404);
    ok('и в списке ведомостей проекта пусто', ((await call('GET', `/api/builder/lists?projectId=${tmp}`)).json?.lists || []).length === 0);
  }

  console.log('14. Уборка');
  const tags = (await call('GET', `/api/projects/${project.id}/tags`)).json;
  for (const t of (Array.isArray(tags) ? tags : tags?.tags || []).filter((x: any) => String(x.identifier).startsWith('9999-T01-'))) await call('DELETE', `/api/tags/${t.id}`);
  await call('DELETE', `/api/builder/lists/${listId}`);
  ok('ведомость убрана', (await call('GET', `/api/builder/lists/${listId}`)).status === 404);
  if (ownProject) await call('DELETE', `/api/projects/${ownProject}`);

  console.log(f ? `\nПровалено: ${f}` : '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
