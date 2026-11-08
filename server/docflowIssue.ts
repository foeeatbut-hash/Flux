/**
 * Выпуск ревизий документов (docs/docflow-program.md, 7.1).
 *
 * Тело файла на сервер не попадает: отпечаток считает главный процесс
 * Electron на компьютере человека, окно показывает его в предпросмотре, а
 * сервер сравнивает присланный при подтверждении отпечаток с тем, что был в
 * плане, и записывает его в ревизию. Всё остальное сервер проверяет сам и
 * дважды: при построении плана и внутри транзакции записи — клиенту здесь
 * не верят ни в чём, кроме самого отпечатка и сведения «файл открыт».
 *
 * Повтор не плодит ревизий двумя ключами: план применяется один раз
 * (повторное подтверждение возвращает прежний итог), а «строка + ревизия»
 * уникальны в таблице. Второй одновременный выпуск того же документа получает
 * 409, и вся его пачка откатывается.
 */
import { createHash } from 'node:crypto';
import { checkName } from '../shared/docflow/nameMask.js';
import { purposeAllows } from '../shared/docflow/links.js';
import { revisionProblem, validDay, dayToInstant, type RevisionKind } from '../shared/docflow/revisions.js';
import { itemContext, rowForCheck } from './docflowLinks.js';
import { readSettings, rawSettingsConfig } from './docflowSettings.js';
import { validateDocflowReferences } from './docflowConfigRefs.js';
import { projectBindingsOf } from './routes/projectFolderBindings.js';
import { DocflowPlanError, saveDocflowPlan, loadDocflowPlan, parsedPlan, finishDocflowPlan } from './docflowPlans.js';

export const ISSUE_KIND = 'issue-revision';
export const ISSUED_STATUS = 'ISSUED';
const MAX_ROWS = 100;
const SHA = /^[0-9a-f]{64}$/;

export interface IssueRowInput { itemId: string; linkId: string; reason: string; date: string; sha256: string; busy: boolean }
export interface IssueRow extends IssueRowInput {
  revision: string; cipher: string; title: string; fileName: string; status: string; itemUpdatedAt: string;
  /** Отпечаток, под которым файл был связан или замечен слежением в последний раз. */
  linkedSha256: string;
  /** Что мешает выпуску; пусто — строка проходит все проверки. */
  problems: string[];
  /** Что стоит знать, но выпуску не мешает. */
  notes: string[];
}

export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Ключ «строка + ревизия»: уникален у действующих выпусков. */
export const issuedKeyOf = (itemId: string, revision: string) => `dfi-${digest(['issue', itemId, revision.toUpperCase()])}`;
const todayPlusOne = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

function inputsOf(raw: any): IssueRowInput[] {
  const list = raw?.rows;
  if (!Array.isArray(list) || !list.length || list.length > MAX_ROWS) throw new DocflowPlanError(`Выберите от 1 до ${MAX_ROWS} документов`, 400);
  const ids = new Set<string>();
  return list.map((row: any) => {
    const text = (value: unknown, max: number) => (typeof value === 'string' && value.length <= max ? value : '');
    const itemId = text(row?.itemId, 100); const linkId = text(row?.linkId, 100);
    if (!itemId || !linkId) throw new DocflowPlanError('У документа не указаны строка или файл ревизии', 400);
    if (ids.has(itemId)) throw new DocflowPlanError('Одна строка выбрана дважды', 400);
    ids.add(itemId);
    return { itemId, linkId, reason: text(row?.reason, 40), date: text(row?.date, 10), sha256: text(row?.sha256, 64).toLowerCase(), busy: row?.busy === true };
  }).sort((a, b) => a.itemId.localeCompare(b.itemId));
}

