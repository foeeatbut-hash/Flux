import { createHash } from 'node:crypto';

type ProjectEntityKind = 'EQ' | 'TAG' | 'SYS' | 'MB' | 'DICT';
type IdDelegate = { findUnique(args: any): Promise<any> };
export type EntityIdOptions = { inTransaction?: boolean };

const COUNTER_PREFIX = '__flux_entity_id_counter__';
const RETRIES = 32;
const MAX_COLLISIONS = 100_000;

export class EntityIdAllocationConflict extends Error {
  readonly code = 'ENTITY_ID_RETRY_REQUIRED';
  constructor() {
    super('Счётчик ID занят параллельной записью; повторите операцию.');
    this.name = 'EntityIdAllocationConflict';
  }
}

function counterIdentity(prefix: string, scope: string): { id: string; key: string } {
  const key = `${COUNTER_PREFIX}:${prefix}:${scope}`;
  // Короткий служебный ID не зависит от длины старого projectId.
  const digest = createHash('sha256').update(key).digest('hex');
  return { id: `${COUNTER_PREFIX}:${digest}`, key };
}

function candidate(prefix: string, sequence: number, projectId?: string): string {
  const serial = String(sequence).padStart(6, '0');
  return projectId ? `${projectId}-${prefix}-${serial}` : `${prefix}-${serial}`;
}

function shouldRetry(error: any): boolean {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  return code === 'P2034' || code === 'P2002' || code === 'P1008' || code === 'ENTITY_ID_RETRY_REQUIRED' || /database is locked|deadlock|serialization failure|timed out/i.test(message);
}

async function standalone<T>(db: any, operation: (tx: any) => Promise<T>, options?: EntityIdOptions): Promise<T> {
  // Prisma interactive transaction clients may still expose a `$transaction`
  // method, and lightweight test/provider wrappers often do as well. Callers
  // that already own the transaction must opt in explicitly to avoid nesting.
  if (options?.inTransaction) return operation(db);
  if (typeof db?.$transaction !== 'function') return operation(db);
  let last: unknown;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      return await db.$transaction(operation, { isolationLevel: 'Serializable' });
    } catch (error) {
      last = error;
      if (!shouldRetry(error) || attempt === RETRIES - 1) throw error;
    }
  }
  throw last;
}

/** Выделить следующий ID; переданный транзакционный клиент сохраняет запись счётчика вместе с создаваемой сущностью. */
async function allocate(
  db: any,
  prefix: string,
  scope: string,
  projectId: string | undefined,
  table: string,
): Promise<string> {
  const { id, key } = counterIdentity(prefix, scope);
  const delegate = db?.[table] as IdDelegate | undefined;
  if (!delegate?.findUnique) throw new Error(`Не настроен генератор ID для ${table}.`);

  // AppSetting уже есть во всех трёх схемах. Фиксированный PK устраняет гонку
  // первого запуска даже в MariaDB, где UNIQUE с NULL ведёт себя иначе.
  await db.appSetting.upsert({
    where: { id },
    create: { id, key, userId: null, value: '0' },
    update: {},
  });
  const row = await db.appSetting.findUnique({ where: { id } });
  if (!row || row.key !== key || row.userId !== null) throw new Error('Служебный счётчик ID занят другой настройкой.');

  let value = Number(row.value);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Счётчик ID повреждён; новые записи остановлены.');

  for (let collision = 0; collision < MAX_COLLISIONS; collision++) {
    const next = value + 1;
    if (!Number.isSafeInteger(next)) throw new Error('В счётчике ID закончились безопасные номера.');
    const changed = await db.appSetting.updateMany({
      where: { id, key, userId: null, value: String(value) },
      data: { value: String(next) },
    });
    if (changed.count !== 1) {
      // Сравнение старого значения не даёт двум серверам выдать один номер.
      // Если транзакция получила старый снимок и не видит новое значение,
      // её провайдер должен оборвать её; внешний вызов повторит всю транзакцию.
      const latest = await db.appSetting.findUnique({ where: { id } });
      if (!latest || latest.key !== key || latest.userId !== null) throw new Error('Служебный счётчик ID исчез или изменён.');
      const latestValue = Number(latest.value);
      if (!Number.isSafeInteger(latestValue) || latestValue < value) throw new Error('Счётчик ID повреждён; новые записи остановлены.');
      if (latestValue === value) throw new EntityIdAllocationConflict();
      value = latestValue;
      continue;
    }

    const idValue = candidate(prefix, next, projectId);
    if (!(await delegate.findUnique({ where: { id: idValue }, select: { id: true } }))) return idValue;
    // Старый или вручную заданный ID может совпасть с очередью. Номер уже
    // потрачен, поэтому удаление строки никогда не выдаст ID повторно.
    value = next;
  }
  throw new Error(`Не удалось найти свободный ID с префиксом ${prefix}.`);
}

/** ID проекта: общий счётчик базы, не зависящий от проекта. */
export async function nextProjectId(db: any, options?: EntityIdOptions): Promise<string> {
  return standalone(db, tx => allocate(tx, 'PRJ', 'global', undefined, 'project'), options);
}

/** ID пяти программных сущностей, чьи записи принадлежат проекту. */
export async function nextProjectEntityId(db: any, projectId: string, kind: ProjectEntityKind, options?: EntityIdOptions): Promise<string> {
  const table: Record<ProjectEntityKind, string> = {
    EQ: 'componentElement', TAG: 'tag', SYS: 'equipmentSystem', MB: 'monoblock', DICT: 'dictionary',
  };
  if (!projectId) throw new Error('Для ID сущности нужен projectId.');
  if (!(await db.project?.findUnique?.({ where: { id: projectId }, select: { id: true } }))) {
    throw new Error('Проект не найден; нельзя выдать ему ID сущности.');
  }
  return standalone(db, tx => allocate(tx, kind, projectId, projectId, table[kind]), options);
}

/** ID строки словаря остаётся в области проекта и разделяет корни полей с обычными значениями. */
export async function nextFieldId(db: any, projectId: string, isConfigRoot: boolean, options?: EntityIdOptions): Promise<string> {
  if (!projectId) throw new Error('Для ID поля нужен projectId.');
  if (!(await db.project?.findUnique?.({ where: { id: projectId }, select: { id: true } }))) {
    throw new Error('Проект не найден; нельзя выдать ему ID поля.');
  }
  const prefix = isConfigRoot ? 'FLD' : 'DI';
  return standalone(db, tx => allocate(tx, prefix, projectId, projectId, 'dictionaryItem'), options);
}
