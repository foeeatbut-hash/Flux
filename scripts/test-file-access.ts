/**
 * Права доступа к файлам: кто читает, кто пишет, что можно менять через PATCH.
 *
 * Внешняя проверка безопасности подтвердила: файл, скрытый в списке Проводника,
 * отдавался по номеру любому вошедшему (`/api/files/:id`, `/raw`, редакторы
 * Flux Office), а PATCH передавал в базу произвольные поля тела — в том числе
 * `scope`, `ownerId` и `content`. Правило теперь одно, в server/fileAccess.ts;
 * здесь оно проверяется на подставных объектах, без сервера и без базы.
 *
 * Запуск: npx tsx scripts/test-file-access.ts
 */
import {
  decideFileAccess, isFileOwnerOrAdmin, patchFileFields, personalScopeWhere, personalVisible,
  canReadFile, canWriteFile, canAccessFolder,
} from '../server/fileAccess';
import { setPrisma } from '../server/context';
import { setupOfficeRooms } from '../server/officeRooms';

let ok = 0, fail = 0;
function eq(name: string, got: any, want: any) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) { ok++; console.log('  ✓', name); }
  else { fail++; console.error('  ✗', name, '\n      получено:', JSON.stringify(got), '\n      ожидалось:', JSON.stringify(want)); }
}

const MAIN = 'u-main';      // Главный Администратор: самый первый ADMIN
const ANNA = { id: 'u-anna', role: 'USER' };
const BORIS = { id: 'u-boris', role: 'USER' };
const MAIN_USER = { id: MAIN, role: 'ADMIN' };
const OTHER_ADMIN = { id: 'u-admin2', role: 'ADMIN' };

const personalOfAnna = { id: 'f1', scope: 'PERSONAL', ownerId: ANNA.id, folderId: null, type: 'FILE' };
const shared = { id: 'f2', scope: 'SHARED', ownerId: null, folderId: null, type: 'FILE' };
const access = (user: any, file: any, folder: any = null, projectVisible = true) =>
  decideFileAccess({ user, mainAdminId: MAIN, file, folder, projectVisible });

console.log('1. Личное видит владелец и Главный Администратор');
eq('владелец читает свой личный файл', access(ANNA, personalOfAnna), true);
eq('чужой личный файл — нет', access(BORIS, personalOfAnna), false);
eq('Главный Администратор видит чужой личный, как в списке', access(MAIN_USER, personalOfAnna), true);
eq('другой администратор личного чужих не видит, как и в списке', access(OTHER_ADMIN, personalOfAnna), false);
eq('общий файл виден любому вошедшему', access(BORIS, shared), true);
eq('личный файл без владельца — только Главному Администратору', [access(ANNA, { ...personalOfAnna, ownerId: null }), access(MAIN_USER, { ...personalOfAnna, ownerId: null })], [false, true]);
eq('без входа не видно ничего, даже общего', access(null, shared), false);
eq('пустой пользователь (без id) — как без входа', access({}, shared), false);
eq('файла нет — отказ', access(ANNA, null), false);

console.log('2. Вложения чата этим правилом не отдаются');
eq('CHAT_FILE закрыт даже владельцу и администратору', [
  access(ANNA, { ...personalOfAnna, type: 'CHAT_FILE' }),
  access(MAIN_USER, { ...shared, type: 'CHAT_FILE' }),
], [false, false]);

console.log('3. Файл в папке наследует видимость папки и проекта');
const folderOfAnna = { scope: 'PERSONAL', ownerId: ANNA.id, projectId: 'p1' };
eq('общий по отметке файл в чужой личной папке — закрыт', access(BORIS, { ...shared, folderId: 'd1' }, folderOfAnna), false);
eq('он же у хозяина папки — открыт', access(ANNA, { ...shared, folderId: 'd1' }, folderOfAnna), true);
eq('общая папка и общий проект — открыто', access(BORIS, { ...shared, folderId: 'd2' }, { scope: 'SHARED', ownerId: null, projectId: 'p1' }), true);
eq('проект закрыт для человека — файл закрыт, хоть он и общий', access(BORIS, { ...shared, folderId: 'd2' }, { scope: 'SHARED', projectId: 'p2' }, false), false);
eq('личный файл в общей папке чужого не открывается', access(BORIS, { ...personalOfAnna, folderId: 'd2' }, { scope: 'SHARED', projectId: 'p1' }), false);

console.log('4. Условие списка: то же правило для Prisma');
eq('Главный Администратор — без ограничений', personalScopeWhere(MAIN_USER, MAIN), {});
eq('обычный сотрудник — общее и своё', personalScopeWhere(ANNA, MAIN), { OR: [{ scope: { not: 'PERSONAL' } }, { ownerId: ANNA.id }] });
eq('без входа — только общее', personalScopeWhere(null, MAIN), { scope: { not: 'PERSONAL' } });
eq('без Главного Администратора (пустая база) никто не получает «всё»', personalScopeWhere({ id: 'x' }, null), { OR: [{ scope: { not: 'PERSONAL' } }, { ownerId: 'x' }] });
eq('personalVisible: общее видно всем', personalVisible(null, MAIN, 'SHARED', null), true);

