/**
 * Связь файла папки проекта со строкой ВДР на сервере (docs/docflow-program.md,
 * разделы 4, 7.3, 10).
 *
 * Клиенту здесь не верят: имя файла проверяется по маске проекта на сервере
 * (тем же `checkName`, что у Проводника и ДО), папка должна быть привязана к
 * проекту строки и иметь подходящее назначение. «Файл уже связан» решает не
 * чтение перед записью, а уникальный `pathKey` — два одновременных запроса
 * не свяжут один файл с разными строками. Отвязка ничего не удаляет: запись
 * остаётся историей (`unlinkedAt`).
 */
import { createHash } from 'node:crypto';
import { checkName, buildFileName, type NameCheck, type RowForCheck } from '../shared/docflow/nameMask.js';
import { isFolderKey, linkLookupKey, purposeAllows, purposeLabel, relativePathProblem, type DocLinkDto, type FolderPurpose, type LinkedItemBrief, type LinkRole } from '../shared/docflow/links.js';
import type { DocflowConfig } from '../shared/docflow/config.js';
import { readSettings } from './docflowSettings.js';
import { codesOfItem } from './vdrTags.js';
import { inTransaction } from './vdrWrite.js';
import { projectBindingsOf } from './routes/projectFolderBindings.js';

export class LinkError extends Error {
  constructor(message: string, readonly status = 400, readonly extra: Record<string, unknown> = {}) { super(message); this.name = 'LinkError'; }
}

const iso = (d: any) => (d ? new Date(d).toISOString() : null);

/** Ключ уникальности: хеш от ключа папки и пути без учёта регистра (как в Windows). */
export const pathKeyOf = (folderKey: string, relativePath: string): string =>
  createHash('sha256').update(linkLookupKey(folderKey, relativePath)).digest('hex');

export function toDto(row: any, mismatch?: string[]): DocLinkDto {
  return {
    id: row.id, itemId: row.itemId, projectId: row.projectId, revision: row.revision, role: row.role === 'remarks' ? 'remarks' : 'file',
    toLinkId: row.toLinkId || null, folderKey: row.folderKey, relativePath: row.relativePath, fileName: row.fileName, sha256: row.sha256 || '',
    size: Number(row.size) || 0, reviewCode: row.reviewCode || '', receivedAt: iso(row.receivedAt), lostAt: iso(row.lostAt),
    linkedById: row.linkedById || null, createdAt: iso(row.createdAt) || '', unlinkedAt: iso(row.unlinkedAt), unlinkReason: row.unlinkReason || '',
    ...(mismatch ? { mismatch } : {}),
  };
}

export interface ItemContext { item: any; register: any; projectId: string; tags: string[] }

export async function itemContext(prisma: any, itemId: string): Promise<ItemContext> {
  const item = await prisma.docRegisterItem.findUnique({ where: { id: itemId } });
  if (!item) throw new LinkError('Строка ВДР не найдена', 404);
  const register = await prisma.docRegister.findUnique({ where: { id: item.registerId } });
  return { item, register, projectId: item.projectId, tags: codesOfItem(item.equipmentTags) };
}

/** Строка ВДР в виде, который понимает проверка имени. */
export function rowForCheck(ctx: ItemContext): RowForCheck {
  const { item, register } = ctx;
  return {
    contractorNo: item.contractorNo, ownerNo: item.ownerNo, vendorNo: item.vendorNo, vdrCode: item.vdrCode, revision: item.revision,
    language: item.language, tags: ctx.tags, poNumber: register?.poNumber || '', projectCode: register?.contractorProjectNo || register?.ownerProjectNo || '',
  };
}

export const briefOf = (item: any, config: DocflowConfig): LinkedItemBrief => ({
  id: item.id, cipher: String(item[config.masks.cipherSource] || item.contractorNo || item.ownerNo || item.vendorNo || ''),
  title: item.titleRu || item.titleEn || '', vdrCode: item.vdrCode || '', revision: item.revision || '', status: item.status || '', registerId: item.registerId,
});

