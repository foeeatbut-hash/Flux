import type { Express, Request, Response } from 'express';
import { getPrisma, sendError, resolveProjectId } from '../context.js';
import { projectSnapshot, whereUsed, searchAll, type UsageKind } from '../insight.js';
import { projectCheck, changeList } from '../insightRules.js';
import { readableAccounts } from '../mail/access.js';

/**
 * Связи проекта: «где используется», проверка проекта, лист изменений и общий
 * поиск.
 *
 * Всё считается на сервере по одному срезу данных. Делать это в браузере
 * нельзя: разделы подгружают только видимую часть своих списков, и связь тега с
 * документом, который сейчас не открыт, там просто не из чего построить.
 *
 * Срез собирается на каждый запрос заново. Кэш здесь был бы вреден: цена
 * ошибки — показать инженеру связь, которой уже нет, и это хуже, чем лишние
 * полсекунды.
 */

const actorOf = (req: Request): any => (req as any).authUser || null;

/**
 * Ящики, письма которых человеку и так видны: свои личные и общий.
 *
 * Спрашиваем у самой почты, а не подбираем условие здесь: правило «что кому
 * видно» должно жить в одном месте, иначе панель связей однажды разойдётся с
 * почтой и покажет чужую переписку.
 */
async function mailIds(req: Request): Promise<string[]> {
  try { return (await readableAccounts(req)).map((a: any) => a.id); } catch (_) { return []; }
}

const KINDS = new Set(['tag', 'element', 'doc', 'file', 'vdr']);

export function registerInsightRoutes(app: Express): void {
  // ── Где используется ──────────────────────────────────────────────────────
  app.get('/api/insight/where-used', async (req: Request, res: Response) => {
    try {
      const kind = String(req.query.kind || 'tag');
      const id = String(req.query.id || '');
      if (!KINDS.has(kind) || !id) return res.status(400).json({ error: 'Нужны kind и id' });
      const projectId = await resolveProjectId(req.query.projectId as string);
      if (!projectId) return res.json({ found: false, kind, id, title: '', subtitle: '', total: 0, groups: [] });
      // Тексты документов нужны: половина связей — упоминания в формулах
      const snap = await projectSnapshot(getPrisma(), projectId, {
        userId: actorOf(req)?.id, mailAccountIds: await mailIds(req),
      });
      res.json(whereUsed(snap, kind as UsageKind, id));
    } catch (err: any) { sendError(res, err); }
  });

  // ── Проверка проекта ──────────────────────────────────────────────────────
  app.get('/api/insight/check', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProjectId(req.query.projectId as string);
      if (!projectId) {
        return res.json({ projectId: '', projectName: '', at: new Date().toISOString(), total: 0, critical: 0, warning: 0, info: 0, groups: [], hidden: [] });
      }
      const snap = await projectSnapshot(getPrisma(), projectId, { userId: actorOf(req)?.id });
      // Отключённые правила — общая настройка команды: если бы каждый прятал
      // своё, «проверено» перестало бы что-либо значить
      let muted: string[] = [];
      try {
        const s = await getPrisma().appSetting.findFirst({ where: { key: 'insight_muted', userId: null } });
        const parsed = s?.value ? JSON.parse(s.value) : [];
        if (Array.isArray(parsed)) muted = parsed.map((x: any) => String(x));
      } catch (_) {}
      const stuckDays = Number(req.query.stuckDays || 21);
      res.json(projectCheck(snap, { muted, stuckDays: isFinite(stuckDays) ? stuckDays : 21 }));
    } catch (err: any) { sendError(res, err); }
  });

  // Отключить или вернуть правило проверки
  app.post('/api/insight/mute', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const ruleId = String(req.body?.ruleId || '');
      const on = req.body?.muted !== false;
      if (!ruleId) return res.status(400).json({ error: 'Нужен ruleId' });
      const cur = await prisma.appSetting.findFirst({ where: { key: 'insight_muted', userId: null } });
      let list: string[] = [];
      try { const p = cur?.value ? JSON.parse(cur.value) : []; if (Array.isArray(p)) list = p.map((x: any) => String(x)); } catch (_) {}
      const next = on ? [...new Set([...list, ruleId])] : list.filter(x => x !== ruleId);
      const value = JSON.stringify(next);
      if (cur) await prisma.appSetting.update({ where: { id: cur.id }, data: { value } });
      else await prisma.appSetting.create({ data: { key: 'insight_muted', value, userId: null } });
      res.json({ muted: next });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Лист изменений ────────────────────────────────────────────────────────
  app.get('/api/insight/changes', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const projectId = await resolveProjectId(req.query.projectId as string);
      if (!projectId) return res.json({ since: null, until: new Date().toISOString(), total: 0, entries: [] });
      const days = Number(req.query.days || 14);
      const since = req.query.since
        ? new Date(String(req.query.since))
        : new Date(Date.now() - (isFinite(days) ? days : 14) * 24 * 60 * 60 * 1000);

      const snap = await projectSnapshot(prisma, projectId, { userId: actorOf(req)?.id });
      const byId = new Map(snap.elements.map(e => [e.id, e]));
      const rows = await prisma.equipmentHistory.findMany({
        where: { changedAt: { gte: since }, elementId: { in: [...byId.keys()] } },
        orderBy: { changedAt: 'desc' }, take: 500,
      });
      res.json(changeList(rows, since.toISOString(), byId));
    } catch (err: any) { sendError(res, err); }
  });

  // ── Общий поиск (Ctrl+K) ──────────────────────────────────────────────────
  app.get('/api/insight/search', async (req: Request, res: Response) => {
    try {
      const q = String(req.query.q || '');
      if (q.trim().length < 2) return res.json({ hits: [] });
      const projectId = await resolveProjectId(req.query.projectId as string);
      if (!projectId) return res.json({ hits: [] });
      const snap = await projectSnapshot(getPrisma(), projectId, {
        userId: actorOf(req)?.id, mailAccountIds: await mailIds(req),
      });
      res.json({ hits: searchAll(snap, q, 30) });
    } catch (err: any) { sendError(res, err); }
  });
}
