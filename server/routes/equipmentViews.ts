import type { Express, Request, Response } from 'express';
import { getPrisma, onDatabaseSwapped, sendError } from '../context.js';
import { ensureTables, type TableSpec } from '../ddl.js';

/**
 * Шаблоны вида: какие характеристики оборудования нужны для этой работы.
 *
 * Владелец просил дословно: «сделай так, чтобы шаблоны вида, которые есть в
 * оборудовании, можно было выводить… шаблон вида берёт скомканный, а в таблице
 * мы уже настраиваем, в каком порядке они будут идти, в каких столбцах».
 *
 * Отсюда разделение, которое здесь главное. Шаблон вида отвечает на вопрос
 * «КАКИЕ поля нужны»: автоматчику — тег, мощность, ток, обороты; монтажнику —
 * масса и габариты. Порядок и столбцы он не хранит вовсе — это дело разметки
 * таблицы (`TableTemplate`). Смешай их в одну сущность, и автоматчик, которому
 * нужен тот же набор в другом порядке, завёл бы второй шаблон вместо того,
 * чтобы подвинуть столбец.
 *
 * Поля хранятся кодами характеристик («Электродвигатель||Номинальная
 * мощность»), а не русскими названиями столбцов: переименуют столбец — шаблон
 * не опустеет.
 */

const TABLES: TableSpec[] = [
  {
    table: 'EquipmentViewTemplate',
    cols: [
      { name: 'id', kind: 'text', pk: true, indexed: true },
      { name: 'name', kind: 'text', notNull: true },
      { name: 'scope', kind: 'text', notNull: true, def: 'SHARED', indexed: true },
      { name: 'ownerId', kind: 'text', indexed: true },
      // Для какого оборудования набор осмыслен: ВЕНТИЛЯТОР, ДВИГАТЕЛЬ, ФИЛЬТР…
      // Пусто — годится любому
      { name: 'role', kind: 'text', def: '' },
      { name: 'fieldsJson', kind: 'longtext', def: '[]' },
      { name: 'createdById', kind: 'text' },
      { name: 'createdAt', kind: 'time', notNull: true, def: 'now' },
      { name: 'updatedAt', kind: 'time', notNull: true, def: 'now' },
    ],
    indexes: [{ name: 'EquipmentViewTemplate_scope_ownerId_idx', cols: ['scope', 'ownerId'] }],
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

/** Поле шаблона вида: характеристика по своим кодам плюс подпись для человека. */
export interface ViewField {
  /** Раздел карточки: «Электродвигатель» */
  group: string;
  /** Ключ параметра: «Номинальная мощность» */
  key: string;
  unit: string;
}

/**
 * Разбор поля из запроса.
 *
 * Мусор молча не проглатывается и не «чинится»: поле без группы или без ключа
 * в таблицу не ляжет никогда, и лучше отбросить его здесь, чем показать
 * человеку пустой столбец без объяснения.
 */
function readFields(raw: unknown): ViewField[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: ViewField[] = [];
  const seen = new Set<string>();
  for (const item of list.slice(0, 500)) {
    const group = String((item as any)?.group || '').trim();
    const key = String((item as any)?.key || '').trim();
    if (!group || !key) continue;
    const id = `${group}||${key}`;
    if (seen.has(id)) continue;   // повтор поля — один столбец, а не два
    seen.add(id);
    out.push({ group, key, unit: String((item as any)?.unit || '').trim() });
  }
  return out;
}

function safeArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  try { const v = JSON.parse(String(raw || '[]')); return Array.isArray(v) ? v : []; } catch (_) { return []; }
}

const toView = (row: any) => ({
  id: row.id,
  name: row.name,
  scope: row.scope,
  ownerId: row.ownerId || null,
  role: row.role || '',
  fields: readFields(safeArray(row.fieldsJson)),
  updatedAt: row.updatedAt,
});

export function registerEquipmentViewRoutes(app: Express): void {
  /**
   * Список шаблонов вида.
   *
   * Общие видны всем, личные — только своему владельцу, и условие стоит внутри
   * запроса к базе: забыть его внутри запроса нельзя, оно и есть запрос.
   */
  app.get('/api/equipment/view-templates', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
      const me = authUserOf(req);
      const rows = await prisma.equipmentViewTemplate.findMany({
        where: { OR: [{ scope: 'SHARED' }, { scope: 'PERSONAL', ownerId: me?.id || '—' }] },
        orderBy: [{ name: 'asc' }],
      });
      res.json({ views: (rows as any[]).map(toView) });
    } catch (err: any) { sendError(res, err); }
  });

  app.post('/api/equipment/view-templates', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
      const me = authUserOf(req);
      const body = (req.body || {}) as Record<string, unknown>;
      const name = String(body.name || '').trim().slice(0, 200);
      if (!name) return res.status(400).json({ error: 'У шаблона должно быть имя' });

      const fields = readFields(body.fields);
      if (!fields.length) {
        return res.status(400).json({ error: 'В шаблоне нет ни одной характеристики' });
      }
      const personal = String(body.scope || 'SHARED') === 'PERSONAL';

      const row = await prisma.equipmentViewTemplate.create({
        data: {
          name,
          scope: personal ? 'PERSONAL' : 'SHARED',
          // Личность — из сессии, а не из запроса: иначе чужой шаблон можно
          // объявить своим и спрятать его от остальных
          ownerId: personal ? (me?.id || null) : null,
          role: String(body.role || '').trim(),
          fieldsJson: JSON.stringify(fields),
          createdById: me?.id || null,
        },
      });
      res.json({ view: toView(row) });
    } catch (err: any) { sendError(res, err); }
  });

  /**
   * Удаление.
   *
   * Личный шаблон удаляет только владелец. Общий — любой, кто до него добрался:
   * он и заведён как общий инструмент, и прятать его за отдельным правом
   * означало бы, что поправить опечатку в имени некому.
   */
  app.delete('/api/equipment/view-templates/:id', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
      const me = authUserOf(req);
      const row = await prisma.equipmentViewTemplate.findUnique({ where: { id: req.params.id } });
      if (!row) return res.json({ ok: true });
      if (row.scope === 'PERSONAL' && row.ownerId !== (me?.id || '')) {
        return res.status(403).json({ error: 'Это личный шаблон другого сотрудника' });
      }
      await prisma.equipmentViewTemplate.delete({ where: { id: row.id } });
      res.json({ ok: true });
    } catch (err: any) { sendError(res, err); }
  });
}
