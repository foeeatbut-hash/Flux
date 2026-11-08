import { createLink, toDto, pathKeyOf } from './docflowLinks.js';
import { CREATE_KIND, claimIds, previewCreateFiles, digest, planCreateFiles } from './docflowCreatePlans.js';
import { DocflowPlanError, loadDocflowPlan, parsedPlan, finishDocflowPlan, PREVIEW_LIFETIME } from './docflowPlans.js';

export { planCreateFiles };
const CLAIM_KIND = 'file-create-claim';
const json = (v: unknown) => JSON.stringify(v);
const scope = (projectId: string, actorId: string) => ({ projectId, actorId, kind: CREATE_KIND });

async function currentPlan(tx: any, plan: any) {
  const saved = parsedPlan<any>(plan);
  const current = await previewCreateFiles(tx, plan.projectId, saved.selection);
  if (digest(current) !== digest({ rows: saved.rows, workBinding: saved.workBinding, fingerprint: saved.fingerprint })) throw new DocflowPlanError('Строки, связи или настройки изменились. Постройте новый план.');
  return saved;
}

function filesOf(raw: any, rows: any[]) {
  const expected = rows.filter(row => row.action === 'create').map(row => row.itemId).sort();
  if (!Array.isArray(raw) || raw.length !== expected.length || raw.some((file: any) => !file || typeof file.itemId !== 'string' || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 50 * 1024 * 1024)) throw new DocflowPlanError('Неверные отпечатки создаваемых файлов', 400);
  if (json(raw.map(file => file.itemId).sort()) !== json(expected)) throw new DocflowPlanError('Список файлов не совпадает с планом', 400);
  if (raw.reduce((total, file) => total + file.size, 0) > 100 * 1024 * 1024) throw new DocflowPlanError('Общий размер пакета превышает 100 МБ. Выберите меньше строк.', 400);
  return raw.map(file => ({ itemId: file.itemId, sha256: file.sha256.toLowerCase(), size: file.size })).sort((a, b) => a.itemId.localeCompare(b.itemId));
}

/** Резерв имеет два SQL-ключа: ревизия строки и путь. Два автора не начинают две копии. */
export async function claimCreateFiles(prisma: any, projectId: string, actorId: string, id: string, rawFiles: unknown) {
  return prisma.$transaction(async (tx: any) => {
    const plan = await loadDocflowPlan(tx, id, scope(projectId, actorId));
    if (plan.state === 'applied') return { id, applied: true, result: JSON.parse(plan.result) };
    if (plan.state !== 'preview') throw new DocflowPlanError('План уже отменён');
    const saved = await currentPlan(tx, plan);
    const files = filesOf(rawFiles, saved.rows);
    if (saved.claimedFiles && json(saved.claimedFiles) !== json(files)) throw new DocflowPlanError('Содержимое изменилось после начала создания. Сначала отмените прежний план.');
    const expiresAt = new Date(Date.now() + PREVIEW_LIFETIME);
    for (const row of saved.rows.filter((row: any) => row.action === 'create')) {
      const file = files.find(file => file.itemId === row.itemId)!;
      for (const key of claimIds(row)) {
        const previous = await tx.docflowPlan.findUnique({ where: { id: key } });
        if (previous && new Date(previous.expiresAt).getTime() > Date.now()) {
          if (previous.projectId !== projectId || previous.actorId !== actorId || previous.kind !== CLAIM_KIND || JSON.parse(previous.payload).planId !== id) throw new DocflowPlanError('Эту ревизию или путь уже создаёт коллега. Обновите реестр после завершения.');
          await tx.docflowPlan.update({ where: { id: key }, data: { expiresAt } });
        } else {
          if (previous) await tx.docflowPlan.deleteMany({ where: { id: key, expiresAt: { lte: new Date() } } });
          await tx.docflowPlan.create({ data: { id: key, projectId, actorId, kind: CLAIM_KIND, state: 'reserved', payload: json({ planId: id, ...file }), expiresAt } });
        }
      }
    }
    const payload = json({ ...saved, claimedFiles: files });
    if (Buffer.byteLength(payload) > 1024 * 1024) throw new DocflowPlanError('План слишком большой', 400);
    const changed = await tx.docflowPlan.updateMany({ where: { id, state: 'preview', updatedAt: plan.updatedAt }, data: { payload, expiresAt } });
    if (changed.count !== 1) throw new DocflowPlanError('План уже изменён. Повторите запрос.');
    return { id, claimed: true, rows: saved.rows, workBinding: saved.workBinding };
  }, { isolationLevel: 'Serializable', timeout: 30_000 });
}

