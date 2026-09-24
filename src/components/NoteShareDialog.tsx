import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Search, Eye, Pencil, Users2, Loader2, Check } from 'lucide-react';
import { dataService, User, UserNote } from '../services/dataService';
import { ENV_CONFIG, getAuthToken } from '../config/env';
import { useToastStore } from '../store/toastStore';
import { initials } from '../lib/declension';
import { useEscapeClose } from '../lib/useDismiss';

/**
 * «Поделиться заметкой»: выбрать коллег и уровень доступа.
 *
 * Блокнот личный, поэтому доступ открывается осознанно и по одному
 * человеку, а не «всем сразу». У каждого выбранного видно, что ему можно:
 * читать или править. Себя в списке нет — с собой делиться незачем.
 */
export default function NoteShareDialog({ note, onClose, onSaved }: {
  note: UserNote;
  onClose: () => void;
  onSaved?: () => void;
}) {
  useEscapeClose(true, onClose);
  const { addToast } = useToastStore();
  const [people, setPeople] = useState<User[]>([]);
  const [shares, setShares] = useState<Record<string, boolean>>({});   // userId → canEdit
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const authHeaders = (): Record<string, string> => {
    const t = getAuthToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [users, res] = await Promise.all([
          dataService.getUsers(),
          fetch(`${ENV_CONFIG.apiUrl}/notes/${note.id}/shares`, { headers: authHeaders() }),
        ]);
        if (!alive) return;
        setPeople(users || []);
        const data = await res.json().catch(() => ({ shares: [] }));
        const map: Record<string, boolean> = {};
        for (const s of (data.shares || [])) map[s.userId] = !!s.canEdit;
        setShares(map);
      } catch (_) {
        if (alive) addToast('Не удалось загрузить список сотрудников', 'error');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [note.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const myId = (() => {
    try { return JSON.parse(localStorage.getItem('pdm_session_user') || '{}').id || ''; } catch { return ''; }
  })();

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return people
      .filter((p) => p.id !== myId && p.isActive !== false)
      .filter((p) => !q || (p.name || '').toLowerCase().includes(q) || (p.symbol || '').toLowerCase().includes(q))
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'));
  }, [people, query, myId]);

  const toggle = (id: string) => {
    setShares((prev) => {
      const next = { ...prev };
      if (id in next) delete next[id];
      else next[id] = false;         // по умолчанию — только чтение
      return next;
    });
  };

  const save = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${ENV_CONFIG.apiUrl}/notes/${note.id}/shares`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ shares: Object.entries(shares).map(([userId, canEdit]) => ({ userId, canEdit })) }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Не удалось сохранить');
      const n = Object.keys(shares).length;
      addToast(n ? `Заметка открыта: ${n} сотрудник(ам)` : 'Доступ закрыт для всех', 'success');
      onSaved?.();
      onClose();
    } catch (e: any) {
      addToast(e.message, 'error');
    } finally { setBusy(false); }
  };

  const nameOf = (p: User) => {
    const parts = { lastName: (p as any).lastName, firstName: (p as any).firstName, middleName: (p as any).middleName };
    return parts.lastName ? initials(parts) : (p.name || p.symbol);
  };

  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
      <div className="absolute inset-0 fx-backdrop" onClick={onClose} />
      <div className="fx-dialog relative w-full max-w-md overflow-hidden flex flex-col max-h-[80vh]">
        <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-slate-900 dark:text-white flex items-center gap-2">
              <Users2 className="w-4.5 h-4.5 text-emerald-600" /> Поделиться заметкой
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">
              «{note.title || 'Без названия'}»
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Закрыть"
            className="p-1 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer">
            <X className="w-4.5 h-4.5" />
          </button>
        </div>

        <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-800">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
            <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus
              placeholder="Найти сотрудника"
              className="w-full pl-9 pr-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-slate-400 text-xs">
              <Loader2 className="w-4 h-4 animate-spin" /> Загружаю сотрудников…
            </div>
          ) : visible.length === 0 ? (
            <p className="text-center text-xs text-slate-400 py-10">
              {people.length <= 1 ? 'В программе пока только вы' : 'Никого не нашлось по запросу'}
            </p>
          ) : visible.map((p) => {
            const on = p.id in shares;
            const canEdit = shares[p.id];
            return (
              <div key={p.id}
                className={`flex items-center gap-2 p-2 rounded-xl border transition-ui ${
                  on ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/20'
                     : 'border-slate-200 dark:border-slate-800'}`}>
                <button type="button" onClick={() => toggle(p.id)}
                  className="flex items-center gap-2.5 flex-1 min-w-0 text-left cursor-pointer">
                  <span className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center ${
                    on ? 'bg-emerald-600 border-emerald-600 text-white' : 'border-slate-300 dark:border-slate-700'}`}>
                    {on && <Check className="w-3 h-3" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{nameOf(p)}</span>
                    <span className="block text-2xs font-mono text-slate-400 truncate">{p.symbol}</span>
                  </span>
                </button>
                {on && (
                  <div className="flex items-center gap-0.5 shrink-0">
                    {([[false, 'Чтение', Eye], [true, 'Правка', Pencil]] as const).map(([val, label, Icon]) => (
                      <button key={String(val)} type="button"
                        onClick={() => setShares((prev) => ({ ...prev, [p.id]: val }))}
                        title={val ? 'Может править заметку' : 'Может только читать'}
                        className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-2xs font-semibold cursor-pointer transition-ui ${
                          canEdit === val
                            ? 'bg-emerald-600 text-white'
                            : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-200'}`}>
                        <Icon className="w-3 h-3" /> {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="px-5 py-3 border-t border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 flex items-center justify-between gap-3">
          <span className="text-2xs text-slate-500 dark:text-slate-400">
            {Object.keys(shares).length === 0
              ? 'Заметку видите только вы'
              : `Открыта: ${Object.keys(shares).length} · на правку: ${Object.values(shares).filter(Boolean).length}`}
          </span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose}
              className="px-3.5 py-2 rounded-lg text-sm font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">
              Отмена
            </button>
            <button type="button" onClick={save} disabled={busy}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold cursor-pointer disabled:opacity-60">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Сохранить
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
