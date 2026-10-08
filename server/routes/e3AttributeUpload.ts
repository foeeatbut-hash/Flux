/**
 * Загрузка заполненной книги атрибутов E3 (docs/e3-integration.md, 9.1).
 *
 * Два шага (flux-data-safety): `plan` читает книгу и называет, что изменится, —
 * ничего не пишет; `apply` пересчитывает тот же план по свежим данным и пишет
 * одной транзакцией. Данные КИП ложатся в группу «КИП» характеристик позиции,
 * поэтому запись идёт так же, как у обновления характеристик импортом: строка
 * истории с партией и рост версии позиции. Из-за этого отмена партии — тот же
 * маршрут, что у импорта расчёта (`/api/equipment/import-undo`): отдельного
 * механизма отката здесь нет и быть не должно.
 *
 * Книга приходит уже прочитанной окном (листы в виде таблиц) и проверяется как
 * чужой ввод: размеры ограничены, ключи строк сверяются с проектом.
 */
import type { Express, Request, Response } from 'express';
import { getPrisma, sendError } from '../context.js';
import { isPrivilegedUser } from '../accessPolicy.js';
import { canSeeProject } from './members.js';
import { catalogSetting } from '../catalogWorkspace.js';
import { withBump } from '../equipmentVersion.js';
import { classifyAll } from '../../equipment/classes.js';
import type { E3Attribute, E3AttributeBook } from '../../e3/attributes.js';
import { kipOf, planUpload, readBook, withKip, type BookSheet, type UploadPlan, type UploadPosition } from '../../e3/attributeUpload.js';

const MAX_SHEETS = 40;
const MAX_ROWS = 50_000;
const MAX_COLS = 600;

class Refusal extends Error { constructor(public status: number, message: string) { super(message); } }

/** Листы из запроса: ограниченные по размеру таблицы, ячейки — строки */
function sheetsOf(raw: unknown): BookSheet[] {
  if (!Array.isArray(raw) || !raw.length) throw new Refusal(400, 'Не передана книга');
  if (raw.length > MAX_SHEETS) throw new Refusal(400, `В книге больше ${MAX_SHEETS} листов`);
  let rows = 0;
  return raw.map((s: any) => {
    const aoa = Array.isArray(s?.aoa) ? s.aoa : [];
    rows += aoa.length;
    if (rows > MAX_ROWS) throw new Refusal(400, `В книге больше ${MAX_ROWS} строк`);
    return {
      name: String(s?.name ?? '').slice(0, 100),
      aoa: aoa.map((r: any) => (Array.isArray(r) ? r.slice(0, MAX_COLS).map((c: any) => (typeof c === 'string' ? c.slice(0, 1000) : c == null ? '' : String(c))) : [])),
    };
  });
}

interface Loaded { plan: UploadPlan; issues: string[]; byId: Map<string, any> }

export function registerE3AttributeUploadRoutes(app: Express, deps: { loadBook?: (db: any) => Promise<E3Attribute[]> } = {}): void {
  const loadBook = deps.loadBook || (async (db: any) => ((await catalogSetting(db, 'e3_attributes', { items: [] })) as E3AttributeBook).items || []);

  /** Позиции проекта и план по книге. Одна функция на оба шага: запись пишет ровно то, что план показал бы сейчас */
  async function build(req: Request, sheetsRaw: unknown): Promise<Loaded> {
    const me = (req as any).authUser;
    if (!me?.id) throw new Refusal(401, 'Нужно войти в программу');
    const projectId = String(req.params.projectId || '');
    if (!projectId || !(await canSeeProject(String(me.id), projectId, isPrivilegedUser(me)))) throw new Refusal(403, 'Нет доступа к проекту. Попросите добавить вас в состав.');
    const db = getPrisma();
    const read = readBook(sheetsOf(sheetsRaw));
    const systems = await db.equipmentSystem.findMany({
      where: { projectId },
      include: { monoblocks: { include: { components: { include: { tags: true } } } } },
    });
    const positions: UploadPosition[] = [];
    const byId = new Map<string, any>();
    for (const sys of systems) {
      const list = (sys.monoblocks || []).flatMap((m: any) => m.components || []);
      const types = classifyAll(list.map((c: any) => ({ ...c, tags: c.tags || [] })));
      for (const c of list) {
        byId.set(c.id, c);
        const tags = (c.tags || []).map((t: any) => t.identifier);
        positions.push({
          id: c.id, cls: types.get(c.id)?.cls || 'ПРОЧЕЕ', tags, label: tags[0] || c.name || c.itemCode,
          removed: c.status === 'REMOVED', kip: kipOf(c.specs),
        });
      }
    }
    return { plan: planUpload(read, await loadBook(db), positions), issues: read.issues, byId };
  }

  const run = (fn: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response) => {
    try { await fn(req, res); } catch (e: any) { sendError(res, e, e instanceof Refusal ? e.status : 500); }
  };

  app.post('/api/projects/:projectId/e3-attribute-upload/plan', run(async (req, res) => {
    const { plan, issues } = await build(req, req.body?.sheets);
    res.json({ plan, issues });
  }));

  app.post('/api/projects/:projectId/e3-attribute-upload/apply', run(async (req, res) => {
    const { plan, issues, byId } = await build(req, req.body?.sheets);
    if (!plan.writes.length) throw new Refusal(409, 'Книга ничего не меняет — записывать нечего');
    const batchId = `kip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const db = getPrisma();
    await db.$transaction(async (tx: any) => {
      for (const w of plan.writes) {
        const el = byId.get(w.id);
        const specs = withKip(el.specs, w.changes);
        // История с партией — по ней отмена вернёт прежние характеристики
        await tx.equipmentHistory.create({
          data: { elementId: el.id, version: el.version, oldSpecs: el.specs ?? null, newSpecs: specs, changeType: 'UPDATE', batchId },
        });
        await tx.componentElement.update({ where: { id: el.id }, data: withBump({ specs }) });
      }
    }, { maxWait: 10_000, timeout: 120_000 });
    res.json({ ok: true, batchId, written: plan.writes.length, values: plan.writes.reduce((n, w) => n + w.changes.length, 0), errors: plan.errors, notes: plan.notes, issues });
  }));
}
