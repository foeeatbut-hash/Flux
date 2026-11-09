/**
 * Сквозной канал подпрограммы к внешней программе (этап 3б) — главный процесс.
 *
 * Порядок на каждый вызов, и решает его только этот файл, а не окно:
 * 1. по проверенному выпуску (подпись владельца, кэш) берётся манифест — слова
 *    подпрограммы и окна о том, что ей разрешено, в расчёт не идут;
 * 2. подключение должно быть объявлено в манифесте, вид вызова — соответствовать
 *    виду объявления;
 * 3. политика администратора и решение человека (electron/moduleGrants.ts):
 *    запрещено — отказ, не решено — окну возвращается вопрос, а не канал;
 * 4. пределы: частота, одновременные вызовы, открытые подключения;
 * 5. сам вызов как есть: HTTP/WebSocket — на проверенный адрес объявленного
 *    сервера (electron/moduleNet.ts), COM — через помощник (moduleCom.ts);
 * 6. запись в журнал: только метаданные, содержимого вызова в нём нет.
 */
import { validMessage } from '../modules/schemas';
import {
  CONNECTION_LIMITS, ConnectError, connectionsOf, describeConnection, grantKey, kindOfOp,
  type ConnectCall, type ConnectErrorCode, type ConnectReply, type ConnectionDecl, type NetConnection,
} from '../modules/connections/model';
import type { ModuleManifest } from '../modules/contract';
import type { ModuleJournal } from './moduleJournal';
import type { ModuleGrants } from './moduleGrants';
import type { ComBackend } from './moduleCom';
import { WsSession, httpCall, systemLookup, type Lookup } from './moduleNet';

export interface VerifiedModule { manifest: ModuleManifest; version: string; author: string; verifiedAt: number }
export interface ConnectRequest { moduleId: string; version: string; session: string; connection: string; call: unknown }
export interface ConnectionDeps {
  /** Проверенный выпуск установленной подпрограммы; null — такого нет или он не запускается */
  resolve: (moduleId: string, version: string) => Promise<VerifiedModule | null>;
  userId: () => string;
  grants: ModuleGrants;
  journal: ModuleJournal;
  com: ComBackend;
  lookup?: Lookup;
  now?: () => number;
}

interface Slot { windowAt: number; calls: number; inFlight: number; open: number }
interface Session { moduleId: string; sockets: Map<string, WsSession>; handles: Map<string, Set<number>>; roots: Map<string, Set<number>> }

const OUTCOME: Record<ConnectErrorCode, string> = {
  DENIED: 'denied', NOT_ALLOWED: 'user-denied', LIMIT: 'limit', TIMEOUT: 'timeout', TARGET: 'target', UNAVAILABLE: 'unavailable', FAILED: 'failed',
};

/** Метка вызова для журнала: без путей с данными и без аргументов */
function labelOf(decl: ConnectionDecl, call: ConnectCall): string {
  if (call.op === 'http' && decl.kind === 'http') return `${call.method} ${decl.pathPrefix}`;
  if (call.op === 'com-call' || call.op === 'com-get' || call.op === 'com-set') return `${call.op.slice(4)} ${call.name}`;
  return call.op;
}

function walk(value: unknown, visit: (handle: number) => void, depth = 0) {
  if (depth > 8 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) walk(item, visit, depth + 1); return; }
  const handle = (value as { $com?: unknown }).$com;
  if (typeof handle === 'number') visit(handle);
  for (const item of Object.values(value)) walk(item, visit, depth + 1);
}

export class ModuleConnections {
  private slots = new Map<string, Slot>();
  private sessions = new Map<string, Session>();
  private counter = 0;
  private now: () => number;
  private lookup: Lookup;
  constructor(private deps: ConnectionDeps) {
    this.now = deps.now ?? Date.now;
    this.lookup = deps.lookup ?? systemLookup;
  }

  private slot(moduleId: string): Slot {
    let s = this.slots.get(moduleId);
    if (!s) { s = { windowAt: 0, calls: 0, inFlight: 0, open: 0 }; this.slots.set(moduleId, s); }
    return s;
  }
  private session(owner: string, session: string, moduleId: string): Session {
    const key = `${owner}:${session}`;
    let s = this.sessions.get(key);
    if (!s) { s = { moduleId, sockets: new Map(), handles: new Map(), roots: new Map() }; this.sessions.set(key, s); }
    return s;
  }