async function releaseClaims(tx: any, plan: any, rows: any[]) {
  for (const key of rows.filter(row => row.action === 'create').flatMap(claimIds)) {
    const claim = await tx.docflowPlan.findUnique({ where: { id: key } });
    if (claim?.kind === CLAIM_KIND && claim.projectId === plan.projectId && claim.actorId === plan.actorId && JSON.parse(claim.payload).planId === plan.id) {
      await tx.docflowPlan.deleteMany({ where: { id: key, payload: claim.payload, updatedAt: claim.updatedAt } });
    }
  }
}

/** Физические файлы уже созданы мостом; вся пачка связей фиксируется одной транзакцией. */
export async function completeCreateFiles(prisma: any, projectId: string, actorId: string, id: string) {
  return prisma.$transaction(async (tx: any) => {
    const plan = await loadDocflowPlan(tx, id, scope(projectId, actorId));
    if (plan.state === 'applied') return JSON.parse(plan.result);
    if (plan.state !== 'preview') throw new DocflowPlanError('План уже отменён');
    const saved = await currentPlan(tx, plan);
    if (!saved.claimedFiles) throw new DocflowPlanError('Сначала подтвердите создание файлов');
    const links = []; const changes = [];
    for (const row of saved.rows) {
      if (row.action === 'open') { links.push(row.link); continue; }
      const file = saved.claimedFiles.find((file: any) => file.itemId === row.itemId);
      for (const key of claimIds(row)) {
        const claim = await loadDocflowPlan(tx, key, { projectId, actorId, kind: CLAIM_KIND });
        const contents = JSON.parse(claim.payload);
        if (contents.planId !== id || contents.sha256 !== file.sha256 || contents.size !== file.size) throw new DocflowPlanError('Резерв файла изменён. Создание не подтверждено.');
      }
      const item = await tx.docRegisterItem.findUnique({ where: { id: row.itemId } });
      const updatedAt = new Date(Math.max(Date.now(), new Date(item.updatedAt).getTime() + 1));
      const claimed = await tx.docRegisterItem.updateMany({ where: { id: item.id, projectId, updatedAt: item.updatedAt, revision: row.revision }, data: { updatedAt } });
      if (claimed.count !== 1) throw new DocflowPlanError('Строку изменили во время создания. Обновите план.');
      const created = await createLink(tx, { itemId: row.itemId, folderKey: row.folderKey, relativePath: row.relativePath, fileName: row.fileName, sha256: file.sha256, size: file.size }, actorId);
      const revisions = await tx.docRegisterItemRevision.count({ where: { itemId: row.itemId } });
      links.push(created.link);
      changes.push({ itemId: row.itemId, itemUpdatedAt: updatedAt.toISOString(), revisions, link: created.link });
    }
    const result = { id, links, changes, count: changes.length };
    await releaseClaims(tx, plan, saved.rows);
    await finishDocflowPlan(tx, plan, 'applied', result);
    return result;
  }, { isolationLevel: 'Serializable', timeout: 30_000 });
}

/** Новые правки и выпуск запрещают отмену; lostAt от собственного удаления допустим. */
async function undoContext(tx: any, projectId: string, actorId: string, id: string) {
  const plan = await loadDocflowPlan(tx, id, scope(projectId, actorId));
  if (plan.state === 'undone') return { plan, changes: [] };
  if (plan.state !== 'applied') throw new DocflowPlanError('План ещё не завершён');
  const result = JSON.parse(plan.result);
  const changes = [];
  for (const change of result.changes) {
    const item = await tx.docRegisterItem.findUnique({ where: { id: change.itemId } });
    const link = await tx.docFileLink.findUnique({ where: { id: change.link.id } });
    if (!item || item.projectId !== projectId || item.revision !== change.link.revision || new Date(item.updatedAt).toISOString() !== change.itemUpdatedAt || ['ISSUED', 'ACCEPTED', 'VOID'].includes(item.status)
      || await tx.docRegisterItemRevision.count({ where: { itemId: item.id } }) !== change.revisions
      || !link || link.projectId !== projectId || link.itemId !== item.id || link.unlinkedAt
      || ['revision', 'folderKey', 'relativePath', 'sha256', 'size'].some(field => link[field] !== change.link[field])) throw new DocflowPlanError('После создания документ изменили или использовали. Отмена сохраняет новые данные.');
    changes.push({ ...change, current: link });
  }
  return { plan, changes };
}

