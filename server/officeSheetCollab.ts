/**
 * Совместная правка Таблицы Flux Office: правят все сразу.
 *
 * Только для файлов в общем доступе. Сервер не понимает Excel: он ведёт
 * журнал правок сеанса — мутаций Univer (tools/genoffice/inject/sheets-collab.ts)
 * — в том порядке, в каком они до него дошли, и раздаёт их участникам.
 * Этот порядок и есть общий: у кого правка применилась раньше, чем пришла
 * чужая, тот переигрывает свою поверх (сведение одной ячейки — «кто позже
 * дошёл до сервера, тот и прав», как у всех).
 *
 * Почему журнал с начала сеанса, а не с последней записи: у каждого окна
 * «файл на диске + журнал правок Таблицы» — это текущая книга. Опоздавший
 * открывает исходник сеанса и проигрывает весь журнал — у него то же, что у
 * всех, и его запись (станет держателем, когда первый уйдёт) — полная.
 *
 * Файл записывает держатель (server/officeRooms.ts). Сверка при записи —
 * с хешем последней записи сеанса, а не с исходником: держатель пишет всё,
 * что было до него записано, плюс новое.
 */
import type { Server, Socket } from 'socket.io';
import { createHash, randomUUID } from 'node:crypto';
import { officeRooms } from './officeRooms.js';

/** Сколько живёт записанный сеанс без людей: переоткрыли — продолжили */
export const IDLE_MS = 10 * 60_000;
/** Одна правка не больше этого (вставка большого куска — несколько мегабайт) */
export const MAX_OP_CHARS = 8 * 1024 * 1024;
/** Журнал сеанса не бесконечен: дальше — открыть книгу заново */
export const MAX_OPS = 200_000;

export interface SheetOp {
  /** Мутация Univer: имя и параметры */
  id: string;
  params: unknown;
  /** Имена листов, о которых говорит правка, — на момент до неё */
  sheets?: Record<string, string>;
}

export interface SheetSession {
  fileId: string;
  /** Опознаватель сеанса: сменился (сервер перезапускался) — окно открывает книгу заново */
  key: string;
  baseBytes: Buffer;
  baseSha: string;
  /** Хеш файла после последней записи сеанса — с ним сверяется следующая */
  savedSha: string;
  ops: Array<{ seq: number; op: SheetOp }>;
  /** До какого номера правки уже в файле */
  savedSeq: number;
  emptyAt: number | null;
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

export class SheetBook {
  private sessions = new Map<string, SheetSession>();
  private opening = new Map<string, Promise<SheetSession>>();

  /** Сеанс файла; нет — открыть с текущим содержимым файла как исходником */
  async ensure(fileId: string, read: () => Promise<Buffer>): Promise<SheetSession> {
    const have = this.sessions.get(fileId);
    if (have) return have;
    const pending = this.opening.get(fileId);
    if (pending) return pending;
    const p = (async () => {
      const bytes = await read();
      const sha = sha256(bytes);
      const s: SheetSession = { fileId, key: randomUUID(), baseBytes: bytes, baseSha: sha, savedSha: sha, ops: [], savedSeq: 0, emptyAt: null };
      this.sessions.set(fileId, s);
      return s;
    })();
    this.opening.set(fileId, p);
    try { return await p; } finally { this.opening.delete(fileId); }
  }

  get(fileId: string): SheetSession | null { return this.sessions.get(fileId) || null; }

  /** Правка участника: получает номер и встаёт в журнал. null — не принята */
  push(s: SheetSession, op: SheetOp): number | null {
    if (s.ops.length >= MAX_OPS) return null;
    const seq = (s.ops.length ? s.ops[s.ops.length - 1].seq : 0) + 1;
    s.ops.push({ seq, op });
    return seq;
  }

  /** Правки после номера from — опоздавшему */
  since(s: SheetSession, from: number): Array<{ seq: number; op: SheetOp }> {
    return from <= 0 ? s.ops.slice() : s.ops.filter((o) => o.seq > from);
  }

