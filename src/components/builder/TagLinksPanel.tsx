/**
 * Связь позиций ведомости с тегами проекта (раздел «Теги»).
 *
 * Тот же план, что у импорта оборудования: точное совпадение привязывается,
 * нового тега нет — заводится, похожих несколько — выбирает человек, запрещённое
 * правилами тегов проекта — не пишется. Молча ничего не создаётся.
 */
import React, { useEffect, useState } from 'react';
import { Link2, Plus, X } from 'lucide-react';
import { catalogService, type TagLinkPlan } from '../../services/catalogService';
import { useToastStore } from '../../store/toastStore';
import { Btn, Chip, Select } from '../catalog/ui';

const LABEL: Record<TagLinkPlan['action'], string> = { link: 'привязать', create: 'завести', skip: 'пропустить', ambiguous: 'выбрать', invalid: 'нельзя' };
const TONE: Record<TagLinkPlan['action'], 'emerald' | 'sky' | 'slate' | 'amber' | 'rose'> = { link: 'emerald', create: 'sky', skip: 'slate', ambiguous: 'amber', invalid: 'rose' };

export default function TagLinksPanel({ listId, onClose, onDone }: { listId: string; onClose: () => void; onDone: () => void }) {
  const addToast = useToastStore((s) => s.addToast);
  const [links, setLinks] = useState<TagLinkPlan[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    catalogService.tagPlan(listId).then((r) => setLinks(r.links)).catch((e) => { addToast(e?.message || 'План не построился', 'error'); onClose(); });
  }, [listId]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (i: number, patch: Partial<TagLinkPlan>) => setLinks((l) => l && l.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const counts = (links || []).reduce<Record<string, number>>((m, l) => ({ ...m, [l.action]: (m[l.action] || 0) + 1 }), {});

  const apply = async () => {
    if (!links) return;
    setBusy(true);
    try {
      const r = await catalogService.tagApply(listId, links.filter((l) => l.action === 'link' || l.action === 'create'));
      addToast(`Теги: привязано ${r.linked}, заведено ${r.created}`, 'success');
      onDone();
    } catch (e: any) { addToast(e?.message || 'Не записалось', 'error'); } finally { setBusy(false); }
  };

  return (
    <div className="flex flex-col gap-2 min-h-0 h-full">
      <div className="flex items-center gap-2 flex-wrap">
        <b className="text-sm">Связь с тегами проекта</b>
        {Object.entries(counts).map(([a, n]) => <Chip key={a} tone={TONE[a as TagLinkPlan['action']]}>{LABEL[a as TagLinkPlan['action']]} {n}</Chip>)}
        <span className="flex-1" />
        <Btn tone="ghost" onClick={onClose} aria-label="Закрыть"><X className="w-4 h-4" /></Btn>
      </div>
      <div className="flex-1 min-h-0 overflow-auto rounded-lg border border-slate-200 dark:border-slate-800">
        {!links ? <div className="p-3 text-xs text-slate-400">Сверяю с тегами проекта…</div> : (
          <table className="w-full text-xs">
            <tbody>
              {links.map((l, i) => (
                <tr key={`${l.blockKey}:${l.identifier}`} className="border-t border-slate-100 dark:border-slate-850">
                  <td className="px-2 py-1 font-mono">{l.identifier}</td>
                  <td className="px-2 py-1"><Chip tone={TONE[l.action]}>{LABEL[l.action]}</Chip></td>
                  <td className="px-2 py-1 text-2xs text-slate-500 dark:text-slate-400">
                    {l.action === 'ambiguous' && l.candidates?.length ? (
                      <Select value={l.existingTagId || ''} className="!w-auto font-mono"
                        onChange={(v) => set(i, v === '__new' ? { action: 'create', existingTagId: undefined } : v ? { action: 'link', existingTagId: v } : { existingTagId: undefined })}
                        options={[{ value: '', label: '— выберите —' }, ...l.candidates.map((c) => ({ value: c.id, label: `${c.identifier} (${c.why})` })), { value: '__new', label: 'завести новый' }]} />
                    ) : l.action === 'invalid' ? <span className="text-rose-600 dark:text-rose-400">{l.problem}{l.fix ? ` — правильно: ${l.fix}` : ''}</span>
                      : l.action === 'link' && l.candidates?.length ? `похоже на ${l.candidates[0].identifier}` : ''}
                    {(l.action === 'link' || l.action === 'create') && (
                      <button type="button" onClick={() => set(i, { action: 'skip' })} className="ml-2 text-slate-400 hover:text-rose-600 cursor-pointer">пропустить</button>
                    )}
                    {l.action === 'skip' && <button type="button" onClick={() => set(i, { action: l.existingTagId ? 'link' : 'create' })} className="text-emerald-700 dark:text-emerald-400 cursor-pointer">вернуть</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="flex gap-2 items-center">
        <Btn tone="primary" onClick={apply} disabled={busy || !links}><Link2 className="w-3.5 h-3.5" /> Привязать {counts.link || 0}, <Plus className="w-3 h-3" /> завести {counts.create || 0}</Btn>
        <span className="text-2xs text-slate-400">Новые теги появятся в разделе «Теги» с маркой — обозначением клапана</span>
      </div>
    </div>
  );
}
