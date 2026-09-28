import type { Express, Request, Response } from 'express';
import { getPrisma, resolveProjectId, sendError } from '../context.js';
import { findCycle, cycleNames } from '../../src/lib/docFormula.js';

// Формулы документа: именованные значения титула.
//
// Формулы — своя область со своим сроком жизни, поэтому отдельный модуль.

// Вид формулы: чужое значение в базе означало бы, что документ соберётся
// непредсказуемо, поэтому проверяем на входе
const KINDS = new Set(['value', 'text', 'compose', 'expr', 'signature']);

/** Строка базы → формула для движка. Испорченный JSON не роняет список. */
function toFormula(row: any) {
  let config: any = {};
  try { config = JSON.parse(row.config || '{}'); } catch { config = {}; }
  return { id: row.id, name: row.name, kind: row.kind, config, projectId: row.projectId };
}

const authUserOf = (req: Request) => (req as any).authUser || null;

export function registerFormulaRoutes(app: Express): void {
  // ── Формулы документа ─────────────────────────────────────────────────────
  // Именованные значения титула. Принадлежат проекту: личная формула означала
  // бы, что у коллеги тот же титул соберётся иначе, и это заметят на печати.

  app.get('/api/projects/:projectId/formulas', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const projectId = await resolveProjectId(req.params.projectId);
      const rows = await prisma.docFormula.findMany({
        where: { projectId },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      });
      res.json({ formulas: (rows as any[]).map(toFormula) });
    } catch (err: any) { sendError(res, err); }
  });

  app.post('/api/projects/:projectId/formulas', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const projectId = await resolveProjectId(req.params.projectId);
      const me = authUserOf(req);
      const name = String(req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'Укажите название формулы' });
      const kind = String(req.body?.kind || 'value');
      if (!KINDS.has(kind)) return res.status(400).json({ error: `Неизвестный вид формулы: ${kind}` });

      const created = await prisma.docFormula.create({
        data: {
          projectId, name, kind,
          config: JSON.stringify(req.body?.config ?? {}),
          sortOrder: Number(req.body?.sortOrder) || 0,
          createdById: me?.id || null,
          updatedById: me?.id || null,
        },
      });
      res.json({ formula: toFormula(created) });
    } catch (err: any) { sendError(res, err); }
  });

  app.put('/api/formulas/:id', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const me = authUserOf(req);
      const current = await prisma.docFormula.findUnique({ where: { id: String(req.params.id) } });
      if (!current) return res.status(404).json({ error: 'Формула не найдена' });

      const kind = req.body?.kind !== undefined ? String(req.body.kind) : current.kind;
      if (!KINDS.has(kind)) return res.status(400).json({ error: `Неизвестный вид формулы: ${kind}` });

      // Кольцо ищем ДО записи: показать «A → B → A» человеку можно только
      // здесь, при выводе документа это уже поздно и непонятно откуда
      const all = await prisma.docFormula.findMany({ where: { projectId: current.projectId } });
      const catalog: Record<string, any> = {};
      for (const r of all as any[]) catalog[r.id] = toFormula(r);
      catalog[current.id] = {
        ...catalog[current.id],
        kind,
        config: req.body?.config !== undefined ? req.body.config : catalog[current.id].config,
      };
      const cycle = findCycle(current.id, catalog);
      if (cycle) {
        return res.status(400).json({ error: `Формула ссылается сама на себя: ${cycleNames(cycle, catalog)}` });
      }

      const updated = await prisma.docFormula.update({
        where: { id: current.id },
        data: {
          name: req.body?.name !== undefined ? String(req.body.name).trim() : current.name,
          kind,
          config: req.body?.config !== undefined ? JSON.stringify(req.body.config) : current.config,
          sortOrder: req.body?.sortOrder !== undefined ? Number(req.body.sortOrder) || 0 : current.sortOrder,
          updatedById: me?.id || null,
        },
      });
      res.json({ formula: toFormula(updated) });
    } catch (err: any) { sendError(res, err); }
  });

  // Сколько шаблонов пострадает от удаления — показываем ДО того, как удалим
  app.get('/api/formulas/:id/usage', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const id = String(req.params.id);
      const f = await prisma.docFormula.findUnique({ where: { id } });
      if (!f) return res.status(404).json({ error: 'Формула не найдена' });
      // И в других формулах-сборках
      const others = await prisma.docFormula.findMany({ where: { projectId: f.projectId } });
      const inFormulas = (others as any[])
        .filter((o) => o.id !== id && String(o.config || '').includes(id))
        .map((o) => ({ id: o.id, name: o.name }));
      // Шаблоны титулов Конструктора ушли вместе с ним: формулу держат только
      // другие формулы-сборки. Поле templates оставлено пустым для окна
      res.json({ templates: [], formulas: inFormulas });
    } catch (err: any) { sendError(res, err); }
  });

  app.delete('/api/formulas/:id', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await prisma.docFormula.delete({ where: { id: String(req.params.id) } });
      res.json({ success: true });
    } catch (err: any) { sendError(res, err); }
  });
}
