/**
 * Главные процессы редакторов Flux Office на сервере: PDF и Таблица.
 *
 * Их интерфейс живёт во фрейме окна Flux, а всё, что в Electron делал
 * главный процесс (читать и писать файл, страницы, шрифты, движок Excel),
 * делает здесь родной код GenOffice, собранный для сервера
 * (tools/genoffice/build.mjs → genoffice-server/<редактор>.cjs).
 *
 * Для каждого окна Flux:
 *   - файл Проводника кладётся во временный каталог, и родной главный
 *     процесс открывает над ним «окно»;
 *   - вызовы окна (ipcRenderer.invoke) приходят сюда по сокету и уходят
 *     родным обработчикам — только из белого списка: ИИ, вход Genspark,
 *     веб-поиск, захват экрана и чужие пути сюда не доходят;
 *   - после сохранения байты с временного диска пишутся в файл Flux общим
 *     ядром (routes/officeFiles.ts: право, держатель, сверка хеша, откат).
 *
 * Временный каталог убирается, когда окно закрывается или пропадает связь.
 */
import type { Server, Socket } from 'socket.io';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getPrisma } from './context.js';
import { canReadFile } from './fileAccess.js';
import { fileBytes } from './routes/fileChunks.js';
import { writeOfficeFile, isCollaborativeFile, copyOfficeFile } from './routes/officeFiles.js';
import { shareOf } from './fileSharing.js';
import { sheetShared } from './officeSheetCollab.js';
import { officeBus } from './officeBus.js';
import { officeHub } from './officeRooms.js';

export type HostApp = 'pdf' | 'sheets';

interface Host {
  start: (resources: string) => void;
  requestCopy?: (id: number, target: string) => Promise<boolean>;
  open: (path: string) => number;
  invoke: (id: number, channel: string, args: unknown[], saveTarget?: string) => Promise<any>;
  send: (id: number, channel: string, args: unknown[]) => void;
  onSend: (fn: (id: number, channel: string, args: unknown[]) => void) => void;
  close: (id: number) => void;
}

interface Session {
  app: HostApp; fileId: string; socketId: string; userId: string;
  dir: string; path: string; sha: string;
  /** Общая книга: правят все сразу (server/officeSheetCollab.ts) */
  collab: boolean;
  /** Какой сеанс общей книги открыт: после сброса сеанса запись сверяется по-старому */
  key: string;
  copy?: { path: string; name: string; made?: any };
}

/** Вызовы, которые окно может сделать. Остальное — отказ */
const ALLOWED: Record<HostApp, (channel: string) => boolean> = {
  pdf: (c) => c.startsWith('pdf:') && ![
    'pdf:generate-image', 'pdf:ocr-page', 'pdf:create-document', 'pdf:convert-office', 'pdf:request-redaction-copy',
  ].includes(c),
  // Книга — да; ИИ, MCP, захват экрана, чужие файлы, печать через Electron — нет
  sheets: (c) => (c.startsWith('workbook:') && !['workbook:create-document', 'workbook:export-pdf', 'workbook:print'].includes(c))
    || ['sheets:consume-new-blank', 'sheets:has-queued-workbook', 'sheets:consume-headless-export'].includes(c),
};

/** Какой вызов записывает файл — после него байты уходят в Flux */
const SAVES: Record<HostApp, (channel: string) => boolean> = {
  pdf: (c) => c === 'pdf:save',
  sheets: (c) => c === 'workbook:save',
};

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const hosts = new Map<HostApp, Host>();
const sessions = new Map<number, Session>();
export function officeHostFileId(socketId: string, session: unknown): string {
  const s = sessions.get(Number(session));
  return s?.socketId === socketId ? s.fileId : '';
}
let io: Server | null = null;

/** Где лежат серверные сборки редакторов: рядом с программой или в ресурсах */
export function hostDir(): string {
  const candidates = [
    process.env.FLUX_GENOFFICE_SERVER,
    ((process as any).resourcesPath || process.env.FLUX_RESOURCES_PATH) && join((process as any).resourcesPath || process.env.FLUX_RESOURCES_PATH, 'genoffice-server'),
    join(process.cwd(), 'genoffice-server'),
    join(__dirname_safe(), '..', 'genoffice-server'),
  ].filter(Boolean) as string[];
  return candidates.find((d) => existsSync(d)) || candidates[candidates.length - 1];
}
function __dirname_safe(): string {
  try { return typeof __dirname === 'string' ? __dirname : process.cwd(); } catch { return process.cwd(); }
}

function host(app: HostApp): Host {
  const have = hosts.get(app);
  if (have) return have;
  const dir = hostDir();
  const file = join(dir, `${app}.cjs`);
  if (!existsSync(file)) throw new Error(`Редактор «${app}» не установлен в этой сборке`);
  const h = createRequire(join(dir, 'package.json'))(file) as Host;
  h.start(dir);
  // Сообщения главного процесса окну — по сокету его владельцу
  h.onSend((id, channel, args) => {
    const s = sessions.get(id);
    if (s && io) io.to(s.socketId).emit('office:ipc-event', { session: id, channel, args });
  });
  hosts.set(app, h);
  return h;
}

