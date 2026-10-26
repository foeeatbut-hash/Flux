/**
 * Разделы панели разработчика, которые правят записи справочника: модели,
 * комплектующие, правила тегов, источники (Excel, обмен), проверка и
 * пробный подбор. Рамка (шапка и боковая навигация) — CatalogStudio.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Plus, Search } from 'lucide-react';
import { Toolbar } from '../ui';
import { useCatalogStore } from '../../store/catalogStore';
import ContextMenu from '../ContextMenu';
import FamilyEditor from './FamilyEditor';
import DescribeMatch from './DescribeMatch';
import CatalogSpreadsheetPanel from './CatalogSpreadsheetPanel';
import { ClassDialog, FamilyDialog, ManufacturerDialog, SubtypeDialog, EQUIPMENT_TYPES, type EquipmentPreset } from './CatalogDialogs';
import { ComponentsPanel, TagRulesPanel, LearnedPanel, CheckPanel, ExchangePanel } from './CatalogPanels';
import type { Catalog } from '../../../catalog/model';
import { textOf } from '../../../catalog/model';
import type { CatalogMeta } from '../../services/catalogService';
import { Btn, Chip, Empty, Select, StatusChip } from './ui';

export type RecordSection = 'families' | 'components' | 'tags' | 'spreadsheet' | 'exchange' | 'check' | 'try' | 'learned';
type Dialog = 'class' | 'family' | 'manufacturer' | 'subtype' | null;

export default function CatalogManagement({ catalog, meta, rights, section, newModelToken, onChanged }: {
  catalog: Catalog; meta: CatalogMeta; rights: { edit: boolean; import: boolean }; section: RecordSection; newModelToken: number; onChanged: () => Promise<void>;
}) {
  const loaded = useCatalogStore((s) => s.loaded);
  const loadLearned = useCatalogStore((s) => s.loadLearned);
  const learned = useCatalogStore((s) => s.learned);
  const [section2, setSection2] = useState<RecordSection>(section);
  const [classId, setClassId] = useState('');
  const [openId, setOpenId] = useState('');
  const [q, setQ] = useState('');
  const [mf, setMf] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [preset, setPreset] = useState<EquipmentPreset>();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const { edit: canEdit, import: canImport } = rights;

  useEffect(() => { loadLearned(); }, [loadLearned]);
  // Раздел задаёт рамка; «Пробный подбор» и «Проверка» возвращают человека к модели — для этого есть собственный переход
  useEffect(() => { setSection2(section); }, [section]);
  useEffect(() => { if (!classId && catalog.classes[0]) setClassId(catalog.classes[0].id); }, [catalog.classes, classId]);
  const cls = catalog.classes.find((c) => c.id === classId);
  const cur = section2;
  const families = useMemo(() => {
    const low = q.trim().toLocaleLowerCase('ru');
    return catalog.families.filter((f) => f.classId === classId && (!mf || f.manufacturerId === mf))
      .filter((f) => !low || [f.code, textOf(f.title), textOf(f.description), ...(f.aliases || [])].some((s) => s.toLocaleLowerCase('ru').includes(low)))
      .sort((a, b) => (a.sort || 0) - (b.sort || 0));
  }, [catalog, classId, q, mf]);
  const open = catalog.families.find((f) => f.id === openId);
  const beginModel = () => { if (cls && catalog.manufacturers.length) setDialog('family'); };
  useEffect(() => { if (newModelToken) { setSection2('families'); beginModel(); } }, [newModelToken]); // eslint-disable-line react-hooks/exhaustive-deps
  const goModel = (id: string) => { setOpenId(id); setSection2('families'); };
  const classes = catalog.classes.map((c) => ({ value: c.id, label: `${textOf(c.title)} · ${catalog.families.filter((f) => f.classId === c.id).length}` }));
  const menuItems = [
    { label: 'Изготовитель', icon: <Plus className="h-4 w-4" />, onClick: () => setDialog('manufacturer') },
    ...(cls ? [{ label: `Подтип в «${textOf(cls.title)}»`, icon: <Plus className="h-4 w-4" />, onClick: () => setDialog('subtype') }] : []),
    { label: 'Тип оборудования', icon: <Plus className="h-4 w-4" />, separated: true, items: EQUIPMENT_TYPES.map((p) => ({ label: p.title, onClick: () => { setPreset(p); setDialog('class'); } })) },
  ];
  const typeBar = <Select value={classId} onChange={(v) => { setClassId(v); setOpenId(''); setMf(''); }} aria-label="Тип оборудования" className="w-auto max-w-56" options={classes} />;
  const wrap = (node: React.ReactNode) => <div className="min-h-0 flex-1 overflow-auto p-4">{node}</div>;

  return <div className="@container flex h-full min-h-0 flex-col">
    {!loaded ? <p className="p-4 text-xs text-[var(--flux-text-muted)]">Загружаю каталог…</p> : <>
      {cur === 'families' ? <>
        <Toolbar>
          {typeBar}
          <label className="fx-input flex min-w-[160px] max-w-[280px] flex-1 items-center gap-2 !px-2"><Search className="h-4 w-4 shrink-0 text-[var(--flux-text-muted)]" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Модель, код или описание" aria-label="Поиск модели" className="min-w-0 flex-1 bg-transparent outline-none" /></label>
          <Select value={mf} onChange={setMf} aria-label="Изготовитель" className="w-auto max-w-48" options={[{ value: '', label: 'Все изготовители' }, ...catalog.manufacturers.map((m) => ({ value: m.id, label: m.shortName || m.name }))]} />
          <span className="flex-1" />
          {canEdit && <Btn tone="ghost" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 4 }); }}><Plus />Добавить<ChevronDown /></Btn>}
        </Toolbar>
        <div className="grid min-h-0 flex-1 grid-cols-1 @[900px]:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]">
          <div className={`min-h-0 flex-col border-[var(--flux-line)] @[900px]:border-r ${open ? 'hidden @[900px]:flex' : 'flex'}`}>
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {families.map((f) => <button key={f.id} type="button" onClick={() => setOpenId(f.id)} aria-pressed={openId === f.id} aria-current={openId === f.id} className="fx-li !h-auto min-h-8 py-1">
                <span className="shrink-0 font-mono">{f.code}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--flux-text-muted)]">{textOf(f.title)}</span>
                {meta[f.id]?.edited && <Chip tone="sky">изменено</Chip>}{f.status !== 'full' && <StatusChip status={f.status} />}
              </button>)}
              {!families.length && <Empty title={catalog.families.some((f) => f.classId === classId) ? 'Модели не найдены' : 'В этом типе пока нет моделей'}
                text={q || mf ? 'Измените поиск или фильтр изготовителя.' : 'Добавьте модель, чтобы заполнить её параметры и характеристики.'}>
                {canEdit && <Btn onClick={beginModel} disabled={!cls || !catalog.manufacturers.length}><Plus />Добавить модель</Btn>}</Empty>}
            </div>
          </div>
          <div className={`min-h-0 overflow-auto p-4 ${open ? '' : 'hidden @[900px]:block'}`}>
            {open ? <div className="flex min-h-0 flex-col"><button type="button" onClick={() => setOpenId('')} className="mb-2 self-start text-xs text-[var(--flux-accent-text)] @[900px]:hidden">← К списку моделей</button>
              <FamilyEditor catalog={catalog} family={open} canEdit={canEdit} edited={meta[open.id]?.edited} onSaved={(f) => { setOpenId(f.id); void onChanged(); }} onDeleted={() => { setOpenId(''); void onChanged(); }} /></div>
              : <Empty title={cls ? `Модели: ${textOf(cls.title)}` : 'Выберите тип оборудования'} text={cls ? `В справочнике ${families.length} моделей типа «${textOf(cls.title)}». Выберите модель или создайте новую.` : 'Выберите существующий тип или добавьте свой. Типы не появляются в каталоге без вашего действия.'} />}
          </div>
        </div>
      </> : <>
        {['components', 'tags', 'spreadsheet', 'check', 'try'].includes(cur) && <Toolbar>{typeBar}</Toolbar>}
        {cur === 'components' && wrap(<ComponentsPanel catalog={catalog} classId={classId} canEdit={canEdit} />)}
        {cur === 'spreadsheet' && wrap(<CatalogSpreadsheetPanel catalog={catalog} classId={classId} canEdit={canImport} />)}
        {cur === 'tags' && wrap(<TagRulesPanel key={classId} catalog={catalog} classId={classId} canEdit={canEdit} />)}
        {cur === 'try' && wrap(<DescribeMatch catalog={catalog} classId={classId} learned={learned} acceptLabel="Показать модель" onAccept={(a) => goModel(a.familyId)} />)}
        {cur === 'learned' && wrap(<LearnedPanel catalog={catalog} />)}
        {cur === 'check' && wrap(<CheckPanel catalog={catalog} classId={classId} onOpen={goModel} />)}
        {cur === 'exchange' && wrap(<ExchangePanel canEdit={canImport} />)}
      </>}
    </>}
    {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
    {dialog === 'class' && <ClassDialog catalog={catalog} preset={preset} onClose={() => setDialog(null)} onDone={async (id) => { await onChanged(); setClassId(id); setMf(''); setOpenId(''); }} />}
    {dialog === 'manufacturer' && <ManufacturerDialog onClose={() => setDialog(null)} onDone={async (id) => { await onChanged(); setMf(id); }} />}
    {dialog === 'family' && cls && <FamilyDialog catalog={catalog} cls={cls} manufacturerId={mf} onClose={() => setDialog(null)} onDone={async (id) => { await onChanged(); setOpenId(id); }} />}
    {dialog === 'subtype' && cls && <SubtypeDialog cls={cls} onClose={() => setDialog(null)} onDone={onChanged} />}
  </div>;
}
