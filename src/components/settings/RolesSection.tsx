import { useState, useEffect } from 'react';
import SectionShell from './SectionShell';
import { ENV_CONFIG } from '../../config/env';
import { Plus, Trash2, Loader2, Check, X, Lock, Pencil } from 'lucide-react';
import RoleIcon from '../RoleIcon';
import {
  Role, ROLE_COLORS, ROLE_ICONS, roleColorClass, loadRoles, invalidateRoles, isTopAdmin,
} from '../../lib/roles';
import {
  FEATURES, FEATURE_GROUPS, PermMap, parsePermissions, entryOf, offEntry,
} from '../../lib/permissions';
import { getAuthToken } from '../../config/env';
import { IconBtn } from '../ui';

// ── Роли сотрудников ───────────────────────────────────────────────────────────
// Роли перестали быть четырьмя строками в коде: их заводит главный
// администратор (уровень 1), и они видны везде, где показан сотрудник.
// Остальные роли доступ не раздают — иначе право можно было бы выписать себе,
// придумав новую роль.
export default function RolesSection({ user, addToast }: { user: any; addToast: (m: string, t?: any) => void }) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Role | null>(null);
  const [draft, setDraft] = useState<Partial<Role> | null>(null);
  const [busy, setBusy] = useState(false);
  const top = isTopAdmin(user, roles);

  const reload = async (force = true) => {
    setLoading(true);
    const list = await loadRoles(force);
    setRoles(list);
    setLoading(false);
  };
  useEffect(() => { reload(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const api = async (path: string, method: string, body?: any) => {
    const token = getAuthToken();
    const res = await fetch(`${ENV_CONFIG.apiUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Не удалось выполнить действие');
    return data;
  };

  const startNew = () => {
    setEditing(null);
    setDraft({ name: '', code: '', description: '', color: 'sky', icon: 'user', level: 50 });
  };

  const save = async () => {
    if (!draft) return;
    const name = String(draft.name || '').trim();
    if (!name) { addToast('Укажите название роли', 'error'); return; }
    setBusy(true);
    try {
      if (editing) await api(`/roles/${editing.id}`, 'PUT', draft);
      else await api('/roles', 'POST', draft);
      invalidateRoles();
      await reload();
      setDraft(null); setEditing(null);
      addToast(editing ? 'Роль обновлена' : `Роль «${name}» создана`, 'success');
    } catch (e: any) {
      addToast(e.message, 'error');
    } finally { setBusy(false); }
  };

  const remove = async (r: Role) => {
    setBusy(true);
    try {
      await api(`/roles/${r.id}`, 'DELETE');
      invalidateRoles();
      await reload();
      addToast(`Роль «${r.name}» удалена`, 'success');
    } catch (e: any) {
      addToast(e.message, 'error');
    } finally { setBusy(false); }
  };

  return (
    <SectionShell title="Роли сотрудников" desc="Кем работают люди в программе.">
      {!top && (
        <div className="mb-4 flex items-start gap-2 fx-note fx-note-warn">
          <Lock className="w-4 h-4 shrink-0 mt-0.5" />
          <span>Роли создаёт и меняет только главный администратор (уровень 1). Здесь вы видите текущий список.</span>
        </div>
      )}

      <div>
        {loading && <div className="text-xs text-slate-400 py-2">Загружаю роли…</div>}
        {roles.map((r) => (
          <div key={r.id} className="fx-set-row group">
            {/* Цвет роли — у значка, название обычным текстом */}
            <RoleIcon name={r.icon} className={`w-4 h-4 shrink-0 ${roleColorClass(r.color).split(/\s+/).filter((c) => /^(dark:)?text-/.test(c)).join(' ')}`} />
            <div className="fx-set-text">
              {r.name}
              <div className="fx-set-desc">
                {r.description || 'Без описания'} · <span className="code">{r.code}</span> · уровень {r.level}
                {r.level > 1 && ` · прав: ${Object.values(parsePermissions(r.permissions as any)).filter((e: any) => e?.enabled).length}`}
                {r.level <= 1 && ' — главный администратор'}
                {r.isSystem && ' · встроенная'}
              </div>
            </div>
            {top && (
              <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                <IconBtn label="Изменить роль" disabled={busy} onClick={() => { setEditing(r); setDraft({ ...r }); }}><Pencil /></IconBtn>
                <IconBtn label={r.isSystem ? 'Встроенную роль удалить нельзя' : 'Удалить роль'} disabled={busy || r.isSystem} onClick={() => remove(r)} className="hover:text-rose-600"><Trash2 /></IconBtn>
              </div>
            )}
          </div>
        ))}
      </div>

      {top && !draft && (
        <button type="button" onClick={startNew}
          className="fx-btn fx-btn-primary mt-4 inline-flex">
          <Plus className="w-4 h-4" /> Добавить роль
        </button>
      )}

      {top && draft && (
        <div className="mt-4 fx-set-group space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
              {editing ? `Роль «${editing.name}»` : 'Новая роль'}
            </h3>
            <button type="button" onClick={() => { setDraft(null); setEditing(null); }}
              className="p-1 rounded-lg hover:bg-white/60 dark:hover:bg-slate-900 text-slate-400 cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 @[640px]:grid-cols-2 gap-3">
            <div>
              <label className="block text-2xs font-semibold text-slate-500 mb-1">Название</label>
              <input type="text" value={draft.name || ''} autoFocus
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Инженер-конструктор"
                className="fx-input" />
            </div>
            <div>
              <label className="block text-2xs font-semibold text-slate-500 mb-1">Код</label>
              <input type="text" value={draft.code || ''} disabled={!!editing}
                onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })}
                placeholder="ENGINEER_CAD"
                className="fx-input code" />
              <p className="text-2xs text-slate-400 mt-1">Латиницей. Пусто — программа придумает сама. Потом не меняется.</p>
            </div>
          </div>

          <div>
            <label className="block text-2xs font-semibold text-slate-500 mb-1">Описание</label>
            <input type="text" value={draft.description || ''}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="Чем занимается: разделы, зона ответственности"
              className="fx-input" />
          </div>

          <div className="grid grid-cols-1 @[640px]:grid-cols-2 gap-3">
            <div>
              <label className="block text-2xs font-semibold text-slate-500 mb-1.5">Цвет значка</label>
              <div className="flex flex-wrap gap-1.5">
                {ROLE_COLORS.map((c) => (
                  <button key={c.id} type="button" title={c.label}
                    onClick={() => setDraft({ ...draft, color: c.id })}
                    className={`w-7 h-7 rounded-lg ${c.dot} transition-ui cursor-pointer ${
                      draft.color === c.id ? 'ring-2 ring-offset-2 dark:ring-offset-slate-950 ring-slate-500 scale-110' : 'opacity-70 hover:opacity-100'}`} />
                ))}
              </div>
            </div>
            <div>
              <label className="block text-2xs font-semibold text-slate-500 mb-1.5">Значок</label>
              <div className="flex flex-wrap gap-1.5">
                {ROLE_ICONS.map((ic) => (
                  <button key={ic} type="button"
                    onClick={() => setDraft({ ...draft, icon: ic })}
                    className={`w-7 h-7 rounded-lg border flex items-center justify-center transition-ui cursor-pointer ${
                      draft.icon === ic
                        ? 'bg-emerald-600 border-emerald-600 text-white'
                        : 'bg-white dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-500 hover:border-emerald-500'}`}>
                    <RoleIcon name={ic} className="w-3.5 h-3.5" />
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Права роли: что можно всем, кто на этой должности. Личные права
              сотрудника накладываются поверх и сильнее — так можно забрать
              доступ у одного человека, не трогая всю роль. */}
          <div>
            <label className="block text-2xs font-semibold text-slate-500 mb-1.5">
              Что разрешено этой роли
            </label>
            <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
              {FEATURE_GROUPS.map((g) => (
                <div key={g}>
                  <div className="text-2xs font-mono text-slate-400 mb-1">{g}</div>
                  <div className="space-y-1">
                    {FEATURES.filter((f) => f.group === g).map((f) => {
                      const perms = parsePermissions(draft.permissions as any);
                      // Открытое по умолчанию право у роли запрещается явной
                      // записью: удалённая запись вернула бы его само (offEntry)
                      const on = !!entryOf(perms, f.id)?.enabled;
                      return (
                        <button key={f.id} type="button"
                          onClick={() => {
                            const next: PermMap = { ...perms };
                            const off = offEntry(f.id);
                            if (on) { if (off) next[f.id] = off; else delete next[f.id]; }
                            else next[f.id] = { enabled: true, until: null };
                            setDraft({ ...draft, permissions: JSON.stringify(next) });
                          }}
                          className={`w-full flex items-start gap-2 p-2 rounded-lg border text-left transition-ui cursor-pointer ${
                            on
                              ? 'border-emerald-400 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30'
                              : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 hover:border-slate-300'}`}>
                          <span aria-pressed={on}>
                            {on && <Check className="w-3 h-3" />}
                          </span>
                          <span className="min-w-0">
                            <span className="block text-xs font-semibold text-slate-800 dark:text-slate-100">
                              {f.label}
                              {f.risky && <span className="ml-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">осторожно</span>}
                            </span>
                            <span className="block text-2xs text-slate-500 dark:text-slate-400 mt-0.5">{f.desc}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between pt-1">
            <span className="text-2xs text-slate-400 max-w-[22rem]">
              Так роль будет выглядеть в списке сотрудников и в подписях документов.
            </span>
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${roleColorClass(draft.color)}`}>
                <RoleIcon name={draft.icon} className="w-3.5 h-3.5" />
                {draft.name || 'Название роли'}
              </span>
              <button type="button" onClick={save} disabled={busy}
                className="fx-btn fx-btn-primary inline-flex">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                Сохранить
              </button>
            </div>
          </div>
        </div>
      )}
    </SectionShell>
  );
}
