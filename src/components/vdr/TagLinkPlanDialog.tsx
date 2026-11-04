import React, { useEffect, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import { Btn } from '../ui';
import { WindowDialog } from '../ui/WindowDialog';
import { useToastStore } from '../../store/toastStore';

/**
 * Перенос кодов тегов из строк ВДР в связи по id: план → применение → отмена.
 *
 * Показывает то, что произойдёт, до записи: сколько связей создастся, какие коды
 * в «Тегах» не нашлись (счётчик «не сопоставлено») и какие неоднозначны (в проекте
 * два тега с таким кодом — решает человек, программа не угадывает). Коды без
 * тега остаются в строках как были; применение их не трогает. Применить можно
 * только тот план, который человек видел: отпечаток уходит на сервер, и если
 * данные успели измениться, приходит новый план, а не запись вслепую.
 */

export interface TagLinkPlan {
  items: number;
  toLink: { itemId: string; itemNo: string; registerName: string; code: string; identifier: string }[];
  alreadyLinked: number;
  unmatched: { itemId: string; itemNo: string; registerName: string; code: string }[];
  ambiguous: { itemId: string; itemNo: string; registerName: string; code: string }[];
  generic: number;
  orphaned: number;
  digest: string;
}

/** «Не сопоставлено» для счётчика: коды без тега и неоднозначные */
export const unlinkedCount = (p: TagLinkPlan | null) => (p ? p.unmatched.length + p.ambiguous.length : 0);

const COLLAPSE = 8;

function Group({ title, tone, rows, hint }: { title: string; tone: string; rows: { itemNo: string; registerName: string; code: string; identifier?: string }[]; hint?: string }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return null;
  const shown = all ? rows : rows.slice(0, COLLAPSE);
  return (
    <div className="space-y-1">
      <div className={`text-xs font-semibold ${tone}`}>{title} — {rows.length}</div>
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
      <div className="border border-slate-200 dark:border-slate-800 rounded-lg divide-y divide-slate-100 dark:divide-slate-800">
        {shown.map((r, i) => (
          <div key={i} className="px-3 py-1 flex items-center gap-2 text-xs">
            <span className="w-28 truncate font-medium text-slate-700 dark:text-slate-300" title={r.registerName}>{r.itemNo || '—'}</span>
            <span className="flex-1 truncate text-slate-600 dark:text-slate-400">{r.code}{r.identifier && r.identifier !== r.code ? ` → ${r.identifier}` : ''}</span>
          </div>
        ))}
      </div>
      {rows.length > COLLAPSE && (
        <button type="button" onClick={() => setAll(v => !v)} className="text-xs text-emerald-600 hover:underline cursor-pointer">
          {all ? 'Свернуть' : `Показать все ${rows.length}`}
        </button>
      )}
    </div>
  );
}

export default function TagLinkPlanDialog({ projectId, initial, onClose, onChanged }: {
  projectId: string; initial: TagLinkPlan | null; onClose: () => void; onChanged: () => void;
}) {
  const { addToast } = useToastStore();
  const [plan, setPlan] = useState<TagLinkPlan | null>(initial);
  const [busy, setBusy] = useState(false);
  // Созданные в этом окне связи: по ним «Отменить» снимает ровно их
  const [created, setCreated] = useState<{ itemId: string; tagId: string }[]>([]);

  useEffect(() => {
    let dead = false;
    fetch(`/api/vdr/tag-links?projectId=${encodeURIComponent(projectId)}`).then(r => r.ok ? r.json() : null)
      .then(d => { if (!dead && d?.plan) setPlan(d.plan); }).catch(() => {});
    return () => { dead = true; };
  }, [projectId]);

  const post = async (path: string, body: any) => {
    const r = await fetch(`/api/vdr/tag-links/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, ...body }) });
    return { r, d: await r.json().catch(() => ({})) };
  };

  const apply = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      const { r, d } = await post('apply', { digest: plan.digest });
      if (r.status === 409 && d.plan) { setPlan(d.plan); addToast(d.error || 'План изменился — проверьте новый', 'error'); return; }
      if (!r.ok) { addToast(d.error || 'Не удалось связать теги', 'error'); return; }
      setPlan(d.plan); setCreated(d.created || []);
      addToast(d.created?.length ? `Связано тегов: ${d.created.length}` : 'Связывать было нечего', 'success');
      onChanged();
    } finally { setBusy(false); }
  };

  const undo = async () => {
    setBusy(true);
    try {
      const { r, d } = await post('undo', { created });
      if (!r.ok) { addToast(d.error || 'Не удалось отменить', 'error'); return; }
      setPlan(d.plan); setCreated([]);
      addToast(`Связей снято: ${d.removed}`, 'success');
      onChanged();
    } finally { setBusy(false); }
  };

  return (
    <WindowDialog onClose={onClose} label="Связи строк ВДР с тегами"
      className="fx-dialog w-[560px] max-w-[94vw] max-h-[86vh] flex flex-col overflow-hidden">
      <div data-dialog-drag className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-800 shrink-0">
        <span className="font-semibold text-slate-800 dark:text-white flex-1">Связи строк ВДР с тегами</span>
        <button type="button" title="Закрыть" onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"><X className="w-4 h-4" /></button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3 text-sm">
        {!plan ? <div className="flex justify-center py-8 text-slate-400"><Loader2 className="w-5 h-5 animate-spin" /></div> : (
          <>
            <p className="text-xs text-slate-500">
              Строка связывается с тегом по его номеру в базе, поэтому переименование тега связь не рвёт.
              Коды в строках остаются как были; ничего не удаляется.
            </p>
            <div className="grid grid-cols-4 gap-2 text-center">
              {[
                ['Строк с кодами', plan.items], ['Уже связано', plan.alreadyLinked],
                ['Будет связано', plan.toLink.length], ['Не сопоставлено', unlinkedCount(plan)],
              ].map(([label, n]) => (
                <div key={String(label)} className="rounded-lg bg-slate-50 dark:bg-slate-900 py-2">
                  <div className="text-lg font-semibold text-slate-800 dark:text-white">{n}</div>
                  <div className="text-[11px] text-slate-500">{label}</div>
                </div>
              ))}
            </div>
            <Group title="Будет связано" tone="text-emerald-600" rows={plan.toLink} />
            <Group title="Нет такого тега в проекте" tone="text-amber-600" rows={plan.unmatched}
              hint="Заведите тег с этим кодом в «Тегах» или поправьте код в строке; затем откройте план снова." />
            <Group title="Два тега с одним кодом" tone="text-rose-600" rows={plan.ambiguous}
              hint="Программа не выбирает сама: оставьте один тег с этим кодом или выберите нужный в карточке строки." />
            {plan.generic > 0 && <p className="text-xs text-slate-500">Отметок «на все позиции»: {plan.generic} — это не теги, связь им не нужна.</p>}
            {plan.orphaned > 0 && <p className="text-xs text-slate-500">Связей с удалёнными тегами: {plan.orphaned} — остаются с прежним кодом, пока он есть в строке.</p>}
          </>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-200 dark:border-slate-800 shrink-0">
        {created.length > 0 && <Btn tone="ghost" onClick={undo} disabled={busy}>Отменить связывание</Btn>}
        <Btn tone="ghost" onClick={onClose}>Закрыть</Btn>
        <Btn tone="primary" onClick={apply} disabled={busy || !plan || plan.toLink.length === 0}>
          {plan && plan.toLink.length ? `Связать: ${plan.toLink.length}` : 'Связывать нечего'}
        </Btn>
      </div>
    </WindowDialog>
  );
}
