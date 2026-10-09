import { testCredentials } from './testCredentials';
import mariadb from 'mariadb';
/**
 * Своя позиция и привязка тега — вживую, на поднятом сервере.
 *
 * Владелец просил: «сделай возможность самому добавить позицию и привязать
 * тег». Проверяем дорогу целиком: тег проверяется до записи тем же правилом,
 * по которому запишется; похожая кириллическая буква исправляется; позиция
 * встаёт внутрь двигателя, а её тег — под тег владельца; занятый тег получает
 * отказ с именем того, кто его держит; позиция заводится и в моноблок, без
 * владельца. Проект синтетический и удаляется в конце.
 *
 * Запуск (сервер поднят): npx tsx scripts/test-position-add-live.ts
 */
import { VEZA_SAMPLE_XML } from './fixtures/veza';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
let f = 0;
const ok = (n: string, c: boolean, d?: unknown) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d === undefined ? '' : JSON.stringify(d).slice(0, 400))));
let token = '';
let syncSocket: import('socket.io-client').Socket | null = null;
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${BASE}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => ({})) as any };
};

function fixtureDatabaseOptions() {
  if (process.env.FLUX_TEST_FIXTURE !== '1') throw new Error('Нужен FLUX_TEST_FIXTURE=1 для доступа к БД тестовой фикстуры.');
  let api: URL, db: URL, user: string, password: string, database: string;
  try {
    api = new URL(process.env.FLUX_API || '');
    db = new URL(process.env.FLUX_DB_FIXTURE_URL || '');
    user = decodeURIComponent(db.username);
    password = decodeURIComponent(db.password);
    database = decodeURIComponent(db.pathname.slice(1));
  } catch {
    throw new Error('FLUX_API и FLUX_DB_FIXTURE_URL должны быть корректными URL; значения скрыты.');
  }
  const loopback = (host: string) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host.toLowerCase());
  const port = db.port ? Number(db.port) : 3306;
  if (!['http:', 'https:'].includes(api.protocol) || !loopback(api.hostname)
    || !['mysql:', 'mariadb:'].includes(db.protocol) || !loopback(db.hostname)
    || !Number.isInteger(port) || port < 1 || port > 65535
    || !/^flux_remaining_[a-z0-9_]+$/i.test(database) || database.includes('/')
    || !user || !password || db.search !== '' || db.hash !== '') {
    throw new Error('Прямой SQL разрешён только для loopback MySQL/MariaDB с локальной БД flux_remaining_* и без query-параметров.');
  }
  return {
    host: db.hostname.replace(/^\[|\]$/g, ''), port,
    user, password, database,
  };
}
async function directParent(id: string): Promise<string | null | undefined> {
  const connection = await mariadb.createConnection(fixtureDatabaseOptions());
  try {
    const rows = await connection.query('SELECT parentElementId FROM ComponentElement WHERE id = ?', [id]) as any[];
    return rows[0]?.parentElementId ?? null;
  } finally {
    await connection.end();
  }
}

