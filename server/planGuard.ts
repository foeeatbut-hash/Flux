/**
 * Сверка предпросмотра с базой при массовой записи (docs/roadmap/offline-work.md,
 * решения владельца 15 ноября 2026, п. 3 и п. 7).
 *
 * Предпросмотр (план) читал записи и собирается их менять или удалять. Пока
 * человек смотрел, коллега мог изменить или удалить часть из них. Молча писать
 * по такому предпросмотру нельзя: человек подтверждал не то, что окажется в базе.
 *
 * Договор. План несёт `seen: { [id]: version }` — целые версии записей, которые
 * он читал. Запись присылает `seen` обратно, а сервер в ТОЙ ЖЕ транзакции, до
 * первой записи, вызывает `assertSeenVersions`. Расхождение — `PlanChanged`, а
 * маршрут отвечает 409 `sendPlanChanged`: тот же вид, что у
 * `PUT /api/tags/bulk-metadata` (`code`, `changed: [{ id, current }]`, `gone`).
 * Бросок внутри транзакции откатывает и уже записанное: «всё или ничего».
 * Экран показывает перечень «было → стало» по записям, строит предпросмотр
 * заново и ждёт нового подтверждения.
 *
 * Запрос без `seen` (старая сборка клиента) принимается и сверяется только с
 * чтением сервера в собственной транзакции, как раньше: `assertSeenVersions`
 * при `seen === undefined` ничего не делает.
 *
 * Версия — целое `version` записи (server/versionBump.ts). Перенос карточки тега
 * версию не двигает, поэтому раскладка холста предпросмотр не ломает.
 */

import { VERSION_CONFLICT, bulkChangedText } from '../src/lib/refusalTexts.js';

/** Что план видел: идентификатор записи → её целая версия. */
export type SeenVersions = Record<string, number>;

/** Сколько записей разрешено сверять за раз (как у массовой записи тегов). */
export const SEEN_LIMIT = 5000;

/** Записей в одном запросе `id IN (...)`: переменных у SQLite меньше, чем у остальных баз. */
const CHUNK = 500;

/**
 * Часть записей, которые видел план, с тех пор изменили или удалили.
 * `current` — какой запись стала сейчас (целая строка базы, как у `VersionConflict`).
 */
export class PlanChanged extends Error {
  /** `message` — свой текст отказа для действия без предпросмотра (ввоз ВДР); по умолчанию — словарь отказов. */
  constructor(public readonly changed: Array<{ id: string; current: any }>, public readonly gone: string[], message?: string) {
    super(message ?? bulkChangedText());
    this.name = 'PlanChanged';
  }
}

/** `seen` в теле запроса нечитаем: маршрут отвечает 400, а не принимает его за «версий нет» и не пишет вслепую. */
export class BadSeen extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadSeen';
  }
}

/**
 * `seen` из тела запроса. `undefined` — не прислан (старый клиент). Прислан, но
 * не объект «идентификатор → целое ≥ 1», или записей больше `SEEN_LIMIT` —
 * `BadSeen`: молчаливый срез терял бы хвост сверки.
 */
export function seenOf(raw: unknown): SeenVersions | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadSeen('Версии записей присланы в нечитаемом виде. Ничего не записано.');
  const out: SeenVersions = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > SEEN_LIMIT) {
    throw new BadSeen(`За один раз можно сверить не больше ${SEEN_LIMIT} записей, прислано ${entries.length}. Ничего не записано — разбейте действие на части.`);
  }
  for (const [id, v] of entries) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
    if (!id || !Number.isSafeInteger(n) || n < 1) throw new BadSeen('Версии записей присланы в нечитаемом виде. Ничего не записано.');
    out[id] = n;
  }
  return out;
}

export interface SeenScope {
  /** Дополнительное условие чтения (проект): запись другого проекта чужой не отдаётся и считается отсутствующей. */
  where?: Record<string, unknown>;
  /** Поле версии в модели; по умолчанию `version`. */
  field?: string;
  /** Свой текст отказа (отмена действия); по умолчанию — текст предпросмотра. */
  message?: string;
  /**
   * Записи, которые запись собирается менять. Те из них, что плану не показывали
   * (нет в `seen`: появились после предпросмотра), — тоже отказ `changed`: молча
   * применять к тому, чего человек не видел, нельзя.
   */
  touched?: Iterable<string>;
}

/**
 * Сверка версий. Вызывать внутри транзакции, ДО первой записи: тогда запись
 * либо идёт по тому, что видел человек, либо не идёт совсем.
 *
 * Перечень полный: называются ВСЕ расходящиеся записи, а не первая, — экран
 * показывает их разом. Бросает `PlanChanged`; без `seen` ничего не делает.
 */
export async function assertSeenVersions(db: any, model: string, seen: SeenVersions | undefined, scope: SeenScope = {}): Promise<void> {
  if (!seen) return;
  const asked = Object.keys(seen);
  const touched = [...new Set(scope.touched ?? [])].filter((id) => !(id in seen));
  const ids = [...asked, ...touched];
  if (!ids.length) return;
  const field = scope.field ?? 'version';
  const rows = new Map<string, any>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const found = await db[model].findMany({ where: { ...(scope.where || {}), id: { in: part } } });
    for (const r of found) rows.set(String(r.id), r);
  }
  const changed: Array<{ id: string; current: any }> = [];
  const gone: string[] = [];
  for (const id of ids) {
    const cur = rows.get(id);
    if (!cur) { if (id in seen) gone.push(id); }
    else if (!(id in seen) || Number(cur[field]) !== seen[id]) changed.push({ id, current: cur });
  }
  if (changed.length || gone.length) throw new PlanChanged(changed, gone, scope.message);
}

type Res = { status: (code: number) => { json: (body: unknown) => unknown } };

/**
 * 409 `VERSION_CONFLICT` с перечнем `changed` / `gone` (вид `bulk-metadata`) или
 * 400 для нечитаемого `seen`. `true` — ответ дан; иначе ошибка не наша.
 * `present` — как показать запись в `current` (по умолчанию как есть).
 */
export function sendPlanRefusal(res: Res, e: unknown, present?: (record: any) => unknown): boolean {
  if (e instanceof PlanChanged) {
    res.status(409).json({
      error: e.message, code: VERSION_CONFLICT,
      changed: e.changed.map((c) => ({ id: c.id, current: present ? present(c.current) : c.current })),
      gone: e.gone,
    });
    return true;
  }
  if (e instanceof BadSeen) { res.status(400).json({ error: e.message }); return true; }
  return false;
}
