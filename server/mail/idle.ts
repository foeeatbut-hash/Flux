import { ImapFlow } from 'imapflow';
import { getPrisma, notifyUser, broadcast } from '../context.js';
import { unseal } from './secret.js';
import { syncFolder } from './sync.js';
import { isShared } from './access.js';

/**
 * Живой ящик: письмо появляется само, без нажатия «Проверить».
 *
 * По IMAP это делается командой IDLE — соединение остаётся открытым, и сервер
 * сам сообщает о новом письме. Опрос раз в минуту дал бы то же самое ценой
 * шестидесяти лишних соединений в час на каждый ящик, а задержку — до минуты.
 *
 * Соединение здесь своё, отдельное от пула в imap.ts. Пул закрывает соединения
 * через пять минут простоя и переиспользует их под выборку писем — то и другое
 * несовместимо с ожиданием, которое должно длиться часами.
 *
 * ImapFlow сам входит в IDLE, когда по открытому ящику нет других команд, и
 * поднимает событие `exists`. Нам остаётся дочитать новые письма и сказать об
 * этом разделу.
 */

interface Watch {
  accountId: string;
  client: ImapFlow | null;
  stopped: boolean;
  /** Сколько раз подряд не удалось соединиться — от этого растёт пауза */
  fails: number;
  timer: NodeJS.Timeout | null;
}

const watches = new Map<string, Watch>();

/** Пауза перед повтором: от 15 секунд до 10 минут. */
function backoff(fails: number): number {
  return Math.min(15_000 * 2 ** Math.max(0, fails - 1), 10 * 60_000);
}

async function openWatch(w: Watch): Promise<void> {
  const prisma = getPrisma();
  const acc = await prisma.mailAccount.findUnique({ where: { id: w.accountId } });
  if (!acc || !acc.active) { stopWatch(w.accountId); return; }

  const password = unseal(acc.secret, acc.secretNonce);
  if (!password) { stopWatch(w.accountId); return; }

  const inbox = await prisma.mailFolder.findFirst({ where: { accountId: acc.id, kind: 'INBOX' } });
  // Пока мы читали базу, наблюдение могли остановить (правка настроек, удаление
  // ящика) — открывать после этого соединение значило бы оставить его без хозяина
  if (w.stopped) return;
  if (!inbox) { retry(w); return; }

  const client = new ImapFlow({
    host: acc.imapHost,
    port: acc.imapPort,
    secure: acc.imapSecure,
    auth: { user: acc.login, pass: password },
    // Своя запись в журнал не нужна: ошибки мы разбираем сами
    logger: false,
    // Долгое ожидание — смысл этого соединения, поэтому таймаут простоя снят
    socketTimeout: 30 * 60_000,
  });

  w.client = client;

  client.on('error', () => { /* разберём в close */ });
  client.on('close', () => {
    if (w.stopped) return;
    w.client = null;
    retry(w);
  });

  // Новое письмо: сервер прислал EXISTS
  client.on('exists', () => { void onNew(w.accountId, inbox.id); });

  try {
    await client.connect();
    if (w.stopped) { try { client.close(); } catch (_) { /* уже закрыт */ } return; }
    await client.mailboxOpen(inbox.path);
    if (w.stopped) { try { client.close(); } catch (_) { /* уже закрыт */ } return; }
    w.fails = 0;
    // Пока нас не было, письма могли прийти — досинхронизируем сразу
    void onNew(w.accountId, inbox.id, true);
  } catch (err: any) {
    w.client = null;
    // Повтор назначаем ниже сами; обработчик закрытия назначил бы второй, и
    // пауза росла бы вдвое быстрее задуманного
    client.removeAllListeners('close');
    try { client.close(); } catch (_) { /* уже закрыт */ }
    // Неверный пароль повторять бессмысленно — пишем в ящик и умолкаем. Текст
    // сервера у imapflow лежит в responseText, а в message только «Command
    // failed»: проверка одного message не узнавала отказ, и наблюдение каждые
    // десять минут пробовало неверный пароль снова — до блокировки ящика
    const refusal = `${err?.responseText || ''} ${err?.message || ''}`;
    if (err?.authenticationFailed
        || /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|authentication failed/i.test(refusal)) {
      await prisma.mailAccount.update({
        where: { id: w.accountId },
        data: { lastError: 'Сервер не принял логин или пароль — проверьте настройки ящика' },
      }).catch(() => null);
      stopWatch(w.accountId);
      return;
    }
    retry(w);
  }
}

