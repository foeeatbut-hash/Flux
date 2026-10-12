import React, { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Save, Search, X } from 'lucide-react';
import { Btn, Empty, Input } from '../ui';
import type { OfficeBinding, OfficeHeaderSchema, OfficePart } from '../../lib/officeModel';
import type { OfficeField, OfficeState } from './fluxData';
import { insertOfficeHeaderPart, mergeOfficeHeaderBinding, moveOfficeHeaderPart, removeOfficeHeaderBinding, removeOfficeHeaderPart } from './officeHeaderEditor';

interface Props {
  fields: OfficeField[];
  state: OfficeState | null;
  forceSave?: boolean;
  saveBlocked?: boolean;
  selectedField: OfficeField | null;
  activeAnchorId: string;
  readOnly: boolean;
  canEditSchema: boolean;
  onSelectField: (field: OfficeField) => void;
  onSaveSchema: (schema: OfficeHeaderSchema, options?: { displayLabels?: Record<string, string> }) => Promise<boolean>;
}

export default function FluxFieldsPanel({ fields, state, forceSave = false, saveBlocked = false, selectedField, activeAnchorId, readOnly, canEditSchema, onSelectField, onSaveSchema }: Props) {
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
  const changed = !!draft && !!state && (forceSave || JSON.stringify(draft) !== JSON.stringify(state.schema));

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
    try {
      const displayLabels = Object.fromEntries(fields.map((field) => [`${field.sourceId}:${field.fieldKey}`, field.displayName]));
      if (!(await onSaveSchema(draft, { displayLabels }))) throw new Error('Редактор не подтвердил сохранение схемы.');
    }
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
          <Btn tone="primary" disabled={!changed || !canEditSchema || readOnly || saveBlocked || saving} onClick={() => void saveSchema()}>{saving ? 'Сохраняем…' : <><Save className="h-3.5 w-3.5" />Сохранить схему</>}</Btn>
        </div>
        {forceSave && <p role="status" className="px-3 pb-2 text-xs text-slate-600 dark:text-slate-300">Шаблон сопоставлен с этим документом. Сохраните схему, чтобы применить его.</p>}
        {error && <p role="alert" className="px-3 pb-2 text-xs text-rose-700 dark:text-rose-300">{error}</p>}
        {!state && <p className="px-3 pb-2 text-xs text-amber-700 dark:text-amber-300">Состояние документа ещё загружается или недоступно.</p>}
        {!canEditSchema && state && !readOnly && <p className="px-3 pb-2 text-xs text-amber-700 dark:text-amber-300">Схема недоступна для изменения в этом документе.</p>}
        {readOnly && <p className="px-3 pb-2 text-xs text-amber-700 dark:text-amber-300">Документ открыт только для просмотра.</p>}
        <div className="max-h-52 overflow-auto px-3 pb-3">
          {!draft?.anchors.length && <p className="text-xs text-slate-500 dark:text-slate-400">Щёлкните ячейку заголовка в документе, выберите поле и привяжите его.</p>}
          {draft?.anchors.map((anchor, anchorIndex) => {
            const active = activeAnchorId === anchor.id;
            const hasField = anchor.parts.some((part) => part.kind === 'field');
            return <section key={anchor.id} className={`border-t border-slate-200 py-2 first:border-0 dark:border-slate-800 ${active ? 'bg-slate-50 dark:bg-slate-900/50' : ''}`}>
              <div className="flex items-center justify-between gap-2"><h4 title={anchor.id} className="min-w-0 truncate text-xs font-semibold text-slate-800 dark:text-dark-text-main">{anchor.sheetName ? `${anchor.sheetName}!` : ''}{anchor.address || `Ячейка шапки ${anchorIndex + 1}`}</h4><span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">{active ? 'активная ячейка' : anchor.kind === 'word-row' ? 'Word' : 'Excel'}</span></div>
              <div className="mt-1 space-y-1">
                {anchor.parts.map((part, partIndex) => <div key={`${anchor.id}:${partIndex}`} className="flex min-w-0 items-center gap-1">
                  {part.kind === 'text' ? <Input aria-label={`Текст заголовка ${partIndex + 1}`} disabled={!canEditSchema || readOnly} value={part.text} onChange={(event) => updateAnchor(anchorIndex, (parts) => parts.map((item, at) => at === partIndex && item.kind === 'text' ? { ...item, text: event.target.value } : item))} />
                    : part.kind === 'operator' ? <select aria-label={`Оператор заголовка ${partIndex + 1}`} className="h-7 min-w-0 flex-1 rounded border border-slate-200 bg-white px-2 text-xs dark:border-slate-700 dark:bg-dark-surface dark:text-dark-text-main" disabled={!canEditSchema || readOnly} value={part.operator} onChange={(event) => updateAnchor(anchorIndex, (parts) => parts.map((item, at) => item.kind === 'operator' && at === partIndex ? { ...item, operator: event.target.value as typeof item.operator } : item))}>{['+', '-', '*', '/', '(', ')'].map((operator) => <option key={operator} value={operator}>{operator}</option>)}</select>
                      : part.kind === 'union' ? <span role="group" aria-label={partLabel(part, fields)} className="flex min-w-0 flex-1 flex-wrap items-center gap-1 rounded border border-slate-200 px-2 py-1 text-xs text-slate-800 dark:border-slate-700 dark:text-dark-text-main">
                        <span className="shrink-0 text-slate-500 dark:text-slate-400">Первое непустое:</span>
                        {part.alternatives.map((binding) => <span key={`${binding.sourceId}:${binding.fieldKey}`} className="inline-flex items-center gap-0.5 rounded bg-slate-100 px-1 dark:bg-slate-800">
                          {fields.find((field) => field.sourceId === binding.sourceId && field.fieldKey === binding.fieldKey)?.displayName || 'Поле'}
                          <button type="button" aria-label={`Удалить поле ${binding.fieldKey} из объединения`} title="Удалить поле из объединения" disabled={!canEditSchema || readOnly} className="rounded p-0.5 text-slate-500 disabled:opacity-30" onClick={() => updateAnchor(anchorIndex, (parts) => removeOfficeHeaderBinding(parts, partIndex, binding))}><X className="h-3 w-3" /></button>
                        </span>)}
                      </span>
                        : <span className="min-w-0 flex-1 truncate rounded border border-slate-200 px-2 py-1 text-xs text-slate-800 dark:border-slate-700 dark:text-dark-text-main">{partLabel(part, fields)}</span>}
                  <button type="button" aria-label={`Переместить часть ${partIndex + 1} выше`} title="Выше" disabled={!canEditSchema || readOnly || partIndex === 0} className="rounded p-1 text-slate-500 disabled:opacity-30" onClick={() => updateAnchor(anchorIndex, (parts) => moveOfficeHeaderPart(parts, partIndex, partIndex - 1))}><ArrowUp className="h-3.5 w-3.5" /></button>
                  <button type="button" aria-label={`Переместить часть ${partIndex + 1} ниже`} title="Ниже" disabled={!canEditSchema || readOnly || partIndex === anchor.parts.length - 1} className="rounded p-1 text-slate-500 disabled:opacity-30" onClick={() => updateAnchor(anchorIndex, (parts) => moveOfficeHeaderPart(parts, partIndex, partIndex + 1))}><ArrowDown className="h-3.5 w-3.5" /></button>
                  <button type="button" aria-label={`Добавить текст после части ${partIndex + 1}`} title="Добавить текст после" disabled={!canEditSchema || readOnly} className="rounded p-1 text-slate-500 disabled:opacity-30" onClick={() => updateAnchor(anchorIndex, (parts) => insertOfficeHeaderPart(parts, partIndex + 1, { kind: 'text', text: '' }))}><Plus className="h-3.5 w-3.5" /></button>
                  <button type="button" aria-label={part.kind === 'field' ? 'Удалить привязку поля' : part.kind === 'union' ? 'Удалить объединение полей' : 'Удалить часть заголовка'} title={part.kind === 'field' ? 'Удалить привязку' : part.kind === 'union' ? 'Удалить объединение' : 'Удалить часть'} disabled={!canEditSchema || readOnly} className="rounded p-1 text-slate-500 disabled:opacity-30" onClick={() => updateAnchor(anchorIndex, (parts) => part.kind === 'field' ? removeOfficeHeaderBinding(parts, partIndex, part.binding) : removeOfficeHeaderPart(parts, partIndex))}><X className="h-3.5 w-3.5" /></button>
                </div>)}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button type="button" className="fx-btn fx-btn-quiet fx-btn-sm" disabled={!canEditSchema || readOnly} onClick={() => updateAnchor(anchorIndex, (parts) => insertOfficeHeaderPart(parts, parts.length, { kind: 'text', text: '' }))}><Plus className="h-3.5 w-3.5" />Текст</button>
                {(['+', '-', '*', '/', '(', ')'] as const).map((operator) => <button key={operator} type="button" className="fx-btn fx-btn-quiet fx-btn-sm" aria-label={`Добавить оператор ${operator}`} disabled={!canEditSchema || readOnly} onClick={() => updateAnchor(anchorIndex, (parts) => insertOfficeHeaderPart(parts, parts.length, { kind: 'operator', operator }))}>{operator}</button>)}
                <button type="button" className="fx-btn fx-btn-quiet fx-btn-sm" disabled={!canEditSchema || readOnly || !selectedField || !hasField} onClick={() => {
                  if (!selectedField) return;
                  const nextBinding = bind(anchor.id, selectedField);
                  updateAnchor(anchorIndex, (parts) => mergeOfficeHeaderBinding(parts, parts.findIndex((part) => part.kind === 'field' || part.kind === 'union'), nextBinding));
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

function partLabel(part: OfficePart, fields: OfficeField[]): string {
  const name = (binding: OfficeBinding) => fields.find((field) => field.sourceId === binding.sourceId && field.fieldKey === binding.fieldKey)?.displayName || 'Поле';
  if (part.kind === 'field') return `⟦${name(part.binding)}⟧`;
  if (part.kind === 'operator') return part.operator;
  if (part.kind === 'union') return `Первое непустое: ${part.alternatives.map(name).join(' / ')}`;
  return part.text;
}

function sourceTitle(source: string) {
  const labels: Record<string, string> = { tags: 'Теги', equipment: 'Оборудование', management: 'Менеджмент', e3: 'E3Flux' };
  return labels[source] || source;
}