  lastSeq(s: SheetSession): number { return s.ops.length ? s.ops[s.ops.length - 1].seq : 0; }

  /** Держатель записал: в файле всё до seq, и следующая запись сверяется с этим хешем */
  markSaved(s: SheetSession, sha: string, seq: number): void {
    s.savedSha = sha;
    s.savedSeq = Math.max(s.savedSeq, seq);
  }

  unsaved(s: SheetSession): boolean { return this.lastSeq(s) > s.savedSeq; }

  /** Пустые сеансы: записанные — через IDLE_MS; незаписанные ждут людей */
  sweep(now: number, occupied: (fileId: string) => boolean): void {
    for (const [id, s] of this.sessions) {
      if (occupied(id)) { s.emptyAt = null; continue; }
      if (s.emptyAt == null) s.emptyAt = now;
      if (now - s.emptyAt >= IDLE_MS && !this.unsaved(s)) this.sessions.delete(id);
    }
  }
}

export const sheetBook = new SheetBook();

const roomOf = (fileId: string) => `office:${fileId}`;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MUTATION = /^[a-z][\w.-]{0,127}$/i;

/** Правка из окна: имя мутации и параметры, которые можно переслать как есть */
export function cleanOp(v: unknown): SheetOp | null {
  const o = v as SheetOp;
  if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !MUTATION.test(o.id)) return null;
  let size = 0;
  try { size = JSON.stringify(o.params ?? null).length; } catch { return null; }
  if (size > MAX_OP_CHARS) return null;
  const sheets: Record<string, string> = {};
  if (o.sheets && typeof o.sheets === 'object') {
    for (const [k, n] of Object.entries(o.sheets).slice(0, 64)) if (typeof n === 'string') sheets[String(k).slice(0, 128)] = n.slice(0, 256);
  }
  return { id: o.id, params: o.params ?? null, sheets };
}

let sweeper: ReturnType<typeof setInterval> | null = null;

/** Подписать одно соединение на обмен правками Таблицы. Зовётся из connection */
export function setupOfficeSheetCollab(io: Server, socket: Socket): { gone: () => void } {
  if (!sweeper) {
    sweeper = setInterval(() => sheetBook.sweep(Date.now(), (id) => officeRooms.roster(id).peers.length > 0), 30_000);
    sweeper.unref?.();
  }
  const member = (fileId: string) => (ID.test(fileId) ? officeRooms.peerOf(fileId, socket.id) : null);

  /** Журнал сеанса после номера from (опоздавшему — весь) */
  socket.on('office:x-want', ({ fileId, from }: { fileId: string; from?: number }, ack?: (r: any) => void) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const id = String(fileId || '');
    const s = sheetBook.get(id);
    if (!member(id) || !officeRooms.roster(id).collab || !s) return reply({ error: 'Сеанс общей книги не открыт' });
    reply({ key: s.key, ops: sheetBook.since(s, Number(from) || 0) });
  });

  /** Правка участника: номер по порядку, в журнал, остальным */
  socket.on('office:x-op', ({ fileId, key, op }: { fileId: string; key: string; op: unknown }, ack?: (r: any) => void) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const id = String(fileId || '');
    const peer = member(id);
    const s = sheetBook.get(id);
    // Правки шлёт только тот, кому файл можно писать
    if (!peer?.mayWrite || !s) return reply({ error: 'Эту книгу вам можно только смотреть' });
    if (String(key || '') !== s.key) return reply({ error: 'session', key: s.key });
    const clean = cleanOp(op);
    if (!clean) return reply({ error: 'Правка не принята' });
    const seq = sheetBook.push(s, clean);
    if (seq == null) return reply({ error: 'Журнал общей книги переполнен: откройте её заново' });
    socket.to(roomOf(id)).emit('office:x-op', { fileId: id, seq, op: clean });
    reply({ seq });
  });

  return { gone: () => {} };
}
