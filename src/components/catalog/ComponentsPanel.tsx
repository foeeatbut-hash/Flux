import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import type { Catalog, Component, FamilyStatus } from '../../../catalog/model';
import { textOf } from '../../../catalog/model';
import CatalogSectionEditor from './CatalogSectionEditor';
import { catalogService } from '../../services/catalogService';
import { useToastStore } from '../../store/toastStore';
import { factsToText, textToFacts } from './ParamsEditor';
import { Btn, Chip, Empty, Field, Input, Select, confirmAsk } from './ui';

const KINDS: Array<{ value: Component['kind']; label: string }> = [
  { value: 'actuator', label: 'привод' }, { value: 'box', label: 'коробка' }, { value: 'gland', label: 'кабельный ввод' },
  { value: 'heater', label: 'обогрев' }, { value: 'frame', label: 'рама' }, { value: 'other', label: 'прочее' },
];
const STATUSES: Array<{ value: FamilyStatus; label: string }> = [
  { value: 'draft', label: 'черновик' }, { value: 'partial', label: 'сверить' }, { value: 'full', label: 'сверено' },
];
type ListMode = 'class' | 'all';
type VersionedComponent = Component & { _draftVersion?: string; _publishedHash?: string };
const componentContent = (item: VersionedComponent) => {
  const { _draftVersion: _version, _publishedHash: _hash, ...content } = item;
  return content;
};

const applicableClasses = (component: Component) => [...new Set([component.classId, ...(component.classIds || [])].filter(Boolean))];
const knownManufacturer = (catalog: Catalog, value: string) => catalog.manufacturers.find((m) => m.name === value || m.shortName === value);

function blankComponent(classId: string): Component {
  return { id: `cmp-${Math.random().toString(36).slice(2, 9)}`, classId, classIds: [classId], kind: 'other', code: '', title: { ru: '' }, specs: [] };
}

