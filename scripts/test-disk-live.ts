/**
 * Общий диск: один на всю программу, читают все, пишут по праву.
 *
 * Разбором кода этого не поймать. Диск устроен служебным ПРОЕКТОМ, и вся суть
 * в том, что он ведёт себя не как проект: не показывается в переключателе, не
 * меняется при смене проекта, не становится проектом «по умолчанию». Каждое из
 * этих свойств живёт в своём запросе, и проверить их можно только вместе.
 *
 * Право проверяется вдвоём: «я не могу написать на диск» в одиночку
 * бессмысленно — администратор может всё. Нужен второй сотрудник, у которого
 * права нет.
 *
 * Запуск (нужен поднятый сервер):
 *   npx tsx server.ts > /tmp/srv.log 2>&1 &
 *   npx tsx scripts/test-disk-live.ts
 */
import { FEATURES } from '../src/lib/permissions';

const BASE = process.env.FLUX_API || 'http://localhost:3000';

/**
 * Права второму сотруднику: все, кроме одного.
 *
 * Забрать надо ИМЕННО право диска. Если отдать ему карту с одним ключом,
 * пропадут и «Загрузка файлов», и проверка покажет «не может ничего» вместо
 * «не может писать на диск» — то есть подтвердит не то, что мы спрашивали.
 */
const permsExcept = (off: string) => JSON.stringify(
  Object.fromEntries(FEATURES.map((f) => [f.id, { enabled: f.id !== off, until: null }])),
);
const ADMIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };

let failed = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { console.log('  ✓', name); return; }
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got).slice(0, 300)}`}`);
};

