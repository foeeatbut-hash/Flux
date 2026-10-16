import type { Express, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { getPrisma } from '../context.js';
import { actorMay } from '../projectAccess.js';
import { isPrivilegedUser } from '../accessPolicy.js';
import { canSeeProject, roleGrantsOf } from './members.js';
import { getDialect } from '../ddl.js';
import type { EquipmentDocumentBinding, EquipmentDocumentBindingInput, EquipmentDocumentBindingLedger, EquipmentDocumentBindingsView } from '../../equipment/documentBindings.js';
import type { PortableFolderLocator } from '../../filesystem/contracts.js';

const LEGACY_LEDGER_KEY = 'equipment_document_bindings:shared:v1';
const LEDGER_KEY_PREFIX = 'equipment_document_bindings:project:v2:';
const LEDGER_OWNER = '__shared__';
const ledgerKey = (projectId: string) => `${LEDGER_KEY_PREFIX}${encodeURIComponent(projectId)}`;
const MAX_BINDINGS = 1000;
const MAX_UNDO = 20;
const MAX_BYTES = 256_000;
const EMPTY = (): EquipmentDocumentBindingLedger => ({ revision: 0, bindings: [], undo: [] });
const filenameRuleKinds = new Set(['exact-tag', 'selected-name', 'document-name']);
const isLocationKey = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

function parseLedger(raw: string | null | undefined): EquipmentDocumentBindingLedger {
  if (!raw) return EMPTY();
  const parsed = JSON.parse(raw);
  if (!parsed || !Number.isSafeInteger(parsed.revision) || parsed.revision < 0 || !Array.isArray(parsed.bindings) || !Array.isArray(parsed.undo)) throw new Error('Повреждён журнал источников оборудования проекта');
  if (parsed.bindings.length > MAX_BINDINGS || parsed.undo.length > MAX_UNDO) throw new Error('Журнал источников проекта превышает допустимый размер');
  return parsed as EquipmentDocumentBindingLedger;
}

function safeFileName(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= 255 && !/[\\/\u0000-\u001f]/u.test(value) && value !== '.' && value !== '..';
}

function validateLocator(locator: unknown): locator is PortableFolderLocator {
  if (locator === undefined) return true;
  if (!locator || typeof locator !== 'object') return false;
  const value = locator as any;
  if (!isLocationKey(value.folderKey) || !Array.isArray(value.anchors) || !value.anchors.length || value.anchors.length > 64) return false;
  if (value.anchors[0]?.key !== value.folderKey || value.anchors[0]?.relativePath !== '') return false;
  const keys = new Set<string>();
  return value.anchors.every((anchor: any) => anchor && isLocationKey(anchor.key) && !keys.has(anchor.key) && keys.add(anchor.key)
    && typeof anchor.relativePath === 'string' && anchor.relativePath.length <= 2048
    && !anchor.relativePath.startsWith('/') && !/^[a-z]:/iu.test(anchor.relativePath)
    && !anchor.relativePath.includes('\\')
    && !anchor.relativePath.split('/').some((part: string) => part === '..' || part === '.'));
}

function normalizeInput(projectId: string, input: EquipmentDocumentBindingInput, prior?: EquipmentDocumentBinding): EquipmentDocumentBinding {
  if (!input || !['cad-xml', 'document'].includes(input.kind)) throw new Error('Некорректный вид источника оборудования');
  if (!safeFileName(input.fileName)) throw new Error('Нужно передать только имя файла без пути');
  if (!Array.isArray(input.equipmentIds) || input.equipmentIds.length > 500 || input.equipmentIds.some(id => typeof id !== 'string' || !id || id.length > 256)) throw new Error('Некорректный список связанного оборудования');
  if (input.systemId !== undefined && (typeof input.systemId !== 'string' || !input.systemId || input.systemId.length > 256)) throw new Error('Некорректный ID установки');
  if (input.tag !== undefined && (typeof input.tag !== 'string' || input.tag.length > 120 || /[\u0000-\u001f]/u.test(input.tag))) throw new Error('Некорректный тег источника');
  if (!validateLocator(input.locator)) throw new Error('Некорректный переносимый адрес папки');
  if (input.rule !== undefined) {
    const rule = input.rule as any;
    if (!rule || !filenameRuleKinds.has(rule.kind) || (rule.kind !== 'exact-tag' && !safeFileName(rule.fileName))) throw new Error('Некорректное правило имени файла');
  }
  if (input.latestRevision && (!/^[a-f0-9]{64}$/u.test(input.latestRevision.sha256) || typeof input.latestRevision.revision !== 'string' || input.latestRevision.revision.length > 120)) throw new Error('Некорректная ревизия источника');
  const id = String(input.id || prior?.id || (input.kind === 'cad-xml' ? input.xmlSourceId || '' : '') || randomUUID());
  if (!id || id.length > 256) throw new Error('Некорректный идентификатор источника');
  const at = new Date().toISOString();
  return {
    id, projectId, kind: input.kind,
    ...(input.xmlSourceId ? { xmlSourceId: input.xmlSourceId } : prior?.xmlSourceId ? { xmlSourceId: prior.xmlSourceId } : {}),
    equipmentIds: [...new Set(input.equipmentIds)],
    ...(input.systemId ? { systemId: input.systemId } : {}),
    ...(input.tag ? { tag: input.tag } : {}),
    ...(input.locator ? { locator: input.locator } : prior?.locator ? { locator: prior.locator } : {}),
    fileName: input.fileName.trim(),
    ...(input.rule ? { rule: input.rule } : prior?.rule ? { rule: prior.rule } : {}),
    ...(input.latestRevision ? { latestRevision: { ...input.latestRevision, updatedAt: input.latestRevision.updatedAt || at } } : prior?.latestRevision ? { latestRevision: prior.latestRevision } : {}),
    createdAt: prior?.createdAt || at,
    updatedAt: at,
  };
}

async function readSetting(prisma: any, projectId: string) {
  const where = { key: ledgerKey(projectId), userId: LEDGER_OWNER };
  const existing = await prisma.appSetting.findFirst({ where });
  if (existing) return existing;

  // Переносим только данные текущего проекта из общего журнала. Старый журнал
  // остаётся источником для проектов, которые ещё не открывали экран привязок.
  const legacy = await prisma.appSetting.findFirst({ where: { key: LEGACY_LEDGER_KEY, userId: LEDGER_OWNER } });
  if (!legacy) return null;
  const prior = parseLedger(legacy.value);
  const forProject = (rows: EquipmentDocumentBinding[]) => rows.filter(row => row.projectId === projectId);
  const bindings = forProject(prior.bindings);
  const undo = prior.undo
    .map(item => ({ ...item, before: forProject(item.before), after: forProject(item.after) }))
    .filter(item => item.before.length > 0 || item.after.length > 0);
  // Не создаём пустую копию журнала для проекта, которого нет в старых данных.
  if (!bindings.length && !undo.length) return null;
  const migrated: EquipmentDocumentBindingLedger = { revision: prior.revision, bindings, undo };
  const data = { ...where, value: JSON.stringify(migrated) };
  if (getDialect() === 'sqlite') {
    await prisma.appSetting.upsert({ where: { key_userId: where }, create: data, update: { key: where.key } });
  } else {
    // INSERT IGNORE / ON CONFLICT DO NOTHING avoids a unique violation aborting
    // the caller's PostgreSQL transaction when two first reads race.
    await prisma.appSetting.createMany({ data: [data], skipDuplicates: true });
  }
  return prisma.appSetting.findFirst({ where });
}

export async function readEquipmentDocumentBindingLedger(prisma: any, projectId: string): Promise<EquipmentDocumentBindingLedger> {
  const row = await readSetting(prisma, projectId);
  return parseLedger(row?.value);
}

export async function cleanupEquipmentDocumentBindingLedger(prisma: any, projectId: string): Promise<void> {
  await prisma.appSetting.deleteMany({ where: { key: ledgerKey(projectId), userId: LEDGER_OWNER } });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const legacy = await prisma.appSetting.findFirst({ where: { key: LEGACY_LEDGER_KEY, userId: LEDGER_OWNER } });
    if (!legacy) return;
    const prior = parseLedger(legacy.value);
    const forOtherProjects = (rows: EquipmentDocumentBinding[]) => rows.filter(row => row.projectId !== projectId);
    const next: EquipmentDocumentBindingLedger = {
      revision: prior.revision + 1,
      bindings: forOtherProjects(prior.bindings),
      undo: prior.undo.map(item => ({ ...item, before: forOtherProjects(item.before), after: forOtherProjects(item.after) })),
    };
    const changed = await prisma.appSetting.updateMany({ where: { id: legacy.id, value: legacy.value }, data: { value: JSON.stringify(next) } });
    if (changed.count === 1) return;
  }
}

