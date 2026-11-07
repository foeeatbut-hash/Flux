import { translatedDocflowPermissions } from '../shared/docflowPermissions.js';

const MARKER = 'migration:docflow.permissions.v1';
function translated(raw: string | null): string | null {
  if (!raw) return raw;
  const map = JSON.parse(raw);
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('Неверный набор прав документооборота');
  const result = translatedDocflowPermissions(map);
  return JSON.stringify(result) === JSON.stringify(map) ? raw : JSON.stringify(result);
}

/** Переносит только имена прав, сохраняя запреты, сроки и личные исключения. */
export async function migrateDocflowPermissions(prisma: any): Promise<void> {
  await prisma.$transaction(async (tx: any) => {
    if (await tx.appSetting.findFirst({ where: { key: MARKER, userId: null } })) return;
    const before: Array<{ model: 'role' | 'user'; id: string; permissions: string | null; after: string | null }> = [];
    for (const model of ['role', 'user'] as const) {
      const rows = await tx[model].findMany({ select: { id: true, permissions: true } });
      for (const row of rows) {
        const after = translated(row.permissions);
        if (after !== row.permissions) before.push({ model, ...row, after });
      }
    }
    // Снимок до записи сохраняется вместе с результатом: потерянных прав
    // при переносе не будет, а администратор может сверить исходный набор.
    for (const change of before) {
      const updated = await tx[change.model].updateMany({
        where: { id: change.id, permissions: change.permissions }, data: { permissions: change.after },
      });
      if (updated.count !== 1) throw new Error('Права изменились во время переноса. Повторите запуск.');
    }
    await tx.appSetting.create({ data: { key: MARKER, value: JSON.stringify({ before, at: new Date().toISOString() }) } });
  });
}