(async () => {
  const login = await call('POST', '/api/login', testCredentials());
  token = login.data?.token || '';
  if (!token) { console.error('Не удалось войти'); process.exit(2); }

  console.log('1. Проект с установкой');
  const made = await call('POST', '/api/projects', { name: `Проверка своей позиции ${Date.now().toString(36)}`, code: 'PR' });
  const projectId = made.data?.project?.id || made.data?.id;
  if (!projectId) throw new Error('Не удалось завести отдельный тестовый проект; продолжать без него небезопасно.');
  try {
  const parsed = await call('POST', '/api/equipment/parse-calc', { text: VEZA_SAMPLE_XML, fileName: 'проба.XML', projectId });
  const units = parsed.data?.units || [];
  const plan = await call('POST', '/api/equipment/import-draft-plan', { units, category: 'AHU', projectId });
  const wrote = await call('POST', '/api/equipment/import-draft', { units, category: 'AHU', fileName: 'проба.XML', projectId, tagLinks: plan.data?.plan?.tagLinks });
  ok('установка ввезена', wrote.status === 200, wrote.data);
  const systems = (await call('GET', `/api/projects/${projectId}/systems`)).data?.systems || [];
  const comps = systems.flatMap((s: any) => s.monoblocks.flatMap((m: any) => m.components.map((c: any) => ({ ...c, _mb: m }))));
  const motor = comps.find((c: any) => c.role === 'ДВИГАТЕЛЬ');
  const fan = comps.find((c: any) => c.id === motor?.parentElementId);
  ok('двигатель и его вентилятор найдены', !!motor && !!fan);

  console.log('\n2. Проверка тега до записи');
  // «Т» и «Е» кириллические — опечатка раскладки
  const twin = 'PR-01-ТЕ-001';
  const chk = await call('POST', `/api/projects/${projectId}/tag-check`, { identifier: twin });
  ok('похожие буквы исправлены', chk.data?.ok === true && chk.data?.identifier === 'PR-01-TE-001', chk.data);
  ok('и сказано, что исправлено', !!chk.data?.corrected?.what, chk.data);
  ok('проверка ничего не записала', !(await call('GET', `/api/projects/${projectId}/tags`)).data
    ?.some?.((t: any) => t.identifier === 'PR-01-TE-001'));
  const bad = await call('POST', `/api/projects/${projectId}/tag-check`, { identifier: 'PR 01 TE' });
  ok('тег с пробелом не проходит', bad.data?.ok === false && !!bad.data?.problem, bad.data);

  console.log('\n3. Датчик ПТС внутрь двигателя со своим тегом');
  const pos = await call('POST', `/api/equipment/component/${motor.id}/position`, {
    name: 'Датчик ПТС', role: 'ДАТЧИК', tag: twin, equipClass: 'ДАТЧИК', equipKind: 'ПТС', params: [{ key: 'Тип', value: 'позистор', unit: '' }],
  });
  ok('позиция заведена', pos.status === 200 && pos.data?.ok, pos.data);
  ok('тег записан исправленным', pos.data?.tag?.identifier === 'PR-01-TE-001', pos.data?.tag);
  const fanTag = fan?.tags?.[0]?.identifier || '';
  ok('родитель тега — тег владельца по составу', !!pos.data?.parentTag && pos.data.parentTag !== 'PR-01-TE-001', [pos.data?.parentTag, fanTag]);
  const after = (await call('GET', `/api/projects/${projectId}/systems`)).data?.systems
    .flatMap((s: any) => s.monoblocks.flatMap((m: any) => m.components));
  const ptc = after.find((c: any) => c.id === pos.data?.component?.id);
  ok('стоит внутри двигателя', ptc?.parentElementId === motor.id);
  ok('тип и вид записаны', ptc?.equipClass === 'ДАТЧИК' && ptc?.equipKind === 'ПТС', [ptc?.equipClass, ptc?.equipKind]);
  ok('помечена ручной', ptc?.manual === true);
  const persistedManualParent = await directParent(pos.data?.component?.id);
  ok('в базе ручная позиция сохраняет выбранного владельца', persistedManualParent === motor.id, persistedManualParent);

  console.log('\n4. Один тег — одно изделие');
  const again = await call('POST', `/api/equipment/component/${fan.id}/tag`, { identifier: 'PR-01-TE-001' });
  ok('занятый тег — отказ', again.status === 409, again.status);
  ok('и названо, кто его держит', /Датчик ПТС/.test(again.data?.error || ''), again.data);

  console.log('\n5. «Создать и привязать»');
  const { io } = await import('socket.io-client');
  const entityChanges: any[] = [];
  syncSocket = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
  await new Promise<void>((resolve, reject) => {
    syncSocket!.once('connect', () => resolve());
    syncSocket!.once('connect_error', reject);
    setTimeout(() => reject(new Error('Socket не подключился')), 5000);
  });
  syncSocket.on('entity:changed', (change: any) => entityChanges.push(change));
  const linked = await call('POST', `/api/equipment/component/${motor.id}/tag`, { identifier: 'PR-01-M-001' });
  ok('новый тег заведён и привязан', linked.status === 200 && linked.data?.created === true, linked.data);
  ok('родитель тега двигателя — тег вентилятора', linked.data?.parentTag === fanTag, [linked.data?.parentTag, fanTag]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const linkedTags = (await call('GET', `/api/projects/${projectId}/tags`)).data?.tags || [];
  const linkedTagId = linkedTags.find((t: any) => t.identifier === 'PR-01-M-001')?.id;
  ok('создание и привязка рассылают событие тега', !!linkedTagId && entityChanges.some((e) =>
    e.kind === 'tag' && (e.id === linkedTagId || (Array.isArray(e.ids) && e.ids.includes(linkedTagId)))), entityChanges);
  ok('привязка рассылает событие позиции', entityChanges.some((e) => e.kind === 'element' && e.id === motor.id), entityChanges);

  console.log('\n6. Позиция в моноблоке: запись и видимое родство тега');
  const top = await call('POST', `/api/equipment/monoblock/${motor._mb.id}/position`, { name: 'Шкаф управления', role: 'ПРОЧЕЕ', tag: 'PR-01-CP-001' });
  ok('заведена', top.status === 200 && top.data?.ok, top.data);
  const cp = (await call('GET', `/api/projects/${projectId}/systems`)).data?.systems
    .flatMap((s: any) => s.monoblocks.flatMap((m: any) => m.components)).find((c: any) => c.id === top.data?.component?.id);
  const rawTop = await directParent(top.data?.component?.id);
  ok('в базе верхняя позиция моноблока не имеет владельца-позиции', rawTop === null, rawTop);
  const visibleParent = (await call('GET', `/api/projects/${projectId}/systems`)).data?.systems
    .flatMap((s: any) => s.monoblocks.flatMap((m: any) => m.components))
    .find((c: any) => c.tags?.some((t: any) => t.identifier === top.data?.parentTag));
  const visibleParentMatches = top.data?.parentTag
    ? !!visibleParent && cp?.parentElementId === visibleParent.id
    : cp?.parentElementId == null;
  ok('экранное дерево следует родству родительского тега; позиция без него остаётся корневой', !!cp && visibleParentMatches, [cp?.parentElementId, visibleParent?.id, top.data?.parentTag]);

  } finally {
    syncSocket?.disconnect();
    const del = await call('DELETE', `/api/projects/${projectId}`);
    ok('проверочный проект удалён', del.status === 200, del.status);
  }
  console.log(f ? `\nПРОВАЛОВ: ${f}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
  process.exit(f ? 1 : 0);
})();
