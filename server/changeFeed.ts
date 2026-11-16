/**
 * Журнал изменений: каждая запись версионной модели оставляет строку в
 * `ChangeFeed` В ТОЙ ЖЕ ТРАНЗАКЦИИ (docs/roadmap/offline-work.md, 1).
 *
 * Почему не просто хук `query`. Хук расширения Prisma получает только
 * `{ model, operation, args, query }` — клиента транзакции вызывающего у него
 * нет. Запись «в другую таблицу» через клиент из замыкания идёт по другому
 * соединению: на PostgreSQL и MariaDB она переживает откат (проверено опытом),
 * а на SQLite откатывается лишь потому, что у адаптера одно соединение. Поэтому:
 *
 *  • `$transaction(async (tx) => …)` обёрнут: клиент транзакции кладётся в
 *    AsyncLocalStorage, и хук пишет журнал через него;
 *  • одиночная запись вне транзакции хук сам выполняет в короткой транзакции
 *    вместе со строкой журнала;
 *  • запись версионной модели в пакетной `$transaction([…])` или по внешнему
 *    клиенту внутри открытой транзакции — громкая ошибка: молча потерять строку
 *    или записать её мимо транзакции хуже отказа. Состояние транзакции хук
 *    читает из `__internalParams.transaction` (поле не документировано, поэтому
 *    только читается — для проверки, писать через него нельзя).
 *
 * Хук стоит в цепочке ПЕРВЫМ (снаружи роста версии и наблюдения): он видит метку
 * `keepVersion` в данных и один раз перенаправляет одиночный запрос в транзакцию.
 *
 * Что пишется: create/createMany/createManyAndReturn — `create`; update/
 * updateMany/updateManyAndReturn/upsert (ветка update) — `update`; delete/
 * deleteMany — `delete`. `updateMany` и `deleteMany` сначала выбирают записи
 * (они не возвращают id). Запись с `keepVersion` в журнал не идёт: версия не
 * менялась — коллеге нечего перечитывать.
 *
 * Автор — из запроса: звено `/api/*` ставит его через `runWithActor`; вне
 * запроса (старт, фоновые задачи) автора нет — «система».
 *
 * Мимо хука идут сырой SQL, вложенные записи (`data: { x: { update } }`) и
 * каскад базы — список в храповике scripts/test-architecture.ts. Каскады
 * проекта и пункта справочника пишут удаление детей сами явными deleteMany
 * (server/projectDelete.ts, server/routes/dictionaries.ts): хук видит их.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { VERSIONED_MODELS, keepsVersion } from './versionBump.js';
import { delegateOf, projectIdsOf, scopeField } from './changeFeedScope.js';

export type FeedKind = 'create' | 'update' | 'delete';

/** Кто пишет: пусто — «система» (старт, фоновая задача, проверка) */
export interface FeedActor { userId: string | null; userName: string }

const actorStore = new AsyncLocalStorage<FeedActor>();
/** Клиент открытой интерактивной транзакции: через него хук пишет строку журнала */
const txStore = new AsyncLocalStorage<{ tx: any }>();

/** Выполнить `fn` от имени человека: все записи внутри (в том числе после `await`) помечаются им. */
export function runWithActor<T>(actor: FeedActor, fn: () => T): T {
  return actorStore.run(actor, () => {
    const result: any = fn();
    // Запрос Prisma ленив: его «then» вызовет тот, кто ждёт результат, — уже вне хранилища. Дожидаемся внутри
    return (result && typeof result.then === 'function' ? (async () => await result)() : result) as T;
  });
}

/** Кто пишет сейчас; вне запроса — «система». */
export const currentActor = (): FeedActor => actorStore.getStore() ?? { userId: null, userName: '' };

/** Ошибка устройства, а не пользователя: запись версионной модели обошла журнал. */
export class ChangeFeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChangeFeedError';
  }
}

/** Срок хранения; `create` не стираются никогда — по ним показывается автор */
export const FEED_KEEP_DAYS = 90;

interface FeedState { enabled: boolean }
const states = new WeakMap<object, FeedState>();

const tracked = (model: string | undefined): model is string => !!model && VERSIONED_MODELS.includes(model);
const CHUNK = 400;
/** Запись вне транзакции может ждать длинную чужую (удаление проекта идёт минуты) */
const SINGLE_TX = { maxWait: 60_000, timeout: 60_000 };

const isEmpty = (data: any) => !!data && typeof data === 'object' && Object.keys(data).length === 0;

/** Поля, без которых строку журнала не собрать (если вызывающий сузил ответ `select`/`omit`) */
const neededFields = (model: string): string[] => ['id', 'version', scopeField(model)].filter(Boolean) as string[];

/**
 * Дополнить `select`/`omit` нужными полями; `strip` вернёт ответ в форме, которую просили.
 * Без `select` и `omit` Prisma и так отдаёт все скалярные поля.
 */
