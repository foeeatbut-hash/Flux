import React from 'react';
import type { OfficeChange, OfficeChangesResult } from '../../../office/changes';

/** Место значения в документе: «Лист1!C4»; у Документа — колонка и позиция строки */
export function changePlace(change: OfficeChange): string {
  return change.sheet && change.address ? `${change.sheet}!${change.address}` : change.column ? `Таблица · ${change.column}` : 'Таблица';
}

const money = (value: string | null, unit?: string) => (value === null || value === '' ? '—' : unit ? `${value} ${unit}` : value);

/**
 * Значение, которое «Обновить» действительно перепишет. «Пропало из источника» и «позиции больше
 * нет» документ не стирает, а ручную правку не заменяет: в счёт «изменится» и «изменилось» они
 * не идут, иначе после обновления сводка говорила бы «изменилось 4» при одном записанном значении.
 */
export const isRewritten = (change: OfficeChange): boolean => !change.manual && (change.kind === 'changed' || change.kind === 'added');

/** Что произошло со значением: слова для строки списка и для скринридера */
export function changeSummary(change: OfficeChange): string {
  if (change.kind === 'row-removed') return 'позиции больше нет в источнике; строка в документе остаётся';
  if (change.kind === 'cleared') return `в источнике значения больше нет (в документе остаётся ${money(change.was)})`;
  return `${money(change.was)} → ${money(change.now, change.unit)}`;
}

interface Props {
  changes: OfficeChange[];
  /** Щелчок по строке: показать это место в документе */
  onGoto?: (change: OfficeChange) => void;
  /** Строки, которых показано больше предела, сворачиваются под «Показать все» */
  limit?: number;
}

/**
 * Список «где · было → стало». Каждая строка — кнопка: щелчок переводит к
 * месту в документе (ячейка Таблицы или строка таблицы Документа).
 */
export default function FluxChangesList({ changes, onGoto, limit = 200 }: Props) {
  const [all, setAll] = React.useState(false);
  const shown = all ? changes : changes.slice(0, limit);
  return (
    <div>
      <ul className="m-0 list-none p-0" aria-label="Изменения в документе">
        {shown.map((change, index) => (
          <li key={`${change.entityId}\u0000${change.anchorId}\u0000${index}`} style={{ borderBottom: '1px solid var(--flux-line)' }}>
            <button type="button" className="fx-li h-auto min-h-[44px] w-full flex-col items-start gap-0 whitespace-normal py-1.5" onClick={() => onGoto?.(change)} disabled={!onGoto}
              title={onGoto ? 'Перейти к этому месту в документе' : undefined}>
              <span className="flex w-full min-w-0 items-baseline justify-between gap-2">
                <span className="truncate text-[13px] font-medium">{change.entityLabel}</span>
                <span className="shrink-0 text-xs tabular-nums" style={{ color: 'var(--flux-text-muted)' }}>{changePlace(change)}</span>
              </span>
              <span className="flex w-full min-w-0 items-baseline gap-2 text-xs" style={{ color: 'var(--flux-text-muted)' }}>
                {change.column && change.kind !== 'row-removed' && <span className="shrink-0">{change.column}:</span>}
                <span className="min-w-0 break-words" style={{ color: 'var(--flux-text)' }}>{changeSummary(change)}</span>
              </span>
              {change.manual && <span className="fx-note fx-note-warn !py-0">Правили руками: «Обновить» эту строку не заменит</span>}
            </button>
          </li>
        ))}
      </ul>
      {!all && changes.length > limit && <button type="button" className="fx-btn fx-btn-quiet fx-btn-sm mt-2" onClick={() => setAll(true)}>Показать все ({changes.length.toLocaleString('ru-RU')})</button>}
    </div>
  );
}

/** Сводка проверки одной фразой: для полосы и заголовка раздела */
export function changesHeadline(result: OfficeChangesResult | null): string {
  if (!result) return 'Проверяем актуальность данных…';
  if (!result.stale) return result.rows ? 'Данные в документе актуальны' : 'В документе нет заполненных строк';
  const n = result.count;
  const word = n % 10 === 1 && n % 100 !== 11 ? 'значение' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'значения' : 'значений';
  return `Данные проекта изменились: в документе устарело ${n.toLocaleString('ru-RU')} ${word}`;
}
