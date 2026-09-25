/**
 * Настоящий файл Flux из байтов — одно место на весь сервер.
 *
 * Выгрузки (оборудование, теги, ВДР, бланки), новый пустой документ, копия
 * рядом, английская версия — всё это «положить файл в Проводник и открыть его
 * в Flux Office». Раньше каждое место делало это по-своему: одним JSON-полем
 * в `content` (предел 50 МБ, без папки), без свободного имени, мимо кусков.
 * Здесь — одна дорога: свободное имя в папке, запись и куски одной
 * транзакцией, раздел и владелец — от папки.
 *
 * Куда класть, если не сказано: «Выгрузки» на личном столе сотрудника. Это
 * его черновое место — общий стол не засоряется каждой пробной выгрузкой, а
 * файл виден сразу, на столе и в Проводнике.
 */
import { createHash } from 'node:crypto';
import { getPrisma, resolveProjectId } from './context.js';
import { dbTypeOf } from '../src/lib/fileTypes.js';
import { ensureDeskFolder } from './systemFolders.js';

export const EXPORTS_FOLDER = 'Выгрузки';

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** Имя файла: без пути и запрещённых в Windows знаков, с расширением образца */
export function cleanName(raw: string, fallback: string): string {
  const ext = (fallback.match(/\.[^.]+$/) || [''])[0];
  let n = String(raw || '').split(/[\\/]/).pop()!.replace(/[<>:"|?*\u0000-\u001f]/g, '').trim().slice(0, 200);
  if (!n) n = fallback.replace(/(\.[^.]+)?$/, ' (копия)$1');
  if (ext && !n.toLowerCase().endsWith(ext.toLowerCase())) n += ext;
  return n;
}

/** Свободное имя в папке: «Отчёт.docx», «Отчёт (2).docx», … */
export function freeName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  const m = name.match(/^(.*?)(\.[^.]+)?$/)!;
  for (let i = 2; ; i++) {
    const n = `${m[1]} (${i})${m[2] || ''}`;
    if (!taken.has(n.toLowerCase())) return n;
  }
}

export interface FileHome {
  folderId: string | null;
  scope: string;
  ownerId: string | null;
  /** Каталог для filePath: «/shared/…/» — по нему файл ищут старые места */
  dir: string;
  department?: string;
}

/** Куда ляжет файл, если положить его рядом с другим */
export async function homeOfFile(fileId: string): Promise<FileHome | null> {
  const from = await getPrisma().fileNode.findUnique({ where: { id: fileId } });
  if (!from) return null;
  return {
    folderId: from.folderId, scope: from.scope, ownerId: from.ownerId,
    dir: String(from.filePath || '').replace(/[^/]*$/, '') || '/shared/', department: from.department,
  };
}

/** Папка как место для файла */
export async function homeOfFolder(folderId: string): Promise<FileHome | null> {
  const f = await getPrisma().folder.findUnique({ where: { id: folderId } });
  if (!f) return null;
  return { folderId: f.id, scope: f.scope || 'SHARED', ownerId: f.ownerId || null, dir: f.scope === 'PERSONAL' ? '/personal/' : '/shared/' };
}

/** «Выгрузки» на личном столе: заводится при первой выгрузке */
export async function exportsHome(userId: string, projectRaw?: string | null): Promise<FileHome> {
  const prisma = getPrisma();
  const projectId = await resolveProjectId(projectRaw || '');
  const desk = await ensureDeskFolder(projectId, 'PERSONAL', userId);
  let folder = await prisma.folder.findFirst({
    where: { parentId: desk.id, name: EXPORTS_FOLDER, deletedAt: null, scope: 'PERSONAL', ownerId: userId },
  });
  if (!folder) {
    folder = await prisma.folder.create({
      data: { name: EXPORTS_FOLDER, projectId, parentId: desk.id, scope: 'PERSONAL', ownerId: userId },
    });
  }
  return { folderId: folder.id, scope: 'PERSONAL', ownerId: userId, dir: '/personal/' };
}

/** Личный стол сотрудника: сюда ложится «Создать → Документ» со стола */
export async function deskHome(userId: string, shared: boolean, projectRaw?: string | null): Promise<FileHome> {
  const projectId = await resolveProjectId(projectRaw || '');
  const desk = await ensureDeskFolder(projectId, shared ? 'SHARED' : 'PERSONAL', shared ? null : userId);
  return { folderId: desk.id, scope: shared ? 'SHARED' : 'PERSONAL', ownerId: shared ? null : userId, dir: shared ? '/shared/' : '/personal/' };
}

export interface NewFile { id: string; name: string; sha256: string; size: number; folderId: string | null }

/**
 * Новый файл: свободное имя в папке, запись и содержимое кусками — одной
 * транзакцией, чтобы не осталось записи без содержимого
 */
export async function createFileFromBytes(a: {
  name: string; body: Buffer; home: FileHome; userId: string; chunkBytes: number; type?: string; refId?: string | null;
}): Promise<NewFile> {
  const prisma = getPrisma();
  const siblings = await prisma.fileNode.findMany({
    where: { folderId: a.home.folderId, deletedAt: null, scope: a.home.scope, ownerId: a.home.ownerId },
    select: { name: true },
  });
  const name = freeName(cleanName(a.name, a.name), new Set(siblings.map((f: { name: string }) => f.name.toLowerCase())));
  const step = Math.max(64 * 1024, a.chunkBytes);
  const made = await prisma.$transaction(async (tx: any) => {
    const file = await tx.fileNode.create({
      data: {
        name, filePath: a.home.dir + name, size: a.body.length, type: a.type || dbTypeOf(name),
        department: a.home.department || 'Unassigned', scope: a.home.scope, ownerId: a.home.ownerId,
        folderId: a.home.folderId, createdById: a.userId, updatedById: a.userId,
        ...(a.refId ? { refId: a.refId } : {}),
      },
    });
    for (let i = 0, idx = 0; i < a.body.length; i += step, idx++) {
      await tx.fileChunk.create({ data: { fileId: file.id, idx, data: a.body.subarray(i, i + step) } });
    }
    return file;
  }, { timeout: 120_000 });
  return { id: made.id, name: made.name, sha256: sha256(a.body), size: a.body.length, folderId: made.folderId };
}
