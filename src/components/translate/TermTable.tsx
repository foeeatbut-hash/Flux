/**
 * Глоссарий проекта: как мы называем узлы, документы и параметры.
 *
 * Термин отличается от строки памяти тем, что это решение, а не след работы:
 * его заводят руками, о нём договариваются с заказчиком и его закрепляют.
 * Закреплённый термин программа не даёт изменить мимоходом — иначе смысл
 * договорённости теряется в первый же занятой день.
 */
import React from 'react';
import { Lock, Trash2, Plus, Check, X } from 'lucide-react';
import { useTranslateStore, type TermRow } from '../../store/translateStore';
import { useToastStore } from '../../store/toastStore';
import { normKey } from '../../translate/segment';

const SOURCE_LABEL: Record<string, string> = {
  hand: 'вручную', vdr: 'из ВДР', standard: 'из стандарта', pack: 'из файла', import: 'из импорта',
};

export default function TermTable({ adding, onAdded }: { adding: boolean; onAdded: () => void }) {
  const terms = useTranslateStore((s) => s.terms);
  const saveTerm = useTranslateStore((s) => s.saveTerm);
  const removeTerm = useTranslateStore((s) => s.removeTerm);
  const { addToast } = useToastStore();

  const [q, setQ] = React.useState('');
  const [draft, setDraft] = React.useState<Partial<TermRow> | null>(null);

  React.useEffect(() => {
    if (adding && !draft) setDraft({ ru: '', en: '', zh: '', note: '' });
  }, [adding, draft]);

  const shown = React.useMemo(() => {
    const key = normKey(q);
    const list = key
      ? terms.filter((t) => [t.ru, t.en, t.zh].some((x) => normKey(x || '').includes(key)))
      : terms;
    return list.slice(0, 500);
  }, [terms, q]);

  const save = async () => {
    if (!draft?.ru?.trim() && !draft?.en?.trim()) { addToast('Термин пуст', 'error'); return; }
    const saved = await saveTerm(draft);
    if (!saved) { addToast('Не удалось сохранить термин', 'error'); return; }
    addToast(draft.id ? 'Термин изменён' : 'Термин добавлен', 'success');
    setDraft(null);
    onAdded();
  };

  const cell = 'px-2 py-1.5 text-xs text-slate-700 dark:text-slate-300 align-top';
  const input = `w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md
                 px-2 py-1 text-xs text-slate-800 dark:text-slate-150 outline-none focus:border-emerald-400`;

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-800">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Найти термин"
          className={`${input} max-w-64`} />
        <span className="text-2xs text-slate-400 dark:text-slate-500">
          {terms.length ? `терминов: ${terms.length}` : 'словарь пуст — соберите его из данных проекта'}
        </span>
        <span className="flex-1" />
        <button type="button" onClick={() => setDraft({ ru: '', en: '', zh: '', note: '' })}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-2xs font-semibold text-emerald-700
                     dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 cursor-pointer">
          <Plus className="w-3 h-3" /> Термин
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto scrollbar-thin">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-slate-50 dark:bg-slate-900 z-10">
            <tr className="text-2xs uppercase tracking-wide text-slate-400 dark:text-slate-500">
              <th className="px-2 py-1.5 text-left font-semibold">Русский</th>
              <th className="px-2 py-1.5 text-left font-semibold">English</th>
              <th className="px-2 py-1.5 text-left font-semibold hidden @[720px]:table-cell">中文</th>
              <th className="px-2 py-1.5 text-left font-semibold hidden @[560px]:table-cell">Пометка</th>
              <th className="px-2 py-1.5 w-16" />
            </tr>
          </thead>
          <tbody>
            {draft && (
              <tr className="bg-emerald-50/60 dark:bg-emerald-950/20">
                <td className={cell}><input autoFocus value={draft.ru || ''} className={input}
                  onChange={(e) => setDraft({ ...draft, ru: e.target.value })} placeholder="расход воздуха" /></td>
                <td className={cell}><input value={draft.en || ''} className={input}
                  onChange={(e) => setDraft({ ...draft, en: e.target.value })} placeholder="air flow rate" /></td>
                <td className={`${cell} hidden @[720px]:table-cell`}><input value={draft.zh || ''} className={input}
                  onChange={(e) => setDraft({ ...draft, zh: e.target.value })} /></td>
                <td className={`${cell} hidden @[560px]:table-cell`}><input value={draft.note || ''} className={input}
                  onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="по требованию заказчика" /></td>
                <td className={cell}>
                  <span className="flex items-center gap-1">
                    <button type="button" onClick={save} title="Сохранить"
                      className="p-1 rounded-md text-emerald-600 hover:bg-emerald-100 dark:hover:bg-emerald-950/40 cursor-pointer">
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <button type="button" onClick={() => { setDraft(null); onAdded(); }} title="Отменить"
                      className="p-1 rounded-md text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-850 cursor-pointer">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </span>
                </td>
              </tr>
            )}
            {shown.map((t) => (
              <tr key={t.id} className="border-b border-slate-100 dark:border-slate-850 hover:bg-slate-50 dark:hover:bg-slate-900/60">
                <td className={cell}>{t.ru}</td>
                <td className={cell}>{t.en}</td>
                <td className={`${cell} hidden @[720px]:table-cell`}>{t.zh}</td>
                <td className={`${cell} hidden @[560px]:table-cell text-slate-400 dark:text-slate-500`}>
                  {t.note || SOURCE_LABEL[t.source] || ''}
                </td>
                <td className={cell}>
                  <span className="flex items-center gap-1">
                    {t.locked
                      ? <Lock className="w-3.5 h-3.5 text-amber-500" aria-label="Закреплён" />
                      : (
                        <button type="button" onClick={() => setDraft(t)} title="Изменить"
                          className="p-1 rounded-md text-slate-400 hover:text-emerald-600 hover:bg-emerald-50
                                     dark:hover:bg-emerald-950/40 cursor-pointer">
                          <Check className="w-3.5 h-3.5" />
                        </button>
                      )}
                    <button type="button" disabled={t.locked}
                      onClick={() => removeTerm(t.id)} title={t.locked ? 'Термин закреплён' : 'Удалить'}
                      className="p-1 rounded-md text-slate-400 hover:text-rose-600 hover:bg-rose-50
                                 dark:hover:bg-rose-950/40 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!shown.length && !draft && (
          <div className="p-6 text-center text-2xs text-slate-400 dark:text-slate-500">
            Ничего не нашлось. Вкладка «Данные проекта» соберёт словарь из строк ВДР и типов документов стандарта.
          </div>
        )}
      </div>
    </div>
  );
}
