import React from 'react';
import { X } from 'lucide-react';

/**
 * Сохранить набор характеристик шаблоном вида.
 *
 * Владелец просил, чтобы «шаблоны вида, которые есть в оборудовании, можно
 * было выводить» в раздел «Таблица». Заводят их здесь, на живой карточке:
 * человек видит те самые характеристики, которые ему нужны, и отмечает их
 * галочками — а не вспоминает названия полей на пустом месте.
 *
 * Шаблон помнит ТОЛЬКО состав полей. Порядок и столбцы — дело разметки
 * таблицы: тот же набор автоматчику нужен в одном порядке, монтажнику в
 * другом, и хранить порядок здесь значило бы заводить второй шаблон вместо
 * того, чтобы подвинуть столбец.
 */

export interface ViewParam { group: string; key: string; unit: string }

interface Props {
  /** Роль позиции, с карточки которой сохраняют: ВЕНТИЛЯТОР, ДВИГАТЕЛЬ… */
  role: string;
  /** Все характеристики карточки */
  params: ViewParam[];
  /** Что отмечено заранее — то, что сейчас видно по профилю */
  preselected: string[];
  onClose: () => void;
  /** Сохранить; вернуть текст ошибки или пусто при успехе */
  onSubmit: (body: { name: string; scope: string; role: string; fields: ViewParam[] }) => Promise<string>;
}

const idOf = (p: ViewParam) => `${p.group}||${p.key}`;

export default function SaveViewDialog({ role, params, preselected, onClose, onSubmit }: Props) {
  const [name, setName] = React.useState('');
  const [personal, setPersonal] = React.useState(false);
  const [byRole, setByRole] = React.useState(true);
  const [picked, setPicked] = React.useState<Set<string>>(() => new Set(preselected));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  const toggle = (id: string) =>
    setPicked((cur) => { const n = new Set(cur); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const groups = React.useMemo(() => {
    const map = new Map<string, ViewParam[]>();
    for (const p of params) {
      if (!map.has(p.group)) map.set(p.group, []);
      map.get(p.group)!.push(p);
    }
    return [...map.entries()];
  }, [params]);

  const submit = async () => {
    const fields = params.filter((p) => picked.has(idOf(p)));
    if (!name.trim()) { setError('У шаблона должно быть имя'); return; }
    if (!fields.length) { setError('Отметьте хотя бы одну характеристику'); return; }
    setBusy(true);
    setError('');
    const why = await onSubmit({
      name: name.trim(),
      scope: personal ? 'PERSONAL' : 'SHARED',
      role: byRole ? role : '',
      fields,
    });
    setBusy(false);
    if (why) setError(why); else onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-label="Сохранить шаблон вида">
      <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <div className="min-w-0">
            <div className="text-sm font-bold truncate">Сохранить шаблон вида</div>
            <div className="text-2xs text-slate-500 dark:text-slate-400 truncate">
              отмеченные характеристики можно будет разложить столбцами в «Таблице»
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-150 cursor-pointer" aria-label="Закрыть">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus
            placeholder="Например: «Ведомость автоматики — двигатели»"
            className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800" />

          <div className="max-h-[42vh] overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-850">
            {groups.length === 0 && (
              <div className="px-3 py-4 text-2xs text-slate-500 dark:text-slate-400">У этой позиции нет характеристик.</div>
            )}
            {groups.map(([title, list]) => (
              <div key={title} className="px-3 py-2">
                <div className="text-2xs font-bold text-slate-400 mb-1">{title}</div>
                {list.map((p) => (
                  <label key={idOf(p)} className="flex items-center gap-2 py-0.5 text-xs cursor-pointer">
                    <input type="checkbox" checked={picked.has(idOf(p))} onChange={() => toggle(idOf(p))}
                      className="w-3.5 h-3.5 accent-emerald-500 cursor-pointer" />
                    <span className="flex-1 min-w-0 truncate text-slate-600 dark:text-slate-300">{p.key}</span>
                    {p.unit && <span className="text-2xs text-slate-400 shrink-0">{p.unit}</span>}
                  </label>
                ))}
              </div>
            ))}
          </div>

          <label className="flex items-center gap-2 text-2xs text-slate-600 dark:text-slate-400 cursor-pointer">
            <input type="checkbox" checked={byRole} onChange={() => setByRole((v) => !v)} className="w-3.5 h-3.5 accent-emerald-500 cursor-pointer" />
            Только для роли «{role.toLowerCase()}»
          </label>
          <label className="flex items-center gap-2 text-2xs text-slate-600 dark:text-slate-400 cursor-pointer">
            <input type="checkbox" checked={personal} onChange={() => setPersonal((v) => !v)} className="w-3.5 h-3.5 accent-emerald-500 cursor-pointer" />
            Личный — виден только мне
          </label>

          {error && <div className="text-2xs text-rose-600 dark:text-rose-400">{error}</div>}
        </div>

        <div className="px-4 py-3 border-t border-slate-100 dark:border-slate-800 flex items-center gap-2">
          <span className="text-2xs text-slate-400">отмечено: {picked.size}</span>
          <span className="flex-1" />
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 cursor-pointer">Отмена</button>
          <button type="button" onClick={submit} disabled={busy}
            className="px-3 py-1.5 text-xs rounded-lg bg-emerald-600 text-white font-semibold disabled:opacity-50 cursor-pointer">
            {busy ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
}
