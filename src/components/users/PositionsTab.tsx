import { useMemo, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import RoleIcon from '../RoleIcon';
import { Btn, Dialog, Empty, Field, IconBtn, Input, Switch, Toolbar } from '../ui';
import { ENV_CONFIG, getAuthToken } from '../../config/env';
import { ROLE_COLORS, ROLE_ICONS, roleColorClass, invalidateRoles, type Role } from '../../lib/roles';
import { FEATURES, FEATURE_GROUPS, entryOf, offEntry, parsePermissions, type PermMap } from '../../lib/permissions';
import { usageByPosition } from '../../lib/positions';
import { countOf } from '../../lib/plural';
import { useModalStore } from '../../store/modalStore';
import type { User } from '../../services/dataService';

const { openConfirm } = useModalStore.getState();

const tintOf = (color?: string) => roleColorClass(color).split(/\s+/).filter((c) => /^(dark:)?text-/.test(c)).join(' ');

async function api(path: string, method: string, body?: unknown) {
  const token = getAuthToken();
  const res = await fetch(`${ENV_CONFIG.apiUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'Не удалось выполнить действие');
  return data;
}

interface Props {
  /** Должности справочника без уровней доступа */
  positions: Role[];
  users: User[];
  /** Справочник изменён: список должностей перечитывается снаружи */
  onChanged: () => void | Promise<void>;
  addToast: (message: string, type?: any) => void;
}

/**
 * Справочник должностей — вкладка программы «Сотрудники».
 * Вкладку видят владелец и администратор с правом «Должности: справочник».
 * Права должности (кроме административных) действуют на всех, у кого она
 * основная, а у кого дополнительная — только добавляют; личные права
 * сотрудника накладываются поверх и сильнее. Удалить нельзя должность,
 * назначенную кому-то, хоть как дополнительную.
 */
export default function PositionsTab({ positions, users, onChanged, addToast }: Props) {
  const usage = useMemo(() => usageByPosition(users), [users]);
  const [draft, setDraft] = useState<Partial<Role> | null>(null);
  const [editing, setEditing] = useState<Role | null>(null);
  const [busy, setBusy] = useState(false);

  const startNew = () => { setEditing(null); setDraft({ name: '', code: '', description: '', color: 'sky', icon: 'user', level: 50, permissions: '{}' }); };
  const startEdit = (r: Role) => { setEditing(r); setDraft({ ...r }); };
  const close = () => { setDraft(null); setEditing(null); };

  const save = async () => {
    if (!draft) return;
    const name = String(draft.name || '').trim();
    if (!name) { addToast('Укажите название должности', 'error'); return; }
    setBusy(true);
    try {
      if (editing) await api(`/roles/${editing.id}`, 'PUT', draft);
      else await api('/roles', 'POST', draft);
      invalidateRoles();
      await onChanged();
      close();
      addToast(editing ? 'Должность обновлена' : `Должность «${name}» создана`, 'success');
    } catch (e: any) {
      addToast(e.message, 'error');
    } finally { setBusy(false); }
  };

  const remove = async (r: Role) => {
    if (!await openConfirm(`Удалить должность «${r.name}»?`, 'Она нигде не назначена. Действие необратимо.', { confirmLabel: 'Удалить', tone: 'danger' })) return;
    setBusy(true);
    try {
      await api(`/roles/${r.id}`, 'DELETE');
      invalidateRoles();
      await onChanged();
      close();
      addToast(`Должность «${r.name}» удалена`, 'success');
    } catch (e: any) {
      addToast(e.message, 'error');
    } finally { setBusy(false); }
  };

  const whyNotDeletable = (r: Role): string => {
    const u = usage.get(r.code);
    if (r.isSystem) return 'Встроенную должность удалить нельзя';
    if (u && u.primary + u.extra > 0) return 'Должность назначена сотрудникам — сначала переведите их на другую';
    return 'Удалить должность';
  };

  return (
    <>
      <Toolbar>
        <span className="text-[13px] text-slate-500 dark:text-slate-400">{countOf(positions.length, 'должность')}</span>
        <span className="ml-auto" />
        <Btn tone="primary" onClick={startNew} disabled={busy}><Plus />Добавить должность</Btn>
      </Toolbar>
      <div className="fx-page-body min-w-0 @container">
        {positions.length === 0 ? (
          <Empty title="Должностей пока нет" text="Заведите первую — её можно назначить сотруднику основной или дополнительной.">
            <Btn tone="primary" onClick={startNew} className="mt-3">Добавить должность</Btn>
          </Empty>
        ) : (
          <table className="fx-table">
            <thead>
              <tr>
                <th>Должность</th>
                <th className="hidden @[720px]:table-cell">Описание</th>
                <th className="hidden @[560px]:table-cell">Код</th>
                <th className="text-right" title="Сколько человек, для кого она основная">Основная</th>
                <th className="text-right" title="Сколько человек, для кого она дополнительная">Дополнительная</th>
                <th className="hidden @[640px]:table-cell text-right">Прав</th>
                <th className="w-24" />
              </tr>
            </thead>
            <tbody>
              {positions.map((r) => {
                const u = usage.get(r.code) || { primary: 0, extra: 0 };
                const rights = Object.values(parsePermissions(r.permissions as any)).filter((e: any) => e?.enabled).length;
                return (
                  <tr key={r.id} onDoubleClick={() => startEdit(r)} title="Двойное нажатие — открыть должность">
                    <td className="whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                        <RoleIcon name={r.icon} className={`w-3.5 h-3.5 shrink-0 ${tintOf(r.color)}`} />
                        {r.name}
                        {r.isSystem && <span className="text-xs text-slate-400">встроенная</span>}
                      </span>
                    </td>
                    <td className="hidden @[720px]:table-cell max-w-0 w-full truncate text-slate-500 dark:text-slate-400" title={r.description}>{r.description || <span className="text-slate-400">—</span>}</td>
                    <td className="hidden @[560px]:table-cell code text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">{r.code}</td>
                    <td className="text-right tabular-nums">{u.primary || <span className="text-slate-400">—</span>}</td>
                    <td className="text-right tabular-nums">{u.extra || <span className="text-slate-400">—</span>}</td>
                    <td className="hidden @[640px]:table-cell text-right tabular-nums">{rights}</td>
                    <td>
                      <div className="fx-row-acts">
                        <IconBtn label={`Изменить должность: ${r.name}`} disabled={busy} onClick={() => startEdit(r)}><Pencil /></IconBtn>
                        <IconBtn label={whyNotDeletable(r)} disabled={busy || r.isSystem || u.primary + u.extra > 0} onClick={() => remove(r)} className="hover:text-rose-600"><Trash2 /></IconBtn>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {draft && (
        <Dialog title={editing ? `Должность «${editing.name}»` : 'Новая должность'} width="max-w-lg" onClose={close} busy={busy}
          footer={<>
            {editing && !editing.isSystem && (usage.get(editing.code)?.primary || 0) + (usage.get(editing.code)?.extra || 0) === 0
              && <Btn size="lg" tone="danger" disabled={busy} onClick={() => remove(editing)} className="mr-auto">Удалить должность</Btn>}
            <Btn size="lg" disabled={busy} onClick={close}>Отмена</Btn>
            <Btn size="lg" tone="primary" disabled={busy} onClick={save}>{busy ? 'Сохранение…' : 'Сохранить'}</Btn>
          </>}>
          <div className="space-y-3">
            <Field label="Название">
              <Input value={draft.name || ''} autoFocus onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Инженер-конструктор" />
            </Field>
            <Field label="Код" hint="Латиницей. Пусто — программа придумает сама. Потом не меняется.">
              <Input value={draft.code || ''} disabled={!!editing} onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })} placeholder="ENGINEER_CAD" className="code" />
            </Field>
            <Field label="Описание">
              <Input value={draft.description || ''} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Чем занимается: разделы, зона ответственности" />
            </Field>
            <div className="fx-field">
              <span className="fx-label">Цвет значка</span>
              <div className="flex flex-wrap gap-1.5">
                {ROLE_COLORS.map((c) => (
                  <button key={c.id} type="button" title={c.label} aria-label={c.label} aria-pressed={draft.color === c.id}
                    onClick={() => setDraft({ ...draft, color: c.id })}
                    className={`w-6 h-6 rounded-full ${c.dot} cursor-pointer ${draft.color === c.id ? 'ring-2 ring-offset-2 dark:ring-offset-slate-950 ring-slate-500' : 'opacity-70 hover:opacity-100'}`} />
                ))}
              </div>
            </div>
            <div className="fx-field">
              <span className="fx-label">Значок</span>
              <div className="fx-seg">
                {ROLE_ICONS.map((ic) => (
                  <button key={ic} type="button" aria-label={ic} aria-pressed={draft.icon === ic} onClick={() => setDraft({ ...draft, icon: ic })}>
                    <RoleIcon name={ic} className="w-3.5 h-3.5" />
                  </button>
                ))}
              </div>
            </div>

            {/* Что разрешено должности: личные права сотрудника накладываются
                поверх и сильнее — так можно забрать доступ у одного человека,
                не трогая всю должность. Административных полномочий здесь нет:
                их выдаёт лично владелец. */}
            <div>
              <div className="fx-label mt-2 mb-1">Что разрешено этой должности</div>
              {FEATURE_GROUPS.map((g) => (
                <div key={g}>
                  <div className="fx-group-title mt-3">{g}</div>
                  {FEATURES.filter((f) => f.group === g).map((f) => {
                    const perms = parsePermissions(draft.permissions as any);
                    // Открытое по умолчанию право у должности запрещается явной
                    // записью: удалённая запись вернула бы его само (offEntry)
                    const on = !!entryOf(perms, f.id)?.enabled;
                    const flip = (value: boolean) => {
                      const next: PermMap = { ...perms };
                      const off = offEntry(f.id);
                      if (!value) { if (off) next[f.id] = off; else delete next[f.id]; }
                      else next[f.id] = { enabled: true, until: null };
                      setDraft({ ...draft, permissions: JSON.stringify(next) });
                    };
                    return (
                      <div key={f.id} className="fx-set-row">
                        <div className="fx-set-text">
                          <span className="inline-flex items-center gap-2">{f.label}{f.risky && <span className="text-xs text-amber-600 dark:text-amber-400">осторожно</span>}</span>
                          <div className="fx-set-desc">{f.desc}</div>
                        </div>
                        <Switch checked={on} onChange={flip} label={f.label} disabled={busy} />
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
