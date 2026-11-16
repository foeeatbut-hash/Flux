/**
 * Окно отказа действия по плану («отменить импорт»): позиции изменили после подтверждения.
 *
 * Перечень по позициям («поле: было → стало») в всплывающую строку не помещается и исчезает
 * за несколько секунд, а прочесть его надо, поэтому отказ открывается окном, которое закрывает
 * человек. Показ — общий `ConflictNotice`; разбор ответа — `planRefusal.ts`.
 */
import { Dialog, Btn } from '../ui';
import ConflictNotice from '../ui/ConflictNotice';
import type { PlanRefusal } from './planRefusal';

export default function PlanRefusalDialog({ title, refusal, onClose }: { title: string; refusal: PlanRefusal; onClose: () => void }) {
  return (
    <Dialog title={title} onClose={onClose} width="max-w-lg" label={title}
      footer={<Btn tone="primary" onClick={onClose}>Понятно</Btn>}>
      <div data-refusal-dialog data-plan-refusal><ConflictNotice message={refusal.message} groups={refusal.groups} /></div>
    </Dialog>
  );
}
