/** Общий справочник оборудования, изготовителей, моделей и комплектующих. */
import React, { useEffect, useMemo, useState } from 'react';
import { Factory, FileSpreadsheet, Layers, Plus, Search, Tag as TagIcon, Wrench, Sparkles, Brain, ShieldCheck, ArrowLeftRight } from 'lucide-react';
import { Tabs } from '../ui';
import { useCatalogStore } from '../../store/catalogStore';
import { useToastStore } from '../../store/toastStore';
import SectionErrorBoundary from '../SectionErrorBoundary';
import FamilyEditor from './FamilyEditor';
import DescribeMatch from './DescribeMatch';
import CatalogSpreadsheetPanel from './CatalogSpreadsheetPanel';
import { ComponentsPanel, TagRulesPanel, LearnedPanel, CheckPanel, ExchangePanel } from './CatalogPanels';
import { catalogService } from '../../services/catalogService';
import { useCatalogLive } from './useCatalogLive';
import type { Family, EquipmentClass, Manufacturer } from '../../../catalog/model';
import { textOf, t2 } from '../../../catalog/model';
import { Btn, Chip, Empty, Field, Input, Select, StatusChip } from './ui';

type Tab = 'families' | 'components' | 'spreadsheet' | 'tags' | 'try' | 'learned' | 'check' | 'exchange';
type Dialog = 'class' | 'family' | 'manufacturer' | 'subtype' | null;
const TABS: Array<{ id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'families', label: 'Модели оборудования', icon: Layers }, { id: 'components', label: 'Компоненты и модели', icon: Wrench },
  { id: 'spreadsheet', label: 'Excel', icon: FileSpreadsheet }, { id: 'tags', label: 'Правила тегов', icon: TagIcon },
  { id: 'try', label: 'Пробный подбор', icon: Sparkles }, { id: 'learned', label: 'Выученное', icon: Brain },
  { id: 'check', label: 'Проверка', icon: ShieldCheck }, { id: 'exchange', label: 'Обмен', icon: ArrowLeftRight },
];
const EQUIPMENT_TYPES = [
  { title: 'Вентилятор', item: 'вентилятор' }, { title: 'Вентиляционная установка', item: 'вентиляционная установка' },
  { title: 'Насос', item: 'насос' }, { title: 'Теплообменник', item: 'теплообменник' },
  { title: 'Клапан', item: 'клапан' }, { title: 'Привод', item: 'привод' },
  { title: 'Автоматика', item: 'устройство автоматики' }, { title: 'Произвольный тип', item: '' },
];
const idFor = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

function blankFamily(cls: EquipmentClass, manufacturerId: string, code: string, title: string, kind: string): Family {
  return {
    id: idFor('fam'), classId: cls.id, manufacturerId, code, title: t2(title), kind,
    typeLabel: t2(textOf(cls.itemName)), shapes: [], params: [],
    positions: [{ key: 'series', label: t2('Обозначение'), formats: [code] }],
    rules: [], match: { kinds: [kind] }, specs: [], status: 'draft', examples: [], sort: 999,
  };
}

