/**
 * HTTP и WebSocket подпрограммы в главном процессе.
 *
 * Адрес берётся из объявления в подписанном манифесте, а не из вызова: вызов
 * даёт только путь внутри объявленного префикса. Имя разрешается здесь же,
 * результат проверяется (modules/connections/address.ts) и соединение
 * открывается именно на проверенный адрес — между проверкой и подключением
 * имя не успеет получить другой. Редиректы не выполняются: ответ 3xx
 * возвращается подпрограмме как есть, а следующий её вызов проверяется заново.
 */
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import WebSocket from 'ws';
import {
  CONNECTION_LIMITS, ConnectError, checkHeaders, parseOrigin, pathAllowed,
  type ConnectCall, type NetConnection,
} from '../modules/connections/model';
import { pickAddress } from '../modules/connections/address';
import type { HttpReply, WsReply } from '../modules/contract';

export type Lookup = (host: string) => Promise<string[]>;
export const systemLookup: Lookup = async host => (await dns.promises.lookup(host, { all: true, verbatim: true })).map(a => a.address);
/** Разрешение имени не ждёт дольше 5 с: зависший DNS не держит вызов и слот подпрограммы */
export const DNS_TIMEOUT_MS = 5000;
const withDnsTimeout = (lookup: Lookup): Lookup => host => Promise.race([lookup(host), new Promise<string[]>((_, reject) => {
  const timer = setTimeout(() => reject(new Error('dns timeout')), DNS_TIMEOUT_MS);
  timer.unref?.();
})]);

const MAX = CONNECTION_LIMITS.bodyBytes;

/** Подключение сразу к проверенному адресу; имя остаётся только для заголовка Host и TLS */
const pinned = (address: string, family: 4 | 6) => (_host: string, options: any, callback: any) => {
  if (options?.all) callback(null, [{ address, family }]);
  else callback(null, address, family);
};

function decodeBody(value: string | undefined, encoding: 'utf8' | 'base64' | undefined): Buffer | undefined {
  if (value === undefined) return undefined;
  if (encoding === 'base64') {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new ConnectError('FAILED', 'base64');
    return Buffer.from(value, 'base64');
  }
  return Buffer.from(value, 'utf8');
}

export interface NetResult<T> { value: T; out: number; inn: number; status?: number }

export async function httpCall(decl: NetConnection, call: Extract<ConnectCall, { op: 'http' }>, lookup: Lookup): Promise<NetResult<HttpReply>> {
  const target = parseOrigin('http', decl.url);
  const path = pathAllowed(decl.pathPrefix, call.path);
  if (!target || !path) throw new ConnectError('TARGET', 'path');
  const headers = checkHeaders(call.headers);
  if (!headers) throw new ConnectError('TARGET', 'headers');
  const body = decodeBody(call.body, call.encoding);
  if (body && (call.method === 'GET' || call.method === 'HEAD')) throw new ConnectError('FAILED', 'body');
  if (body && body.length > MAX) throw new ConnectError('LIMIT');
  const chosen = await pickAddress(decl, withDnsTimeout(lookup)).catch(() => null);
  if (!chosen) throw new ConnectError('TARGET', 'address');
  const client = target.scheme === 'https' ? https : http;
  const sent: Record<string, string | number> = { 'accept-encoding': 'identity', 'user-agent': 'Flux-Module', ...headers };
  if (body) sent['content-length'] = body.length;
  return new Promise((resolve, reject) => {
    const request = client.request({
      host: target.host, port: target.port, path, method: call.method, headers: sent, agent: false,
      lookup: pinned(chosen.address, chosen.family) as any, servername: /^[0-9.]+$|:/.test(target.host) ? undefined : target.host,
    } as http.RequestOptions, response => {
      const parts: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX) { request.destroy(); reject(new ConnectError('LIMIT', 'response')); return; }
        parts.push(chunk);
      });
      response.on('end', () => {
        const raw = Buffer.concat(parts);
        const out: Record<string, string> = {};
        // Cookie, которые поставил сервер, подпрограмме не отдаются: хранилища cookie у неё нет, а чужой сеанс ей ни к чему
        for (const [name, value] of Object.entries(response.headers).slice(0, 64)) {
          if (name !== 'set-cookie' && value !== undefined) out[name] = Array.isArray(value) ? value.join(', ') : String(value);
        }
        let reply: HttpReply;
        try {
          if (call.encoding === 'base64') throw new Error('binary');
          reply = { status: response.statusCode || 0, headers: out, body: new TextDecoder('utf-8', { fatal: true }).decode(raw), encoding: 'utf8' };
        } catch { reply = { status: response.statusCode || 0, headers: out, body: raw.toString('base64'), encoding: 'base64' }; }
        resolve({ value: reply, out: body?.length || 0, inn: raw.length, status: response.statusCode });
      });
      response.on('error', () => reject(new ConnectError('FAILED')));
    });
    // Общий срок вызова, а не только простой сокета: медленный ответ по капле не держит слот дольше предела
    const total = setTimeout(() => { request.destroy(); reject(new ConnectError('TIMEOUT')); }, CONNECTION_LIMITS.callMs);
    total.unref?.();
    request.on('close', () => clearTimeout(total));
    request.setTimeout(CONNECTION_LIMITS.callMs, () => { request.destroy(); reject(new ConnectError('TIMEOUT')); });
    request.on('error', () => reject(new ConnectError('FAILED')));
    request.end(body);
  });
}