function retry(w: Watch): void {
  if (w.stopped) return;
  w.fails += 1;
  if (w.timer) clearTimeout(w.timer);
  w.timer = setTimeout(() => { void openWatch(w); }, backoff(w.fails));
}

/** Пришло новое: дочитываем папку и говорим разделу. */
async function onNew(accountId: string, folderId: string, quiet = false): Promise<void> {
  const prisma = getPrisma();
  try {
    const [acc, folder] = await Promise.all([
      prisma.mailAccount.findUnique({ where: { id: accountId } }),
      prisma.mailFolder.findUnique({ where: { id: folderId } }),
    ]);
    if (!acc || !folder) return;

    const report = await syncFolder(acc, folder, false);
    if (!report.added) return;

    // Раздел обновляет список сам — счётчики и строки, без нажатий
    broadcast('mail:new', { accountId, folderId, added: report.added });
    if (quiet) return;

    const fresh = await prisma.mailMessage.findFirst({
      where: { folderId }, orderBy: { sentAt: 'desc' },
    });
    if (!fresh) return;

    // Личный ящик — уведомляем владельца. Общий не трогаем: десять сотрудников
    // получали бы по уведомлению на каждую рассылку, и уведомления
    // превратились бы в шум, который перестают читать.
    if (!isShared(acc) && acc.ownerId) {
      await notifyUser(
        acc.ownerId, 'ПОЧТА',
        fresh.fromName || fresh.fromAddr || 'Новое письмо',
        fresh.subject || '(без темы)',
        '/mail',
      );
    }
  } catch (_) {
    /* сбой синхронизации не должен ронять наблюдение: следующее письмо придёт */
  }
}

/** Начать следить за ящиком. Повторный вызов ничего не ломает. */
export function watchAccount(accountId: string): void {
  if (!accountId || watches.has(accountId)) return;
  const w: Watch = { accountId, client: null, stopped: false, fails: 0, timer: null };
  watches.set(accountId, w);
  void openWatch(w);
}

/** Перестать следить: ящик удалили, отключили или сменили настройки. */
export function stopWatch(accountId: string): void {
  const w = watches.get(accountId);
  if (!w) return;
  w.stopped = true;
  if (w.timer) clearTimeout(w.timer);
  watches.delete(accountId);
  const c = w.client;
  w.client = null;
  if (c) { c.logout().catch(() => { try { c.close(); } catch (_) { /* уже мёртв */ } }); }
}

/** Перезапустить наблюдение — после правки настроек ящика. */
export function restartWatch(accountId: string): void {
  stopWatch(accountId);
  // Небольшая пауза: старое соединение должно успеть закрыться
  setTimeout(() => watchAccount(accountId), 1500);
}

/**
 * Поднять наблюдение за всеми подключёнными ящиками.
 * Зовётся при старте сервера и после переключения базы.
 */
export async function watchAll(): Promise<number> {
  const prisma = getPrisma();
  if (!prisma) return 0;
  try {
    const accounts = await prisma.mailAccount.findMany({ where: { active: true } });
    for (const a of accounts as any[]) watchAccount(a.id);
    return accounts.length;
  } catch (_) {
    // Таблиц может ещё не быть — на пустой базе это нормально
    return 0;
  }
}

/** Погасить все наблюдения — при остановке сервера и смене базы. */
export function stopAll(): void {
  for (const id of [...watches.keys()]) stopWatch(id);
}

export function watchCount(): number {
  return watches.size;
}