/** Проверка имени без записи: окно «Связать со строкой…» показывает расхождения до нажатия кнопки. */
export async function planLink(prisma: any, input: { itemId: string; fileName: string; revision?: string }): Promise<{ check: NameCheck; expectedName: string; blocked: boolean; reason: string; sameRevisionFile: DocLinkDto | null }> {
  const ctx = await itemContext(prisma, input.itemId);
  const { config } = await readSettings(prisma, ctx.projectId);
  const row = rowForCheck(ctx);
  const check = checkName(config, String(input.fileName || ''), row);
  const ext = /\.[^.\\/]+$/.exec(String(input.fileName || ''))?.[0] || '';
  const revision = check.revision || row.revision || '';
  const existing = await prisma.docFileLink.findFirst({ where: { itemId: ctx.item.id, role: 'file', revision, unlinkedAt: null } });
  return {
    check, expectedName: buildFileName(config, row, ext), blocked: !check.ok,
    reason: check.ok ? '' : check.blocking.map((f) => f.text).join('; ') || 'Имя не по маске проекта',
    sameRevisionFile: existing ? toDto(existing) : null,
  };
}

export interface CreateLinkInput {
  itemId: string; role?: LinkRole; toLinkId?: string; folderKey: string; relativePath: string; fileName: string;
  sha256?: string; size?: number; reviewCode?: string; receivedAt?: string | null;
  /** Заменить действующий файл этой же ревизии (прежняя связь уйдёт в историю). */
  replace?: boolean;
}

async function purposeOf(projectId: string, prisma: any, folderKey: string): Promise<{ found: boolean; purpose: FolderPurpose | undefined; label: string }> {
  const binding = (await projectBindingsOf(prisma, projectId)).find((b) => b.locationKey === folderKey);
  return { found: !!binding, purpose: binding?.purpose, label: binding?.label || '' };
}

async function ownerOfPath(prisma: any, key: string): Promise<string> {
  const other = await prisma.docFileLink.findFirst({ where: { pathKey: key } });
  if (!other) return '';
  const item = await prisma.docRegisterItem.findUnique({ where: { id: other.itemId }, select: { contractorNo: true, ownerNo: true, vendorNo: true, titleRu: true } });
  return item ? (item.contractorNo || item.ownerNo || item.vendorNo || item.titleRu || 'другой строкой') : 'другой строкой';
}

