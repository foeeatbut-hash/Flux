import { createHash, randomUUID } from 'node:crypto';
import { hasPosition } from '../shared/positions.js';
import { buildFileName, maskParts } from '../shared/docflow/nameMask.js';
import { loadKitContext, requirementFor, itemAppliesToTag, parse, iso, type KitContext } from './docflowKitContext.js';
import { DocflowPlanError, saveDocflowPlan, loadDocflowPlan, parsedPlan, finishDocflowPlan } from './docflowPlans.js';

const KIND = 'kit-rows';
const json = (v: unknown) => JSON.stringify(v);
interface Selection { registerId: string; tagIds: string[]; stage: 'П' | 'Р'; fields: Record<string, string> }
function selectionOf(raw: any): Selection {
  if (typeof raw?.registerId !== 'string' || !raw.registerId || raw.registerId.length > 100) throw new DocflowPlanError('Выберите реестр проекта', 400);
  if (!Array.isArray(raw.tagIds) || !raw.tagIds.length || raw.tagIds.length > 500 || raw.tagIds.some((id: any) => typeof id !== 'string' || !id || id.length > 100)) throw new DocflowPlanError('Выберите от 1 до 500 тегов', 400);
  if (!['П', 'Р'].includes(raw.stage)) throw new DocflowPlanError('Выберите стадию П или Р', 400);
  const fields = raw.fields ?? {};
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.entries(fields).some(([k, v]) => !['заказ', 'установка', 'договор', 'язык'].includes(k) || typeof v !== 'string' || v.length > 100 || /[\\/:*?"<>|\u0000-\u001f]/.test(v))) throw new DocflowPlanError('Неверные поля шифра', 400);
  return { registerId: raw.registerId, tagIds: [...new Set<string>(raw.tagIds)].sort(), stage: raw.stage, fields };
}
function workingDate(start: string, days: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || Number.isNaN(Date.parse(start))) return null;
  const date = new Date(`${start}T12:00:00Z`);
  if (date.toISOString().slice(0, 10) !== start) return null;
  for (let left = days; left > 0;) { date.setUTCDate(date.getUTCDate() + 1); if (![0, 6].includes(date.getUTCDay())) left--; }
  return `${date.toISOString().slice(0, 10)}T00:00:00.000Z`;
}
function fingerprint(context: KitContext) {
  return createHash('sha256').update(json({ settings: context.settings, tags: context.tags.map(t => [t.id, t.identifier, t.updatedAt, t.equipment, t.sourceVersions]),
    items: context.items, links: context.links, files: context.files, reservations: context.reservations, registers: context.registers,
  })).digest('hex');
}
async function preview(prisma: any, projectId: string, selection: Selection) {
  const context = await loadKitContext(prisma, projectId);
  const register = context.registers.find(r => r.id === selection.registerId);
  if (!register) throw new DocflowPlanError('Реестр не найден в этом проекте', 403);
  if (selection.tagIds.some(id => !context.tags.some(tag => tag.id === id))) throw new DocflowPlanError('Тег не найден в этом проекте', 403);
  const members: any[] = await prisma.projectMember.findMany({ where: { projectId }, select: { userId: true } });
  const users: any[] = await prisma.user.findMany({ where: { isActive: true, ...(members.length ? { id: { in: members.map(m => m.userId) } } : {}) }, select: { id: true, name: true, role: true, positionCode: true, extraPositions: true, validUntil: true } });
  const candidates = new Map<string, any>();
  const { config } = context.settings;
  for (const tag of context.tags.filter(t => selection.tagIds.includes(t.id))) {
    const kit = config.kits.find(k => k.classId === tag.classId);
    if (!kit) {
      candidates.set(`missing:${tag.id}`, { key: `missing:${tag.id}`, tagIds: [tag.id], docType: '', unit: 'tag', scopeId: tag.id, action: 'skip', problem: tag.classId ? 'Для класса не задан комплект' : 'Выберите класс Каталога в карточке тега' });
      continue;
    }
    for (const spec of kit.items.filter(item => !item.stage || item.stage === selection.stage)) {
      const requirement = requirementFor(context, tag, spec);
      const previous = candidates.get(requirement.key);
      if (previous) {
        if (json(previous.spec) !== json(spec)) previous.problem = 'Для общего документа различаются настройки комплектов. Согласуйте их перед созданием.';
        previous.needed ||= requirement.needed;
      } else candidates.set(requirement.key, { ...requirement });
    }
  }
  if (candidates.size > 500) throw new DocflowPlanError('План содержит больше 500 строк. Выберите меньше тегов.', 400);
  let number = Math.max(0, ...context.items.map(i => Number(parse(i.meta).docflowNumber) || 0));
  const occupied = new Set(context.items.map(i => String(i[config.masks.cipherSource]).toUpperCase()).filter(Boolean));
  const rows = [];
  for (const requirement of candidates.values()) {
    if (!requirement.spec) { rows.push(requirement); continue; }
    const tag = context.tags.find(t => t.id === requirement.tagIds[0]);
    const spec = requirement.spec;
    const type = config.vdrTypes.find(t => t.code === spec.docType)!;
    const people = spec.responsibleRole ? users.filter(u => hasPosition(u, spec.responsibleRole) && (!u.validUntil || new Date(u.validUntil).getTime() > Date.now())) : [];
    const milestone = config.deadlines.milestones.find(m => m.code === spec.milestone);
    const dueDate = spec.milestone ? workingDate(milestone?.date || '', spec.workdays) : null;
    let problem = requirement.problem || (spec.milestone && !dueDate ? 'Для вехи срока не задана корректная дата' : '');
    let cipher = requirement.item?.[config.masks.cipherSource] || '';
    let docflowNumber = 0;
    if (requirement.needed && !requirement.item && !problem) {
      for (let attempt = 0; attempt < 10_000; attempt++) {
        docflowNumber = ++number;
        const fields: Record<string, string> = { проект: register.contractorProjectNo || register.ownerProjectNo || '', заказ: register.poNumber, договор: register.contractorProjectNo,
          установка: tag?.group?.name || '', язык: 'RU', ...selection.fields, тип: spec.docType, номер: String(number).padStart(3, '0'), тег: requirement.unit === 'tag' ? tag?.identifier || '' : '' };
        const parts = maskParts(config.masks.cipher);
        const missing = parts.filter(p => 'field' in p && !fields[p.field]).map(p => (p as any).field);
        if (missing.length) { problem = `Заполните поля шифра: ${missing.join(', ')}`; break; }
        cipher = parts.map(p => 'literal' in p ? p.literal : fields[p.field]).join('');
        if (!cipher || cipher.length > 180 || /[\\/:*?"<>|\u0000-\u001f]/.test(cipher)) { problem = 'Шифр пуст, слишком длинный или содержит недопустимые символы'; break; }
        if (!occupied.has(cipher.toUpperCase())) { occupied.add(cipher.toUpperCase()); break; }
        cipher = '';
      }
      if (!cipher && !problem) problem = 'Не удалось выделить свободный шифр. Проверьте маску.';
    }
    const row = { ...(requirement.item || {}), [config.masks.cipherSource]: cipher, vdrCode: spec.docType, revision: requirement.item?.revision || 'A', tags: requirement.tagIds.map((id: string) => context.tags.find(t => t.id === id)?.identifier || ''), projectCode: register.contractorProjectNo || register.ownerProjectNo || '', poNumber: register.poNumber, language: 'RU' };
    const ext = /\.[a-z0-9]+$/i.exec(type.template || '')?.[0] || '.docx';
    const fileName = buildFileName(config, row, ext);
    if (requirement.needed && !requirement.item && !fileName && !problem) problem = 'По маске не удаётся собрать имя файла. Проверьте поля и маску.';
    rows.push({ key: requirement.key, tagIds: requirement.tagIds, tags: row.tags, docType: spec.docType, unit: spec.unit, scopeId: requirement.scopeId, necessity: spec.necessity,
      cipher, contractorNo: row.contractorNo || '', ownerNo: row.ownerNo || '', vendorNo: row.vendorNo || '', titleRu: type.titleRu, titleEn: type.titleEn,
      revision: row.revision, language: row.language, fileName, assigneeId: people.length === 1 ? people[0].id : null,
      assignee: people.length === 1 ? people[0].name : spec.responsibleRole ? `Не назначен: ${spec.responsibleRole} (${people.length} кандидатов)` : 'Не назначен',
      dueDate, docflowNumber, action: !requirement.needed || problem ? 'skip' : requirement.item ? 'keep' : 'create', problem: !requirement.needed ? 'Не нужен в проекте: условие не выполнено или тег снят' : problem,
      itemId: requirement.item?.id || null,
    });
  }
  return { fingerprint: fingerprint(context), rows };
}

export async function listKitDocuments(prisma: any, projectId: string, tagId?: string, stage?: string, actorId?: string) {
  if (stage && !['П', 'Р'].includes(stage)) throw new DocflowPlanError('Неверная стадия', 400);
  const context = await loadKitContext(prisma, projectId);
  if (tagId && !context.tags.some(tag => tag.id === tagId)) throw new DocflowPlanError('Тег не найден в этом проекте', 403);
  const tags = context.tags.filter(tag => !tagId || tag.id === tagId).map(tag => ({ id: tag.id, identifier: tag.identifier, classId: tag.classId, removed: tag.removed,
    items: context.items.filter(item => !item.titleEn?.includes('Vendor Document Register') && itemAppliesToTag(context, item, tag.id)),
    requirements: (context.settings.config.kits.find(k => k.classId === tag.classId)?.items || []).filter(spec => !stage || !spec.stage || spec.stage === stage).map(spec => {
      const r = requirementFor(context, tag, spec); const { spec: _spec, ...rest } = r; return rest;
    }),
  }));
  if (!tagId) for (const link of context.links.filter(link => !context.tags.some(tag => tag.id === link.tagId))) {
    let removed = tags.find(tag => tag.id === link.tagId);
    if (!removed) { removed = { id: link.tagId, identifier: link.tagIdentifier || link.tagId, classId: '', removed: true, items: [], requirements: [] }; tags.push(removed); }
    const item = context.items.find(item => item.id === link.itemId);
    if (item && !removed.items.some(row => row.id === item.id)) removed.items.push(item);
  }
  const unique = [...new Map(tags.flatMap(t => t.requirements).filter(r => r.needed).map(r => [r.key, r])).values()];
  const last = actorId ? await prisma.docflowPlan.findFirst({ where: { projectId, actorId, kind: KIND, state: 'applied', expiresAt: { gt: new Date() } }, orderBy: { updatedAt: 'desc' } }) : null;
  return { tags, totals: { needed: unique.length, existing: unique.filter(r => r.hasFile).length, issued: unique.filter(r => ['ISSUED', 'ACCEPTED'].includes(r.item?.status)).length,
    overdue: unique.filter(r => r.item?.dueDate && new Date(r.item.dueDate).getTime() < Date.now() && !['ISSUED', 'ACCEPTED', 'VOID'].includes(r.item.status)).length },
    registers: context.registers.map(r => ({ id: r.id, name: r.name })), lastPlanId: last?.id || null, lastActorId: last?.actorId || null };
}

export async function planKitRows(prisma: any, projectId: string, actorId: string, raw: any) {
  const selection = selectionOf(raw);
  const data = await preview(prisma, projectId, selection);
  const plan = await saveDocflowPlan(prisma, { projectId, actorId, kind: KIND, payload: { selection, ...data } });
  return { id: plan.id, rows: data.rows, expiresAt: iso(plan.expiresAt) };
}

export async function applyKitRows(prisma: any, projectId: string, actorId: string, id: string) {
  return prisma.$transaction(async (tx: any) => {
    const plan = await loadDocflowPlan(tx, id, { projectId, actorId, kind: KIND });
    if (plan.state === 'applied') return JSON.parse(plan.result);
    if (plan.state !== 'preview') throw new DocflowPlanError('План уже отменён');
    const saved = parsedPlan<any>(plan);
    const current = await preview(tx, projectId, saved.selection);
    if (json(current) !== json({ fingerprint: saved.fingerprint, rows: saved.rows })) throw new DocflowPlanError('Данные проекта изменились. Постройте новый предпросмотр.');
    const changes = [];
    for (const row of saved.rows.filter((r: any) => r.action === 'create')) {
      const item = await tx.docRegisterItem.create({ data: { id: randomUUID(), projectId, registerId: saved.selection.registerId,
        contractorNo: row.contractorNo, ownerNo: row.ownerNo, vendorNo: row.vendorNo, vdrCode: row.docType, titleRu: row.titleRu, titleEn: row.titleEn,
        revision: row.revision, language: row.language, assigneeId: row.assigneeId, dueDate: row.dueDate ? new Date(row.dueDate) : null,
        equipmentTags: json(row.tags), meta: json({ docflowUnit: row.unit, docflowNumber: row.docflowNumber, docflowPlanId: id }),
      } });
      await tx.docflowKitRow.create({ data: { projectId, unit: row.unit, scopeId: row.scopeId, docType: row.docType, itemId: item.id, cipher: row.cipher } });
      await tx.docRegisterItemTag.createMany({ data: row.tagIds.map((tagId: string, index: number) => ({ itemId: item.id, tagId, tagIdentifier: row.tags[index] })) });
      changes.push({ itemId: item.id, updatedAt: iso(item.updatedAt), tagIds: row.tagIds });
    }
    const result = { id, changes, count: changes.length };
    await finishDocflowPlan(tx, plan, 'applied', result);
    return result;
  }, { isolationLevel: 'Serializable', timeout: 30_000 });
}

export async function undoKitRows(prisma: any, projectId: string, actorId: string, id: string) {
  return prisma.$transaction(async (tx: any) => {
    const plan = await loadDocflowPlan(tx, id, { projectId, actorId, kind: KIND });
    if (plan.state === 'undone') return { ok: true };
    if (plan.state !== 'applied') throw new DocflowPlanError('План ещё не применён');
    const result = JSON.parse(plan.result);
    for (const item of result.changes) {
      const links = await tx.docRegisterItemTag.findMany({ where: { itemId: item.itemId } });
      if (json(links.map((l: any) => l.tagId).sort()) !== json([...item.tagIds].sort()) || await tx.docFileLink.count({ where: { itemId: item.itemId } }) || await tx.docRegisterItemRevision.count({ where: { itemId: item.itemId } })) throw new DocflowPlanError('Строку уже использовали или изменили связи. Отмена не затронула новые данные.');
      const removed = await tx.docRegisterItem.deleteMany({ where: { id: item.itemId, projectId, updatedAt: new Date(item.updatedAt), status: 'DRAFT' } });
      if (removed.count !== 1) throw new DocflowPlanError('После создания строку изменили. Отмена не затронула новые данные.');
      await tx.docRegisterItemTag.deleteMany({ where: { itemId: item.itemId } });
      // Явно удаляем резерв и для старых баз, где синхронизация ещё не установила каскад.
      await tx.docflowKitRow.deleteMany({ where: { itemId: item.itemId, projectId } });
    }
    await finishDocflowPlan(tx, plan, 'undone', result);
    return { ok: true };
  }, { isolationLevel: 'Serializable', timeout: 30_000 });
}
