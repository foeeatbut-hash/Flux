import React from 'react';
import { Dialog, Btn, Status, Empty } from '../ui';
import { migrationPlan, migrationApply, migrationUndo, type MigrationPlan } from '../../lib/docflowApi';

/**
 * Перенос прежних глобальных стандартов в проекты: у каждого проекта с
 * реестрами появляется своя копия настроек из стандарта его реестров.
 * Сначала план (какой проект из какого стандарта), потом применение одной
 * транзакцией, потом — отмена, которая убирает только нетронутые копии.
 */
export default function StandardsMigrationDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [plan, setPlan] = React.useState<MigrationPlan | null>(null);
  const [picked, setPicked] = React.useState<string[]>([]);
  const [message, setMessage] = React.useState('');
  const [busy, setBusy] = React.useState(true);
  const load = React.useCallback(async () => {
    setBusy(true);
    const answer = await migrationPlan();
    setBusy(false);
    if (answer.ok) { setPlan(answer.data); setPicked(answer.data.projects.map((p) => p.projectId)); } else setMessage(answer.data.error || 'План не собран');
  }, []);
  React.useEffect(() => { void load(); }, [load]);
  const apply = async () => {
    setBusy(true);
    const answer = await migrationApply(picked);
    setBusy(false);
    if (answer.ok) { setPlan(answer.data); setPicked([]); setMessage(`Своя копия настроек появилась у ${picked.length} проектов`); onDone(); }
    else setMessage(answer.data.error || 'Не удалось применить');
  };
  const undo = async () => {
    setBusy(true);
    const answer = await migrationUndo();
    setBusy(false);
    if (answer.ok) {
      setPlan(answer.data.plan); setPicked(answer.data.plan.projects.map((p) => p.projectId));
      setMessage(answer.data.kept.length ? `Отменено. Оставлены копии, которые уже правили: ${answer.data.kept.length}` : 'Перенос отменён');
      onDone();
    } else setMessage(answer.data.error || 'Не удалось отменить');
  };
  return (
    <Dialog title="Перенос стандартов в проекты" onClose={onClose} busy={busy} width="max-w-xl"
      footer={<>
        {plan?.applied && <Btn tone="danger" onClick={() => void undo()} disabled={busy}>Отменить перенос</Btn>}
        <Btn onClick={onClose} disabled={busy}>Закрыть</Btn>
        <Btn tone="primary" onClick={() => void apply()} disabled={busy || !picked.length}>Перенести ({picked.length})</Btn>
      </>}>
      <div className="flex flex-col gap-2 text-sm">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Глобальные стандарты стали шаблонами ({plan?.templates ?? '…'}). Проект получает свою копию из стандарта своих реестров; дальше она живёт отдельно.
        </p>
        {plan && !plan.projects.length && <Empty title="Переносить нечего" text="У всех проектов с реестрами уже есть свои настройки." />}
        {plan && plan.projects.length > 0 && (
          <table className="fx-table" aria-label="План переноса">
            <thead><tr><th style={{ width: 28 }} /><th>Проект</th><th>Стандарт</th><th className="text-right">Реестров</th></tr></thead>
            <tbody>
              {plan.projects.map((p) => (
                <tr key={p.projectId} title={p.note || undefined}>
                  <td><input type="checkbox" aria-label={`Перенести «${p.projectName}»`} checked={picked.includes(p.projectId)} onChange={(e) => setPicked((cur) => (e.target.checked ? [...cur, p.projectId] : cur.filter((x) => x !== p.projectId)))} /></td>
                  <td>{p.projectName}{p.note && <div className="fx-hint">{p.note}</div>}</td>
                  <td>{p.standardName}</td>
                  <td className="text-right tabular-nums">{p.registers}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {message && <Status tone="sky">{message}</Status>}
      </div>
    </Dialog>
  );
}
