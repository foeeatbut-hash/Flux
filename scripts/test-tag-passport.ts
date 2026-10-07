/**
 * Паспорт тега: GET /api/tags/:id/passport.
 *
 * Проверяет, что в одном ответе собраны примечания ВСЕХ источников (комментарии
 * тега, примечание и этапы закупки, заметки блокнота, разбор САПР), что у тега
 * нет группы ВДР, даже когда строка ВДР ссылается на его код, и что тег закрытого
 * проекта постороннему не отдаётся — ни паспортом, ни историей.
 *
 * Нужен сервер (FLUX_API) и вход администратора (FLUX_USER, FLUX_PASS). Проект
 * и сотрудник — свои, одноразовые, в конце удаляются.
 *
 * Запуск: FLUX_USER=… FLUX_PASS=… npx tsx scripts/test-tag-passport.ts
 */
import { randomUUID } from 'node:crypto';
import { testCredentials } from './testCredentials';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = testCredentials();

let ok = 0;
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { ok++; return; }
  fail++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got).slice(0, 600)}`}`);
};

const call = async (token: string, method: string, url: string, body?: unknown) => {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* не JSON */ }
  return { status: res.status, json };
};

const stamp = Date.now().toString(36);
const code = `PSP-${stamp}-A`;

async function main() {
  try { await call('', 'GET', '/api/health'); } catch (e: any) {
    console.error(`Сервер на ${BASE} не отвечает (${e?.message || e}).`); process.exit(2);
  }
  const login = await call('', 'POST', '/api/login', LOGIN);
  const admin = login.json?.token || '';
  if (!admin) { console.error('Вход не удался', login.json?.message); process.exit(1); }
  const A = (method: string, url: string, body?: unknown) => call(admin, method, url, body);

  // Сотрудник без прав на закрытый проект и тот, кого в проект позвали
  const outsiderSymbol = `psp-out-${randomUUID().slice(0, 8)}`;
  const outsiderPass = randomUUID();
  const insiderSymbol = `psp-in-${randomUUID().slice(0, 8)}`;
  const insiderPass = randomUUID();
  const outsider = (await A('POST', '/api/users', { name: 'Посторонний', symbol: outsiderSymbol, password: outsiderPass, role: 'ENGINEER_VENT' })).json;
  const insider = (await A('POST', '/api/users', { name: 'Свой', symbol: insiderSymbol, password: insiderPass, role: 'ENGINEER_VENT' })).json;
  const outsiderId = outsider?.user?.id || outsider?.id;
  const insiderId = insider?.user?.id || insider?.id;
  const outTok = (await call('', 'POST', '/api/login', { symbol: outsiderSymbol, password: outsiderPass })).json?.token || '';
  const inTok = (await call('', 'POST', '/api/login', { symbol: insiderSymbol, password: insiderPass })).json?.token || '';
  check('служебные сотрудники заведены', !!outsiderId && !!insiderId && !!outTok && !!inTok, [outsider, insider]);

  const proj = await A('POST', '/api/projects', { name: `Паспорт ${stamp}` });
  const projectId = proj.json?.project?.id;
  if (!projectId) { console.error('Проект не заведён', proj.json); process.exit(1); }
  const mine: string[] = [];
  let registerId = '';
  const noteIds: string[] = [];

  try {
    // Проект становится закрытым: в составе только администратор и «свой»
    const me = login.json?.user?.id;
    const members = await A('POST', `/api/projects/${projectId}/members`, { userIds: [me, insiderId] });
    check('состав проекта задан', members.status === 200, members.json);

    console.log('Подготовка: тег, комментарий, закупка, состав');
    const tag = (await A('POST', `/api/projects/${projectId}/tags`, {
      identifier: code, brand: 'Марка', department: 'ОВ',
      metadata: JSON.stringify({ x: 100, y: 100, mainName: 'Вентилятор приточный', connections: [], descriptions: [] }),
    })).json?.tag;
    const child = (await A('POST', `/api/projects/${projectId}/tags`, { identifier: `${code}-M`, metadata: JSON.stringify({ x: 400, y: 100, mainName: 'Двигатель', connections: [], descriptions: [] }) })).json?.tag;
    const parent = (await A('POST', `/api/projects/${projectId}/tags`, { identifier: `PSP-${stamp}-AHU`, metadata: JSON.stringify({ x: 100, y: 400, mainName: 'Установка', connections: [], descriptions: [] }) })).json?.tag;
    mine.push(tag?.id, child?.id, parent?.id);
    check('теги заведены', !!tag?.id && !!child?.id && !!parent?.id);

    const comment = { id: 'c-1', text: 'Проверить мощность', comment: 'уточнить у заказчика', status: 'warning', createdBy: 'Иван Теговый', createdAt: '2026-09-01T10:00:00.000Z' };
    await A('PUT', `/api/tags/${tag.id}`, { metadata: { descriptions: [comment], parentId: parent.id } });
    await A('PUT', `/api/tags/${parent.id}`, { metadata: { connections: [tag.id] } });
    await A('PUT', `/api/tags/${tag.id}`, { metadata: { connections: [child.id] } });
    const proc = await A('PATCH', `/api/tags/${tag.id}/procurement`, { procurement: {
      stage: 'ordered', supplier: 'ООО Поставщик', qty: '2', note: 'Срок поставки 8 недель',
      stageLog: { ordered: { at: '2026-09-10T08:00:00.000Z', by: 'Пётр Закупщик' } },
    } });
    check('закупка записана', proc.status === 200, proc.json);

    // Заметка блокнота администратора и заметка постороннего, обе с кодом тега
    const myNote = (await A('POST', '/api/notes', { title: 'Созвон по вентилятору', content: `<p>Обсудили ${code}: срок и мощность</p>` })).json?.note;
    const foreignNote = (await call(inTok, 'POST', '/api/notes', { title: 'Чужая заметка', content: `<p>Личное про ${code}</p>` })).json?.note;
    noteIds.push(myNote?.id, foreignNote?.id);
    check('заметки заведены', !!myNote?.id && !!foreignNote?.id);

    // Примечание САПР: позиция с тегом и свидетельством о теге
    const units = [{ name: 'у1', title: 'Установка', monoblocks: [{ name: 'M1', title: '', blocks: [{
      name: 'бл1', title: 'Вентилятор', equipType: 'component', tags: [code],
      tagNotes: [{ identifier: code, verdict: 'assigned', why: 'указан в примечании к вентилятору', phrase: 'Вентилятор — тег ' + code }],
    }] }] }];
    // Связи с тегами предлагает сам план — как в мастере; здесь тег уже есть, и план привязывает позицию к нему
    const plan = await A('POST', '/api/equipment/import-draft-plan', { units, category: 'AHU', projectId });
    const sapr = await A('POST', '/api/equipment/import-draft', { units, category: 'AHU', fileName: 'проба.XML', projectId, tagLinks: plan.json?.plan?.tagLinks });
    check('позиция с примечанием САПР ввезена', sapr.status === 200, sapr.json);

    // Строка ВДР, ссылающаяся на код: группы ВДР в паспорте быть не должно
    registerId = (await A('POST', '/api/vdr/registers', { projectId, name: 'ВДР проверки' })).json?.register?.id;
    await A('POST', '/api/vdr/items', { registerId, titleRu: `Схема ${code}`, contractorNo: 'C-1', equipmentTags: JSON.stringify([code]) });

    console.log('Паспорт');
    const res = await A('GET', `/api/tags/${tag.id}/passport`);
    const p = res.json;
    check('паспорт отдан', res.status === 200 && p?.tag?.id === tag.id, res);
    check('шапка: код, наименование, марка, отдел, проект', p?.tag?.identifier === code && p?.tag?.mainName === 'Вентилятор приточный' && p?.tag?.brand === 'Марка' && p?.tag?.department === 'ОВ' && p?.tag?.projectName === `Паспорт ${stamp}`, p?.tag);
    check('создан — автор из истории', !!p?.created?.at && !!p?.created?.by, p?.created);

    const notes: any[] = p?.notes || [];
    const by = (source: string) => notes.filter((n) => n.source === source);
    const c1 = notes.find((n) => n.source === 'tags');
    check('комментарий тега: текст, пояснение, автор и дата', c1?.text === 'Проверить мощность' && c1?.detail === 'уточнить у заказчика' && c1?.author === 'Иван Теговый' && c1?.at === '2026-09-01T10:00:00.000Z' && c1?.sourceLabel === 'Теги', c1);
    const pn = notes.find((n) => n.source === 'procurement' && n.kind === 'note');
    check('примечание закупки отдельно от комментария, подписано «Закупка»', pn?.text === 'Срок поставки 8 недель' && pn?.sourceLabel === 'Закупка', pn);
    check('у примечания закупки автор и дата — из истории', !!pn?.author && !!pn?.at, pn);
    const st = notes.find((n) => n.source === 'procurement' && n.kind === 'stage');
    check('отметка этапа: «Заказан», кто и когда', /Заказан/.test(st?.text || '') && st?.author === 'Пётр Закупщик' && st?.at === '2026-09-10T08:00:00.000Z', st);
    const nb = by('notebook');
    check('заметка блокнота — своя, с фрагментом', nb.length === 1 && nb[0].detail === 'Созвон по вентилятору' && nb[0].text.includes(code), nb);
    check('чужая заметка блокнота в паспорт не попала', !notes.some((n) => /Чужая заметка|Личное про/.test(`${n.text}${n.detail || ''}`)), nb);
    const cad = by('cad');
    check('примечание САПР с позиции, связанной с тегом', cad.length === 1 && /Вентилятор — тег/.test(cad[0].text) && cad[0].sourceLabel === 'САПР' && cad[0].status === 'назначен', cad);
    check('источников четыре: Теги, Закупка, Заметки, САПР', new Set(notes.map((n) => n.source)).size === 4, notes.map((n) => n.source));
    const dated = notes.filter((n) => n.at).map((n) => n.at);
    check('список — новые сверху', dated.every((v, i) => i === 0 || dated[i - 1] >= v), dated);

    check('закупка: этап, поставщик, количество', p?.procurement?.stageId === 'ordered' && p?.procurement?.supplier === 'ООО Поставщик' && p?.procurement?.qty === '2', p?.procurement);
    check('родитель — по parentId', p?.composition?.parent?.id === parent.id && p?.composition?.parent?.mainName === 'Установка', p?.composition);
    check('состав — по connections', p?.composition?.children?.[0]?.id === child.id, p?.composition);

    const groups: any[] = p?.usage?.groups || [];
    check('«где используется»: оборудование есть', groups.some((g) => g.id === 'elements' && g.links.length === 1), groups.map((g) => g.id));
    check('группы ВДР нет, хотя строка ВДР ссылается на код тега', !groups.some((g) => g.id === 'vdr') && !JSON.stringify(groups).includes('"kind":"vdr"'), groups.map((g) => g.id));
    check('прежняя карточка связей тоже без ВДР', !(await A('GET', `/api/insight/where-used?kind=tag&id=${tag.id}&projectId=${projectId}`)).json?.groups?.some((g: any) => g.id === 'vdr'));
    const direct = await A('GET', `/api/vdr/items/by-tag?projectId=${projectId}&tag=${encodeURIComponent(code)}`);
    check('данные ВДР не тронуты: строка по-прежнему ссылается на код', (direct.json?.items || []).length === 1, direct.json);

    check('история в паспорте: создание и закупка', (p?.history || []).some((h: any) => h.kind === 'создан') && (p?.history || []).some((h: any) => h.source === 'Закупки' && h.field === 'procurement.stage'), p?.history?.slice(0, 5));
    check('лента подписана: поле и автор', (p?.history || []).every((h: any) => 'fieldLabel' in h && 'userName' in h));

    console.log('Дубли кода');
    // «А» и «Р» кириллические — тот же код, набранный в другой раскладке
    const twin = (await A('POST', `/api/projects/${projectId}/tags`, { identifier: code.replace('PSP', 'РSР').replace('-A', '-А'), metadata: '{}' })).json?.tag;
    if (twin?.id) mine.push(twin.id);
    const withTwin = (await A('GET', `/api/tags/${tag.id}/passport`)).json;
    check('двойник по написанию назван дублем', !!twin?.id && (withTwin?.duplicates || []).some((d: any) => d.id === twin.id), { twin: twin?.identifier, dups: withTwin?.duplicates });
    check('соседний код не считается дублем', !(withTwin?.duplicates || []).some((d: any) => d.id === child.id || d.id === parent.id));

    console.log('Права');
    check('свой (в составе) читает паспорт', (await call(inTok, 'GET', `/api/tags/${tag.id}/passport`)).status === 200);
    const foreign = await call(outTok, 'GET', `/api/tags/${tag.id}/passport`);
    check('посторонний: паспорт тега закрытого проекта не отдаётся (403)', foreign.status === 403 && !foreign.json?.tag, foreign);
    check('посторонний: и история тега закрыта', (await call(outTok, 'GET', `/api/tags/${tag.id}/history`)).status === 403);
    check('посторонний: и запись закупки', (await call(outTok, 'PATCH', `/api/tags/${tag.id}/procurement`, { procurement: { stage: 'purchased' } })).status === 403);
    check('закупка постороннего не записалась', (await A('GET', `/api/tags/${tag.id}/passport`)).json?.procurement?.stageId === 'ordered');
    check('без входа — 401', (await call('', 'GET', `/api/tags/${tag.id}/passport`)).status === 401);
    check('несуществующий тег — 404', (await A('GET', '/api/tags/нет-такого/passport')).status === 404);
  } finally {
    for (const id of mine) if (id) await A('DELETE', `/api/tags/${id}`);
    for (const id of noteIds) if (id) await A('DELETE', `/api/notes/${id}`);
    if (registerId) await A('DELETE', `/api/vdr/registers/${registerId}`);
    await A('DELETE', `/api/projects/${projectId}`);
    for (const id of [outsiderId, insiderId]) if (id) await A('DELETE', `/api/users/${id}`);
  }

  console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