export default function CatalogManagement({ catalog, meta, rights, onChanged }: { catalog: import('../../../catalog/model').Catalog; meta: import('../../services/catalogService').CatalogMeta; rights: { edit: boolean; import: boolean }; onChanged: () => Promise<void> }) {
  const loaded = useCatalogStore((s) => s.loaded);
  const error = useCatalogStore((s) => s.error);
  const load = onChanged;
  const loadLearned = useCatalogStore((s) => s.loadLearned);
  const learned = useCatalogStore((s) => s.learned);
  const addToast = useToastStore((s) => s.addToast);
  const [tab, setTab] = useState<Tab>(rights.edit ? 'families' : 'spreadsheet');
  const [classId, setClassId] = useState('');
  const [openId, setOpenId] = useState('');
  const [q, setQ] = useState('');
  const [mf, setMf] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [classTitle, setClassTitle] = useState('');
  const [classItem, setClassItem] = useState('');
  const [manufacturer, setManufacturer] = useState<Manufacturer>({ id: '', name: '', shortName: '' });
  const [modelCode, setModelCode] = useState('');
  const [modelTitle, setModelTitle] = useState('');
  const [modelKind, setModelKind] = useState('');
  const [subtypeTitle, setSubtypeTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const canEdit = rights.edit;
  const canImport = rights.import;

  useEffect(() => { loadLearned(); }, [loadLearned]);
  useCatalogLive();
  useEffect(() => { if (!classId && catalog.classes[0]) setClassId(catalog.classes[0].id); }, [catalog.classes, classId]);
  const cls = catalog.classes.find((c) => c.id === classId);
  const families = useMemo(() => {
    const low = q.trim().toLocaleLowerCase('ru');
    return catalog.families.filter((f) => f.classId === classId && (!mf || f.manufacturerId === mf))
      .filter((f) => !low || [f.code, textOf(f.title), textOf(f.description), ...(f.aliases || [])].some((s) => s.toLocaleLowerCase('ru').includes(low)))
      .sort((a, b) => (a.sort || 0) - (b.sort || 0));
  }, [catalog, classId, q, mf]);
  const open = catalog.families.find((f) => f.id === openId);
  const beginModel = () => {
    setModelCode(''); setModelTitle('');
    setModelKind(cls?.facts.find((f) => f.key === 'kind')?.values?.[0]?.code || '');
    setDialog('family');
  };
  const submitClass = async (e: React.FormEvent) => {
    e.preventDefault();
    const title = classTitle.trim();
    const itemName = classItem.trim();
    if (!title || !itemName) return;
    const classId = idFor('cls');
    const code = title.toLocaleLowerCase('ru').replace(/[^a-zа-я0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 18) || 'equipment';
    const c: EquipmentClass = {
      id: classId, code: `${code}-${classId.slice(-5)}`,
      title: t2(title), itemName: t2(itemName),
      facts: [{ key: 'kind', label: t2('Подтип'), type: 'choice', hard: true, values: [{ code: 'default', label: t2(title) }] }],
      sort: catalog.classes.length + 1,
    };
    setBusy(true);
    try { await catalogService.save('class', c); await load(); setClassId(c.id); setMf(''); setOpenId(''); setDialog(null); addToast('Тип оборудования добавлен', 'success'); }
    catch (e: any) { addToast(e?.message || 'Не удалось добавить тип', 'error'); }
    finally { setBusy(false); }
  };
  const submitManufacturer = async (e: React.FormEvent) => {
    e.preventDefault();
    const item = { ...manufacturer, name: manufacturer.name.trim(), shortName: manufacturer.shortName.trim() };
    if (!item.name || !item.shortName) return;
    setBusy(true);
    try { await catalogService.save('manufacturer', item); await load(); setMf(item.id); setDialog(null); addToast('Изготовитель добавлен', 'success'); }
    catch (e: any) { addToast(e?.message || 'Не удалось добавить изготовителя', 'error'); }
    finally { setBusy(false); }
  };
  const submitFamily = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cls || !modelCode.trim() || !modelTitle.trim() || !mf) return;
    const item = blankFamily(cls, mf, modelCode.trim(), modelTitle.trim(), modelKind || 'default');
    setBusy(true);
    try { await catalogService.save('family', item); await load(); setOpenId(item.id); setDialog(null); addToast('Модель добавлена. Характеристики можно заполнить в карточке.', 'success'); }
    catch (e: any) { addToast(e?.message || 'Не удалось добавить модель', 'error'); }
    finally { setBusy(false); }
  };
  const submitSubtype = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cls || !subtypeTitle.trim()) return;
    const factIndex = cls.facts.findIndex((fact) => fact.key === 'kind');
    const existing = factIndex >= 0 ? cls.facts[factIndex] : { key: 'kind', label: t2('Подтип'), type: 'choice' as const, hard: true, values: [] };
    const base = subtypeTitle.trim().toLocaleLowerCase('ru').replace(/[^a-zа-я0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 24) || 'subtype';
    const codes = new Set((existing.values || []).map((value) => value.code));
    let code = base; let suffix = 2;
    while (codes.has(code)) code = `${base}-${suffix++}`;
    const facts = [...cls.facts];
    const updatedFact = { ...existing, values: [...(existing.values || []), { code, label: t2(subtypeTitle.trim()) }] };
    if (factIndex >= 0) facts[factIndex] = updatedFact; else facts.push(updatedFact);
    setBusy(true);
    try { await catalogService.save('class', { ...cls, facts }); await load(); setDialog(null); setSubtypeTitle(''); addToast('Подтип добавлен', 'success'); }
    catch (e: any) { addToast(e?.message || 'Не удалось добавить подтип', 'error'); }
    finally { setBusy(false); }
  };
  const openNewType = (preset: typeof EQUIPMENT_TYPES[number]) => {
    setClassTitle(preset.title === 'Произвольный тип' ? '' : preset.title);
    setClassItem(preset.item); setDialog('class');
  };
  const chooseEquipmentType = (preset: typeof EQUIPMENT_TYPES[number]) => {
    if (preset.title === 'Произвольный тип') { openNewType(preset); return; }
    const normalized = preset.title.toLocaleLowerCase('ru').replace(/ё/g, 'е');
    const existing = catalog.classes.find((item) => {
      const title = textOf(item.title).toLocaleLowerCase('ru').replace(/ё/g, 'е');
      return title === normalized || (preset.title === 'Клапан' && title.includes('клапан'));
    });
    if (existing) { setClassId(existing.id); setOpenId(''); setMf(''); }
    else openNewType(preset);
  };

  return <SectionErrorBoundary title="Каталог">
    <div className="h-full flex flex-col min-h-0 @container gap-2">
      <div className="flex min-h-11 items-center gap-2 flex-wrap">
        <b className="text-base font-semibold">Каталог оборудования</b>
        <span className="text-xs text-slate-500 dark:text-slate-400">{catalog.classes.length} типов · {catalog.families.length} моделей · {catalog.components.length} компонентов</span>
        <span className="flex-1" />
        {canEdit && <Btn tone="primary" onClick={beginModel} disabled={!cls || !catalog.manufacturers.length}><Plus className="w-3.5 h-3.5" /> Новая модель</Btn>}
      </div>
      <div className="flex items-center gap-2 text-sm"><span>Инструмент редактора</span><Select value={tab} onChange={v => setTab(v as Tab)} options={TABS.map(({id,label}) => ({value:id,label}))} aria-label="Инструмент редактора" className="w-auto max-w-full" /></div>
      {error && <div className="text-xs text-rose-600 dark:text-rose-400">{error}</div>}
      <div className="flex-1 min-h-0">
        {!loaded ? <div className="text-xs text-slate-500 dark:text-slate-400">Загружаю каталог…</div> : <>
          {tab === 'families' && <div className="h-full min-h-0 flex flex-col gap-2">
            <section aria-label="Типы оборудования" className="border-b border-slate-200 dark:border-slate-800 pb-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-slate-500 dark:text-slate-400">Тип оборудования</span>
                <Select value={classId} onChange={(v) => { setClassId(v); setOpenId(''); setMf(''); }} aria-label="Тип оборудования" className="w-auto max-w-full"
                  options={catalog.classes.map((c) => ({ value: c.id, label: `${textOf(c.title)} · ${catalog.families.filter((f) => f.classId === c.id).length}` }))} />
                {canEdit && <Btn tone="ghost" onClick={() => { setManufacturer({ id: idFor('mf'), name: '', shortName: '' }); setDialog('manufacturer'); }}><Factory className="w-3.5 h-3.5" /> Изготовитель</Btn>}
                {canEdit && cls && <Btn tone="ghost" onClick={() => { setSubtypeTitle(''); setDialog('subtype'); }}><Plus className="w-3.5 h-3.5" /> Подтип</Btn>}
                {canEdit && <Btn tone="ghost" onClick={() => setDialog('class')}><Plus className="w-3.5 h-3.5" /> Тип оборудования</Btn>}
                <span className="flex-1" />
                <span className="text-xs text-slate-500 dark:text-slate-400">{cls ? textOf(cls.itemName) : 'Тип не выбран'}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                <span>Типы оборудования:</span>{EQUIPMENT_TYPES.map((p) => <Btn key={p.title} tone="ghost" onClick={() => chooseEquipmentType(p)}>{catalog.classes.some((item) => textOf(item.title).toLocaleLowerCase('ru').includes(p.title.toLocaleLowerCase('ru')) && p.title !== 'Произвольный тип') ? '' : <Plus className="w-3 h-3" />}{p.title}</Btn>)}
              </div>
            </section>
            <div className="flex-1 min-h-0 grid grid-cols-1 @[900px]:grid-cols-[minmax(240px,300px)_minmax(0,1fr)] gap-3">
              <div className={`min-h-0 flex-col gap-2 ${open ? 'hidden @[900px]:flex' : 'flex'}`}>
                <div className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700">
                  <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Модель, код или описание" aria-label="Поиск модели" className="flex-1 min-w-0 bg-transparent text-xs outline-none" />
                </div>
                <div className="flex items-center gap-1"><Factory className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <Select value={mf} onChange={setMf} aria-label="Изготовитель" options={[{ value: '', label: 'Все изготовители' }, ...catalog.manufacturers.map((m) => ({ value: m.id, label: m.shortName || m.name }))]} />
                  {canEdit && <Btn tone="ghost" onClick={() => { setManufacturer({ id: idFor('mf'), name: '', shortName: '' }); setDialog('manufacturer'); }} title="Добавить изготовителя"><Plus className="w-3.5 h-3.5" /></Btn>}
                </div>
                {canEdit && <Btn onClick={beginModel} disabled={!cls || !catalog.manufacturers.length}><Plus className="w-3.5 h-3.5" /> Модель оборудования</Btn>}
                <div className="flex-1 min-h-0 overflow-auto pr-1">
                  {families.map((f) => <button key={f.id} type="button" onClick={() => setOpenId(f.id)} aria-pressed={openId === f.id}
                    className={`w-full text-left rounded px-2 py-1 cursor-pointer flex items-center gap-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/40 ${openId === f.id ? 'bg-slate-100 dark:bg-slate-800' : ''}`}>
                    <span className="font-mono text-xs min-w-0 truncate">{f.code}</span><span className="flex-1" />
                    <span className="text-xs text-slate-500 dark:text-slate-400 truncate">{textOf(f.title)}</span>{meta[f.id]?.edited && <Chip tone="sky">изменено</Chip>}{f.status !== 'full' && <StatusChip status={f.status} />}
                  </button>)}
                  {!families.length && <Empty title={catalog.families.some((f) => f.classId === classId) ? 'Модели не найдены' : 'В этом типе пока нет моделей'}
                    text={q || mf ? 'Измените поиск или фильтр изготовителя.' : 'Добавьте модель, чтобы заполнить её параметры и характеристики.'}>
                    {canEdit && <Btn onClick={beginModel} disabled={!cls || !catalog.manufacturers.length}><Plus className="w-3.5 h-3.5" /> Добавить модель</Btn>}
                  </Empty>}
                </div>
              </div>
              <div className="min-h-0">
                {open ? <div className="h-full min-h-0 flex flex-col"><button type="button" onClick={() => setOpenId('')} className="@[900px]:hidden text-left text-xs text-emerald-700 dark:text-emerald-400 mb-1">← К списку моделей</button>
                  <FamilyEditor catalog={catalog} family={open} canEdit={canEdit} edited={meta[open.id]?.edited} onSaved={(f) => { setOpenId(f.id); void load(); }} onDeleted={() => { setOpenId(''); void load(); }} /></div>
                  : <Empty title={cls ? `Модели: ${textOf(cls.title)}` : 'Выберите тип оборудования'} text={cls ? `В справочнике ${families.length} моделей типа «${textOf(cls.title)}». Выберите модель или создайте новую.` : 'Выберите существующий тип или добавьте свой. Типы не появляются в каталоге без вашего действия.'} />}
              </div>
            </div>
          </div>}
          {tab === 'components' && <div className="h-full overflow-auto"><ComponentsPanel catalog={catalog} classId={classId} canEdit={canEdit} /></div>}
          {tab === 'spreadsheet' && <div className="h-full overflow-auto"><CatalogSpreadsheetPanel catalog={catalog} classId={classId} canEdit={canImport} /></div>}
          {tab === 'tags' && <div className="h-full overflow-auto"><TagRulesPanel key={classId} catalog={catalog} classId={classId} canEdit={canEdit} /></div>}
          {tab === 'try' && <div className="h-full overflow-auto"><DescribeMatch catalog={catalog} classId={classId} learned={learned} acceptLabel="Показать модель" onAccept={(a) => { setOpenId(a.familyId); setTab('families'); }} /></div>}
          {tab === 'learned' && <div className="h-full overflow-auto"><LearnedPanel catalog={catalog} /></div>}
          {tab === 'check' && <div className="h-full overflow-auto"><CheckPanel catalog={catalog} classId={classId} onOpen={(id) => { setOpenId(id); setTab('families'); }} /></div>}
          {tab === 'exchange' && <div className="h-full overflow-auto"><ExchangePanel canEdit={canImport} /></div>}
        </>}
      </div>

      {dialog === 'class' && <div className="fixed inset-0 z-50 bg-black/30 dark:bg-black/60 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Новый тип оборудования" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setDialog(null); }}>
        <form onSubmit={submitClass} className="w-full max-w-lg rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-4 flex flex-col gap-3">
          <h2 className="text-base font-semibold">Новый тип оборудования</h2>
          <div className="flex flex-wrap gap-1">{EQUIPMENT_TYPES.map((p) => <Btn key={p.title} tone="ghost" onClick={() => openNewType(p)}>{p.title}</Btn>)}</div>
          <div className="grid grid-cols-1 @[480px]:grid-cols-2 gap-3">
            <Field label="Тип оборудования"><Input autoFocus value={classTitle} onChange={(e) => setClassTitle(e.target.value)} placeholder="Например, насос" required /></Field>
            <Field label="Название одной позиции"><Input value={classItem} onChange={(e) => setClassItem(e.target.value)} placeholder="Например, насос" required /></Field>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">Новый тип появится после сохранения. Подтипы и характеристики можно настроить в карточках моделей.</p>
          <div className="flex justify-end gap-2"><Btn onClick={() => setDialog(null)} disabled={busy}>Отмена</Btn><Btn tone="primary" disabled={busy || !classTitle.trim() || !classItem.trim()}>Добавить тип</Btn></div>
        </form>
      </div>}
      {dialog === 'manufacturer' && <div className="fixed inset-0 z-50 bg-black/30 dark:bg-black/60 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Новый изготовитель" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setDialog(null); }}>
        <form onSubmit={submitManufacturer} className="w-full max-w-md rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-4 flex flex-col gap-3">
          <h2 className="text-base font-semibold">Новый изготовитель</h2>
          <Field label="Полное название"><Input autoFocus value={manufacturer.name} onChange={(e) => setManufacturer({ ...manufacturer, name: e.target.value })} placeholder="ООО «Пример»" required /></Field>
          <Field label="Короткое название"><Input value={manufacturer.shortName} onChange={(e) => setManufacturer({ ...manufacturer, shortName: e.target.value })} placeholder="Пример" required /></Field>
          <div className="flex justify-end gap-2"><Btn onClick={() => setDialog(null)} disabled={busy}>Отмена</Btn><Btn tone="primary" disabled={busy || !manufacturer.name.trim() || !manufacturer.shortName.trim()}>Добавить изготовителя</Btn></div>
        </form>
      </div>}
      {dialog === 'family' && cls && <div className="fixed inset-0 z-50 bg-black/30 dark:bg-black/60 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Новая модель оборудования" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setDialog(null); }}>
        <form onSubmit={submitFamily} className="w-full max-w-lg rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-4 flex flex-col gap-3">
          <h2 className="text-base font-semibold">Новая модель · {textOf(cls.title)}</h2>
          <div className="grid grid-cols-1 @[480px]:grid-cols-2 gap-3">
            <Field label="Изготовитель"><Select value={mf} onChange={setMf} options={catalog.manufacturers.map((m) => ({ value: m.id, label: m.name }))} /></Field>
            <Field label="Подтип"><Select value={modelKind} onChange={setModelKind} options={(cls.facts.find((f) => f.key === 'kind')?.values || []).map((v) => ({ value: v.code, label: textOf(v.label) }))} /></Field>
            <Field label="Марка или код"><Input autoFocus value={modelCode} onChange={(e) => setModelCode(e.target.value)} placeholder="Например, ВКРС" required /></Field>
            <Field label="Название модели"><Input value={modelTitle} onChange={(e) => setModelTitle(e.target.value)} placeholder="Например, вентилятор радиальный" required /></Field>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">После создания заполните обозначение, параметры и характеристики в карточке модели.</p>
          <div className="flex justify-end gap-2"><Btn onClick={() => setDialog(null)} disabled={busy}>Отмена</Btn><Btn tone="primary" disabled={busy || !mf || !modelCode.trim() || !modelTitle.trim()}>Добавить модель</Btn></div>
        </form>
      </div>}
      {dialog === 'subtype' && cls && <div className="fixed inset-0 z-50 bg-black/30 dark:bg-black/60 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Добавить подтип" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setDialog(null); }}>
        <form onSubmit={submitSubtype} className="w-full max-w-md rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-4 flex flex-col gap-3">
          <h2 className="text-base font-semibold">Подтип · {textOf(cls.title)}</h2>
          <Field label="Название подтипа"><Input autoFocus value={subtypeTitle} onChange={(e) => setSubtypeTitle(e.target.value)} placeholder="Например, дымовой" required /></Field>
          <div className="text-xs text-slate-500 dark:text-slate-400">Существующие подтипы: {(cls.facts.find((fact) => fact.key === 'kind')?.values || []).map((value) => textOf(value.label)).join(', ') || 'пока нет'}</div>
          <div className="flex justify-end gap-2"><Btn onClick={() => setDialog(null)} disabled={busy}>Отмена</Btn><Btn tone="primary" disabled={busy || !subtypeTitle.trim()}>Добавить подтип</Btn></div>
        </form>
      </div>}
    </div>
  </SectionErrorBoundary>;
}
