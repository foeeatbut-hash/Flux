import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import type { Catalog } from '../../../catalog/model';
import { textOf } from '../../../catalog/model';
import type { CatalogAction, CatalogGrant } from '../../../catalog/publication';
import { catalogWorkspaceService } from '../../services/catalogWorkspaceService';

interface Props { catalog: Catalog; onSaved: () => void }
interface AccessUser { id: string; name: string; role: string }
interface GrantRow {
  key: string;
  userId: string;
  classId: string;
  manufacturerId: string;
  rights: Record<CatalogAction, boolean>;
}

const ACTIONS: Array<{ id: CatalogAction; title: string }> = [
  { id: 'edit', title: 'Правка' },
  { id: 'import', title: 'Импорт' },
  { id: 'publish', title: 'Публикация' },
];
const EMPTY_RIGHTS = (): Record<CatalogAction, boolean> => ({ edit: false, import: false, publish: false });
const grantKey = (grant: Pick<CatalogGrant, 'userId' | 'classId' | 'manufacturerId'>) =>
  `${grant.userId}\u0000${grant.classId || ''}\u0000${grant.manufacturerId || ''}`;
const control = `h-8 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-800 outline-none
  focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100`;

function groupGrants(grants: CatalogGrant[]): GrantRow[] {
  const grouped = new Map<string, GrantRow>();
  for (const grant of grants) {
    const key = grantKey(grant);
    let row = grouped.get(key);
    if (!row) {
      row = { key, userId: grant.userId, classId: grant.classId || '', manufacturerId: grant.manufacturerId || '', rights: EMPTY_RIGHTS() };
      grouped.set(key, row);
    }
    row.rights[grant.action] = true;
  }
  return [...grouped.values()];
}

function flattenRows(rows: GrantRow[]): CatalogGrant[] {
  return rows.flatMap((row) => ACTIONS.filter(({ id }) => row.rights[id]).map(({ id }) => ({
    userId: row.userId,
    action: id,
    ...(row.classId ? { classId: row.classId } : {}),
    ...(row.manufacturerId ? { manufacturerId: row.manufacturerId } : {}),
  })));
}

