/**
 * Полоса над документом Flux Office: кто в файле и кто его правит.
 *
 * Когда человек в файле один и правит — полосы нет: сообщать нечего. Она
 * появляется, когда есть что знать: рядом коллеги, правит другой, правка
 * свободна или нет связи.
 */
import React from 'react';
import { Avatar, Btn } from '../ui';
import type { OfficeMode, OfficeRoster } from './useOfficeRoom';

export function presenceLine(roster: OfficeRoster | null, clientId: string, mode: OfficeMode, editable: boolean): {
  text: string; canTake: boolean;
} {
  const h = roster?.holder || null;
  const others = (roster?.peers || []).filter((p) => p.clientId !== clientId);
  if (mode === 'pending') return { text: 'Подключение к серверу…', canTake: false };
  // Общий файл: правят все сразу
  if (roster?.collab) {
    const names = Array.from(new Set(others.map((p) => p.name)));
    if (mode === 'together') {
      if (!editable) return { text: 'Подключение к общему документу…', canTake: false };
      return { text: names.length ? `Правите вместе: ${names.join(', ')}` : '', canTake: false };
    }
    const me = roster.peers.find((p) => p.clientId === clientId);
    if (me && !me.mayWrite) return { text: 'Только просмотр: этот файл вам можно только смотреть. Правки остальных видны сразу', canTake: false };
    return { text: 'Нет связи с сервером: правка остановлена, пока связь не вернётся', canTake: false };
  }
  if (mode === 'alone') return { text: 'Нет связи с сервером: сохранение сверит версию файла', canTake: false };
  if (mode === 'edit') {
    if (!editable) return { text: 'Открываю свежую версию…', canTake: false };
    return { text: others.length ? 'Вы правите файл, остальные смотрят' : '', canTake: false };
  }
  if (h && h.lost) return { text: `${h.name} потерял связь — правка ждёт его возвращения`, canTake: false };
  if (h) return { text: `Только просмотр: файл правит ${h.name}. Его сохранения появляются здесь сами`, canTake: false };
  return { text: 'Правка свободна: файл никто не правит', canTake: true };
}

export default function OfficePresence({ roster, clientId, mode, editable, onTake }: {
  roster: OfficeRoster | null; clientId: string; mode: OfficeMode; editable: boolean; onTake: () => void;
}) {
  const { text, canTake } = presenceLine(roster, clientId, mode, editable);
  // Один человек в двух окнах — один кружок
  const seen = new Set<string>();
  const people = (roster?.peers || []).filter((p) => p.clientId !== clientId && !seen.has(p.userId) && seen.add(p.userId));
  if (!text && !people.length) return null;
  const holderId = roster?.holder?.userId;
  return (
    <div className="flex h-9 shrink-0 items-center gap-3 border-b border-slate-200 bg-slate-50 px-3 text-sm text-slate-700
                    dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300" role="status" aria-label="Кто в файле">
      {people.length > 0 && (
        <div className="flex items-center gap-1" aria-label="Сейчас в файле">
          {people.map((p) => (
            <span key={p.userId} title={roster?.collab ? p.name : p.userId === holderId ? `${p.name} — правит` : `${p.name} — смотрит`} className="inline-flex">
              <Avatar name={p.name} online />
            </span>
          ))}
        </div>
      )}
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {canTake && <Btn size="sm" tone="primary" onClick={onTake}>Взять правку</Btn>}
    </div>
  );
}