/** Клиент транзакции нужен там, где запись привязки должна быть атомарна с импортом. */
export async function upsertEquipmentDocumentBindingInTransaction(
  prisma: any,
  projectId: string,
  input: EquipmentDocumentBindingInput,
  expectedRevision?: number,
): Promise<{ binding: EquipmentDocumentBinding; ledger: EquipmentDocumentBindingLedger }> {
  const stored = await readSetting(prisma, projectId);
  const current = parseLedger(stored?.value);
  if (expectedRevision !== undefined && expectedRevision !== current.revision) throw Object.assign(new Error('Источники оборудования изменились в другом окне. Обновите список и повторите импорт.'), { status: 409, revision: current.revision });

  const sameXml = input.xmlSourceId ? current.bindings.find(row => row.kind === 'cad-xml' && row.xmlSourceId === input.xmlSourceId && row.projectId === projectId) : undefined;
  const sameDocument = input.kind === 'document' && input.locator
    ? current.bindings.filter(row => row.kind === 'document' && row.projectId === projectId && row.locator?.folderKey === input.locator.folderKey && row.fileName === input.fileName)
    : [];
  if (sameDocument.length > 1 && !input.id) throw Object.assign(new Error('Для папки и имени найдено несколько источников. Обновите список и выберите нужный.'), { status: 409, revision: current.revision });
  const prior = current.bindings.find(row => row.id === input.id && row.projectId === projectId) || sameXml || sameDocument[0];
  const binding = normalizeInput(projectId, input, prior);
  const byId = current.bindings.findIndex(row => row.id === binding.id);
  if (byId >= 0 && current.bindings[byId].projectId !== projectId) throw Object.assign(new Error('Нет доступа к выбранному источнику'), { status: 403 });
  if (binding.xmlSourceId && current.bindings.some(row => row.id !== binding.id && row.kind === 'cad-xml' && row.projectId === projectId && row.xmlSourceId === binding.xmlSourceId)) throw Object.assign(new Error('Для XML-источника уже сохранена другая привязка'), { status: 409 });
  const bindings = current.bindings.slice();
  if (byId >= 0) bindings[byId] = binding;
  else {
    if (bindings.length >= MAX_BINDINGS) throw Object.assign(new Error('Достигнут предел источников оборудования в проекте'), { status: 413 });
    bindings.push(binding);
  }
  const revision = current.revision + 1;
  const next: EquipmentDocumentBindingLedger = {
    revision,
    bindings,
    undo: [...current.undo, { id: randomUUID(), beforeRevision: current.revision, afterRevision: revision, before: current.bindings, after: bindings }].slice(-MAX_UNDO),
  };
  let value = JSON.stringify(next);
  while (Buffer.byteLength(value, 'utf8') > MAX_BYTES && next.undo.length) {
    next.undo.shift();
    value = JSON.stringify(next);
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_BYTES) throw Object.assign(new Error('Журнал источников проекта превышает 256 КБ; активные привязки не удалены'), { status: 413 });
  if (stored) {
    const result = await prisma.appSetting.updateMany({ where: { id: stored.id, value: stored.value }, data: { value } });
    if (result.count !== 1) throw Object.assign(new Error('Источники оборудования изменились параллельно. Обновите список.'), { status: 409 });
  } else {
    try { await prisma.appSetting.create({ data: { key: ledgerKey(projectId), userId: LEDGER_OWNER, value } }); }
    catch { throw Object.assign(new Error('Источники оборудования изменились параллельно. Обновите список.'), { status: 409 }); }
  }
  return { binding, ledger: next };
}

