import React, { useEffect, useMemo, useState } from 'react';
import { Archive, ArchiveRestore, Pencil, Plus, Wand2 } from 'lucide-react';
import { Btn, Empty, FilterSeg, SettingRow, Toolbar } from '../ui';
import DepartmentTree from './DepartmentTree';
import { ArchiveDialog, DepartmentFormDialog } from './DepartmentDialogs';
import { KIND_LABEL, departmentLabel, subtreeIds } from '../../../shared/departments';
import { departmentService, DepartmentApiError } from '../../services/departmentService';
import { useDepartmentStore } from '../../store/departmentStore';
import { useToastStore } from '../../store/toastStore';
import type { User } from '../../services/dataService';
import { countOf } from '../../lib/plural';

/**
 * Вкладка «Подразделения»: слева дерево (город → отдел → группа) с числом людей,
 * справа выбранное — название, город, пояс и люди. Создать — внутри выбранного,
 * перенести — перетаскиванием, архив — с переводом людей. Правят только те, у кого
 * право «Управление сотрудниками»; остальные видят дерево.
 */
function localTime(zone?: string | null): string {
  if (!zone) return '';
  try { return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: zone }).format(new Date()); }
  catch { return ''; }
}

export default function DepartmentsTab({ users, canManage, onAssign, onWizard, onBatch }: {
  users: User[]; canManage: boolean;
  onAssign: (userIds: string[], targetId: string) => void;
  onWizard: () => void;
  onBatch: (message: string, undoToken: string | null) => void;
}) {
  const { departments, rootId, unassigned, loaded, error } = useDepartmentStore();
  const addToast = useToastStore((s) => s.addToast);
  const [selectedId, setSelectedId] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [scope, setScope] = useState<'own' | 'all'>('all');
  const [form, setForm] = useState<{ mode: 'create' | 'edit' } | null>(null);
  const [archiving, setArchiving] = useState(false);

  useEffect(() => { void useDepartmentStore.getState().load(); }, []);

  const visible = useMemo(() => showArchived ? departments : departments.filter((d) => !d.archivedAt), [departments, showArchived]);
  // Выбор переживает перезагрузку дерева; пропавшее (ушло в архив) заменяется корнем
  const selected = departments.find((d) => d.id === selectedId && (showArchived || !d.archivedAt)) || departments.find((d) => d.id === rootId);
  const archivedCount = departments.filter((d) => d.archivedAt).length;

  const people = useMemo(() => {
    if (!selected) return [];
    const ids = scope === 'all' ? subtreeIds(departments, selected.id) : new Set([selected.id]);
    return users.filter((u) => u.departmentId && ids.has(u.departmentId))
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'));
  }, [users, departments, selected, scope]);

  const fail = (e: any) => addToast(e instanceof DepartmentApiError || e?.message ? e.message : 'Операция не выполнена', 'error');

  const drop = async (sourceId: string, targetId: string) => {
    try { await departmentService.move(sourceId, targetId); await useDepartmentStore.getState().load(); addToast('Подразделение перенесено', 'success'); }
    catch (e) { fail(e); }
  };
  const restore = async () => {
    if (!selected) return;
    try { await departmentService.restore(selected.id); await useDepartmentStore.getState().load(); addToast(`«${selected.name}» возвращено из архива`, 'success'); }
    catch (e) { fail(e); }
  };

  if (!loaded) return <div className="fx-page-body"><Empty title="Загрузка…" /></div>;
  if (error && !departments.length) return <div className="fx-page-body"><Empty title="Подразделения недоступны" text={error}><Btn className="mt-3" onClick={() => void useDepartmentStore.getState().load()}>Повторить</Btn></Empty></div>;

  // Город и пояс у отдела обычно не заданы: действует то, что задано у ближайшего родителя
  const inherit = (field: 'city' | 'timezone') => {
    for (let cur = selected, guard = 0; cur && guard < 20; cur = departments.find((d) => d.id === cur!.parentId), guard++) {
      if (cur[field]) return { value: cur[field] as string, from: cur.id === selected?.id ? '' : cur.name };
    }
    return { value: '', from: '' };
  };
  const cityInfo = inherit('city');
  const zoneInfo = inherit('timezone');
  const zone = zoneInfo.value;
  const isRoot = selected?.kind === 'company';
  return <>
    <Toolbar>
      {canManage && <>
        <Btn tone="primary" size="sm" onClick={() => setForm({ mode: 'create' })} disabled={!selected || !!selected.archivedAt} title="Создать подразделение внутри выбранного"><Plus />Создать</Btn>
        <Btn tone="ghost" size="sm" onClick={() => setForm({ mode: 'edit' })} disabled={!selected || !!selected.archivedAt} title="Название, город, часовой пояс"><Pencil />Изменить</Btn>
        {selected?.archivedAt
          ? <Btn tone="ghost" size="sm" onClick={() => void restore()} title="Вернуть из архива"><ArchiveRestore />Вернуть</Btn>
          : <Btn tone="ghost" size="sm" onClick={() => setArchiving(true)} disabled={!selected || isRoot} title="Отправить в архив с переводом людей"><Archive />В архив</Btn>}
      </>}
      <span className="ml-auto" />
      {archivedCount > 0 && <FilterSeg label="Архив" value={showArchived ? 'all' : 'live'} onChange={(v) => setShowArchived(v === 'all')} options={[{ value: 'live', label: 'Действующие' }, { value: 'all', label: 'С архивными', count: archivedCount }]} />}
      {canManage && <Btn size="sm" onClick={onWizard} title="Разложить по справочнику старые тексты «Подразделение»"><Wand2 />Разложить сотрудников…</Btn>}
    </Toolbar>
    <div className="fx-page-body !p-0 grid min-h-0 grid-cols-1 @[720px]:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="fx-side min-h-0 overflow-auto border-b p-2 @[720px]:border-b-0" aria-label="Дерево подразделений">
        <DepartmentTree departments={visible} selectedId={selected?.id ?? null} onSelect={setSelectedId} label="Подразделения"
          onDrop={canManage ? (s, t) => void drop(s, t) : undefined} />
        {unassigned > 0 && <p className="fx-hint mt-3 px-2">Без подразделения: {countOf(unassigned, 'сотрудник')}. Их можно перевести во вкладке «Список» или мастером «Разложить сотрудников…».</p>}
      </aside>
      <main className="min-h-0 min-w-0 overflow-auto p-4">
        {!selected ? <Empty title="Выберите подразделение" /> : <>
          <h2 className="m-0 flex items-center gap-2 text-[15px] font-semibold text-slate-900 dark:text-white">{selected.name}
            {selected.archivedAt && <span className="fx-badge">в архиве</span>}</h2>
          <div className="mt-2">
            <SettingRow title="Вид">{KIND_LABEL[selected.kind] || selected.kind}</SettingRow>
            {!isRoot && <SettingRow title="Где">{departmentLabel(departments, selected.parentId) || 'Компания'}</SettingRow>}
            <SettingRow title="Город">{cityInfo.value ? <span>{cityInfo.value}{cityInfo.from && <span className="ml-2 text-slate-400">от «{cityInfo.from}»</span>}</span> : <span className="text-slate-400">—</span>}</SettingRow>
            <SettingRow title="Часовой пояс">{zone ? <span className="tabular-nums">{zone}{zoneInfo.from && <span className="ml-2 text-slate-400">от «{zoneInfo.from}»</span>}{localTime(zone) && <span className="ml-2 text-slate-400">сейчас {localTime(zone)}</span>}</span> : <span className="text-slate-400">—</span>}</SettingRow>
            <SettingRow title="Людей">{selected.people} в подразделении{selected.total !== selected.people ? ` · ${selected.total} с вложенными` : ''}</SettingRow>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <div className="fx-group-title !m-0">Люди</div>
            {selected.total !== selected.people && <FilterSeg label="Состав" value={scope} onChange={setScope} options={[{ value: 'own', label: 'Только здесь' }, { value: 'all', label: 'С вложенными' }]} />}
          </div>
          {people.length === 0
            ? <Empty title="Здесь пока никого" text="Людей переводят во вкладке «Список»: отметьте строки и нажмите «Перевести в подразделение…»." />
            : <table className="fx-table mt-2">
                <thead><tr><th>Сотрудник</th><th className="hidden @[560px]:table-cell">Логин</th>{scope === 'all' && <th>Подразделение</th>}<th className="w-24" /></tr></thead>
                <tbody>{people.map((u) => <tr key={u.id}>
                  <td className="truncate" title={u.name}>{u.name}</td>
                  <td className="code hidden text-xs text-slate-400 @[560px]:table-cell">{u.symbol}</td>
                  {scope === 'all' && <td className="text-slate-500 dark:text-slate-400">{departmentLabel(departments, u.departmentId)}</td>}
                  <td><div className="fx-row-acts">{canManage && <Btn tone="ghost" size="sm" onClick={() => onAssign([u.id], '')}>Перевести…</Btn>}</div></td>
                </tr>)}</tbody>
              </table>}
        </>}
      </main>
    </div>
    {form && selected && <DepartmentFormDialog mode={form.mode} dept={form.mode === 'edit' ? selected : undefined} parent={form.mode === 'create' ? selected : undefined}
      departments={departments} onClose={() => setForm(null)} onDone={(id) => { setForm(null); setSelectedId(id); }} />}
    {archiving && selected && <ArchiveDialog dept={selected} departments={departments} onClose={() => setArchiving(false)}
      onDone={(message, token) => { setArchiving(false); setSelectedId(selected.parentId || rootId); onBatch(message, token); }} />}
  </>;
}
