/**
 * Прикрепление результата программы к проекту (`flux.attach`): файл ложится в Проводник проекта.
 *
 * Решение руководителя, владельцем не подтверждено (`.claude/progress/programs-11.md`): место — папка проекта «Результаты программ», внутри
 * подпапка по названию программы; видят те же, кто видит проект. Прежний файл не перезаписывается: при занятом имени у нового появляется
 * номер (`freeAttachName`), а ответ называет имя, под которым файл лёг.
 *
 * Что проверяет сервер, а что нет. Разрешение `attach` в подписанном манифесте проверяет мост окна Flux (modules/bridge.ts): манифест
 * проверяет и хранит главный процесс компьютера, сервер его не видит. Сервер отвечает за то, что принадлежит ему: кто пишет (только
 * сессия), в какой проект (человек обязан его видеть; общий диск — по праву «Общий диск»), лицензия сотрудника, имя и размер файла.
 * Запись — одной транзакцией через клиент транзакции: папки, файл и содержимое появляются вместе или не появляются совсем, а журнал
 * изменений получает свои строки в той же транзакции (server/changeFeed.ts).
 */
import type { Express, Request, Response } from 'express';
import { getPrisma } from '../context.js';
import { isPrivilegedUser } from '../accessPolicy.js';
import { canSeeProject } from './members.js';
import { ensureDiskProject } from '../systemFolders.js';
import { ATTACH_NAME_MAX, ATTACH_ROOT_FOLDER, attachFolderName, attachFolderPath, freeAttachName } from '../../modules/page/attach.js';
import { PAGE_LIMITS, saveNameProblem } from '../../modules/page/model.js';
import { dbTypeOf } from '../../src/lib/fileTypes.js';

export interface ModuleAttachDeps {
  /** Есть ли у сотрудника право — та же таблица, что у остальных разделов */
  can: (user: any, feature: string) => boolean;
  /** Действует ли лицензия сотрудника: без неё записи нет, как у остальных файлов (mayWriteFile в server.ts) */
  licensed: (user: any) => Promise<boolean>;
}

/** Строгий base64: Buffer.from молча принимает мусор и отдаёт «короче, чем прислали» */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** Предел байт: тот же, что у моста (700 тысяч знаков base64), чтобы сервер не принимал больше, чем мост пропускает */
export const ATTACH_MAX_BYTES = Math.floor(PAGE_LIMITS.saveChars * 3 / 4);
/** Код отказа отдельным полем, текст — для человека: окно решает по коду, а не разбирает фразу */
const refuse = (res: Response, status: number, code: string, error: string) => res.status(status).json({ code, error });

export function registerModuleAttachRoutes(app: Express, deps: ModuleAttachDeps): void {
  app.post('/api/modules/attach', async (req: Request, res: Response) => {
    const user = (req as any).authUser;
    // Личность — только из сессии: поля автора в теле запроса сервер не читает
    if (!user?.id) return refuse(res, 401, 'UNAUTHORIZED', 'Войдите во Flux заново.');
    const body = req.body || {};
    const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
    const name = typeof body.name === 'string' ? body.name : '';
    const program = typeof body.program === 'string' ? body.program : '';
    const data = typeof body.data === 'string' ? body.data : '';
    if (!projectId) return refuse(res, 400, 'NO_PROJECT', 'Откройте проект: результату программы некуда лечь.');
    if (!name || name.length > ATTACH_NAME_MAX || saveNameProblem(name)) return refuse(res, 400, 'BAD_NAME', 'Недопустимое имя файла: файлы-программы и служебные имена Windows не прикрепляются.');
    if (!program.trim() || program.length > 200) return refuse(res, 400, 'BAD_PROGRAM', 'Не названа программа, приславшая результат.');
    if (data.length % 4 !== 0 || !BASE64.test(data)) return refuse(res, 400, 'BAD_DATA', 'Содержимое файла передано в неверной кодировке.');
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length) return refuse(res, 400, 'EMPTY', 'Файл пустой: прикреплять нечего.');
    if (bytes.length > ATTACH_MAX_BYTES) return refuse(res, 413, 'LIMIT', 'Файл больше допустимого размера для прикрепления программой.');
    try {
      if (!(await deps.licensed(user))) return refuse(res, 402, 'LICENSE', 'Запись недоступна: продлите лицензию сотрудника у владельца Flux.');
      const prisma = getPrisma();
      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true } });
      // Закрытый проект и несуществующий отвечают одинаково: ответ «проект есть, но закрыт» сам подтверждал бы, что он существует
      if (!project || !(await canSeeProject(String(user.id), projectId, isPrivilegedUser(user)))) return refuse(res, 404, 'PROJECT_CLOSED', 'Проект не найден или закрыт для вас.');
      if (projectId === await ensureDiskProject() && !deps.can(user, 'disk.write')) {
        return refuse(res, 403, 'DISK', 'Общий диск открыт всем на чтение, а класть на него файлы можно по праву «Общий диск». Его выдаёт администратор в разделе «Сотрудники».');
      }
      const made = await prisma.$transaction(async (tx: any) => {
        // Общие (SHARED) папки без владельца: видят те же, кто видит проект. Корзину не берём: удалённая папка снова не оживает сама
        const folderIn = async (parentId: string | null, folderName: string) => {
          const found = await tx.folder.findFirst({ where: { projectId, parentId, name: folderName, scope: 'SHARED', deletedAt: null }, select: { id: true } });
          return found || tx.folder.create({ data: { name: folderName, projectId, parentId, scope: 'SHARED', ownerId: null }, select: { id: true } });
        };
        const root = await folderIn(null, ATTACH_ROOT_FOLDER);
        const own = await folderIn(root.id, attachFolderName(program));
        // Занятые имена — вместе с удалёнными в корзину: восстановленный файл не должен встать рядом с одноимённым
        const taken = await tx.fileNode.findMany({ where: { folderId: own.id }, select: { name: true } });
        const finalName = freeAttachName(name, taken.map((row: { name: string }) => row.name));
        const file = await tx.fileNode.create({
          data: {
            name: finalName, folderId: own.id, filePath: `/shared/${finalName}`, size: bytes.length, type: dbTypeOf(finalName),
            department: 'Unassigned', scope: 'SHARED', ownerId: null, createdById: String(user.id), updatedById: String(user.id),
          },
          select: { id: true, name: true, size: true },
        });
        // Содержимое — одним куском, как у файла из Проводника (server/routes/fileChunks.ts): при размере до ~512 КиБ второго куска не бывает
        await tx.fileChunk.create({ data: { fileId: file.id, idx: 0, data: bytes } });
        return { file, folderId: own.id };
      }, { timeout: 30_000, maxWait: 10_000 });
      res.json({ ok: true, file: { id: made.file.id, name: made.file.name, size: made.file.size, folderId: made.folderId }, name: made.file.name, folder: attachFolderPath(program), project: { id: project.id, name: project.name } });
    } catch (err: any) {
      console.error('[modules/attach]', err?.message);
      refuse(res, 500, 'FAILED', 'Не удалось прикрепить файл: проект не изменён. Повторите позже.');
    }
  });
}
