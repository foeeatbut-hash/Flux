/**
 * Стенд для проверок платформы: своя база и настоящие таблицы.
 *
 * Почему не через поднятый сервер. Команды, очередь и присутствие проверяются
 * на границах, до которых по HTTP не дотянуться: гонка двух одинаковых
 * запросов, падение между коммитом и отправкой, поздний `disconnect` старого
 * поколения. Такое воспроизводится только изнутри.
 *
 * И почему не на рабочей базе: проверки заводят и удаляют записи, а рабочая
 * база у владельца одна. Здесь каждый прогон получает свой файл SQLite и
 * сносит его за собой.
 *
 * Правила платформы держат частичные уникальные индексы, а SQLite их умеет —
 * значит, стенд проверяет те же правила, что и рабочая база на PostgreSQL, а
 * не их ослабленную копию.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setPrisma, setUserPush } from '../server/context';
import { setDialect } from '../server/ddl';
import { ensurePlayTables } from '../server/play/tables';

export interface Harness {
  prisma: any;
  dir: string;
  /** Что ушло бы в сокет: очередь толкает сюда, и это видно проверке */
  pushed: Array<{ userId: string; event: string; payload: any }>;
  close: () => Promise<void>;
}

/** Поднять пустую базу с таблицами платформы. */
export async function openHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'flux-play-'));
  const file = join(dir, 'play.sqlite');

  const { PrismaClient } = require('@prisma/client-sqlite');
  const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
  const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });

  setDialect('sqlite');
  setPrisma(prisma);

  const pushed: Harness['pushed'] = [];
  setUserPush((userId: string, event: string, payload: any) => { pushed.push({ userId, event, payload }); });

  // Схему создаёт та же страховка, что и в бою: проверять надо настоящие
  // таблицы с настоящими индексами, а не таблицы, написанные для проверки
  const failure = await ensurePlayTables(prisma, () => {});
  if (failure) throw new Error(failure);

  return {
    prisma,
    dir,
    pushed,
    close: async () => {
      try { await prisma.$disconnect(); } catch (_) { /* уже закрыт */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch (_) { /* уберётся системой */ }
    },
  };
}
