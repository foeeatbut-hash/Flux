/**
 * Сквозной путь работы: проект → его данные → тег → оборудование → связь →
 * документ → общий доступ.
 *
 * Проверка написана по просьбе владельца пройти работу по шагам и убрать
 * недочёты. Остальные пробы смотрят на части: раскладку, права, отдельные
 * маршруты. Здесь проверяется то, что между ними, — что цепочка целиком
 * доходит до конца и на каждом шаге данные действительно появляются там, где
 * их ждёт человек.
 *
 * Идёт через настоящие запросы программы, а не через базу: так же, как это
 * делает окно. Всё созданное убирается за собой.
 *
 * Запуск (нужен поднятый сервер):
 *   npx tsx server.ts > /tmp/srv.log 2>&1 &
 *   npx tsx scripts/test-walkthrough.ts
 */
const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };

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

const stamp = Date.now();
const NAME = `Проба сквозного пути ${stamp}`;

(async () => {
  try {
    const h = await fetch(BASE + '/api/health');
    if (!h.ok) throw new Error('health ' + h.status);
  } catch (e: any) {
    console.error(`Сервер на ${BASE} не отвечает (${e?.message || e}).`);
    process.exit(2);
  }
  token = (await api('POST', '/api/login', LOGIN)).json?.token || '';
  if (!token) { console.error('Не удалось войти.'); process.exit(2); }

  let projectId = '';
  let tagId = '';
  let fileId = '';
  let docId = '';

  try {
    console.log('1. Создание проекта');
    const made = await api('POST', '/api/projects', { name: NAME, code: `P-${stamp}`, customer: 'Заказчик' });
    ok('проект создан', made.status === 200 && !!(made.json?.project?.id || made.json?.id), made.json?.error || made.status);
    projectId = String(made.json?.project?.id || made.json?.id || '');
    const list = await api('GET', '/api/projects');
    const all = Array.isArray(list.json) ? list.json : (list.json?.projects || []);
    ok('проект виден в списке', all.some((p: any) => p.id === projectId), all.length);

    console.log('2. Изменение данных проекта');
    const upd = await api('PUT', `/api/projects/${projectId}`, {
      name: NAME, code: `P-${stamp}`, customer: 'Новый заказчик', contractor: 'Подрядчик', description: 'Правка',
    });
    ok('данные приняты', upd.status === 200, upd.json?.error || upd.status);
    const back = await api('GET', '/api/projects');
    const mine = (Array.isArray(back.json) ? back.json : (back.json?.projects || [])).find((p: any) => p.id === projectId);
    ok('заказчик сохранился', mine?.customer === 'Новый заказчик', mine?.customer);
    ok('подрядчик сохранился', mine?.contractor === 'Подрядчик', mine?.contractor);

    console.log('3. Новый тег');
    const code = `AHU-${String(stamp).slice(-5)}`;
    // Теги живут внутри проекта: /api/projects/<id>/tags — так же зовёт их окно
    const tag = await api('POST', `/api/projects/${projectId}/tags`, { identifier: code, department: 'ОВ' });
    ok('тег создан', tag.status === 200 && !!(tag.json?.tag?.id || tag.json?.id), tag.json?.error || tag.status);
    tagId = String(tag.json?.tag?.id || tag.json?.id || '');
    const tags = await api('GET', `/api/projects/${projectId}/tags`);
    const tagList = Array.isArray(tags.json) ? tags.json : (tags.json?.tags || []);
    ok('тег виден в реестре проекта', tagList.some((t: any) => t.id === tagId), tagList.length);

    console.log('4. Обновление сведений о теге');
    const tagUpd = await api('PUT', `/api/tags/${tagId}`, { department: 'АТХ', metadata: JSON.stringify({ brand: 'Systemair' }) });
    ok('правка принята', tagUpd.status === 200, tagUpd.json?.error || tagUpd.status);
    const tags2 = await api('GET', `/api/projects/${projectId}/tags`);
    const t2 = (Array.isArray(tags2.json) ? tags2.json : (tags2.json?.tags || [])).find((t: any) => t.id === tagId);
    ok('отдел изменился', t2?.department === 'АТХ', t2?.department);

    console.log('5. Оборудование проекта отвечает без данных');
    // Раздел берёт системы СВОЕГО проекта. Маршрут «/api/equipment», отдававший
    // оборудование всех проектов сразу, убран: им никто не пользовался, а дыру
    // он оставлял настоящую
    const eq = await api('GET', `/api/projects/${projectId}/systems`);
    ok('раздел отвечает, а не падает', eq.status === 200, eq.status);
    ok('в новом проекте оборудования нет', Array.isArray(eq.json?.systems) && eq.json.systems.length === 0, eq.json?.systems?.length);
    const foreign = await api('GET', '/api/equipment');
    ok('общей выдачи оборудования всех проектов больше нет', foreign.status === 404, foreign.status);

    console.log('6. Документ Flux Office');
    const doc = await api('POST', '/api/constructor/docs', { projectId, name: `Ведомость ${stamp}`, kind: 'DOC' });
    ok('документ создан', doc.status === 200 && !!doc.json?.doc?.id, doc.json?.error || doc.status);
    docId = String(doc.json?.doc?.id || '');
    const docs = await api('GET', `/api/constructor/docs?projectId=${projectId}`);
    ok('документ виден в списке проекта',
      (docs.json?.docs || []).some((d: any) => d.id === docId), (docs.json?.docs || []).length);

    console.log('7. Общий доступ: файл в общем разделе Проводника');
    const file = await api('POST', '/api/files', {
      name: `Общий-${stamp}.txt`,
      filePath: `/shared/Общий-${stamp}.txt`,
      size: 5, type: 'TXT', scope: 'SHARED',
      content: 'data:text/plain;base64,cHJvYmE=',
    });
    ok('файл создан', file.status === 200 && !!file.json?.file?.id, file.json?.error || file.status);
    fileId = String(file.json?.file?.id || '');
    ok('он именно общий, а не личный', file.json?.file?.scope === 'SHARED', file.json?.file?.scope);
    const got = await api('GET', `/api/files/${fileId}`);
    ok('содержимое читается обратно', String(got.json?.file?.content || '').includes('base64'), got.status);

    console.log('8. Журнал записал сделанное');
    const actions = await api('GET', '/api/logs/actions?take=50');
    const said = (actions.json?.actions || []).map((a: any) => a.what);
    ok('журнал доступен администратору', actions.status === 200, actions.status);
    ok('создание проекта записано', said.some((w: string) => /проект/i.test(w)), said.slice(0, 6));
    ok('создание тега записано', said.some((w: string) => /тег/i.test(w)), said.slice(0, 6));
    ok('создание файла записано', said.some((w: string) => /файл/i.test(w)), said.slice(0, 6));
  } finally {
    console.log('9. Убираем за собой');
    if (fileId) await api('DELETE', `/api/files/${fileId}`);
    if (docId) await api('DELETE', `/api/constructor/docs/${docId}`);
    if (tagId) await api('DELETE', `/api/tags/${tagId}`);
    if (projectId) await api('DELETE', `/api/projects/${projectId}`);
  }

  console.log(f ? `\nПровалено проверок: ${f}` : '\nСквозной путь пройден');
  process.exit(f ? 1 : 0);
})();