export async function createLink(prisma: any, input: CreateLinkInput, actorId: string): Promise<{ link: DocLinkDto; replaced: DocLinkDto | null; check: NameCheck | null }> {
  const role: LinkRole = input.role === 'remarks' ? 'remarks' : 'file';
  if (!isFolderKey(input.folderKey)) throw new LinkError('Некорректный ключ папки', 400);
  const problem = relativePathProblem(input.relativePath, input.fileName);
  if (problem) throw new LinkError(problem, 400);
  const ctx = await itemContext(prisma, input.itemId);
  const where = await purposeOf(ctx.projectId, prisma, input.folderKey);
  if (!where.found) throw new LinkError('Эта папка не привязана к проекту строки. Привяжите её в Проводнике (правой кнопкой по папке).', 422);
  if (!purposeAllows(role, where.purpose)) {
    throw new LinkError(role === 'remarks'
      ? `Файл замечаний должен лежать в папке «Возвраты», а эта папка — «${purposeLabel(where.purpose)}».`
      : `Файл документа не может лежать в папке «${purposeLabel(where.purpose)}»: нужна рабочая папка или выпуск.`, 422);
  }
  const key = pathKeyOf(input.folderKey, input.relativePath);
  let revision = ctx.item.revision as string;
  let check: NameCheck | null = null;
  let toLink: any = null;
  if (role === 'file') {
    const { config } = await readSettings(prisma, ctx.projectId);
    check = checkName(config, input.fileName, rowForCheck(ctx));
    if (!check.ok) throw new LinkError(`Имя файла не сходится со строкой: ${check.blocking.map((f) => f.text).join('; ') || 'не по маске проекта'}`, 422, { check });
    if (check.revision) revision = check.revision;
  } else {
    toLink = await prisma.docFileLink.findUnique({ where: { id: String(input.toLinkId || '') } });
    if (!toLink || toLink.itemId !== ctx.item.id || toLink.role !== 'file' || toLink.unlinkedAt) throw new LinkError('Замечания привязываются к действующему файлу ревизии этой строки', 422);
    revision = toLink.revision;
  }
  try {
    return await inTransaction(prisma, async (db) => {
      const busy = await db.docFileLink.findFirst({ where: { pathKey: key } });
      if (busy) throw new LinkError(`Файл уже связан с ${await ownerOfPath(db, key)}. Сначала отвяжите его там.`, 409, { itemId: busy.itemId, linkId: busy.id });
      let replaced: any = null;
      if (role === 'file') {
        const same = await db.docFileLink.findFirst({ where: { itemId: ctx.item.id, role: 'file', revision, unlinkedAt: null } });
        if (same && !input.replace) throw new LinkError(`У строки уже есть файл ревизии ${revision}: ${same.fileName}. Назначьте другой, заменив его, или отвяжите прежний.`, 409, { linkId: same.id, replaceable: true });
        if (same) replaced = await db.docFileLink.update({ where: { id: same.id }, data: { unlinkedAt: new Date(), unlinkedById: actorId, unlinkReason: 'заменён другим файлом', pathKey: null } });
      }
      const made = await db.docFileLink.create({
        data: {
          itemId: ctx.item.id, projectId: ctx.projectId, revision, role, toLinkId: toLink?.id || null, folderKey: input.folderKey,
          relativePath: input.relativePath.split(/[\\/]+/).join('/'), fileName: input.fileName, sha256: String(input.sha256 || '').slice(0, 64),
          size: Number(input.size) > 0 ? Number(input.size) : 0, reviewCode: role === 'remarks' ? String(input.reviewCode || '').slice(0, 20) : '',
          receivedAt: role === 'remarks' && input.receivedAt && !Number.isNaN(Date.parse(input.receivedAt)) ? new Date(input.receivedAt) : null,
          pathKey: key, linkedById: actorId,
        },
      });
      return { link: toDto(made), replaced: replaced ? toDto(replaced) : null, check };
    });
  } catch (err: any) {
    // Гонка двух запросов: уникальный индекс отказал второму
    if (err?.code === 'P2002' || /unique/i.test(String(err?.message))) throw new LinkError(`Файл уже связан с ${await ownerOfPath(prisma, key)}. Сначала отвяжите его там.`, 409);
    throw err;
  }
}

/** Отвязка: запись остаётся историей. Замечания, привязанные к отвязанному файлу, отвязываются вместе с ним. */
export async function unlinkLink(prisma: any, input: { itemId: string; linkId: string; reason?: string }, actorId: string): Promise<DocLinkDto[]> {
  return inTransaction(prisma, async (db) => {
    const link = await db.docFileLink.findUnique({ where: { id: input.linkId } });
    if (!link || link.itemId !== input.itemId) throw new LinkError('Связь не найдена', 404);
    if (link.unlinkedAt) throw new LinkError('Файл уже отвязан', 409);
    const data = { unlinkedAt: new Date(), unlinkedById: actorId, unlinkReason: String(input.reason || 'отвязан').slice(0, 200), pathKey: null };
    const out = [await db.docFileLink.update({ where: { id: link.id }, data })];
    if (link.role === 'file') {
      const dependents = await db.docFileLink.findMany({ where: { toLinkId: link.id, unlinkedAt: null } });
      for (const d of dependents) out.push(await db.docFileLink.update({ where: { id: d.id }, data: { ...data, unlinkReason: 'файл ревизии отвязан' } }));
    }
    return out.map((x: any) => toDto(x));
  });
}

export interface TrackInput { linkId: string; itemId: string; folderKey?: string; relativePath?: string; fileName?: string; sha256?: string; size?: number; lost?: boolean }

/**
 * Слежение (раздел 3.5): Проводник сообщает, что файл переименовали или перенесли, изменили или не нашли.
 * Связь держится по ключу папки и отпечатку; новое имя не отвязывает файл, а попадает в `mismatch`
 * — строка покажет «имя не совпадает» с выбором «вернуть имя» / «отвязать».
 */
