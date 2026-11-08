import React from 'react';
import { Dialog, Btn, Select, Input, Status } from '../ui';
import { kitPlan, kitApply, kitUndo, type KitRowsPlan } from '../../lib/docflowKitApi';

const units: Record<string, string> = { tag: 'На тег', group: 'На установку', project: 'На проект' };
const necessities: Record<string, string> = { required: 'Обязательный', customer: 'По требованию заказчика', optional: 'Необязательный' };

export default function KitRowsDialog({ projectId, tagIds, registers, stage: initialStage = 'Р', onClose, onApplied }: {
  projectId: string; tagIds: string[]; registers: Array<{ id: string; name: string }>; stage?: string;
  onClose: () => void; onApplied: () => void;
}) {
  const [registerId, setRegisterId] = React.useState(registers[0]?.id || '');
  const [stage, setStage] = React.useState(initialStage);
  const [fields, setFields] = React.useState<Record<string, string>>({});
  const [plan, setPlan] = React.useState<KitRowsPlan | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [applied, setApplied] = React.useState(false);
  const change = (callback: () => void) => { callback(); setPlan(null); setError(''); };
  const preview = async () => {
    setBusy(true); setError(''); setPlan(null);
    const answer = await kitPlan({ projectId, registerId, tagIds, stage, fields });
    setBusy(false);
    if (answer.ok) setPlan(answer.data); else setError(answer.data.error || 'Не удалось построить план');
  };
  const apply = async () => {
    if (!plan) return;
    setBusy(true); setError('');
    const answer = await kitApply(projectId, plan.id);
    setBusy(false);
    if (answer.ok) { setApplied(true); onApplied(); } else { setPlan(null); setError(answer.data.error || 'Не удалось создать строки'); }
  };
  const undo = async () => {
    if (!plan) return;
    setBusy(true); setError('');
    const answer = await kitUndo(projectId, plan.id);
    setBusy(false);
    if (answer.ok) { onApplied(); onClose(); } else setError(answer.data.error || 'Не удалось отменить создание');
  };
  const count = plan?.rows.filter(row => row.action === 'create').length || 0;
  return <Dialog title="Создать недостающие строки — предпросмотр" width="max-w-5xl" busy={busy} onClose={onClose}
    footer={<><Btn disabled={busy} onClick={onClose}>{applied ? 'Готово' : 'Закрыть'}</Btn>
      {applied ? <Btn disabled={busy} onClick={() => void undo()}>Отменить создание строк</Btn> : <>
        <Btn disabled={busy || !registerId} onClick={() => void preview()}>Показать план</Btn>
        <Btn tone="primary" disabled={busy || !plan || !count} onClick={() => void apply()}>Создать строки ({count})</Btn></>}
    </>}>
    <p className="fx-note mb-3">Строки и связи с перечисленными тегами увидят участники проекта. Отмена доступна 30 дней, пока строки не изменили и не использовали.</p>
    <div className="flex flex-wrap items-end gap-3 mb-3">
      <label className="fx-field min-w-44"><span className="fx-label">Реестр проекта</span><Select aria-label="Реестр комплекта" value={registerId} disabled={busy || applied} onChange={v => change(() => setRegisterId(v))} options={[{ value: '', label: 'Выберите…' }, ...registers.map(r => ({ value: r.id, label: r.name }))]} /></label>
      <label className="fx-field"><span className="fx-label">Стадия</span><Select aria-label="Стадия комплекта" value={stage} disabled={busy || applied} onChange={v => change(() => setStage(v))} options={[{ value: 'П', label: 'П' }, { value: 'Р', label: 'Р' }]} /></label>
      {['заказ', 'установка', 'договор'].map(key => <label className="fx-field min-w-32 flex-1" key={key}><span className="fx-label">{key === 'заказ' ? 'Заказ (если не задан в реестре)' : key === 'установка' ? 'Установка (если нет связи)' : 'Договор (если не задан)'}</span>
        <Input aria-label={`Поле шифра: ${key}`} value={fields[key] || ''} disabled={busy || applied} onChange={e => change(() => setFields(current => { const next = { ...current }; if (e.target.value) next[key] = e.target.value; else delete next[key]; return next; }))} /></label>)}
    </div>
    {!registers.length && <Status tone="amber">Сначала создайте реестр проекта на вкладке «Реестр».</Status>}
    {busy && <p role="status">Подготовка…</p>}
    {error && <Status tone="rose">{error}</Status>}
    {applied && <Status tone="emerald">Строки созданы по подтверждённому плану.</Status>}
    {plan && <div className="overflow-x-auto"><table className="fx-table w-full whitespace-nowrap" aria-label="План строк комплекта"><thead><tr>
      <th>Теги</th><th>Тип / единица</th><th>Обязательность</th><th>Шифр</th><th>Имя файла</th><th>Ответственный</th><th>Срок</th><th>Действие</th>
    </tr></thead><tbody>{plan.rows.map(row => <tr key={row.key}>
      <td className="font-mono max-w-44 truncate" title={row.tags?.join(', ')}>{row.tags?.join(', ') || row.tagIds.join(', ')}</td>
      <td>{row.docType || '—'} · {units[row.unit]}</td><td>{necessities[row.necessity || ''] || '—'}</td>
      <td className="font-mono">{row.cipher || '—'}</td><td className="font-mono">{row.fileName || '—'}</td>
      <td>{row.assignee || '—'}</td><td>{row.dueDate?.slice(0, 10) || 'Срок не задан'}</td>
      <td>{row.problem || (row.action === 'create' ? 'Создать' : row.action === 'keep' ? 'Уже есть' : 'Пропустить')}</td>
    </tr>)}</tbody></table>{!plan.rows.length && <p className="fx-note">Для выбранной стадии нет недостающих документов.</p>}</div>}
  </Dialog>;
}
