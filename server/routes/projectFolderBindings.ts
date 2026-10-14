import type { Express, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { getPrisma } from '../context.js';
import { isAdminActor } from '../projectAccess.js';
import { canSeeProject } from './members.js';
import { validateBinding, type ProjectFolderBinding, type ProjectFolderBindingLedger, type ProjectFolderBindingView } from '../../src/lib/projectFolderBindings.js';

// Один общий журнал на весь Flux. Папки проектов сетевые и у всех одни и те же, поэтому привязку,
// сделанную администратором или руководителем проектов, видят все, кому виден сам проект.
// Прежние журналы «по пользователю и устройству» (ключи explorer_project_bindings:<хеш>) не читаются:
// функция не выходила в релиз, переносить там нечего.
const LEDGER_KEY = 'explorer_project_bindings:shared:v1';
// Уникальность AppSetting — пара (key, userId), а при NULL базы допускают дубликаты. Фиксированный
// владелец даёт настоящий уникальный индекс: два одновременных первых сохранения не создадут две строки.
const LEDGER_OWNER = '__shared__';
const MAX_BINDINGS = 500;
const MAX_UNDO = 20;
const MAX_LEDGER_BYTES = 256_000;
const EMPTY = (): ProjectFolderBindingLedger => ({ revision: 0, bindings: [], undo: [] });

export interface ProjectFolderBindingDeps {
  /** Право менять привязки: администратор или владелец функции project.manage (как в server/routes/projects.ts). */
  mayManage: (req: Request) => Promise<boolean>;
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

/** Что из журнала видит этот человек: привязки и записи отмены скрытых от него проектов не показываются. */
async function viewFor(me: any, ledger: ProjectFolderBindingLedger, bindings: ProjectFolderBinding[], canManage: boolean): Promise<ProjectFolderBindingView> {
  const admin = isAdminActor(me);
  const cache = new Map<string, boolean>();
  const may = async (projectId: string) => {
    let allowed = cache.get(projectId);
    if (allowed === undefined) { allowed = await canSeeProject(String(me.id), projectId, admin); cache.set(projectId, allowed); }
    return allowed;
  };
  const visible: ProjectFolderBinding[] = [];
  for (const binding of bindings) if (await may(binding.projectId)) visible.push(binding);
  const undo: ProjectFolderBindingView['undo'] = [];
  // Отмена — действие управляющего; остальным историю не показываем вовсе.
  if (canManage) {
    for (const entry of ledger.undo) {
      let allowed = true;
      for (const projectId of new Set([...projectsIn(entry.before || []), ...projectsIn(entry.after || [])])) if (!(await may(projectId))) { allowed = false; break; }
      if (allowed) undo.push({ id: entry.id, afterRevision: entry.afterRevision });
    }
  }
  return { revision: ledger.revision, canManage, bindings: visible, undo };
}

export function registerProjectFolderBindingRoutes(app: Express, deps: ProjectFolderBindingDeps): void {
  app.get('/api/explorer/project-bindings', async (req: Request, res: Response) => {
    try {
      const me = (req as any).authUser;
      if (!me?.id) return res.status(401).json({ error: 'Требуется вход' });
      const row = await getPrisma().appSetting.findFirst({ where: { key: LEDGER_KEY, userId: LEDGER_OWNER } });
      const ledger = parseLedger(row?.value);
      res.json(await viewFor(me, ledger, ledger.bindings, await deps.mayManage(req)));
    } catch (err: any) { res.status(500).json({ error: err?.message || 'Не удалось прочитать привязки папок' }); }
  });

  app.post('/api/explorer/project-bindings', async (req: Request, res: Response) => {
    try {
      const me = (req as any).authUser;
      if (!me?.id) return res.status(401).json({ error: 'Требуется вход' });
      const actorId = String(me.id);
      if (!(await deps.mayManage(req))) return res.status(403).json({ error: 'Привязывать папки к проектам могут администраторы и сотрудники с правом «Управление проектами».' });
      const admin = isAdminActor(me);
      const { expectedRevision, operation } = req.body || {};
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !operation || !['upsert', 'remove', 'undo'].includes(operation.kind)) return res.status(400).json({ error: 'Некорректный план изменения привязок' });
      const prisma = getPrisma();
      const stored = await prisma.appSetting.findFirst({ where: { key: LEDGER_KEY, userId: LEDGER_OWNER } });
      const current = parseLedger(stored?.value);
      if (expectedRevision !== current.revision) return res.status(409).json({ error: 'Привязки изменились на другом окне. Обновите Проводник.', revision: current.revision });

      let nextBindings = current.bindings.slice();
      if (operation.kind === 'upsert') {
        const given = operation.binding || {};
        const binding = { id: given.id || randomUUID(), locationKey: given.locationKey, projectId: given.projectId, label: typeof given.label === 'string' ? given.label.trim() : given.label, actorId, at: new Date().toISOString() } as ProjectFolderBinding;
        validateBinding(binding);
        const project = await prisma.project.findUnique({ where: { id: binding.projectId }, select: { id: true } });
        if (!project || !(await canSeeProject(actorId, binding.projectId, admin))) return res.status(403).json({ error: 'Нет доступа к выбранному проекту' });
        const sameKey = nextBindings.findIndex(item => item.locationKey === binding.locationKey);
        const sameId = nextBindings.findIndex(item => item.id === binding.id);
        if ((sameKey >= 0 && nextBindings[sameKey].id !== binding.id) || (sameId >= 0 && sameId !== sameKey)) return res.status(409).json({ error: 'Для этой папки уже существует привязка' });
        // Смена проекта у чужой привязки скрытого проекта раскрыла бы её существование: заменять можно лишь видимое.
        if (sameKey >= 0 && !(await canSeeProject(actorId, nextBindings[sameKey].projectId, admin))) return res.status(403).json({ error: 'Нет доступа к проекту этой привязки' });
        if (sameKey < 0 && nextBindings.length >= MAX_BINDINGS) return res.status(413).json({ error: 'Достигнут предел привязок папок' });
        if (sameKey >= 0) nextBindings[sameKey] = binding;
        else nextBindings.push(binding);
      } else if (operation.kind === 'remove') {
        if (typeof operation.bindingId !== 'string' || !operation.bindingId) return res.status(400).json({ error: 'Не выбрана граница привязки' });
        const target = nextBindings.find(item => item.id === operation.bindingId);
        if (!target) return res.status(404).json({ error: 'Привязка уже отсутствует' });
        if (!(await canSeeProject(actorId, target.projectId, admin))) return res.status(403).json({ error: 'Нет доступа к проекту этой привязки' });
        nextBindings = nextBindings.filter(item => item.id !== operation.bindingId);
      } else {
        const entry = current.undo.find(item => item.id === operation.undoId && item.afterRevision === current.revision);
        if (!entry || !same(current.bindings, entry.after)) return res.status(409).json({ error: 'Отмену нельзя применить после последующих изменений' });
        for (const projectId of [...new Set([...projectsIn(entry.before), ...projectsIn(entry.after)])]) {
          if (!(await canSeeProject(actorId, projectId, admin))) return res.status(403).json({ error: 'Для отмены нужна доступность всех исходных проектов' });
        }
        nextBindings = entry.before.slice();
      }

      if (nextBindings.length > MAX_BINDINGS) return res.status(400).json({ error: 'Некорректный набор привязок' });
      const nextRevision = current.revision + 1;
      const history = current.undo.slice();
      history.push({ id: randomUUID(), beforeRevision: current.revision, afterRevision: nextRevision, before: current.bindings.slice(), after: nextBindings.slice() });
      const next: ProjectFolderBindingLedger = { revision: nextRevision, bindings: nextBindings, undo: history.slice(-MAX_UNDO) };
      // Каждая запись отмены хранит полные копии привязок до и после, поэтому журнал растёт быстрее самих привязок.
      // Ограничение должно урезать историю отмены (старые записи), а не блокировать сохранение привязок: иначе при
      // большом числе привязок любой следующий запрос, включая удаление и отмену, навсегда получал бы 413.
      let value = JSON.stringify(next);
      while (Buffer.byteLength(value, 'utf8') > MAX_LEDGER_BYTES && next.undo.length > 0) {
        next.undo.shift();
        value = JSON.stringify(next);
      }
      if (Buffer.byteLength(value, 'utf8') > MAX_LEDGER_BYTES) return res.status(413).json({ error: 'Журнал привязок превышает допустимый размер' });

      // Условное обновление сравнивает полное старое значение: пара окон не сможет затереть друг другу привязки.
      if (stored) {
        const result = await prisma.appSetting.updateMany({ where: { id: stored.id, value: stored.value }, data: { value } });
        if (result.count !== 1) return res.status(409).json({ error: 'Привязки изменились параллельно. Обновите Проводник.' });
      } else {
        try { await prisma.appSetting.create({ data: { key: LEDGER_KEY, userId: LEDGER_OWNER, value } }); }
        catch (_) { return res.status(409).json({ error: 'Привязки изменились параллельно. Обновите Проводник.' }); }
      }
      res.json(await viewFor(me, next, nextBindings, true));
    } catch (err: any) { res.status(400).json({ error: err?.message || 'План привязки не применён' }); }
  });
}
