/**
 * Путь файла Windows через программу: принесли — открыли — выгрузили.
 *
 * Проверка написана по трём поломкам разом. Стол не принимал файлы Windows
 * вовсе; двойное нажатие по книге Excel вело в предпросмотр вместо редактора;
 * а разбор Word на сервере не работал в собранной программе никогда — он звал
 * библиотеку из зависимостей для разработки, которых у сотрудника нет.
 *
 * Здесь проверяется то, что можно проверить без окна: сервер принимает файл,
 * отдаёт его байты обратно теми же, заводит документ из разобранного окном и
 * связывает файл с документом — чтобы второе открытие вело в тот же документ,
 * а не в новую копию.
 *
 * Запуск (нужен поднятый сервер):
 *   npx tsx server.ts > /tmp/srv.log 2>&1 &
 *   npx tsx scripts/test-office-open.ts
 */
import { buildDocx, partsFromText } from '../src/lib/docxWrite';
import { planDrop } from '../src/lib/dropFiles';
import { appsFor, isOffice } from '../src/lib/fileTypes';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 240) : ''));

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
  token = (await api('POST', '/api/login', LOGIN)).json?.token || '';
  if (!token) { console.error('Не удалось войти.'); process.exit(2); }

  console.log('1. Сервер говорит, какой файл примет его база');
  const limits = await api('GET', '/api/limits');
  ok('предел назван числом', Number(limits.json?.maxFileBytes) > 0, limits.json);
  const max = Number(limits.json?.maxFileBytes);
  // Правила приёма считают тем же пределом, что назвал сервер
  const plan = planDrop([{ name: 'Смета.xlsx', size: 1024 }, { name: 'Огромный.xlsx', size: max + 1 }], [], max);
  ok('файл в пределах принимается', plan.accepted.length === 1, plan.accepted);
  ok('файл сверх предела отклоняется с причиной', plan.refused.length === 1, plan.refused);

  console.log('2. Двойное нажатие по офисному файлу ведёт в редактор');
  ok('книга Excel — офисный файл', isOffice({ id: 'x', name: 'Смета.xlsx' }));
  const apps = appsFor({ id: 'x', name: 'Смета.xlsx' });
  ok('первым идёт Flux Office, а не предпросмотр', apps[0].name === 'Flux Office', apps.map((a) => a.name));
  ok('предпросмотр остаётся вторым', apps.length > 1 && apps[1].id === 'explorer', apps.map((a) => a.id));

  const docxName = `Проверка-${Date.now()}.docx`;
  let fileId = '';
  let docId = '';
  try {
    console.log('3. Файл кладётся в программу и возвращается байт в байт');
    const bytes = buildDocx(partsFromText('Пояснительная записка\n\nСистема П1.\nИмя\tЗначение\nРасход\t1200'));
    const b64 = Buffer.from(bytes).toString('base64');
    const put = await api('POST', '/api/files', {
      name: docxName,
      filePath: `/personal/${docxName}`,
      size: bytes.length,
      type: 'DOCX',
      content: `data:application/octet-stream;base64,${b64}`,
      origin: 'C:\\Users\\Инженер\\Рабочий стол\\' + docxName,
    });
    ok('файл принят', put.status === 200 && !!put.json?.file?.id, put.json?.error || put.status);
    fileId = String(put.json?.file?.id || '');
    ok('запомнено, откуда файл принесли',
      String(put.json?.file?.origin || '').includes('Рабочий стол'), put.json?.file?.origin);

    const got = await api('GET', `/api/files/${fileId}`);
    const back = String(got.json?.file?.content || '');
    const backB64 = back.includes(',') ? back.slice(back.indexOf(',') + 1) : back;
    ok('содержимое вернулось тем же', Buffer.from(backB64, 'base64').equals(Buffer.from(bytes)),
      { было: bytes.length, стало: Buffer.from(backB64, 'base64').length });

    console.log('4. Из разобранного окном заводится документ');
    // Ровно то, что делает окно: разбор уже сделан, серверу остаётся завести
    // документ. Серверный разбор docx здесь не участвует — он и не работал
    const made = await api('POST', '/api/constructor/docs/import-file', {
      fileId,
      projectId: 'default',
      name: docxName.replace(/\.docx$/, ''),
      importText: 'Пояснительная записка\n\nСистема П1.',
    });
    ok('документ заведён', made.status === 200 && !!made.json?.doc?.id, made.json?.error || made.status);
    docId = String(made.json?.doc?.id || '');
    ok('это текстовый документ, а не книга', made.json?.doc?.kind === 'TEXT', made.json?.doc?.kind);
    ok('текст лежит в задании на вставку',
      String(made.json?.doc?.bindings || '').includes('Система П1'), made.json?.doc?.bindings);

    console.log('5. Второе открытие ведёт в тот же документ, а не в копию');
    const again = await api('GET', `/api/files/${fileId}`);
    ok('файл связан с документом', String(again.json?.file?.refId || '') === docId, again.json?.file?.refId);
    // По этой связи и решается, чем открывать: документ, а не «ещё одна копия»
    const asDoc = appsFor({ id: fileId, name: docxName, refId: docId });
    ok('открывается документом', asDoc[0].href({ id: fileId, refId: docId }).includes(docId),
      asDoc[0].href({ id: fileId, refId: docId }));
  } finally {
    if (docId) await api('DELETE', `/api/constructor/docs/${docId}`);
    if (fileId) await api('DELETE', `/api/files/${fileId}`);
  }

  console.log(f ? `\nПровалено проверок: ${f}` : '\nПроверка пути офисного файла пройдена');
  process.exit(f ? 1 : 0);
})();
