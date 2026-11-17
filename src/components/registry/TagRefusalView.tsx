/**
 * Отказ записи тега на экране: в карточке — на месте прежней строки, у правки без формы — окном.
 *
 * Объяснённый отказ (изменили, удалили, открыт у коллеги) — общий `ConflictNotice` с
 * перечнем «было → стало» (у массовых действий — по записям); прочий (занятый код,
 * сбой) — прежняя красная строка или всплывающий тост: ставить в рамку каждое «код занят» незачем.
 * Перечень во всплывающую строку не помещается и исчезает через несколько секунд, а
 * прочесть его надо, поэтому окно закрывает человек.
 */
import { useState, type ReactNode } from 'react';
import { Dialog, Btn } from '../ui';
import ConflictNotice from '../ui/ConflictNotice';
import type { TagRefusal } from './tagRefusal';

export function TagRefusalView({ refusal, className = '' }: { refusal: TagRefusal | null; className?: string }) {
  if (!refusal) return null;
  if (refusal.kind === 'plain') return <div role="alert" className={`fx-error ${className}`.trim()}>{refusal.message}</div>;
  return (
    <ConflictNotice message={refusal.message} className={className}
      changedBy={refusal.kind === 'conflict' && !refusal.groups ? refusal.changedBy : undefined}
      changes={refusal.kind === 'conflict' && !refusal.groups ? refusal.changes : undefined}
      groups={refusal.kind === 'conflict' ? refusal.groups : undefined} />
  );
}

/** Окно отказа для действий без формы: удаление, массовое действие, правка из списка. */
export function useTagRefusalDialog(toast: (text: string, kind: 'error') => void): { show: (title: string, refusal: TagRefusal) => void; element: ReactNode } {
  const [shown, setShown] = useState<{ title: string; refusal: TagRefusal } | null>(null);
  const show = (title: string, refusal: TagRefusal) => {
    if (refusal.kind === 'plain') toast(refusal.message, 'error'); else setShown({ title, refusal });
  };
  const element = shown && (
    <Dialog title={shown.title} onClose={() => setShown(null)} width="max-w-lg" label={shown.title}
      footer={<Btn tone="primary" onClick={() => setShown(null)}>Понятно</Btn>}>
      <div data-refusal-dialog><TagRefusalView refusal={shown.refusal} /></div>
    </Dialog>
  );
  return { show, element };
}