/** Все проверки выпуска по текущему состоянию базы; не пишет. Принадлежность проекту нарушена — исключение, остальное — в `problems`. */
export async function evaluateIssue(db: any, projectId: string, inputs: IssueRowInput[]) {
  if (!await db.project.findUnique({ where: { id: projectId }, select: { id: true } })) throw new DocflowPlanError('Проект не найден', 404);
  await validateDocflowReferences(db, await rawSettingsConfig(db, projectId));
  const { config } = await readSettings(db, projectId);
  const bindings = await projectBindingsOf(db, projectId);
  const issuedStatus = config.statuses.find((s) => s.code === ISSUED_STATUS);
  const rows: IssueRow[] = [];
  for (const input of inputs) {
    const ctx = await itemContext(db, input.itemId);
    if (ctx.projectId !== projectId || !ctx.register || ctx.register.projectId !== projectId) throw new DocflowPlanError('Строка или её реестр принадлежат другому проекту', 403);
    const link = await db.docFileLink.findUnique({ where: { id: input.linkId } });
    if (!link || link.projectId !== projectId || link.itemId !== ctx.item.id) throw new DocflowPlanError('Файл не принадлежит этой строке этого проекта', 403);
    const { item } = ctx;
    const problems: string[] = []; const notes: string[] = [];
    if (!issuedStatus) problems.push('В настройках проекта нет статуса «Выдан» (код ISSUED)');
    if (link.role !== 'file') problems.push('Выпускается файл документа, а не файл возврата');
    if (link.unlinkedAt) problems.push('Связь с файлом снята');
    else if (link.revision !== item.revision) problems.push(`Связанный файл относится к ревизии ${link.revision || '—'}, а у строки ${item.revision}`);
    if (link.lostAt) problems.push('Файл ревизии не найден на месте: удалён или перемещён');
    const place = bindings.find((b) => b.locationKey === link.folderKey);
    if (!place) problems.push('Папка файла больше не привязана к проекту');
    else if (!purposeAllows('file', place.purpose)) problems.push('Файл лежит в папке, где документы не выпускаются');
    const check = checkName(config, link.fileName, rowForCheck(ctx));
    if (!check.ok) problems.push(`Имя файла не по маске или не совпадает со строкой: ${check.blocking.map((f) => f.text).join('; ') || 'не по маске проекта'}`);
    else if (check.revision && check.revision.toUpperCase() !== String(item.revision).toUpperCase()) problems.push(`В имени файла ревизия ${check.revision}, а у строки ${item.revision}`);
    const status = config.statuses.find((s) => s.code === item.status);
    if (!status?.issue) problems.push(`Статус «${status?.label || item.status}» не разрешает выпуск`);
    const reason = config.reasons.find((r) => r.code === input.reason);
    if (!reason) problems.push('Укажите причину выпуска из настроек проекта');
    const last = await db.docRegisterItemRevision.findFirst({ where: { itemId: item.id, issuedKey: { not: null } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    if (last && String(last.revision).toUpperCase() === String(item.revision).toUpperCase()) problems.push(`Ревизия ${item.revision} уже выпущена`);
    else if (reason) {
      const why = revisionProblem(config.revisionRules, last ? String(last.revision) : null, String(item.revision), reason.revKind as RevisionKind);
      if (why) problems.push(why);
    }
    if (!validDay(input.date)) problems.push('Укажите дату выпуска');
    else if (input.date > todayPlusOne()) problems.push('Дата выпуска позже сегодняшней');
    if (!SHA.test(input.sha256)) problems.push('Отпечаток файла не получен: выпуск возможен только из программы на компьютере');
    if (input.busy) problems.push('Файл сейчас открыт на запись в редакторе Flux. Закройте его и повторите проверку');
    if (SHA.test(input.sha256) && link.sha256 && link.sha256 !== input.sha256) notes.push('Файл изменён с тех пор, как был связан со строкой: выпускается его текущее содержимое');
    rows.push({
      ...input, revision: item.revision, cipher: String(item[config.masks.cipherSource] || item.contractorNo || item.ownerNo || item.vendorNo || ''),
      title: item.titleRu || item.titleEn || '', fileName: link.fileName, status: item.status, itemUpdatedAt: new Date(item.updatedAt).toISOString(),
      linkedSha256: link.sha256 || '', problems, notes,
    });
  }
  const links = await db.docFileLink.findMany({ where: { id: { in: inputs.map((i) => i.linkId) } }, orderBy: { id: 'asc' } });
  // Что должно совпасть между предпросмотром и записью: строки, связи и правила
  const stable = {
    rows: rows.map((r) => ({ itemId: r.itemId, linkId: r.linkId, revision: r.revision, reason: r.reason, date: r.date, sha256: r.sha256, status: r.status, at: r.itemUpdatedAt, problems: r.problems })),
    links: links.map((l: any) => ({ id: l.id, path: l.pathKey, name: l.fileName, sha: l.sha256, lost: l.lostAt ? 1 : 0, off: l.unlinkedAt ? 1 : 0 })),
    rules: { statuses: config.statuses, reasons: config.reasons, rules: config.revisionRules, masks: config.masks, bindings: bindings.map((b) => [b.locationKey, b.purpose]) },
  };
  return { rows, digest: digest(stable) };
}

export async function planIssue(prisma: any, projectId: string, actorId: string, raw: any) {
  const inputs = inputsOf(raw);
  const evaluated = await evaluateIssue(prisma, projectId, inputs);
  const plan = await saveDocflowPlan(prisma, { projectId, actorId, kind: ISSUE_KIND, payload: { inputs, rows: evaluated.rows, digest: evaluated.digest } });
  return { id: plan.id, projectId, rows: evaluated.rows, ok: evaluated.rows.every((r) => !r.problems.length), expiresAt: plan.expiresAt.toISOString() };
}

const scope = (projectId: string, actorId: string) => ({ projectId, actorId, kind: ISSUE_KIND });
const hashesOf = (raw: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object') for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_ROWS)) if (typeof value === 'string') out[key] = value.toLowerCase();
  return out;
};

/**
 * Запись пачки одной транзакцией. Повторное подтверждение уже применённого
 * плана отдаёт прежний итог, а не пишет заново.
 */
export async function applyIssue(prisma: any, projectId: string, actorId: string, planId: string, rawHashes: unknown) {
  const hashes = hashesOf(rawHashes);
  return prisma.$transaction(async (tx: any) => {
    const plan = await loadDocflowPlan(tx, planId, scope(projectId, actorId));
    if (plan.state === 'applied') return { ...JSON.parse(plan.result), repeated: true };
    if (plan.state !== 'preview') throw new DocflowPlanError('План выпуска отменён. Постройте новый.');
    const saved = parsedPlan<{ inputs: IssueRowInput[]; rows: IssueRow[]; digest: string }>(plan);
    for (const input of saved.inputs) {
      if (hashes[input.itemId] !== input.sha256) throw new DocflowPlanError('Файл изменился после предпросмотра: отпечаток не совпал. Проверьте выпуск заново.');
    }
    const current = await evaluateIssue(tx, projectId, saved.inputs);
    if (current.digest !== saved.digest) throw new DocflowPlanError('Строки, файлы или настройки изменились после предпросмотра. Проверьте выпуск заново.');
    const bad = current.rows.find((r) => r.problems.length);
    if (bad) throw new DocflowPlanError(`Выпуск не пройдёт проверки: ${bad.cipher || bad.title}: ${bad.problems[0]}`, 422);
    const issues = [];
    for (const row of current.rows) {
      const item = await tx.docRegisterItem.findUnique({ where: { id: row.itemId } });
      const claimed = await tx.docRegisterItem.updateMany({
        where: { id: item.id, projectId, updatedAt: item.updatedAt, revision: row.revision, status: row.status },
        data: { status: ISSUED_STATUS, issueDate: dayToInstant(row.date), reasonForIssue: row.reason, reviewCode: '', dueDate: null },
      });
      if (claimed.count !== 1) throw new DocflowPlanError('Строку изменили во время выпуска. Проверьте выпуск заново.');
      const after = await tx.docRegisterItem.findUnique({ where: { id: item.id } });
      const record = await tx.docRegisterItemRevision.create({
        data: {
          itemId: item.id, revision: row.revision, date: dayToInstant(row.date), reason: row.reason, place: '', description: 'Выпуск из документооборота',
          authorId: actorId, linkId: row.linkId, sha256: row.sha256, issuedKey: issuedKeyOf(item.id, row.revision), planId,
        },
      });
      // Отпечаток связи обновляется до выпускаемого содержимого; отпечаток выпуска остаётся в ревизии неизменным
      await tx.docFileLink.updateMany({ where: { id: row.linkId, unlinkedAt: null }, data: { sha256: row.sha256 } });
      issues.push({
        itemId: item.id, revision: row.revision, recordId: record.id, linkId: row.linkId, sha256: row.sha256, reason: row.reason, date: row.date,
        itemUpdatedAt: new Date(after.updatedAt).toISOString(),
        before: { status: item.status, issueDate: item.issueDate ? new Date(item.issueDate).toISOString() : null, reasonForIssue: item.reasonForIssue, reviewCode: item.reviewCode, dueDate: item.dueDate ? new Date(item.dueDate).toISOString() : null },
      });
    }
    const result = { id: planId, count: issues.length, issues };
    await finishDocflowPlan(tx, plan, 'applied', result);
    return result;
  }, { isolationLevel: 'Serializable', timeout: 30_000 });
}

/** Отмена выпуска пачки: пока по документам не пришли возвраты и строки никто не менял. */
export async function undoIssue(prisma: any, projectId: string, actorId: string, planId: string) {
  return prisma.$transaction(async (tx: any) => {
    const plan = await loadDocflowPlan(tx, planId, scope(projectId, actorId));
    if (plan.state === 'undone') return { ok: true };
    if (plan.state !== 'applied') throw new DocflowPlanError('Выпуск ещё не выполнен');
    const result = JSON.parse(plan.result);
    for (const issue of result.issues) {
      const item = await tx.docRegisterItem.findUnique({ where: { id: issue.itemId } });
      const record = await tx.docRegisterItemRevision.findUnique({ where: { id: issue.recordId } });
      if (!item || item.projectId !== projectId || !record || record.undoneAt || record.issuedKey !== issuedKeyOf(item.id, issue.revision)) throw new DocflowPlanError('Выпуск уже изменён. Отмена сохраняет новые данные.');
      if (new Date(item.updatedAt).toISOString() !== issue.itemUpdatedAt || item.revision !== issue.revision) throw new DocflowPlanError('После выпуска строку изменили. Отмена сохраняет новые данные.');
      if (await tx.docFileLink.count({ where: { toLinkId: issue.linkId, unlinkedAt: null } })) throw new DocflowPlanError('По выпуску уже назначен возврат. Отмена невозможна.');
    }
    for (const issue of result.issues) {
      const before = issue.before;
      const restored = await tx.docRegisterItem.updateMany({
        where: { id: issue.itemId, projectId, revision: issue.revision, updatedAt: new Date(issue.itemUpdatedAt) },
        data: { status: before.status, issueDate: before.issueDate ? new Date(before.issueDate) : null, reasonForIssue: before.reasonForIssue, reviewCode: before.reviewCode, dueDate: before.dueDate ? new Date(before.dueDate) : null },
      });
      if (restored.count !== 1) throw new DocflowPlanError('Строку изменили во время отмены. Повторите проверку.');
      // История остаётся, но выпуск перестаёт быть действующим и освобождает ключ «строка + ревизия»
      await tx.docRegisterItemRevision.updateMany({ where: { id: issue.recordId, undoneAt: null }, data: { undoneAt: new Date(), issuedKey: null } });
    }
    await finishDocflowPlan(tx, plan, 'undone', result);
    return { ok: true };
  }, { isolationLevel: 'Serializable', timeout: 30_000 });
}

export async function stateIssue(prisma: any, projectId: string, actorId: string, planId: string) {
  const plan = await loadDocflowPlan(prisma, planId, scope(projectId, actorId));
  const saved = parsedPlan<{ rows: IssueRow[] }>(plan);
  return { id: planId, projectId, state: plan.state, rows: saved.rows, expiresAt: new Date(plan.expiresAt).toISOString(), result: plan.result ? JSON.parse(plan.result) : null };
}

/** Последний собственный выпуск, который ещё можно отменить, — виден и после закрытия окна. */
export async function lastIssue(prisma: any, projectId: string, actorId: string) {
  const plans = await prisma.docflowPlan.findMany({ where: { projectId, actorId, kind: ISSUE_KIND, state: 'applied', expiresAt: { gt: new Date() } }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: 1 });
  return plans[0] ? stateIssue(prisma, projectId, actorId, plans[0].id) : null;
}

const LEGACY_ISSUED_STATUSES = ['ISSUED', 'ACCEPTED', 'REMARKS'];

/**
 * Выпуски, сделанные прежним способом (до окна «Выпустить…»): у них в истории ревизий нет ключа выпуска.
 * Строка в статусе «Выдан / Принят / Замечания» с записью истории на её текущую ревизию считается выпущенной:
 * записи ставится ключ «строка + ревизия» и файл ревизии (если он связан). Без этого «следующая ревизия»
 * для старых данных не открывалась, а выпустить заново было нельзя. Повторный запуск ничего не меняет;
 * проходит страницами, чтобы не читать весь реестр сразу.
 */
export async function backfillLegacyIssues(db: any, onlyItemId?: string): Promise<number> {
  let fixed = 0; let cursor = '';
  for (;;) {
    const items: any[] = await db.docRegisterItem.findMany({
      where: { status: { in: LEGACY_ISSUED_STATUSES }, ...(onlyItemId ? { id: onlyItemId } : cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: 'asc' }, take: 500, select: { id: true, revision: true },
    });
    if (!items.length) return fixed;
    cursor = items[items.length - 1].id;
    const ids = items.map((i) => i.id);
    const rows: any[] = await db.docRegisterItemRevision.findMany({ where: { itemId: { in: ids }, issuedKey: null, undoneAt: null, linkId: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    const keyed: any[] = await db.docRegisterItemRevision.findMany({ where: { itemId: { in: ids }, issuedKey: { not: null } }, select: { itemId: true, revision: true } });
    for (const item of items) {
      const revision = String(item.revision).toUpperCase();
      if (keyed.some((k) => k.itemId === item.id && String(k.revision).toUpperCase() === revision)) continue;
      const row = rows.find((r) => r.itemId === item.id && String(r.revision).toUpperCase() === revision);
      if (!row) continue;
      const link = await db.docFileLink.findFirst({ where: { itemId: item.id, role: 'file', revision: item.revision, unlinkedAt: null } });
      try { await db.docRegisterItemRevision.update({ where: { id: row.id }, data: { issuedKey: issuedKeyOf(item.id, item.revision), linkId: link?.id || null, sha256: link?.sha256 || '' } }); fixed++; }
      catch (e: any) { if (e?.code !== 'P2002') throw e; /* другой запуск успел раньше */ }
    }
    if (onlyItemId) return fixed;
  }
}
