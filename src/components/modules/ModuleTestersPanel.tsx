import React, { useCallback, useEffect, useState } from 'react';
import { Btn, Toolbar } from '../ui';
import { moduleReleaseService } from '../../services/moduleReleaseService';

/**
 * Кому виден тестовый канал: выпуск сначала получают назначенные люди, затем
 * владелец выпускает в рабочий канал для всех (решение владельца).
 */
export default function ModuleTestersPanel() {
  const [users, setUsers] = useState<Array<{ id: string; name: string; role: string }>>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<string>('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const load = useCallback(() => {
    moduleReleaseService.testers().then((r) => { setUsers(r.users); setChosen(new Set(r.testers)); setSaved([...r.testers].sort().join()); })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  const dirty = [...chosen].sort().join() !== saved;
  const save = async () => {
    setError('');
    try { const r = await moduleReleaseService.saveTesters([...chosen]); setSaved([...r.testers].sort().join()); }
    catch (e: any) { setError(e.message); }
  };
  return <>
    <Toolbar>
      <span className="font-semibold">Тестовый канал</span><span className="fx-n">{chosen.size}</span>
      <span className="flex-1" />
      <Btn size="sm" tone="ghost" onClick={() => setOpen(!open)}>{open ? 'Свернуть' : 'Назначить тестировщиков'}</Btn>
      {dirty && <Btn size="sm" tone="primary" onClick={() => void save()}>Сохранить</Btn>}
    </Toolbar>
    {error && <div className="fx-error px-3 py-2">{error}</div>}
    {open && <div className="grid gap-1 px-3 py-2 sm:grid-cols-2 lg:grid-cols-3" data-testid="module-testers">
      {users.map((u) => <label key={u.id} className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={chosen.has(u.id)} onChange={(e) => {
          const next = new Set(chosen);
          if (e.target.checked) next.add(u.id); else next.delete(u.id);
          setChosen(next);
        }} />
        <span className="truncate">{u.name}</span><span className="fx-hint truncate">{u.role}</span>
      </label>)}
    </div>}
  </>;
}
