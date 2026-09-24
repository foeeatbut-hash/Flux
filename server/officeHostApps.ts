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
import { fileBytes } from './routes/fileChunks.js';
import { writeOfficeFile } from './routes/officeFiles.js';

export type HostApp = 'pdf' | 'sheets';

interface Host {
  start: (resources: string) => void;
  open: (path: string) => number;
  invoke: (id: number, channel: string, args: unknown[]) => Promise<any>;
  send: (id: number, channel: string, args: unknown[]) => void;
  onSend: (fn: (id: number, channel: string, args: unknown[]) => void) => void;
  close: (id: number) => void;
}

interface Session {
  app: HostApp; fileId: string; socketId: string; userId: string;
  dir: string; path: string; sha: string;
}

/** Вызовы, которые окно может сделать. Остальное — отказ */
const ALLOWED: Record<HostApp, (channel: string) => boolean> = {
  pdf: (c) => c.startsWith('pdf:') && ![
    'pdf:generate-image', 'pdf:ocr-page', 'pdf:create-document', 'pdf:convert-office', 'pdf:request-redaction-copy',
  ].includes(c),
  sheets: (c) => /^(sheets|workbook|xlsx):/.test(c) || c === 'app:get-language',
};

/** Какой вызов записывает файл — после него байты уходят в Flux */
const SAVES: Record<HostApp, (channel: string) => boolean> = {
  pdf: (c) => c === 'pdf:save',
  sheets: (c) => /save/i.test(c) && !/transfer|chunk|abort|recovery/i.test(c),
};

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const hosts = new Map<HostApp, Host>();
const sessions = new Map<number, Session>();
let io: Server | null = null;

/** Где лежат серверные сборки редакторов: рядом с программой или в ресурсах */
export function hostDir(): string {
  const candidates = [
    process.env.FLUX_GENOFFICE_SERVER,
    (process as any).resourcesPath && join((process as any).resourcesPath, 'genoffice-server'),
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
      if (!file) return reply({ error: 'Файл не найден' });
      const h = host(app);
      const bytes = await fileBytes(file);
      const dir = await mkdtemp(join(tmpdir(), 'flux-office-'));
      const path = join(dir, safeName(file.name));
      await writeFile(path, bytes);
      const id = h.open(path);
      sessions.set(id, { app, fileId: file.id, socketId: socket.id, userId: userId(), dir, path, sha: sha256(bytes) });
      mine.add(id);
      reply({ session: id, name: file.name, path });
    } catch (err: any) {
      reply({ error: String(err?.message || err) });
    }
  });

  socket.on('office:ipc', async ({ session, channel, args }: { session: number; channel: string; args: unknown[] }, ack?: (r: any) => void) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const s = sessions.get(Number(session));
    if (!s || s.socketId !== socket.id) return reply({ error: 'Окно редактора не открыто' });
    const ch = String(channel || '');
    if (!ALLOWED[s.app](ch)) return reply({ error: 'Во Flux Office это отключено' });
    try {
      const result = await host(s.app).invoke(Number(session), ch, Array.isArray(args) ? args : []);
      if (SAVES[s.app](ch) && result && result.ok !== false && !result.canceled) {
        // Записано во временный файл — теперь в файл Flux, с его правилами
        const bytes = await readFile(s.path);
        const user = await deps.getAuthUser(s.userId);
        const w = await writeOfficeFile({ fileId: s.fileId, body: bytes, baseSha: s.sha, user });
        if (w.status !== 200) {
          return reply({ result: { ...(typeof result === 'object' ? result : {}), ok: false, error: String(w.json?.error || `сервер ответил ${w.status}`) } });
        }
        s.sha = w.json.sha256;
        if (!w.json.unchanged) socket.to(`office:${s.fileId}`).emit('office:saved', { fileId: s.fileId, sha256: s.sha });
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