  async call(owner: string, request: ConnectRequest): Promise<ConnectReply> {
    const started = this.now();
    const user = this.deps.userId();
    const record = (decl: ConnectionDecl | null, version: string, label: string, outcome: string, io: { inn?: number; out?: number } = {}, level: 'info' | 'warn' | 'error' = 'info') => {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(request.moduleId) || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version)) return;
      this.deps.journal.add({
        moduleId: request.moduleId, version, userId: user, category: 'connection', level, event: 'call',
        // К чему: понятное имя объявленного подключения и метка вызова; адрес и аргументы — только объявленное, не вызов
        detail: `${decl ? describeConnection(decl) : String(request.connection).slice(0, 40)} · ${label}`, outcome,
        ms: this.now() - started, bytesIn: io.inn || 0, bytesOut: io.out || 0,
      });
    };
    const refuse = (code: ConnectErrorCode, decl: ConnectionDecl | null, version: string, label: string): ConnectReply => {
      record(decl, version, label, OUTCOME[code], {}, code === 'NOT_ALLOWED' ? 'info' : 'warn');
      return { ok: false, code };
    };
    // Форма вызова проверяется той же схемой, что в мосте: окно могло ошибиться, главный процесс доверия не даёт
    const envelope = { flux: 'module', v: 1, session: String(request.session), id: 'main', type: 'connect', connection: request.connection, call: request.call };
    if (!validMessage('connect', envelope)) return refuse('DENIED', null, String(request.version), 'bad-call');
    const call = request.call as ConnectCall;
    const verified = await this.deps.resolve(request.moduleId, request.version);
    if (!verified) return refuse('DENIED', null, String(request.version), 'unknown-module');
    const decl = connectionsOf(verified.manifest).find(c => c.id === request.connection) || null;
    if (!decl || decl.kind !== kindOfOp(call.op)) return refuse('DENIED', decl, verified.version, labelOf(decl || { kind: 'com', id: '', app: '', does: '', access: 'read', progId: '' }, call));
    const label = labelOf(decl, call);

    // Освобождение и закрытие нужны и после отказа в разрешении: ресурсы, открытые раньше, закрываются всегда
    const closing = call.op === 'ws-close' || call.op === 'com-release';
    if (!closing) {
      const spec = grantKey(decl);
      const state = this.deps.grants.state(user, request.moduleId, decl.id, spec, `${owner}:${request.session}`);
      if (state === 'denied') return refuse('NOT_ALLOWED', decl, verified.version, label);
      if (state === 'ask') {
        // Вопрос человеку показывает окно Flux; канал не открывается, пока решение не записано
        const ask = { moduleId: request.moduleId, moduleName: verified.manifest.name, version: verified.version, connection: decl.id, app: decl.app, does: decl.does,
          access: decl.access, technical: describeConnection(decl), author: verified.manifest.author, verifiedAt: verified.verifiedAt, kind: decl.kind };
        return { ok: false, code: 'ASK', ask };
      }
    }

    const slot = this.slot(request.moduleId), now = this.now();
    if (now - slot.windowAt >= 1000) { slot.windowAt = now; slot.calls = 0; }
    if (++slot.calls > CONNECTION_LIMITS.callsPerSecond || slot.inFlight >= CONNECTION_LIMITS.inFlight) return refuse('LIMIT', decl, verified.version, label);
    slot.inFlight++;
    try {
      const done = await this.run(owner, request, decl, call, slot);
      record(decl, verified.version, label, 'ok', done.io);
      return { ok: true, data: done.data };
    } catch (error) {
      const code = error instanceof ConnectError ? error.code : 'FAILED';
      return refuse(code, decl, verified.version, label);
    } finally { slot.inFlight--; }
  }

  private async run(owner: string, request: ConnectRequest, decl: ConnectionDecl, call: ConnectCall, slot: Slot): Promise<{ data: unknown; io: { inn?: number; out?: number } }> {
    const session = this.session(owner, request.session, request.moduleId);
    const limit = <T>(work: Promise<T>) => Promise.race([work, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new ConnectError('TIMEOUT')), CONNECTION_LIMITS.callMs + 1000);
      timer.unref?.();
    })]);
    switch (call.op) {
      case 'http': {
        const result = await httpCall(decl as NetConnection, call, this.lookup);
        return { data: result.value, io: { inn: result.inn, out: result.out } };
      }
      case 'ws-open': {
        if (slot.open >= CONNECTION_LIMITS.open) throw new ConnectError('LIMIT', 'open');
        slot.open++;
        try {
          const socket = await WsSession.open(decl as NetConnection, call.path, this.lookup);
          const id = `s${++this.counter}`;
          session.sockets.set(`${decl.id}:${id}`, socket);
          return { data: { socket: id }, io: {} };
        } catch (error) { slot.open--; throw error; }
      }
      case 'ws-send': case 'ws-recv': case 'ws-close': {
        const key = `${decl.id}:${call.socket}`, socket = session.sockets.get(key);
        if (!socket) throw new ConnectError('FAILED', 'no socket');
        if (call.op === 'ws-send') return { data: {}, io: { out: socket.send(call.data, call.encoding) } };
        if (call.op === 'ws-close') { socket.close(); session.sockets.delete(key); slot.open = Math.max(0, slot.open - 1); return { data: {}, io: {} }; }
        const before = socket.bytesIn;
        const reply = await socket.recv(call.timeoutMs ?? 0);
        return { data: reply, io: { inn: socket.bytesIn - before } };
      }
      default: return this.com(session, decl, call, slot, limit);
    }
  }

  private async com(session: Session, decl: ConnectionDecl, call: Extract<ConnectCall, { op: `com-${string}` }>, slot: Slot, limit: <T>(w: Promise<T>) => Promise<T>) {
    if (decl.kind !== 'com') throw new ConnectError('DENIED');
    if (!this.deps.com.available()) throw new ConnectError('UNAVAILABLE', 'no com');
    const owned = session.handles.get(decl.id) || new Set<number>();
    session.handles.set(decl.id, owned);
    const roots = session.roots.get(decl.id) || new Set<number>();
    session.roots.set(decl.id, roots);
    if (call.op === 'com-open') {
      if (slot.open >= CONNECTION_LIMITS.open) throw new ConnectError('LIMIT', 'open');
      slot.open++;
      try {
        const handle = await limit(this.deps.com.open(decl.progId));
        owned.add(handle); roots.add(handle);
        return { data: { handle }, io: {} };
      } catch (error) { slot.open--; throw error; }
    }
    // Объект COM можно использовать только свой: номер чужого или выдуманного — отказ
    if (!owned.has(call.handle)) throw new ConnectError('DENIED', 'handle');
    if (call.op === 'com-release') {
      await this.deps.com.release(call.handle);
      owned.delete(call.handle);
      if (roots.delete(call.handle)) slot.open = Math.max(0, slot.open - 1);
      return { data: {}, io: {} };
    }
    const args = call.args || [];
    for (const value of [...args, call.op === 'com-set' ? call.value : null]) walk(value, handle => { if (!owned.has(handle)) throw new ConnectError('DENIED', 'handle'); });
    const kind = call.op === 'com-call' ? 'call' : call.op === 'com-get' ? 'get' : 'set';
    const value = await limit(this.deps.com.invoke(call.handle, kind, call.name, args, call.op === 'com-set' ? call.value : undefined));
    let tooMany = false;
    walk(value, handle => {
      if (owned.size >= CONNECTION_LIMITS.comHandles) tooMany = true; else owned.add(handle);
    });
    if (tooMany) throw new ConnectError('LIMIT', 'handles');
    return { data: call.op === 'com-set' ? {} : { value }, io: { inn: JSON.stringify(value ?? null).length, out: JSON.stringify(args).length } };
  }

  /** Окно подпрограммы закрыто: сокеты и COM-объекты, которые она оставила, закрываются здесь */
  async closeSession(owner: string, session: string) {
    const key = `${owner}:${session}`, s = this.sessions.get(key);
    this.deps.grants.endSession(key);
    if (!s) return;
    this.sessions.delete(key);
    for (const socket of s.sockets.values()) socket.close();
    for (const set of s.handles.values()) for (const handle of set) await this.deps.com.release(handle).catch(() => {});
    // Места открытых подключений этого окна возвращаются подпрограмме
    const freed = s.sockets.size + [...s.roots.values()].reduce((n, set) => n + set.size, 0);
    const slot = this.slots.get(s.moduleId);
    if (slot && freed) slot.open = Math.max(0, slot.open - freed);
  }

  async closeOwner(owner: string) {
    for (const key of [...this.sessions.keys()]) if (key.startsWith(`${owner}:`)) await this.closeSession(owner, key.slice(owner.length + 1));
  }

  async shutdown() {
    for (const key of [...this.sessions.keys()]) { const [owner, ...rest] = key.split(':'); await this.closeSession(owner, rest.join(':')); }
    await this.deps.com.shutdown().catch(() => {});
  }
}
