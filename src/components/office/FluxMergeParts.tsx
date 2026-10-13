import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Btn, Dialog, Input } from '../ui';
import type { MergePosition } from './fluxMergeChoice';

/** «У 1 позиции», «У 2 позиций»: после «У» слово стоит в родительном падеже. */
export const positionsText = (count: number): string => `У ${count} ${count % 10 === 1 && count % 100 !== 11 ? 'позиции' : 'позиций'} заполнены оба параметра`;

export interface MergeAlternativeName { fieldKey: string; name: string }

/**
 * Короткая плашка рядом с ячейкой: объединение не остановилось, но у части позиций заполнены оба
 * параметра. Выбор можно сделать здесь или позже правым щелчком по плашке («Приоритет объединения»).
 */
export function MergeBadge({ count, alternatives, left, top, busy, onTake, onEach, onClose }: {
  count: number; alternatives: MergeAlternativeName[]; left: number; top: number; busy: boolean;
  onTake: (fieldKey: string) => void; onEach: () => void; onClose: () => void;
}) {
  return createPortal(<div role="group" aria-label="Приоритет объединения" data-context-menu className="fx-pop fixed z-[70] w-72 space-y-2 p-3 text-xs" style={{ left, top }}>
    <div className="flex items-start justify-between gap-2">
      <p role="status" className="font-medium text-slate-800 dark:text-dark-text-main">{positionsText(count)}</p>
      <button type="button" aria-label="Закрыть плашку" className="shrink-0 text-slate-500 hover:text-slate-800 dark:text-slate-400" onClick={onClose}><X size={14} /></button>
    </div>
    <div className="flex flex-wrap gap-1.5">
      {alternatives.map((item) => <Btn key={item.fieldKey} size="sm" disabled={busy} onClick={() => onTake(item.fieldKey)}>Брать {item.name}</Btn>)}
      <Btn size="sm" disabled={busy} onClick={onEach}>Выбрать по каждой</Btn>
    </div>
  </div>, document.body);
}

/** Порядок параметров объединения и исключения по позициям, где заполнены оба. */
export function PriorityDialog({ alternatives, positions, picks, busy, onSave, onClose }: {
  alternatives: MergeAlternativeName[]; positions: MergePosition[]; picks: Record<string, string>; busy: boolean;
  onSave: (order: string[], picks: Record<string, string>) => void; onClose: () => void;
}) {
  const [order, setOrder] = useState(alternatives.map((item) => item.fieldKey));
  const [chosen, setChosen] = useState<Record<string, string>>(picks);
  const names = new Map(alternatives.map((item) => [item.fieldKey, item.name]));
  const move = (index: number, delta: number) => setOrder((list) => {
    const next = [...list]; const to = index + delta;
    if (to < 0 || to >= next.length) return list;
    [next[index], next[to]] = [next[to], next[index]];
    return next;
  });
  return <Dialog title="Приоритет объединения" width="max-w-lg" scrollBody busy={busy} onClose={onClose}
    footer={<><Btn disabled={busy} onClick={onClose}>Отмена</Btn><Btn tone="primary" disabled={busy} onClick={() => onSave(order, chosen)}>Сохранить</Btn></>}>
    <div className="space-y-4 text-xs text-slate-700 dark:text-slate-200">
      <section aria-label="Порядок параметров" className="space-y-1">
        <h4 className="font-semibold text-slate-800 dark:text-dark-text-main">Если у позиции заполнены оба параметра, берётся первый</h4>
        <ol className="space-y-1">
          {order.map((key, index) => <li key={key} className="flex items-center gap-2">
            <span className="w-4 text-slate-500">{index + 1}.</span><span className="min-w-0 flex-1 truncate">{names.get(key)}</span>
            <Btn size="sm" aria-label={`Выше: ${names.get(key)}`} disabled={index === 0} onClick={() => move(index, -1)}>↑</Btn>
            <Btn size="sm" aria-label={`Ниже: ${names.get(key)}`} disabled={index === order.length - 1} onClick={() => move(index, 1)}>↓</Btn>
          </li>)}
        </ol>
      </section>
      <section aria-label="Позиции с обоими параметрами" className="space-y-1">
        <h4 className="font-semibold text-slate-800 dark:text-dark-text-main">{positions.length ? positionsText(positions.length) : 'Позиций, где заполнены оба параметра, нет'}</h4>
        <ul className="divide-y divide-slate-200 dark:divide-slate-700">
          {positions.map((position) => {
            const current = chosen[position.entityId] || order[0];
            return <li key={position.entityId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
              <span className="min-w-0 flex-1 truncate font-medium" title={position.name}>{position.name}</span>
              <span role="radiogroup" aria-label={`Параметр для позиции ${position.name}`} className="flex gap-1">
                {order.map((key) => <button key={key} type="button" role="radio" aria-checked={current === key} title={position.values[key]}
                  className={`fx-btn fx-btn-sm ${current === key ? 'fx-btn-primary' : ''}`} onClick={() => setChosen((all) => ({ ...all, [position.entityId]: key }))}>{names.get(key)}</button>)}
              </span>
            </li>;
          })}
        </ul>
      </section>
    </div>
  </Dialog>;
}

/** Своё имя параметра на плашке и в тексте шапки; программное остаётся в подсказке. */
export function RenameDialog({ current, technical, custom, busy, onSave, onReset, onClose }: {
  current: string; technical: string; custom: boolean; busy: boolean; onSave: (name: string) => void; onReset: () => void; onClose: () => void;
}) {
  const [name, setName] = useState(current);
  const submit = () => { if (name.trim()) onSave(name); };
  return <Dialog title="Переименовать" width="max-w-sm" busy={busy} onClose={onClose}
    footer={<>
      {custom && <Btn disabled={busy} onClick={onReset}>Сбросить имя</Btn>}
      <Btn disabled={busy} onClick={onClose}>Отмена</Btn>
      <Btn tone="primary" disabled={busy || !name.trim()} onClick={submit}>Сохранить</Btn>
    </>}>
    <div className="space-y-2 text-xs text-slate-600 dark:text-slate-300">
      <label className="block space-y-1"><span>Отображаемое имя</span>
        <Input autoFocus value={name} maxLength={200} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submit(); }} />
      </label>
      <p>Программное имя: {technical}. Данные берутся по нему, имя меняет только подпись.</p>
    </div>
  </Dialog>;
}

/** Объяснение, почему объединение не записано: в строках, где обе колонки заполнены вручную разным, выбирать нельзя. */
export function MergeConflictDialog({ conflicts, onClose }: { conflicts: Array<{ rowIndex: number; targetText: string; sourceText: string }>; onClose: () => void }) {
  return <Dialog title="Объединение не выполнено" width="max-w-md" onClose={onClose} footer={<Btn onClick={onClose}>Закрыть</Btn>}>
    <div role="alert" className="space-y-1 text-xs text-rose-700 dark:text-rose-300">
      <p>В выбранных колонках есть разные непустые значения, введённые вручную: {conflicts.length}. Они сохранены без изменений, документ не менялся. Приведите значения к одному в документе и повторите объединение.</p>
      {conflicts.slice(0, 8).map((conflict, index) => <p key={`${conflict.rowIndex}:${index}`}>Строка {conflict.rowIndex}: «{conflict.targetText}» / «{conflict.sourceText}»</p>)}
    </div>
  </Dialog>;
}
