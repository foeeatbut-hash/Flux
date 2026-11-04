import React from 'react';
import type { OfficeChange } from '../../../office/changes';
import { changePlace } from './FluxChangesList';
import { changeKey, type RefreshGroups } from './officeRefreshPreview';

const show = (value: string | null, unit?: string) => (value === null || value === '' ? '—' : unit ? `${value} ${unit}` : value);

interface Props {
  groups: RefreshGroups;
  skipped: ReadonlySet<string>;
  onToggle: (change: OfficeChange) => void;
  onGoto?: (change: OfficeChange) => void;
}

/**
 * Предпросмотр «Обновить» (решение 4.11.2026): по каждой ячейке «было → станет», галочка
 * «применить». Три группы с разным действием; снятые позиции и пропавшие значения — по
 * умолчанию отмечены, но строка не удаляется, а помечается (office.md).
 */
export default function FluxRefreshPreview({ groups, skipped, onToggle, onGoto }: Props) {
  const section = (title: string, hint: string, items: OfficeChange[], line: (change: OfficeChange) => React.ReactNode) => items.length ? (
    <section className="mt-3" aria-label={title}>
      <h4 className="text-[13px] font-semibold">{title} · {items.length.toLocaleString('ru-RU')}</h4>
      <p className="fx-note !pb-1">{hint}</p>
      <ul className="m-0 list-none p-0">
        {items.map((change) => (
          <li key={changeKey(change)} className="flex items-start gap-2 py-1.5" style={{ borderBottom: '1px solid var(--flux-line)' }}>
            <input type="checkbox" className="mt-1" style={{ accentColor: "var(--flux-accent)" }} checked={!skipped.has(changeKey(change))} onChange={() => onToggle(change)}
              aria-label={`Применить: ${change.entityLabel}${change.column ? `, ${change.column}` : ''}`} />
            <button type="button" className="min-w-0 flex-1 bg-transparent p-0 text-left" onClick={() => onGoto?.(change)} disabled={!onGoto} title={onGoto ? 'Перейти к этому месту в документе' : undefined}>
              <span className="flex w-full min-w-0 items-baseline justify-between gap-2">
                <span className="truncate text-[13px] font-medium">{change.entityLabel}</span>
                <span className="shrink-0 text-xs tabular-nums" style={{ color: 'var(--flux-text-muted)' }}>{changePlace(change)}</span>
              </span>
              <span className="block min-w-0 break-words text-xs" style={{ color: 'var(--flux-text)' }}>{line(change)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  ) : null;
  const column = (change: OfficeChange) => change.column ? <span style={{ color: 'var(--flux-text-muted)' }}>{change.column}: </span> : null;
  return (
    <div data-testid="flux-refresh-preview">
      {section('Значения изменятся', 'В ячейке будет новое значение из источника.', groups.values, (c) => <>{column(c)}{show(c.was)} → <strong>{show(c.now, c.unit)}</strong></>)}
      {section('Значение пропало — ячейка будет очищена', 'В источнике значения больше нет. «Отменить» вернёт прежнее.', groups.cleared, (c) => <>{column(c)}{show(c.was)} → <strong>пусто</strong></>)}
      {section('Позиция снята — строка будет помечена', 'Строка остаётся в документе, ничего в ней не стирается; Flux помечает её «позиции больше нет в источнике».', groups.removed, (c) => <>строка остаётся → <strong>помечена как снятая</strong></>)}
      {groups.manual.length > 0 && <p className="fx-note fx-note-warn mt-2">Правили руками, «Обновить» не заменит: {groups.manual.length.toLocaleString('ru-RU')}</p>}
    </div>
  );
}
