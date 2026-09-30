/**
 * Мост между шиной Flux Office и сокетами этого сервера.
 *
 * Шина (officeBus.ts) и книги правил про socket.io не знают: им нужно только
 * «отдать событие окнам этого сервера». Отдельный класс нужен, чтобы
 * проверки (scripts/test-office-bus.ts) гоняли два сервера в одном процессе
 * без сокетов: у каждого свой OfficeOut, и вместо socket.io он вызывает
 * функцию проверки — так видно, что именно получило окно каждого сервера.
 */
import type { Server } from 'socket.io';

export type OutTarget = { room?: string; socket?: string; except?: string | null };
export type OutSink = (to: OutTarget, event: string, payload: unknown) => void;

/** Комната socket.io, в которой сидят окна одного файла на этом сервере */
export const roomOf = (fileId: string): string => `office:${fileId}`;

export class OfficeOut {
  private io: Server | null = null;
  /** Подмена для проверок: что делать вместо сокета */
  sink: OutSink | null = null;

  attach(server: Server): void { this.io = server; }

  /** Всем окнам файла на этом сервере, кроме except (автора) */
  room(fileId: string, event: string, payload: unknown, except?: string | null): void {
    if (this.sink) { this.sink({ room: fileId, except }, event, payload); return; }
    if (!this.io) return;
    if (except) this.io.to(roomOf(fileId)).except(except).emit(event, payload);
    else this.io.to(roomOf(fileId)).emit(event, payload);
  }

  /** Одному окну; если оно не на этом сервере — некому отдавать, и это не ошибка */
  socket(socketId: string, event: string, payload: unknown): void {
    if (this.sink) { this.sink({ socket: socketId }, event, payload); return; }
    this.io?.to(socketId).emit(event, payload);
  }
}

/** Сокеты этого сервера */
export const officeOut = new OfficeOut();
export const attachIo = (server: Server): void => officeOut.attach(server);
