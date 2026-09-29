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
 *
 * Где что живёт. Журнал, исходник, хеш последней записи и «до какого номера
 * записано» — в общей базе (server/officeBus.ts): у каждого сотрудника свой
 * сервер, и порядок правок, заведённый на одном из них, второму был бы
 * неизвестен — у двоих оказались бы разные книги. Номер правки выдаёт база, так
 * что порядок один для всех серверов. Правки доходят до окон через насос шины в
 * порядке номеров — и до окон этого же сервера тоже: по приходу их разослать
 * нельзя, две правки могли бы обогнать друг друга, а окно отбрасывает всё, что
 * старше уже применённого.
 */
import type { Socket } from 'socket.io';
import { createHash } from 'node:crypto';
import { officeHub, type OfficeRoomHub } from './officeRooms.js';
import { officeBus, BusFull, IDLE_MS, type OfficeBus, type SessionRow } from './officeBus.js';
import { officeOut, type OfficeOut } from './officeIo.js';

export { IDLE_MS };

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

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** Одна запись журнала: номер и правка */
export interface SheetEntry { seq: number; op: SheetOp }

/**
 * Журнал Таблицы на шине. Один на сервер. Правила (что принять, сколько
 * держать) — здесь, состояние — в базе.
 */
export class SheetShared {
  constructor(private bus: OfficeBus, private out: OfficeOut = officeOut) {
    // Правки после номера — окнам этого сервера, в порядке номеров; автору — нет, он свою уже знает
    bus.on('x', (ev) => {
      let op: SheetOp | null = null;
      try { op = ev.data ? JSON.parse(ev.data.toString('utf8')) : null; } catch (_) { op = null; }
      if (op) this.out.room(ev.fileId, 'office:x-op', { fileId: ev.fileId, seq: ev.seq, op }, ev.fromSocket);
    });
  }

  /** Сеанс общей книги; нет — открыть с текущим содержимым файла как исходником */
  async open(fileId: string, read: () => Promise<Buffer>): Promise<SessionRow> {
    const row = await this.bus.ensureBase(fileId, 'sheets', read, sha256);
    if (!row.baseData) throw new Error('У сеанса нет исходника');
    return row;
  }

  /** Журнал после номера from (опоздавшему — весь) */
  async since(fileId: string, from: number): Promise<{ key: string; ops: SheetEntry[] } | null> {
    const row = await this.bus.session(fileId);
    if (!row) return null;
    const ops: SheetEntry[] = [];
    let after = Math.max(0, from);
    for (;;) {
      const page = await this.bus.since(fileId, after, ['x']);
      for (const ev of page) {
        try { ops.push({ seq: ev.seq, op: JSON.parse((ev.data || Buffer.alloc(0)).toString('utf8')) }); } catch (_) { /* повреждённую правку пропускаем */ }
      }
      if (page.length < 2000) break;
      after = page[page.length - 1].seq;
    }
    return { key: row.key, ops };
  }

  /** Правка участника: номер по порядку и в журнал. null — не принята, причина в error */
  async push(fileId: string, key: string, op: SheetOp, fromSocket: string): Promise<{ seq: number } | { error: string; key?: string }> {
    const row = await this.bus.session(fileId);
    if (!row) return { error: 'Сеанс общей книги не открыт' };
    if (key !== row.key) return { error: 'session', key: row.key };
    try {
      const seq = await this.bus.publish(fileId, { kind: 'x', fromSocket, data: Buffer.from(JSON.stringify(op)), app: 'sheets' }, { maxSeq: MAX_OPS });
      return { seq };
    } catch (e) {
      if (e instanceof BusFull) return { error: 'Журнал общей книги переполнен: откройте её заново' };
      throw e;
    }
  }

  /** Держатель записал: в файле всё до seq, и следующая запись сверяется с этим хешем */
  async markSaved(fileId: string, sha: string, seq: number): Promise<void> {
    await this.bus.patchSession({ fileId }, { savedSha: sha });
    await this.bus.patchSession({ fileId, savedSeq: { lt: seq } }, { savedSeq: seq });
  }
}

export const sheetShared = new SheetShared(officeBus);

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

/** Подписать одно соединение на обмен правками Таблицы. Зовётся из connection */
export function setupOfficeSheetCollab(
  socket: Socket, parts: { hub: OfficeRoomHub; shared: SheetShared } = { hub: officeHub, shared: sheetShared },
): { gone: () => void } {
  const { hub, shared } = parts;
  const member = (fileId: string) => (ID.test(fileId) ? hub.peerLocal(fileId, socket.id) : null);

  /** Журнал сеанса после номера from (опоздавшему — весь) */
  socket.on('office:x-want', async ({ fileId, from }: { fileId: string; from?: number }, ack?: (r: any) => void) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const id = String(fileId || '');
    if (!member(id) || !hub.isCollab(id)) return reply({ error: 'Сеанс общей книги не открыт' });
    try {
      const got = await shared.since(id, Number(from) || 0);
      reply(got || { error: 'Сеанс общей книги не открыт' });
    } catch (e: any) { reply({ error: `Журнал общей книги не прочитан: ${e?.message || e}` }); }
  });

  /** Правка участника: номер по порядку, в журнал, остальным */
  socket.on('office:x-op', async ({ fileId, key, op }: { fileId: string; key: string; op: unknown }, ack?: (r: any) => void) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const id = String(fileId || '');
    const peer = member(id);
    // Правки шлёт только тот, кому файл можно писать
    if (!peer?.mayWrite) return reply({ error: 'Эту книгу вам можно только смотреть' });
    const clean = cleanOp(op);
    if (!clean) return reply({ error: 'Правка не принята' });
    try { reply(await shared.push(id, String(key || ''), clean, socket.id)); }
    catch (e: any) { reply({ error: `Правка не записана в общую базу: ${e?.message || e}` }); }
  });

  return { gone: () => {} };
}
