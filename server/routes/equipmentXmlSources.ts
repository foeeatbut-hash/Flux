import { createHash, randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { XMLValidator } from 'fast-xml-parser';
import { broadcast, getPrisma, sendError } from '../context.js';
import { parseEquipmentXML } from '../equipmentParser.js';
import { unitBlocksOf } from '../equipmentResolve.js';
import { withBump } from '../equipmentVersion.js';
import { emitEntityChanged } from '../entityChanged.js';
import { actorMay } from '../projectAccess.js';
import { canSeeProject, roleGrantsOf } from './members.js';
import { applyEquipmentSourceDecisions, diffEquipmentSource, equipmentSourceSpecsEqual, parseEquipmentSourceGroups, rebaseSourceDecisions, sourceDecisionStatus, type SourceChange, type SourceGroup } from '../equipmentSourceReview.js';
import { isPrivilegedUser } from '../accessPolicy.js';
import { decodeEquipmentSourceXml, EQUIPMENT_SOURCE_MAX_BYTES } from '../../equipment/sourceXml.js';
import { inferEquipmentSourceFilenameRule, matchesEquipmentSourceFilename, type EquipmentSourceFilenameRule } from '../../equipment/sourceXml.js';
import { bindingKey as catalogBindingKey, sourceInfo as equipmentCatalogSourceInfo } from '../equipmentCatalog.js';
import { resolveEquipmentSourceTargets, type EquipmentSourceTargetElement, type EquipmentSourceTargetsResult } from '../equipmentSourceTargets.js';
import { importPolicyOfProject } from './tagPolicy.js';
import { validateTag } from '../../equipment/tagPolicy.js';
import { recordTagCreated, TAG_SOURCE } from '../tagHistory.js';
import { blockKey } from '../specUtils.js';

const authUserOf = (req: Request) => (req as any).authUser || null;
const parseJson = (raw: unknown, fallback: any) => { try { return typeof raw === 'string' ? JSON.parse(raw) : raw ?? fallback; } catch { return fallback; } };
const normTag = (value: unknown) => String(value ?? '').normalize('NFC').trim().toLocaleLowerCase();
const sourceDto = (source: any, tag: any) => ({
  sourceId: source.id, projectId: source.projectId, tagId: source.tagId, targetType: source.targetType,
  systemId: source.systemId || undefined, elementId: source.elementId, tagIdentifier: tag?.identifier || source.tagIdentifier,
  boundIdentifier: source.tagIdentifier, revisionOrder: parseJson(source.revisionOrder, ['A','B','C','D','E','F','G','H','I','J']),
  selectedRule: parseJson(source.selectedRule, { kind: 'exact-tag' }), lastImportedRevision: source.lastImportedRevision || null,
  lastImportedSha256: source.lastImportedSha256 || null, lastImportedAt: source.lastImportedAt || null,
  lastReviewedRevision: source.lastReviewedRevision || null, lastReviewedSha256: source.lastReviewedSha256 || null, lastReviewedAt: source.lastReviewedAt || null,
  createdAt: source.createdAt, updatedAt: source.updatedAt,
});
const emitSourceChanged = (projectId: string, sourceId: string) => broadcast('entity:changed', { kind: 'equipment-source', id: sourceId, projectId, at: Date.now() });

export function decodeVerifiedSource(body: any): { text: string; sha256: string } {
  const encoded = String(body?.base64 || ''); const claimed = String(body?.sha256 || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(claimed) || !encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw Object.assign(new Error('Нет корректной контрольной суммы или содержимого XML.'), { status: 400 });
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded || !Number.isInteger(Number(body?.size)) || Number(body.size) !== bytes.length || bytes.length > EQUIPMENT_SOURCE_MAX_BYTES) throw Object.assign(new Error('Размер или кодировка XML не соответствуют прочитанному файлу либо превышают 16 МБ.'), { status: 400 });
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== claimed) throw Object.assign(new Error('Файл изменился при передаче. Повторите проверку источника.'), { status: 409 });
  const text = decodeEquipmentSourceXml(bytes);
  if (text === null) throw Object.assign(new Error('Файл не является корректным UTF-8 или UTF-16 XML.'), { status: 400 });
  return { text, sha256: actual };
}

function validateXmlTarget(text: string, fileName: string, tag: any, target: any, selectedRule?: EquipmentSourceFilenameRule) {
  if (!fileName || fileName.length > 255 || /[/\\\u0000-\u001f]/u.test(fileName) || fileName === '.' || fileName === '..') throw Object.assign(new Error('Сервер принимает только имя XML-файла без пути.'), { status: 400 });
  const validRule = selectedRule && (selectedRule.kind === 'exact-tag'
    || (selectedRule.kind === 'selected-name' && typeof selectedRule.fileName === 'string' && selectedRule.fileName.length > 0 && selectedRule.fileName.length <= 255 && !/[/\\\u0000-\u001f]/u.test(selectedRule.fileName)));
  if (!validRule) throw Object.assign(new Error('Правило имени источника не распознано; выберите XML заново.'), { status: 400 });
  if (!matchesEquipmentSourceFilename(fileName, String(tag.identifier), selectedRule)) throw Object.assign(new Error(`Имя файла «${fileName}» не соответствует сохранённому правилу тега «${tag.identifier}».`), { status: 400 });
  if (XMLValidator.validate(text) !== true) throw Object.assign(new Error('XML повреждён или не завершён; текущие характеристики не изменены.'), { status: 400 });
  const result = parseEquipmentXML(text);
  const groups = groupsForTarget(result, target, String(tag.identifier));
  const parsedUnit = target.targetType === 'system' ? result.units.find(unit => normTag(unit.name) === normTag(tag.identifier) || (unit.tags || []).some((item: string) => normTag(item) === normTag(tag.identifier))) : undefined;
  return { groups, result, parsedUnit };
}

async function access(req: Request, projectId: string, manage = true) {
  const actor = authUserOf(req);
  if (!actor?.id) throw Object.assign(new Error('Требуется вход'), { status: 401 });
  if (!(await canSeeProject(String(actor.id), projectId, isPrivilegedUser(actor)))) throw Object.assign(new Error('Проект недоступен'), { status: 403 });
  if (manage && !(await actorMay(actor, roleGrantsOf, 'equipment.manage'))) throw Object.assign(new Error('Нужно право «Правка характеристик оборудования»'), { status: 403 });
  return actor;
}

async function sourceInProject(req: Request, manage = true) {
  const prisma = getPrisma();
  const projectId = String(req.params.projectId || '');
  const actor = await access(req, projectId, manage);
  const source = await prisma.equipmentXmlSource.findFirst({ where: { id: String(req.params.sourceId || ''), projectId, deletedAt: null } });
  if (!source) throw Object.assign(new Error('Источник не найден в этом проекте'), { status: 404 });
  const tag = await prisma.tag.findFirst({ where: { id: source.tagId, projectId } });
  if (!tag) throw Object.assign(new Error('Тег источника больше не найден в проекте'), { status: 409 });
  if (String(tag.identifier) !== String(source.tagIdentifier)) {
    // ID сохраняется после переименования; человек видит конфликт имени файла,
    // а источник не перепривязывается молча к похожему тегу.
    return { prisma, projectId, actor, source, tag, renamed: true };
  }
  return { prisma, projectId, actor, source, tag, renamed: false };
}

