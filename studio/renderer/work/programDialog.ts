/**
 * Диалоги и файл программы в пробном запуске: общая часть окон Studio (запуск разработчика и пробный запуск владельца).
 * Окна рисуют диалог по-своему (каркас у них разный), а тексты, ответы и строки журнала — одни и те же.
 */
import type { PageDialog, PageDialogAnswer } from '../../../modules/page/model';

/** Что получает программа, если человек закрыл диалог, не ответив */
export const dialogCancel = (request: PageDialog): PageDialogAnswer => (request.kind === 'confirm' ? false : null);
/** Ответ на «OK» / Enter */
export const dialogSubmit = (request: PageDialog, value: string): PageDialogAnswer => (request.kind === 'confirm' ? true : request.kind === 'prompt' ? value : null);
export const dialogOkLabel = (request: PageDialog) => (request.kind === 'confirm' && request.ok) || (request.kind === 'alert' ? 'Понятно' : 'OK');
export const dialogCancelLabel = (request: PageDialog) => (request.kind === 'confirm' && request.cancel) || 'Отмена';
export const dialogStartLine = (request: PageDialog) => `${request.kind}: «${request.title}»`;
/** В журнал уходит только вид ответа: текст, введённый человеком, туда не попадает */
export const dialogAnswerLine = (request: PageDialog, answer: PageDialogAnswer) =>
  `ответ: ${request.kind === 'prompt' ? (answer === null ? 'отказ' : `строка, ${String(answer).length} зн.`) : request.kind === 'confirm' ? (answer ? 'да' : 'нет') : 'прочитано'}`;

export type PickedFile = { name: string; mime: string; bytes: Uint8Array } | 'cancelled' | 'limit';
type Wire = { ok: boolean; code?: string; name?: string; data?: string };

/** Ответ главного процесса на «дайте файл» → то, что ждёт мост; строки журнала пишет окно через `log` */
export function pickedFromWire(reply: Wire, log: (text: string, level?: 'info' | 'warn') => void): PickedFile {
  if (reply.ok && reply.name !== undefined && reply.data !== undefined) {
    const bytes = Uint8Array.from(atob(reply.data), c => c.charCodeAt(0));
    log(`${reply.name} (${bytes.length} Б) выдан программе`); return { name: reply.name, mime: '', bytes };
  }
  if (reply.code === 'CANCELLED') { log('человек отказался выбирать файл'); return 'cancelled'; }
  if (reply.code === 'LIMIT') { log('файл больше 512 КиБ — программе не выдан', 'warn'); return 'limit'; }
  throw new Error(reply.code || 'FAILED');
}
