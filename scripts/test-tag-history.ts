/**
 * История изменений тега: каждый путь, меняющий тег, оставляет запись с
 * источником, автором и «было → стало»; пустая правка записи не оставляет;
 * удалённый тег историю сохраняет.
 *
 * Нужен сервер (FLUX_API, по умолчанию :3000) и вход (FLUX_USER, FLUX_PASS).
 * Проект заводится свой, одноразовый, и в конце удаляется вместе с тегами.
 * Записи истории не удаляются никогда — таблица только дописывается, — но у
 * каждого прогона свои идентификаторы тегов, и чужих проверок они не касаются.
 *
 * Запуск: FLUX_USER=… FLUX_PASS=… npx tsx scripts/test-tag-history.ts
 */
import { testCredentials } from './testCredentials';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = testCredentials();

let ok = 0;
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { ok++; return; }
  fail++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got).slice(0, 400)}`}`);
};

let token = '';
const call = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const textBody = await res.text();
  let json: any = null;
  try { json = JSON.parse(textBody); } catch { /* не JSON */ }
  return { status: res.status, json };
};

interface Row { kind: string; field: string; before: string | null; after: string | null; source: string; userId: string | null; userName: string; at: string }
const history = async (tagId: string): Promise<Row[]> => (await call('GET', `/api/tags/${tagId}/history`)).json?.history || [];
const stamp = Date.now().toString(36);
const code = (s: string) => `HIST-${stamp}-${s}`;
const meta = (o: Record<string, unknown>) => JSON.stringify({ x: 100, y: 100, connections: [], descriptions: [], ...o });