/** Один открытый сокет подпрограммы: очередь входящих ограничена, переполнение закрывает сокет */
export class WsSession {
  private queue: Array<{ data: string; encoding: 'utf8' | 'base64' }> = [];
  private queued = 0;
  private closed = false;
  private waiter: (() => void) | null = null;
  bytesIn = 0;
  bytesOut = 0;
  private constructor(private socket: WebSocket) {
    socket.on('message', (data: Buffer, binary: boolean) => {
      const raw = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      this.bytesIn += raw.length;
      this.queued += raw.length;
      if (this.queue.length >= CONNECTION_LIMITS.wsQueue || this.queued > CONNECTION_LIMITS.wsQueueBytes) { this.close(); return; }
      this.queue.push(binary ? { data: raw.toString('base64'), encoding: 'base64' } : { data: raw.toString('utf8'), encoding: 'utf8' });
      this.wake();
    });
    socket.on('close', () => { this.closed = true; this.wake(); });
    socket.on('error', () => { this.closed = true; this.wake(); });
  }
  private wake() { const w = this.waiter; this.waiter = null; w?.(); }

  static async open(decl: NetConnection, rawPath: string, lookup: Lookup): Promise<WsSession> {
    const target = parseOrigin('ws', decl.url);
    const path = pathAllowed(decl.pathPrefix, rawPath);
    if (!target || !path) throw new ConnectError('TARGET', 'path');
    const chosen = await pickAddress(decl, withDnsTimeout(lookup)).catch(() => null);
    if (!chosen) throw new ConnectError('TARGET', 'address');
    return new Promise((resolve, reject) => {
      // followRedirects у ws выключен по умолчанию; Origin и cookie не отправляются
      const socket = new WebSocket(`${target.origin}${path}`, {
        lookup: pinned(chosen.address, chosen.family) as any, handshakeTimeout: CONNECTION_LIMITS.callMs,
        maxPayload: CONNECTION_LIMITS.bodyBytes, perMessageDeflate: false, headers: { 'user-agent': 'Flux-Module' },
        servername: /^[0-9.]+$|:/.test(target.host) ? undefined : target.host,
      } as WebSocket.ClientOptions);
      socket.once('open', () => resolve(new WsSession(socket)));
      socket.once('error', () => reject(new ConnectError('FAILED', 'handshake')));
      socket.once('unexpected-response', () => { socket.terminate(); reject(new ConnectError('FAILED', 'handshake')); });
    });
  }

  send(value: string, encoding?: 'utf8' | 'base64'): number {
    if (this.closed) throw new ConnectError('FAILED', 'closed');
    const raw = decodeBody(value, encoding)!;
    if (raw.length > CONNECTION_LIMITS.bodyBytes) throw new ConnectError('LIMIT');
    this.socket.send(raw, { binary: encoding === 'base64' });
    this.bytesOut += raw.length;
    return raw.length;
  }

  private receiving = false;
  async recv(timeoutMs: number): Promise<WsReply> {
    // Одно ожидание на сокет: второе, пока первое не закончилось, — предел, а не ещё один занятый слот
    if (this.receiving) throw new ConnectError('LIMIT', 'recv');
    this.receiving = true;
    try { return await this.recvOnce(timeoutMs); } finally { this.receiving = false; }
  }
  private async recvOnce(timeoutMs: number): Promise<WsReply> {
    if (!this.queue.length && !this.closed && timeoutMs > 0) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.waiter = null; resolve(); }, Math.min(timeoutMs, CONNECTION_LIMITS.recvMs));
        this.waiter = () => { clearTimeout(timer); resolve(); };
      });
    }
    const next = this.queue.shift();
    if (next) { this.queued -= Buffer.byteLength(next.data, next.encoding === 'base64' ? 'base64' : 'utf8'); return next; }
    return this.closed ? { closed: true } : { empty: true };
  }

  close() { this.closed = true; try { this.socket.terminate(); } catch { /* уже закрыт */ } this.wake(); }
}
