import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { getPrisma } from '../context';
import { diagnosticsDir, diagnosticsEnabled, serverDiagnostics } from '../diagnostics';
import { readSource } from '../../diagnostics/node/read';
import { parseJsonl } from '../../diagnostics/summary';
import { automaticEvents, emptyAutomaticState, mergeAutomatic, type AutomaticState } from '../../diagnostics/automatic';
import { actorOf, fail, ok } from './policy';
import { ERRORS } from '../../feedback/contracts';
import type { FeedbackDeps } from '../routes/feedback';

const KEY = 'feedback.automatic.v1';
const idOf = (actor: string | null) => `auto-${createHash('sha256').update(actor || '@server').digest('hex').slice(0, 32)}`;
const decode = (value?: string): AutomaticState => {
  try { const s = JSON.parse(value || ''); if (s.cursors && Array.isArray(s.incidents)) return s; } catch { /* первая запись */ }
  return emptyAutomaticState();
};

/** CAS защищает от двойного учёта одним и тем же журналом на двух серверах. */
async function change(actor: string | null, update: (s: AutomaticState) => AutomaticState): Promise<boolean> {
  const prisma = getPrisma(); const id = idOf(actor);
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await prisma.appSetting.findUnique({ where: { id } });
    const value = JSON.stringify(update(decode(row?.value)));
    if (value === row?.value) return true;
    if (row) {
      const result = await prisma.appSetting.updateMany({ where: { id, value: row.value }, data: { value } });
      if (result.count) return true;
    } else {
      try { await prisma.appSetting.create({ data: { id, key: KEY, userId: actor, value } }); return true; }
      catch (e: any) { if (e.code !== 'P2002') throw e; }
    }
  }
  return false;
}

let timer: ReturnType<typeof setInterval> | undefined;
let scanning = false;
export function registerAutomaticRoutes(app: Express, deps: FeedbackDeps): void {
  app.post('/api/feedback/automatic-incidents', async (req, res) => {
    const actor = actorOf(req);
    if (!actor) return fail(res, ERRORS.FORBIDDEN, 'Нужно войти в программу');
    if (!Array.isArray(req.body?.events) || req.body.events.length > 1000) return fail(res, ERRORS.VALIDATION, 'Допускается до 1000 технических событий');
    const events = automaticEvents(req.body.events, ['renderer', 'electron']);
    const saved = await change(actor.id, s => mergeAutomatic(s, events));
    if (!saved) return fail(res, ERRORS.REVISION_CONFLICT, 'Журнал обновляется другим окном; повторите позже');
    ok(res, { accepted: events.length });
  });
  app.get('/api/feedback/automatic-incidents', async (req, res) => {
    const actor = actorOf(req); if (!actor) return fail(res, ERRORS.FORBIDDEN, 'Нужно войти в программу');
    const triage = actor.isAdmin || deps.can((req as any).authUser, 'feedback.triage');
    const rows = await getPrisma().appSetting.findMany({ where: { key: KEY, ...(triage ? {} : { userId: actor.id }) }, orderBy: { updatedAt: 'desc' }, take: 100 });
    const items = rows.flatMap((r: any) => decode(r.value).incidents.filter(i => i.severity === 'error' || i.count >= 2).map(i => ({ ...i, ownerId: r.userId, origin: r.userId ? 'Окно сотрудника' : 'Сервер' })));
    ok(res, { triage, items: items.sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, 300), limited: rows.length === 100 });
  });
  app.patch('/api/feedback/automatic-incidents/:id/resolve', async (req, res) => {
    const actor = actorOf(req);
    if (!actor || !(actor.isAdmin || deps.can((req as any).authUser, 'feedback.triage'))) return fail(res, ERRORS.FORBIDDEN, 'Нужно право разбора обращений');
    const owner = req.body?.ownerId === null ? null : String(req.body?.ownerId || '');
    if (owner === '') return fail(res, ERRORS.VALIDATION, 'Укажите источник');
    let found = false;
    const changed = await change(owner, s => ({ ...s, incidents: s.incidents.map(i => {
      if (i.id !== req.params.id) return i;
      found = true; return { ...i, resolvedAt: new Date().toISOString() };
    }) }));
    if (!found) return fail(res, ERRORS.NOT_FOUND, 'Событие уже удалено ротацией');
    if (!changed) return fail(res, ERRORS.REVISION_CONFLICT, 'Список обновляется; повторите позже');
    ok(res, { resolved: true });
  });
  // Сервер анализирует свой журнал даже когда никто не создавал обращение.
  if (!timer && diagnosticsEnabled) {
    const scan = async () => {
      if (scanning) return; scanning = true;
      try {
        await serverDiagnostics().flush(); const to = Date.now();
        const part = await readSource(diagnosticsDir(), 'server', { from: to - 15 * 60000, to, maxBytes: 2 * 1024 * 1024 });
        const { events } = parseJsonl(part.text);
        await change(null, s => mergeAutomatic(s, automaticEvents(events.slice(-1000), ['server'])));
      } catch { /* сбор диагностики не должен нарушать работу приложения */ }
      finally { scanning = false; }
    };
    timer = setInterval(() => { void scan(); }, 60000); timer.unref();
    void scan();
  }
}
