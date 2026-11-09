/**
 * Как ошибка обработчика становится ответом клиенту.
 *
 * Вынесено из server.ts, чтобы проверять без поднятого сервера
 * (scripts/test-review-auth.ts). Раньше любой сбой отвечал 500: битый JSON
 * клиента (400) и слишком большое тело (413) выглядели как поломка сервера, а
 * любая ошибка внешнего ключа — как «сессия устарела, войдите заново».
 */
export function describeApiError(err: any, opts: { databaseReady: boolean }): { status: number; message: string } {
  const rawMsg = String(err?.message || err || 'Internal server error');
  // Берем суть ошибки Prisma — последняя строка вместо простыни с код-фреймом
  const lines = rawMsg.split('\n').map(l => l.trim()).filter(Boolean);
  let message = lines[lines.length - 1] || rawMsg;
  // Ошибки разбора запроса (битый JSON, слишком большое тело) — вина клиента, а не сервера
  const clientStatus = Number(err?.status ?? err?.statusCode);
  let status = Number.isInteger(clientStatus) && clientStatus >= 400 && clientStatus < 500 && err?.expose !== false ? clientStatus : 500;
  if (status === 400 && err?.type === 'entity.parse.failed') message = 'Запрос содержит некорректный JSON.';
  else if (status === 413) message = 'Слишком большой запрос';
  if (rawMsg.includes('malformed') || rawMsg.includes('disk image')) {
    message = 'База данных повреждена (database disk image is malformed). Flux сохранил исходную базу и журналы SQLite.';
  } else if (err?.code === 'P2003' && /^(userId|authorId|ownerId|createdBy|actorId)\b/i.test(String(err?.meta?.field_name || err?.meta?.constraint || ''))) {
    // Ссылка на несуществующего пользователя — сессия устарела. Любой другой
    // внешний ключ (удаление записи с дочерними, неверный родитель) — не она
    message = 'Сессия устарела: текущий пользователь отсутствует в базе данных. Выйдите из профиля и войдите заново.';
  } else if (err?.code === 'P2003') {
    status = 409;
    message = 'Запись связана с другими данными. Сначала уберите или перенесите связанные записи.';
  } else if (!opts.databaseReady) {
    message = 'База данных не инициализирована: клиент Prisma не был создан при старте. Подробности в backend-init.log.';
  }
  return { status, message };
}
