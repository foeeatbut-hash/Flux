/**
 * Комментарии тега: то, что раньше называлось «подописание» и «замечание».
 *
 * Полей было два, смысл один, и человек каждый раз решал, куда писать. Теперь
 * это одна вещь — комментарий, у которого три части: название, содержание и
 * актуальность. База не менялась: у записи и раньше были текст, примечание и
 * состояние — им вернули человеческие имена и один вид.
 *
 * Актуальность тега складывается из актуальностей его комментариев (правило
 * живёт в разделе «Теги»), поэтому «Критично» у одного комментария — это
 * «Критично» у всего тега. Здесь про это сказано словами, а не оставлено
 * догадываться по цвету.
 */
import React, { useState } from 'react';
import { Plus, Edit, Trash2 } from 'lucide-react';
import CustomSelect from '../CustomSelect';

export interface TagComment {
  id: string;
  text: string;
  comment?: string;
  status: 'actual' | 'warning' | 'critical' | 'info' | 'draft';
  createdBy?: string;
  createdAt?: string;
  updatedBy?: string;
  updatedAt?: string;
}

export interface StatusLook {
  bg: string; text: string; border: string; icon: any; label: string;
}

export default function TagComments({ items, statusConfig, statusOptions, formatDate, onAdd, onUpdate, onRemove }: {
  items: TagComment[];
  statusConfig: Record<string, StatusLook>;
  statusOptions: { value: string; label: string }[];
  formatDate: (iso: string) => string;
  onAdd: (text: string, comment: string, status: string) => void | Promise<void>;
  onUpdate: (id: string, patch: { text: string; comment: string; status: string }) => void | Promise<void>;
  onRemove: (id: string) => void;
}) {
  const [text, setText] = useState('');
  const [body, setBody] = useState('');
  const [status, setStatus] = useState('actual');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ text: '', comment: '', status: 'actual' });

  const add = async () => {
    if (!text.trim()) return;
    await onAdd(text.trim(), body.trim(), status);
    setText(''); setBody(''); setStatus('actual');
  };

  const field = 'w-full px-2.5 py-1.5 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-xs text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500';

  return (
    <div className="space-y-2.5 text-left">
      <div className="flex items-baseline justify-between gap-2">
        <label className="fx-label">Комментарии ({items.length})</label>
        <span className="text-2xs text-slate-400">Актуальность тега берётся из них</span>
      </div>

      {/* Добавление: три части в одну строку — вместе они и есть комментарий */}
      <div className="flex flex-wrap gap-1.5">
        <input type="text" value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          placeholder="Название (напр. Датчик TE-101)"
          className={`${field} flex-1 min-w-[10rem]`} />
        <div className="w-36 shrink-0">
          <CustomSelect value={status} onChange={setStatus} options={statusOptions} />
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <input type="text" value={body} onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          placeholder="Содержание: что проверено, что не так"
          className={`${field} flex-1 min-w-[10rem]`} />
        <button type="button" disabled={!text.trim()} onClick={add}
          className="fx-btn fx-btn-primary shrink-0">
          <Plus className="w-3.5 h-3.5" /> Добавить
        </button>
      </div>

      <div className="space-y-1.5 max-h-[300px] overflow-y-auto">
        {items.map((item) => {
          const look = statusConfig[item.status] || statusConfig.draft;
          const Icon = look.icon;
          if (editingId === item.id) {
            return (
              <div key={item.id} className="p-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg space-y-1.5">
                <div className="flex gap-1.5">
                  <input value={form.text} onChange={(e) => setForm(f => ({ ...f, text: e.target.value }))}
                    placeholder="Название" className={`${field} flex-1 min-w-0`} />
                  <div className="w-36 shrink-0">
                    <CustomSelect value={form.status} onChange={(v) => setForm(f => ({ ...f, status: v }))} options={statusOptions} />
                  </div>
                </div>
                <textarea value={form.comment} onChange={(e) => setForm(f => ({ ...f, comment: e.target.value }))}
                  rows={2} placeholder="Содержание" className={`${field} animate-none`} />
                <div className="flex justify-end gap-1.5">
                  <button type="button" onClick={() => setEditingId(null)}
                    className="px-2 py-0.5 text-xs text-slate-400 hover:text-slate-600 cursor-pointer">Отмена</button>
                  <button type="button"
                    onClick={async () => { await onUpdate(item.id, form); setEditingId(null); }}
                    className="fx-btn fx-btn-primary fx-btn-sm">Сохранить</button>
                </div>
              </div>
            );
          }
          return (
            <div key={item.id} className="px-2.5 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-lg">
              <div className="flex items-start justify-between gap-2">
                <div className="flex gap-2 min-w-0">
                  <Icon className={`w-4 h-4 shrink-0 mt-0.5 ${look.text}`} />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-slate-850 dark:text-slate-100">{item.text}</p>
                    {item.comment && (
                      <p className="text-xs text-slate-550 dark:text-slate-400 mt-0.5">{item.comment}</p>
                    )}
                    {/* Кто и когда — мелким, одной строкой: это справка, а не содержание */}
                    <p className="text-2xs text-slate-450 dark:text-slate-500 font-mono mt-0.5 leading-none">
                      {item.createdBy || 'Система'}{item.createdAt ? ` · ${formatDate(item.createdAt)}` : ''}
                      {item.updatedBy ? ` · правил ${item.updatedBy}` : ''}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <span className={`px-1.5 py-0.5 rounded text-2xs font-semibold border ${look.bg} ${look.text} ${look.border}`}>{look.label}</span>
                  <button type="button" title="Изменить комментарий"
                    onClick={() => { setEditingId(item.id); setForm({ text: item.text, comment: item.comment || '', status: item.status }); }}
                    className="p-1 hover:bg-slate-200 dark:hover:bg-slate-800 rounded text-slate-405 hover:text-emerald-600 cursor-pointer">
                    <Edit className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" title="Удалить комментарий" onClick={() => onRemove(item.id)}
                    className="p-1 hover:bg-rose-50 dark:hover:bg-rose-950 rounded text-slate-400 hover:text-rose-500 cursor-pointer">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        {!items.length && (
          <p className="text-center py-5 text-slate-400 text-xs italic">
            Комментариев нет. Пока их нет, тег числится устаревшим.
          </p>
        )}
      </div>
    </div>
  );
}
