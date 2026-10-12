import { useState } from 'react';
import { Pin, Save } from 'lucide-react';
import type { OfficeTemplate } from './fluxData';

export interface FluxTemplateControlsProps {
  templates: OfficeTemplate[];
  pinnedIds: string[];
  canSave: boolean;
  busy?: boolean;
  error?: string;
  onSave: (name: string, scope: OfficeTemplate['scope']) => Promise<void>;
  onOpen: (template: OfficeTemplate) => void | Promise<void>;
  onPin: (template: OfficeTemplate) => void | Promise<void>;
}

/** Кнопки и имя шаблона; доступ к личным и общим данным проверяет сервер. */
export default function FluxTemplateControls({ templates, pinnedIds, canSave, busy = false, error, onSave, onOpen, onPin }: FluxTemplateControlsProps) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState<OfficeTemplate['scope']>('PERSONAL');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!name.trim() || !canSave || saving || busy) return;
    setSaving(true);
    try { await onSave(name.trim(), scope); setName(''); }
    finally { setSaving(false); }
  };

  return <div className="flex min-w-0 items-center gap-2" aria-label="Шаблоны Flux">
    <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
      {templates.map((template) => {
        const pinned = pinnedIds.includes(template.id);
        return <div key={template.id} className="flex shrink-0 items-center gap-1 rounded border border-slate-200 px-2 py-1 text-xs dark:border-dark-border">
          <button type="button" className="max-w-36 truncate text-slate-800 dark:text-dark-text-main" onClick={() => void onOpen(template)} disabled={busy} title={`Открыть шаблон «${template.name}»`}>{template.name}</button>
          <button type="button" onClick={() => void onPin(template)} disabled={busy} aria-pressed={pinned} aria-label={`${pinned ? 'Открепить' : 'Закрепить'} ${template.name}`} title={pinned ? 'Открепить' : 'Закрепить'} className="rounded p-1 text-slate-500 disabled:opacity-40 dark:text-slate-400">
            <Pin className={`h-3 w-3 ${pinned ? 'fill-current text-emerald-700 dark:text-emerald-300' : ''}`} />
          </button>
        </div>;
      })}
      {!templates.length && <span className="text-xs text-slate-500 dark:text-slate-400">Шаблонов пока нет</span>}
    </div>
    <input aria-label="Название шаблона" value={name} onChange={(event) => setName(event.target.value)} placeholder="Новый шаблон" maxLength={120}
      className="h-7 min-w-28 max-w-36 rounded border border-slate-200 bg-white px-2 text-xs text-slate-800 placeholder:text-slate-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600 dark:border-dark-border dark:bg-dark-surface dark:text-dark-text-main dark:placeholder:text-slate-500" />
    <select aria-label="Доступ шаблона" value={scope} onChange={(event) => setScope(event.target.value as OfficeTemplate['scope'])} disabled={busy || saving}
      className="h-7 rounded border border-slate-200 bg-white px-1 text-xs text-slate-700 dark:border-dark-border dark:bg-dark-surface dark:text-slate-300">
      <option value="PERSONAL">Личный</option><option value="SHARED">Общий</option>
    </select>
    <button type="button" onClick={() => void save()} disabled={!canSave || !name.trim() || busy || saving} aria-label="Сохранить шаблон" title="Сохранить шаблон"
      className="rounded p-1 text-slate-500 disabled:opacity-40 dark:text-slate-400"><Save className="h-3.5 w-3.5" /></button>
    {error && <span role="alert" className="max-w-48 text-xs text-rose-700 dark:text-rose-300">{error}</span>}
  </div>;
}
