/**
 * Ключ кода тега (`Tag.codeKey`): защита от двух тегов с одним кодом в проекте.
 *
 * Зачем. Проверка «код свободен» читала теги и сравнивала в JS (`assertFreeTagCode`),
 * а запись шла отдельным запросом: два одновременных создания, два окна или
 * два сервера общей базы проходили проверку оба и заводили два тега с одним
 * кодом. Держит уникальность теперь база: `@@unique([projectId, codeKey])`.
 * Проверка в коде осталась ранним понятным отказом, но защитой считается ключ.
 *
 * Одно правило ключа на всех — `identityKeyOf` (NFC, пробелы по краям, нижний
 * регистр): им же сравнивают коды реестр тегов, импорт оборудования и ВДР.
 * Второе правило рядом дало бы тег, который одна проверка считает свободным,
 * а другая занятым.
 *
 * Старые повторы. В базах, где два тега с одним кодом уже есть, ключ получает
 * только самый старый из них; остальные остаются с NULL (NULL в уникальном
 * ключе не конфликтует). Ничего не удаляется и не переименовывается: решает
 * человек, а число оставшихся повторов — в журнале и в `tagCodeRepeats`.
 */

import { identityKeyOf } from '../equipment/tagPolicy.js';

/** Ключ кода тега — то же правило, что у `identityKeyOf`. */
export const tagCodeKey = (identifier: unknown): string => identityKeyOf(String(identifier ?? ''));

/** Код тега уже занят в проекте: два тега с одним кодом смешивают позиции в спецификации и документах. */
export class TagDuplicate extends Error {
  /** Обработчики вида `sendError(res, err, err.status || 500)` отвечают этим кодом сами */
  readonly status = 409;
  constructor(public readonly identifier: string, public readonly existing?: { id: string; identifier: string } | null) {
    super(`Тег «${identifier}» уже заведён в этом проекте. Укажите другой код.`);
  }
}

/** Данные записи тега с ключом кода: единственное место, где `codeKey` выводится из `identifier`. */
export function withCodeKey<T extends { identifier?: unknown }>(data: T): T & { codeKey?: string } {
  return 'identifier' in data && data.identifier !== undefined ? { ...data, codeKey: tagCodeKey(data.identifier) } : data;
}

/** Нарушен именно ключ кода (а не, например, первичный ключ): P2002 с колонкой codeKey или именем ключа. */
export function isCodeKeyViolation(err: any): boolean {
  if (err?.code !== 'P2002') return false;
  let where = '';
  try { where = `${JSON.stringify(err.meta ?? {})} ${String(err.message ?? '')}`; } catch { where = String(err.message ?? ''); }
  return /codeKey/i.test(where);
}

/**
 * Тег проекта с таким кодом: по написанию и по ключу. Ключ ловит другой
 * регистр и NFD-запись, написание — старый повтор, у которого ключа нет.
 */
export function findTagByCode(db: any, projectId: string, code: string, include?: Record<string, unknown>): Promise<any | null> {
  return db.tag.findFirst({ where: { projectId, OR: [{ codeKey: tagCodeKey(code) }, { identifier: code }] }, ...(include ? { include } : {}) });
}
/** Все теги проекта с таким кодом (старые повторы без ключа в том числе). */
export function findTagsByCode(db: any, projectId: string, code: string, include?: Record<string, unknown>): Promise<any[]> {
  return db.tag.findMany({ where: { projectId, OR: [{ codeKey: tagCodeKey(code) }, { identifier: code }] }, ...(include ? { include } : {}) });
}

/**
 * Нарушение ключа кода → `TagDuplicate` с занявшим тегом; любая другая ошибка
 * возвращается как есть. Занявший читается отдельным запросом: транзакция,
 * в которой ключ нарушен, к этому времени уже отменена.
 */
export async function duplicateOf(db: any, err: unknown, projectId: string, identifier: unknown): Promise<unknown> {
  if (err instanceof TagDuplicate || !isCodeKeyViolation(err)) return err;
  const code = String(identifier ?? '').trim();
  let existing: { id: string; identifier: string } | null = null;
  try {
    const row = await db.tag.findFirst({ where: { projectId, codeKey: tagCodeKey(code) }, select: { id: true, identifier: true } });
    if (row) existing = { id: String(row.id), identifier: String(row.identifier) };
  } catch { /* без занявшего отказ остаётся отказом */ }
  return new TagDuplicate(code, existing);
}

// ── Заполнение ключа у существующих тегов ──────────────────────────────────

type Dialect = 'postgresql' | 'mysql' | 'sqlite';
interface RawDb {
  $queryRawUnsafe(sql: string, ...values: any[]): Promise<any[]>;
  $executeRawUnsafe(sql: string, ...values: any[]): Promise<any>;
}

