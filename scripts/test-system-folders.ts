/**
 * Перевоз документов Flux Office на рабочий стол.
 *
 * Разовая правка данных — самое опасное, что делает обновление: она проходит
 * один раз, у каждого сотрудника по-своему, и увидеть её последствия можно
 * только когда человек не найдёт вчерашний документ. Поэтому она проверяется
 * не «на живой базе», а поштучно, с подставной базой, где видно каждое
 * действие.
 *
 * Запуск: npx tsx scripts/test-system-folders.ts
 */
import { setPrisma } from '../server/context';
import { migrateOfficeFolderToDesk, DESK_FOLDER, LEGACY_OFFICE_FOLDER } from '../server/systemFolders';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { console.log('  ✓', name); return; }
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

/** Подставная база: тот же разговор, что у Prisma, но в памяти и на виду */
function fakeDb(folders: any[], files: any[]) {
  let seq = 0;
  const match = (row: any, where: any): boolean =>
    Object.entries(where || {}).every(([k, v]) => {
      if (v && typeof v === 'object' && 'in' in (v as any)) return (v as any).in.includes(row[k]);
      return row[k] === v;
    });
  return {
    folder: {
      findMany: async ({ where }: any) => folders.filter((f) => match(f, where)),
      findFirst: async ({ where }: any) => folders.find((f) => match(f, where)) || null,
      create: async ({ data }: any) => { const row = { id: `f${++seq}`, ...data }; folders.push(row); return row; },
      updateMany: async ({ where, data }: any) => {
        let n = 0;
        for (const f of folders) if (match(f, where)) { Object.assign(f, data); n++; }
        return { count: n };
      },
      count: async ({ where }: any) => folders.filter((f) => match(f, where)).length,
      delete: async ({ where }: any) => {
        const i = folders.findIndex((f) => f.id === where.id);
        if (i >= 0) folders.splice(i, 1);
        return {};
      },
    },
    fileNode: {
      updateMany: async ({ where, data }: any) => {
        let n = 0;
        for (const f of files) if (match(f, where)) { Object.assign(f, data); n++; }
        return { count: n };
      },
      count: async ({ where }: any) => files.filter((f) => match(f, where)).length,
    },
  };
}

(async () => {
console.log('1. Содержимое старой папки переезжает на стол');
{
  const folders: any[] = [
    { id: 'old', projectId: 'p1', name: LEGACY_OFFICE_FOLDER, system: true, scope: 'SHARED', ownerId: null, parentId: null },
    { id: 'sub', projectId: 'p1', name: 'Ведомости', system: false, scope: 'SHARED', ownerId: null, parentId: 'old' },
  ];
  const files: any[] = [
    { id: 'a', folderId: 'old', name: 'Смета' },
    { id: 'b', folderId: 'old', name: 'Записка' },
    { id: 'c', folderId: 'sub', name: 'Вложенная' },
  ];
  setPrisma(fakeDb(folders, files));
  const moved = await migrateOfficeFolderToDesk();

  const desk = folders.find((f) => f.name === DESK_FOLDER && f.scope === 'SHARED');
  check('папка стола заведена', !!desk, folders.map((f) => f.name));
  check('файлы переехали на стол', files.filter((f) => f.folderId === desk?.id).length === 2,
    files.map((f) => [f.name, f.folderId]));
  check('и посчитаны', moved === 2, moved);
  // Подпапку сотрудник завёл сам — разбирать её за него значит потерять его порядок
  check('его подпапка переехала целиком, а не рассыпалась',
    folders.find((f) => f.id === 'sub')?.parentId === desk?.id,
    folders.find((f) => f.id === 'sub')?.parentId);
  check('файл внутри подпапки остался в ней', files.find((f) => f.id === 'c')?.folderId === 'sub');
  check('старая папка убрана', !folders.some((f) => f.name === LEGACY_OFFICE_FOLDER), folders.map((f) => f.name));
}

console.log('2. Личное едет на личный стол, общее — на общий');
{
  const folders: any[] = [
    { id: 'o1', projectId: 'p1', name: LEGACY_OFFICE_FOLDER, system: true, scope: 'SHARED', ownerId: null, parentId: null },
    { id: 'o2', projectId: 'p1', name: LEGACY_OFFICE_FOLDER, system: true, scope: 'PERSONAL', ownerId: 'u7', parentId: null },
  ];
  const files: any[] = [
    { id: 'a', folderId: 'o1', name: 'Общая' },
    { id: 'b', folderId: 'o2', name: 'Личная' },
  ];
  setPrisma(fakeDb(folders, files));
  await migrateOfficeFolderToDesk();

  const shared = folders.find((f) => f.name === DESK_FOLDER && f.scope === 'SHARED');
  const personal = folders.find((f) => f.name === DESK_FOLDER && f.scope === 'PERSONAL');
  check('заведены оба стола', !!shared && !!personal, folders.map((f) => [f.name, f.scope]));
  check('личный стол принадлежит своему сотруднику', personal?.ownerId === 'u7', personal?.ownerId);
  check('общий стол без владельца', shared?.ownerId === null, shared?.ownerId);
  check('общая — на общем', files.find((f) => f.id === 'a')?.folderId === shared?.id);
  // Личный документ на общем столе увидели бы все — это утечка, а не неудобство
  check('личная — на личном', files.find((f) => f.id === 'b')?.folderId === personal?.id);
}

console.log('3. Перевозить нечего — ничего и не делаем');
{
  const folders: any[] = [
    { id: 'd1', projectId: 'p1', name: DESK_FOLDER, system: true, scope: 'SHARED', ownerId: null, parentId: null },
  ];
  const files: any[] = [{ id: 'a', folderId: 'd1', name: 'Уже на столе' }];
  setPrisma(fakeDb(folders, files));
  const moved = await migrateOfficeFolderToDesk();
  check('перевезено ноль', moved === 0, moved);
  check('стол не задвоился', folders.filter((f) => f.name === DESK_FOLDER).length === 1, folders.length);
  check('файл остался на месте', files[0].folderId === 'd1');
}

console.log(failed === 0 ? '\nВсе проверки системных папок пройдены' : `\nПровалено: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();
