import React from 'react';
import { HelpCircle } from 'lucide-react';
import { ROLES } from '../../../equipment/roles';

/**
 * Узлы выгрузки, которых программа не знает.
 *
 * Разбор всегда собирал их отдельным списком, а до окна список не доходил:
 * предпросмотр молчал, и позиция нового вида тихо не приезжала в реестр —
 * замечали это на объекте. Теперь вид виден строкой, и человек сразу
 * относит его к роли или помечает «не позиция». Ответ хранится для всей
 * компании: следующий ввоз того же вида уже не спросит.
 */

const SKIP = 'НЕ_ПОЗИЦИЯ';

export default function UnknownKinds({ kinds, onSaved }: { kinds: string[]; onSaved: () => void }) {
  const [busy, setBusy] = React.useState('');
  const [failure, setFailure] = React.useState('');

  const save = async (kind: string, role: string) => {
    if (!role) return;
    setBusy(kind);
    setFailure('');
    try {
      const r = await fetch('/api/equipment/veza-kinds', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, role }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) setFailure(String(d?.error || 'Не удалось сохранить'));
      else onSaved();
    } catch (_) {
      setFailure('Сервер не ответил');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="px-5 py-2 border-b border-slate-200 dark:border-slate-800 bg-amber-50/60 dark:bg-amber-950/20 text-xs shrink-0">
      <div className="flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-400">
        <HelpCircle className="w-3.5 h-3.5 shrink-0" />
        В файле есть узлы, которых программа не знает — они не приедут, пока их не отнести к роли
      </div>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {kinds.map((kind) => (
          <label key={kind} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-amber-200 dark:border-amber-900/50">
            <span className="font-mono text-slate-700 dark:text-slate-150">{kind}</span>
            <select
              defaultValue=""
              disabled={busy === kind}
              onChange={(e) => void save(kind, e.target.value)}
              className="bg-transparent text-xs text-slate-600 dark:text-slate-300 focus:outline-none cursor-pointer"
              aria-label={`Роль для ${kind}`}
            >
              <option value="" disabled>считать…</option>
              {ROLES.filter((r) => r.id !== 'БЛОК').map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
              <option value={SKIP}>не позиция (материал, крепёж)</option>
            </select>
          </label>
        ))}
      </div>
      {failure && <div className="mt-1 text-rose-600 dark:text-rose-400">{failure}</div>}
    </div>
  );
}