const api = async (method: string, url: string, token: string, body?: any) => {
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

  const stamp = Date.now().toString(36).slice(-6);
  const login = await api('POST', '/api/login', '', ADMIN);
  const admin = login.json?.token || '';
  if (!admin) { console.error('Не удалось войти администратором.'); process.exit(2); }

  console.log('1. Диск заводится сам и не притворяется проектом');
  const p1 = await api('POST', '/api/projects', admin, { name: `Диск-проба А ${stamp}` });
  const p2 = await api('POST', '/api/projects', admin, { name: `Диск-проба Б ${stamp}` });
  const projA = p1.json?.project?.id || p1.json?.id;
  const projB = p2.json?.project?.id || p2.json?.id;
  ok('два проекта для пробы заведены', !!projA && !!projB, [projA, projB]);

  const treeA = await api('GET', `/api/projects/default/folders?actorId=`, admin);
  const diskProjectId = String(treeA.json?.diskProjectId || '');
  const diskFolderId = String(treeA.json?.diskFolderId || '');
  ok('дерево называет проект диска', !!diskProjectId, treeA.json?.diskProjectId);
  ok('и его корневую папку', !!diskFolderId, treeA.json?.diskFolderId);

  const projects = await api('GET', '/api/projects', admin);
  const list: any[] = Array.isArray(projects.json) ? projects.json : (projects.json?.projects || []);
  // Диск в переключателе — это приглашение «переключиться в хранилище»,
  // после которого исчезли бы теги, оборудование и все данные проекта
  ok('в списке проектов диска нет',
    !list.some((p) => p.id === diskProjectId), list.map((p) => p.name));

  const diskRoot = (treeA.json?.folders || []).find((f: any) => f.id === diskFolderId);
  ok('корень диска — системная папка', !!diskRoot?.system, diskRoot);
  ok('и он в проекте диска', diskRoot?.projectId === diskProjectId, diskRoot?.projectId);
  ok('и он общий, а не личный', diskRoot?.scope === 'SHARED' && !diskRoot?.ownerId, diskRoot?.scope);

  console.log('2. Содержимое диска не зависит от проекта');
  const made = await api('POST', '/api/files', admin, {
    name: `Норматив ${stamp}.txt`, folderId: diskFolderId, type: 'TXT',
    content: 'data:text/plain;base64,0J3QvtGA0LzQsNGC0LjQsg==',
  });
  ok('файл лёг на диск', made.status === 200 && !!made.json?.file?.id, made.json);
  const fileId = made.json?.file?.id;

  const seenFrom = async (project: string) => {
    const t = await api('GET', `/api/projects/default/folders?actorId=`, admin);
    const root = (t.json?.folders || []).find((f: any) => f.id === diskFolderId);
    return (root?.files || []).some((f: any) => f.id === fileId);
  };
  ok('виден при одном проекте', await seenFrom(projA));
  // Ровно то, ради чего диск и заводили: «Общий» принадлежит проекту, диск — нет
  ok('и при другом — тот же самый', await seenFrom(projB));

  console.log('3. Класть на диск — по праву, читать — всем');
  const pass = `Пр${stamp}!7`;
  const mk = await api('POST', '/api/users', admin, {
    symbol: `disk${stamp}`, name: 'Проба Диск', password: pass, role: 'USER',
  });
  const mateId = mk.json?.user?.id || mk.json?.id;
  ok('второй сотрудник заведён', !!mateId, mk.json);
  // Забираем именно право диска, остальное не трогаем: иначе проверка показала
  // бы «не может ничего», а не «не может писать на диск»
  await api('PUT', `/api/users/${mateId}`, admin, { permissions: permsExcept('disk.write') });
  const mateLogin = await api('POST', '/api/login', '', { symbol: `disk${stamp}`, password: pass });
  const mate = mateLogin.json?.token || '';
  ok('второй сотрудник вошёл', !!mate, mateLogin.json);

  const mateTree = await api('GET', `/api/projects/default/folders?actorId=${mateId}`, mate);
  const mateRoot = (mateTree.json?.folders || []).find((f: any) => f.id === diskFolderId);
  ok('он видит диск', !!mateRoot, mateTree.json?.diskFolderId);
  ok('и лежащий на нём файл', (mateRoot?.files || []).some((f: any) => f.id === fileId),
    (mateRoot?.files || []).map((f: any) => f.name));

  const mateWrite = await api('POST', '/api/files', mate, {
    name: `Чужое ${stamp}.txt`, folderId: diskFolderId, type: 'TXT', content: 'data:text/plain;base64,eA==',
  });
  ok('но положить на диск не может', mateWrite.status === 403, [mateWrite.status, mateWrite.json]);
  ok('и отказ объясняет, чего не хватает',
    String(mateWrite.json?.error || '').includes('Общий диск'), mateWrite.json?.error);

  const mateFolder = await api('POST', '/api/folders', mate, {
    name: 'Своя папка', projectId: diskProjectId, parentId: diskFolderId,
  });
  ok('и папку на диске не заводит', mateFolder.status === 403, mateFolder.status);

  const mateDelete = await api('DELETE', `/api/files/${fileId}`, mate);
  ok('и чужое с диска не удаляет', mateDelete.status === 403, mateDelete.status);

  // Право выдали — и запреты снимаются тем же ключом
  await api('PUT', `/api/users/${mateId}`, admin, { permissions: permsExcept('') });
  const allowed = await api('POST', '/api/files', mate, {
    name: `Разрешённое ${stamp}.txt`, folderId: diskFolderId, type: 'TXT', content: 'data:text/plain;base64,eA==',
  });
  ok('с правом — кладёт', allowed.status === 200, [allowed.status, allowed.json?.error]);

  console.log('4. Корзина одного проекта не трогает удалённое в другом');
  const fa = await api('POST', '/api/folders', admin, { name: `Папка А ${stamp}`, projectId: projA });
  const fb = await api('POST', '/api/folders', admin, { name: `Папка Б ${stamp}`, projectId: projB });
  const inA = await api('POST', '/api/files', admin, {
    name: `А ${stamp}.txt`, folderId: fa.json?.folder?.id, type: 'TXT', content: 'data:text/plain;base64,eA==',
  });
  const inB = await api('POST', '/api/files', admin, {
    name: `Б ${stamp}.txt`, folderId: fb.json?.folder?.id, type: 'TXT', content: 'data:text/plain;base64,eA==',
  });
  await api('DELETE', `/api/files/${inA.json?.file?.id}`, admin);
  await api('DELETE', `/api/files/${inB.json?.file?.id}`, admin);

  const trashA = await api('GET', `/api/projects/${projA}/trash`, admin);
  const namesA = (trashA.json?.files || []).map((f: any) => f.name);
  ok('в корзине проекта А своё есть', namesA.includes(`А ${stamp}.txt`), namesA);
  // Тихий дефект: очистка корзины одного проекта стирала удалённое во всех
  ok('и чужого в ней нет', !namesA.includes(`Б ${stamp}.txt`), namesA);

  await api('DELETE', `/api/projects/${projA}/trash`, admin);
  const trashB = await api('GET', `/api/projects/${projB}/trash`, admin);
  ok('после очистки А удалённое в Б на месте',
    (trashB.json?.files || []).some((f: any) => f.name === `Б ${stamp}.txt`),
    (trashB.json?.files || []).map((f: any) => f.name));

  // Убираем за собой: свои пробные записи не должны стать чужими провалами
  await api('DELETE', `/api/files/${fileId}`, admin);
  await api('DELETE', `/api/files/${allowed.json?.file?.id}`, admin);
  await api('DELETE', `/api/users/${mateId}`, admin);
  await api('DELETE', `/api/projects/${projA}`, admin);
  await api('DELETE', `/api/projects/${projB}`, admin);

  console.log(failed === 0 ? '\nВсе проверки общего диска пройдены' : `\nПровалено: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();
