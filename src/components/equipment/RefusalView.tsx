/**
 * Отказ записи в форме: на месте прежней строки текста.
 *
 * Отказ, который сервер объяснил (изменили, удалили, открыта у коллеги), — общий
 * `ConflictNotice` с перечнем «было → стало»; прочий (занятый тег, нет права) —
 * прежняя красная строка: ставить в рамку каждое «тег занят» незачем.
 */
import ConflictNotice from '../ui/ConflictNotice';
import type { Refusal } from './conflictView';

export default function RefusalView({ refusal, className = '' }: { refusal: Refusal | null; className?: string }) {
  if (!refusal) return null;
  if (refusal.kind === 'plain') return <div role="alert" className={`fx-error ${className}`.trim()}>{refusal.message}</div>;
  return <ConflictNotice message={refusal.message} changes={refusal.kind === 'conflict' ? refusal.changes : undefined} changedBy={refusal.kind === 'conflict' ? refusal.changedBy : undefined} className={className} />;
}