const safeName = (name: string) => (name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 180);

async function closeSession(id: number): Promise<void> {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try { hosts.get(s.app)?.close(id); } catch (_) {}
  await rm(s.dir, { recursive: true, force: true }).catch(() => {});
}

export interface HostAppsDeps {
  getAuthUser: (id: string) => Promise<any>;
}

/** Подписать одно соединение. Зовётся из connection (server/officeSockets.ts) */
export function setupOfficeHostApps(server: Server, socket: Socket, deps: HostAppsDeps): { gone: () => void } {
  io = server;
  const mine = new Set<number>();
  const userId = () => String((socket as any).userId || '');

  socket.on('office:host-open', async ({ app, fileId }: { app: HostApp; fileId: string }, ack?: (r: any) => void) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      if (app !== 'pdf' && app !== 'sheets') return reply({ error: 'Неизвестный редактор' });
      if (!userId()) return reply({ error: 'Требуется вход в систему' });
      const file = await getPrisma().fileNode.findUnique({ where: { id: String(fileId || '') } });
      // Файл берётся по номеру из сокета: без проверки чужой личный документ
      // открывался в главном процессе редактора и отдавал своё содержимое.
      // Отказ — тот же ответ, что и «нет файла»
      if (!file || !(await canReadFile(getPrisma(), await deps.getAuthUser(userId()), file))) return reply({ error: 'Файл не найден' });
      const h = host(app);
      // Общая книга открывается с исходника сеанса: у всех участников одно и
      // то же начало, свежее — в журнале правок сеанса
      const collab = app === 'sheets' && await isCollaborativeFile(file);
      const book = collab ? await sheetShared.open(file.id, () => fileBytes(file)) : null;
      const bytes = book ? (book.baseData as Buffer) : await fileBytes(file);
      const dir = await mkdtemp(join(tmpdir(), 'flux-office-'));
      const path = join(dir, safeName(file.name));
      await writeFile(path, bytes);
      const id = h.open(path);
      sessions.set(id, { app, fileId: file.id, socketId: socket.id, userId: userId(), dir, path, sha: sha256(bytes), collab, key: book?.key || '' });
      mine.add(id);
      reply({ session: id, name: file.name, path, ...(book ? { collab: { key: book.key } } : {}) });
    } catch (err: any) {
      reply({ error: String(err?.message || err) });
    }
  });

  socket.on('office:save-copy', async ({ session, name }: { session: number; name: string }, ack?: (r: any) => void) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const s = sessions.get(Number(session));
    if (!s || s.socketId !== socket.id || s.app !== 'pdf') return reply({ error: 'Окно PDF не открыто' });
    if (s.copy) return reply({ error: 'Копия уже сохраняется' });
    s.copy = { path: join(s.dir, `copy-${Date.now()}.pdf`), name: safeName(String(name || 'Копия.pdf')) };
    try {
      const currentUser = await deps.getAuthUser(s.userId);
      if (!(await canReadFile(getPrisma(), currentUser, s.fileId))) return reply({ error: 'Доступ к файлу отозван' });
      const ok = await host(s.app).requestCopy?.(Number(session), s.copy.path);
      reply(ok && s.copy.made ? { copy: s.copy.made } : { error: 'Копия PDF не сохранена. Правки остаются в исходном окне' });
    } catch (_) { reply({ error: 'Не удалось сохранить копию PDF' }); }
    finally { const path = s.copy?.path; s.copy = undefined; if (path) await rm(path, { force: true }).catch(() => {}); }
  });

  socket.on('office:ipc', async ({ session, channel, args, auto, copyName }: { session: number; channel: string; args: unknown[]; auto?: boolean; copyName?: string }, ack?: (r: any) => void) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const s = sessions.get(Number(session));
    if (!s || s.socketId !== socket.id) return reply({ error: 'Окно редактора не открыто' });
    const ch = String(channel || '');
    if (!ALLOWED[s.app](ch)) return reply({ error: 'Во Flux Office это отключено' });
    try {
      const currentUser = await deps.getAuthUser(s.userId);
      if (!(await canReadFile(getPrisma(), currentUser, s.fileId))) return reply({ error: 'Доступ к файлу отозван' });
      const accessAtStart = await shareOf(getPrisma(), s.fileId);
      // Что из журнала общей книги окно уже включило в эту запись: номер до записи,
      // а не после — правка, пришедшая во время записи, в файл не попадёт
      const seqAtSave = s.collab && SAVES[s.app](ch) ? ((await officeBus.session(s.fileId))?.dataSeq ?? 0) : 0;
      const isSheetCopy = s.app === 'sheets' && ch === 'workbook:save' && (args?.[0] as any)?.mode === 'save-as';
      if (isSheetCopy && !copyName) return reply({ result: { canceled: true } });
      const copyTarget = isSheetCopy ? join(s.dir, `copy-${Date.now()}${/\.xlsm$/i.test(s.path) ? '.xlsm' : '.xlsx'}`) : undefined;
      const result = await host(s.app).invoke(Number(session), ch, Array.isArray(args) ? args : [], copyTarget);
      if (SAVES[s.app](ch) && result && result.ok !== false && (!result.canceled || result.fluxCopySaved) &&
          (isSheetCopy || (s.app === 'pdf' && s.copy && (args?.[0] as any)?.targetPath === s.copy.path))) {
        const target = copyTarget || s.copy!.path;
        const made = await copyOfficeFile({ fileId: s.fileId, body: await readFile(target), name: copyName || s.copy!.name,
          user: await deps.getAuthUser(s.userId) });
        if (isSheetCopy) {
          // Движок сохранил копию без смены сессии. «Отменено» оставляет
          // исходные правки в редакторе для обычного сохранения.
          return reply({ result: { canceled: true }, copy: made });
        }
        s.copy!.made = made;
        return reply({ result });
      }
      if (SAVES[s.app](ch) && result && result.ok !== false && !result.canceled) {
        // Записано во временный файл — теперь в файл Flux, с его правилами
        const bytes = await readFile(s.path);
        const user = await deps.getAuthUser(s.userId);
        // Общая книга: в файле уже записанное другими держателями — сверка с
        // последней записью сеанса из общей базы, а не с тем, что было у этого
        // окна при открытии (в отделе прежний держатель мог быть на другом сервере)
        const book = s.collab ? await officeBus.session(s.fileId) : null;
        const shared = !!book && book.key === s.key;
        let w = await writeOfficeFile({ fileId: s.fileId, body: bytes, baseSha: shared ? book!.savedSha : s.sha, user, autosave: auto, sessionKey: s.key, shareEpoch: accessAtStart ? Number(accessAtStart.epoch) : undefined });
        // Держатель успел смениться между «взял слово» и записью, и файл уже записал прежний. Содержимое
        // общее — в нём есть всё записанное, — поэтому сверяемся заново, но только если файл
        // менял именно сеанс (хеш совпал с записанным в базе), а не кто-то в обход него
        if (w.status === 409 && shared && w.json?.currentSha256) {
          const now = await officeBus.session(s.fileId);
          if (now && now.key === s.key && now.savedSha === w.json.currentSha256) {
            w = await writeOfficeFile({ fileId: s.fileId, body: bytes, baseSha: now.savedSha, user, autosave: auto, sessionKey: s.key, shareEpoch: accessAtStart ? Number(accessAtStart.epoch) : undefined });
          }
        }
        // Правку держит другой (список успел устареть): записывает он, а мы просим его
        if (w.status === 423 && shared) {
          await officeHub.requestSave(s.fileId, socket.id).catch(() => false);
          // «Отменено», а не ошибка: редактор не считает правки записанными и не пугает человека
          return reply({ result: { canceled: true } });
        }
        if (w.status !== 200) {
          return reply({ result: { ...(typeof result === 'object' ? result : {}), ok: false, error: String(w.json?.error || `сервер ответил ${w.status}`) } });
        }
        s.sha = w.json.sha256;
        if (shared) await sheetShared.markSaved(s.fileId, s.sha, seqAtSave);
        if (!w.json.unchanged) await officeHub.announceSaved(s.fileId, s.sha, socket.id).catch(() => undefined);
        socket.emit('office:saved-self', { fileId: s.fileId, sha256: s.sha });
      }
      reply({ result });
    } catch (err: any) {
      reply({ error: String(err?.message || err) });
    }
  });

  socket.on('office:ipc-send', ({ session, channel, args }: { session: number; channel: string; args: unknown[] }) => {
    const s = sessions.get(Number(session));
    if (!s || s.socketId !== socket.id) return;
    const ch = String(channel || '');
    if (!ALLOWED[s.app](ch)) return;
    try { host(s.app).send(Number(session), ch, Array.isArray(args) ? args : []); } catch (_) {}
  });

  socket.on('office:host-close', ({ session }: { session: number }) => {
    const id = Number(session);
    if (sessions.get(id)?.socketId !== socket.id) return;
    mine.delete(id);
    void closeSession(id);
  });

  return { gone: () => { for (const id of mine) void closeSession(id); mine.clear(); } };
}

/** Проверкам: сколько окон открыто сейчас */
export const openSessions = (): number => sessions.size;

/**
 * Одна правка файла родным главным процессом, без окна редактора: файл — во
 * временный каталог, вызов, байты обратно. Так прежние замечания Просмотра
 * переносятся в PDF тем же кодом, каким редактор пишет свои пометки
 */
export async function transformWithHost(app: HostApp, bytes: Buffer, name: string, channel: string, args: (path: string) => unknown[]): Promise<Buffer> {
  const h = host(app);
  const dir = await mkdtemp(join(tmpdir(), 'flux-office-'));
  const path = join(dir, safeName(name));
  let id = 0;
  try {
    await writeFile(path, bytes);
    id = h.open(path);
    const result = await h.invoke(id, channel, args(path));
    if (result && typeof result === 'object' && (result.ok === false || result.canceled)) {
      throw new Error(String(result.error || 'Редактор не записал файл'));
    }
    return await readFile(path);
  } finally {
    if (id) { try { h.close(id); } catch (_) {} }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