export async function undoCreatePlan(prisma: any, projectId: string, actorId: string, id: string) {
  const { changes } = await undoContext(prisma, projectId, actorId, id);
  return { id, files: changes.map(change => toDto(change.current)) };
}
export async function undoCreatedFiles(prisma: any, projectId: string, actorId: string, id: string) {
  return prisma.$transaction(async (tx: any) => {
    const { plan, changes } = await undoContext(tx, projectId, actorId, id);
    if (plan.state === 'undone') return { ok: true };
    for (const change of changes) {
      const done = await tx.docFileLink.updateMany({ where: { id: change.current.id, updatedAt: change.current.updatedAt, unlinkedAt: null }, data: { pathKey: null, unlinkedAt: new Date(), unlinkedById: actorId, unlinkReason: 'отмена создания файла' } });
      if (done.count !== 1) throw new DocflowPlanError('Связь файла уже изменена. Повторите проверку отмены.');
    }
    await finishDocflowPlan(tx, plan, 'undone', JSON.parse(plan.result));
    return { ok: true };
  }, { isolationLevel: 'Serializable', timeout: 30_000 });
}

export async function cancelCreateFiles(prisma: any, projectId: string, actorId: string, id: string, prepareOnly = false) {
  return prisma.$transaction(async (tx: any) => {
    const plan = await loadDocflowPlan(tx, id, scope(projectId, actorId));
    if (plan.state === 'undone') return { ok: true };
    if (plan.state !== 'preview') throw new DocflowPlanError('Файлы уже связаны: используйте отмену создания');
    const rows = parsedPlan<any>(plan).rows;
    for (const row of rows.filter((row: any) => row.action === 'create')) {
      const occupied = await tx.docFileLink.findFirst({ where: { pathKey: pathKeyOf(row.folderKey, row.relativePath) } });
      if (occupied) throw new DocflowPlanError('Один из созданных файлов уже назначен документу. Подготовку нельзя отменить удалением файлов.');
    }
    if (prepareOnly) return { ok: true };
    await releaseClaims(tx, plan, rows);
    const done = await tx.docflowPlan.updateMany({ where: { id, state: 'preview', updatedAt: plan.updatedAt }, data: { state: 'undone' } });
    if (done.count !== 1) throw new DocflowPlanError('План уже изменён');
    return { ok: true };
  }, { isolationLevel: 'Serializable', timeout: 30_000 });
}
export async function stateCreateFiles(prisma: any, projectId: string, actorId: string, id: string) {
  const plan = await loadDocflowPlan(prisma, id, scope(projectId, actorId));
  const saved = parsedPlan<any>(plan);
  return { id, projectId, expiresAt: new Date(plan.expiresAt).toISOString(), state: plan.state, rows: saved.rows, workBinding: saved.workBinding, result: plan.result ? JSON.parse(plan.result) : null };
}

/** Отмена остаётся доступной после закрытия окна, но только автору исходной операции. */
export async function lastCreateFiles(prisma: any, projectId: string, actorId: string, itemId?: string) {
  if (itemId) {
    const item = await prisma.docRegisterItem.findUnique({ where: { id: itemId }, select: { projectId: true } });
    if (!item || item.projectId !== projectId) throw new DocflowPlanError('Строка не найдена в этом проекте', 403);
  }
  const plans = await prisma.docflowPlan.findMany({ where: { projectId, actorId, kind: CREATE_KIND, state: 'applied', expiresAt: { gt: new Date() } }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: 200 });
  const last = plans.find((plan: any) => {
    const changes = JSON.parse(plan.result).changes || [];
    return changes.length && (!itemId || changes.some((change: any) => change.itemId === itemId));
  });
  return last ? stateCreateFiles(prisma, projectId, actorId, last.id) : null;
}