async function visibleProject(req: Request, projectId: string) {
  const actor = (req as any).authUser;
  if (!actor?.id) throw Object.assign(new Error('Требуется вход'), { status: 401 });
  if (!(await canSeeProject(String(actor.id), projectId, isPrivilegedUser(actor)))) throw Object.assign(new Error('Проект недоступен'), { status: 403 });
  return actor;
}

async function viewFor(projectId: string, ledger: EquipmentDocumentBindingLedger, canManage: boolean): Promise<EquipmentDocumentBindingsView> {
  return { revision: ledger.revision, canManage, bindings: ledger.bindings.filter(row => row.projectId === projectId) };
}

export async function validateEquipmentDocumentBindingTargets(prisma: any, projectId: string, input: EquipmentDocumentBindingInput) {
  if (!input || !['cad-xml', 'document'].includes(input.kind) || !Array.isArray(input.equipmentIds)) throw Object.assign(new Error('Некорректная привязка источника оборудования'), { status: 400 });
  if (input.kind === 'cad-xml' && input.xmlSourceId) {
    const source = await prisma.equipmentXmlSource.findFirst({ where: { id: input.xmlSourceId, projectId, deletedAt: null }, select: { id: true } });
    if (!source) throw Object.assign(new Error('XML-источник не найден в выбранном проекте'), { status: 404 });
  }
  if (input.systemId) {
    const system = await prisma.equipmentSystem.findFirst({ where: { id: input.systemId, projectId }, select: { id: true } });
    if (!system) throw Object.assign(new Error('Установка не найдена в выбранном проекте'), { status: 404 });
  }
  if (input.equipmentIds.length) {
    const rows = await prisma.componentElement.findMany({ where: { id: { in: input.equipmentIds } }, select: { id: true, monoblock: { select: { system: { select: { projectId: true } } } } } });
    if (rows.length !== new Set(input.equipmentIds).size || rows.some((row: any) => row.monoblock?.system?.projectId !== projectId)) throw Object.assign(new Error('Связанное оборудование не найдено в выбранном проекте'), { status: 404 });
  }
}

