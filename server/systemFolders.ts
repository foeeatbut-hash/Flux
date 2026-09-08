/**
 * Системные папки Проводника: те, что заводит сама программа.
 *
 * Их две сущности и один смысл — «место, которое человек не создавал, но
 * которое обязано быть»: рабочий стол сотрудника и общий стол проекта.
 * `system: true` запрещает их переименовывать, переносить и удалять
 * (server/routes/explorer.ts).
 *
 * Отдельным файлом, потому что этим пользуются двое — маршруты стола и
 * маршруты Flux Office, — а импортировать маршрут из маршрута значит замкнуть
 * круг: стол уже зовёт зеркало документа, а зеркало теперь кладётся на стол.
 */
import { getPrisma, onDatabaseSwapped } from './context.js';

/** Имя системной папки стола. Оно же служит ключом поиска — менять нельзя */
export const DESK_FOLDER = 'Рабочий стол';

/** Имя папки, в которой документы студии лежали до версии 1.1 */
export const LEGACY_OFFICE_FOLDER = 'Конструктор';

/**
 * Папка стола заводится по требованию: пустой стол не должен ничего плодить.
 *
 * Личный стол принадлежит сотруднику (`scope: PERSONAL`, `ownerId`), общий —
 * проекту (`scope: SHARED`, без владельца).
 */
export async function ensureDeskFolder(
  projectId: string,
  scope: 'PERSONAL' | 'SHARED',
  ownerId: string | null,
): Promise<any> {
  const prisma = getPrisma();
  const where = {
    projectId,
    name: DESK_FOLDER,
    system: true,
    scope,
    ownerId: scope === 'PERSONAL' ? ownerId : null,
    parentId: null,
  };
  const found = await prisma.folder.findFirst({ where });
  return found || prisma.folder.create({ data: where });
}

/**
 * Разовый перевоз: содержимое папки «Конструктор» — на рабочий стол.
 *
 * Документы Flux Office складывались в отдельную системную папку. Человек при
 * этом ждёт их там же, где ждал бы в Windows, — на своём столе: он сохранил
 * файл и хочет увидеть его значок, а не искать по дереву Проводника.
 *
 * Перевозим, а не бросаем: оставленная папка означала бы, что вчерашние
 * документы лежат в одном месте, а сегодняшние в другом, и найти вчерашние
 * можно только зная историю программы.
 *
 * Признак выполненного пишется в настройки, иначе перевоз повторялся бы при
 * каждом запуске и таскал бы обратно то, что человек с тех пор разложил сам.
 */
export async function migrateOfficeFolderToDesk(): Promise<number> {
  const prisma = getPrisma();
  let moved = 0;
  const legacy = await prisma.folder.findMany({
    where: { name: LEGACY_OFFICE_FOLDER, system: true },
  });
  for (const old of legacy as any[]) {
    const scope: 'PERSONAL' | 'SHARED' = old.scope === 'PERSONAL' ? 'PERSONAL' : 'SHARED';
    const desk = await ensureDeskFolder(old.projectId, scope, old.ownerId || null);
    if (desk.id === old.id) continue;
    const files = await prisma.fileNode.updateMany({
      where: { folderId: old.id },
      data: { folderId: desk.id },
    });
    // Подпапки, которые сотрудник завёл внутри, едут целиком: он их так и
    // разложил, и разбирать их за него — значит потерять его порядок
    await prisma.folder.updateMany({ where: { parentId: old.id }, data: { parentId: desk.id } });
    moved += Number(files?.count || 0);
    // Папка уходит только пустой: если что-то не перевезлось, пусть лучше
    // останется видимой, чем исчезнет вместе с содержимым
    const left = await prisma.fileNode.count({ where: { folderId: old.id } });
    const leftDirs = await prisma.folder.count({ where: { parentId: old.id } });
    if (!left && !leftDirs) await prisma.folder.delete({ where: { id: old.id } });
  }
  return moved;
}

/** Признак выполненного перевоза: в настройках, чтобы он случился один раз */
const MIGRATED_KEY = 'office_desk_migrated';
let checked = false;

/**
 * Перевезти документы Flux Office на рабочий стол, если это ещё не сделано.
 *
 * Зовётся из тех мест, где папка и нужна: из маршрутов Flux Office и из
 * маршрутов стола. Отдельного шага при запуске нет намеренно — общая база у
 * отдела одна, а серверов столько же, сколько сотрудников, и перевоз, начатый
 * при запуске у каждого, был бы одним и тем же делом в пять рук.
 */
export async function ensureOfficeOnDesk(): Promise<void> {
  if (checked) return;
  checked = true;
  const prisma = getPrisma();
  try {
    const row = await prisma.appSetting.findFirst({ where: { key: MIGRATED_KEY, userId: null } });
    if (row?.value) return;
    const moved = await migrateOfficeFolderToDesk();
    await prisma.appSetting.create({
      data: { key: MIGRATED_KEY, userId: null, value: new Date().toISOString() },
    });
    if (moved) console.log(`[Flux Office] Документов перевезено на рабочий стол: ${moved}`);
  } catch (e: any) {
    // Не смогли — попробуем в следующий раз: перевоз не условие работы
    checked = false;
    console.warn('[Flux Office] Перевоз на рабочий стол отложен:', e?.message);
  }
}

// База сменилась — признак выполненного у новой свой, проверяем заново
onDatabaseSwapped(() => { checked = false; });