function safeGroups(groups: any[]): SourceGroup[] {
  return groups.map(group => ({ title: String(group?.title || 'Параметры'), params: (group?.params || []).map((param: any) => ({ key: String(param?.key || ''), value: param?.value ?? '', unit: String(param?.unit || '') })).filter((param: any) => param.key) }));
}

export function groupsForTarget(result: ReturnType<typeof parseEquipmentXML>, source: any, identifier: string): SourceGroup[] {
  const matches: SourceGroup[][] = [];
  for (const unit of result.units) {
    if (source.targetType === 'system') {
      if (normTag(unit.name) === normTag(identifier) || (unit.tags || []).some((tag: string) => normTag(tag) === normTag(identifier))) matches.push(safeGroups(unit.groups || []));
      continue;
    }
    for (const block of unitBlocksOf(unit).filter(item => item.code !== '__unit__')) {
      if (normTag(block.code) === normTag(identifier) || (block.tags || []).some((tag: string) => normTag(tag) === normTag(identifier))) matches.push(safeGroups(block.groups || []));
    }
  }
  if (!matches.length) throw Object.assign(new Error(`В XML не найдено оборудование с точным тегом «${identifier}».`), { status: 400 });
  if (matches.length !== 1) throw Object.assign(new Error(`Тег «${identifier}» найден в XML несколько раз; неоднозначный источник.`), { status: 400 });
  return matches[0];
}

