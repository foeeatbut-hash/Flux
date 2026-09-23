import React from 'react';
import { Check, RotateCcw, X } from 'lucide-react';
import { CLASSES, classById, classLabel, type Classified } from '../../../equipment/classes';

/**
 * Тип и вид позиции в шапке карточки — с поправкой по нажатию.
 *
 * Тип угадывается правилами, и человек видит угаданное сразу, а не после
 * того, как в выгрузке не оказалось «его» приводов. Поправка — здесь же:
 * выбрать тип, вписать вид (или взять из подсказок), и она сильнее правил.
 * «Вернуть угаданное» стирает поправку — рядом написано, что будет угадано.
 */

interface Props {
  componentId: string;
  typed: Classified | undefined;
  /** Поправка записана — карточке пора перечитать данные */
  onSaved: () => void;
  say: (text: string, kind?: 'success' | 'error' | 'info') => void;
}

export default function TypeChip({ componentId, typed, onSaved, say }: Props) {
  const [open, setOpen] = React.useState(false);
  const [cls, setCls] = React.useState<string>(typed?.cls || 'ПРОЧЕЕ');
  const [kind, setKind] = React.useState<string>(typed?.kind || '');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    setCls(typed?.cls || 'ПРОЧЕЕ');
    setKind(typed?.kind || '');
  }, [componentId, typed?.cls, typed?.kind]);

  const manual = !!typed && (typed.cls !== typed.auto.cls || typed.kind !== typed.auto.kind);

  const save = async (next: { equipClass: string; equipKind: string }) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/equipment/component/${componentId}/class`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { say(data?.error || 'Не удалось записать тип', 'error'); return; }
      say(next.equipClass || next.equipKind ? 'Тип позиции поправлен' : 'Тип снова угадывается', 'success');
      setOpen(false);
      onSaved();
    } catch (_) {
      say('Сервер не ответил', 'error');
    } finally { setBusy(false); }
  };

  // Поправка пишется только там, где она расходится с угаданным: иначе
  // ручная запись «заморозила» бы тип, и улучшение правил её бы не коснулось
  const submit = () => {
    if (!typed) return;
    save({
      equipClass: cls === typed.auto.cls ? '' : cls,
      equipKind: kind.trim() === typed.auto.kind && cls === typed.auto.cls ? '' : kind.trim(),
    });
  };

  if (!typed) return null;
  return (
    <span className="relative inline-flex">
      <button type="button" onClick={() => setOpen((v) => !v)} data-type-chip
        title={manual ? `Поправлено вручную · угадано: ${classLabel(typed.auto)}` : 'Тип угадан по названию и характеристикам — нажмите, чтобы поправить'}
        className="px-2 py-0.5 rounded-md bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 text-2xs font-bold tracking-wide cursor-pointer hover:ring-1 hover:ring-emerald-400">
        {classLabel(typed)}{manual ? ' ✎' : ''}
      </button>
      {open && (
        <div role="dialog" aria-label="Тип позиции"
          className="absolute left-0 top-full mt-1 z-30 w-72 p-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl space-y-2">
          <label className="block">
            <span className="text-2xs font-semibold text-slate-500 dark:text-slate-400">Тип</span>
            <select value={cls} onChange={(e) => { setCls(e.target.value); setKind(''); }}
              className="mt-1 w-full px-2 py-1 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
              {CLASSES.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-2xs font-semibold text-slate-500 dark:text-slate-400">Вид</span>
            <input value={kind} onChange={(e) => setKind(e.target.value)} list={`kinds-${componentId}`}
              placeholder="например, «Канальный»"
              className="mt-1 w-full px-2 py-1 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800" />
            <datalist id={`kinds-${componentId}`}>
              {classById(cls).kinds.map((k) => <option key={k} value={k} />)}
            </datalist>
          </label>
          <div className="text-2xs text-slate-400">Угадано: {classLabel(typed.auto)}</div>
          <div className="flex items-center gap-1.5 pt-1">
            {manual && (
              <button type="button" disabled={busy} onClick={() => save({ equipClass: '', equipKind: '' })}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-2xs text-slate-500 hover:text-emerald-600 cursor-pointer disabled:opacity-50">
                <RotateCcw className="w-3 h-3" />вернуть угаданное
              </button>
            )}
            <span className="flex-1" />
            <button type="button" onClick={() => setOpen(false)} aria-label="Закрыть"
              className="p-1 rounded-lg text-slate-400 hover:text-slate-600 cursor-pointer"><X className="w-3.5 h-3.5" /></button>
            <button type="button" disabled={busy} onClick={submit}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600 text-white text-2xs font-bold cursor-pointer disabled:opacity-50">
              <Check className="w-3 h-3" />Записать
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
