import React from 'react';
import { Plus, X } from 'lucide-react';
import { ROLES, roleById, roleFits, roleTitle } from '../../../equipment/roles';
import { CLASSES, classById, isClassId } from '../../../equipment/classes';
import { useTagCheck, tagHint, tagPrefixOf } from './useTagCheck';

/**
 * Завести позицию внутри существующей — руками.
 *
 * Расчёт САПР знает не всё. Датчик ПТС, поставленный на электродвигатель уже
 * на объекте, в выгрузке не появится никогда, а тег и параметры у него есть, и
 * в таблицу он попадать обязан. Здесь его и заводят: имя, роль, тег и свои
 * параметры.
 *
 * Роль не навязывается. Подсказка «обычно так не ставят» показывается заранее,
 * но кнопку не блокирует: объект бывает устроен не по учебнику, и запрещать
 * инженеру описывать то, что он видит своими глазами, программа не вправе.
 *
 * Тег проверяется на лету тем же правилом, по которому запишется: приставка
 * подставлена от тега родителя, похожие кириллические буквы исправляются, а
 * свободный тег из реестра предлагается подсказкой — привяжется он, а не
 * заведётся второй. Тип и вид ставятся сразу; не тронуты — угадываются.
 */

export interface AddPositionTarget {
  /** Позиция-владелец; пусто — позиция верхнего уровня в моноблоке */
  id?: string;
  monoblockId?: string;
  name: string;
  role?: string;
  /** Тег владельца (или установки) — от него приставка нового тега */
  parentTag?: string;
}

export interface AddPositionBody {
  name: string; role: string; tag: string; equipClass: string; equipKind: string;
  params: { key: string; value: string; unit: string }[];
}

interface Props {
  target: AddPositionTarget;
  projectId: string;
  /** Свободные теги реестра — подсказки поля тега */
  freeTags?: string[];
  onClose: () => void;
  /** Завести позицию; вернуть текст ошибки или пусто при успехе */
  onSubmit: (body: AddPositionBody) => Promise<string>;
}

interface Row { key: string; value: string; unit: string }