const q = (d: Dialect, id: string): string => (d === 'mysql' ? `\`${id}\`` : `"${id}"`);
const param = (d: Dialect, n: number): string => (d === 'postgresql' ? `$${n}` : '?');

/** Момент создания из любого вида, в котором его отдаёт база: Date, мс, строка (SQLite — в UTC). */
function millis(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  const s = String(v ?? '');
  const t = Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
  return Number.isNaN(t) ? 0 : t;
}

interface Row { id: string; projectId: string; identifier: string; codeKey: string | null; at: number }

async function readTags(db: RawDb, d: Dialect): Promise<Row[]> {
  const rows = await db.$queryRawUnsafe(
    `SELECT ${['id', 'projectId', 'identifier', 'codeKey', 'createdAt'].map((c) => q(d, c)).join(', ')} FROM ${q(d, 'Tag')}`,
  );
  // Порядок «старый первым» считаем здесь: в SQLite даты лежат и числами, и строками, и SQL-порядок их смешал бы
  return rows.map((r) => ({
    id: String(r.id), projectId: String(r.projectId), identifier: String(r.identifier ?? ''),
    codeKey: r.codeKey == null ? null : String(r.codeKey), at: millis(r.createdAt),
  })).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const slot = (projectId: string, key: string): string => `${projectId}\u0000${key}`;

/**
 * Поставить ключ тегам, у которых его нет. Первому в группе [проект, ключ]
 * (по createdAt, затем id) — ключ, остальным повторам — NULL, как было.
 * Идемпотентно: занятый ключ не перезаписывается, повторный запуск ничего не
 * меняет. Ничего не удаляет. Возвращает, сколько ключей поставлено и сколько
 * повторов осталось без ключа.
 */
export async function backfillTagCodeKeys(db: RawDb, d: Dialect, log: (m: string) => void = () => {}): Promise<{ filled: number; repeats: number }> {
  let rows: Row[];
  try { rows = await readTags(db, d); } catch (e: any) {
    log(`[Tag codeKey] Колонка не прочитана, заполнение пропущено: ${e?.message || e}`);
    return { filled: 0, repeats: 0 };
  }
  const taken = new Set(rows.filter((r) => r.codeKey !== null).map((r) => slot(r.projectId, r.codeKey!)));
  let filled = 0, repeats = 0;
  for (const r of rows) {
    if (r.codeKey !== null) continue;
    const key = tagCodeKey(r.identifier);
    if (taken.has(slot(r.projectId, key))) { repeats++; continue; }
    try {
      await db.$executeRawUnsafe(`UPDATE ${q(d, 'Tag')} SET ${q(d, 'codeKey')} = ${param(d, 1)} WHERE ${q(d, 'id')} = ${param(d, 2)} AND ${q(d, 'codeKey')} IS NULL`, key, r.id);
      taken.add(slot(r.projectId, key));
      filled++;
    } catch (e: any) {
      // Ключ успел занять другой процесс: этот тег — повтор, а не повод падать на старте
      repeats++;
      log(`[Tag codeKey] Тег ${r.id} («${r.identifier}») остался без ключа: ${e?.message || e}`);
    }
  }
  if (filled || repeats) log(`[Tag codeKey] Ключей кода поставлено: ${filled}; повторов кода без ключа: ${repeats} (теги не тронуты, показывает tagCodeRepeats).`);
  return { filled, repeats };
}

export interface TagCodeRepeat {
  projectId: string;
  key: string;
  /** Тег, у которого ключ есть */
  keeper: { id: string; identifier: string } | null;
  /** Старые повторы с тем же ключом, у которых ключа нет */
  repeats: Array<{ id: string; identifier: string }>;
}

/** Отчёт о повторах кода: только чтение, ничего не меняет. */
export async function tagCodeRepeats(db: RawDb, d: Dialect): Promise<TagCodeRepeat[]> {
  const rows = await readTags(db, d);
  const groups = new Map<string, TagCodeRepeat>();
  for (const r of rows) {
    const key = r.codeKey !== null ? r.codeKey : tagCodeKey(r.identifier);
    const g = groups.get(slot(r.projectId, key)) || { projectId: r.projectId, key, keeper: null, repeats: [] };
    if (r.codeKey !== null) g.keeper = { id: r.id, identifier: r.identifier };
    else g.repeats.push({ id: r.id, identifier: r.identifier });
    groups.set(slot(r.projectId, key), g);
  }
  // Группа без ключа вообще (до заполнения) — повтор, только если в ней больше одного тега
  return [...groups.values()].filter((g) => (g.keeper ? g.repeats.length > 0 : g.repeats.length > 1));
}
