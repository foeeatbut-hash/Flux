import React, { useEffect, useMemo, useState } from 'react';
import { Btn, Dialog, Field, Input, Status } from '../ui';
import DepartmentPicker from './DepartmentPicker';
import { departmentLabel } from '../../../shared/departments';
import { departmentService, type AssignPlanItem, type DepartmentRow } from '../../services/departmentService';
import { useDepartmentStore } from '../../store/departmentStore';
import { countOf } from '../../lib/plural';

/**
 * «Перевести в подразделение…»: выбор места, предпросмотр, перевод.
 * План строит сервер (ничего не пишет), применение — отдельный шаг; после него
 * экран показывает «Отменить» (flux-data-safety: массовая запись обратима).
 */
export default function AssignDialog({ userIds, departments, initialTarget = '', onClose, onDone }: {
  userIds: string[]; departments: DepartmentRow[]; initialTarget?: string;
  onClose: () => void; onDone: (message: string, undoToken: string | null) => void;
}) {
  const [target, setTarget] = useState(initialTarget);
  const [reason, setReason] = useState('');
  const [items, setItems] = useState<AssignPlanItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!target) { setItems([]); return; }
    let alive = true;
    setBusy(true); setError('');
    departmentService.assignPreview(userIds, target)
      .then((r) => { if (alive) setItems(r.items); })
      .catch((e: any) => { if (alive) { setItems([]); setError(e?.message || 'Не удалось построить предпросмотр'); } })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [target, userIds]);

  const moves = useMemo(() => items.filter((i) => i.status === 'move'), [items]);
  const same = items.filter((i) => i.status === 'same').length;
  const skipped = items.filter((i) => i.status === 'skip');
  const label = (id: string | null) => id ? departmentLabel(departments, id) || '—' : 'Без подразделения';
  const targetName = departments.find((d) => d.id === target)?.name || '';

  const apply = async () => {
    setBusy(true); setError('');
    try {
      const r = await departmentService.assign(userIds, target, reason.trim() || undefined);
      await useDepartmentStore.getState().load();
      onDone(`Переведено: ${countOf(r.moved, 'сотрудник')} → «${targetName}»`, r.undoToken);
    } catch (e: any) { setError(e?.message || 'Перевод не выполнен'); setBusy(false); }
  };

  return <Dialog title="Перевести в подразделение" width="max-w-2xl" onClose={onClose} busy={busy}
    footer={<><Btn size="lg" disabled={busy} onClick={onClose}>Отмена</Btn><Btn size="lg" tone="primary" disabled={busy || !moves.length} onClick={() => void apply()}>{moves.length ? `Перевести ${moves.length}` : 'Перевести'}</Btn></>}>
    {error && <p className="fx-error mb-3" role="alert">{error}</p>}
    <div className="space-y-3">
      <Field label={`Куда (отмечено: ${countOf(userIds.length, 'сотрудник')})`}>
        <DepartmentPicker value={target} onChange={setTarget} departments={departments} disabled={busy} ariaLabel="Подразделение для перевода" placeholder="Выберите подразделение" />
      </Field>
      <Field label="Причина" hint="Необязательно. Попадёт в историю переводов.">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} placeholder="Например, реорганизация" />
      </Field>
      {target && !busy && items.length > 0 && <>
        <p className="fx-hint">Будет переведено: {moves.length}{same ? ` · уже там: ${same}` : ''}{skipped.length ? ` · пропущено: ${skipped.length}` : ''}</p>
        <div className="max-h-64 overflow-auto">
          <table className="fx-table">
            <thead><tr><th>Сотрудник</th><th>Сейчас</th><th>Результат</th></tr></thead>
            <tbody>{items.map((i) => <tr key={i.userId}>
              <td className="truncate" title={i.name}>{i.name}</td>
              <td className="text-slate-500 dark:text-slate-400">{label(i.fromId)}</td>
              <td>{i.status === 'move' ? <Status tone="emerald">переводится</Status> : i.status === 'same' ? <Status tone="slate">уже там</Status> : <Status tone="amber" title={i.note}>пропущен</Status>}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {skipped.length > 0 && <p className="fx-hint">{skipped[0].note}{skipped.length > 1 ? ' (и другие пропущенные)' : ''}.</p>}
      </>}
    </div>
  </Dialog>;
}