export async function trackLink(prisma: any, input: TrackInput): Promise<DocLinkDto> {
  return inTransaction(prisma, async (db) => {
    const link = await db.docFileLink.findUnique({ where: { id: input.linkId } });
    if (!link || link.itemId !== input.itemId || link.unlinkedAt) throw new LinkError('Связь не найдена', 404);
    const data: any = {};
    if (input.lost) data.lostAt = link.lostAt || new Date();
    else {
      data.lostAt = null;
      if (typeof input.sha256 === 'string' && /^[0-9a-f]{64}$/u.test(input.sha256)) data.sha256 = input.sha256;
      if (Number(input.size) >= 0 && input.size !== undefined) data.size = Number(input.size);
      if (input.relativePath !== undefined || input.fileName !== undefined || input.folderKey !== undefined) {
        const folderKey = input.folderKey || link.folderKey;
        const relativePath = String(input.relativePath ?? link.relativePath);
        const fileName = String(input.fileName ?? link.fileName);
        if (!isFolderKey(folderKey)) throw new LinkError('Некорректный ключ папки', 400);
        const problem = relativePathProblem(relativePath, fileName);
        if (problem) throw new LinkError(problem, 400);
        const key = pathKeyOf(folderKey, relativePath);
        if (key !== link.pathKey) {
          const busy = await db.docFileLink.findFirst({ where: { pathKey: key } });
          if (busy && busy.id !== link.id) throw new LinkError('На новом месте уже лежит файл, связанный с другой строкой', 409);
          Object.assign(data, { folderKey, relativePath: relativePath.split(/[\\/]+/).join('/'), fileName, pathKey: key });
        }
      }
    }
    const updated = await db.docFileLink.update({ where: { id: link.id }, data });
    return toDto(updated);
  });
}

/** Заменить `mismatch` у связей-файлов: имя сейчас сверяется со строкой тем же `checkName`. */
export async function mismatchOf(config: DocflowConfig, ctx: ItemContext, link: any): Promise<string[] | undefined> {
  if (link.role !== 'file') return undefined;
  const check = checkName(config, link.fileName, rowForCheck(ctx));
  if (check.ok) return undefined;
  return check.blocking.map((f) => f.text).concat(check.parsed.ok ? [] : check.parsed.problems);
}

/** Действующие связи проекта (или строки) с краткими сведениями о строках; `history` добавляет отвязанные. */
export async function listLinks(prisma: any, input: { projectId?: string; itemId?: string; history?: boolean }): Promise<{ links: DocLinkDto[]; items: Record<string, LinkedItemBrief> }> {
  const where: any = {};
  if (input.itemId) where.itemId = input.itemId;
  else if (input.projectId) where.projectId = input.projectId;
  else throw new LinkError('Не указан проект или строка', 400);
  if (!input.history) where.unlinkedAt = null;
  const rows: any[] = await prisma.docFileLink.findMany({ where, orderBy: { createdAt: 'asc' }, take: 20000 });
  const itemIds = [...new Set(rows.map((r) => r.itemId))];
  const items: any[] = itemIds.length ? await prisma.docRegisterItem.findMany({ where: { id: { in: itemIds } } }) : [];
  const projectId = input.projectId || items[0]?.projectId || rows[0]?.projectId;
  const { config } = projectId ? await readSettings(prisma, projectId) : { config: (await readSettings(prisma, '')).config };
  const registers: any[] = await prisma.docRegister.findMany({ where: { id: { in: [...new Set(items.map((i) => i.registerId))] } } });
  const byItem = new Map(items.map((i) => [i.id, i]));
  const byRegister = new Map(registers.map((r) => [r.id, r]));
  const links: DocLinkDto[] = [];
  for (const r of rows) {
    const item = byItem.get(r.itemId);
    const mismatch = item && !r.unlinkedAt ? await mismatchOf(config, { item, register: byRegister.get(item.registerId), projectId: item.projectId, tags: codesOfItem(item.equipmentTags) }, r) : undefined;
    links.push(toDto(r, mismatch));
  }
  return { links, items: Object.fromEntries(items.map((i) => [i.id, briefOf(i, config)])) };
}