/** Панель правил прав. Родитель показывает её только владельцу или администратору. */
export default function CatalogAccess({ catalog, onSaved }: Props) {
  const [users, setUsers] = useState<AccessUser[]>([]);
  const [rows, setRows] = useState<GrantRow[]>([]);
  const [savedRows, setSavedRows] = useState<GrantRow[]>([]);
  const [version, setVersion] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    setLoading(true);
    setFailure('');
    try {
      const result = await catalogWorkspaceService.access();
      const nextRows = groupGrants(result.grants || []);
      setUsers(result.users || []);
      setRows(nextRows);
      setSavedRows(nextRows);
      setVersion(result.version || '');
    } catch (error: any) {
      setFailure(error?.message || 'Не удалось загрузить права каталога');
    } finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, []);

  const usersById = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);
  const dirty = JSON.stringify(rows) !== JSON.stringify(savedRows);
  const updateRow = (key: string, update: (row: GrantRow) => GrantRow) => {
    setRows((current) => current.map((row) => row.key === key ? update(row) : row));
    setNotice('');
  };

  const addRow = () => {
    const userId = users[0]?.id || '';
    if (!userId) { setFailure('Нет активных сотрудников, которым можно выдать права'); return; }
    const row: GrantRow = {
      key: `${userId}\u0000\u0000\u0000new-${Date.now()}`,
      userId, classId: '', manufacturerId: '', rights: EMPTY_RIGHTS(),
    };
    setRows((current) => [...current, row]);
    setFailure(''); setNotice('');
  };

  const removeRow = (key: string) => {
    setRows((current) => current.filter((row) => row.key !== key));
    setNotice('');
  };

  const save = async () => {
    const incomplete = rows.find((row) => !row.userId);
    if (incomplete) { setFailure('Выберите сотрудника для каждого правила'); return; }
    setSaving(true); setFailure(''); setNotice('');
    try {
      const grants = flattenRows(rows);
      const response = await catalogWorkspaceService.setAccess(grants, version);
      if (response.version) setVersion(response.version);
      else {
        const latest = await catalogWorkspaceService.access();
        setVersion(latest.version || '');
      }
      const fresh = groupGrants(grants);
      setRows(fresh); setSavedRows(fresh); setNotice('Права каталога сохранены');
      onSaved();
    } catch (error: any) {
      setFailure(error?.message || 'Не удалось сохранить права каталога');
    } finally { setSaving(false); }
  };

  return (
    <section className="min-w-0 space-y-3" aria-label="Права каталога">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Права каталога</h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Выдавайте действия сотруднику для всего каталога, выбранного вида или изготовителя.
          </p>
        </div>
        <button type="button" onClick={addRow} disabled={loading || saving || users.length === 0}
          className="fx-btn fx-btn-sm inline-flex items-center gap-1.5">
          <Plus className="h-3.5 w-3.5" /> Добавить правило
        </button>
        <button type="button" onClick={() => void save()} disabled={loading || saving || !dirty}
          className="fx-btn fx-btn-sm fx-btn-primary inline-flex items-center gap-1.5">
          <Save className="h-3.5 w-3.5" />{saving ? 'Сохраняем…' : 'Сохранить'}
        </button>
      </div>

      {failure && <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">{failure}</p>}
      {notice && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">{notice}</p>}
      {loading ? (
        <p role="status" className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">Загружаем права…</p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">Выданных прав пока нет.</p>
      ) : (
        <div className="max-w-full overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
          <table className="w-full min-w-[860px] border-collapse text-left text-xs">
            <thead className="bg-slate-50 text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2 font-medium">Сотрудник</th>
                <th className="px-2 py-2 font-medium">Вид оборудования</th>
                <th className="px-2 py-2 font-medium">Изготовитель</th>
                {ACTIONS.map((action) => <th key={action.id} className="w-20 px-2 py-2 text-center font-medium">{action.title}</th>)}
                <th className="w-10 px-2 py-2" aria-label="Удалить" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const knownUser = usersById.get(row.userId);
                return (
                  <tr key={row.key} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="min-w-56 px-3 py-2">
                      <select aria-label="Сотрудник" value={row.userId} disabled={saving} className={`${control} w-full`}
                        onChange={(event) => updateRow(row.key, (current) => ({ ...current, userId: event.target.value }))}>
                        {!knownUser && row.userId && <option value={row.userId}>Сотрудник недоступен ({row.userId})</option>}
                        {users.map((user) => <option key={user.id} value={user.id}>{user.name} · {user.role}</option>)}
                      </select>
                    </td>
                    <td className="min-w-48 px-2 py-2">
                      <select aria-label="Вид оборудования" value={row.classId} disabled={saving} className={`${control} w-full`}
                        onChange={(event) => updateRow(row.key, (current) => ({ ...current, classId: event.target.value }))}>
                        <option value="">Все виды</option>
                        {catalog.classes.map((item) => <option key={item.id} value={item.id}>{textOf(item.title)}</option>)}
                      </select>
                    </td>
                    <td className="min-w-48 px-2 py-2">
                      <select aria-label="Изготовитель" value={row.manufacturerId} disabled={saving} className={`${control} w-full`}
                        onChange={(event) => updateRow(row.key, (current) => ({ ...current, manufacturerId: event.target.value }))}>
                        <option value="">Все изготовители</option>
                        {catalog.manufacturers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                      </select>
                    </td>
                    {ACTIONS.map(({ id, title }) => (
                      <td key={id} className="px-2 py-2 text-center">
                        <input type="checkbox" aria-label={`${title}: ${knownUser?.name || 'сотрудник'}`}
                          checked={row.rights[id]} disabled={saving}
                          onChange={(event) => updateRow(row.key, (current) => ({
                            ...current, rights: { ...current.rights, [id]: event.target.checked },
                          }))}
                          className="h-4 w-4 accent-emerald-600 dark:accent-emerald-400" />
                      </td>
                    ))}
                    <td className="px-2 py-2 text-center">
                      <button type="button" onClick={() => removeRow(row.key)} disabled={saving}
                        aria-label="Удалить правило" title="Удалить правило"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-rose-600 disabled:opacity-50 dark:hover:bg-slate-800 dark:hover:text-rose-400">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
