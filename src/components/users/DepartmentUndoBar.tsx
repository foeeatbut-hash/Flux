import React, { useState } from 'react';
import { Btn } from '../ui';
import { departmentService } from '../../services/departmentService';
import { useDepartmentStore } from '../../store/departmentStore';

/**
 * Полоса «Выполнено · Отменить» после массовой правки подразделений. Остаётся,
 * пока человек её не закроет: отмена возможна сутки, и спешка тут ни к чему.
 */
export default function DepartmentUndoBar({ message, token, onClose, onUndone }: {
  message: string; token: string; onClose: () => void; onUndone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const undo = async () => {
    setBusy(true); setError('');
    try { await departmentService.undo(token); await useDepartmentStore.getState().load(); onUndone(); }
    catch (e: any) { setError(e?.message || 'Отмена не выполнена'); setBusy(false); }
  };
  return <div role="status" className="flex flex-wrap items-center gap-2 border-b border-[var(--flux-line)] bg-[var(--flux-sel)] px-4 py-1.5 text-[13px]">
    <span className="min-w-0 flex-1 truncate" title={message}>{message}</span>
    {error && <span className="text-[var(--flux-bad-text)]">{error}</span>}
    <Btn size="sm" disabled={busy} onClick={() => void undo()}>{busy ? 'Отмена…' : 'Отменить'}</Btn>
    <Btn size="sm" tone="ghost" disabled={busy} onClick={onClose}>Скрыть</Btn>
  </div>;
}
