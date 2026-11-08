import { randomUUID } from 'node:crypto';

export const PREVIEW_LIFETIME = 15 * 60_000;
export const UNDO_LIFETIME = 30 * 24 * 60 * 60_000;
const MAX_PAYLOAD = 1024 * 1024;
const MAX_PLANS = 200;

export class DocflowPlanError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

/** Уборка идёт перед созданием: истёкшие планы не накапливаются с новыми. */
export async function saveDocflowPlan(prisma: any, input: {
  projectId: string; actorId: string; kind: string; payload: unknown;
}) {
  const now = new Date();
  await prisma.docflowPlan.deleteMany({ where: { expiresAt: { lte: now } } });
  const count = await prisma.docflowPlan.count({ where: { projectId: input.projectId, actorId: input.actorId, kind: input.kind } });
  if (count >= MAX_PLANS) throw new DocflowPlanError('Достигнут предел сохранённых операций. Дождитесь окончания срока отмены.', 429);
  const payload = JSON.stringify(input.payload);
  if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD) throw new DocflowPlanError('План слишком большой. Выберите меньше тегов.', 400);
  return prisma.docflowPlan.create({ data: {
    id: randomUUID(), projectId: input.projectId, actorId: input.actorId, kind: input.kind,
    payload, expiresAt: new Date(now.getTime() + PREVIEW_LIFETIME),
  } });
}

/** Идентификатор плана не заменяет проверку автора, проекта и текущих прав маршрута. */
export async function loadDocflowPlan(prisma: any, id: string, scope: { projectId: string; actorId: string; kind: string }) {
  if (typeof id !== 'string' || !id || id.length > 100) throw new DocflowPlanError('Не указан план', 400);
  const row = await prisma.docflowPlan.findUnique({ where: { id } });
  if (!row) throw new DocflowPlanError('План не найден или срок его хранения истёк', 404);
  if (row.projectId !== scope.projectId || row.actorId !== scope.actorId || row.kind !== scope.kind) {
    throw new DocflowPlanError('План недоступен', 403);
  }
  if (new Date(row.expiresAt).getTime() <= Date.now()) throw new DocflowPlanError('Срок плана истёк. Постройте новый предпросмотр.', 410);
  return row;
}

export function parsedPlan<T>(row: { payload: string }): T { return JSON.parse(row.payload) as T; }

/** Состояние и результат записываются в той же транзакции, что и данные проекта. */
export async function finishDocflowPlan(tx: any, row: any, state: 'applied' | 'undone', result: unknown) {
  const expected = state === 'applied' ? 'preview' : 'applied';
  const done = await tx.docflowPlan.updateMany({
    where: { id: row.id, state: expected, updatedAt: row.updatedAt },
    data: { state, result: JSON.stringify(result), expiresAt: new Date(Date.now() + UNDO_LIFETIME) },
  });
  if (done.count !== 1) throw new DocflowPlanError('План уже применён или изменён. Обновите окно.');
}
