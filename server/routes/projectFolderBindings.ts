import type { Express, Request, Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { getPrisma } from '../context.js';
import { isAdminActor } from '../projectAccess.js';
import { canSeeProject } from './members.js';
import { isSafeBindingPath, normalizedBindingPath, validateBinding, type ProjectFolderBinding, type ProjectFolderBindingLedger } from '../../src/lib/projectFolderBindings.js';

const KEY_PREFIX = 'explorer_project_bindings:';
const MAX_BINDINGS = 500;
const MAX_UNDO = 20;
const EMPTY = (): ProjectFolderBindingLedger => ({ revision: 0, bindings: [], undo: [] });

function scopeKey(deviceId: string, rootId: string): string {
  return KEY_PREFIX + createHash('sha256').update(`${deviceId}\0${rootId}`).digest('hex');
}

function parseLedger(raw: string | null | undefined): ProjectFolderBindingLedger {
  if (!raw) return EMPTY();
  const parsed = JSON.parse(raw);
  if (!parsed || !Number.isSafeInteger(parsed.revision) || parsed.revision < 0 || !Array.isArray(parsed.bindings) || !Array.isArray(parsed.undo)) throw new Error('Повреждён журнал привязок папок');
  if (parsed.bindings.length > MAX_BINDINGS || parsed.undo.length > MAX_UNDO) throw new Error('Журнал привязок превышает допустимый размер');
  return parsed as ProjectFolderBindingLedger;
}

function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function projectsIn(bindings: ProjectFolderBinding[]): string[] { return [...new Set(bindings.map(row => row.projectId))]; }

export function registerProjectFolderBindingRoutes(app: Express): void {
  app.get('/api/explorer/project-bindings', async (req: Request, res: Response) => {
    try {
      const me = (req as any).authUser;
      if (!me?.id) return res.status(401).json({ error: 'Требуется вход' });
      const deviceId = String(req.query.deviceId || '');
      const rootId = String(req.query.rootId || '');
      if (!deviceId || deviceId.length > 160 || !rootId || rootId.length > 256) return res.status(400).json({ error: 'Не указан компьютер или корень Проводника' });
      const row = await getPrisma().appSetting.findFirst({ where: { key: scopeKey(deviceId, rootId), userId: String(me.id) } });
      const ledger = parseLedger(row?.value);
      const visible = await Promise.all(ledger.bindings.map(async binding => [binding, await canSeeProject(String(me.id), binding.projectId, isAdminActor(me))] as const));
      const bindings = visible.filter(([, allowed]) => allowed).map(([binding]) => binding);
      const undo = [];
      for (const entry of ledger.undo) {
        const pids = [...new Set([...projectsIn(entry.before || []), ...projectsIn(entry.after || [])])];
        let allowed = true;
        for (const projectId of pids) if (!(await canSeeProject(String(me.id), projectId, isAdminActor(me)))) { allowed = false; break; }
        if (allowed) undo.push({ id: entry.id, afterRevision: entry.afterRevision });
      }
      res.json({ revision: ledger.revision, bindings, undo });
    } catch (err: any) { res.status(500).json({ error: err?.message || 'Не удалось прочитать привязки папок' }); }
  });

  app.post('/api/explorer/project-bindings', async (req: Request, res: Response) => {
    try {
      const me = (req as any).authUser;
      if (!me?.id) return res.status(401).json({ error: 'Требуется вход' });
      const actorId = String(me.id);
      const { deviceId, rootId, expectedRevision, operation } = req.body || {};
      if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 160 || typeof rootId !== 'string' || !rootId || rootId.length > 256) return res.status(400).json({ error: 'Не указан компьютер или корень Проводника' });
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !operation || !['upsert', 'remove', 'undo'].includes(operation.kind)) return res.status(400).json({ error: 'Некорректный план изменения привязок' });
      const prisma = getPrisma();
      const key = scopeKey(deviceId, rootId);
      const stored = await prisma.appSetting.findFirst({ where: { key, userId: actorId } });
      const current = parseLedger(stored?.value);
      if (expectedRevision !== current.revision) return res.status(409).json({ error: 'Привязки изменились на другом окне. Обновите Проводник.', revision: current.revision });

      let nextBindings = current.bindings.slice();
      if (operation.kind === 'upsert') {
        const binding = { ...operation.binding, actorId, deviceId, rootId } as ProjectFolderBinding;
        if (!binding.id) binding.id = randomUUID();
        validateBinding(binding);
        const project = await prisma.project.findUnique({ where: { id: binding.projectId }, select: { id: true } });
        if (!project || !(await canSeeProject(actorId, binding.projectId, isAdminActor(me)))) return res.status(403).json({ error: 'Нет доступа к выбранному проекту' });
        const sameBoundary = nextBindings.findIndex(item => item.canonicalFolderId === binding.canonicalFolderId && item.rootId === rootId);
        const samePath = nextBindings.findIndex(item => normalizedBindingPath(item.relativePath) === normalizedBindingPath(binding.relativePath) && item.rootId === rootId);
        if ((sameBoundary >= 0 && nextBindings[sameBoundary].id !== binding.id) || (samePath >= 0 && nextBindings[samePath].id !== binding.id)) return res.status(409).json({ error: 'Для этой папки уже существует привязка' });
        if (sameBoundary < 0 && nextBindings.length >= MAX_BINDINGS) return res.status(413).json({ error: 'Достигнут предел привязок для этого корня' });
        if (sameBoundary >= 0) nextBindings[sameBoundary] = binding;
        else nextBindings.push(binding);
      } else if (operation.kind === 'remove') {
        if (typeof operation.bindingId !== 'string' || !operation.bindingId) return res.status(400).json({ error: 'Не выбрана граница привязки' });
        const target = nextBindings.find(item => item.id === operation.bindingId);
        if (!target) return res.status(404).json({ error: 'Привязка уже отсутствует' });
        if (!(await canSeeProject(actorId, target.projectId, isAdminActor(me)))) return res.status(403).json({ error: 'Нет доступа к проекту этой привязки' });
        nextBindings = nextBindings.filter(item => item.id !== operation.bindingId);
      } else {
        const entry = current.undo.find(item => item.id === operation.undoId && item.afterRevision === current.revision);
        if (!entry || !same(current.bindings, entry.after)) return res.status(409).json({ error: 'Отмену нельзя применить после последующих изменений' });
        for (const projectId of [...new Set([...projectsIn(entry.before), ...projectsIn(entry.after)])]) {
          if (!(await canSeeProject(actorId, projectId, isAdminActor(me)))) return res.status(403).json({ error: 'Для отмены нужна доступность всех исходных проектов' });
        }
        nextBindings = entry.before.slice();
      }

      if (nextBindings.length > MAX_BINDINGS || nextBindings.some(item => item.actorId !== actorId || item.deviceId !== deviceId || item.rootId !== rootId)) return res.status(400).json({ error: 'Некорректная область привязки' });
      const nextRevision = current.revision + 1;
      const history = current.undo.slice();
      history.push({ id: randomUUID(), beforeRevision: current.revision, afterRevision: nextRevision, before: current.bindings.slice(), after: nextBindings.slice() });
      const next: ProjectFolderBindingLedger = { revision: nextRevision, bindings: nextBindings, undo: history.slice(-MAX_UNDO) };
      const value = JSON.stringify(next);
      if (Buffer.byteLength(value, 'utf8') > 256_000) return res.status(413).json({ error: 'Журнал привязок превышает допустимый размер' });

      // Условное обновление сравнивает полное старое значение: пара окон не сможет затереть друг другу привязки.
      if (stored) {
        const result = await prisma.appSetting.updateMany({ where: { id: stored.id, value: stored.value }, data: { value } });
        if (result.count !== 1) return res.status(409).json({ error: 'Привязки изменились параллельно. Обновите Проводник.' });
      } else {
        try { await prisma.appSetting.create({ data: { key, userId: actorId, value } }); }
        catch (_) { return res.status(409).json({ error: 'Привязки изменились параллельно. Обновите Проводник.' }); }
      }
      const responseBindings = await Promise.all(nextBindings.map(async binding => [binding, await canSeeProject(actorId, binding.projectId, isAdminActor(me))] as const));
      const responseUndo = [];
      for (const item of next.undo) {
        const pids = [...new Set([...projectsIn(item.before), ...projectsIn(item.after)])];
        let allowed = true;
        for (const projectId of pids) if (!(await canSeeProject(actorId, projectId, isAdminActor(me)))) { allowed = false; break; }
        if (allowed) responseUndo.push({ id: item.id, afterRevision: item.afterRevision });
      }
      res.json({ revision: nextRevision, bindings: responseBindings.filter(([, allowed]) => allowed).map(([binding]) => binding), undo: responseUndo });
    } catch (err: any) { res.status(400).json({ error: err?.message || 'План привязки не применён' }); }
  });
}