export default function AddPositionDialog({ target, projectId, freeTags = [], onClose, onSubmit }: Props) {
  const parentRole = target.role || 'БЛОК';
  // Что обычно ставят внутрь владельца — первым: в двигатель датчик ПТС, в
  // клапан привод. Коробка и датчик «годятся куда угодно», и без этого
  // подсказкой всегда вставала бы коробка
  const suggested = roleById(parentRole).children?.[0] || 'ДАТЧИК';

  const [name, setName] = React.useState('');
  const [role, setRole] = React.useState<string>(suggested);
  const [tag, setTag] = React.useState(() => tagPrefixOf(target.parentTag || ''));
  const [cls, setCls] = React.useState('');
  const [kind, setKind] = React.useState('');
  const check = useTagCheck(projectId, tag === tagPrefixOf(target.parentTag || '') ? '' : tag);
  const [rows, setRows] = React.useState<Row[]>([{ key: '', value: '', unit: '' }]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  const fits = roleFits(parentRole, role);

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows((cur) => cur.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  const submit = async () => {
    if (!name.trim()) { setError('У позиции должно быть название'); return; }
    setBusy(true);
    setError('');
    // Одна приставка без продолжения — не тег: человек не стал его заводить
    const typed = tag.trim() === tagPrefixOf(target.parentTag || '') ? '' : tag.trim();
    const why = await onSubmit({
      name: name.trim(),
      role,
      tag: typed,
      equipClass: cls,
      equipKind: kind.trim(),
      params: rows.filter((r) => r.key.trim()).map((r) => ({ key: r.key.trim(), value: r.value, unit: r.unit.trim() })),
    });
    setBusy(false);
    if (why) setError(why); else onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-label="Добавить позицию">
      <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <div className="min-w-0">
            <div className="text-sm font-bold truncate">Добавить позицию</div>
            <div className="text-2xs text-slate-500 dark:text-slate-400 truncate">{target.id ? 'внутрь' : 'в'} «{target.name}»</div>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-150 cursor-pointer" aria-label="Закрыть">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3 max-h-[60vh] overflow-y-auto">
          <label className="block">
            <span className="text-2xs font-semibold text-slate-500 dark:text-slate-400">Название</span>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus
              placeholder="Датчик ПТС ВЕДО-201"
              className="mt-1 w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800" />
          </label>

          <label className="block">
            <span className="text-2xs font-semibold text-slate-500 dark:text-slate-400">Роль</span>
            <select value={role} onChange={(e) => { setRole(e.target.value); if (!cls && isClassId(e.target.value)) setKind(''); }}
              className="mt-1 w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
              {ROLES.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
            </select>
            {!fits && (
              <span className="mt-1 block text-2xs text-amber-600 dark:text-amber-400">
                Обычно «{roleTitle(role).toLowerCase()}» внутри «{roleTitle(parentRole).toLowerCase()}» не ставят — проверьте, что это именно то, что нужно.
              </span>
            )}
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-2xs font-semibold text-slate-500 dark:text-slate-400">Тип</span>
              <select value={cls} onChange={(e) => { setCls(e.target.value); setKind(''); }}
                className="mt-1 w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
                <option value="">по роли — {classById(isClassId(role) ? role : 'ПРОЧЕЕ').title.toLowerCase()}</option>
                {CLASSES.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-2xs font-semibold text-slate-500 dark:text-slate-400">Вид</span>
              <input value={kind} onChange={(e) => setKind(e.target.value)} list="add-position-kinds" placeholder="угадается"
                className="mt-1 w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800" />
              <datalist id="add-position-kinds">
                {classById(cls || (isClassId(role) ? role : 'ПРОЧЕЕ')).kinds.map((k) => <option key={k} value={k} />)}
              </datalist>
            </label>
          </div>

          <label className="block">
            <span className="text-2xs font-semibold text-slate-500 dark:text-slate-400">Тег (необязательно)</span>
            <input value={tag} onChange={(e) => setTag(e.target.value)} list="add-position-tags"
              placeholder="3700-B01-TE-001A"
              className="mt-1 w-full px-2.5 py-1.5 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800" />
            <datalist id="add-position-tags">
              {freeTags.filter((t) => !tag || t.toLowerCase().startsWith(tag.toLowerCase())).slice(0, 50).map((t) => <option key={t} value={t} />)}
            </datalist>
            <span className={`mt-1 block text-2xs ${check.state === 'bad' ? 'text-rose-600 dark:text-rose-400' : check.corrected ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400'}`}>
              {tagHint(check) || (target.parentTag
                ? `Родитель тега встанет сам: «${target.parentTag}».`
                : 'Родитель тега встанет сам: тег владельца, а если у него тега нет — тег установки.')}
            </span>
          </label>

          <div>
            <span className="text-2xs font-semibold text-slate-500 dark:text-slate-400">Параметры</span>
            <div className="mt-1 space-y-1">
              {rows.map((r, i) => (
                <div key={i} className="flex gap-1">
                  <input value={r.key} onChange={(e) => setRow(i, { key: e.target.value })} placeholder="Название"
                    className="flex-1 min-w-0 px-2 py-1 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800" />
                  <input value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} placeholder="Значение"
                    className="w-24 px-2 py-1 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800" />
                  <input value={r.unit} onChange={(e) => setRow(i, { unit: e.target.value })} placeholder="Ед."
                    className="w-14 px-2 py-1 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800" />
                </div>
              ))}
            </div>
            <button type="button" onClick={() => setRows((c) => [...c, { key: '', value: '', unit: '' }])}
              className="mt-1 flex items-center gap-1 text-2xs text-emerald-600 hover:text-emerald-700 cursor-pointer">
              <Plus className="w-3 h-3" />ещё параметр
            </button>
          </div>

          {error && <div className="text-2xs text-rose-600 dark:text-rose-400">{error}</div>}
        </div>

        <div className="px-4 py-3 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="fx-btn">Отмена</button>
          <button type="button" onClick={submit} disabled={busy}
            className="fx-btn fx-btn-primary">
            {busy ? 'Заводим…' : 'Добавить'}
          </button>
        </div>
      </div>
    </div>
  );
}