console.log('5. Кто вправе менять раздел и владельца файла');
eq('владелец личного', isFileOwnerOrAdmin(ANNA, personalOfAnna), true);
eq('посторонний', isFileOwnerOrAdmin(BORIS, personalOfAnna), false);
eq('администратор', isFileOwnerOrAdmin(OTHER_ADMIN, shared), true);
eq('автор общего файла', isFileOwnerOrAdmin(BORIS, { ...shared, createdById: BORIS.id }), true);
eq('не автор общего файла', isFileOwnerOrAdmin(ANNA, { ...shared, createdById: BORIS.id }), false);
eq('без входа', isFileOwnerOrAdmin(null, shared), false);

console.log('6. PATCH файла: белый список полей');
const ctx = (over: any = {}) => ({ actorId: ANNA.id, current: personalOfAnna, ownerOrAdmin: true, ...over });
const evil = {
  name: 'План.docx', revision: '3', statusCode: 'B', department: 'КИПиА',
  content: 'ПОДМЕНА', filePath: '/etc/passwd', createdById: BORIS.id, updatedById: BORIS.id,
  deletedAt: null, size: 1, type: 'CHAT_FILE', id: 'другой', folderId: 'чужая',
};
const p1 = patchFileFields(evil, ctx());
eq('пропускаются только имя, ревизия, статус, отдел и «кто изменил» из сессии',
  p1.data, { updatedById: ANNA.id, name: 'План.docx', revision: '3', statusCode: 'B', department: 'КИПиА' });
eq('content, filePath, createdById, deletedAt, size, type, id, folderId отброшены',
  ['content', 'filePath', 'createdById', 'deletedAt', 'size', 'type', 'id', 'folderId'].filter((k) => k in p1.data), []);
eq('updatedById из тела не принимается', patchFileFields({ updatedById: BORIS.id }, ctx()).data, { updatedById: ANNA.id });
eq('пустое тело — меняется только «кто изменил»', patchFileFields({}, ctx()).data, { updatedById: ANNA.id });
eq('не-объект вместо тела не роняет', patchFileFields(null, ctx()).data, { updatedById: ANNA.id });
eq('пустое имя — отказ 400', patchFileFields({ name: '   ' }, ctx()).error?.status, 400);
eq('имя не строкой — отказ 400', patchFileFields({ name: { $set: 'x' } }, ctx()).error?.status, 400);
eq('теги — списки номеров', (() => { const r = patchFileFields({ mainTagIds: ['a'], additionalTagIds: [] }, ctx()); return [r.mainTagIds, r.additionalTagIds]; })(), [['a'], []]);
eq('теги не списком — отказ 400', patchFileFields({ mainTagIds: 'a' }, ctx()).error?.status, 400);
eq('теги с не-строками — отказ 400', patchFileFields({ additionalTagIds: [{ id: 'a' }] }, ctx()).error?.status, 400);

console.log('7. PATCH файла: раздел и владелец');
eq('посторонний меняет scope — 403', patchFileFields({ scope: 'PERSONAL' }, ctx({ ownerOrAdmin: false })).error?.status, 403);
eq('посторонний меняет ownerId — 403', patchFileFields({ ownerId: BORIS.id }, ctx({ ownerOrAdmin: false })).error?.status, 403);
eq('владелец выкладывает файл в общий: владелец обнуляется', (() => { const d = patchFileFields({ scope: 'SHARED' }, ctx()).data; return [d.scope, d.ownerId]; })(), ['SHARED', null]);
eq('владелец делает общий файл личным — своим', (() => { const d = patchFileFields({ scope: 'PERSONAL' }, ctx({ current: shared })).data; return [d.scope, d.ownerId]; })(), ['PERSONAL', ANNA.id]);
eq('владелец не назначает чужого хозяина — 403', patchFileFields({ scope: 'PERSONAL', ownerId: BORIS.id }, ctx()).error?.status, 403);
eq('Главный Администратор назначает хозяина', patchFileFields({ scope: 'PERSONAL', ownerId: BORIS.id }, ctx({ actorId: MAIN, actorIsMainAdmin: true })).data.ownerId, BORIS.id);
eq('неизвестное значение scope — 400', patchFileFields({ scope: 'ALL' }, ctx()).error?.status, 400);
eq('ownerId без scope у личного файла сохраняет раздел', (() => { const d = patchFileFields({ ownerId: ANNA.id }, ctx()).data; return [d.scope, d.ownerId]; })(), ['PERSONAL', ANNA.id]);

