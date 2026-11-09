// Файлы-вложения чата: кто что прикрепил, и когда файл можно стирать.
//
// Файл вложения — запись FileNode (type=CHAT_FILE), загруженная заранее через
// /api/chat/upload. Сообщение лишь ссылается на неё путём /chat_files/{id}/{имя}.
// Раньше путь, имя и размер брались из тела запроса как есть: можно было
// «прикрепить» чужой файл по его номеру, а потом удалить своё сообщение и
// стереть чужой файл. Теперь сервер сам решает, что можно прикрепить.
import { AppError } from '../context.js';

/** Предел файла в чате: сам файл лежит строкой в базе, большие уходят в Проводник */
export const CHAT_FILE_MAX_BYTES = 25 * 1024 * 1024;
/** Вложений в одном сообщении */
export const CHAT_ATTACHMENTS_MAX = 20;
/** Сколько загруженный, но не отправленный файл ждёт, прежде чем считаться сиротой */
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

const NODE_PATH = /^\/chat_files\/([^/?#]+)\/[^/?#]+$/;

/** Путь файла в узле: у кого он загружен, чтобы прикрепить мог только он */
export const uploaderPath = (userId: string, base: string) => `/chat/${userId}/${base}`;

export const nodeOfPath = (filePath: string): string => (String(filePath || '').match(/^\/chat_files\/([^/]+)\//) || [])[1] || '';

/**
 * Вложения нового сообщения из тела запроса → записи для создания.
 *
 * Принимается только файл, загруженный этим же пользователем и ещё не
 * прикреплённый к другому сообщению. Имя и размер берутся из узла, а не от клиента.
 */
export async function resolveNewAttachments(prisma: any, actor: string, raw: unknown): Promise<Array<{ fileName: string; filePath: string; fileSize: number }>> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new AppError(400, 'Вложения должны быть списком');
  if (raw.length > CHAT_ATTACHMENTS_MAX) throw new AppError(400, `В сообщении не больше ${CHAT_ATTACHMENTS_MAX} вложений`);
  const out: Array<{ fileName: string; filePath: string; fileSize: number }> = [];
  const seen = new Set<string>();
  for (const att of raw as any[]) {
    const id = (String(att?.filePath || '').match(NODE_PATH) || [])[1];
    if (!id) throw new AppError(400, 'Вложение не найдено: загрузите файл заново');
    if (seen.has(id)) throw new AppError(400, 'Один и тот же файл прикреплён дважды');
    seen.add(id);
    const node = await prisma.fileNode.findUnique({ where: { id }, select: { id: true, name: true, size: true, type: true, filePath: true } });
    // Чужой и несуществующий файл неотличимы: номер файла не подтверждаем
    // Уже стёртый уборкой или загруженный старой версией: прикрепить нечего, надо загрузить заново
    if (!node || node.type !== 'CHAT_FILE') throw new AppError(404, 'Файл не найден или устарел: загрузите его заново');
    if (!String(node.filePath || '').startsWith(`/chat/${actor}/`)) {
      // `/chat/<имя>` без владельца — загрузка прежней версии: прикрепить её уже нельзя
      if (String(node.filePath || '').split('/').length === 3) throw new AppError(404, 'Файл устарел: загрузите его заново');
      throw new AppError(403, 'Прикрепить можно только файл, который вы сами загрузили в чат');
    }
    if (await prisma.chatAttachment.count({ where: { filePath: { startsWith: `/chat_files/${id}/` } } })) {
      throw new AppError(409, 'Этот файл уже прикреплён к другому сообщению: загрузите его заново');
    }
    out.push({ fileName: node.name, filePath: `/chat_files/${node.id}/${encodeURIComponent(node.name)}`, fileSize: Number(node.size || 0) });
  }
  return out;
}

/**
 * Стереть файлы, на которые после удаления сообщений больше никто не ссылается.
 * Вызывать ПОСЛЕ удаления сообщений: пересланные копии держат тот же файл.
 * Возвращает, сколько файлов стёрто.
 */
export async function releaseChatFiles(prisma: any, filePaths: string[]): Promise<number> {
  const ids = [...new Set(filePaths.map(nodeOfPath).filter(Boolean))];
  let removed = 0;
  for (const id of ids) {
    const still = await prisma.chatAttachment.count({ where: { filePath: { startsWith: `/chat_files/${id}/` } } });
    if (still) continue;
    const r = await prisma.fileNode.deleteMany({ where: { id, type: 'CHAT_FILE' } });
    removed += r.count;
  }
  return removed;
}

/**
 * Уборка сирот: файлы чата, загруженные давно, но ни к одному сообщению не
 * прикреплённые (загрузили и передумали, сообщение ушло в очистку и т. п.).
 * Ограничена: просматривает не больше `scan` узлов и стирает не больше `limit`;
 * на что есть ссылка — не трогает. Каждое удаление пишет в журнал.
 */
export async function cleanOrphanChatFiles(prisma: any, opts: { now?: number; limit?: number; scan?: number; log?: (m: string) => void } = {}): Promise<{ scanned: number; removed: number }> {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? 200;
  const scan = opts.scan ?? 2000;
  const log = opts.log ?? ((m: string) => console.log(m));
  const before = new Date(now - ORPHAN_GRACE_MS);
  let scanned = 0;
  let removed = 0;
  // Проход продолжается с того места, где остановился прошлый: иначе первые
  // `scan` прикреплённых файлов заслоняли бы собой сирот в хвосте списка
  let cursor = sweepState.cursor;
  let wrapped = false;
  while (scanned < scan && removed < limit) {
    const page = await prisma.fileNode.findMany({
      where: { type: 'CHAT_FILE', createdAt: { lt: before }, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true, name: true, size: true, createdAt: true },
      orderBy: { id: 'asc' },
      take: 200,
    });
    if (!page.length) { cursor = ''; wrapped = true; break; }
    for (const n of page) {
      if (scanned >= scan || removed >= limit) break;
      scanned++;
      cursor = n.id;
      const refs = await prisma.chatAttachment.count({ where: { filePath: { startsWith: `/chat_files/${n.id}/` } } });
      if (refs) continue;
      const r = await prisma.fileNode.deleteMany({ where: { id: n.id, type: 'CHAT_FILE' } });
      if (r.count) {
        removed++;
        log(`[Чат] удалён файл-сирота ${n.id} «${n.name}», ${n.size} байт, загружен ${n.createdAt?.toISOString?.() || ''}`);
      }
    }
  }
  sweepState.cursor = wrapped ? '' : cursor;
  return { scanned, removed };
}

/** Где остановилась уборка; в памяти процесса: после перезапуска идёт с начала */
const sweepState = { cursor: '' };
export const resetSweepCursor = () => { sweepState.cursor = ''; };

/** Предел длины текста одного сообщения */
export const CHAT_TEXT_MAX = 20000;

/**
 * Текст сообщения: не длиннее предела и не пустой, если к нему нечего больше
 * приложить (вложение, тег, ссылка на проект, вопрос Guide).
 */
export function checkMessageText(content: unknown, hasOtherPayload: boolean): string {
  const text = String(content ?? '');
  if (text.length > CHAT_TEXT_MAX) throw new AppError(400, `Сообщение длиннее ${CHAT_TEXT_MAX} знаков`);
  if (!text.trim() && !hasOtherPayload) throw new AppError(400, 'Пустое сообщение: напишите текст или приложите файл');
  return text;
}