export function registerEquipmentDocumentBindingRoutes(app: Express): void {
  app.get('/api/equipment/projects/:projectId/document-bindings', async (req: Request, res: Response) => {
    try {
      const projectId = String(req.params.projectId || '');
      const actor = await visibleProject(req, projectId);
      const ledger = await readEquipmentDocumentBindingLedger(getPrisma(), projectId);
      res.json(await viewFor(projectId, ledger, await actorMay(actor, roleGrantsOf, 'equipment.manage')));
    } catch (error: any) { res.status(error.status || 500).json({ error: error.message || 'Не удалось прочитать источники оборудования' }); }
  });

  app.post('/api/equipment/projects/:projectId/document-bindings', async (req: Request, res: Response) => {
    try {
      const projectId = String(req.params.projectId || '');
      const actor = await visibleProject(req, projectId);
      if (!(await actorMay(actor, roleGrantsOf, 'equipment.manage'))) return res.status(403).json({ error: 'Нужно право «Правка характеристик оборудования»' });
      const { expectedRevision, operation } = req.body || {};
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !operation || !['upsert', 'remove'].includes(operation.kind)) return res.status(400).json({ error: 'Некорректный план изменения источников' });
      const prisma = getPrisma();
      const stored = await readSetting(prisma, projectId);
      const ledger = parseLedger(stored?.value);
      if (ledger.revision !== expectedRevision) return res.status(409).json({ error: 'Источники оборудования изменились. Обновите список.', revision: ledger.revision });
      if (operation.kind === 'remove') {
        const target = ledger.bindings.find(row => row.projectId === projectId && row.id === operation.bindingId);
        if (!target) return res.status(404).json({ error: 'Источник не найден' });
        const nextBindings = ledger.bindings.filter(row => row.id !== target.id);
        const revision = ledger.revision + 1;
        const next: EquipmentDocumentBindingLedger = { revision, bindings: nextBindings, undo: [...ledger.undo, { id: randomUUID(), beforeRevision: ledger.revision, afterRevision: revision, before: ledger.bindings, after: nextBindings }].slice(-MAX_UNDO) };
        let value = JSON.stringify(next);
        while (Buffer.byteLength(value, 'utf8') > MAX_BYTES && next.undo.length) { next.undo.shift(); value = JSON.stringify(next); }
        if (Buffer.byteLength(value, 'utf8') > MAX_BYTES) return res.status(413).json({ error: 'Журнал источников проекта превышает 256 КБ' });
        if (!stored) return res.status(409).json({ error: 'Источники оборудования изменились параллельно. Обновите список.' });
        const updated = await prisma.appSetting.updateMany({ where: { id: stored.id, value: stored.value }, data: { value } });
        if (updated.count !== 1) return res.status(409).json({ error: 'Источники оборудования изменились параллельно. Обновите список.' });
        return res.json(await viewFor(projectId, next, true));
      }
      const input = operation.binding as EquipmentDocumentBindingInput;
      const result = await prisma.$transaction(async (tx: any) => {
        await validateEquipmentDocumentBindingTargets(tx, projectId, input);
        return upsertEquipmentDocumentBindingInTransaction(tx, projectId, input, expectedRevision);
      });
      res.json(await viewFor(projectId, result.ledger, true));
    } catch (error: any) { res.status(error.status || 400).json({ error: error.message || 'Изменение источника не сохранено' }); }
  });

  app.post('/api/equipment/projects/:projectId/document-bindings/migrate', async (req: Request, res: Response) => {
    try {
      const projectId = String(req.params.projectId || '');
      const actor = await visibleProject(req, projectId);
      if (!(await actorMay(actor, roleGrantsOf, 'equipment.manage'))) return res.status(403).json({ error: 'Нужно право «Правка характеристик оборудования»' });
      const { expectedRevision, confirmed, bindings } = req.body || {};
      if (confirmed !== true) return res.status(400).json({ error: 'Перенос локальных привязок требует явного подтверждения' });
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !Array.isArray(bindings) || !bindings.length || bindings.length > 250) return res.status(400).json({ error: 'Некорректный список переноса привязок' });
      const prisma = getPrisma();
      const result = await prisma.$transaction(async (tx: any) => {
        const stored = await readSetting(tx, projectId);
        const current = parseLedger(stored?.value);
        if (current.revision !== expectedRevision) throw Object.assign(new Error('Источники оборудования изменились. Обновите список.'), { status: 409, revision: current.revision });
        let ledger = current;
        for (const raw of bindings) {
          const sourceId = String(raw?.sourceId || '');
          if (!sourceId || sourceId.length > 256 || !safeFileName(raw?.fileName)) throw Object.assign(new Error('Для переноса источника нужны его ID и имя выбранного файла'), { status: 400 });
          const source = await tx.equipmentXmlSource.findFirst({ where: { id: sourceId, projectId, deletedAt: null } });
          if (!source) throw Object.assign(new Error('Локальная привязка ссылается на отсутствующий источник этого проекта'), { status: 404 });
          const input: EquipmentDocumentBindingInput = {
            id: source.id, kind: 'cad-xml', xmlSourceId: source.id,
            equipmentIds: [source.elementId], ...(source.systemId ? { systemId: source.systemId } : {}),
            ...(source.tagIdentifier ? { tag: source.tagIdentifier } : {}),
            ...(raw.locator ? { locator: raw.locator } : {}), fileName: raw.fileName,
            rule: parseLedgerRule(source.selectedRule, raw.rule),
            ...(source.lastImportedRevision && source.lastImportedSha256 ? { latestRevision: { revision: source.lastImportedRevision, sha256: source.lastImportedSha256 } } : {}),
          };
          await validateEquipmentDocumentBindingTargets(tx, projectId, input);
          const saved = await upsertEquipmentDocumentBindingInTransaction(tx, projectId, input, ledger.revision);
          ledger = saved.ledger;
        }
        return ledger;
      });
      res.json(await viewFor(projectId, result, true));
    } catch (error: any) { res.status(error.status || 400).json({ error: error.message || 'Перенос привязок не выполнен' }); }
  });
}

function parseLedgerRule(stored: unknown, fallback: unknown) {
  try {
    const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
    if (parsed && filenameRuleKinds.has(parsed.kind)) return parsed;
  } catch { /* Используем ниже уже проверенное правило из старого формата. */ }
  return fallback;
}
