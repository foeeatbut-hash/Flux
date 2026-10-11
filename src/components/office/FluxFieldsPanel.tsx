import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Save, Search, X } from 'lucide-react';
import { Btn, Empty, Input } from '../ui';
import type { OfficeBinding, OfficeHeaderSchema, OfficePart } from '../../lib/officeModel';
import type { OfficeField, OfficeState } from './fluxData';

interface Props {
  fields: OfficeField[];
  state: OfficeState | null;
  selectedField: OfficeField | null;
  activeAnchorId: string;
  projectId: string;
  readOnly: boolean;
  canEditSchema: boolean;
  onSelectField: (field: OfficeField) => void;
  onSaveSchema: (schema: OfficeHeaderSchema) => Promise<boolean>;
}

export default function FluxFieldsPanel({ fields, state, selectedField, activeAnchorId, projectId, readOnly, canEditSchema, onSelectField, onSaveSchema }: Props) {
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<OfficeHeaderSchema | null>(state?.schema || null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const shown = useMemo(() => {
    const q = search.trim().toLocaleLowerCase('ru-RU');
    return q ? fields.filter((field) => `${field.displayName} ${field.fieldKey} ${field.sourceId}`.toLocaleLowerCase('ru-RU').includes(q)) : fields;
  }, [fields, search]);
  const groups = useMemo(() => shown.reduce((map, field) => {
    const list = map.get(field.sourceId) || []; list.push(field); map.set(field.sourceId, list); return map;
  }, new Map<string, OfficeField[]>()), [shown]);
  const anchorCount = state?.schema.anchors.length || 0;
  const changed = !!draft && !!state && JSON.stringify(draft) !== JSON.stringify(state.schema);

  useEffect(() => { setDraft(state?.schema || null); setError(''); }, [state?.baseHash, state?.schema]);

  const updateAnchor = (anchorIndex: number, change: (parts: OfficePart[]) => OfficePart[]) => {
    setDraft((current) => current ? ({ ...current, anchors: current.anchors.map((anchor, index) => index === anchorIndex ? { ...anchor, parts: change(anchor.parts) } : anchor) }) : current);
  };
  const bind = (anchorId: string, field: OfficeField): OfficeBinding => ({
    fieldKey: field.fieldKey, sourceId: field.sourceId, entityType: field.entityType,
    entityId: null, sourceRevision: state?.sourceRevision || '', ...(field.unit ? { unit: field.unit } : {}), anchorId,
  });
  const saveSchema = async () => {
    if (!draft || !canEditSchema || readOnly) return;
    setSaving(true); setError('');
    try { if (!(await onSaveSchema(draft))) throw new Error('Редактор не подтвердил сохранение схемы.'); }
    catch (reason: any) { setError(String(reason?.message || reason)); }
    finally { setSaving(false); }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 p-3">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Найти поле Flux" placeholder="Найти поле по названию" className="w-full pl-7" />
        </label>
        <div className="mt-2 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
          <span>{fields.length.toLocaleString('ru-RU')} доступных полей</span>
          <span>{anchorCount ? `Якорей: ${anchorCount}` : 'Якорей шапки пока нет'}</span>
        </div>
      </div>

      <section className="min-h-0 shrink-0 border-y border-slate-200 dark:border-slate-800">
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <div><h3 className="text-xs font-semibold text-slate-800 dark:text-dark-text-main">Поля и схема заголовков</h3><p className="text-xs text-slate-500 dark:text-slate-400">Обычный текст, метки, операторы и объединения сохраняются в метаданных документа.</p></div>
          <Btn tone="primary" disabled={!changed || !canEditSchema || readOnly || saving} onClick={() => void saveSchema()}>{saving ? 'Сохраняем…' : <><Save className="h-3.5 w-3.5" />Сохранить схему</>}</Btn>
        </div>
        {error && <p role="alert" className="px-3 pb-2 text-xs text-rose-700 dark:text-rose-300">{error}</p>}
        {!canEditSchema && <p className="px-3 pb-2 text-xs text-amber-700 dark:text-amber-300">Редактор пока не подтвердил безопасный мост записи схемы. Изменения не применяются локально.</p>}
        {readOnly && <p className="px-3 pb-2 text-xs text-amber-700 dark:text-amber-300">Документ открыт только для просмотра.</p>}
        <div className="max-h-52 overflow-auto px-3 pb-3">
          {!draft?.anchors.length && <p className="text-xs text-slate-500 dark:text-slate-400">Щёлкните ячейку заголовка в документе, выберите поле и привяжите его.</p>}
          {draft?.anchors.map((anchor, anchorIndex) => {
            const active = activeAnchorId === anchor.id;
            const hasField = anchor.parts.some((part) => part.kind === 'field');
            return <section key={anchor.id} className={`border-t border-slate-200 py-2 first:border-0 dark:border-slate-800 ${active ? 'bg-slate-50 dark:bg-slate-900/50' : ''}`}>
              <div className="flex items-center justify-between gap-2"><h4 className="min-w-0 truncate text-xs font-semibold">{anchor.sheetName ? `${anchor.sheetName}!` : ''}{anchor.address || anchor.id}</h4><span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">{active ? 'активная ячейка' : anchor.kind === 'word-row' ? 'Word' : 'Excel'}</span></div>
              <div className="mt-1 space-y-1">
                {anchor.parts.map((part, partIndex) => <div key={`${anchor.id}:${partIndex}`} className="flex items-center gap-1.5">
                  {part.kind === 'text' ? <Input aria-label={`Текст заголовка ${partIndex + 1}`} disabled={!canEditSchema || readOnly} value={part.text} onChange={(event) => updateAnchor(anchorIndex, (parts) => parts.map((item, at) => at === partIndex && item.kind === 'text' ? { ...item, text: event.target.value } : item))} />
                    : <span className="min-w-0 flex-1 truncate rounded border border-slate-200 px-2 py-1 text-xs dark:border-slate-700">{partLabel(part)}</span>}
                  {part.kind !== 'field' && part.kind !== 'union' && <button type="button" aria-label="Удалить часть заголовка" disabled={!canEditSchema || readOnly} className="rounded p-1 text-slate-500 disabled:opacity-40" onClick={() => updateAnchor(anchorIndex, (parts) => parts.filter((_item, at) => at !== partIndex))}><X className="h-3.5 w-3.5" /></button>}
                </div>)}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button type="button" className="fx-btn fx-btn-quiet fx-btn-sm" disabled={!canEditSchema || readOnly} onClick={() => updateAnchor(anchorIndex, (parts) => [...parts, { kind: 'text', text: '' }])}><Plus className="h-3.5 w-3.5" />Текст</button>
                {(['+', '-', '*', '/'] as const).map((operator) => <button key={operator} type="button" className="fx-btn fx-btn-quiet fx-btn-sm" aria-label={`Добавить оператор ${operator}`} disabled={!canEditSchema || readOnly} onClick={() => updateAnchor(anchorIndex, (parts) => [...parts, { kind: 'operator', operator }])}>{operator}</button>)}
                <button type="button" className="fx-btn fx-btn-quiet fx-btn-sm" disabled={!canEditSchema || readOnly || !selectedField || !hasField} onClick={() => {
                  if (!selectedField) return;
                  const nextBinding = bind(anchor.id, selectedField);
                  updateAnchor(anchorIndex, (parts) => {
                    const prior = parts.filter((part) => part.kind === 'field').map((part, priority) => ({ ...part.binding, priority }));
                    const alternatives = [...prior.filter((item) => item.fieldKey !== nextBinding.fieldKey), { ...nextBinding, priority: prior.length }];
                    let inserted = false;
                    return parts.filter((part) => part.kind !== 'field').map((part) => part.kind === 'union' && !inserted ? (inserted = true, { ...part, alternatives }) : part).concat(inserted ? [] : [{ kind: 'union' as const, mode: 'first-match' as const, alternatives }]);
                  });
                }}><Plus className="h-3.5 w-3.5" />Объединить с выбранным полем</button>
              </div>
            </section>;
          })}
        </div>
      </section>

      <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
        {!shown.length && <Empty title="Полей не найдено" text={fields.length ? 'Измените запрос.' : 'Для выбранного проекта сервер не вернул поля.'} />}
        {[...groups.entries()].map(([sourceId, list]) => <section key={sourceId} className="mb-3"><h3 className="fx-group-title">{sourceTitle(sourceId)}</h3>
          {list.map((field) => {
            const active = selectedField?.sourceId === field.sourceId && selectedField.fieldKey === field.fieldKey;
            return <button key={`${field.sourceId}:${field.fieldKey}`} type="button" aria-pressed={active} onClick={() => onSelectField(field)} className={`fx-li w-full min-w-0 text-left ${active ? 'is-on' : ''}`}>
              <span className="min-w-0 flex-1 truncate">{field.displayName}</span>{field.unit && <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">{field.unit}</span>}
            </button>;
          })}
        </section>)}
      </div>
      <div className="shrink-0 border-t border-slate-200 px-3 py-2 text-xs dark:border-slate-800" aria-live="polite">
        {readOnly ? <p className="text-amber-700 dark:text-amber-300">Документ открыт для просмотра. Запросите право на правку.</p>
          : !selectedField ? <p className="text-slate-500 dark:text-slate-400">Выберите поле, затем щёлкните ячейку заголовка в документе.</p>
            : !activeAnchorId ? <p className="text-slate-600 dark:text-slate-300">Выбрано «{selectedField.displayName}». Щёлкните ячейку шапки, чтобы привязать поле.</p>
              : <p className="text-slate-600 dark:text-slate-300">Выбрано «{selectedField.displayName}» · активен якорь шапки.</p>}
      </div>
    </div>
  );
}

function partLabel(part: OfficePart): string {
  if (part.kind === 'field') return `⟦${part.binding.fieldKey}⟧`;
  if (part.kind === 'operator') return part.operator;
  if (part.kind === 'union') return `Первое непустое: ${part.alternatives.map((item) => item.fieldKey).join(' / ')}`;
  return part.text;
}

function sourceTitle(source: string) {
  const labels: Record<string, string> = { tags: 'Теги', equipment: 'Оборудование', management: 'Менеджмент', e3: 'E3Flux' };
  return labels[source] || source;
}
