/**
 * Карточка выбранной позиции: конфигурация изделия, количество и источник.
 *
 * Правка идёт в черновик и записывается кнопкой — поля, которые человек
 * поменял, отмечаются в `overrides`, и повторный импорт новой ревизии MTO их
 * не перезапишет, а покажет расхождение (flux-data-safety, п. 3).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Save, X, RefreshCcw, Undo2, Pencil, Sparkles } from 'lucide-react';
import type { Catalog, Family, ValveValues } from '../../../catalog/model';
import { textOf } from '../../../catalog/model';
import type { SelectionItemData } from '../../../catalog/selection';
import { buildDesignation, parseWithFamily } from '../../../catalog/designation';
import { splitTagCell, derivedTag, tagRuleOf, tagTypeOf } from '../../../catalog/tags';
import Configurator from '../catalog/Configurator';
import FamilyPicker from '../catalog/FamilyPicker';
import DescribeMatch, { type Accepted } from '../catalog/DescribeMatch';
import type { Learned } from '../../../catalog/match';
import { Area, Btn, Chip, Confidence, Field, Input, SectionTitle } from '../catalog/ui';
import DataIssueDialog from '../catalog/DataIssueDialog';
import type { CatalogDataIssueContext } from '../../../feedback/catalogDataIssue';

function parseQtyInput(raw: string): number | null {
  const normalized = raw.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

export default function ItemPanel({ catalog, item, learned, onSave, onClose, onRematch, onMatch }: {
  catalog: Catalog;
  item: SelectionItemData;
  learned: Learned[];
  /** Записанная позиция — или undefined, если не записалось */
  onSave: (next: SelectionItemData, title: string) => Promise<SelectionItemData | undefined>;
  onClose: () => void;
  onRematch: (id: string) => void;
  onMatch: (id: string, accepted: Accepted) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<SelectionItemData>(item);
  const [tagsText, setTagsText] = useState(item.tags.join(', '));
  const [qtyText, setQtyText] = useState(String(item.qty));
  const [picking, setPicking] = useState(!item.familyId);
  const [saving, setSaving] = useState(false);
  const [matching, setMatching] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);
  const draftRef = React.useRef(draft); draftRef.current = draft;
  const tagsRef = React.useRef(tagsText); tagsRef.current = tagsText;
  const qtyRef = React.useRef(qtyText); qtyRef.current = qtyText;
  /**
   * Позиция перечиталась (своё сохранение, чужая правка, отмена). Несохранённый
   * черновик при этом не перетираем: человек его набирал. Он уйдёт с прежней
   * версией, и сервер ответит «уже изменили» — тогда «Вернуть» покажет свежую
   */
  const shown = React.useRef(item);
  const [changedMeanwhile, setChangedMeanwhile] = useState(false);
  useEffect(() => {
    const prev = shown.current;
    shown.current = item;
    const wasDirty = prev.id === item.id && (JSON.stringify(draftRef.current) !== JSON.stringify(prev) || tagsRef.current !== prev.tags.join(', ') || qtyRef.current !== String(prev.qty));
    if (prev.id !== item.id) setMatching(false);
    if (wasDirty) {
      // Правки остаются, версия — свежая: следующее «Сохранить» запишет своё
      // уже осознанно, поверх показанного предупреждения
      setDraft((d) => ({ ...d, updatedAt: item.updatedAt }));
      setChangedMeanwhile(true);
      return;
    }
    setDraft(item); setTagsText(item.tags.join(', ')); setQtyText(String(item.qty)); setPicking(!item.familyId); setChangedMeanwhile(false);
  }, [item]);

  const family = draft.familyId ? catalog.families.find((f) => f.id === draft.familyId) : undefined;
  const equipmentClass = catalog.classes.find((c) => c.id === draft.classId);
  const hasActuatorFields = equipmentClass?.code === 'valve';
  const parsedTags = splitTagCell(tagsText);
  const qtyValue = parseQtyInput(qtyText);
  const dirty = JSON.stringify(draft) !== JSON.stringify(item) || tagsText !== item.tags.join(', ') || qtyText !== String(item.qty);
  const auto = family ? buildDesignation(family, draft.values).text : '';
  const rule = draft.tags[0] ? tagRuleOf(catalog.tagRules, draft.tags[0]) : undefined;
  const derived = useMemo(() => draft.tags.map((t) => derivedTag(t, tagTypeOf(t), rule?.actuatorCode)).filter(Boolean), [draft.tags, rule]);

  const mark = (field: string, patch: Partial<SelectionItemData>) => {
    setDraft((d) => ({ ...d, ...patch, overrides: [...new Set([...(d.overrides || []), field])] }));
  };

  const save = async () => {
    if (qtyValue === null || parsedTags.rest.length) return;
    const tags = parsedTags.tags;
    const next: SelectionItemData = {
      ...draft,
      tags,
      qty: qtyValue,
      overrides: [...new Set([
        ...(draft.overrides || []),
        ...(tags.join(',') !== item.tags.join(',') ? ['tags'] : []),
        ...(qtyValue !== item.qty ? ['qty'] : []),
      ])],
      designation: draft.designationManual ? draft.designation : auto,
      status: draft.familyId ? (draft.status === 'draft' ? 'matched' : draft.status) : 'draft',
    };
    setSaving(true);
    try {
      const saved = await onSave(next, `Правка позиции ${tags[0] || ''}`.trim());
      if (saved) { shown.current = saved; setDraft(saved); setTagsText(saved.tags.join(', ')); setQtyText(String(saved.qty)); setChangedMeanwhile(false); }
    } finally { setSaving(false); }
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
            <Input type="text" inputMode="decimal" value={qtyText} onChange={(e) => setQtyText(e.target.value)} className="tabular-nums" aria-invalid={qtyValue === null} />
          </Field>
        </div>
        {qtyValue === null && <div className="text-2xs text-rose-600 dark:text-rose-400">Количество не распознано. Исправьте значение; исходный ввод сохранён.</div>}
        {parsedTags.rest.length > 0 && <div className="text-2xs text-rose-600 dark:text-rose-400">Не распознаны части тега: {parsedTags.rest.join(', ')}. Исправьте ввод; эти фрагменты не будут отброшены молча.</div>}

        <SectionTitle right={<div className="flex gap-1">
          <Btn tone="ghost" onClick={() => setMatching((v) => !v)} disabled={dirty}><Sparkles className="w-3.5 h-3.5" /> {matching ? 'К модели' : 'Подбор по описанию'}</Btn>
          {family && !matching && <Btn tone="ghost" onClick={() => setPicking(!picking)}>{picking ? 'Отмена' : 'Сменить'}</Btn>}
        </div>}>
          {equipmentClass?.itemName ? textOf(equipmentClass.itemName) : 'Изделие'}{family ? `: ${family.code}` : ''}
        </SectionTitle>
        {matching && <div className="mt-2">
          {catalog.classes.some((c) => c.id === draft.classId) && <DescribeMatch catalog={catalog} classId={draft.classId} learned={learned}
            initialText={item.sourceText || ''} acceptLabel="Применить к позиции"
            onAccept={(accepted) => { void onMatch(item.id, accepted).then((saved) => { if (saved) setMatching(false); }); }} />}
        </div>}
        {!matching && (picking || !family) && (
          <FamilyPicker catalog={catalog} classId={draft.classId} value={draft.familyId} compact
            onPick={(f) => {
              // Сохраняются общие параметры семейств одного класса; чужие коды
              // остаются за пределами новой конфигурации.
              const keep: ValveValues = {};
              const keys = new Set(f.params.map((p) => p.key));
              for (const [key, value] of Object.entries(draft.values)) if (keys.has(key)) keep[key] = value;
              mark('familyId', { familyId: f.id, values: keep, designationManual: false });
              setPicking(false);
            }} />
        )}
        {!matching && family && !picking && (
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
                {family.designationMode !== 'free' && !parseWithFamily(family, draft.designation).complete && <span className="text-2xs text-amber-700 dark:text-amber-400">Строка не разбирается по позициям {family.code} — проверьте перед выпуском.</span>}
              </div>
            ) : <div className="font-mono text-xs mt-1 break-all u-sel">{auto}</div>}
          </>
        )}

        {hasActuatorFields && <>
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
        </>}

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
        {family && <div className="mt-2 flex items-center gap-2 flex-wrap">
          <span className="text-2xs text-slate-400">{textOf(family.title)}{family.catalog ? ` · ${family.catalog.file}, стр. ${family.catalog.pages || '—'}` : ''}</span>
          <span className="flex-1" />
          <Btn tone="ghost" onClick={() => setIssueOpen(true)}>Сообщить о неточности</Btn>
        </div>}
      </div>
      <div className="flex items-center gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
        <Btn tone="primary" onClick={save} disabled={!dirty || saving || qtyValue === null || parsedTags.rest.length > 0}><Save className="w-3.5 h-3.5" /> {saving ? 'Сохраняю…' : 'Сохранить'}</Btn>
        <Btn tone="ghost" onClick={() => { setDraft(item); setTagsText(item.tags.join(', ')); setQtyText(String(item.qty)); setChangedMeanwhile(false); }} disabled={!dirty}><Undo2 className="w-3.5 h-3.5" /> Вернуть</Btn>
        {changedMeanwhile && dirty
          ? <span className="text-2xs text-rose-600 dark:text-rose-400">позицию изменили, пока вы правили: «Сохранить» запишет ваше, «Вернуть» покажет свежее</span>
          : dirty && <span className="text-2xs text-amber-700 dark:text-amber-400">есть несохранённые правки</span>}
      </div>
      {issueOpen && family && <DataIssueDialog context={dataIssueContext(family, draft.values, item.tags)} onClose={() => setIssueOpen(false)} />}
    </div>
  );
}

function dataIssueContext(family: Family, values: SelectionItemData['values'], tags: string[]): CatalogDataIssueContext {
  const designation = buildDesignation(family, values).text;
  const catalog = family.catalog;
  return {
    program: 'builder',
    entityId: family.id,
    entityTitle: `${family.code} · ${textOf(family.title)}${tags.length ? ` · позиция ${tags.slice(0, 3).join(', ')}${tags.length > 3 ? ` и ещё ${tags.length - 3}` : ''}` : ''}`.slice(0, 400),
    field: [family.designationMode === 'article' || family.designationMode === 'free' ? 'Артикул или марка' : 'Обозначение изделия', tags.length ? `позиция ${tags.slice(0, 3).join(', ')}` : ''].filter(Boolean).join(' · ').slice(0, 200),
    currentValue: designation,
    ...(family.version !== undefined ? { revision: String(family.version) } : {}),
    ...(catalog?.file?.trim() ? { source: { file: catalog.file, ...(catalog.pages ? { pages: catalog.pages } : {}), ...(catalog.edition ? { edition: catalog.edition } : {}) } } : {}),
  };
}
