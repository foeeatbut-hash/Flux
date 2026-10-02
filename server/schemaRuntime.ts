import { createHash } from 'node:crypto';
import { onDatabaseSwapped } from './context.js';
import type { Dialect } from './ddl.js';

export interface SchemaConnection {
  $queryRawUnsafe(sql: string, ...values: any[]): Promise<any[]>;
  $executeRawUnsafe(sql: string, ...values: any[]): Promise<any>;
}

type Coordinator = <T>(work: (connection: SchemaConnection) => Promise<T>) => Promise<T>;
const clients = new WeakMap<object, { dialect: Dialect; coordinate?: Coordinator }>();
let generation = 0;
onDatabaseSwapped(() => { generation++; });

/** Даже временная проверка подключения не должна менять диалект работающего клиента. */
export function registerSchemaClient(prisma: object, dialect: Dialect, coordinate?: Coordinator): void {
  clients.set(prisma, { dialect, coordinate });
}
export function clientDialect(prisma: object, fallback: Dialect): Dialect {
  return clients.get(prisma)?.dialect || fallback;
}

interface Preparation {
  generation: number;
  jobs: Map<string, Promise<any>>;
}
let preparations = new WeakMap<object, Preparation>();
export function resetSchemaPreparations(prisma?: object): void {
  if (prisma) preparations.delete(prisma);
  else preparations = new WeakMap();
}

/** Ошибка не кэшируется; завершение старой базы не отмечает новую готовой. */
export function oncePerDatabase<T>(prisma: object, key: string, work: () => Promise<T>): Promise<T> {
  let state = preparations.get(prisma);
  if (!state || state.generation !== generation) {
    state = { generation, jobs: new Map() };
    preparations.set(prisma, state);
  }
  const existing = state.jobs.get(key);
  if (existing) return existing;
  const captured = state;
  const pending = Promise.resolve().then(work).catch(error => {
    if (captured.jobs.get(key) === pending) captured.jobs.delete(key);
    throw error;
  });
  state.jobs.set(key, pending);
  return pending;
}

export async function withSchemaConnection<T>(prisma: SchemaConnection, work: (connection: SchemaConnection) => Promise<T>): Promise<T> {
  const coordinate = clients.get(prisma)?.coordinate;
  return coordinate ? coordinate(work) : work(prisma);
}

/**
 * GET_LOCK принадлежит физическому соединению. Через пул Prisma его брать
 * нельзя: RELEASE_LOCK попал бы на другой сокет, а DDL работал бы без защиты.
 * Весь DDL и освобождение идут на одном соединении; end снимает блокировку
 * и при отказе RELEASE_LOCK. Адрес и пароль остаются только в замыкании.
 */
export function mariaDbSchemaCoordinator(connect: () => Promise<any>): Coordinator {
  return async work => {
    const connection = await connect();
    let lockName = '';
    let acquired = false;
    try {
      const rows = await connection.query('SELECT DATABASE() AS db');
      if (!rows[0]?.db) throw new Error('Для подготовки схемы нужно выбрать базу данных.');
      lockName = `flux:schema:${createHash('sha256').update(String(rows[0].db)).digest('hex').slice(0, 48)}`;
      const lock = await connection.query('SELECT GET_LOCK(?, 60) AS acquired', [lockName]);
      if (Number(lock[0]?.acquired) !== 1) throw new Error('Подготовка схемы занята другим экземпляром Flux. Повторите запрос.');
      acquired = true;
      return await work({
        $queryRawUnsafe: (sql, ...values) => connection.query(sql, values),
        $executeRawUnsafe: async (sql, ...values) => (await connection.query(sql, values)).affectedRows || 0,
      });
    } finally {
      try {
        if (acquired) await connection.query('SELECT RELEASE_LOCK(?) AS released', [lockName]);
      } finally {
        await connection.end();
      }
    }
  };
}

/** PostgreSQL CREATE IF NOT EXISTS не защищает от одновременного CREATE типа таблицы. */
export function postgresSchemaCoordinator(connect: () => Promise<any>): Coordinator {
  return async work => {
    const connection = await connect();
    const key = "hashtextextended(current_database() || ':' || current_schema() || ':flux-schema', 0)";
    let acquired = false;
    try {
      await connection.query("SELECT set_config('lock_timeout', '60s', false)");
      await connection.query(`SELECT pg_advisory_lock(${key})`);
      acquired = true;
      return await work({
        $queryRawUnsafe: async (sql, ...values) => (await connection.query(sql, values)).rows,
        $executeRawUnsafe: async (sql, ...values) => (await connection.query(sql, values)).rowCount || 0,
      });
    } finally {
      try {
        if (acquired) await connection.query(`SELECT pg_advisory_unlock(${key})`);
      } finally { await connection.end(); }
    }
  };
}
