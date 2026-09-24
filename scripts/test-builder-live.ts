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
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };

let token = '';
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
    ownProject = (await call('POST', '/api/projects', { name: 'Проверка Конструктора' })).json?.id || '';
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
      { id: 'live-1', classId: 'cls-valve', tags: ['9999-T01-DF-001', '9999-T01-DF-002'], qty: 2, familyId: 'veza-kpu-1n', values: { purpose: 'О', exec: 'В', W: 900, H: 400, type: '2*ф', drive: 'ЭПВ24' }, designation: '', status: 'matched', sort: 1 },
      { id: 'live-2', classId: 'cls-valve', tags: ['9999-T01-DV-001'], qty: 1, familyId: 'veza-germik-p', values: { H: 600, W: 1000, drive: 'РУЧКА' }, designation: '', status: 'matched', sort: 2 },
    ],
  });
  ok('пакет записан', a1.status === 200 && !!a1.json?.batchId && a1.json?.items?.length === 2, a1);
  let list = (await call('GET', `/api/builder/lists/${listId}`)).json;
  ok('позиции читаются обратно с тегами', list?.items?.length === 2 && list.items[0].tags.length === 2, list?.items);
  const a2 = await call('POST', `/api/builder/lists/${listId}/apply`, { title: 'Проверка: кол-во', upserts: [{ ...list.items[0], qty: 7 }] });
  list = (await call('GET', `/api/builder/lists/${listId}`)).json;
  ok('правка записана', list.items.find((i: any) => i.id === 'live-1')?.qty === 7);
  const undo = await call('POST', `/api/builder/batches/${a2.json?.batchId}/undo`);
  list = (await call('GET', `/api/builder/lists/${listId}`)).json;
  ok('отмена вернула количество', undo.status === 200 && list.items.find((i: any) => i.id === 'live-1')?.qty === 2, list.items);
  const again = await call('POST', `/api/builder/batches/${a2.json?.batchId}/undo`);
  ok('отменённое второй раз не отменяется', again.status === 409, again.status);
  const rm = await call('POST', `/api/builder/lists/${listId}/apply`, { title: 'Проверка: снять', upserts: [], removeIds: ['live-2'] });
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
  const item = (await call('GET', `/api/builder/lists/${listId}`)).json?.items?.find((i: any) => i.id === 'live-1');
  ok('у позиции записаны ссылки на теги', Object.keys(item?.tagIds || {}).length === 2, item?.tagIds);

  console.log('5. Правка каталога: снимок и откат');
  const fam = cat.json.families.find((x: any) => x.id === 'veza-klara');
  const put = await call('PUT', '/api/catalog/family/veza-klara', { ...fam, description: { ru: 'Проверка правки' } });
  ok('семейство сохранено', put.status === 200, put);
  const cat2 = await call('GET', '/api/catalog');
  ok('правка видна и помечена «правлено»', cat2.json.families.find((x: any) => x.id === 'veza-klara')?.description?.ru === 'Проверка правки' && cat2.json.meta['veza-klara']?.edited === true);
  ok('метка версии сменилась', cat2.json.stamp !== cat.json.stamp);
  const revs = (await call('GET', '/api/catalog/family/veza-klara/revisions')).json?.revisions || [];
  ok('снимок до правки записан', revs.length >= 1, revs);
  const bad = await call('PUT', '/api/catalog/family/veza-broken', { id: 'veza-broken', classId: 'cls-valve', code: '', positions: [], params: [] });
  ok('семейство без кода не сохраняется', bad.status === 400, bad);
  const reseed = await call('POST', '/api/catalog/family/veza-klara/reseed');
  ok('возврат к затравке', reseed.status === 200 && (await call('GET', '/api/catalog')).json.meta['veza-klara']?.edited === false);

  console.log('6. Обучение');
  await call('POST', '/api/catalog/learn', { classId: 'cls-valve', signature: 'проверка подписи # x #', familyId: 'veza-klara', values: { exec: 'Н', W: 500 } });
  const learned = (await call('GET', '/api/catalog/learn?classId=cls-valve')).json?.learned || [];
  const mine = learned.find((l: any) => l.signature === 'проверка подписи # x #');
  ok('выбор запомнен', !!mine);
  ok('размер не запоминается', mine && mine.values.W === undefined && mine.values.exec === 'Н', mine);
  if (mine) await call('DELETE', `/api/catalog/learn/${mine.id}`);

  console.log('7. Уборка');
  const tags = (await call('GET', `/api/projects/${project.id}/tags`)).json;
  for (const t of (Array.isArray(tags) ? tags : tags?.tags || []).filter((x: any) => String(x.identifier).startsWith('9999-T01-'))) await call('DELETE', `/api/tags/${t.id}`);
  await call('DELETE', `/api/builder/lists/${listId}`);
  ok('ведомость убрана', (await call('GET', `/api/builder/lists/${listId}`)).status === 404);
  if (ownProject) await call('DELETE', `/api/projects/${ownProject}`);

  console.log(f ? `\nПровалено: ${f}` : '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
