import { createHash } from 'node:crypto';
import { buildFileName, checkName, maskParts, rowFields, placementFolder } from '../shared/docflow/nameMask.js';
import { relativePathProblem } from '../shared/docflow/links.js';
import { itemContext, rowForCheck, toDto, pathKeyOf } from './docflowLinks.js';
import { readSettings, rawSettingsConfig } from './docflowSettings.js';
import { validateDocflowReferences } from './docflowConfigRefs.js';
import { projectBindingsOf } from './routes/projectFolderBindings.js';
import { DocflowPlanError, saveDocflowPlan } from './docflowPlans.js';

export const CREATE_KIND = 'create-files';
export interface CreateSelection { itemIds: string[]; format: string; useTemplates: boolean }
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const claimIds = (row: { itemId: string; revision: string; folderKey: string; relativePath: string }) => [
  `dfc-${digest(['item', row.itemId, row.revision])}`, `dfc-${digest(['path', row.folderKey, row.relativePath.toUpperCase()])}`,
];

function selectionOf(raw: any): CreateSelection {
  if (!Array.isArray(raw?.itemIds) || !raw.itemIds.length || raw.itemIds.length > 100 || raw.itemIds.some((id: any) => typeof id !== 'string' || !id || id.length > 100)) throw new DocflowPlanError('Выберите от 1 до 100 строк', 400);
  const format = raw.format || 'docx';
  if (!['docx', 'xlsx', 'pdf', 'txt'].includes(format)) throw new DocflowPlanError('Выберите формат нового файла', 400);
  if (raw.useTemplates !== undefined && typeof raw.useTemplates !== 'boolean') throw new DocflowPlanError('Неверный выбор шаблонов', 400);
  return { itemIds: [...new Set<string>(raw.itemIds)].sort(), format, useTemplates: raw.useTemplates !== false };
}

/** Имена и папку определяет сервер, физическую доступность проверяет мост компьютера. */
export async function previewCreateFiles(prisma: any, projectId: string, selection: CreateSelection) {
  if (!await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } })) throw new DocflowPlanError('Проект не найден', 404);
  await validateDocflowReferences(prisma, await rawSettingsConfig(prisma, projectId));
  const settings = await readSettings(prisma, projectId);
  const bindings = await projectBindingsOf(prisma, projectId);
  const workBinding = bindings.find(binding => binding.purpose === 'work') || null;
  const rows = [];
  const snapshots = [];
  for (const itemId of selection.itemIds) {
    const ctx = await itemContext(prisma, itemId);
    if (ctx.projectId !== projectId || !ctx.register || ctx.register.projectId !== projectId) throw new DocflowPlanError('Строка или её реестр принадлежат другому проекту', 403);
    const refs = await prisma.docRegisterItemTag.findMany({ where: { itemId }, orderBy: { tagId: 'asc' } });
    if (refs.length) {
      const tags = await prisma.tag.findMany({ where: { id: { in: refs.map((ref: any) => ref.tagId) } }, select: { projectId: true } });
      if (tags.some((tag: any) => tag.projectId !== projectId)) throw new DocflowPlanError('Строка ссылается на тег другого проекта', 403);
    }
    const type = settings.config.vdrTypes.find(type => type.code === ctx.item.vdrCode);
    if (!type) throw new DocflowPlanError('Тип документа отсутствует в настройках проекта', 400);
    const existing = await prisma.docFileLink.findFirst({ where: { itemId, projectId, revision: ctx.item.revision, role: 'file', unlinkedAt: null }, orderBy: { createdAt: 'asc' } });
    snapshots.push({ item: ctx.item, register: ctx.register, refs, existing });
    if (existing) {
      rows.push({ itemId, revision: ctx.item.revision, fileName: existing.fileName, relativePath: existing.relativePath, folderKey: existing.folderKey,
        template: '', format: '', action: 'open' as const, link: toDto(existing), binding: bindings.find(binding => binding.locationKey === existing.folderKey) || null });
      continue;
    }
    if (['ISSUED', 'ACCEPTED', 'VOID'].includes(ctx.item.status)) throw new DocflowPlanError('Для выданной, принятой или аннулированной строки новый файл не создаётся. Проверьте её существующий файл.', 409);
    if (!workBinding) throw new DocflowPlanError('В Проводнике назначьте рабочую папку этого проекта', 422);
    const template = selection.useTemplates ? String(type.template || '').trim() : '';
    const ext = template ? /\.([a-z0-9]{1,10})$/i.exec(template)?.[1]?.toLowerCase() : selection.format;
    if (!ext) throw new DocflowPlanError('В пути шаблона не указан формат файла', 400);
    const row = rowForCheck(ctx);
    const name = buildFileName(settings.config, row, `.${ext}`);
    if (!name || name.length > 255 || !checkName(settings.config, name, row).ok) throw new DocflowPlanError('Из полей строки нельзя собрать имя по маске проекта. Исправьте строку или маску.', 422);
    const values = rowFields(settings.config, row);
    const missing = maskParts(settings.config.folders.work).filter(part => 'field' in part && !values[part.field]);
    if (missing.length) throw new DocflowPlanError('Для структуры рабочей папки не заполнены поля строки', 422);
    const folder = placementFolder(settings.config, 'work', row);
    const relativePath = [folder, name].filter(Boolean).join('/');
    const problem = relativePathProblem(relativePath, name);
    if (problem) throw new DocflowPlanError(problem, 422);
    const busy = await prisma.docFileLink.findFirst({ where: { pathKey: pathKeyOf(workBinding.locationKey, relativePath) } });
    if (busy) throw new DocflowPlanError('Путь по маске уже связан с другой строкой. Исправьте шифр.', 409);
    rows.push({ itemId, revision: ctx.item.revision, fileName: name, relativePath, folderKey: workBinding.locationKey,
      template, format: ext, action: 'create' as const, link: null, binding: workBinding });
  }
  const targets = rows.filter(row => row.action === 'create').map(row => `${row.folderKey}:${row.relativePath.toUpperCase()}`);
  if (new Set(targets).size !== targets.length) throw new DocflowPlanError('Несколько строк дают одно имя. Исправьте шифры или маску перед созданием.', 409);
  return { rows, workBinding, fingerprint: digest({ config: settings.config, snapshots, bindings }) };
}

export async function planCreateFiles(prisma: any, projectId: string, actorId: string, raw: any) {
  const selection = selectionOf(raw);
  const data = await previewCreateFiles(prisma, projectId, selection);
  const plan = await saveDocflowPlan(prisma, { projectId, actorId, kind: CREATE_KIND, payload: { selection, ...data } });
  return { id: plan.id, projectId, ...data, expiresAt: plan.expiresAt.toISOString() };
}
