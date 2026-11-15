/**
 * Хук: пока компонент на экране, записи из списка считаются открытыми у этого окна.
 *
 * Сам разговор с сервером — `lib/openRecords.ts` (без React). Здесь только связь с
 * жизнью компонента: список сообщается при смене и снимается при размонтировании.
 * `source` называет того, кто держит (экран, окно правки): у окна один клиент и
 * несколько источников, а на сервер уходит их объединение.
 */
import { useEffect } from 'react';
import { windowOpenRecords, type OpenRecordRef } from '../lib/openRecords';

export function useOpenRecords(source: string, records: OpenRecordRef[]): void {
  // Ключ по содержимому: новый массив с теми же записями ничего не пересылает
  const key = records.map((r) => `${r.model}:${r.id}`).join('|');
  useEffect(() => {
    const client = windowOpenRecords();
    client.setSource(source, records);
    return () => client.setSource(source, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- records сведён к key
  }, [source, key]);
}
