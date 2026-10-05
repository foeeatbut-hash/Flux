/** Изолированные проверки прав и сохранения заметок; только синтетические записи в временной SQLite. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { parsePrismaSchema } from '../server/schema-sync';
import { setPrisma } from '../server/context';
import { setDialect } from '../server/ddl';
import { registerNoteRoutes } from '../server/routes/notes';

const requireFromRepo = createRequire(join(process.cwd(), 'package.json'));
const { PrismaClient } = requireFromRepo('@prisma/client-sqlite');
const { PrismaBetterSqlite3 } = requireFromRepo('@prisma/adapter-better-sqlite3');
const temp = mkdtempSync(join(tmpdir(), 'flux-remaining-notes-'));
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${join(temp, 'notes.sqlite')}` }) });
const handlers = new Map<string, Function>();
const app: any = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [method, (path: string, ...fns: Function[]) => handlers.set(`${method} ${path}`, fns.at(-1)!)]));
const people = { owner: { id: 'note-owner' }, editor: { id: 'note-editor' }, reader: { id: 'note-reader' }, stranger: { id: 'note-stranger' } };
let passed = 0;
const check = (name: string, condition: boolean) => {
  assert.equal(condition, true, name);
  passed++;
  console.log(`✓ ${name}`);
};
const call = async (method: string, route: string, user: any, body: any = {}, params: any = {}) => {
  const handler = handlers.get(`${method} ${route}`);
  assert.ok(handler, `registered ${method} ${route}`);
  let status = 200, value: any;
  const res: any = { status(code: number) { status = code; return res; }, json(json: any) { value = json; return res; } };
  await handler({ authUser: user, params, body }, res);
  return { status, value };
};

async function main() {
  try {
    setDialect('sqlite');
    setPrisma(prisma);
    const models = parsePrismaSchema('sqlite', readFileSync('prisma/schema.prisma', 'utf8'));
    for (const model of models.filter(model => ['UserNote', 'NoteShare'].includes(model.name))) {
      const columns = model.columns.map(column => `"${column.name}" ${column.sqlType}${column.nullable ? '' : ' NOT NULL'}${column.isId ? ' PRIMARY KEY' : ''}${column.unique ? ' UNIQUE' : ''}${column.defaultSql ? ` DEFAULT ${column.defaultSql}` : ''}`);
      const uniques = model.uniques.map(key => `UNIQUE (${key.columns.map(name => `"${name}"`).join(',')})`);
      await prisma.$executeRawUnsafe(`CREATE TABLE "${model.name}" (${[...columns, ...uniques].join(',')})`);
    }
    registerNoteRoutes(app);

    const made = await call('post', '/api/notes', people.owner, { title: '  ', content: '# Основа', groupName: 'Тестовая группа' });
    const noteId = String(made.value?.note?.id || '');
    assert.equal(made.status, 200);
    check('пустой заголовок получает видимое имя и запись принадлежит создателю', !!noteId && made.value.note.title === 'Новая заметка' && made.value.note.ownerId === people.owner.id);
    check('создание заметки записало текст, группу и доступный preset цвета', made.value.note.content === '# Основа' && made.value.note.groupName === 'Тестовая группа' && made.value.note.color.includes('amber'));

    const hidden = await call('get', '/api/notes', people.stranger);
    check('чужая личная заметка отсутствует в списке постороннего сотрудника', !hidden.value.notes.some((note: any) => note.id === noteId));
    check('прямое чтение личной заметки посторонним запрещено', (await call('get', '/api/notes/:id', people.stranger, {}, { id: noteId })).status === 403);
    check('правка личной заметки посторонним запрещена', (await call('patch', '/api/notes/:id', people.stranger, { content: 'подмена' }, { id: noteId })).status === 403);

    const changed = await call('patch', '/api/notes/:id', people.owner, { title: 'Итоги', content: '# Итоги\n\n- строка', color: 'bg-emerald-50', groupName: null }, { id: noteId });
    const stored = await prisma.userNote.findUnique({ where: { id: noteId } });
    check('владелец сохранил Markdown, цвет и снятие группы; повторное чтение совпадает', changed.status === 200 && stored.title === 'Итоги' && stored.content === '# Итоги\n\n- строка' && stored.color === 'bg-emerald-50' && stored.groupName === null);

    const view = await call('put', '/api/notes/:id/shares', people.owner, { shares: [{ userId: people.reader.id, canEdit: false }, { userId: people.owner.id, canEdit: true }] }, { id: noteId });
    const reader = await call('get', '/api/notes/:id', people.reader, {}, { id: noteId });
    const readerList = await call('get', '/api/notes', people.reader);
    check('владелец выдаёт VIEW одному сотруднику и share себя не создаёт', view.status === 200 && view.value.shares.length === 1 && view.value.shares[0].userId === people.reader.id && view.value.shares[0].canEdit === false);
    check('получатель видит общую заметку как read-only в карточке и списке', reader.status === 200 && reader.value.note.canEdit === false && readerList.value.notes.some((row: any) => row.id === noteId && row.canEdit === false));
    check('получатель с VIEW не может менять текст или доступ', (await call('patch', '/api/notes/:id', people.reader, { content: 'подмена' }, { id: noteId })).status === 403 && (await call('put', '/api/notes/:id/shares', people.reader, { shares: [] }, { id: noteId })).status === 403);
    check('посторонний сотрудник не может читать список получателей', (await call('get', '/api/notes/:id/shares', people.stranger, {}, { id: noteId })).status === 403);

    const edit = await call('put', '/api/notes/:id/shares', people.owner, { shares: [{ userId: people.editor.id, canEdit: true }] }, { id: noteId });
    const editorWrite = await call('patch', '/api/notes/:id', people.editor, { title: 'Правка коллеги', content: '# Общая правка' }, { id: noteId });
    const ownerRead = await call('get', '/api/notes/:id', people.owner, {}, { id: noteId });
    check('право EDIT разрешает правку, которая сохраняется и читается владельцем', edit.status === 200 && editorWrite.status === 200 && ownerRead.value.note.title === 'Правка коллеги' && ownerRead.value.note.content === '# Общая правка');
    check('редактор общей заметки не может удалить оригинал', (await call('delete', '/api/notes/:id', people.editor, {}, { id: noteId })).value?.removedShare === true && !!(await prisma.userNote.findUnique({ where: { id: noteId } })));

    await call('put', '/api/notes/:id/shares', people.owner, { shares: [{ userId: people.reader.id, canEdit: false }] }, { id: noteId });
    await call('delete', '/api/notes/:id', people.reader, {}, { id: noteId });
    check('получатель удаляет только свою ссылку, а оригинал владельца остаётся', !!(await prisma.userNote.findUnique({ where: { id: noteId } })) && (await call('get', '/api/notes/:id', people.reader, {}, { id: noteId })).status === 403);
    const revoked = await call('put', '/api/notes/:id/shares', people.owner, { shares: [] }, { id: noteId });
    check('владелец может отозвать доступ; получатель сразу теряет прямое чтение', revoked.status === 200 && revoked.value.shares.length === 0 && (await call('get', '/api/notes/:id', people.reader, {}, { id: noteId })).status === 403);
    check('после отзыва владелец сохраняет изменённую заметку', (await call('get', '/api/notes/:id', people.owner, {}, { id: noteId })).value.note.content === '# Общая правка');

    await prisma.userNote.create({ data: { title: 'Старая общая', content: 'legacy text', ownerId: null } });
    const legacy = await prisma.userNote.findFirst({ where: { title: 'Старая общая' } });
    const claim = await call('post', '/api/notes/:id/claim', people.owner, {}, { id: legacy.id });
    const cannotReclaim = await call('post', '/api/notes/:id/claim', people.editor, {}, { id: legacy.id });
    check('старая общая заметка становится личной у первого заявившего сотрудника', claim.status === 200 && claim.value.note.ownerId === people.owner.id && cannotReclaim.status === 400);

    const ownerDelete = await call('delete', '/api/notes/:id', people.owner, {}, { id: noteId });
    check('удаление владельцем удаляет запись и связанные выдачи доступа', ownerDelete.status === 200 && !(await prisma.userNote.findUnique({ where: { id: noteId } })) && await prisma.noteShare.count({ where: { noteId } }) === 0);
    console.log(`Notes API/domain: ${passed} checks PASS (temporary SQLite, synthetic users and notes)`);
  } finally {
    await prisma.$disconnect().catch(() => undefined);
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
