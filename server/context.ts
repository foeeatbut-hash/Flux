// Общий контекст сервера для вынесенных модулей-роутов.
//
// PrismaClient в server.ts — изменяемая переменная (пересоздаётся при
// переключении/восстановлении БД). Поэтому вынесенные роуты не могут захватить
// её один раз при импорте — они читают актуальный экземпляр лениво через
// getPrisma() на момент запроса. server.ts обязан вызывать setPrisma() при
// каждом (пере)создании клиента.

import type { Response } from 'express';
import { nextProjectId } from './entityIds.js';

let _prisma: any = null;

export function setPrisma(p: any): void {
  _prisma = p;
  // База сменилась — разовые правки надо проверить заново: у новой базы свой
  // признак выполненного, и считать его выполненным по памяти нельзя
  for (const reset of onSwapped) { try { reset(); } catch (_) { /* сброс — не условие работы */ } }
}

/** Кто хочет знать о смене базы: сюда записываются сбросы кэшей */
const onSwapped: Array<() => void> = [];
export function onDatabaseSwapped(reset: () => void): void { onSwapped.push(reset); }
export function getPrisma(): any { return _prisma; }

// Разрешение projectId: заглушки («null»/«undefined»/«default»/пусто) →
// первый проект в базе (создаётся, если проектов ещё нет).
export async function resolveProjectId(raw: string | undefined | null): Promise<string> {
  const prisma = getPrisma();
  const v = String(raw ?? '');
  if (v && v !== 'null' && v !== 'undefined' && v !== 'default') return v;
  // Служебный проект (общий диск) проектом «по умолчанию» быть не может:
  // иначе данные, у которых проект не назвали, легли бы в хранилище
  let first = await prisma.project.findFirst({ where: { system: false } });
  if (!first) first = await prisma.project.create({ data: { id: await nextProjectId(prisma), name: 'Общий Проект' } });
  return first.id;
}

/**
 * Ошибка, текст и код которой можно показать человеку как есть.
 * Всё прочее (сбой базы, опечатка в коде) наружу общим текстом, а подробность — в журнал.
 */
export class AppError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'AppError';
    this.status = status;
  }
}

/** Код из ошибки: свой status (AppError, http-errors, body-parser) или переданный */
function statusOf(err: any, fallback: number): number {
  const s = Number(err?.status ?? err?.statusCode);
  if (!Number.isInteger(s) || s < 400 || s > 599) return fallback;
  // 401 и 407 из чужой библиотеки (почта, HTTP-клиент) окно прочло бы как «сессия
  // кончилась» и разлогинило человека; свой отказ входа — только у AppError
  if ((s === 401 || s === 407) && !(err instanceof AppError)) return 502;
  return s;
}

/** Сообщение драйвера базы: имена моделей и текст запроса человеку не нужны */
function isDriverError(err: any): boolean {
  const name = String(err?.name || '');
  const msg = String(err?.message || '');
  return /^PrismaClient/.test(name) || /^P\d{4}$/.test(String(err?.code || '')) || /Invalid `[\w.]*prisma\d*\./i.test(msg);
}

// Единый ответ об ошибке (сохраняет привычный формат { error }).
// Код берётся из самой ошибки (err.status), иначе из параметра. Если ответ уже
// начат (файл идёт потоком), JSON дописать некуда: res.status().json() бросил бы
// ERR_HTTP_HEADERS_SENT из catch и дал необработанный отказ — обрываем соединение,
// чтобы клиент увидел обрыв, а не «успешно» оборванный файл.
export function sendError(res: Response, err: any, code = 500): void {
  if (res.headersSent) {
    console.error('[sendError] ответ уже начат, соединение закрыто:', err?.message || err);
    try { res.destroy(); } catch (_) { /* сокет уже закрыт */ }
    return;
  }
  const status = statusOf(err, code);
  let message = err?.message || String(err);
  if (isDriverError(err)) {
    console.error('[sendError] сбой базы:', err?.message || err);
    message = 'Не удалось выполнить операцию с базой данных. Подробности в журнале сервера.';
  } else if (status >= 500 && !(err instanceof AppError)) {
    console.error('[sendError]', err?.stack || err);
  }
  res.status(status).json({ error: message });
}

// Личное уведомление пользователю (реализация живёт в server.ts — там же
// socket-рассылка). Вынесенные роуты зовут notifyUser() лениво.
type Notifier = (userId: string, category: string, title: string, body?: string, targetRoute?: string) => Promise<void>;
let _notifier: Notifier | null = null;
export function setNotifier(fn: Notifier): void { _notifier = fn; }
export async function notifyUser(userId: string, category: string, title: string, body = '', targetRoute = ''): Promise<void> {
  try { if (_notifier && userId) await _notifier(userId, category, title, body, targetRoute); } catch (_) {}
}

// Широковещательное событие всем открытым окнам программы. Реализация живёт
// в server.ts вместе с socket.io; вынесенные модули зовут broadcast() лениво.
type Broadcaster = (event: string, payload: any) => void;
let _broadcast: Broadcaster | null = null;
export function setBroadcaster(fn: Broadcaster): void { _broadcast = fn; }
export function broadcast(event: string, payload: any): void {
  try { if (_broadcast) _broadcast(event, payload); } catch (_) { /* сокет мог отвалиться */ }
}

/**
 * Событие одному человеку, без записи в базу.
 *
 * Отличается от notifyUser тем, что ничего не создаёт: запись уже лежит в базе,
 * и её надо только донести быстрее, чем сработает опрос. Нужно очереди
 * уведомлений — она сама решает, что и когда записывать, и вторая запись рядом
 * означала бы два уведомления об одном событии.
 */
type UserPush = (userId: string, event: string, payload: any) => void;
let _push: UserPush | null = null;
export function setUserPush(fn: UserPush): void { _push = fn; }
export function pushToUser(userId: string, event: string, payload: any): void {
  try { if (_push && userId) _push(userId, event, payload); } catch (_) { /* сокет догонит опросом */ }
}

/**
 * Сбросить профиль сессии из кэша сервера.
 *
 * Сервер держит профиль вошедшего полминуты, чтобы не ходить в базу на каждый
 * запрос. Кто меняет права мимо маршрутов «Сотрудников» (кнопки диагностики
 * платформы), обязан сбросить и кэш — иначе выданное право полминуты
 * «не работает», а человек решает, что кнопка сломана.
 */
let _forget: ((userId?: string) => void) | null = null;
export function setSessionForget(fn: (userId?: string) => void): void { _forget = fn; }
export function forgetSessionUser(userId?: string): void {
  try { _forget?.(userId); } catch (_) { /* кэш истечёт сам */ }
}

// Настройка приложения: глобальная (userId=null) или персональная.
// Используется и в server.ts, и в вынесенных роутах — живёт здесь, чтобы не
// дублироваться.
export async function upsertSetting(key: string, userId: string | null, value: string) {
  const prisma = getPrisma();
  const existing = await prisma.appSetting.findFirst({ where: { key, userId: userId || null } });
  if (existing) {
    return prisma.appSetting.update({ where: { id: existing.id }, data: { value } });
  }
  return prisma.appSetting.create({ data: { key, userId: userId || null, value } });
}
