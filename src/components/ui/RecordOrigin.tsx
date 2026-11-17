/**
 * Строка «Создал: Иванов И. И., 16.11.2026» в карточке записи — общая для всех программ.
 *
 * Автор и время берутся из журнала изменений сервера (`GET /api/record-origin`).
 * Нет автора — только дата («Создано: …»); нет ничего, запрос не удался или записи
 * ещё нет (`id` пуст) — не рисуется ничего: карточка не должна показывать ошибку
 * из-за подсказки. Оформление — `fx-hint`, как у прочих пояснений.
 */
import { useEffect, useState } from 'react';
import { createdByText, fetchRecordOrigin, type RecordOriginInfo } from '../../lib/recordOrigin';

export default function RecordOrigin({ model, id, className = '' }: {
  /** Имя модели схемы: `Project`, `Tag`, `Monoblock`, `DocRegisterItem`, `DictionaryItem`… */
  model: string;
  id: string | null | undefined;
  className?: string;
}) {
  const [shown, setShown] = useState<{ key: string; origin: RecordOriginInfo | null } | null>(null);
  const key = id ? `${model}:${id}` : '';
  useEffect(() => {
    if (!key || !id) return;
    let alive = true;
    void fetchRecordOrigin(model, id).then((origin) => { if (alive) setShown({ key, origin }); });
    return () => { alive = false; };
  }, [key, model, id]);
  // Ответ другой записи (человек переключился быстрее запроса) не показывается
  const text = shown && shown.key === key ? createdByText(shown.origin) : '';
  if (!text) return null;
  return <p className={`fx-hint m-0 ${className}`.trim()} data-record-origin>{text}</p>;
}