export function ComponentsPanel({ catalog, classId, canEdit }: { catalog: Catalog; classId: string; canEdit: boolean }) {
  const addToast = useToastStore((s) => s.addToast);
  const [edit, setEdit] = useState<VersionedComponent | null>(null);
  const [savedEdit, setSavedEdit] = useState<VersionedComponent | null>(null);
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [mode, setMode] = useState<ListMode>('class');
  const [familyPicker, setFamilyPicker] = useState(false);
  const dirty = !!edit && !!savedEdit && JSON.stringify(componentContent(edit)) !== JSON.stringify(componentContent(savedEdit));
  const freshComponent = edit ? catalog.components.find((item) => item.id === edit.id) as VersionedComponent | undefined : undefined;
  const incomingFingerprint = JSON.stringify([edit?.id || null, freshComponent || null]);
  const lastObservedProps = useRef(incomingFingerprint);
  const lastAppliedProps = useRef(incomingFingerprint);
  const ownSaveBlockedProps = useRef<string | null>(null);
  const selectionId = useRef<string | null>(edit?.id || null);

  const list = useMemo(() => catalog.components.filter((c) => {
    if (mode === 'class' && !applicableClasses(c).includes(classId)) return false;
    if (kind && (c.equipmentType || c.kind) !== kind) return false;
    const needle = query.trim().toLocaleLowerCase('ru');
    const manufacturer = catalog.manufacturers.find((m) => m.id === c.manufacturerId);
    return !needle || [c.code, textOf(c.title), c.manufacturer || '', manufacturer?.name || '', manufacturer?.shortName || '', c.catalog?.file || ''].some((x) => x.toLocaleLowerCase('ru').includes(needle));
  }).sort((a, b) => a.code.localeCompare(b.code, 'ru')), [catalog.components, catalog.manufacturers, classId, kind, mode, query]);

  // При смене выбранного типа не оставляем форму модели, которая пропала из списка.
  useEffect(() => {
    if (mode === 'class' && edit && !applicableClasses(edit).includes(classId)) { setEdit(null); setSavedEdit(null); }
  }, [classId, edit, mode]);

  useEffect(() => {
    if (!edit) return;
    const fresh = freshComponent;
    if (selectionId.current !== edit.id) {
      selectionId.current = edit.id;
      lastObservedProps.current = incomingFingerprint;
      lastAppliedProps.current = incomingFingerprint;
      ownSaveBlockedProps.current = null;
      return;
    }
    if (incomingFingerprint !== lastObservedProps.current) lastObservedProps.current = incomingFingerprint;
    if (incomingFingerprint === ownSaveBlockedProps.current) return;
    if (incomingFingerprint === lastAppliedProps.current) return;
    if (!fresh) {
      if (dirty) setSaveError('Комплектующее удалено или скрыто после начала правки. Ваши значения сохранены; проверьте актуальный каталог.');
      else { setEdit(null); setSavedEdit(null); lastAppliedProps.current = incomingFingerprint; }
      return;
    }
    if (dirty) {
      setSaveError('Данные изменились после начала правки. Ваши значения сохранены; сверите изменения перед повторным сохранением.');
      return;
    }
    const replacement = {
      ...fresh,
      manufacturer: fresh.manufacturer || catalog.manufacturers.find((item) => item.id === fresh.manufacturerId)?.name || '',
    } as VersionedComponent;
    setEdit(replacement);
    setSavedEdit(replacement);
    lastAppliedProps.current = incomingFingerprint;
    setSaveError('');
  }, [incomingFingerprint, dirty, edit?.id, catalog.manufacturers]);

  const update = (patch: Partial<Component>) => setEdit((current) => current ? { ...current, ...patch } : current);
  const toggleClass = (id: string, checked: boolean) => {
    if (!edit) return;
    const ids = new Set(applicableClasses(edit));
    if (checked) ids.add(id);
    else if (id !== edit.classId) ids.delete(id);
    // Основной classId остаётся применимым даже при снятии всех вторичных типов.
    setEdit({ ...edit, classIds: [...ids] });
  };
  const toggleFamily = (id: string, checked: boolean) => {
    if (!edit) return;
    const ids = new Set(edit.familyIds || []);
    if (checked) ids.add(id); else ids.delete(id);
    setEdit({ ...edit, familyIds: [...ids] });
  };
  const updateSpec = (index: number, patch: Partial<NonNullable<Component['specs']>[number]>) => {
    if (!edit) return;
    setEdit({ ...edit, specs: (edit.specs || []).map((spec, i) => i === index ? { ...spec, ...patch } : spec) });
  };
  const setManufacturer = (value: string) => {
    const match = knownManufacturer(catalog, value);
    update({ manufacturer: value, manufacturerId: match?.id });
  };
  const selectComponent = (component: Component) => { setSaveError(''); const selected = {
    ...component,
    manufacturer: component.manufacturer || catalog.manufacturers.find((m) => m.id === component.manufacturerId)?.name || '',
  } as VersionedComponent; setEdit(selected); setSavedEdit(selected); };
  const startNewComponent = () => { const fresh = blankComponent(classId); setSaveError(''); setEdit(fresh); setSavedEdit(fresh); };
  const save = async () => {
    if (!edit || saving) return;
    setSaving(true);
    try {
      const normalized = { ...edit, classIds: [...new Set([edit.classId, ...(edit.classIds || [])])] } as VersionedComponent;
      const result = await catalogService.save('component', normalized);
      ownSaveBlockedProps.current = incomingFingerprint;
      lastAppliedProps.current = incomingFingerprint;
      setEdit((current) => {
        if (current?.id !== normalized.id) return current;
        const saved = { ...current, _draftVersion: result.revision };
        delete saved._publishedHash;
        return saved;
      });
      const committed = { ...normalized, _draftVersion: result.revision };
      delete committed._publishedHash;
      setSavedEdit(committed);
      setSaveError('');
      addToast('Сохранено', 'success');
    } catch (e: any) { setSaveError(e?.message || 'Не сохранилось'); addToast(e?.message || 'Не сохранилось', 'error'); }
    finally { setSaving(false); }
  };

  const mfListId = 'catalog-component-manufacturers';
  return (
    <div className="grid grid-cols-1 @[900px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 h-full min-h-0">
      <section className="flex min-h-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск модели или изготовителя" aria-label="Поиск модели или изготовителя" className="min-w-[180px] flex-1" />
          <Select value={kind} onChange={setKind} aria-label="Тип комплектующего" className="w-auto" options={[{ value: '', label: 'все типы' }, ...KINDS]} />
          <div className="fx-segctl" role="group" aria-label="Область комплектующих">
            <button type="button" aria-pressed={mode === 'class'} onClick={() => setMode('class')}>Для выбранного типа</button>
            <button type="button" aria-pressed={mode === 'all'} onClick={() => setMode('all')}>Все комплектующие</button>
          </div>
          {canEdit && <Btn onClick={startNewComponent}><Plus className="w-3.5 h-3.5" /> Комплектующее</Btn>}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {!list.length ? <Empty title="Комплектующие не найдены" text={query || kind ? 'Измените условия поиска или фильтр.' : 'Добавьте комплектующее для этого типа оборудования.'} /> : (
            <table className="fx-table text-left">
              <thead><tr><th>Код</th><th>Название модели</th><th>Изготовитель</th><th>Тип</th></tr></thead>
              <tbody>{list.map((c) => (
                <tr key={c.id} onClick={() => selectComponent(c)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectComponent(c); } }} tabIndex={0} role="button" aria-selected={edit?.id === c.id} className="cursor-pointer">
                  <td className="font-mono">{c.code || '—'}</td>
                  <td>{textOf(c.title) || '—'}</td>
                  <td>{c.manufacturer || catalog.manufacturers.find((m) => m.id === c.manufacturerId)?.name || '—'}</td>
                  <td><Chip>{KINDS.find((k) => k.value === (c.equipmentType || c.kind))?.label || c.equipmentType || 'прочее'}</Chip></td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      </section>

      {edit ? <section className="min-h-0 overflow-auto border-l border-slate-200 dark:border-slate-800 pl-3 flex flex-col gap-2">
        <div className="grid grid-cols-1 @[600px]:grid-cols-2 gap-2">
          <Field label="Код"><Input value={edit.code} onChange={(e) => update({ code: e.target.value })} className="font-mono" disabled={!canEdit} /></Field>
          <Field label="Собственный тип комплектующего"><Select value={edit.equipmentType || edit.kind} onChange={(v) => update({ kind: v as Component['kind'], equipmentType: v })} options={KINDS} disabled={!canEdit} /></Field>
          <Field label="Название модели"><Input value={edit.title.ru} onChange={(e) => update({ title: { ...edit.title, ru: e.target.value } })} disabled={!canEdit} /></Field>
          <Field label="Изготовитель" hint="Не зависит от изготовителя изделия. Можно указать нового текстом.">
            <><Input list={mfListId} value={edit.manufacturer || ''} onChange={(e) => setManufacturer(e.target.value)} disabled={!canEdit} /><datalist id={mfListId}>{catalog.manufacturers.map((m) => <option key={m.id} value={m.name}>{m.shortName}</option>)}</datalist></>
          </Field>
        </div>

        <Field label="Признаки для подбора" hint="Например: voltage=24; ex=true"><Input value={factsToText(edit.facts)} onChange={(e) => update({ facts: textToFacts(e.target.value) })} className="font-mono" disabled={!canEdit} /></Field>

        <div className="fx-field">
          <span className="fx-label">Применяется в оборудовании</span>
          <div className="grid grid-cols-1 @[600px]:grid-cols-2 gap-x-3 gap-y-1 text-xs">
            {catalog.classes.map((cls) => <label key={cls.id} className="flex items-center gap-2 min-h-7">
              <input type="checkbox" checked={applicableClasses(edit).includes(cls.id)} onChange={(e) => toggleClass(cls.id, e.target.checked)} disabled={!canEdit || cls.id === edit.classId} />
              <span>{textOf(cls.title)}{cls.id === edit.classId ? ' · основной тип' : ''}</span>
            </label>)}
          </div>
        </div>

        <div className="fx-field">
          <button type="button" className="text-left fx-label hover:text-slate-800 dark:hover:text-slate-200" aria-expanded={familyPicker} onClick={() => setFamilyPicker(!familyPicker)}>
            Семейства {edit.familyIds?.length ? `· выбрано ${edit.familyIds.length}` : '· не ограничено'}
          </button>
          {familyPicker && <div className="max-h-40 overflow-auto border border-slate-200 dark:border-slate-700 rounded p-1 grid grid-cols-1 @[600px]:grid-cols-2 gap-x-2">
            {catalog.families.filter((f) => applicableClasses(edit).includes(f.classId)).map((family) => <label key={family.id} className="flex items-center gap-2 min-h-7 text-xs">
              <input type="checkbox" checked={(edit.familyIds || []).includes(family.id)} onChange={(e) => toggleFamily(family.id, e.target.checked)} disabled={!canEdit} />
              <span className="font-mono">{family.code}</span><span className="truncate">{textOf(family.title)}</span>
            </label>)}
          </div>}
        </div>

        <div className="grid grid-cols-1 @[600px]:grid-cols-3 gap-2">
          <Field label="Источник PDF"><Input value={edit.catalog?.file || ''} onChange={(e) => update({ catalog: { ...(edit.catalog || { file: '' }), file: e.target.value } })} disabled={!canEdit} /></Field>
          <Field label="Страницы каталога"><Input value={edit.catalog?.pages || ''} onChange={(e) => update({ catalog: { ...(edit.catalog || { file: '' }), pages: e.target.value } })} disabled={!canEdit} /></Field>
          <Field label="Страница PDF"><Input type="number" min="1" value={edit.sourcePdfPage || ''} onChange={(e) => update({ sourcePdfPage: e.target.value ? Number(e.target.value) : undefined })} disabled={!canEdit} /></Field>
          <Field label="Редакция"><Input value={edit.catalog?.edition || ''} onChange={(e) => update({ catalog: { ...(edit.catalog || { file: '' }), edition: e.target.value } })} disabled={!canEdit} /></Field>
          <Field label="Статус сверки"><Select value={edit.status || 'draft'} onChange={(v) => update({ status: v as FamilyStatus })} options={STATUSES} disabled={!canEdit} /></Field>
          <Field label="Что сверить"><Input value={(edit.todo || []).join('; ')} onChange={(e) => update({ todo: e.target.value.split(';').map((v) => v.trim()).filter(Boolean) })} disabled={!canEdit} /></Field>
        </div>

        <div className="fx-field">
          <span className="fx-label">Характеристики</span>
          {(edit.specs || []).map((spec, i) => <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_90px_auto] gap-1 items-center">
            <Field label="Параметр"><Input value={spec.label.ru} onChange={(e) => updateSpec(i, { label: { ...spec.label, ru: e.target.value } })} disabled={!canEdit} /></Field>
            <Field label="Значение"><Input value={spec.value} onChange={(e) => updateSpec(i, { value: e.target.value })} disabled={!canEdit} /></Field>
            <Field label="Ед. изм."><Input value={spec.unit || ''} onChange={(e) => updateSpec(i, { unit: e.target.value })} disabled={!canEdit} /></Field>
            {canEdit && <Btn tone="ghost" onClick={() => update({ specs: (edit.specs || []).filter((_, j) => j !== i) })} aria-label="Удалить характеристику"><Trash2 className="w-3 h-3" /></Btn>}
          </div>)}
          {canEdit && <Btn onClick={() => update({ specs: [...(edit.specs || []), { label: { ru: '' }, value: '' }] })}><Plus className="w-3 h-3" /> Характеристика</Btn>}
        </div>

        <CatalogSectionEditor sections={edit.sections || []} readOnly={!canEdit} onChange={sections => update({ sections })} />
        {saveError && <div role="alert" className="text-xs text-rose-600 dark:text-rose-400">{saveError}</div>}
        {canEdit && <div className="flex gap-2 mt-auto pt-2">
          {!edit.id.startsWith('cmp-') && <Btn tone="danger" disabled={saving} onClick={async () => { if (await confirmAsk('Удалить комплектующее?', edit.code, { confirmLabel: 'Удалить', tone: 'danger' })) { try { await catalogService.remove('component', edit.id, edit._draftVersion); setSaveError(''); setEdit(null); setSavedEdit(null); } catch (e: any) { setSaveError(e?.message || 'Не удалось удалить комплектующее'); addToast(e?.message || 'Не удалось удалить комплектующее', 'error'); } } }}><Trash2 className="w-3.5 h-3.5" /> Удалить</Btn>}
          <span className="flex-1" /><Btn tone="primary" onClick={save} disabled={saving}><Save className="w-3.5 h-3.5" /> {saving ? 'Сохраняем…' : 'Сохранить'}</Btn>
        </div>}
      </section> : <section className="hidden @[900px]:flex items-start justify-center border-l border-slate-200 dark:border-slate-800 pl-3 text-xs text-slate-500 dark:text-slate-400"><Empty title="Выберите комплектующее" text="Нажмите строку, чтобы посмотреть или изменить модель." /></section>}
    </div>
  );
}