async function main() {
  try { await call('GET', '/api/health'); } catch (e: any) {
    console.error(`Сервер на ${BASE} не отвечает (${e?.message || e}).`); process.exit(2);
  }
  const login = await call('POST', '/api/login', LOGIN);
  token = login.json?.token || '';
  const me = login.json?.user?.id || '';
  check('вход выполнен', !!token && !!me, login.json?.message);
  if (!token) process.exit(1);

  const proj = await call('POST', '/api/projects', { name: `История ${stamp}` });
  const projectId = proj.json?.project?.id;
  check('проект для проверки заведён', !!projectId, proj.json);
  if (!projectId) process.exit(1);
  const mine: string[] = [];

  try {
    console.log('Создание');
    const a = (await call('POST', `/api/projects/${projectId}/tags`, { identifier: code('A'), brand: 'Марка-1', department: 'ОВ', metadata: meta({ mainName: 'Вентилятор' }) })).json?.tag;
    const b = (await call('POST', `/api/projects/${projectId}/tags`, { identifier: code('B'), metadata: meta({}) })).json?.tag;
    mine.push(a?.id, b?.id);
    check('теги заведены', !!a?.id && !!b?.id);
    let h = await history(a.id);
    check('создание оставило ровно одну запись', h.length === 1, h);
    check('запись — «создан», источник «Теги»', h[0]?.kind === 'создан' && h[0]?.source === 'Теги', h[0]);
    check('в записи код нового тега', h[0]?.after === code('A'), h[0]);
    check('автор — тот, кто вошёл, из сессии, а не из тела', h[0]?.userId === me && !!h[0]?.userName, h[0]);

    console.log('Пустая правка и раскладка записи не оставляют');
    const n0 = (await history(a.id)).length;
    await call('PUT', `/api/tags/${a.id}`, { identifier: code('A'), brand: 'Марка-1', department: 'ОВ', metadata: meta({ mainName: 'Вентилятор' }) });
    check('то же самое, что уже записано — записи нет', (await history(a.id)).length === n0, await history(a.id));
    await call('PUT', `/api/tags/${a.id}`, { metadata: meta({ mainName: 'Вентилятор', x: 480, y: 220 }) });
    check('перенос карточки по холсту — не правка тега', (await history(a.id)).length === n0, await history(a.id));
    await call('PUT', `/api/tags/bulk-metadata`, { updates: [{ id: a.id, metadata: meta({ mainName: 'Вентилятор', x: 900, y: 40 }) }] });
    check('раскладка массовым запросом — тоже нет', (await history(a.id)).length === n0, await history(a.id));

    console.log('Поля тега');
    await call('PUT', `/api/tags/${a.id}`, { brand: 'Марка-2', fluid: 'Воздух' });
    h = await history(a.id);
    const brand = h.find((r) => r.field === 'brand');
    check('смена марки: было → стало', brand?.kind === 'изменён' && brand.before === 'Марка-1' && brand.after === 'Марка-2', brand);
    const fluid = h.find((r) => r.field === 'fluid');
    check('новое значение поля: «было» пусто', fluid?.before === null && fluid?.after === 'Воздух', fluid);
    await call('PUT', `/api/tags/${a.id}`, { identifier: code('A2') });
    check('переименование: код было → стало', (await history(a.id)).some((r) => r.field === 'identifier' && r.kind === 'изменён' && r.before === code('A') && r.after === code('A2')));
    check('источник записей правки — «Теги»', (await history(a.id)).filter((r) => r.kind === 'изменён').every((r) => r.source === 'Теги'));
    await call('PUT', `/api/tags/${a.id}`, { identifier: code('A') });

    console.log('Наименование');
    await call('PUT', `/api/tags/${a.id}`, { metadata: meta({ mainName: 'Вентилятор приточный' }) });
    const name = (await history(a.id)).find((r) => r.field === 'mainName');
    check('наименование: было → стало', name?.before === 'Вентилятор' && name?.after === 'Вентилятор приточный', name);

    console.log('Комментарии');
    const c1 = { id: 'c-1', text: 'Проверить мощность', comment: 'уточнить у заказчика', status: 'warning', createdBy: 'Тест', createdAt: new Date().toISOString() };
    let before = (await history(a.id)).length;
    await call('PUT', `/api/tags/${a.id}`, { metadata: meta({ mainName: 'Вентилятор приточный', descriptions: [c1] }) });
    h = await history(a.id);
    check('добавлен комментарий — одна запись', h.length === before + 1, h.length - before);
    check('вид «комментарий добавлен», в «стало» его текст и статус',
      h[0]?.kind === 'комментарий добавлен' && h[0].before === null && /уточнить у заказчика/.test(h[0].after || '') && /Проверить/.test(h[0].after || '') && /Проверить\]|\[Проверить/.test(h[0].after || ''), h[0]);
    const c1b = { ...c1, comment: 'мощность подтверждена', status: 'actual', updatedAt: new Date().toISOString(), updatedBy: 'Тест' };
    await call('PUT', `/api/tags/${a.id}`, { metadata: meta({ mainName: 'Вентилятор приточный', descriptions: [c1b] }) });
    h = await history(a.id);
    check('правка комментария: «комментарий изменён», было → стало',
      h[0]?.kind === 'комментарий изменён' && /уточнить/.test(h[0].before || '') && /подтверждена/.test(h[0].after || ''), h[0]);
    before = h.length;
    await call('PUT', `/api/tags/${a.id}`, { metadata: meta({ mainName: 'Вентилятор приточный', descriptions: [{ ...c1b, updatedAt: 'иное-время', updatedBy: 'Другой' }] }) });
    check('смена только служебных отметок комментария — не правка', (await history(a.id)).length === before);
    await call('PUT', `/api/tags/${a.id}`, { metadata: meta({ mainName: 'Вентилятор приточный', descriptions: [] }) });
    h = await history(a.id);
    check('комментарий удалён: «было» — его текст', h[0]?.kind === 'комментарий удалён' && /подтверждена/.test(h[0].before || '') && h[0].after === null, h[0]);

    console.log('Связи: родитель и состав');
    await call('PUT', `/api/tags/${a.id}`, { metadata: meta({ mainName: 'Вентилятор приточный', connections: [b.id] }) });
    h = await history(a.id);
    check('в состав добавлен тег: «связь добавлена», в записи его код, а не идентификатор',
      h[0]?.kind === 'связь добавлена' && h[0].field === 'connections' && h[0].after === code('B'), h[0]);
    await call('PUT', `/api/tags/${b.id}`, { metadata: meta({ parentId: a.id }) });
    h = await history(b.id);
    check('родитель назначен: «связь добавлена» по полю parentId', h[0]?.kind === 'связь добавлена' && h[0].field === 'parentId' && h[0].after === code('A'), h[0]);
    // Ключ снимается явным null: пропущенный ключ теперь означает «не трогать»
    await call('PUT', `/api/tags/${b.id}`, { metadata: meta({ parentId: null }) });
    h = await history(b.id);
    check('родитель убран: «связь убрана», «было» — его код', h[0]?.kind === 'связь убрана' && h[0].field === 'parentId' && h[0].before === code('A'), h[0]);
    await call('PUT', `/api/tags/${a.id}`, { metadata: meta({ mainName: 'Вентилятор приточный', connections: [] }) });
    check('тег убран из состава: «связь убрана»', (await history(a.id))[0]?.kind === 'связь убрана');

    console.log('Массовая запись metadata');
    before = (await history(b.id)).length;
    await call('PUT', '/api/tags/bulk-metadata', { updates: [{ id: b.id, metadata: meta({ actuality: 'critical' }) }] });
    h = await history(b.id);
    check('массовая правка оставила запись по ключу', h.length === before + 1 && h[0]?.field === 'actuality' && h[0].after === 'critical' && h[0].source === 'Теги', h[0]);

    console.log('Генератор кода');
    const g = (await call('POST', '/api/tags/generate', { projectId, prefix: `GEN-${stamp}-`, suffix: '' })).json?.tag;
    if (g?.id) mine.push(g.id);
    h = await history(g?.id);
    check('создание по приставке — «создан» с автором', h[0]?.kind === 'создан' && h[0].userId === me, h[0]);

    console.log('Импорт таблицей (бланк тегов)');
    const imp = await call('POST', `/api/projects/${projectId}/tags/bulk-import`, {
      mode: 'update',
      rows: [
        { identifier: code('A'), name: 'Вентилятор вытяжной', brand: 'Марка-3' },
        { identifier: code('IMP1'), name: 'Новый из таблицы', parent: code('A') },
      ],
    });
    check('импорт выполнен', imp.status === 200 && imp.json?.created === 1 && imp.json?.updated === 1, imp.json);
    const tagsNow: any[] = (await call('GET', `/api/projects/${projectId}/tags`)).json?.tags || [];
    const imp1 = tagsNow.find((t) => t.identifier === code('IMP1'));
    if (imp1) mine.push(imp1.id);
    h = await history(imp1?.id);
    check('созданное импортом: «создан», источник «импорт тегов», автор из сессии', h[0]?.kind === 'создан' && h[0].source === 'импорт тегов' && h[0].userId === me, h[0]);
    h = await history(a.id);
    check('обновлённое импортом: марка и наименование — с источником «импорт тегов»',
      h.some((r) => r.field === 'brand' && r.before === 'Марка-2' && r.after === 'Марка-3' && r.source === 'импорт тегов')
      && h.some((r) => r.field === 'mainName' && r.after === 'Вентилятор вытяжной' && r.source === 'импорт тегов'), h.slice(0, 5));
    check('связь родитель → состав, поставленная импортом, записана в истории родителя',
      h.some((r) => r.kind === 'связь добавлена' && r.field === 'connections' && r.after === code('IMP1') && r.source === 'импорт тегов'), h.slice(0, 5));

    console.log('Захват с экрана');
    const cap = await call('POST', `/api/projects/${projectId}/tags/capture-apply`, {
      rows: [
        { identifier: code('CAP1'), action: 'create', brand: 'Захват', name: 'Из захвата' },
        { identifier: code('B'), action: 'fill', targetId: b.id, department: 'ВК', name: 'Дополнено захватом' },
      ],
    });
    const capId = cap.json?.created?.[0]?.id;
    if (capId) mine.push(capId);
    check('захват применён', cap.status === 200 && !!capId && cap.json?.filled?.length === 1, cap.json);
    h = await history(capId);
    check('созданное захватом: источник «захват»', h[0]?.kind === 'создан' && h[0].source === 'захват' && h[0].userId === me, h[0]);
    h = await history(b.id);
    check('дополненное захватом: отдел было → стало, источник «захват»',
      h.some((r) => r.field === 'department' && r.before === null && r.after === 'ВК' && r.source === 'захват'), h.slice(0, 4));
    const undo = await call('POST', `/api/projects/${projectId}/tags/capture-undo`, {
      deleteIds: [capId],
      restore: [{ id: b.id, brand: null, department: null, fluid: null, wbs: null, metadata: meta({}) }],
    });
    check('захват отменён', undo.status === 200 && undo.json?.deleted === 1 && undo.json?.restored === 1, undo.json);
    h = await history(capId);
    check('отмена снимает тег: «удалён», источник «восстановление», история цела', h[0]?.kind === 'удалён' && h[0].source === 'восстановление' && h[1]?.kind === 'создан', h);
    h = await history(b.id);
    check('отмена вернула отдел: запись «стало» пусто', h[0]?.source === 'восстановление' && h.some((r) => r.field === 'department' && r.before === 'ВК' && r.after === null && r.source === 'восстановление'), h.slice(0, 4));

    console.log('Удаление');
    const keep = (await history(a.id)).length;
    const del = await call('DELETE', `/api/tags/${a.id}`);
    check('тег удалён', del.status === 200, del.json);
    h = await history(a.id);
    check('удалённый тег сохраняет всю прежнюю историю', h.length === keep + 1, [h.length, keep]);
    check('и первой в ленте — запись об удалении: кто, источник, код', h[0]?.kind === 'удалён' && h[0].before === code('A') && h[0].source === 'Теги' && h[0].userId === me, h[0]);
    check('самая старая запись — создание', h[h.length - 1]?.kind === 'создан', h[h.length - 1]);
    check('порядок — новое сверху', h.every((r, i) => i === 0 || h[i - 1].at >= r.at), h.map((r) => r.at));
    check('повторное удаление несуществующего тега — 404, а не зависший запрос', (await call('DELETE', `/api/tags/${a.id}`)).status === 404);
    check('PUT несуществующего тега — 404', (await call('PUT', `/api/tags/${a.id}`, { brand: 'x' })).status === 404);
  } finally {
    for (const id of mine) if (id) await call('DELETE', `/api/tags/${id}`);
    await call('DELETE', `/api/projects/${projectId}`);
  }

  console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
