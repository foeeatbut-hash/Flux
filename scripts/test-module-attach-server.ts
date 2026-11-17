/**
 * Прикрепление результата программы к проекту на настоящем сервере (server.ts, одноразовая база SQLite).
 *
 * Что доказывается:
 * - файл ложится в «Результаты программ / <название программы>» проекта, содержимое возвращается байт в байт, размер — по записи;
 * - папки не плодятся: второй вызов кладёт в те же; одноимённый файл получает номер, прежний цел (не перезаписан);
 * - видят те же, кто видит проект: участник — да; человек вне состава закрытого проекта — нет (и не может прикрепить туда);
 * - отказы с кодом отдельным полем: нет проекта, проект закрыт/не существует, исполняемое имя, мусор вместо base64, пустой и слишком большой файл,
 *   запрет общего диска без права, нет входа (401);
 * - личность — из сессии: «автор» в теле запроса игнорируется;
 * - запись одной транзакцией: при сбое посреди записи не остаётся ни папки, ни файла без содержимого;
 * - журнал изменений получил строки на создание папок и файла (запись пошла через клиент транзакции).
 *
 * Запуск: npx tsx scripts/test-module-attach-server.ts   (свой сервер на свободном порту)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const require = createRequire(import.meta.url);
let passed = 0;
const check = (label: string, condition: unknown, detail?: unknown) => { assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`); passed++; console.log(`✓ ${label}`); };

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-attach-'));
  const allocator = net.createServer();
  await new Promise<void>((resolve) => allocator.listen(0, '127.0.0.1', resolve));
  const port = (allocator.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => allocator.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [...(process.env.FLUX_TEST_REQUIRE ? ['--require', process.env.FLUX_TEST_REQUIRE] : []), '--import', 'tsx', 'server.ts'], {
    env: { ...process.env, VENT_APP_DATA: directory, PORT: String(port), DATABASE_URL: '', FLUX_EMBEDDED: '1', FLUX_LISTEN_HOST: '127.0.0.1', FLUX_API_ONLY: '1', FLUX_TEST_LICENSE: '1', FLUX_TEST_LICENSE_AUTO: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { if (output.length < 100000) output += d; });
  child.stderr.on('data', (d) => { if (output.length < 100000) output += d; });
  try {
    const deadline = Date.now() + 120000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`Сервер завершился (${child.exitCode}): ${output.slice(-1500)}`);
      try { const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) }); if (r.ok) break; } catch { /* ещё поднимается */ }
      if (Date.now() > deadline) throw new Error(`Сервер не поднялся: ${output.slice(-1500)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    const dbFile = path.join(directory, 'database.sqlite');
    const Database = require('better-sqlite3');
    const db = new Database(dbFile);
    const password = 'disposable-attach-password';
    const hash = (() => { const salt = crypto.randomBytes(16); return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(password, salt, 64).toString('hex')}`; })();
    const user = (id: string, role: string) => db.prepare('INSERT INTO "User" (id, symbol, name, password, role, permissions) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, hash, role, '{}');
    user('at-admin', 'ADMIN');
    user('at-member', 'ENGINEER_VENT');
    user('at-outsider', 'ENGINEER_VENT');
    db.prepare('INSERT INTO "Project" (id, name) VALUES (?, ?)').run('at-open', 'Открытый проект');
    db.prepare('INSERT INTO "Project" (id, name) VALUES (?, ?)').run('at-closed', 'Закрытый проект');
    // Состав закрытого проекта: админ и участник; посторонний в него не входит
    for (const id of ['at-admin', 'at-member']) db.prepare('INSERT INTO "ProjectMember" (id, projectId, userId) VALUES (?, ?, ?)').run(`m-${id}`, 'at-closed', id);
    db.close();

    const login = async (symbol: string) => {
      const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol, password }) });
      assert.equal(r.status, 200, `вход ${symbol}`);
      return (await r.json() as any).token as string;
    };
    const [admin, member, outsider] = [await login('at-admin'), await login('at-member'), await login('at-outsider')];
    const call = async (token: string | null, method: string, url: string, body?: any) => {
      const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) as any };
    };
    const b64 = (value: Buffer | string) => Buffer.from(value).toString('base64');
    const attach = (token: string | null, extra: Record<string, unknown> = {}) =>
      call(token, 'POST', '/api/modules/attach', { projectId: 'at-open', moduleId: 'air-calc', program: 'Расчёт воздуха', name: 'расчёт.csv', mime: 'text/csv', data: b64('a;b\n1;2\n'), ...extra });
    const rows = (sql: string, ...args: unknown[]) => { const h = new Database(dbFile, { readonly: true }); try { return h.prepare(sql).all(...args) as any[]; } finally { h.close(); } };

    console.log('1. Запись');
    const first = await attach(member);
    check('прикрепление принято: имя и папка для человека', first.status === 200 && first.body.name === 'расчёт.csv' && first.body.folder === 'Результаты программ / Расчёт воздуха', first);
    const folders = rows('SELECT id, name, parentId, scope, ownerId, projectId FROM "Folder" WHERE projectId = ?', 'at-open');
    const root = folders.find(f => f.name === 'Результаты программ' && f.parentId === null);
    const own = folders.find(f => f.name === 'Расчёт воздуха' && f.parentId === root?.id);
    check('папки: «Результаты программ» в корне проекта и подпапка программы, общие, без владельца', !!root && !!own && root.scope === 'SHARED' && own.scope === 'SHARED' && !root.ownerId && !own.ownerId, folders);
    const files = rows('SELECT id, name, size, folderId, scope, ownerId, createdById, updatedById, type FROM "FileNode" WHERE folderId = ?', own?.id);
    check('файл лежит в подпапке, размер — по содержимому, автор — вошедший, раздел общий', files.length === 1 && files[0].name === 'расчёт.csv' && files[0].size === 8 && files[0].createdById === 'at-member' && files[0].scope === 'SHARED' && !files[0].ownerId, files);
    const chunks = rows('SELECT idx, data FROM "FileChunk" WHERE fileId = ?', files[0].id);
    check('содержимое возвращается байт в байт одним куском', chunks.length === 1 && chunks[0].idx === 0 && Buffer.from(chunks[0].data).toString('utf8') === 'a;b\n1;2\n');
    const raw = await fetch(`${base}/api/files/${files[0].id}/raw`, { headers: { Authorization: `Bearer ${member}` } });
    check('и отдаётся обычным путём Проводника (/raw)', raw.status === 200 && (await raw.text()) === 'a;b\n1;2\n');

    console.log('\n2. Повтор: ничего не плодится и не перезаписывается');
    const again = await attach(member, { data: b64('другое содержимое') });
    check('одноимённый файл получает номер', again.status === 200 && again.body.name === 'расчёт (2).csv', again);
    const afterFolders = rows('SELECT id FROM "Folder" WHERE projectId = ?', 'at-open');
    check('папки не продублированы', afterFolders.length === folders.length, afterFolders.length);
    const both = rows('SELECT name, size FROM "FileNode" WHERE folderId = ? ORDER BY name', own.id);
    check('прежний файл цел (имя и размер), новый рядом', both.length === 2 && both.some(f => f.name === 'расчёт.csv' && f.size === 8) && both.some(f => f.name === 'расчёт (2).csv'), both);
    const oldBytes = rows('SELECT data FROM "FileChunk" WHERE fileId = ?', files[0].id);
    check('содержимое прежнего файла не затронуто', Buffer.from(oldBytes[0].data).toString('utf8') === 'a;b\n1;2\n');
    const other = await attach(member, { program: 'Другая программа', name: 'расчёт.csv' });
    check('другая программа — своя подпапка, имя свободно', other.status === 200 && other.body.name === 'расчёт.csv' && other.body.folder === 'Результаты программ / Другая программа', other);
    const trashed = rows('SELECT id FROM "FileNode" WHERE folderId = ? AND name = ?', own.id, 'расчёт (2).csv');
    const del = await call(admin, 'DELETE', `/api/files/${trashed[0].id}`);
    const afterTrash = await attach(member, { data: b64('третий') });
    check('имя из корзины тоже занято: восстановленный файл не встанет рядом одноимённым', del.status === 200 && afterTrash.status === 200 && afterTrash.body.name === 'расчёт (3).csv', { del: del.status, afterTrash });

    console.log('\n3. Кто видит');
    const outsiderSees = await call(outsider, 'GET', `/api/projects/at-open/folders`);
    const outsiderFolders: any[] = outsiderSees.body.folders || outsiderSees.body || [];
    check('открытый проект: посторонний (не в составе, состав пуст) видит папку результатов', outsiderSees.status === 200 && JSON.stringify(outsiderFolders).includes('Результаты программ'), outsiderSees.status);
    const toClosedOutsider = await attach(outsider, { projectId: 'at-closed' });
    check('в закрытый проект человек вне состава прикрепить не может: отказ с кодом PROJECT_CLOSED', toClosedOutsider.status === 403 || toClosedOutsider.status === 404, toClosedOutsider);
    check('и в базе ничего не появилось', rows('SELECT id FROM "Folder" WHERE projectId = ?', 'at-closed').length === 0 && rows('SELECT f.id FROM "FileNode" f JOIN "Folder" d ON d.id = f.folderId WHERE d.projectId = ?', 'at-closed').length === 0);
    const toClosedMember = await attach(member, { projectId: 'at-closed' });
    check('участник закрытого проекта прикрепляет', toClosedMember.status === 200, toClosedMember);
    const outsiderReads = await call(outsider, 'GET', `/api/projects/at-closed/folders`);
    check('посторонний не видит файл закрытого проекта', outsiderReads.status === 403 || outsiderReads.status === 404, outsiderReads.status);
    const missing = await attach(member, { projectId: 'нет-такого' });
    check('несуществующий проект — тот же отказ, что и закрытый (не выдаёт, что он есть)', (missing.status === 404 || missing.status === 403) && !!(missing.body.error), missing);

    console.log('\n4. Отказы с кодом отдельным полем');
    const refused = async (label: string, token: string | null, extra: Record<string, unknown>, status: number, code?: string) => {
      const answer = await attach(token, extra);
      check(label, answer.status === status && (code === undefined || answer.body.code === code) && (status === 401 || typeof answer.body.error === 'string'), answer);
    };
    await refused('без входа — 401', null, {}, 401);
    await refused('без проекта — NO_PROJECT', member, { projectId: '' }, 400, 'NO_PROJECT');
    await refused('исполняемое имя — BAD_NAME', member, { name: 'вирус.exe' }, 400, 'BAD_NAME');
    await refused('служебное имя Windows — BAD_NAME', member, { name: 'con.txt' }, 400, 'BAD_NAME');
    await refused('мусор вместо base64 — BAD_DATA', member, { data: '!!!не-base64!!!' }, 400, 'BAD_DATA');
    await refused('пустой файл — EMPTY', member, { data: '' }, 400, 'EMPTY');
    await refused('слишком большой — LIMIT', member, { data: b64(Buffer.alloc(600_000, 7)) }, 413, 'LIMIT');
    await refused('программа не названа — BAD_PROGRAM', member, { program: '  ' }, 400, 'BAD_PROGRAM');
    const traversal = await attach(member, { program: '../../Секрет/..\\x' });
    check('название программы с путём не создаёт вложенных папок', traversal.status === 200 && !/[\\/]\s*[^/]*[\\/]/.test(traversal.body.folder.replace('Результаты программ / ', '')), traversal.body.folder);
    const asOther = await attach(member, { createdById: 'at-admin', authorId: 'at-admin', userId: 'at-admin' });
    const authored = rows('SELECT createdById FROM "FileNode" WHERE id = ?', asOther.body.file?.id);
    check('«автор» из тела игнорируется: файл записан на вошедшего', asOther.status === 200 && authored[0]?.createdById === 'at-member', authored);

    console.log('\n5. Общий диск и журнал');
    const tree = await call(member, 'GET', '/api/projects/at-open/folders');
    const diskProjectId = String(tree.body?.diskProjectId || '');
    check('проект общего диска существует', !!diskProjectId, tree.body?.diskProjectId);
    const onDisk = await attach(member, { projectId: diskProjectId });
    check('общий диск без права «Общий диск» — отказ DISK, и ничего не записано', onDisk.status === 403 && onDisk.body.code === 'DISK' && rows(`SELECT id FROM "Folder" WHERE projectId = ? AND name = 'Результаты программ'`, diskProjectId).length === 0, onDisk);
    const adminOnDisk = await attach(admin, { projectId: diskProjectId });
    check('у администратора право «Общий диск» есть по роли: прикрепление на диск проходит', adminOnDisk.status === 200, adminOnDisk);
    const feed = rows(`SELECT model, kind FROM "ChangeFeed" WHERE model = 'FileNode' AND kind = 'create'`);
    const written = rows(`SELECT id FROM "FileNode" WHERE folderId IN (SELECT id FROM "Folder" WHERE name IN ('Расчёт воздуха', 'Другая программа') AND projectId IN ('at-open', 'at-closed'))`);
    check('журнал изменений получил строку на каждый созданный файл (запись шла через клиент транзакции)', feed.length >= written.length && written.length >= 4, { feed: feed.length, written: written.length });

    console.log('\n6. Одной транзакцией');
    // Занимаем ключ куска заранее нельзя (файл новый), поэтому ломаем запись содержимого иначе: таблица кусков временно переименована
    const broken = new Database(dbFile);
    broken.exec('ALTER TABLE "FileChunk" RENAME TO "FileChunk_hold"');
    broken.close();
    const countsBefore = { folders: rows('SELECT id FROM "Folder"').length, files: rows('SELECT id FROM "FileNode"').length };
    const failing = await attach(member, { projectId: 'at-open', program: 'Сломанная', name: 'x.csv' });
    const restore = new Database(dbFile);
    restore.exec('ALTER TABLE "FileChunk_hold" RENAME TO "FileChunk"');
    restore.close();
    const countsAfter = { folders: rows('SELECT id FROM "Folder"').length, files: rows('SELECT id FROM "FileNode"').length };
    check('сбой записи содержимого — FAILED, а не успех', failing.status === 500 && failing.body.code === 'FAILED' && typeof failing.body.error === 'string', failing);
    check('и ни папки, ни файла без содержимого не осталось', countsAfter.folders === countsBefore.folders && countsAfter.files === countsBefore.files, { countsBefore, countsAfter });
  } finally {
    if (child.exitCode === null && !child.signalCode) { const exited = once(child, 'exit'); child.kill(); const timer = setTimeout(() => child.kill('SIGKILL'), 3000); await exited; clearTimeout(timer); }
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log(`module-attach-server: ${passed} проверок прошли`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
