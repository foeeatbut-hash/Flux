/**
 * Сквозной канал программы к внешней программе (этап 3б) — главный процесс.
 *
 * Порядок на каждый вызов, и решает его только этот файл, а не окно:
 * 1. по проверенному выпуску (подпись владельца, кэш) берётся манифест — слова
 *    программы и окна о том, что ей разрешено, в расчёт не идут;
 * 2. подключение должно быть объявлено в манифесте (для COM — белый список ProgID,
 *    опасные объекты только с флагом владельца), вид вызова — соответствовать объявлению;
 * 3. политика администратора и решение человека (electron/moduleGrants.ts):
 *    запрещено — отказ, не решено — окну возвращается вопрос, а не канал;
 * 4. пределы: частота, одновременные вызовы, открытые подключения, размеры;
 * 5. сам вызов как есть: HTTP/WebSocket — на проверенный адрес объявленного
 *    сервера (electron/moduleNet.ts), COM — через помощника программы (moduleCom.ts);
 * 6. запись в журнал: только метаданные, содержимого вызова в нём нет.
 */
import { validMessage } from '../modules/schemas';
import {
  COM_DENIED_TYPES, CONNECTION_LIMITS, ConnectError, comDenied, connectionsOf, describeConnection, grantKey, kindOfOp,
  type ConnectCall, type ConnectErrorCode, type ConnectReply, type ConnectionDecl, type NetConnection,
} from '../modules/connections/model';
import type { ModuleManifest } from '../modules/contract';
import type { ModuleJournal } from './moduleJournal';
import type { ModuleGrants } from './moduleGrants';
import type { ComBackend } from './moduleCom';
import { hasNetPermission } from '../modules/permissions/registry';
import { WsSession, fetchUrl, httpCall, systemLookup, type Lookup } from './moduleNet';

export interface VerifiedModule { manifest: ModuleManifest; version: string; author: string; verifiedAt: number }
export interface ConnectRequest { moduleId: string; version: string; session: string; connection: string; call: unknown }
/** Вызов `flux.net.fetch(url)`: полный адрес, а не объявленное подключение */
export interface NetRequest { moduleId: string; version: string; session: string; call: unknown }
/** Имена «подключений» для политики администратора: начинаются с «@», поэтому с объявленными в манифесте не совпадают */
export const NET_POLICY = { internet: '@internet', lan: '@lan' } as const;
export interface ConnectionDeps {
  /** Проверенный выпуск установленной программы; null — такого нет или он не запускается */
  resolve: (moduleId: string, version: string) => Promise<VerifiedModule | null>;
  userId: () => string;
  grants: ModuleGrants;
  journal: ModuleJournal;
  /** Помощник COM программы: у каждой свой, чтобы таймаут или сбой одной не трогал объекты других */
  comFor: (moduleId: string) => ComBackend;
  lookup?: Lookup;
  now?: () => number;
}

interface Slot { windowAt: number; calls: number; comWindowAt: number; comCalls: number; inFlight: number; open: number; comQueue: Promise<unknown>; comWaiting: number }
interface Session { moduleId: string; sockets: Map<string, WsSession>; handles: Map<string, Set<number>>; roots: Map<string, Set<number>> }

const OUTCOME: Record<ConnectErrorCode, string> = {
  DENIED: 'denied', NOT_ALLOWED: 'user-denied', LIMIT: 'limit', TIMEOUT: 'timeout', TARGET: 'target', UNAVAILABLE: 'unavailable', FAILED: 'failed',
};

/** Метка вызова для журнала: без путей с данными и без аргументов */
function labelOf(decl: ConnectionDecl, call: ConnectCall): string {
  if (call.op === 'http' && decl.kind === 'http') return `${call.method} ${decl.pathPrefix}`;
  if (call.op === 'com-call' || call.op === 'com-get' || call.op === 'com-set') return `${call.op.slice(4)} ${call.name}`;
  if (call.op === 'com-batch') return `batch ×${call.calls.length}`;
  return call.op;
}

function walk(value: unknown, visit: (handle: number) => void, depth = 0) {
  if (depth > 8 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) walk(item, visit, depth + 1); return; }
  const handle = (value as { $com?: unknown }).$com;
  if (typeof handle === 'number') visit(handle);
  for (const item of Object.values(value)) walk(item, visit, depth + 1);
}
const sizeOf = (value: unknown) => { try { return JSON.stringify(value ?? null).length; } catch { return Infinity; } };

