import React, { useEffect, useMemo, useState } from 'react';
import { Btn, Dialog, Empty, Select, Status } from '../ui';
import DepartmentPicker from './DepartmentPicker';
import { departmentLabel } from '../../../shared/departments';
import { departmentService, type DepartmentRow, type LegacyChoice, type LegacyGroup } from '../../services/departmentService';
import { useDepartmentStore } from '../../store/departmentStore';
import { countOf } from '../../lib/plural';

/**
 * «Разложить сотрудников по подразделениям»: однократный мастер для старого
 * текстового поля «Подразделение». План строит сервер по тем, у кого
 * подразделение ещё не выбрано; таблица ниже и есть предпросмотр — ничего не
 * записано, пока не нажата «Разложить». После применения экран предлагает отмену.
 */
type Action = 'create' | 'map' | 'skip';
interface Row { action: Action; departmentId: string; parentId: string }

const defaultRow = (g: LegacyGroup, rootId: string): Row => g.match.status === 'match'
  ? { action: 'map', departmentId: g.match.departmentId, parentId: rootId }
  : g.match.status === 'create'
    ? { action: 'create', departmentId: '', parentId: g.match.parentId }
    : { action: 'skip', departmentId: '', parentId: rootId };

export default function LegacyWizard({ departments, rootId, onClose, onDone }: {
  departments: DepartmentRow[]; rootId: string; onClose: () => void; onDone: (message: string, undoToken: string | null) => void;
}) {
  const [groups, setGroups] = useState<LegacyGroup[] | null>(null);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    departmentService.legacyPlan(rootId)
      .then((r) => { if (!alive) return; setGroups(r.groups); setRows(Object.fromEntries(r.groups.map((g) => [g.key, defaultRow(g, rootId)]))); })
      .catch((e: any) => { if (alive) setError(e?.message || 'Не удалось построить план'); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [rootId]);

  const set = (key: string, patch: Partial<Row>) => setRows((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  const summary = useMemo(() => {
    let people = 0, created = 0;
    for (const g of groups || []) {
      const r = rows[g.key];
      if (!r || r.action === 'skip' || (r.action === 'map' && !r.departmentId)) continue;
      people += g.count;
      if (r.action === 'create' && g.match.status === 'create') created += g.match.chain.length;
    }
    return { people, created };
  }, [groups, rows]);

  const apply = async () => {
    setBusy(true); setError('');
    try {
      const choices: LegacyChoice[] = (groups || []).map((g) => {
        const r = rows[g.key];
        return r.action === 'map' ? { key: g.key, action: r.departmentId ? 'map' : 'skip', departmentId: r.departmentId }
          : r.action === 'create' ? { key: g.key, action: 'create', parentId: r.parentId } : { key: g.key, action: 'skip' };
      });
      const r = await departmentService.legacyApply(choices);
      await useDepartmentStore.getState().load();
      onDone(`Разложено: ${countOf(r.assigned, 'сотрудник')}${r.created ? `, создано подразделений: ${r.created}` : ''}`, r.undoToken);
    } catch (e: any) { setError(e?.message || 'Раскладка не выполнена'); setBusy(false); }
  };

  const mark = (g: LegacyGroup) => g.match.status === 'ambiguous'
    ? <Status tone="amber" title={g.match.candidates.join('; ')}>неоднозначно</Status>
    : g.match.status === 'match' ? <Status tone="emerald">найдено</Status> : <Status tone="sky">нет в справочнике</Status>;

  return <Dialog title="Разложить сотрудников по подразделениям" width="max-w-4xl" onClose={onClose} busy={busy}
    footer={<><Btn size="lg" disabled={busy} onClick={onClose}>Закрыть</Btn><Btn size="lg" tone="primary" disabled={busy || !summary.people} onClick={() => void apply()}>{summary.people ? `Разложить ${summary.people}` : 'Разложить'}</Btn></>}>
    {error && <p className="fx-error mb-3" role="alert">{error}</p>}
    {busy && !groups && <p className="fx-hint">Строится план…</p>}
    {groups && groups.length === 0 && <Empty title="Раскладывать нечего" text="У всех сотрудников с текстовым подразделением оно уже выбрано из справочника." />}
    {groups && groups.length > 0 && <>
      <p className="mb-2 fx-hint">Берётся старое текстовое поле «Подразделение». Одинаковые написания (регистр, пробелы) собраны вместе. Сначала предпросмотр: ничего не записано, пока вы не нажмёте «Разложить»; потом это можно отменить.</p>
      <div className="max-h-[50vh] overflow-auto">
        <table className="fx-table">
          <thead><tr><th>Текст у сотрудников</th><th>Людей</th><th>Действие</th><th>Куда</th></tr></thead>
          <tbody>{groups.map((g) => {
            const r = rows[g.key] || defaultRow(g, rootId);
            const chain = g.match.status === 'create' ? g.match.chain : [];
            return <tr key={g.key}>
              <td title={g.names.join(', ')}><span className="inline-flex items-center gap-2">{g.text}{mark(g)}</span></td>
              <td className="tabular-nums" title={g.names.join(', ')}>{g.count}</td>
              <td className="w-56"><Select aria-label={`Действие для «${g.text}»`} value={r.action} onChange={(v) => set(g.key, { action: v as Action })} disabled={busy}
                options={[{ value: 'create', label: 'Создать новое' }, { value: 'map', label: 'В существующее' }, { value: 'skip', label: 'Пропустить' }]} /></td>
              <td className="w-64">
                {r.action === 'map' && <DepartmentPicker value={r.departmentId} onChange={(v) => set(g.key, { departmentId: v })} departments={departments} disabled={busy} ariaLabel={`Куда положить «${g.text}»`} />}
                {r.action === 'create' && (chain.length > 1
                  ? <span className="text-slate-500 dark:text-slate-400">создаётся «{chain.join(' / ')}» в «{departmentLabel(departments, g.match.status === 'create' ? g.match.parentId : rootId) || 'Компания'}»</span>
                  : <DepartmentPicker value={r.parentId} onChange={(v) => set(g.key, { parentId: v })} departments={departments} disabled={busy} ariaLabel={`Где создать «${g.text}»`} />)}
                {r.action === 'skip' && <span className="text-slate-400">—</span>}
              </td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      <p className="mt-2 fx-hint">Будет разложено: {countOf(summary.people, 'сотрудник')}{summary.created ? ` · новых подразделений: до ${summary.created}` : ''}.</p>
    </>}
  </Dialog>;
}