function indexChanges(raw: unknown): SourceChange[] {
  let parsed: unknown;
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { throw Object.assign(new Error('Повреждён список изменений кандидата'), { status: 409 }); }
  if (!Array.isArray(parsed)) throw Object.assign(new Error('Повреждён список изменений кандидата'), { status: 409 });
  return parsed;
}
function storedObject(raw: unknown, fallback: any, label: string): any {
  let parsed: any;
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { throw Object.assign(new Error(`${label} повреждены; изменения не сохранены.`), { status: 409 }); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Object.assign(new Error(`${label} имеют неверный формат; изменения не сохранены.`), { status: 409 });
  return parsed ?? fallback;
}

function targetElementDto(element: any): EquipmentSourceTargetElement {
  const tagNames = Array.isArray(element?.tags) ? element.tags.map((tag: any) => String(tag.identifier || '')) : [];
  return {
    id: String(element.id), itemCode: String(element.itemCode || ''), name: String(element.name || element.itemCode || ''),
    monoblockName: String(element.monoblock?.name || ''), parentElementId: element.parentElementId || null,
    equipType: String(element.equipType || ''), role: String(element.role || ''), sourceKind: element.sourceKind ?? null, instanceNo: element.instanceNo ?? null, instanceCount: element.instanceCount ?? null, sourceOrder: Number(element.sourceOrder || 0), status: String(element.status || ''), manual: element.manual === true, version: Number(element.version || 1), specs: element.specs ?? null,
    overrides: element.overrides ?? null, tags: tagNames,
  };
}

function makeSourceTargetReview(source: any, root: any, groups: SourceGroup[], parsedUnit: any, systemElements: any[] = []): EquipmentSourceTargetsResult {
  const rootTarget = targetElementDto(root);
  if (source.targetType === 'system' && parsedUnit) {
    return resolveEquipmentSourceTargets(parsedUnit, rootTarget, systemElements.map(targetElementDto));
  }
  const changes = diffEquipmentSource(root.specs ?? null, groups, root.overrides ?? null).map(change => ({
    ...change, rawId: change.id, targetId: root.id, id: `${root.id}\u0001${change.id}`, targetLabel: targetElementDto(root).name,
  }));
  return { targets: [{ elementId: rootTarget.id, label: rootTarget.name, groups, changes, expectedVersion: rootTarget.version }], structuralActions: [] };
}

export function registerEquipmentXmlSourceRoutes(app: Express): void {
  app.get('/api/equipment/projects/:projectId/sources', async (req, res) => {
    try {
      const prisma = getPrisma(); const projectId = String(req.params.projectId || '');
      await access(req, projectId, false);
      const rows = await prisma.equipmentXmlSource.findMany({ where: { projectId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
      const tags = await prisma.tag.findMany({ where: { id: { in: rows.map((row: any) => row.tagId) }, projectId } });
      const byId = new Map(tags.map((tag: any) => [tag.id, tag]));
      const recentCandidates = rows.length ? await prisma.equipmentXmlCandidate.findMany({ where: { sourceId: { in: rows.map((row: any) => row.id) } }, orderBy: { updatedAt: 'desc' }, select: { id: true, sourceId: true, revision: true, fileName: true, status: true, changes: true, decisions: true, expectedVersions: true, updatedAt: true } }) : [];
      const latest = new Map<string, any>();
      for (const candidate of recentCandidates) if (!latest.has(candidate.sourceId)) latest.set(candidate.sourceId, { id: candidate.id, revision: candidate.revision, fileName: candidate.fileName, status: candidate.status, changes: parseJson(candidate.changes, []), decisions: parseJson(candidate.decisions, {}), expectedVersions: parseJson(candidate.expectedVersions, {}), updatedAt: candidate.updatedAt });
      const targetElementIds = [...new Set([...latest.values()].flatMap(candidate => Object.keys(candidate.expectedVersions || {})))];
      const targetElements = targetElementIds.length ? await prisma.componentElement.findMany({ where: { id: { in: targetElementIds } }, include: { tags: true } }) : [];
      const targetTags = new Map(targetElements.map((element: any) => [element.id, (element.tags || []).map((tag: any) => tag.id)]));
      res.json({ sources: rows.map((row: any) => {
        const candidate = latest.get(row.id) || null;
        const ids = new Set([row.elementId, ...Object.keys(candidate?.expectedVersions || {})]);
        return { ...sourceDto(row, byId.get(row.tagId)), targetTags: [...ids].map(elementId => ({ elementId, tagIds: targetTags.get(elementId) || (elementId === row.elementId ? [row.tagId] : []) })), latestCandidate: candidate };
      }) });
    } catch (err: any) { sendError(res, err, err.status || 500); }
  });

  // Источник создаётся только после первичного импорта: привязка никогда не
  // указывает на оборудование, которого ещё нет в проектном реестре.
  app.post('/api/equipment/projects/:projectId/sources', async (req, res) => {
    try {
      const prisma = getPrisma(); const projectId = String(req.params.projectId || '');
      const actor = await access(req, projectId);
      const tagId = String(req.body?.tagId || ''); const targetType = String(req.body?.targetType || '');
      const elementId = String(req.body?.elementId || ''); const systemId = String(req.body?.systemId || '');
      if (!tagId || !elementId || !['system', 'component'].includes(targetType)) return res.status(400).json({ error: 'Нужны тег, позиция и тип источника.' });
      const tag = await prisma.tag.findFirst({ where: { id: tagId, projectId } });
      const element = await prisma.componentElement.findUnique({ where: { id: elementId }, include: { tags: true, monoblock: { include: { system: true } } } });
      if (!tag || !element || element.monoblock?.system?.projectId !== projectId || !(element.tags || []).some((item: any) => item.id === tagId)) return res.status(404).json({ error: 'Позиция и тег не связаны в этом проекте.' });
      if (targetType === 'system' && (!systemId || element.monoblock?.system?.id !== systemId || element.monoblock?.system?.name !== tag.identifier || element.itemCode !== '__unit__')) return res.status(400).json({ error: 'Источник установки должен быть привязан к тегу и служебной позиции __unit__ этой установки.' });
      if (targetType === 'component' && systemId) return res.status(400).json({ error: 'Для источника компонента не передавайте systemId.' });
      const { text, sha256 } = decodeVerifiedSource(req.body);
      const fileName = String(req.body?.fileName || '');
      const selectedRule = (parseJson(req.body?.selectedRule, null) || inferEquipmentSourceFilenameRule(fileName, String(tag.identifier))) as EquipmentSourceFilenameRule | null;
      if (!selectedRule) return res.status(400).json({ error: `Имя файла «${fileName}» не содержит точный тег «${tag.identifier}».` });
      const { groups } = validateXmlTarget(text, fileName, tag, { targetType, systemId }, selectedRule);
      // Выбор XML создаёт привязку, но не является импортом. Baseline можно
      // поставить только если уже сохранённые характеристики совпадают с ним.
      const alreadyImported = equipmentSourceSpecsEqual(element.specs ?? null, JSON.stringify({ groups }));
      const source = await prisma.equipmentXmlSource.create({ data: {
        id: randomUUID(), projectId, tagId, targetType, systemId: targetType === 'system' ? systemId : null,
        elementId, tagIdentifier: String(tag.identifier), revisionOrder: JSON.stringify(Array.isArray(req.body?.revisionOrder) ? req.body.revisionOrder.slice(0, 30).map(String) : ['A','B','C','D','E','F','G','H','I','J']),
        selectedRule: JSON.stringify(selectedRule),
        ...(alreadyImported ? { lastImportedRevision: String(req.body?.revision || ''), lastImportedSha256: String(req.body?.sha256 || ''), lastImportedAt: new Date(), lastReviewedRevision: String(req.body?.revision || ''), lastReviewedSha256: String(req.body?.sha256 || ''), lastReviewedAt: new Date() } : {}),
        createdById: String(actor.id),
      } });
      emitSourceChanged(projectId, source.id);
      res.status(201).json({ source: sourceDto(source, tag) });
    } catch (err: any) {
      if (err.code === 'P2002') return res.status(409).json({ error: 'Эта привязка уже сохранена.' });
      sendError(res, err, err.status || 500);
    }
  });

  app.delete('/api/equipment/projects/:projectId/sources/:sourceId', async (req, res) => {
    try {
      const { prisma, source } = await sourceInProject(req);
      await prisma.equipmentXmlSource.update({ where: { id: source.id }, data: { deletedAt: new Date() } });
      emitSourceChanged(source.projectId, source.id);
      res.json({ ok: true });
    } catch (err: any) { sendError(res, err, err.status || 500); }
  });

  // Переименование не меняет ID привязки; инженер выбирает новый XML и
  // явно подтверждает соответствие, прежде чем обновить правило имени файла.
  app.put('/api/equipment/projects/:projectId/sources/:sourceId/rebind', async (req, res) => {
    try {
      const { prisma, source, tag } = await sourceInProject(req);
      const element = await prisma.componentElement.findUnique({ where: { id: source.elementId }, include: { tags: true, monoblock: { include: { system: true } } } });
      if (!element || element.monoblock?.system?.projectId !== source.projectId || !(element.tags || []).some((item: any) => item.id === tag.id)) return res.status(409).json({ error: 'Тег больше не привязан к прежней позиции. Выберите правильное оборудование перед перепривязкой.' });
      if (source.targetType === 'system' && element.monoblock?.system?.id !== source.systemId) return res.status(409).json({ error: 'Установка источника изменилась.' });
      if (source.targetType === 'system' && element.monoblock?.system?.name !== tag.identifier) return res.status(409).json({ error: 'Имя установки не совпадает с текущим идентификатором тега.' });
      const { text, sha256 } = decodeVerifiedSource(req.body);
      const fileName = String(req.body?.fileName || '');
      const rule = (parseJson(req.body?.selectedRule, null) || inferEquipmentSourceFilenameRule(fileName, String(tag.identifier))) as EquipmentSourceFilenameRule | null;
      if (!rule) return res.status(400).json({ error: `Имя файла «${fileName}» не содержит тег «${tag.identifier}».` });
      validateXmlTarget(text, fileName, tag, source, rule);
      const updated = await prisma.$transaction(async (tx: any) => {
        const claimed = await tx.equipmentXmlSource.updateMany({ where: { id: source.id, projectId: source.projectId, deletedAt: null, tagIdentifier: source.tagIdentifier, selectedRule: source.selectedRule }, data: { tagIdentifier: String(tag.identifier), selectedRule: JSON.stringify(rule) } });
        if (claimed.count !== 1) throw Object.assign(new Error('Источник параллельно перепривязали. Обновите карточку.'), { status: 409 });
        const candidates = await tx.equipmentXmlCandidate.findMany({ where: { sourceId: source.id }, select: { id: true, status: true, decisions: true, decisionHistory: true, updatedAt: true } });
        for (const candidate of candidates) {
          let history: any[] = [];
          try { history = JSON.parse(candidate.decisionHistory || '[]'); } catch { throw Object.assign(new Error('История решений повреждена; перепривязка отменена.'), { status: 409 }); }
          history.push({ decisions: parseJson(candidate.decisions, {}), status: candidate.status, invalidatedByRebindAt: new Date().toISOString() });
          await tx.equipmentXmlCandidate.updateMany({ where: { id: candidate.id, updatedAt: candidate.updatedAt }, data: { status: 'stale', decisionHistory: JSON.stringify(history) } });
        }
        return tx.equipmentXmlSource.findUnique({ where: { id: source.id } });
      });
      emitSourceChanged(source.projectId, source.id);
      res.json({ source: sourceDto(updated, tag), selectedFileSha256: sha256 });
    } catch (err: any) { sendError(res, err, err.status || 500); }
  });

  app.get('/api/equipment/projects/:projectId/sources/:sourceId/candidates', async (req, res) => {
    try {
      const { prisma, source, renamed, tag } = await sourceInProject(req, false);
      const candidates = await prisma.equipmentXmlCandidate.findMany({ where: { sourceId: source.id }, orderBy: { createdAt: 'asc' }, include: { applications: { orderBy: { createdAt: 'desc' }, take: 1, select: { batchId: true } } } });
      res.json({ renamed, currentIdentifier: tag.identifier, candidates: candidates.map((candidate: any) => ({ ...candidate, structuralActions: parseJson(candidate.parsedSpecs, {}).structuralActions || [], expectedVersions: parseJson(candidate.expectedVersions, {}), parsedSpecs: undefined, changes: parseJson(candidate.changes, []), decisions: parseJson(candidate.decisions, {}), undoBatchId: candidate.applications?.[0]?.batchId || null, applications: undefined })) });
    } catch (err: any) { sendError(res, err, err.status || 500); }
  });

  app.post('/api/equipment/projects/:projectId/sources/:sourceId/check', async (req, res) => {
    try {
      const { prisma, projectId, actor, source, renamed, tag } = await sourceInProject(req);
      if (renamed) return res.status(409).json({ error: `Тег переименован: было «${source.tagIdentifier}», сейчас «${tag.identifier}». Перепривяжите файл к новому имени.` });
      const { text, sha256: digest } = decodeVerifiedSource(req.body); const fileName = String(req.body?.fileName || ''); const revision = String(req.body?.revision || '').trim();
      if (!text.trim()) return res.status(400).json({ error: 'XML-файл пуст.' });
      if (!revision || revision.length > 100 || !fileName || fileName.length > 255) return res.status(400).json({ error: 'Не указаны имя XML или ревизия.' });
      const { groups, parsedUnit } = validateXmlTarget(text, fileName, tag, source, parseJson(source.selectedRule, undefined));
      if (source.targetType === 'component') {
        const element = await prisma.componentElement.findUnique({ where: { id: source.elementId }, include: { tags: true, monoblock: { include: { system: true } } } });
        if (!element || element.monoblock?.system?.projectId !== projectId || !(element.tags || []).some((item: any) => item.id === tag.id)) return res.status(409).json({ error: 'Тег больше не привязан к исходной позиции. Нужна явная перепривязка.' });
      }
      const element = await prisma.componentElement.findUnique({ where: { id: source.elementId }, include: { tags: true, monoblock: true } });
      if (!element) return res.status(409).json({ error: 'Позиция источника больше не существует.' });
      if (source.targetType === 'system') {
        const system = await prisma.equipmentSystem.findFirst({ where: { id: source.systemId, projectId } });
        if (!system || system.name !== source.tagIdentifier || system.name !== tag.identifier) return res.status(409).json({ error: 'Установка источника была переименована; проверьте соответствие файла.' });
      }
      const systemElements = source.targetType === 'system' ? await prisma.componentElement.findMany({
        where: { monoblock: { systemId: source.systemId } }, include: { tags: true, monoblock: true },
      }) : [];
      const review = makeSourceTargetReview(source, element, groups, parsedUnit, systemElements);
      const expectedVersions: Record<string, number> = Object.fromEntries(review.targets.map(target => [target.elementId, target.expectedVersion]));
      for (const id of review.structuralActions.flatMap(action => action.elementIds)) {
        const live = systemElements.find((item: any) => item.id === id) || (element.id === id ? element : null);
        if (live) expectedVersions[id] = Number(live.version || 1);
      }
      const changes = review.targets.flatMap(target => target.changes);
      // Показываем отдельно зафиксированное каталожное значение. XML меняет
      // только исходные характеристики позиции и никогда не меняет каталог.
      const catalogBinding = await prisma.appSetting.findFirst({ where: { key: catalogBindingKey(element.id), userId: null } });
      for (const target of review.targets) {
        const targetElement = target.elementId === element.id ? element : systemElements.find((item: any) => item.id === target.elementId);
        if (!targetElement) continue;
        const binding = targetElement.id === element.id ? catalogBinding : await prisma.appSetting.findFirst({ where: { key: catalogBindingKey(targetElement.id), userId: null } });
        if (binding) {
          try {
            const catalogView = await equipmentCatalogSourceInfo(targetElement, undefined, binding);
            const catalogByAddress = new Map(catalogView.effective.filter((item: any) => item.source === 'catalog').map((item: any) => [`${item.group}||${item.key}`, item]));
            for (const change of target.changes) {
            const current = catalogByAddress.get(`${change.group}||${change.key}`);
            if (current) change.catalogCurrent = { key: change.key, value: current.value, ...(current.unit ? { unit: current.unit } : {}), source: 'catalog' };
          }
          } catch (_) {
            // Отображение каталожного значения вспомогательное.
          }
        }
      }
      const parsedTargetSpecs = { targets: review.targets.map(({ elementId, label, groups }) => ({ elementId, label, groups })), structuralActions: review.structuralActions };
      const existing = await prisma.equipmentXmlCandidate.findFirst({ where: { sourceId: source.id, sha256: digest }, include: { applications: { orderBy: { createdAt: 'desc' }, take: 1, select: { batchId: true } } } });
      if (existing) {
        let candidate = existing;
        if (existing.status === 'stale'
          || JSON.stringify(parseJson(existing.expectedVersions, { [element.id]: Number(existing.expectedVersion) })) !== JSON.stringify(expectedVersions)
          || JSON.stringify(parseJson(existing.parsedSpecs, {})) !== JSON.stringify(parsedTargetSpecs)) {
          const oldChanges = indexChanges(existing.changes);
          const oldDecisions = parseJson(existing.decisions, {}) as Record<string, any>;
          const rebasedDecisions = rebaseSourceDecisions(oldChanges, oldDecisions, changes);
          let history: any;
          try { history = JSON.parse(existing.decisionHistory || '[]'); } catch { throw Object.assign(new Error('История решений повреждена; кандидат оставлен без изменений.'), { status: 409 }); }
          if (!Array.isArray(history)) throw Object.assign(new Error('История решений повреждена; кандидат оставлен без изменений.'), { status: 409 });
          history.push({ expectedVersion: existing.expectedVersion, changes: oldChanges, decisions: oldDecisions, status: existing.status, at: new Date().toISOString() });
          const status = sourceDecisionStatus(changes, rebasedDecisions, review.structuralActions);
          const claimed = await prisma.equipmentXmlCandidate.updateMany({
            where: { id: existing.id, expectedVersion: existing.expectedVersion, updatedAt: existing.updatedAt },
            data: { revision, fileName, parsedSpecs: JSON.stringify(parsedTargetSpecs), changes: JSON.stringify(changes), decisions: JSON.stringify(rebasedDecisions), decisionHistory: JSON.stringify(history), status, expectedVersion: Number(element.version || 1), expectedVersions: JSON.stringify(expectedVersions) },
          });
          if (claimed.count !== 1) throw Object.assign(new Error('Кандидат параллельно обновили. Повторите сравнение.'), { status: 409 });
          candidate = { ...existing, revision, fileName, parsedSpecs: JSON.stringify(parsedTargetSpecs), changes: JSON.stringify(changes), decisions: JSON.stringify(rebasedDecisions), decisionHistory: JSON.stringify(history), status, expectedVersion: Number(element.version || 1), expectedVersions: JSON.stringify(expectedVersions) };
          emitSourceChanged(projectId, source.id);
          return res.json({ candidate: { id: candidate.id, sourceId: source.id, revision, fileName, sha256: digest, status, changes, decisions: rebasedDecisions, structuralActions: review.structuralActions, expectedVersion: candidate.expectedVersion, expectedVersions, createdAt: candidate.createdAt, undoBatchId: existing.applications?.[0]?.batchId || null }, reused: true, rebased: true });
        }
        return res.json({ candidate: { id: candidate.id, sourceId: source.id, revision: candidate.revision, fileName: candidate.fileName, sha256: candidate.sha256, status: candidate.status, changes: parseJson(candidate.changes, []), decisions: parseJson(candidate.decisions, {}), structuralActions: parseJson(candidate.parsedSpecs, {}).structuralActions || [], expectedVersion: candidate.expectedVersion, expectedVersions: parseJson(candidate.expectedVersions, {}), createdAt: candidate.createdAt, undoBatchId: candidate.applications?.[0]?.batchId || null }, reused: true });
      }
      if (changes.length === 0 && review.structuralActions.length === 0 && source.lastImportedSha256 === digest) return res.json({ unchanged: true, source: sourceDto(source, tag) });
      const candidateData = {
        id: randomUUID(), sourceId: source.id, projectId, revision, fileName, sha256: digest,
        parsedSpecs: JSON.stringify(parsedTargetSpecs), changes: JSON.stringify(changes), decisions: '{}', status: 'pending', expectedVersion: Number(element.version || 1), expectedVersions: JSON.stringify(expectedVersions), uploadedById: String(actor.id),
      };
      const candidate = await prisma.equipmentXmlCandidate.create({ data: candidateData });
      emitSourceChanged(projectId, source.id);
      res.status(201).json({ candidate: { id: candidate.id, sourceId: source.id, revision, fileName, sha256: digest, status: candidate.status, changes, decisions: {}, structuralActions: review.structuralActions, expectedVersion: candidate.expectedVersion, expectedVersions, createdAt: candidate.createdAt }, reused: false });
    } catch (err: any) { sendError(res, err, err.status || 500); }
  });

  app.post('/api/equipment/projects/:projectId/sources/:sourceId/candidates/:candidateId/decisions', async (req, res) => {
    try {
      const { prisma, projectId, actor, source, tag } = await sourceInProject(req);
      const candidate = await prisma.equipmentXmlCandidate.findFirst({ where: { id: req.params.candidateId, sourceId: source.id, projectId } });
      if (!candidate) return res.status(404).json({ error: 'Кандидат ревизии не найден.' });
      if (candidate.status === 'stale') return res.status(409).json({ error: 'Источник перепривязали. Сначала сравните файл заново.' });
      if (String(tag.identifier) !== String(source.tagIdentifier) || !matchesEquipmentSourceFilename(candidate.fileName, String(tag.identifier), parseJson(source.selectedRule, { kind: 'exact-tag' }))) return res.status(409).json({ error: 'Кандидат относится к прежнему имени файла или правилу источника. Проверьте и сравните XML заново.' });
      const root = await prisma.componentElement.findFirst({ where: { id: source.elementId, monoblock: { system: { projectId } } }, include: { tags: true, monoblock: true } });
      if (!root) return res.status(404).json({ error: 'Позиция источника не найдена в проекте.' });
      const currentTargets = source.targetType === 'system'
        ? await prisma.componentElement.findMany({ where: { monoblock: { systemId: source.systemId } }, include: { tags: true, monoblock: true } })
        : [root];
      const parsed = storedObject(candidate.parsedSpecs, {}, 'Сохранённое сравнение XML');
      const structuralActions = Array.isArray(parsed.structuralActions) ? parsed.structuralActions : [];
      const targetSpecs: Array<{ elementId: string; label: string; groups: SourceGroup[] }> = Array.isArray(parsed.targets)
        ? parsed.targets : [{ elementId: root.id, label: root.name, groups: parseEquipmentSourceGroups(candidate.parsedSpecs) }];
      const expectedVersions = storedObject(candidate.expectedVersions, { [root.id]: Number(candidate.expectedVersion) }, 'Версии сравнения XML') as Record<string, number>;
      const liveById = new Map(currentTargets.map((target: any) => [String(target.id), target]));
      for (const target of targetSpecs) {
        const live = liveById.get(target.elementId) as any;
        if (!live || Number(live.version || 1) !== Number(expectedVersions[target.elementId])) return res.status(409).json({ error: 'Одна из позиций изменилась после сравнения. Обновите список XML-кандидатов.' });
      }
      for (const [targetId, version] of Object.entries(expectedVersions)) {
        const live = liveById.get(targetId) as any;
        if (!live || Number(live.version || 1) !== Number(version)) return res.status(409).json({ error: 'Одна из позиций или структура установки изменилась после сравнения. Обновите список XML-кандидатов.' });
      }
      const expectedVersion = Number(req.body?.expectedVersion);
      if (!Number.isInteger(expectedVersion) || expectedVersion !== Number(root.version || 1) || expectedVersion !== Number(candidate.expectedVersion)) return res.status(409).json({ error: 'Позицию источника изменили после сравнения. Обновите список XML-кандидатов.' });
      const asked = Array.isArray(req.body?.decisions) ? req.body.decisions : [];
      const changes = indexChanges(candidate.changes);
      if (req.body?.confirmNoChanges === true) {
        if (changes.length || structuralActions.length || asked.length) return res.status(409).json({ error: 'В ревизии есть характеристики или изменения состава для решения.' });
        const now = new Date(); const batchId = `xmlrev-${Date.now()}-${randomUUID().slice(0, 8)}`;
        const beforeSource = await prisma.equipmentXmlSource.findUnique({ where: { id: source.id } });
        const snapshots: any[] = targetSpecs.map(target => {
          const live = liveById.get(target.elementId) as any;
          const version = Number(live.version || 1);
          return { elementId: live.id, oldSpecs: live.specs ?? null, newSpecs: live.specs ?? null, oldOverrides: live.overrides ?? null, newOverrides: live.overrides ?? null, oldVersion: version, newVersion: version };
        });
        if (snapshots.length) snapshots[0].sourceBindingAfter = { projectId: source.projectId, tagId: source.tagId, targetType: source.targetType, systemId: source.systemId ?? null, elementId: source.elementId, tagIdentifier: source.tagIdentifier, selectedRule: source.selectedRule, deletedAt: source.deletedAt ?? null };
        await prisma.$transaction(async (tx: any) => {
          for (const snapshot of snapshots) {
            const claim = await tx.componentElement.updateMany({ where: { id: snapshot.elementId, version: snapshot.oldVersion, specs: snapshot.oldSpecs, overrides: snapshot.oldOverrides }, data: { version: snapshot.oldVersion, specs: snapshot.oldSpecs, overrides: snapshot.oldOverrides } });
            if (claim.count !== 1) throw Object.assign(new Error('Позицию изменили параллельно с проверкой. Обновите сравнение XML.'), { status: 409 });
          }
          const claimed = await tx.equipmentXmlCandidate.updateMany({ where: { id: candidate.id, updatedAt: candidate.updatedAt, expectedVersion }, data: { status: 'complete' } });
          if (claimed.count !== 1) throw Object.assign(new Error('Кандидат уже изменился. Обновите список.'), { status: 409 });
          const sourceClaim = await tx.equipmentXmlSource.updateMany({ where: { id: source.id, tagIdentifier: source.tagIdentifier, selectedRule: source.selectedRule, lastImportedRevision: beforeSource?.lastImportedRevision ?? null, lastImportedSha256: beforeSource?.lastImportedSha256 ?? null, lastImportedAt: beforeSource?.lastImportedAt ?? null, lastReviewedRevision: beforeSource?.lastReviewedRevision ?? null, lastReviewedSha256: beforeSource?.lastReviewedSha256 ?? null, lastReviewedAt: beforeSource?.lastReviewedAt ?? null }, data: { lastImportedRevision: candidate.revision, lastImportedSha256: candidate.sha256, lastImportedAt: now, lastReviewedRevision: candidate.revision, lastReviewedSha256: candidate.sha256, lastReviewedAt: now } });
          if (sourceClaim.count !== 1) throw Object.assign(new Error('Импортированную ревизию параллельно обновили. Повторите проверку.'), { status: 409 });
          await tx.equipmentXmlApplication.create({ data: {
            id: randomUUID(), batchId, candidateId: candidate.id, sourceId: source.id, elementId: root.id,
            oldSpecs: root.specs ?? null, newSpecs: root.specs ?? null, oldOverrides: root.overrides ?? null, newOverrides: root.overrides ?? null,
            oldVersion: expectedVersion, newVersion: expectedVersion, targetSnapshots: JSON.stringify(snapshots), beforeDecisions: candidate.decisions || '{}', afterDecisions: candidate.decisions || '{}', beforeStatus: candidate.status, afterStatus: 'complete',
            oldImportedRevision: beforeSource?.lastImportedRevision ?? null, oldImportedSha256: beforeSource?.lastImportedSha256 ?? null, oldImportedAt: beforeSource?.lastImportedAt ?? null,
            newImportedRevision: candidate.revision, newImportedSha256: candidate.sha256, newImportedAt: now,
            oldReviewedRevision: beforeSource?.lastReviewedRevision ?? null, oldReviewedSha256: beforeSource?.lastReviewedSha256 ?? null, oldReviewedAt: beforeSource?.lastReviewedAt ?? null,
            newReviewedRevision: candidate.revision, newReviewedSha256: candidate.sha256, newReviewedAt: now, actorId: String(actor.id),
          } });
          for (const snapshot of snapshots) await tx.equipmentHistory.create({ data: { elementId: snapshot.elementId, version: snapshot.oldVersion, oldSpecs: snapshot.oldSpecs, newSpecs: snapshot.newSpecs, changeType: 'XML_REVISION', batchId } });
        });
        emitSourceChanged(projectId, source.id);
        return res.json({ ok: true, status: 'complete', expectedVersion, batchId, changed: false });
      }
      const structuralAsked = Array.isArray(req.body?.structuralDecisions) ? req.body.structuralDecisions : [];
      if ((!asked.length && !structuralAsked.length) || asked.length + structuralAsked.length > 500) return res.status(400).json({ error: 'Выберите хотя бы одно решение по характеристике или составу.' });
      const known = new Map(changes.map(change => [change.id, change]));
      const knownStructural = new Map(structuralActions.map((action: any) => [String(action.id || ''), action]));
      const decisions = storedObject(candidate.decisions, {}, 'Сохранённые решения') as Record<string, any>;
      const nextDecisions = { ...decisions };
      for (const item of asked) {
        const id = String(item?.id || ''); const change = known.get(id); const action = String(item?.action || '');
        if (!change || !['accept', 'keep', 'accept_missing'].includes(action) || (change.kind === 'missing' ? !['keep', 'accept_missing'].includes(action) : action === 'accept_missing')) return res.status(400).json({ error: 'Некорректное решение по характеристике.' });
        if (Object.prototype.hasOwnProperty.call(nextDecisions, id)) return res.status(409).json({ error: `Решение по «${change.key}» уже сохранено. Обновите список.` });
        nextDecisions[id] = { action, overrideManual: item?.overrideManual === true, userId: String(actor.id), at: new Date().toISOString() };
      }
      for (const item of structuralAsked) {
        const id = String(item?.id || ''); const action = String(item?.action || '');
        if (!knownStructural.has(id) || !['accept', 'keep'].includes(action)) return res.status(400).json({ error: 'Некорректное решение по составу установки.' });
        if (Object.prototype.hasOwnProperty.call(nextDecisions, id)) return res.status(409).json({ error: 'Решение по этому элементу состава уже сохранено.' });
        nextDecisions[id] = { action, structural: true, userId: String(actor.id), at: new Date().toISOString() };
      }
      type TargetUpdate = { element: any; oldSpecs: string | null; newSpecs: string | null; oldOverrides: string | null; newOverrides: string | null; oldVersion: number; newVersion: number; oldMetadata: Record<string, unknown>; newMetadata: Record<string, unknown>; existed: boolean; changed: boolean };
      const updates: TargetUpdate[] = [];
      const metadataOf = (live: any): Record<string, unknown> => ({
        name: live.name, itemCode: live.itemCode, monoblockId: live.monoblockId, parentElementId: live.parentElementId ?? null,
        status: live.status, sourceOrder: live.sourceOrder, equipType: live.equipType, role: live.role, sourceKind: live.sourceKind ?? null, manual: live.manual === true,
        instanceNo: live.instanceNo ?? null, instanceCount: live.instanceCount ?? null,
      });
      for (const target of targetSpecs) {
        const live = liveById.get(target.elementId) as any;
        const localChanges = changes.filter(change => String(change.targetId || root.id) === target.elementId);
        const localDecisions = Object.fromEntries(Object.entries(nextDecisions).filter(([id]) => localChanges.some(change => change.id === id)));
        const nextSpecs = applyEquipmentSourceDecisions(live.specs ?? null, target.groups, localChanges, localDecisions as any);
        let overrides: Record<string, unknown> = {};
        try {
          const parsedOverrides = live.overrides ? JSON.parse(live.overrides) : {};
          if (!parsedOverrides || typeof parsedOverrides !== 'object' || Array.isArray(parsedOverrides)) throw new Error('invalid overrides');
          overrides = parsedOverrides;
        } catch {
          if (asked.some((item: any) => localChanges.some(change => change.id === item?.id) && item?.overrideManual === true)) return res.status(409).json({ error: 'Карта ручных значений повреждена. Исправьте её перед заменой.' });
        }
        for (const item of asked) {
          const change = localChanges.find(change => change.id === item?.id);
          if (change && item?.overrideManual === true && ['accept', 'accept_missing'].includes(String(item?.action))) delete overrides[`${change.group}||${change.key}`];
        }
        let malformed = false;
        try { if (live.overrides) { const raw = JSON.parse(live.overrides); malformed = !raw || typeof raw !== 'object' || Array.isArray(raw); } } catch { malformed = true; }
        const nextOverrides = malformed ? (live.overrides ?? null) : (Object.keys(overrides).length ? JSON.stringify(overrides) : null);
        const oldSpecs = live.specs ?? null; const oldOverrides = live.overrides ?? null;
        const changed = !equipmentSourceSpecsEqual(oldSpecs, nextSpecs) || oldOverrides !== nextOverrides;
        const oldVersion = Number(live.version || 1);
        const metadata = metadataOf(live);
        updates.push({ element: live, oldSpecs, newSpecs: changed ? nextSpecs : oldSpecs, oldOverrides, newOverrides: changed ? nextOverrides : oldOverrides, oldVersion, newVersion: oldVersion + (changed ? 1 : 0), oldMetadata: metadata, newMetadata: metadata, existed: true, changed });
      }
      const metadataPatches = new Map<string, Record<string, unknown>>();
      const acceptedAdded: any[] = [];
      for (const action of structuralActions as any[]) {
        const decision = nextDecisions[action.id];
        if (decision?.action !== 'accept') continue;
        if (action.kind === 'added') {
          if (!decision.appliedElementId) acceptedAdded.push(action);
          continue;
        }
        const targetId = String(action.elementIds?.[0] || '');
        const live = liveById.get(targetId) as any;
        if (!live) return res.status(409).json({ error: 'Структурное изменение ссылается на уже удалённую позицию.' });
        const patch = metadataPatches.get(targetId) || {};
        if (action.kind === 'removed') patch.status = 'REMOVED';
        else if (action.kind === 'restored') patch.status = 'OK';
        else if (action.field === 'status') patch.status = action.after === 'ACTIVE' ? 'OK' : action.after;
        else if (action.field === 'title') patch.name = action.after;
        else if (action.field === 'equipType') patch.equipType = action.after;
        else if (action.field === 'role') patch.role = action.after;
        else if (action.field === 'sourceKind') patch.sourceKind = action.after || null;
        else if (action.field === 'instanceNo') patch.instanceNo = action.after ?? null;
        else if (action.field === 'instanceCount') patch.instanceCount = action.after ?? null;
        else if (action.field === 'sourceOrder') patch.sourceOrder = Number(action.after || 0);
        else if (action.field === 'parentElementId') patch.parentElementId = action.after || null;
        else if (action.field === 'monoblockName') {
          const monoblock = currentTargets.find((item: any) => item.monoblock?.name === action.after)?.monoblock;
          if (!monoblock) return res.status(409).json({ error: `Моноблок «${action.after}» нужно создать через полный план XML-импорта.` });
          patch.monoblockId = monoblock.id;
        }
        metadataPatches.set(targetId, patch);
      }
      for (const [targetId, patch] of metadataPatches) {
        const live = liveById.get(targetId) as any;
        let update = updates.find(item => item.element.id === targetId);
        if (!update) {
          const oldMetadata = metadataOf(live);
          update = { element: live, oldSpecs: live.specs ?? null, newSpecs: live.specs ?? null, oldOverrides: live.overrides ?? null, newOverrides: live.overrides ?? null, oldVersion: Number(live.version || 1), newVersion: Number(live.version || 1), oldMetadata, newMetadata: oldMetadata, existed: true, changed: false };
          updates.push(update);
        }
        update.newMetadata = { ...update.oldMetadata, ...patch };
        update.changed = update.changed || Object.keys(patch).some(key => update!.oldMetadata[key] !== update!.newMetadata[key]);
        update.newVersion = update.oldVersion + (update.changed ? 1 : 0);
      }
      // Проверяем правила тегов до записи. Связываем только точные совпадения;
      // дубли, занятые теги и недопустимые имена требуют отдельного решения
      // в полном плане импорта, без автоматического выбора.
      const sourceTagPolicy = acceptedAdded.length ? await importPolicyOfProject(projectId) : null;
      for (const action of acceptedAdded) {
        const proposal = action.proposed || {};
        if (!proposal.itemCode || !proposal.monoblockName || !Array.isArray(proposal.groups)) return res.status(409).json({ error: 'В предложении новой позиции не хватает обязательных данных.' });
        for (const identifier of Array.isArray(proposal.tags) ? proposal.tags : []) {
          const check = validateTag(identifier, sourceTagPolicy!);
          if (!check.ok) return res.status(409).json({ error: `Тег «${identifier}» нельзя создать: ${check.problem}` });
          const hits = await prisma.tag.findMany({ where: { projectId, identifier }, include: { componentElements: { select: { id: true } } } });
          if (hits.length > 1 || hits.some((tag: any) => (tag.componentElements || []).length > 0)) return res.status(409).json({ error: `Тег «${identifier}» неоднозначен или уже связан. Решите привязку через полный план импорта.` });
        }
      }
      const status = sourceDecisionStatus(changes, nextDecisions, structuralActions);
      const priorApplication = await prisma.equipmentXmlApplication.findFirst({ where: { candidateId: candidate.id }, orderBy: { createdAt: 'asc' } });
      const batchId = priorApplication?.batchId || `xmlrev-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const rootUpdate = updates.find(item => item.element.id === root.id)!;
      const finalExpectedVersions = Object.fromEntries(updates.map(item => [item.element.id, item.newVersion]));
      const finalVersion = rootUpdate.newVersion;
      const now = new Date();
      const importedBaselineChanged = status === 'complete';
      const reviewedBaselineChanged = status === 'complete' || status === 'keepResolved';
      const createdSnapshots: any[] = [];
      await prisma.$transaction(async (tx: any) => {
        const sourceClaim = await tx.equipmentXmlSource.updateMany({ where: { id: source.id, projectId, deletedAt: null, tagIdentifier: source.tagIdentifier, selectedRule: source.selectedRule }, data: { updatedAt: source.updatedAt } });
        if (sourceClaim.count !== 1) throw Object.assign(new Error('Источник перепривязали во время сравнения. Проверьте XML заново.'), { status: 409 });
        const tagClaim = await tx.tag.updateMany({ where: { id: tag.id, projectId, identifier: source.tagIdentifier }, data: { updatedAt: tag.updatedAt } });
        if (tagClaim.count !== 1) throw Object.assign(new Error('Тег источника переименовали во время сравнения. Проверьте XML заново.'), { status: 409 });
        for (const update of updates) {
          const claim = await tx.componentElement.updateMany({ where: { id: update.element.id, version: update.oldVersion, specs: update.oldSpecs, overrides: update.oldOverrides, ...update.oldMetadata }, data: update.changed ? withBump({ specs: update.newSpecs, overrides: update.newOverrides, ...update.newMetadata }) : { version: update.oldVersion, specs: update.oldSpecs, overrides: update.oldOverrides } });
          if (claim.count !== 1) throw Object.assign(new Error(`Позицию «${update.element.itemCode}» изменили параллельно. Обновите сравнение.`), { status: 409 });
        }
        for (const action of acceptedAdded) {
          const proposal = action.proposed;
          const systemId = String(source.systemId || '');
          let monoblock = await tx.monoblock.findFirst({ where: { systemId, name: proposal.monoblockName } });
          if (!monoblock) monoblock = await tx.monoblock.create({ data: { systemId, name: proposal.monoblockName } });
          const duplicate = await tx.componentElement.findMany({ where: { monoblockId: monoblock.id, itemCode: proposal.itemCode, status: { not: 'REMOVED' } }, select: { id: true } });
          if (duplicate.length) throw Object.assign(new Error(`Позиция «${proposal.itemCode}» уже существует в моноблоке «${proposal.monoblockName}».`), { status: 409 });
          let parentElementId: string | null = null;
          if (proposal.parentName) {
            const parents = await tx.componentElement.findMany({ where: { monoblockId: monoblock.id, itemCode: proposal.parentName, status: { not: 'REMOVED' } }, select: { id: true } });
            if (parents.length !== 1) throw Object.assign(new Error(`Для новой позиции «${proposal.itemCode}» родитель «${proposal.parentName}» не найден однозначно.`), { status: 409 });
            parentElementId = parents[0].id;
          }
          const connectTagIds: string[] = [];
          for (const identifier of Array.isArray(proposal.tags) ? proposal.tags : []) {
            const hits = await tx.tag.findMany({ where: { projectId, identifier }, include: { componentElements: { select: { id: true } } } });
            if (hits.length > 1 || hits.some((tag: any) => (tag.componentElements || []).length)) throw Object.assign(new Error(`Тег «${identifier}» изменился или связан параллельно.`), { status: 409 });
            if (hits.length === 1) connectTagIds.push(hits[0].id);
            else {
              const tag = await tx.tag.create({ data: { projectId, identifier } });
              await recordTagCreated(tx, { projectId, userId: String(actor.id), source: TAG_SOURCE.equipmentImport }, tag);
              connectTagIds.push(tag.id);
            }
          }
          const specs = JSON.stringify({ groups: proposal.groups });
          const created = await tx.componentElement.create({ data: {
            monoblockId: monoblock.id, itemCode: proposal.itemCode, name: proposal.title || proposal.itemCode,
            equipType: proposal.equipType || 'ПРОЧЕЕ', specs, version: 1, status: 'OK', manual: false,
            role: proposal.role || 'БЛОК', sourceKind: proposal.sourceKind || null,
            sourceOrder: Number.isFinite(Number(proposal.sourceOrder)) ? Number(proposal.sourceOrder) : 0,
            parentElementId, instanceNo: proposal.instanceNo ?? null, instanceCount: proposal.instanceCount ?? null,
            ...(connectTagIds.length ? { tags: { connect: connectTagIds.map(id => ({ id })) } } : {}),
          } });
          createdSnapshots.push({ elementId: created.id, oldSpecs: null, newSpecs: created.specs, oldOverrides: null, newOverrides: null, oldVersion: 0, newVersion: Number(created.version || 1), oldMetadata: null, newMetadata: metadataOf(created), existed: false, created: true });
          nextDecisions[action.id] = { ...(nextDecisions[action.id] || {}), appliedElementId: created.id };
          await tx.equipmentHistory.create({ data: { elementId: created.id, version: 1, oldSpecs: null, newSpecs: specs, changeType: 'XML_REVISION_CREATE', batchId } });
        }
        const beforeSource = await tx.equipmentXmlSource.findUnique({ where: { id: source.id } });
        if (importedBaselineChanged || reviewedBaselineChanged) {
          const sourceClaim = await tx.equipmentXmlSource.updateMany({ where: { id: source.id, tagIdentifier: source.tagIdentifier, selectedRule: source.selectedRule, lastImportedRevision: beforeSource?.lastImportedRevision ?? null, lastImportedSha256: beforeSource?.lastImportedSha256 ?? null, lastImportedAt: beforeSource?.lastImportedAt ?? null, lastReviewedRevision: beforeSource?.lastReviewedRevision ?? null, lastReviewedSha256: beforeSource?.lastReviewedSha256 ?? null, lastReviewedAt: beforeSource?.lastReviewedAt ?? null }, data: {
          ...(importedBaselineChanged ? { lastImportedRevision: candidate.revision, lastImportedSha256: candidate.sha256, lastImportedAt: now } : {}),
          ...(reviewedBaselineChanged ? { lastReviewedRevision: candidate.revision, lastReviewedSha256: candidate.sha256, lastReviewedAt: now } : {}),
          } });
          if (sourceClaim.count !== 1) throw Object.assign(new Error('Импортированную ревизию параллельно обновили. Повторите проверку.'), { status: 409 });
        }
        const sourceBindingAfter = { projectId: source.projectId, tagId: source.tagId, targetType: source.targetType, systemId: source.systemId ?? null, elementId: source.elementId, tagIdentifier: source.tagIdentifier, selectedRule: source.selectedRule, deletedAt: source.deletedAt ?? null };
        const currentSnapshots = [...updates.map(({ element: item, ...snapshot }) => ({ elementId: item.id, ...snapshot })), ...createdSnapshots];
        let priorSnapshots: any[] = [];
        if (priorApplication) {
          const parsedPrior = parseJson(priorApplication.targetSnapshots, null);
          if (!Array.isArray(parsedPrior)) throw Object.assign(new Error('Снимок предыдущих решений XML имеет неверный формат; изменения не сохранены.'), { status: 409 });
          priorSnapshots = parsedPrior;
        }
        const snapshotsById = new Map<string, any>();
        for (const snapshot of priorSnapshots) snapshotsById.set(snapshot.elementId, snapshot);
        for (const snapshot of currentSnapshots) {
          const previous = snapshotsById.get(snapshot.elementId);
          snapshotsById.set(snapshot.elementId, previous ? { ...snapshot,
            oldSpecs: previous.oldSpecs, oldOverrides: previous.oldOverrides, oldVersion: previous.oldVersion,
            oldMetadata: previous.oldMetadata, existed: previous.existed, created: previous.created,
            sourceBindingAfter: previous.sourceBindingAfter,
          } : snapshot);
        }
        const targetSnapshots = [...snapshotsById.values()];
        if (targetSnapshots.length && !targetSnapshots.some(item => item.sourceBindingAfter)) targetSnapshots[0].sourceBindingAfter = sourceBindingAfter;
        const cumulativeExpectedVersions = Object.fromEntries(targetSnapshots.map(item => [item.elementId, item.newVersion]));
        const candidateClaim = await tx.equipmentXmlCandidate.updateMany({ where: { id: candidate.id, updatedAt: candidate.updatedAt, expectedVersion: Number(candidate.expectedVersion) }, data: { decisions: JSON.stringify(nextDecisions), status, expectedVersion: finalVersion, expectedVersions: JSON.stringify(cumulativeExpectedVersions) } });
        if (candidateClaim.count !== 1) throw Object.assign(new Error('Решение уже изменилось в другой сессии. Обновите список.'), { status: 409 });
        const applicationData = {
          candidateId: candidate.id, sourceId: source.id, elementId: root.id,
          oldSpecs: priorApplication?.oldSpecs ?? rootUpdate.oldSpecs, newSpecs: rootUpdate.newSpecs,
          oldOverrides: priorApplication?.oldOverrides ?? rootUpdate.oldOverrides, newOverrides: rootUpdate.newOverrides,
          oldVersion: priorApplication?.oldVersion ?? rootUpdate.oldVersion, newVersion: rootUpdate.newVersion,
          targetSnapshots: JSON.stringify(targetSnapshots), beforeDecisions: priorApplication?.beforeDecisions ?? candidate.decisions ?? '{}', afterDecisions: JSON.stringify(nextDecisions),
          beforeStatus: priorApplication?.beforeStatus ?? candidate.status, afterStatus: status,
          oldImportedRevision: priorApplication?.oldImportedRevision ?? beforeSource?.lastImportedRevision ?? null, oldImportedSha256: priorApplication?.oldImportedSha256 ?? beforeSource?.lastImportedSha256 ?? null, oldImportedAt: priorApplication?.oldImportedAt ?? beforeSource?.lastImportedAt ?? null,
          newImportedRevision: importedBaselineChanged ? candidate.revision : (beforeSource?.lastImportedRevision ?? null), newImportedSha256: importedBaselineChanged ? candidate.sha256 : (beforeSource?.lastImportedSha256 ?? null), newImportedAt: importedBaselineChanged ? now : (beforeSource?.lastImportedAt ?? null),
          oldReviewedRevision: priorApplication?.oldReviewedRevision ?? beforeSource?.lastReviewedRevision ?? null, oldReviewedSha256: priorApplication?.oldReviewedSha256 ?? beforeSource?.lastReviewedSha256 ?? null, oldReviewedAt: priorApplication?.oldReviewedAt ?? beforeSource?.lastReviewedAt ?? null,
          newReviewedRevision: reviewedBaselineChanged ? candidate.revision : (beforeSource?.lastReviewedRevision ?? null), newReviewedSha256: reviewedBaselineChanged ? candidate.sha256 : (beforeSource?.lastReviewedSha256 ?? null), newReviewedAt: reviewedBaselineChanged ? now : (beforeSource?.lastReviewedAt ?? null), actorId: String(actor.id),
        };
        if (priorApplication) {
          const updated = await tx.equipmentXmlApplication.updateMany({ where: { id: priorApplication.id, batchId }, data: applicationData });
          if (updated.count !== 1) throw Object.assign(new Error('Снимок операции XML параллельно изменился.'), { status: 409 });
        } else await tx.equipmentXmlApplication.create({ data: { id: randomUUID(), batchId, ...applicationData } });
        for (const update of updates) if (update.changed) await tx.equipmentHistory.create({ data: { elementId: update.element.id, version: update.oldVersion, oldSpecs: update.oldSpecs, newSpecs: update.newSpecs, changeType: 'XML_REVISION', batchId } });
      });
      for (const update of updates) if (update.changed) emitEntityChanged('element', update.element.id, req);
      for (const created of createdSnapshots) emitEntityChanged('element', created.elementId, req);
      emitSourceChanged(projectId, source.id);
      res.json({ ok: true, status, expectedVersion: finalVersion, expectedVersions: finalExpectedVersions, batchId, changed: updates.some(update => update.changed) || createdSnapshots.length > 0 });
    } catch (err: any) {
      if (err.code === 'P2002') return res.status(409).json({ error: 'Этот кандидат уже сохранён.' });
      sendError(res, err, err.status || 500);
    }
  });
}