function widen(model: string, args: any): { args: any; strip: (r: any) => any } {
  const added: string[] = [];
  let next = args;
  if (args?.select) {
    const select = { ...args.select };
    for (const f of neededFields(model)) if (!select[f]) { select[f] = true; added.push(f); }
    next = { ...args, select };
  } else if (args?.omit) {
    const omit = { ...args.omit };
    for (const f of neededFields(model)) if (omit[f]) { delete omit[f]; added.push(f); }
    next = { ...args, omit };
  }
  if (!added.length) return { args: next, strip: (r) => r };
  const one = (r: any) => {
    if (!r || typeof r !== 'object') return r;
    const copy = { ...r };
    for (const f of added) delete copy[f];
    return copy;
  };
  return { args: next, strip: (r) => (Array.isArray(r) ? r.map(one) : one(r)) };
}

interface Entry { row: any; kind: FeedKind }

/** Записать строки журнала через клиент транзакции. Ошибка летит наверх и откатывает запись. */
async function feed(tx: any, model: string, entries: Entry[]): Promise<void> {
  if (!entries.length) return;
  const actor = currentActor();
  const projects = await projectIdsOf(tx, model, entries.map((e) => e.row));
  const data = entries.map(({ row, kind }) => ({
    projectId: projects.get(String(row.id)) ?? null,
    model,
    recordId: String(row.id),
    version: typeof row.version === 'number' ? row.version : 1,
    kind,
    userId: actor.userId,
    userName: actor.userName,
  }));
  for (let i = 0; i < data.length; i += CHUNK) await tx.changeFeed.createMany({ data: data.slice(i, i + CHUNK) });
}

/** Прочитать записи по условию в нужной для журнала форме (id, версия, поле проекта) */
const pick = (tx: any, model: string, where: any) =>
  tx[delegateOf(model)].findMany({ where, select: Object.fromEntries(neededFields(model).map((f) => [f, true])) });

/** Версии записей после правки: `updateMany` их не возвращает */
async function versionsOf(tx: any, model: string, rows: any[]): Promise<any[]> {
  const out: any[] = [];
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const ids = [...byId.keys()];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const fresh = await tx[delegateOf(model)].findMany({ where: { id: { in: ids.slice(i, i + CHUNK) } }, select: { id: true, version: true } });
    for (const f of fresh) out.push({ ...byId.get(String(f.id)), version: f.version });
  }
  return out;
}

/** Одна операция внутри транзакции `tx`: сама запись через `query` и строки журнала через `tx` */
async function recorded(tx: any, model: string, op: string, args: any, query: (a: any) => Promise<any>): Promise<any> {
  switch (op) {
    case 'create': {
      const w = widen(model, args);
      const r = await query(w.args);
      await feed(tx, model, [{ row: r, kind: 'create' }]);
      return w.strip(r);
    }
    case 'createMany': {
      // Id нужен журналу, а createMany их не возвращает: назначаем сами (в схеме они — uuid)
      const many = Array.isArray(args.data);
      const rows: any[] = (many ? args.data : [args.data]).map((r: any) => (r?.id ? r : { ...r, id: randomUUID() }));
      let existing = new Set<string>();
      if (args.skipDuplicates) {
        const ids = rows.map((r) => String(r.id));
        for (let i = 0; i < ids.length; i += CHUNK) {
          for (const f of await tx[delegateOf(model)].findMany({ where: { id: { in: ids.slice(i, i + CHUNK) } }, select: { id: true } })) existing.add(String(f.id));
        }
      }
      const r = await query({ ...args, data: many ? rows : rows[0] });
      await feed(tx, model, rows.filter((x) => !existing.has(String(x.id))).map((row) => ({ row, kind: 'create' as const })));
      return r;
    }
    case 'createManyAndReturn': {
      const w = widen(model, args);
      const r = await query(w.args);
      await feed(tx, model, (r as any[]).map((row) => ({ row, kind: 'create' as const })));
      return w.strip(r);
    }
    case 'update': {
      if (keepsVersion(args.data)) return query(args);
      const w = widen(model, args);
      const r = await query(w.args);
      await feed(tx, model, [{ row: r, kind: 'update' }]);
      return w.strip(r);
    }
    case 'updateMany': {
      if (keepsVersion(args.data)) return query(args);
      const before = await pick(tx, model, args.where);
      const r = await query(args);
      if (before.length) await feed(tx, model, (await versionsOf(tx, model, before)).map((row) => ({ row, kind: 'update' as const })));
      return r;
    }
    case 'updateManyAndReturn': {
      if (keepsVersion(args.data)) return query(args);
      const w = widen(model, args);
      const r = await query(w.args);
      await feed(tx, model, (r as any[]).map((row) => ({ row, kind: 'update' as const })));
      return w.strip(r);
    }
    case 'upsert': {
      const found = await tx[delegateOf(model)].findUnique({ where: args.where, select: { id: true } });
      const w = widen(model, args);
      const r = await query(w.args);
      // Пустой `update` («создай, если нет») и keepVersion версию не двигают — и журнал не пишут
      if (!found) await feed(tx, model, [{ row: r, kind: 'create' }]);
      else if (!isEmpty(args.update) && !keepsVersion(args.update)) await feed(tx, model, [{ row: r, kind: 'update' }]);
      return w.strip(r);
    }
    case 'delete': {
      const w = widen(model, args);
      const r = await query(w.args);
      await feed(tx, model, [{ row: r, kind: 'delete' }]);
      return w.strip(r);
    }
    case 'deleteMany': {
      const before = await pick(tx, model, args.where);
      const r = await query(args);
      await feed(tx, model, before.map((row: any) => ({ row, kind: 'delete' as const })));
      return r;
    }
    default:
      return query(args);
  }
}

