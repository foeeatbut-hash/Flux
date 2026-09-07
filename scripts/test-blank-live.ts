/**
 * Бланк доезжает до базы целиком: разбор → план → предпросмотр → запись → теги.
 *
 * Разбором кода этого не поймать: каждый кусок по отдельности выглядит
 * правильным, а цепочка рвётся между ними. Именно так было с листом на клапаны —
 * распознавание давало сто позиций, а в базу приезжала одна, и ни одного тега.
 *
 * Проба берёт обезличенный образец настоящего листа (scripts/fixtures/blanks.ts),
 * прогоняет его тем же путём, каким идёт мастер импорта, и смотрит результат
 * глазами базы: сколько позиций, чьи теги, что заведено и что привязано.
 *
 * Запуск (нужен поднятый сервер):
 *   npx tsx server.ts > /tmp/srv.log 2>&1 &
 *   npx tsx scripts/test-blank-live.ts
 */
import { recognize, draftToUnits } from '../src/import/recognize';
import { VALVE_SHEET, AHU_SHEET } from './fixtures/blanks';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const ADMIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 300) : ''));

let token = '';
const api = async (method: string, url: string, body?: any) => {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: null as any, text }; }
};

(async () => {
  try {
    const h = await fetch(BASE + '/api/health');
    if (!h.ok) throw new Error('health ' + h.status);
  } catch (e: any) {
    console.error(`Сервер на ${BASE} не отвечает (${e?.message || e}).`);
    process.exit(2);
  }

  const login = await api('POST', '/api/login', ADMIN);
  token = login.json?.token || '';
  if (!token) { console.error('Не удалось войти администратором.'); process.exit(2); }

  const stamp = Date.now().toString(36).slice(-6);
  const project = await api('POST', '/api/projects', { name: `Проверка бланков ${stamp}` });
  const projectId = project.json?.project?.id || project.json?.id || '';
  if (!projectId) { console.error('Проект не завёлся.', project.status, project.json); process.exit(2); }

  console.log('1. Лист на клапаны: сколько позиций доезжает до базы');
  const valves = recognize(VALVE_SHEET);
  const valveUnits = draftToUnits(valves.items, `клапаны-${stamp}`);
  ok('распознано четыре позиции', valves.items.length === 4, valves.items.length);

  const planned = await api('POST', '/api/equipment/import-draft-plan', {
    units: valveUnits, category: 'VALVE', projectId,
  });
  const plan = planned.json?.plan;
  ok('план построен без записи в базу', planned.status === 200 && !!plan, planned.json);
  ok('в плане четыре блока', (plan?.blocks || []).length === 4, (plan?.blocks || []).length);
  ok('все блоки новые', (plan?.blocks || []).every((b: any) => b.action === 'create'));
  ok('в плане семь тегов бланка (2+1 и 1+3)', (plan?.tagLinks || []).length === 7, (plan?.tagLinks || []).map((l: any) => l.identifier));
  ok('все теги предложены к созданию', (plan?.tagLinks || []).every((l: any) => l.action === 'create'),
    (plan?.tagLinks || []).map((l: any) => l.action));

  // Предпросмотр ничего не пишет — это главное свойство плана
  const beforeTags = (await api('GET', `/api/projects/${projectId}/tags`)).json;
  const beforeCount = (beforeTags?.tags || []).length;
  ok('после плана тегов в проекте не прибавилось', beforeCount === 0, beforeCount);

  console.log('2. Запись подтверждённого предпросмотра');
  const written = await api('POST', '/api/equipment/import-draft', {
    units: valveUnits, fileName: `клапаны-${stamp}.xlsx`, category: 'VALVE', projectId,
    selection: (plan?.blocks || []).map((b: any) => b.key),
    tagLinks: plan?.tagLinks,
  });
  ok('импорт прошёл', written.status === 200 && written.json?.success, written.json);
  // Служебного блока «параметры установки» у перечня нет: групп у него пусто,
  // и план его не показывал — запись обязана считать так же
  ok('заведено ровно столько блоков, сколько обещал план', written.json?.newBlocks === 4, written.json?.newBlocks);
  ok('заведено семь тегов', written.json?.tagsCreated === 7, written.json);
  ok('все семь привязаны к своим позициям', written.json?.tagsLinked === 7, written.json);
  ok('отказов по занятости нет', (written.json?.tagConflicts || []).length === 0, written.json?.tagConflicts);
  ok('номер партии вернулся (импорт можно отменить)', !!written.json?.batchId, written.json?.batchId);

  console.log('3. Теги видны в проекте и стоят на своих изделиях');
  const after = (await api('GET', `/api/projects/${projectId}/tags`)).json;
  const tags: any[] = after?.tags || [];
  ok('в проекте семь тегов', tags.length === 7, tags.map(t => t.identifier));
  const names = tags.map(t => t.identifier).sort();
  ok('теги те самые, что в бланке',
    names.includes('1000-D01-DS-002') && names.includes('1000-B02-DF-005'), names);
  const linked = tags.filter(t => (t.componentElements || []).length > 0);
  ok('каждый тег привязан к изделию', linked.length === 7, tags.map(t => [t.identifier, (t.componentElements || []).length]));

  console.log('4. Повторный ввоз того же бланка: теги привязываются, а не двоятся');
  const again = await api('POST', '/api/equipment/import-draft-plan', {
    units: valveUnits, category: 'VALVE', projectId,
  });
  const plan2 = again.json?.plan;
  ok('блоки узнаны, а не заведены заново',
    (plan2?.blocks || []).every((b: any) => b.action !== 'create'), (plan2?.blocks || []).map((b: any) => b.action));
  ok('теперь все теги предлагается привязать',
    (plan2?.tagLinks || []).every((l: any) => l.action === 'link'), (plan2?.tagLinks || []).map((l: any) => l.action));
  ok('и видно, что они уже заняты своими изделиями',
    (plan2?.tagLinks || []).every((l: any) => !!l.takenBy), (plan2?.tagLinks || []).map((l: any) => l.takenBy));

  console.log('5. Лист технических данных установки: дерево и параметры');
  const ahu = recognize(AHU_SHEET);
  const ahuUnits = draftToUnits(ahu.items, `установка-${stamp}`);
  const ahuPlan = (await api('POST', '/api/equipment/import-draft-plan', {
    units: ahuUnits, category: 'AHU', projectId,
  })).json?.plan;
  ok('установка одна', (ahuPlan?.systems || []).length === 1, ahuPlan?.systems);
  ok('имя установки — её тег', ahuPlan?.systems?.[0]?.name === '1000-A01-HU-001A', ahuPlan?.systems?.[0]);
  const mbs = new Set((ahuPlan?.blocks || []).map((b: any) => b.monoblockName).filter(Boolean));
  ok('моноблока два', mbs.size === 2, [...mbs]);
  const fan = (ahuPlan?.blocks || []).find((b: any) => /ВЕНТ-063/.test(b.itemCode || ''));
  ok('вентилятор доехал под своей маркой', !!fan, (ahuPlan?.blocks || []).map((b: any) => b.itemCode));
  // «nдв» — обороты двигателя, «nрк» — рабочего колеса: индекс сохраняется в
  // подписи, иначе два разных параметра слились бы в один
  const rpm = (fan?.params || []).find((p: any) => p.key === 'Частота вращения (nдв)');
  ok('обороты подписаны оборотами, а не мощностью', !!rpm && rpm.value === '1435', (fan?.params || []).map((p: any) => p.key));
  ok('мощность не перепутана с оборотами',
    (fan?.params || []).some((p: any) => /мощность/i.test(p.key) && p.unit === 'кВт'),
    (fan?.params || []).map((p: any) => [p.key, p.unit]));

  console.log(f === 0 ? '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
  process.exit(f === 0 ? 0 : 1);
})();
