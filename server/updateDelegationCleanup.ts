/**
 * Снятие выданных администраторам разрешений на обновления.
 *
 * Решение владельца (9 ноября 2026): обновлениями управляет только владелец, из Studio — Владелец.
 * Разрешение администратору (`update.delegation:<профиль>`) было единственным «правом на обновления»:
 * на нём держалась подпись его компьютера под назначением. Строки разрешений удаляются; права
 * администратора на всё остальное (`permissions` профилей и должностей) не затрагиваются.
 *
 * Идущие кампании не страдают: каждая команда назначения хранит своё разрешение внутри подписанного
 * конверта (`update.command:*`), а цепочка устройства читается по `update.head:*` — их миграция не трогает.
 * Работает через приложение, а не через SQL диалекта, поэтому одинакова для SQLite, PostgreSQL и MariaDB.
 */
const MARKER = 'migration:update.delegation.retired.v1';
const KEY = 'update.delegation';

export async function retireUpdateDelegations(prisma: any): Promise<number> {
  return prisma.$transaction(async (tx: any) => {
    if (await tx.appSetting.findFirst({ where: { key: MARKER, userId: null } })) return 0;
    const rows: Array<{ id: string }> = await tx.appSetting.findMany({ where: { key: KEY, userId: null }, select: { id: true } });
    for (let i = 0; i < rows.length; i += 200) {
      await tx.appSetting.deleteMany({ where: { id: { in: rows.slice(i, i + 200).map(r => r.id) } } });
    }
    // Список снятых профилей остаётся в отметке: что было выдано, видно и после переноса
    await tx.appSetting.create({ data: { key: MARKER, value: JSON.stringify({ at: new Date().toISOString(), profiles: rows.map(r => r.id.slice(KEY.length + 1)) }) } });
    return rows.length;
  });
}
