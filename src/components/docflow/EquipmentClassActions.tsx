import React from 'react';
import { Btn, Dialog, Status } from '../ui';
import { docflowCall } from '../../lib/docflowApi';

interface ClassRow { tagId: string; tag: string; type: string; before: string; classId: string; classCode: string; action: string; source: string; problem: string }
interface ClassPlan { id: string; rows: ClassRow[] }
export interface ClassOverride { tagId: string; classId: string; type?: string }

/** Заполнение всегда отдельно от сохранения соответствий: сначала видимые строки плана. */
export default function EquipmentClassActions({ projectId, disabled, tagIds, overrides, onApplied, label = 'Заполнить классы…' }: {
  projectId: string; disabled?: boolean; tagIds?: string[]; overrides?: ClassOverride[];
  onApplied?: () => void; label?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [plan, setPlan] = React.useState<ClassPlan | null>(null);
  const [lastId, setLastId] = React.useState<string | null>(null);
  const [applied, setApplied] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const base = `/api/equipment/projects/${encodeURIComponent(projectId)}/catalog-classes`;
  const tagScope = !!tagIds;
  React.useEffect(() => {
    let alive = true;
    setLastId(null);
    if (tagScope) return;
    void docflowCall('GET', `${base}/last`).then(answer => { if (alive && answer.ok) setLastId(answer.data.id); });
    return () => { alive = false; };
  }, [base, tagScope]);
  const preview = async () => {
    setOpen(true); setBusy(true); setError(''); setPlan(null); setApplied(false);
    const answer = await docflowCall<ClassPlan>('POST', `${base}/plan`, { tagIds, overrides });
    setBusy(false);
    if (answer.ok) setPlan(answer.data); else setError(answer.data.error || 'Не удалось построить план');
  };
  const apply = async () => {
    if (!plan) return;
    setBusy(true); setError('');
    const answer = await docflowCall('POST', `${base}/apply`, { planId: plan.id });
    setBusy(false);
    if (answer.ok) { setApplied(true); setLastId(plan.id); onApplied?.(); }
    else { setError(answer.data.error || 'Не удалось применить план'); setPlan(null); }
  };
  const undo = async () => {
    setBusy(true); setError('');
    const answer = await docflowCall('POST', `${base}/undo`, { planId: lastId });
    setBusy(false);
    if (answer.ok) { setLastId(null); setOpen(false); setApplied(false); onApplied?.(); }
    else setError(answer.data.error || 'Не удалось отменить заполнение');
  };
  const count = plan?.rows.filter(row => row.action === 'set').length || 0;
  return <div className="space-y-2">
    <div className="flex flex-wrap gap-2">
      <Btn disabled={disabled || busy} onClick={() => void preview()}>{label}</Btn>
      {lastId && <Btn disabled={disabled || busy} onClick={() => void undo()}>Отменить последнее заполнение</Btn>}
    </div>
    {!open && error && <Status tone="rose">{error}</Status>}
    {open && <Dialog title="Классы оборудования — предпросмотр" width="max-w-3xl" busy={busy} onClose={() => setOpen(false)}
      footer={<><Btn disabled={busy} onClick={() => setOpen(false)}>{applied ? 'Готово' : 'Закрыть'}</Btn>
        {applied ? <Btn disabled={busy} onClick={() => void undo()}>Отменить заполнение</Btn>
          : <Btn tone="primary" disabled={busy || !plan || !count} onClick={() => void apply()}>Применить ({count})</Btn>}</>}>
      <p className="fx-note mb-3">Изменения увидят участники этого проекта. Другие проекты сохранят свои классы. Отмена доступна 30 дней, пока теги не изменили.</p>
      {busy && <p role="status">Подготовка…</p>}
      {error && <Status tone="rose">{error}</Status>}
      {applied && <Status tone="emerald">Классы назначены по подтверждённому плану.</Status>}
      {plan && <div className="overflow-x-auto"><table className="fx-table w-full" aria-label="План классов оборудования">
        <thead><tr><th>Тег</th><th>Тип</th><th>Было</th><th>Станет</th><th>Основание</th></tr></thead>
        <tbody>{plan.rows.map(row => <tr key={row.tagId}><td className="font-mono">{row.tag}</td><td>{row.type || '—'}</td><td>{row.before || '—'}</td>
          <td>{row.classCode || '—'}</td><td>{row.problem || (row.action === 'keep' ? 'Без изменения' : row.source)}</td></tr>)}</tbody>
      </table>{!plan.rows.length && <p className="fx-note">В проекте пока нет тегов.</p>}</div>}
    </Dialog>}
  </div>;
}
