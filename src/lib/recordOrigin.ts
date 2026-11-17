/**
 * «Кто создал запись и когда»: разбор ответа `GET /api/record-origin` и текст строки.
 *
 * Без React: наборы гоняют разбор на голых объектах и подставном `fetch`.
 * Сбой запроса (сети нет, запись скрыта, модель не из перечня) — не ошибка для
 * человека: строка «Создал» просто не появляется, карточка остаётся как была.
 */

export interface RecordOriginInfo { createdBy: { userId?: string; name: string } | null; createdAt: string | null }

/** Ответ сервера → то, что нужно строке; нет ни автора, ни даты — `null` (рисовать нечего) */
export function originOf(body: any): RecordOriginInfo | null {
  if (!body || typeof body !== 'object') return null;
  const name = typeof body.createdBy?.name === 'string' ? body.createdBy.name.trim() : '';
  const at = typeof body.createdAt === 'string' && !Number.isNaN(new Date(body.createdAt).getTime()) ? body.createdAt : null;
  if (!name && !at) return null;
  return { createdBy: name ? { ...(typeof body.createdBy.userId === 'string' ? { userId: body.createdBy.userId } : {}), name } : null, createdAt: at };
}

/** «Создал: Иванов И. И., 16.11.2026»; автора нет — «Создано: 16.11.2026»; ничего нет — пустая строка */
export function createdByText(origin: RecordOriginInfo | null): string {
  if (!origin) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  let date = '';
  if (origin.createdAt) { const d = new Date(origin.createdAt); date = `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`; }
  if (origin.createdBy) return `Создал: ${origin.createdBy.name}${date ? `, ${date}` : ''}`;
  return date ? `Создано: ${date}` : '';
}

/** Запрос происхождения записи; любой сбой — `null`, не исключение */
export async function fetchRecordOrigin(model: string, id: string, fetcher: (url: string) => Promise<Response> = (u) => fetch(u)): Promise<RecordOriginInfo | null> {
  if (!model || !id) return null;
  try {
    const res = await fetcher(`/api/record-origin?model=${encodeURIComponent(model)}&id=${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    return originOf(await res.json());
  } catch {
    return null;
  }
}
