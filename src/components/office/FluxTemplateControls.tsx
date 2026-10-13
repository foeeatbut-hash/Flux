import { useMemo, useState } from 'react';
import { Pin } from 'lucide-react';
import { Badge, Btn, Dialog, Empty, Input } from '../ui';
import type { OfficeTemplate } from './fluxData';

export type TemplateDialogMode = 'library' | 'pinned' | 'save';
type Filter = 'all' | 'mine' | 'shared' | 'pinned';
type Order = 'name' | 'date';

export interface FluxTemplateControlsProps {
  mode: TemplateDialogMode;
  templates: OfficeTemplate[];
  pinnedIds: string[];
  /** Текущий сотрудник: по нему видно, чьи шаблоны «мои» и какие он может править. */
  userId: string;
  /** Шапку можно сохранить: схема прочитана, нет неразрешённых связей шаблона. */
  canSave: boolean;
  busy?: boolean;
  error?: string;
  onSave: (input: { name: string; description: string; scope: OfficeTemplate['scope']; pin: boolean }) => Promise<boolean>;
  onOpen: (template: OfficeTemplate) => void | Promise<void>;
  onPin: (template: OfficeTemplate) => void | Promise<void>;
  onCopy: (template: OfficeTemplate) => void | Promise<void>;
  onDelete: (template: OfficeTemplate) => void | Promise<void>;
  onClose: () => void;
}

/** Создатель правит и удаляет оригинал, остальные используют или копируют себе (ТЗ §13); проверяет сервер. */
export const canManageTemplate = (template: OfficeTemplate, userId: string): boolean =>
  !!userId && (template.scope === 'PERSONAL' ? template.ownerId === userId : template.createdById === userId);

/**
 * Окна шаблонов, которые открывают команды ленты «Шаблоны», «Закреплённые» и
 * «Сохранить как». В правой панели шаблонов больше нет.
 */
export default function FluxTemplateControls(props: FluxTemplateControlsProps) {
  if (props.mode === 'save') return <SaveDialog {...props} />;
  return <Library {...props} initial={props.mode === 'pinned' ? 'pinned' : 'all'} title={props.mode === 'pinned' ? 'Закреплённые шаблоны' : 'Шаблоны шапки'} />;
}

function SaveDialog({ canSave, busy, error, onSave, onClose }: FluxTemplateControlsProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState<OfficeTemplate['scope']>('PERSONAL');
  const [pin, setPin] = useState(false);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!name.trim() || !canSave || saving || busy) return;
    setSaving(true);
    try { if (await onSave({ name: name.trim(), description: description.trim(), scope, pin })) onClose(); }
    finally { setSaving(false); }
  };
  return <Dialog title="Сохранить шапку как шаблон" onClose={onClose} busy={saving}
    footer={<><Btn tone="ghost" onClick={onClose} disabled={saving}>Отмена</Btn><Btn tone="primary" onClick={() => void save()} disabled={!canSave || !name.trim() || saving || busy}>Сохранить</Btn></>}>
    <div className="space-y-3">
      <label className="block text-xs text-slate-600 dark:text-slate-300">Название
        <Input autoFocus aria-label="Название шаблона" className="mt-1 w-full" value={name} maxLength={120} placeholder="Например, Ведомость оборудования ОВ" onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void save(); }} />
      </label>
      <label className="block text-xs text-slate-600 dark:text-slate-300">Описание (необязательно)
        <Input aria-label="Описание шаблона" className="mt-1 w-full" value={description} maxLength={500} onChange={(event) => setDescription(event.target.value)} />
      </label>
      <fieldset>
        <legend className="mb-1 text-xs text-slate-600 dark:text-slate-300">Доступ</legend>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-1.5"><input type="radio" name="flux-template-scope" className="accent-emerald-600" checked={scope === 'PERSONAL'} onChange={() => setScope('PERSONAL')} />Только мне</label>
          <label className="flex items-center gap-1.5"><input type="radio" name="flux-template-scope" className="accent-emerald-600" checked={scope === 'SHARED'} onChange={() => setScope('SHARED')} />Для всех</label>
        </div>
      </fieldset>
      <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" className="accent-emerald-600" checked={pin} onChange={(event) => setPin(event.target.checked)} />Закрепить для себя</label>
      <p className="text-xs text-slate-500 dark:text-slate-400">Сохраняется только шапка: метки, текст, действия и объединения. Заполненные строки и персональные данные в шаблон не входят.{scope === 'SHARED' ? ' Общий шаблон правит и удаляет только его создатель; остальные используют его или копируют себе.' : ''}</p>
      {!canSave && <p role="status" className="text-xs text-amber-700 dark:text-amber-300">Шапка ещё не прочитана из документа или в шаблоне есть неразрешённые связи.</p>}
      {error && <p role="alert" className="text-xs text-rose-700 dark:text-rose-300">{error}</p>}
    </div>
  </Dialog>;
}

