/**
 * Кто работает над проектом.
 *
 * Показывается сразу после создания проекта — тем же шагом, каким его и
 * заводят: проект без ответа на вопрос «кто в деле» становится общим, и
 * ограничение, ради которого всё затевалось, не включается никогда.
 *
 * Пустой состав — не ошибка, а состояние: пока в проект никого не позвали, он
 * виден всем. Об этом сказано прямо, а не оставлено человеку на догадки.
 */
import React from 'react';
import { Check, Search } from 'lucide-react';
import { Dialog, Btn, Input } from './ui';
import { ENV_CONFIG, getAuthToken } from '../config/env';
import { useToastStore } from '../store/toastStore';
import { useStore } from '../store/store';

interface Person { id: string; name: string; symbol: string }

const headers = (): Record<string, string> => {
  const t = getAuthToken();
  return { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) };
};

export default function ProjectMembers({ projectId, projectName, onClose }: {
  projectId: string;
  projectName: string;
  onClose: () => void;
}) {
  const me = useStore((s) => s.user);
  const { addToast } = useToastStore();
  const [people, setPeople] = React.useState<Person[]>([]);
  const [chosen, setChosen] = React.useState<Set<string>>(new Set());
  const [open, setOpen] = React.useState(true);
  const [q, setQ] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [uRes, mRes] = await Promise.all([
          fetch(`${ENV_CONFIG.apiUrl}/users`, { headers: headers() }),
          fetch(`${ENV_CONFIG.apiUrl}/projects/${projectId}/members`, { headers: headers() }),
        ]);
        const uJson = uRes.ok ? await uRes.json() : [];
        const mJson = mRes.ok ? await mRes.json() : { items: [], open: true };
        if (!alive) return;
        const rows = Array.isArray(uJson) ? uJson : uJson?.users || [];
        setPeople(rows.map((u: any) => ({ id: u.id, name: u.name, symbol: u.symbol })));
        setChosen(new Set((mJson.items || []).map((m: any) => m.userId)));
        setOpen(!!mJson.open);
      } catch (_) { /* список людей не пришёл — состав всё равно можно закрыть */ }
    })();
    return () => { alive = false; };
  }, [projectId]);

  const flip = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id); else next.add(id);
    setChosen(next);
  };

  const save = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${ENV_CONFIG.apiUrl}/projects/${projectId}/members`, {
        method: 'POST', headers: headers(), body: JSON.stringify({ userIds: Array.from(chosen) }),
      });
      if (!res.ok) throw new Error('не сохранилось');
      addToast(chosen.size
        ? `В проекте ${chosen.size} человек — остальные его не увидят`
        : 'Состав пуст: проект видят все', 'success');
      onClose();
    } catch (_) {
      addToast('Не удалось сохранить состав', 'error');
    } finally { setBusy(false); }
  };

  const shown = people.filter((p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <Dialog title={`Кто работает над «${projectName}»`} label="Кто работает над проектом" onClose={onClose} busy={busy}
      footer={<>
        <span className="mr-auto self-center text-xs text-slate-500 dark:text-slate-400">Выбрано: {chosen.size}</span>
        <Btn size="lg" onClick={onClose}>Потом</Btn>
        <Btn size="lg" tone="primary" onClick={save} disabled={busy}>Готово</Btn>
      </>}>
      <label className="relative block mb-2">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Найти сотрудника" aria-label="Найти сотрудника" className="pl-7" />
      </label>
      <div className="max-h-[50vh] overflow-y-auto -mx-2">
        {shown.map((p) => {
          const on = chosen.has(p.id);
          return (
            <button key={p.id} type="button" role="checkbox" aria-checked={on} onClick={() => flip(p.id)} className="fx-li">
              <span className={`w-4 h-4 rounded shrink-0 flex items-center justify-center border ${on ? 'bg-emerald-600 border-emerald-600' : 'border-slate-300 dark:border-slate-700'}`}>
                {on && <Check className="w-3 h-3 text-white" />}
              </span>
              <span className="truncate">{p.name}{p.id === me?.id ? ' — вы' : ''}</span>
              <span className="fx-n code">{p.symbol}</span>
            </button>
          );
        })}
        {shown.length === 0 && <p className="px-2 py-3 text-xs text-slate-400">Никого не нашлось.</p>}
      </div>
      <p className="fx-hint mt-2">
        {chosen.size === 0
          ? (open
            ? 'Пока в проект никого не позвали, его видят все. Как только появится первый участник, остальные перестанут видеть и проект, и его файлы.'
            : 'Состав пуст — проект снова станет виден всем.')
          : 'Кто не в списке — не увидит ни проекта, ни его файлов, ни тегов, ни писем. Администратор видит всё.'}
      </p>
    </Dialog>
  );
}
