/**
 * Отказ записи ВДР на экране: в карточке и реквизитах — на месте прежней строки отказа,
 * у действий без формы (быстрая кнопка в таблице, массовое действие, ревизия реестра) — окном.
 *
 * Объяснённый отказ (изменили, удалили, открыта у коллеги) — общий `ConflictNotice` с перечнем
 * «было → стало» (у массовых действий — по строкам, а то, что не записано не из-за чужой правки,
 * списком под ним); прочий (нет права, сбой) — прежняя красная строка или всплывающая строка:
 * ставить в рамку каждое «нет права» незачем. Перечень во всплывающую строку не помещается
 * и исчезает через несколько секунд, а прочесть его надо, поэтому окно закрывает человек.
 */
import { useState, type ReactNode } from 'react';
import { Dialog, Btn } from '../ui';
import ConflictNotice from '../ui/ConflictNotice';
import type { VdrRefusal } from './vdrWrite';

export function VdrRefusalView({ refusal, className = '' }: { refusal: VdrRefusal | null; className?: string }) {
  if (!refusal) return null;
  if (refusal.kind === 'plain') return <div role="alert" className={`fx-error ${className}`.trim()}>{refusal.message}</div>;
  return (
    <div data-vdr-refusal className={className}>
      <ConflictNotice message={refusal.message}
        changes={refusal.kind === 'conflict' && !refusal.groups ? refusal.changes : undefined}
        groups={refusal.kind === 'conflict' && refusal.groups?.some((g) => g.changes.length > 0) ? refusal.groups : undefined} />
      {refusal.notes && refusal.notes.length > 0 && (
        <ul className="fx-conflict-list mt-2" data-conflict-notes>
          {refusal.notes.map((n, i) => <li key={`${n.title}-${i}`} data-conflict-note><span className="fx-conflict-field">{n.title}:</span> {n.text}</li>)}
        </ul>
      )}
    </div>
  );
}

/** Окно отказа для действий без формы. Прочий отказ остаётся всплывающей строкой, как был. */
export function useVdrRefusalDialog(toast: (text: string, kind: 'error') => void): { show: (title: string, refusal: VdrRefusal) => void; element: ReactNode } {
  const [shown, setShown] = useState<{ title: string; refusal: VdrRefusal } | null>(null);
  const show = (title: string, refusal: VdrRefusal) => {
    if (refusal.kind === 'plain') toast(refusal.message, 'error'); else setShown({ title, refusal });
  };
  const element = shown && (
    <Dialog title={shown.title} onClose={() => setShown(null)} width="max-w-lg" label={shown.title}
      footer={<Btn tone="primary" onClick={() => setShown(null)}>Понятно</Btn>}>
      <div data-refusal-dialog><VdrRefusalView refusal={shown.refusal} /></div>
    </Dialog>
  );
  return { show, element };
}