function Library({ templates, pinnedIds, userId, busy, error, onOpen, onPin, onCopy, onDelete, onClose, initial, title }: FluxTemplateControlsProps & { initial: Filter; title: string }) {
  const [filter, setFilter] = useState<Filter>(initial);
  const [order, setOrder] = useState<Order>('name');
  const [search, setSearch] = useState('');
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return templates
      .filter((template) => filter === 'all' || (filter === 'pinned' ? pinnedIds.includes(template.id) : filter === 'mine' ? canManageTemplate(template, userId) : template.scope === 'SHARED'))
      .filter((template) => !needle || `${template.name} ${template.description || ''}`.toLowerCase().includes(needle))
      .sort((a, b) => order === 'name' ? a.name.localeCompare(b.name, 'ru') : String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }, [templates, pinnedIds, userId, filter, order, search]);
  return <Dialog title={title} onClose={onClose} width="max-w-xl" scrollBody busy={busy}>
    <div className="mb-3 grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2">
      <Input aria-label="Поиск по шаблонам" placeholder="Поиск по названию" value={search} onChange={(event) => setSearch(event.target.value)} />
      <select aria-label="Показать шаблоны" className="fx-input" value={filter} onChange={(event) => setFilter(event.target.value as Filter)}>
        <option value="all">Все доступные</option><option value="mine">Мои</option><option value="shared">Общие</option><option value="pinned">Закреплённые</option>
      </select>
      <select aria-label="Сортировка шаблонов" className="fx-input" value={order} onChange={(event) => setOrder(event.target.value as Order)}>
        <option value="name">По названию</option><option value="date">По дате</option>
      </select>
    </div>
    {error && <p role="alert" className="mb-2 text-xs text-rose-700 dark:text-rose-300">{error}</p>}
    {!shown.length ? <Empty title={templates.length ? 'Ничего не найдено' : 'Шаблонов пока нет'} text={templates.length ? 'Измените поиск или фильтр.' : 'Сохраните шапку кнопкой «Сохранить как» на ленте.'} />
      : <ul aria-label="Шаблоны" className="divide-y divide-slate-200 dark:divide-slate-700">
        {shown.map((template) => {
          const pinned = pinnedIds.includes(template.id);
          const own = canManageTemplate(template, userId);
          return <li key={template.id} className="flex items-center gap-2 py-2" data-template-id={template.id}>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2"><span className="truncate text-sm font-medium text-slate-800 dark:text-dark-text-main">{template.name}</span><Badge>{template.scope === 'SHARED' ? 'Общий' : 'Личный'}</Badge></div>
              {template.description && <p className="truncate text-xs text-slate-500 dark:text-slate-400">{template.description}</p>}
              {template.scope === 'SHARED' && !own && <p className="text-xs text-slate-500 dark:text-slate-400">Создал другой сотрудник: можно использовать или копировать себе.</p>}
            </div>
            <button type="button" onClick={() => void onPin(template)} disabled={busy} aria-pressed={pinned} aria-label={`${pinned ? 'Открепить' : 'Закрепить'} ${template.name}`} title={pinned ? 'Открепить' : 'Закрепить для себя'} className="rounded p-1.5 text-slate-500 disabled:opacity-40 dark:text-slate-400">
              <Pin className={`h-3.5 w-3.5 ${pinned ? 'fill-current text-emerald-700 dark:text-emerald-300' : ''}`} />
            </button>
            {!own && <Btn size="sm" disabled={busy} onClick={() => void onCopy(template)} title="Сохранить свою копию шаблона">Копия себе</Btn>}
            {own && <Btn size="sm" tone="danger" disabled={busy} onClick={() => void onDelete(template)} title="Удалить шаблон">Удалить</Btn>}
            <Btn size="sm" tone="primary" disabled={busy} onClick={async () => { await onOpen(template); onClose(); }} title={`Применить шаблон «${template.name}» к документу`}>Открыть</Btn>
          </li>;
        })}
      </ul>}
  </Dialog>;
}
