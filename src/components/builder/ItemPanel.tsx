/**
 * Карточка позиции: всё об одном клапане (или другом изделии) ведомости.
 *
 * Правка идёт в черновик и записывается кнопкой — поля, которые человек
 * поменял, отмечаются в `overrides`, и повторный импорт новой ревизии MTO их
 * не перезапишет, а покажет расхождение (flux-data-safety, п. 3).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Save, X, RefreshCcw, Undo2, Pencil } from 'lucide-react';
import type { Catalog, ValveValues } from '../../../catalog/model';
import { textOf } from '../../../catalog/model';
import type { SelectionItemData } from '../../../catalog/selection';
import { buildDesignation, parseWithFamily } from '../../../catalog/designation';
import { splitTagCell, derivedTag, tagRuleOf, tagTypeOf } from '../../../catalog/tags';
import Configurator from '../catalog/Configurator';
import FamilyPicker from '../catalog/FamilyPicker';
import { Area, Btn, Chip, Confidence, Field, Input, SectionTitle } from '../catalog/ui';

export default function ItemPanel({ catalog, item, onSave, onClose, onRematch }: {
  catalog: Catalog;
  item: SelectionItemData;
  onSave: (next: SelectionItemData, title: string) => Promise<void>;
  onClose: () => void;
  onRematch: (id: string) => void;
}) {
  const [draft, setDraft] = useState<SelectionItemData>(item);
  const [tagsText, setTagsText] = useState(item.tags.join(', '));
  const [picking, setPicking] = useState(!item.familyId);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft(item); setTagsText(item.tags.join(', ')); setPicking(!item.familyId); }, [item]);

  const family = draft.familyId ? catalog.families.find((f) => f.id === draft.familyId) : undefined;
  const dirty = JSON.stringify(draft) !== JSON.stringify(item) || tagsText !== item.tags.join(', ');
  const auto = family ? buildDesignation(family, draft.values).text : '';
  const rule = draft.tags[0] ? tagRuleOf(catalog.tagRules, draft.tags[0]) : undefined;
  const derived = useMemo(() => draft.tags.map((t) => derivedTag(t, tagTypeOf(t), rule?.actuatorCode)).filter(Boolean), [draft.tags, rule]);

  const mark = (field: string, patch: Partial<SelectionItemData>) => {
    setDraft((d) => ({ ...d, ...patch, overrides: [...new Set([...(d.overrides || []), field])] }));
  };

  const save = async () => {
    const tags = splitTagCell(tagsText).tags;
    const next: SelectionItemData = {
      ...draft,
      tags,
      overrides: tags.join(',') !== item.tags.join(',') ? [...new Set([...(draft.overrides || []), 'tags'])] : draft.overrides,
      designation: draft.designationManual ? draft.designation : auto,
      status: draft.familyId ? (draft.status === 'draft' ? 'matched' : draft.status) : 'draft',
    };
    setSaving(true);
    try { await onSave(next, `Правка позиции ${tags[0] || ''}`.trim()); } finally { setSaving(false); }
  };

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="flex items-center gap-2 pb-2 border-b border-slate-100 dark:border-slate-800">
        <b className="text-sm font-mono truncate min-w-0 flex-1">{item.tags[0] || 'Позиция без тега'}</b>
        <Confidence value={item.match?.confidence} />
        <Btn tone="ghost" onClick={onClose} aria-label="Закрыть"><X className="w-4 h-4" /></Btn>
      </div>
      <div className="flex-1 min-h-0 overflow-auto pr-1 @container">
        <div className="grid grid-cols-[minmax(0,1fr)_90px] gap-2 mt-2">
          <Field label="Теги" hint={`${splitTagCell(tagsText).tags.length} тег.${splitTagCell(tagsText).rest.length ? ` · не похоже на тег: ${splitTagCell(tagsText).rest.join(', ')}` : ''}`}>
            <Area rows={2} value={tagsText} onChange={(e) => setTagsText(e.target.value)} className="font-mono" />
          </Field>
          <Field label="Кол-во">
            <Input type="number" min={0} value={draft.qty} onChange={(e) => mark('qty', { qty: Number(e.target.value) || 0 })} className="tabular-nums" />
          </Field>
        </div>

        <SectionTitle right={family && <Btn tone="ghost" onClick={() => setPicking(!picking)}>{picking ? 'Отмена' : 'Сменить'}</Btn>}>
          Изделие{family ? `: ${family.code}` : ''}
        </SectionTitle>
        {(picking || !family) && (
          <FamilyPicker catalog={catalog} classId={draft.classId} value={draft.familyId} compact
            onPick={(f) => {
              // При смене семейства коды прежнего теряют смысл, а размер — нет
              const keep: ValveValues = {};
              for (const k of ['W', 'H', 'D']) if (draft.values[k] !== undefined) keep[k] = draft.values[k];
              mark('familyId', { familyId: f.id, values: keep, designationManual: false });
              setPicking(false);
            }} />
        )}
        {family && !picking && (
          <>
            <Configurator family={family} values={draft.values} onChange={(values) => mark('values', { values })} />
            <SectionTitle>Обозначение для бланка</SectionTitle>
            <label className="flex items-center gap-1.5 text-2xs text-slate-500 dark:text-slate-400 cursor-pointer">
              <input type="checkbox" checked={!!draft.designationManual}
                onChange={(e) => mark('designation', { designationManual: e.target.checked, designation: e.target.checked ? draft.designation || auto : auto })} />
              <Pencil className="w-3 h-3" /> Задать руками (не пересобирать из параметров)
            </label>
            {draft.designationManual ? (
              <div className="flex flex-col gap-1 mt-1">
                <Input value={draft.designation} onChange={(e) => mark('designation', { designation: e.target.value })} className="font-mono" />
                {!parseWithFamily(family, draft.designation).complete && <span className="text-2xs text-amber-700 dark:text-amber-400">Строка не разбирается по позициям {family.code} — проверьте перед выпуском.</span>}
              </div>
            ) : <div className="font-mono text-xs mt-1 break-all u-sel">{auto}</div>}
          </>
        )}

        <SectionTitle>Привод и коробка</SectionTitle>
        <div className="grid grid-cols-1 @[480px]:grid-cols-2 gap-2">
          <Field label="Марка привода" hint="Пусто — из обозначения">
            <Input value={draft.actuator?.model || ''} onChange={(e) => mark('actuator', { actuator: { ...draft.actuator, model: e.target.value } })} className="font-mono" />
          </Field>
          <Field label="Теги приводов" hint={derived.length ? `по правилу: ${derived.join(', ')}` : 'правила для кода тега нет'}>
            <Input value={(draft.actuator?.tags || []).join(', ')} placeholder={derived.join(', ')}
              onChange={(e) => mark('actuator', { actuator: { ...draft.actuator, tags: splitTagCell(e.target.value).tags } })} className="font-mono" />
          </Field>
          <Field label="Теги коробок">
            <Input value={(draft.actuator?.boxTags || []).join(', ')} onChange={(e) => mark('actuator', { actuator: { ...draft.actuator, boxTags: splitTagCell(e.target.value).tags } })} className="font-mono" />
          </Field>
          <Field label="Маркировка коробки">
            <Input value={draft.actuator?.boxModel || ''} onChange={(e) => mark('actuator', { actuator: { ...draft.actuator, boxModel: e.target.value } })} className="font-mono" />
          </Field>
          <Field label="Кабельные вводы" className="@[480px]:col-span-2">
            <Input value={draft.actuator?.glands || ''} onChange={(e) => mark('actuator', { actuator: { ...draft.actuator, glands: e.target.value } })} />
          </Field>
        </div>

        {(family?.facts?.heating || draft.values.heating || draft.heating?.voltage || family?.params.some((p) => p.values?.some((v) => v.facts?.heating))) && (
          <>
            <SectionTitle>Обогрев</SectionTitle>
            <div className="grid grid-cols-2 @[480px]:grid-cols-4 gap-2">
              {(['voltage', 'kw300', 'kwStart', 'sections'] as const).map((k) => (
                <Field key={k} label={{ voltage: 'Напряжение, В', kw300: 'кВт после 300 с', kwStart: 'Пусковая, кВт', sections: 'Секций' }[k]}>
                  <Input value={draft.heating?.[k] || ''} onChange={(e) => mark('heating', { heating: { ...draft.heating, [k]: e.target.value } })} className="tabular-nums" />
                </Field>
              ))}
            </div>
          </>
        )}

        <SectionTitle>Примечание</SectionTitle>
        <Area rows={2} value={draft.notes || ''} onChange={(e) => mark('notes', { notes: e.target.value })} />

        {(item.sourceText || item.match) && (
          <>
            <SectionTitle right={item.sourceText && <Btn tone="ghost" onClick={() => onRematch(item.id)}><RefreshCcw className="w-3.5 h-3.5" /> Подобрать заново</Btn>}>
              Откуда
            </SectionTitle>
            {item.sourceRef && (
              <div className="flex flex-wrap gap-1 mb-1">
                {item.sourceRef.file && <Chip>{item.sourceRef.file}</Chip>}
                {item.sourceRef.sheet && <Chip>лист {item.sourceRef.sheet}</Chip>}
                {item.sourceRef.row ? <Chip>строка {item.sourceRef.row}</Chip> : null}
                {item.sourceRef.rev && <Chip>рев. {item.sourceRef.rev}</Chip>}
              </div>
            )}
            {item.sourceText && <div className="text-2xs text-slate-500 dark:text-slate-400 whitespace-pre-wrap break-words u-sel max-h-40 overflow-auto">{item.sourceText}</div>}
            {item.match?.reasons?.length ? (
              <ul className="mt-1 flex flex-wrap gap-1">
                {item.match.reasons.slice(0, 12).map((r, i) => (
                  <li key={i}><Chip tone={r.status === 'mismatch' ? 'rose' : r.status === 'unknown' ? 'slate' : r.status === 'learned' ? 'sky' : 'emerald'}>{r.text}</Chip></li>
                ))}
              </ul>
            ) : null}
          </>
        )}
        {(draft.overrides || []).length > 0 && (
          <div className="mt-2 text-2xs text-slate-400">Правлено руками: {(draft.overrides || []).join(', ')} — импорт эти поля не перезапишет.</div>
        )}
        {family && <div className="mt-2 text-2xs text-slate-400">{textOf(family.title)}{family.catalog ? ` · ${family.catalog.file}, стр. ${family.catalog.pages || '—'}` : ''}</div>}
      </div>
      <div className="flex items-center gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
        <Btn tone="primary" onClick={save} disabled={!dirty || saving}><Save className="w-3.5 h-3.5" /> {saving ? 'Сохраняю…' : 'Сохранить'}</Btn>
        <Btn tone="ghost" onClick={() => { setDraft(item); setTagsText(item.tags.join(', ')); }} disabled={!dirty}><Undo2 className="w-3.5 h-3.5" /> Вернуть</Btn>
        {dirty && <span className="text-2xs text-amber-700 dark:text-amber-400">есть несохранённые правки</span>}
      </div>
    </div>
  );
}