console.log('8. Проверки с базой на подставном клиенте');
// Минимальная имитация Prisma: только то, что читает fileAccess и правило проектов
const files: Record<string, any> = {
  f1: personalOfAnna,
  f2: shared,
  f3: { id: 'f3', scope: 'SHARED', ownerId: null, folderId: 'dHidden', type: 'FILE' },
  f4: { id: 'f4', scope: 'SHARED', ownerId: null, folderId: 'dAnna', type: 'FILE' },
};
const folders: Record<string, any> = {
  dHidden: { scope: 'SHARED', ownerId: null, projectId: 'pClosed' },
  dAnna: { scope: 'PERSONAL', ownerId: ANNA.id, projectId: 'pOpen' },
};
const members = [{ projectId: 'pClosed', userId: ANNA.id }];
const fake = {
  fileNode: { findUnique: async ({ where }: any) => files[where.id] || null },
  folder: { findUnique: async ({ where }: any) => folders[where.id] || null },
  user: { findFirst: async () => ({ id: MAIN }) },
  projectMember: {
    count: async (a?: any) => members.filter((m) => !a?.where || ((!a.where.projectId || m.projectId === a.where.projectId) && (!a.where.userId || m.userId === a.where.userId))).length,
    findMany: async (a?: any) => members.filter((m) => !a?.where?.projectId || m.projectId === a.where.projectId),
  },
};
setPrisma(fake as any);
(async () => {
  eq('по номеру: свой личный файл читается', await canReadFile(fake, ANNA, 'f1'), true);
  eq('по номеру: чужой личный — нет', await canReadFile(fake, BORIS, 'f1'), false);
  eq('по номеру: несуществующий — нет', await canReadFile(fake, ANNA, 'нет-такого'), false);
  eq('запись в чужой личный файл — нет', await canWriteFile(fake, BORIS, 'f1'), false);
  eq('запись в свой личный файл — да', await canWriteFile(fake, ANNA, 'f1'), true);
  eq('общий файл читает любой вошедший', await canReadFile(fake, BORIS, 'f2'), true);
  eq('файл закрытого проекта: участнику — да', await canReadFile(fake, ANNA, 'f3'), true);
  eq('файл закрытого проекта: постороннему — нет', await canReadFile(fake, BORIS, 'f3'), false);
  eq('файл закрытого проекта: администратору — да', await canReadFile(fake, OTHER_ADMIN, 'f3'), true);
  eq('файл в чужой личной папке — нет', await canReadFile(fake, BORIS, 'f4'), false);
  eq('запись сама принимает и запись файла, и номер', await canReadFile(fake, ANNA, files.f1), true);
  eq('чужая личная папка недоступна', await canAccessFolder(fake, BORIS, 'dAnna'), false);
  eq('своя личная папка доступна', await canAccessFolder(fake, ANNA, 'dAnna'), true);
  eq('корень раздела (папки нет) доступен', await canAccessFolder(fake, BORIS, null), true);
  eq('несуществующая папка — нет', await canAccessFolder(fake, ANNA, 'нет'), false);
  eq('без входа — нет', await canReadFile(fake, null, 'f2'), false);
  // № 24 и mayWriteFile: запись в чужой личный файл — только у владельца и Главного Администратора
  eq('другой администратор не пишет в чужой личный файл', await canWriteFile(fake, OTHER_ADMIN, 'f1'), false);
  eq('Главный Администратор пишет в чужой личный файл, как и видит его', await canWriteFile(fake, MAIN_USER, 'f1'), true);
  eq('другой администратор не читает файл в чужой личной папке', await canReadFile(fake, OTHER_ADMIN, 'f4'), false);

  console.log('9. Комната файла: вход только тем, кто файл читает');
  // Подставной сокет: комната записывает вход в hub и подписывает сокет на рассылку
  const enter = async (user: any, fileId: string) => {
    const handlers: Record<string, Function> = {};
    const joined: string[] = [];
    const hubCalls: string[] = [];
    const socket: any = { id: 's1', userId: user.id, connected: true, on: (e: string, f: Function) => { handlers[e] = f; }, join: (r: string) => joined.push(r), leave: () => {} };
    const hub: any = { join: async (id: string) => { hubCalls.push(id); }, depart: async () => {} };
    let wrote = 0;
    setupOfficeRooms(socket, {
      nameOf: async () => 'Имя',
      mayRead: async (uid, fid) => canReadFile(fake, uid === user.id ? user : null, fid),
      mayWrite: async () => { wrote++; return ''; },
      isShared: async () => false,
    }, hub);
    await handlers['office:join']({ fileId, clientId: 'c1', app: 'docs' });
    return { joined, hubCalls, wrote };
  };
  const own = await enter(ANNA, 'f1');
  eq('хозяин личного файла входит в комнату', [own.joined.length, own.hubCalls], [1, ['f1']]);
  const alien = await enter(BORIS, 'f1');
  eq('чужой в комнату личного файла не входит и в базу не записывается', [alien.joined, alien.hubCalls], [[], []]);
  const other = await enter(OTHER_ADMIN, 'f1');
  eq('другой администратор тоже не входит', [other.joined, other.hubCalls], [[], []]);
  const ghost = await enter(ANNA, 'нет-такого');
  eq('несуществующий файл — молчаливый отказ, как и чужой', [ghost.joined, ghost.hubCalls], [[], []]);
  eq('право записи до отказа не спрашивается впустую', alien.wrote, 0);

  console.log(`\n${ok} ✓, ${fail} ✗`);
  process.exit(fail ? 1 : 0);
})();
