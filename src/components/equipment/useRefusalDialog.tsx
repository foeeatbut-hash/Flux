/**
 * Окно отказа для действий без формы: удаление, отвязка тега, «принять значение».
 *
 * Перечень «было → стало» во всплывающую строку не помещается и исчезает через
 * несколько секунд, а прочесть его надо. Поэтому объяснённый отказ открывается
 * окном, которое закрывает человек; прочий отказ (сеть, нет права) остаётся
 * всплывающей строкой, как был.
 */
import { useState, type ReactNode } from 'react';
import { Dialog, Btn } from '../ui';
import type { Refusal } from './conflictView';
import RefusalView from './RefusalView';

export function useRefusalDialog(toast: (text: string, kind: 'error') => void): { show: (title: string, refusal: Refusal) => void; element: ReactNode } {
  const [shown, setShown] = useState<{ title: string; refusal: Refusal } | null>(null);
  const show = (title: string, refusal: Refusal) => {
    if (refusal.kind === 'plain') toast(refusal.message, 'error'); else setShown({ title, refusal });
  };
  const element = shown && (
    <Dialog title={shown.title} onClose={() => setShown(null)} width="max-w-lg" label={shown.title}
      footer={<Btn tone="primary" onClick={() => setShown(null)}>Понятно</Btn>}>
      <div data-refusal-dialog><RefusalView refusal={shown.refusal} /></div>
    </Dialog>
  );
  return { show, element };
}