const OPERATIONS = ['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany'] as const;

/**
 * Клиент с журналом изменений. `build` достраивает цепочку расширений
 * (рост версии, наблюдение) ВНУТРИ хука журнала: хук стоит первым и перенаправляет
 * одиночную запись в транзакцию на готовом клиенте — так рост версии и наблюдение
 * отрабатывают один раз. Не получилось расширить — ошибка, а не молчание.
 */
export function withChangeFeed<T>(client: T, build: (inner: T) => T = (c) => c): T {
  if (typeof (client as any)?.$extends !== 'function') {
    throw new Error('Клиент базы не умеет расширения: журнал изменений не будет писаться.');
  }
  const state: FeedState = { enabled: true };
  let final: any = null;

  const hooks: Record<string, (p: any) => Promise<any>> = {};
  for (const op of OPERATIONS) {
    hooks[op] = async ({ model, args, query, __internalParams }: any) => {
      if (!state.enabled || !tracked(model)) return query(args);
      const transaction = __internalParams?.transaction;
      const store = txStore.getStore();
      if (!transaction) {
        if (store) {
          throw new ChangeFeedError(`Запись ${model}.${op} по внешнему клиенту внутри открытой транзакции: журнал изменений и сама запись окажутся в разных транзакциях. Пишите через клиент транзакции (tx).`);
        }
        // Одиночная запись: сама запись и строка журнала — одна короткая транзакция
        // (обёртка `$transaction` ниже сама кладёт клиент транзакции в хранилище)
        // (`await` обязателен: запрос Prisma ленив и без него выполнится уже вне хранилища)
        return final.$transaction(async (tx: any) => await tx[delegateOf(model)][op](args), SINGLE_TX);
      }
      if (transaction.kind !== 'itx') {
        throw new ChangeFeedError(`Запись ${model}.${op} в пакетной $transaction([…]): журнал изменений в неё не попадёт. Используйте $transaction(async (tx) => …).`);
      }
      if (!store) {
        throw new ChangeFeedError(`Запись ${model}.${op} в транзакции, открытой мимо обёртки клиента: журнал изменений не получит клиент транзакции.`);
      }
      return recorded(store.tx, model, op, args, query);
    };
  }

  const extended = (client as any).$extends({ name: 'flux-change-feed', query: { $allModels: hooks } });
  final = build(extended as T);
  const proxy = new Proxy(final, {
    get(target: any, prop: string | symbol) {
      if (prop === '$transaction') {
        return (arg: any, options?: any) => (typeof arg === 'function'
          ? target.$transaction((tx: any) => txStore.run({ tx }, async () => await arg(tx)), options)
          : target.$transaction(arg, options));
      }
      const value = target[prop];
      return typeof value === 'function' && typeof prop === 'string' && prop.startsWith('$') ? value.bind(target) : value;
    },
  }) as T;
  states.set(proxy as any, state);
  // Клиент, на котором считает хук, — сам прокси: транзакция одиночной записи обёрнута так же
  final = proxy;
  return proxy;
}

/**
 * Подготовка журнала после приведения схемы базы к версии программы: проверить,
 * что таблица есть, и стереть строки старше 90 дней (кроме `create`). Таблицы нет —
 * журнал выключается ГРОМКО (запись в лог), а работа идёт как раньше: в PostgreSQL
 * сбойный запрос отравил бы всю транзакцию, и каждая правка отказывала бы. Возвращает,
 * включён ли журнал.
 */
export async function prepareChangeFeed(client: any, log: (m: string) => void = () => {}, now = Date.now()): Promise<boolean> {
  const state = states.get(client);
  if (!state) return false;
  try {
    await client.changeFeed.findFirst({ select: { seq: true } });
  } catch (e: any) {
    state.enabled = false;
    log(`[Журнал изменений] ВЫКЛЮЧЕН: таблицы ChangeFeed нет или она не читается (${e?.message || e}). Записи работают без журнала.`);
    return false;
  }
  state.enabled = true;
  try {
    const gone = await client.changeFeed.deleteMany({ where: { at: { lt: new Date(now - FEED_KEEP_DAYS * 86_400_000) }, NOT: { kind: 'create' } } });
    if (gone.count) log(`[Журнал изменений] очистка: удалено ${gone.count} строк старше ${FEED_KEEP_DAYS} дней`);
  } catch (e: any) {
    log(`[Журнал изменений] очистка не удалась: ${e?.message || e}`);
  }
  return true;
}

/** Включён ли журнал на этом клиенте (проверки) */
export const changeFeedEnabled = (client: any): boolean => states.get(client)?.enabled ?? false;
