// Общий контекст сервера для вынесенных модулей-роутов.
//
// PrismaClient в server.ts — изменяемая переменная (пересоздаётся при
// переключении/восстановлении БД). Поэтому вынесенные роуты не могут захватить
// её один раз при импорте — они читают актуальный экземпляр лениво через
// getPrisma() на момент запроса. server.ts обязан вызывать setPrisma() при
// каждом (пере)создании клиента.

import type { Response } from 'express';

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
  let first = await prisma.project.findFirst();
  if (!first) first = await prisma.project.create({ data: { name: 'Общий Проект' } });
  return first.id;
}

// Единый ответ об ошибке (сохраняет привычный формат { error }).
export function sendError(res: Response, err: any, code = 500): void {
  res.status(code).json({ error: err?.message || String(err) });
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
