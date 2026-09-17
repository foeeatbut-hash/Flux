import type { Express, Request, Response } from 'express';
import { getPrisma, onDatabaseSwapped, sendError } from '../context.js';
import { ensureTables, type TableSpec } from '../ddl.js';
import { readTemplateBody, whyNotSaveTemplate } from '../../src/lib/tableLayout.js';

/**
 * Шаблоны шапки таблицы.
 *
 * Набор полей, сохранённый под именем: автоматчик собирает «Ведомость
 * автоматики» один раз и потом только применяет. Проекта у шаблона нет
 * намеренно — в этом весь смысл, иначе его пришлось бы переносить руками в
 * каждый следующий проект.
 *
 * Отдельным модулем, а не в constructor.ts: тот давно у предела размера, а
 * шаблоны — своя область со своим сроком жизни.
 */

/**
 * Таблица создаётся здесь же — страховка поверх автомиграции.
 *
 * `schema-sync` читает схему Prisma и создаёт таблицы с колонками, но индексов
 * не создаёт. Без индекса по `[scope, ownerId]` список шаблонов у каждого
 * открытия панели сканировал бы таблицу целиком.
 */
const TABLES: TableSpec[] = [
  {
    table: 'TableTemplate',
    cols: [
      { name: 'id', kind: 'text', pk: true, indexed: true },
      { name: 'name', kind: 'text', notNull: true },
      { name: 'scope', kind: 'text', notNull: true, def: 'SHARED', indexed: true },
      { name: 'ownerId', kind: 'text', indexed: true },
      { name: 'grain', kind: 'text', notNull: true, def: 'tag' },
      { name: 'columnsJson', kind: 'longtext', def: '[]' },
      { name: 'filtersJson', kind: 'longtext', def: '[]' },
      { name: 'createdById', kind: 'text' },
      { name: 'createdAt', kind: 'time', notNull: true, def: 'now' },
      { name: 'updatedAt', kind: 'time', notNull: true, def: 'now' },
    ],
    indexes: [{ name: 'TableTemplate_scope_ownerId_idx', cols: ['scope', 'ownerId'] }],
  },
];

let ready = false;
onDatabaseSwapped(() => { ready = false; });

async function ensure(prisma: any): Promise<void> {
  if (ready) return;
  await ensureTables(prisma, TABLES);
  ready = true;
}

const authUserOf = (req: Request) => (req as any).authUser || null;

/** Строка базы → шаблон для окна. Испорченный JSON не роняет список. */
function toTemplate(row: any) {
  const body = readTemplateBody(JSON.stringify({
    grain: row.grain,
    columns: safeArray(row.columnsJson),
    filters: safeArray(row.filtersJson),
  }));
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    ownerId: row.ownerId || null,
    ...body,
    updatedAt: row.updatedAt,
  };
}

function safeArray(raw: unknown): unknown[] {
  try {
    const parsed = JSON.parse(String(raw || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) { return []; }
}

export function registerTableTemplateRoutes(app: Express): void {
  /**
   * Список шаблонов.
   *
   * Общие видны всем, личные — только своему владельцу. Условие стоит внутри
   * запроса к базе, а не фильтром после выборки: забыть условие внутри запроса
   * нельзя, оно и есть запрос.
   */
  app.get('/api/table-templates', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
      const me = authUserOf(req);
      const rows = await prisma.tableTemplate.findMany({
        where: { OR: [{ scope: 'SHARED' }, { scope: 'PERSONAL', ownerId: me?.id || '—' }] },
        orderBy: [{ name: 'asc' }],
      });
      res.json({ templates: (rows as any[]).map(toTemplate) });
    } catch (err: any) { sendError(res, err); }
  });

  app.post('/api/table-templates', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
      const me = authUserOf(req);
      const body = (req.body || {}) as Record<string, unknown>;
      const name = String(body.name || '').trim().slice(0, 200);
      const personal = String(body.scope || 'SHARED') === 'PERSONAL';

      // Та же проверка, что и в окне: окно не должно быть единственным местом,
      // где её знают, — до сервера доходят и старые клиенты
      const columns = safeArray(body.columns);
      const why = whyNotSaveTemplate(name, {
        grain: String(body.grain || 'tag'), headerRow: 0, filters: [],
        columns: columns as any[],
      });
      if (why) return res.status(400).json({ error: why });

      const row = await prisma.tableTemplate.create({
        data: {
          name,
          scope: personal ? 'PERSONAL' : 'SHARED',
          // Личность — из сессии, а не из запроса: иначе чужой шаблон можно
          // объявить своим и спрятать его от остальных
          ownerId: personal ? (me?.id || null) : null,
          grain: String(body.grain || 'tag'),
          columnsJson: JSON.stringify(columns),
          filtersJson: JSON.stringify(safeArray(body.filters)),
          createdById: me?.id || null,
        },
      });
      res.json({ template: toTemplate(row) });
    } catch (err: any) { sendError(res, err); }
  });

  /**
   * Удаление.
   *
   * Личный шаблон удаляет только владелец. Общий — любой, кто до него добрался:
   * он и заведён как общий инструмент, и прятать его за отдельным правом
   * означало бы, что поправить опечатку в имени некому.
   */
  app.delete('/api/table-templates/:id', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
      const me = authUserOf(req);
      const row = await prisma.tableTemplate.findUnique({ where: { id: req.params.id } });
      if (!row) return res.json({ ok: true });
      if (row.scope === 'PERSONAL' && row.ownerId !== (me?.id || '')) {
        return res.status(403).json({ error: 'Это личный шаблон другого сотрудника' });
      }
      await prisma.tableTemplate.delete({ where: { id: row.id } });
      res.json({ ok: true });
    } catch (err: any) { sendError(res, err); }
  });
}
