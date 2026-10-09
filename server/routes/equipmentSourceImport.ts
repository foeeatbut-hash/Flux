import { createHash, randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { XMLValidator } from 'fast-xml-parser';
import { broadcast, getPrisma, sendError } from '../context.js';
import { decodeVerifiedSource } from './equipmentXmlSources.js';
import { parseEquipmentXML, type EquipParseResult, type ParsedUnit } from '../equipmentParser.js';
import { planEquipmentImport, applyEdits, filterBySelection, type EditMap } from '../equipmentPlan.js';
import { importEquipmentToDB } from '../equipmentImport.js';
import { cleanChoices } from '../equipmentResolve.js';
import { cleanTagLinks } from './equipmentDraft.js';
import type { TagLink } from '../equipmentTags.js';
import { inferEquipmentSourceFilenameRule, matchesEquipmentSourceFilename, type EquipmentSourceFilenameRule } from '../../equipment/sourceXml.js';
import { actorMay } from '../projectAccess.js';
import { canSeeProject, roleGrantsOf } from './members.js';
import { isPrivilegedUser } from '../accessPolicy.js';
import { blockKey } from '../specUtils.js';
import { emitProjectDataChanged } from '../entityChanged.js';

type RequestData = {
  projectId?: unknown; category?: unknown; fileName?: unknown; revision?: unknown;
  tagIdentifier?: unknown; sha256?: unknown; size?: unknown; base64?: unknown;
  edits?: EditMap; choices?: unknown; selection?: unknown; tagLinks?: unknown; conflictMode?: unknown; previewToken?: unknown;
};

const tagKey = (value: unknown) => String(value ?? '').normalize('NFC').trim().toLocaleLowerCase();
const actorOf = (req: Request) => (req as any).authUser || null;
const error = (message: string, status = 400) => Object.assign(new Error(message), { status });

async function authorize(req: Request, projectId: string) {
  const actor = actorOf(req);
  if (!actor?.id) throw error('Требуется вход', 401);
  if (!(await getPrisma().project.findUnique({ where: { id: projectId }, select: { id: true } }))) throw error('Проект не найден', 404);
  if (!(await canSeeProject(String(actor.id), projectId, isPrivilegedUser(actor)))) throw error('Проект недоступен', 403);
  if (!(await actorMay(actor, roleGrantsOf, 'equipment.manage'))) throw error('Нужно право «Правка характеристик оборудования»', 403);
  return actor;
}

function validateInput(body: RequestData) {
  const projectId = String(body.projectId || '');
  const category = String(body.category || '');
  const fileName = String(body.fileName || '');
  const revision = String(body.revision || '').trim();
  const identifier = String(body.tagIdentifier || '').normalize('NFC').trim();
  if (!projectId || !category || !identifier) throw error('Укажите проект, категорию и корневой тег.');
  if (!fileName || fileName.length > 255 || /[/\\\u0000-\u001f]/u.test(fileName) || fileName === '.' || fileName === '..') throw error('Передайте только имя XML-файла без пути.');
  if (!revision || revision.length > 255 || /[\u0000-\u001f\u007f]/u.test(revision)) throw error('Не удалось определить обозначение ревизии XML.');
  return { projectId, category, fileName, revision, identifier };
}

function selectedUnit(result: EquipParseResult, identifier: string): ParsedUnit {
  const hits = result.units.filter(unit => tagKey(unit.name) === tagKey(identifier) || (unit.tags || []).some(tag => tagKey(tag) === tagKey(identifier)));
  if (hits.length !== 1) throw error(hits.length ? `Корневой тег «${identifier}» найден в XML несколько раз.` : `Корневой тег «${identifier}» не совпадает ни с именем установки, ни с её тегами.`);
  return hits[0];
}

function sourceRule(fileName: string, identifier: string): EquipmentSourceFilenameRule {
  const rule = inferEquipmentSourceFilenameRule(fileName, identifier);
  if (!rule || !matchesEquipmentSourceFilename(fileName, identifier, rule)) throw error(`Имя файла «${fileName}» не содержит точный тег «${identifier}».`);
  return rule;
}

function parseBody(body: RequestData) {
  const input = validateInput(body);
  const { text, sha256 } = decodeVerifiedSource(body);
  if (XMLValidator.validate(text) !== true) throw error('XML повреждён или не завершён; оборудование не изменено.');
  const parsed = parseEquipmentXML(text);
  if (!parsed.units.length) throw error('В XML не найдены установки для импорта.');
  const unit = selectedUnit(parsed, input.identifier);
  const rule = sourceRule(input.fileName, input.identifier);
  // Тег корня — пользовательский выбор для импорта. Добавляем его к штатному
  // служебному блоку, чтобы общий планировщик и импортёр одинаково связали его.
  const result: EquipParseResult = {
    ...parsed,
    units: parsed.units.map(item => item === unit
      ? { ...item, tags: Array.from(new Set([...(item.tags || []), input.identifier])) }
      : item),
  };
  return { ...input, text, sha256, result, unitName: unit.name, rule };
}

function normalizedPlanOptions(body: RequestData) {
  return { edits: body.edits || {}, choices: cleanChoices(body.choices) };
}

async function planWithSafeChoices(prisma: any, input: ReturnType<typeof parseBody>, edited: EquipParseResult, choices: Record<string, string>, requireReview: boolean) {
  // Сначала получаем перечень пропавших позиций, затем по умолчанию оставляем
  // их. Снятие возможно только по явному решению для конкретной строки.
  const candidate = await planEquipmentImport(prisma, input.projectId, input.category, edited, {
    fileName: input.fileName, choices, removeMissing: true,
  });
  const safeChoices = { ...choices };
  for (const row of candidate.missing) {
    const decision = choices[row.key];
    if (decision !== undefined && decision !== 'keep' && decision !== 'remove') throw error(`Для отсутствующей позиции «${row.title}» выберите «оставить» или «снять».`);
    safeChoices[row.key] = decision === 'remove' ? 'remove' : 'keep';
  }
  const plan = await planEquipmentImport(prisma, input.projectId, input.category, edited, {
    fileName: input.fileName, choices: safeChoices, removeMissing: true,
  });
  if (requireReview) {
    for (const row of [...plan.matches, ...plan.systemRows]) {
      const selected = safeChoices[row.key];
      if (!selected || !row.options.some((option: any) => option.value === selected)) {
        throw error(`План импорта требует решения для строки «${row.key}». Обновите план и подтвердите выбранный вариант.`, 409);
      }
    }
  }
  return { plan, choices: safeChoices };
}

async function sourceImportPreviewToken(prisma: any, input: ReturnType<typeof parseBody>, edited: EquipParseResult, edits: EditMap): Promise<string> {
  const { plan } = await planWithSafeChoices(prisma, input, edited, {}, false);
  const [systems, tags, sources] = await Promise.all([
    prisma.equipmentSystem.findMany({ where: { projectId: input.projectId, category: input.category }, orderBy: { id: 'asc' }, include: {
      monoblocks: { orderBy: { id: 'asc' }, include: { components: { orderBy: { id: 'asc' }, include: { tags: { orderBy: { id: 'asc' }, select: { id: true, identifier: true } } } } } },
    } }),
    prisma.tag.findMany({ where: { projectId: input.projectId }, orderBy: { id: 'asc' }, select: { id: true, identifier: true, metadata: true, componentElements: { orderBy: { id: 'asc' }, select: { id: true } } } }),
    prisma.equipmentXmlSource.findMany({ where: { projectId: input.projectId, deletedAt: null }, orderBy: { id: 'asc' }, select: {
      id: true, tagId: true, targetType: true, systemId: true, elementId: true, tagIdentifier: true,
      selectedRule: true, lastImportedRevision: true, lastImportedSha256: true,
    } }),
  ]);
  const state = systems.map((system: any) => ({
    id: system.id, name: system.name, fileName: system.fileName,
    monoblocks: system.monoblocks.map((monoblock: any) => ({
      id: monoblock.id, name: monoblock.name,
      components: monoblock.components.map((component: any) => ({
        id: component.id, itemCode: component.itemCode, version: component.version, specs: component.specs,
        overrides: component.overrides, paramConflicts: component.paramConflicts, status: component.status,
        manual: component.manual, parentElementId: component.parentElementId, tags: component.tags,
      })),
    })),
  }));
  const stable = JSON.stringify({
    input: { projectId: input.projectId, category: input.category, fileName: input.fileName,
      revision: input.revision, identifier: input.identifier, sha256: input.sha256, edits },
    plan, state, tags, sources,
  });
  return createHash('sha256').update(stable).digest('hex');
}

export function registerEquipmentSourceImportRoutes(app: Express): void {
  app.post('/api/equipment/source-import/preview', async (req: Request, res: Response) => {
    try {
      const body = req.body as RequestData;
      const input = parseBody(body);
      await authorize(req, input.projectId);
      const { edits, choices } = normalizedPlanOptions(body);
      const edited = applyEdits(input.result, edits);
      const { plan: preview } = await planWithSafeChoices(getPrisma(), input, edited, choices, false);
      const previewToken = await sourceImportPreviewToken(getPrisma(), input, edited, edits);
      const rootKey = blockKey(input.unitName, '', '__unit__');
      const rootLink = preview.tagLinks.find(link => link.blockKey === rootKey && tagKey(link.identifier) === tagKey(input.identifier));
      if (!rootLink || ['invalid', 'ambiguous'].includes(rootLink.action)) throw error(rootLink?.problem || `Тег «${input.identifier}» нельзя связать с установкой по правилам проекта.`);
      res.json({
        success: true, fileName: input.fileName, sha256: input.sha256, revision: input.revision,
        unitTag: { identifier: input.identifier, existingTagId: rootLink.existingTagId || null, action: rootLink.action },
        plan: preview, previewToken,
      });
    } catch (err: any) { sendError(res, err, err.status || 500); }
  });

  app.post('/api/equipment/source-import/apply', async (req: Request, res: Response) => {
    const body = req.body as RequestData;
    try {
      const input = parseBody(body);
      const actor = await authorize(req, input.projectId);
      const prisma = getPrisma();
      const { edits, choices } = normalizedPlanOptions(body);
      const edited = applyEdits(input.result, edits);
      const suppliedPreviewToken = String(body.previewToken || '');
      if (!/^[a-f0-9]{64}$/u.test(suppliedPreviewToken)) throw error('План устарел. Повторите предпросмотр перед импортом.', 409);
      const actualPreviewToken = await sourceImportPreviewToken(prisma, input, edited, edits);
      if (actualPreviewToken !== suppliedPreviewToken) throw error('Данные проекта изменились после предпросмотра. Обновите план импорта.', 409);
      const unit = selectedUnit(edited, input.identifier);
      const rootKey = blockKey(unit.name, '', '__unit__');
      const selected = Array.isArray(body.selection) ? new Set(body.selection.map(String)) : null;
      if (selected && !selected.has(rootKey)) throw error('Перед подтверждением выберите корневую запись установки, к которой привязывается XML.');
      const selectedResult = filterBySelection(edited, selected);
      if (!selectedResult.units.length) throw error('Не выбрано ни одной позиции для импорта.');
      const { plan: planned, choices: reviewedChoices } = await planWithSafeChoices(prisma, input, edited, choices, true);
      const plannedRootLink = planned.tagLinks.find(link => link.blockKey === rootKey && tagKey(link.identifier) === tagKey(input.identifier));
      if (!plannedRootLink || ['invalid', 'ambiguous'].includes(plannedRootLink.action)) throw error(plannedRootLink?.problem || `Тег «${input.identifier}» нельзя связать с установкой.`);
      const sameRevisionIsNoOp = !planned.matches.length && !planned.systemRows.length
        && !planned.missing.some(row => reviewedChoices[row.key] === 'remove');

      // Повторная отправка той же проверенной ревизии не создаёт новый batch,
      // историю или версии оборудования.
      const oldSource = await prisma.equipmentXmlSource.findFirst({ where: {
        projectId: input.projectId, tagIdentifier: input.identifier, targetType: 'system',
        lastImportedSha256: input.sha256, deletedAt: null,
      } });
      if (oldSource && sameRevisionIsNoOp) {
        const [tag, system, element] = await Promise.all([
          prisma.tag.findFirst({ where: { id: oldSource.tagId, projectId: input.projectId } }),
          prisma.equipmentSystem.findFirst({ where: { id: oldSource.systemId || '', projectId: input.projectId, category: input.category, name: input.unitName, fileName: input.fileName } }),
          prisma.componentElement.findFirst({ where: { id: oldSource.elementId, itemCode: '__unit__', monoblock: { systemId: oldSource.systemId || '', name: '__unit__' } }, include: { tags: true } }),
        ]);
        if (tag && system && element && (element.tags || []).some((item: any) => item.id === tag.id)) return res.json({ success: true, duplicate: true, fileName: input.fileName, revision: input.revision, sha256: input.sha256, source: {
          sourceId: oldSource.id, tagId: tag.id, targetType: 'system', systemId: system.id,
          elementId: element.id, revision: input.revision, sha256: input.sha256, fileName: input.fileName,
        } });
      }

      const rootLink = plannedRootLink;
      if (!rootLink || ['invalid', 'ambiguous'].includes(rootLink.action)) throw error(rootLink?.problem || `Тег «${input.identifier}» нельзя связать с установкой.`);
      const suppliedLinks = (cleanTagLinks(body.tagLinks) || []) as TagLink[];
      // Сохранить выбор инженера по остальным позициям, но корневой тег источника
      // принудительно берётся из серверного плана и не может быть пропущен.
      const links = [...suppliedLinks.filter(link => !(link.blockKey === rootKey && tagKey(link.identifier) === tagKey(input.identifier))), rootLink];
      // Импорт первого источника всегда сохраняет прежние значения при конфликте;
      // решение «принять расчёт» остаётся отдельным явным действием инженера.
      const mode = 'wait' as const;

      const result = await prisma.$transaction(async (tx: any) => {
        const transactionPreviewToken = await sourceImportPreviewToken(tx, input, edited, edits);
        if (transactionPreviewToken !== suppliedPreviewToken) throw error('Данные проекта изменились во время импорта. Обновите план и повторите подтверждение.', 409);
        const racedSource = await tx.equipmentXmlSource.findFirst({ where: {
          projectId: input.projectId, tagIdentifier: input.identifier, targetType: 'system',
          lastImportedSha256: input.sha256, deletedAt: null,
        } });
        if (racedSource && sameRevisionIsNoOp) {
          const [tag, system, element] = await Promise.all([
            tx.tag.findFirst({ where: { id: racedSource.tagId, projectId: input.projectId } }),
            tx.equipmentSystem.findFirst({ where: { id: racedSource.systemId || '', projectId: input.projectId, category: input.category, name: input.unitName, fileName: input.fileName } }),
            tx.componentElement.findFirst({ where: { id: racedSource.elementId, itemCode: '__unit__', monoblock: { systemId: racedSource.systemId || '', name: '__unit__' } }, include: { tags: true } }),
          ]);
          if (tag && system && element && (element.tags || []).some((item: any) => item.id === tag.id)) return { duplicate: true as const, source: racedSource, tag, system, root: element };
          throw error('Найдено прежнее сохранение этой ревизии, но его привязка повреждена; повторный импорт остановлен.', 409);
        }
        const summary = await importEquipmentToDB(tx, input.projectId, input.category, input.fileName, selectedResult, mode, links,
          { userId: String(actor.id) }, { choices: reviewedChoices, full: edited, removeMissing: true, deferEntityChanged: true });
        const systemRows = await tx.equipmentSystem.findMany({ where: {
          projectId: input.projectId, category: input.category, name: input.unitName, fileName: input.fileName,
        } });
        if (systemRows.length !== 1) throw error('После импорта не удалось однозначно определить установку для XML; изменения отменены.', 409);
        const system = systemRows[0];
        const roots = await tx.componentElement.findMany({ where: { monoblock: { systemId: system.id, name: '__unit__' }, itemCode: '__unit__' }, include: { tags: true } });
        const matchingRoots = roots.filter((row: any) => (row.tags || []).some((tag: any) => tag.identifier === input.identifier));
        if (matchingRoots.length !== 1) throw error('После импорта корневой тег не связан ровно с одной служебной записью установки; изменения отменены.', 409);
        const root = matchingRoots[0];
        const tag = (root.tags || []).find((candidate: any) => candidate.identifier === input.identifier);
        const now = new Date();
        const sourceBaselineApplied = summary.conflictsCount === 0
          && JSON.stringify(selectedResult.units) === JSON.stringify(edited.units);
        const priorBinding = await tx.equipmentXmlSource.findFirst({ where: {
          projectId: input.projectId, targetType: 'system', tagId: tag.id, deletedAt: null,
        }, orderBy: { createdAt: 'asc' } });
        if (priorBinding && (priorBinding.systemId !== system.id || priorBinding.elementId !== root.id)) {
          throw error('Тег источника уже связан с другой установкой. Сначала проверьте или перепривяжите источник.', 409);
        }
        const source = priorBinding
          ? await tx.equipmentXmlSource.update({ where: { id: priorBinding.id }, data: {
            tagIdentifier: input.identifier, selectedRule: JSON.stringify(input.rule),
            ...(sourceBaselineApplied ? { lastImportedRevision: input.revision, lastImportedSha256: input.sha256, lastImportedAt: now,
              lastReviewedRevision: input.revision, lastReviewedSha256: input.sha256, lastReviewedAt: now } : {}),
          } })
          : await tx.equipmentXmlSource.create({ data: {
            id: randomUUID(), projectId: input.projectId, tagId: tag.id, targetType: 'system',
            systemId: system.id, elementId: root.id, tagIdentifier: input.identifier,
            revisionOrder: JSON.stringify(['A','B','C','D','E','F','G','H','I','J']),
            selectedRule: JSON.stringify(input.rule),
            ...(sourceBaselineApplied ? { lastImportedRevision: input.revision, lastImportedSha256: input.sha256,
              lastImportedAt: now, lastReviewedRevision: input.revision, lastReviewedSha256: input.sha256, lastReviewedAt: now } : {}),
            createdById: String(actor.id),
          } });
        return { duplicate: false as const, summary, source, tag, system, root };
      }, { timeout: 30_000, isolationLevel: 'Serializable' });
      if (result.duplicate) return res.json({ success: true, duplicate: true, fileName: input.fileName,
        revision: input.revision, sha256: input.sha256, source: { sourceId: result.source.id,
          tagId: result.tag.id, targetType: 'system', systemId: result.system.id,
          elementId: result.root.id, revision: input.revision, sha256: input.sha256, fileName: input.fileName } });
      const summary = result.summary;
      if (summary.newBlocks || summary.updatedBlocks || summary.movedBlocks || summary.supersededBlocks
        || summary.removedBlocks || summary.restoredBlocks) emitProjectDataChanged('element', input.projectId, actor);
      if (summary.tagsLinked || summary.tagsCreated || summary.tagParents) emitProjectDataChanged('tag', input.projectId, actor);
      broadcast('entity:changed', { kind: 'equipment-source', id: result.source.id, projectId: input.projectId, at: Date.now() });
      res.json({ success: true, fileName: input.fileName, revision: input.revision, sha256: input.sha256,
        baselineApplied: summary.conflictsCount === 0,
        conflictsCount: result.summary.conflictsCount, newBlocks: result.summary.newBlocks,
        updatedBlocks: result.summary.updatedBlocks, movedBlocks: result.summary.movedBlocks || 0,
        removedBlocks: result.summary.removedBlocks || 0, systems: result.summary.systems,
        batchId: result.summary.batchId, tagsLinked: result.summary.tagsLinked,
        tagsCreated: result.summary.tagsCreated, conflictMode: mode,
        source: { sourceId: result.source.id, tagId: result.tag.id, targetType: 'system',
          systemId: result.system.id, elementId: result.root.id, revision: input.revision,
          sha256: input.sha256, fileName: input.fileName },
      });
    } catch (err: any) { sendError(res, err, err.status || 500); }
  });
}