export class ModuleConnections {
  private slots = new Map<string, Slot>();
  private sessions = new Map<string, Session>();
  private backends = new Map<string, ComBackend>();
  private counter = 0;
  private now: () => number;
  private lookup: Lookup;
  constructor(private deps: ConnectionDeps) {
    this.now = deps.now ?? Date.now;
    this.lookup = deps.lookup ?? systemLookup;
  }

  private slot(moduleId: string): Slot {
    let s = this.slots.get(moduleId);
    if (!s) { s = { windowAt: 0, calls: 0, comWindowAt: 0, comCalls: 0, inFlight: 0, open: 0, comQueue: Promise.resolve(), comWaiting: 0 }; this.slots.set(moduleId, s); }
    return s;
  }
  private session(owner: string, session: string, moduleId: string): Session {
    const key = `${owner}:${session}`;
    let s = this.sessions.get(key);
    if (!s) { s = { moduleId, sockets: new Map(), handles: new Map(), roots: new Map() }; this.sessions.set(key, s); }
    return s;
  }
  /** Помощник COM программы; когда он завершился, её объекты недействительны — учёт обнуляется, чужие программы не затронуты */
  private com(moduleId: string): ComBackend {
    let backend = this.backends.get(moduleId);
    if (!backend) {
      backend = this.deps.comFor(moduleId);
      this.backends.set(moduleId, backend);
      backend.onExit(() => this.resetCom(moduleId));
    }
    return backend;
  }
  private resetCom(moduleId: string) {
    const slot = this.slots.get(moduleId);
    for (const s of this.sessions.values()) {
      if (s.moduleId !== moduleId) continue;
      const roots = [...s.roots.values()].reduce((n, set) => n + set.size, 0);
      if (slot) slot.open = Math.max(0, slot.open - roots);
      s.handles.clear(); s.roots.clear();
    }
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
    // connectionsOf повторно разбирает объявления: COM вне белого списка и опасный без флага владельца сюда не доходят
    const decl = connectionsOf(verified.manifest).find(c => c.id === request.connection) || null;
    if (!decl || decl.kind !== kindOfOp(call.op) || (decl.kind === 'com' && comDenied(decl.progId) && !decl.allowDangerous)) {
      return refuse('DENIED', decl, verified.version, labelOf(decl || { kind: 'com', id: '', app: '', does: '', access: 'read', progId: '' }, call));
    }
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
    const isCom = call.op.startsWith('com-');
    // Ожидание сообщения WebSocket не занимает «одновременный» вызов: оно и так ограничено 25 с и одним ожиданием на сокет
    const waits = call.op === 'ws-recv';
    if (isCom) {
      // COM — локальный однопоточный помощник: вызовов много, а идут они по очереди
      if (now - slot.comWindowAt >= 1000) { slot.comWindowAt = now; slot.comCalls = 0; }
      if (++slot.comCalls > CONNECTION_LIMITS.comCallsPerSecond || slot.comWaiting >= CONNECTION_LIMITS.comQueue) return refuse('LIMIT', decl, verified.version, label);
    } else {
      if (now - slot.windowAt >= 1000) { slot.windowAt = now; slot.calls = 0; }
      if (++slot.calls > CONNECTION_LIMITS.callsPerSecond || (!waits && slot.inFlight >= CONNECTION_LIMITS.inFlight)) return refuse('LIMIT', decl, verified.version, label);
    }
    if (!isCom && !waits) slot.inFlight++;
    try {
      const done = await this.run(owner, request, decl, call, slot);
      record(decl, verified.version, label, 'ok', done.io);
      return { ok: true, data: done.data };
    } catch (error) {
      const code = error instanceof ConnectError ? error.code : 'FAILED';
      return refuse(code, decl, verified.version, label);
    } finally { if (!isCom && !waits) slot.inFlight--; }
  }

  /**
   * Обращение по полному адресу (`flux.net.fetch(url)`). Порядок тот же, что у `call`, но разрешение — не подключение, а
   * объявленное в подписанном манифесте `permissions` (`internet`, `lan`): человек согласился с ним при установке.
   * Какое именно нужно, решает адрес, В КОТОРЫЙ РАЗРЕШИЛОСЬ ИМЯ (все адреса имени), а не написанное в вызове.
   */
  async net(owner: string, request: NetRequest): Promise<ConnectReply> {
    const started = this.now();
    const user = this.deps.userId();
    const call = request.call as { url?: unknown; method?: string };
    const record = (version: string, label: string, outcome: string, io: { inn?: number; out?: number } = {}, level: 'info' | 'warn' | 'error' = 'info') => {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(request.moduleId) || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version)) return;
      this.deps.journal.add({ moduleId: request.moduleId, version, userId: user, category: 'connection', level, event: 'call', detail: `адрес в сети · ${label}`, outcome,
        ms: this.now() - started, bytesIn: io.inn || 0, bytesOut: io.out || 0 });
    };
    const refuse = (code: ConnectErrorCode, version: string, label: string): ConnectReply => {
      record(version, label, OUTCOME[code], {}, code === 'NOT_ALLOWED' ? 'info' : 'warn');
      return { ok: false, code };
    };
    // В журнал — только метод и имя сервера: путь и запрос могут нести данные проекта
    const hostOf = (url: unknown) => { try { return new URL(String(url)).hostname.slice(0, 80); } catch { return '?'; } };
    const label = `${String(call?.method || '?').slice(0, 8)} ${hostOf(call?.url)}`;
    const envelope = { flux: 'module', v: 1, session: String(request.session), id: 'main', type: 'net', call: request.call };
    if (!request.call || typeof request.call !== 'object' || !validMessage('net', envelope)) return refuse('DENIED', String(request.version), 'bad-call');
    const verified = await this.deps.resolve(request.moduleId, request.version);
    if (!verified) return refuse('DENIED', String(request.version), 'unknown-module');
    const declared = { internet: hasNetPermission(verified.manifest, 'internet'), lan: hasNetPermission(verified.manifest, 'lan') };
    if (!declared.internet && !declared.lan) return refuse('DENIED', verified.version, label);
    // Политика администратора сильнее объявления: запрет роли действует, даже если человек уже согласился при установке
    const grants = {
      internet: declared.internet && !this.deps.grants.isDeniedByPolicy(request.moduleId, NET_POLICY.internet),
      lan: declared.lan && !this.deps.grants.isDeniedByPolicy(request.moduleId, NET_POLICY.lan),
    };
    if (!grants.internet && !grants.lan) return refuse('NOT_ALLOWED', verified.version, label);
    const slot = this.slot(request.moduleId), now = this.now();
    if (now - slot.windowAt >= 1000) { slot.windowAt = now; slot.calls = 0; }
    if (++slot.calls > CONNECTION_LIMITS.callsPerSecond || slot.inFlight >= CONNECTION_LIMITS.inFlight) return refuse('LIMIT', verified.version, label);
    slot.inFlight++;
    try {
      const done = await fetchUrl(request.call as Parameters<typeof fetchUrl>[0], grants, this.lookup);
      record(verified.version, label, 'ok', { inn: done.inn, out: done.out });
      return { ok: true, data: done.value };
    } catch (error) {
      return refuse(error instanceof ConnectError ? error.code : 'FAILED', verified.version, label);
    } finally { slot.inFlight--; }
  }

  private async run(owner: string, request: ConnectRequest, decl: ConnectionDecl, call: ConnectCall, slot: Slot): Promise<{ data: unknown; io: { inn?: number; out?: number } }> {
    const session = this.session(owner, request.session, request.moduleId);
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
      default: {
        // Вызовы COM одной программы идут строго по одному: помощник однопоточный
        slot.comWaiting++;
        const turn = slot.comQueue.then(() => this.comCall(session, decl, call as Extract<ConnectCall, { op: `com-${string}` }>, slot), () => this.comCall(session, decl, call as Extract<ConnectCall, { op: `com-${string}` }>, slot));
        slot.comQueue = turn.then(() => undefined, () => undefined).finally(() => { slot.comWaiting--; });
        return turn;
      }
    }
  }

  private async comCall(session: Session, decl: ConnectionDecl, call: Extract<ConnectCall, { op: `com-${string}` }>, slot: Slot) {
    if (decl.kind !== 'com') throw new ConnectError('DENIED');
    const backend = this.com(session.moduleId);
    if (!backend.available()) throw new ConnectError('UNAVAILABLE', 'no com');
    const owned = session.handles.get(decl.id) || new Set<number>();
    session.handles.set(decl.id, owned);
    const roots = session.roots.get(decl.id) || new Set<number>();
    session.roots.set(decl.id, roots);
    const limit = <T>(work: Promise<T>) => Promise.race([work, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new ConnectError('TIMEOUT')), CONNECTION_LIMITS.callMs + 6000);
      timer.unref?.();
    })]);
    // Объекты опасных типов в ответе не выдаются, если объект не открыт владельцем как опасный
    const deny = decl.allowDangerous ? [] : [...COM_DENIED_TYPES];
    if (call.op === 'com-open') {
      if (slot.open >= CONNECTION_LIMITS.open) throw new ConnectError('LIMIT', 'open');
      slot.open++;
      try {
        const handle = await limit(backend.open(decl.progId));
        owned.add(handle); roots.add(handle);
        return { data: { handle }, io: {} };
      } catch (error) { slot.open--; throw error; }
    }
    if (call.op === 'com-release') {
      // Чужой, выдуманный или устаревший номер — отказ; уже освобождённый объект повторно не освобождается
      if (!owned.has(call.handle)) throw new ConnectError('DENIED', 'handle');
      await backend.release(call.handle);
      owned.delete(call.handle);
      if (roots.delete(call.handle)) slot.open = Math.max(0, slot.open - 1);
      return { data: {}, io: {} };
    }
    const items = call.op === 'com-batch' ? call.calls.map(c => ({ ...c, args: c.args || [] }))
      : [{ kind: call.op === 'com-call' ? 'call' as const : call.op === 'com-get' ? 'get' as const : 'set' as const, handle: call.handle, name: call.name, args: call.args || [], value: call.op === 'com-set' ? call.value : undefined }];
    if (sizeOf(items) > CONNECTION_LIMITS.comArgsBytes) throw new ConnectError('LIMIT', 'args');
    for (const item of items) {
      if (!owned.has(item.handle)) throw new ConnectError('DENIED', 'handle');
      for (const value of [...item.args, item.value]) walk(value, handle => { if (!owned.has(handle)) throw new ConnectError('DENIED', 'handle'); });
    }
    const results = call.op === 'com-batch' ? await limit(backend.batch(items, deny))
      : [{ ok: true as const, value: await limit(backend.invoke(items[0].handle, items[0].kind, items[0].name, items[0].args, items[0].value, deny)) }];
    // Объекты из ответа записываются программе; сверх предела — освобождаются сразу, а не остаются висеть у помощника
    const fresh: number[] = [];
    for (const r of results) if (r.ok) walk(r.value, handle => { if (!owned.has(handle) && !fresh.includes(handle)) fresh.push(handle); });
    if (owned.size + fresh.length > CONNECTION_LIMITS.comHandles || sizeOf(results) > CONNECTION_LIMITS.comReplyBytes) {
      for (const handle of fresh) await backend.release(handle).catch(() => {});
      throw new ConnectError('LIMIT', 'handles');
    }
    for (const handle of fresh) owned.add(handle);
    const inn = sizeOf(results), out = sizeOf(items);
    if (call.op === 'com-batch') return { data: { results: results.map(r => 'error' in r ? { error: r.error } : { value: r.value }) }, io: { inn, out } };
    return { data: call.op === 'com-set' ? {} : { value: (results[0] as { value: unknown }).value }, io: { inn, out } };
  }

  /** Окно программы закрыто: сокеты и COM-объекты, которые она оставила, закрываются здесь */
  async closeSession(owner: string, session: string) {
    const key = `${owner}:${session}`, s = this.sessions.get(key);
    this.deps.grants.endSession(key);
    if (!s) return;
    this.sessions.delete(key);
    for (const socket of s.sockets.values()) socket.close();
    const backend = this.backends.get(s.moduleId);
    if (backend) for (const set of s.handles.values()) for (const handle of set) await backend.release(handle).catch(() => {});
    // Места открытых подключений этого окна возвращаются программе
    const freed = s.sockets.size + [...s.roots.values()].reduce((n, set) => n + set.size, 0);
    const slot = this.slots.get(s.moduleId);
    if (slot && freed) slot.open = Math.max(0, slot.open - freed);
  }

  async closeOwner(owner: string) {
    for (const key of [...this.sessions.keys()]) if (key.startsWith(`${owner}:`)) await this.closeSession(owner, key.slice(owner.length + 1));
  }

  async shutdown() {
    for (const key of [...this.sessions.keys()]) { const [owner, ...rest] = key.split(':'); await this.closeSession(owner, rest.join(':')); }
    for (const backend of this.backends.values()) await backend.shutdown().catch(() => {});
  }
}
