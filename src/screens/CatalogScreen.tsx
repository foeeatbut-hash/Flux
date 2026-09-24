/**
 * Каталог — справочник оборудования программы.
 *
 * Не проектный: данные живут в программе и одинаковы во всех проектах. Здесь
 * заводят и сверяют семейства (позиции обозначения, коды, правила), приводы и
 * коробки, правила тегов; отсюда Конструктор берёт всё для подбора и бланков.
 * Первый класс — клапаны ВЕЗА из семи каталогов; другие классы и заводы
 * добавляются здесь же, без правки программы.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Search, Plus, Layers, Wrench, Tag as TagIcon, Sparkles, Brain, ShieldCheck, ArrowLeftRight, Factory } from 'lucide-react';
import { useStore } from '../store/store';
import { useCatalogStore } from '../store/catalogStore';
import { useToastStore } from '../store/toastStore';
import { can } from '../lib/permissions';
import SectionErrorBoundary from '../components/SectionErrorBoundary';
import FamilyEditor from '../components/catalog/FamilyEditor';
import DescribeMatch from '../components/catalog/DescribeMatch';
import { ComponentsPanel, TagRulesPanel, LearnedPanel, CheckPanel, ExchangePanel } from '../components/catalog/CatalogPanels';
import { catalogService } from '../services/catalogService';
import { useCatalogLive } from '../components/catalog/useCatalogLive';
import type { Family, EquipmentClass } from '../../catalog/model';
import { textOf, t2 } from '../../catalog/model';
import { Btn, Chip, Empty, Select, StatusChip, promptAsk } from '../components/catalog/ui';

type Tab = 'families' | 'components' | 'tags' | 'try' | 'learned' | 'check' | 'exchange';

const TABS: Array<{ id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'families', label: 'Семейства', icon: Layers },
  { id: 'components', label: 'Комплектующие', icon: Wrench },
  { id: 'tags', label: 'Правила тегов', icon: TagIcon },
  { id: 'try', label: 'Пробный подбор', icon: Sparkles },
  { id: 'learned', label: 'Выученное', icon: Brain },
  { id: 'check', label: 'Проверка', icon: ShieldCheck },
  { id: 'exchange', label: 'Обмен', icon: ArrowLeftRight },
];

function blankFamily(classId: string, manufacturerId: string, code: string): Family {
  return {
    id: `fam-${Math.random().toString(36).slice(2, 10)}`, classId, manufacturerId, code,
    title: t2(code), kind: 'air', typeLabel: t2(''), shapes: ['rect'],
    params: [
      { key: 'W', label: t2('Ширина', 'Width'), kind: 'number', size: 'W', unit: 'мм', step: 'size' },
      { key: 'H', label: t2('Высота', 'Height'), kind: 'number', size: 'H', unit: 'мм', step: 'size' },
      { key: 'D', label: t2('Диаметр', 'Diameter'), kind: 'number', size: 'D', unit: 'мм', step: 'size' },
    ],
    positions: [
      { key: 'series', label: t2('Обозначение'), formats: [code] },
      { key: 'size', label: t2('Сечение'), formats: ['{W}{x}{H}', '{D}'] },
    ],
    rules: [], match: { kinds: [] }, specs: [], status: 'draft', examples: [], sort: 999,
  };
}

export default function CatalogScreen() {
  const user = useStore((s) => s.user);
  const catalog = useCatalogStore((s) => s.catalog);
  const meta = useCatalogStore((s) => s.meta);
  const loaded = useCatalogStore((s) => s.loaded);
  const error = useCatalogStore((s) => s.error);
  const load = useCatalogStore((s) => s.load);
  const loadLearned = useCatalogStore((s) => s.loadLearned);
  const learned = useCatalogStore((s) => s.learned);
  const addToast = useToastStore((s) => s.addToast);
  const [tab, setTab] = useState<Tab>('families');
  const [classId, setClassId] = useState('');
  const [openId, setOpenId] = useState('');
  const [q, setQ] = useState('');
  const [mf, setMf] = useState('');
  const canEdit = can(user as any, 'catalog.manage');

  useEffect(() => { load(); loadLearned(); }, [load, loadLearned]);
  useCatalogLive();
  useEffect(() => { if (!classId && catalog.classes[0]) setClassId(catalog.classes[0].id); }, [catalog.classes, classId]);
  const cls = catalog.classes.find((c) => c.id === classId);

  const families = useMemo(() => {
    const low = q.trim().toLowerCase();
    return catalog.families
      .filter((f) => f.classId === classId && (!mf || f.manufacturerId === mf))
      .filter((f) => !low || [f.code, textOf(f.title), textOf(f.description), ...(f.aliases || [])].some((s) => s.toLowerCase().includes(low)))
      .sort((a, b) => (a.sort || 0) - (b.sort || 0));
  }, [catalog, classId, q, mf]);
  const kindLabel = (k: string) => textOf(cls?.facts.find((f) => f.key === 'kind')?.values?.find((v) => v.code === k)?.label) || k;
  const grouped = useMemo(() => {
    const m = new Map<string, Family[]>();
    for (const f of families) m.set(f.kind, [...(m.get(f.kind) || []), f]);
    return [...m.entries()];
  }, [families]);
  const open = catalog.families.find((f) => f.id === openId);

  const addFamily = async () => {
    const code = await promptAsk('Новое семейство', 'Код семейства — так начинается обозначение (например, КПУ-5)');
    if (!code) return;
    const mfId = mf || catalog.manufacturers[0]?.id;
    if (!mfId) { addToast('Сначала заведите производителя', 'error'); return; }
    const f = blankFamily(classId, mfId, code.trim());
    try { await catalogService.save('family', f); await load(true); setOpenId(f.id); } catch (e: any) { addToast(e?.message || 'Не создалось', 'error'); }
  };
  const addManufacturer = async () => {
    const name = await promptAsk('Новый производитель', 'Название, например ООО «ВИНГС-М»');
    if (!name) return;
    const short = (await promptAsk('Короткое имя', 'Как подписывать в списках', name.replace(/ООО|ЗАО|АО|«|»|"/g, '').trim())) || name;
    try { await catalogService.save('manufacturer', { id: `mf-${Math.random().toString(36).slice(2, 9)}`, name, shortName: short }); await load(true); addToast('Производитель добавлен', 'success'); } catch (e: any) { addToast(e?.message || 'Не добавился', 'error'); }
  };
  const addClass = async () => {
    const title = await promptAsk('Новый класс оборудования', 'Например: Вентиляторы, Решётки, Воздухонагреватели');
    if (!title) return;
    const c: EquipmentClass = {
      id: `cls-${Math.random().toString(36).slice(2, 9)}`, code: title.toLowerCase().replace(/[^a-zа-я0-9]+/gi, '-').slice(0, 24), title: t2(title), itemName: t2(title.toLowerCase()),
      facts: [{ key: 'kind', label: t2('Род'), type: 'choice', hard: true, values: [] }], sort: catalog.classes.length + 1,
    };
    try { await catalogService.save('class', c); await load(true); setClassId(c.id); addToast('Класс добавлен. Заведите в нём семейства.', 'success'); } catch (e: any) { addToast(e?.message || 'Не добавился', 'error'); }
  };

  return (
    <SectionErrorBoundary title="Каталог">
      <div className="h-full flex flex-col min-h-0 @container gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <b className="text-base font-bold">Каталог</b>
          <span className="text-2xs text-slate-400">общий для всех проектов</span>
          <span className="flex-1" />
          <Select value={classId} onChange={(v) => { setClassId(v); setOpenId(''); }} className="!w-auto" aria-label="Класс оборудования"
            options={catalog.classes.map((c) => ({ value: c.id, label: `${textOf(c.title)} · ${catalog.families.filter((f) => f.classId === c.id).length}` }))} />
          {canEdit && <Btn tone="ghost" onClick={addClass} title="Новый класс оборудования"><Plus className="w-3.5 h-3.5" /> Класс</Btn>}
        </div>
        {error && <div className="text-xs text-rose-600 dark:text-rose-400">{error}</div>}
        <div className="flex items-center gap-1 border-b border-slate-100 dark:border-slate-800 flex-wrap">
          {TABS.map((t) => (
            <button key={t.id} type="button" onClick={() => setTab(t.id)} aria-pressed={tab === t.id}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border-b-2 -mb-px cursor-pointer ${tab === t.id ? 'border-emerald-600 text-emerald-700 dark:text-emerald-400' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-emerald-700'}`}>
              <t.icon className="w-3.5 h-3.5" /> {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 min-h-0">
          {!loaded ? <div className="text-xs text-slate-400">Загружаю Каталог…</div> : (
            <>
              {tab === 'families' && (
                <div className="h-full min-h-0 grid grid-cols-1 @[900px]:grid-cols-[minmax(240px,300px)_minmax(0,1fr)] gap-3">
                  <div className={`min-h-0 flex-col gap-2 ${open ? 'hidden @[900px]:flex' : 'flex'}`}>
                    <label className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-700">
                      <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Код, название…" className="flex-1 min-w-0 bg-transparent text-xs outline-none" />
                    </label>
                    <div className="flex items-center gap-1">
                      <Factory className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <Select value={mf} onChange={setMf} options={[{ value: '', label: 'все производители' }, ...catalog.manufacturers.map((m) => ({ value: m.id, label: m.shortName || m.name }))]} />
                      {canEdit && <Btn tone="ghost" onClick={addManufacturer} title="Новый производитель"><Plus className="w-3.5 h-3.5" /></Btn>}
                    </div>
                    {canEdit && <Btn onClick={addFamily}><Plus className="w-3.5 h-3.5" /> Семейство</Btn>}
                    <div className="flex-1 min-h-0 overflow-auto pr-1">
                      {grouped.map(([kind, list]) => (
                        <div key={kind} className="mb-2">
                          <div className="text-2xs font-bold text-emerald-700 dark:text-emerald-400 px-1 py-1">{kindLabel(kind)} <span className="text-slate-400 tabular-nums">· {list.length}</span></div>
                          {list.map((f) => (
                            <button key={f.id} type="button" onClick={() => setOpenId(f.id)} aria-pressed={openId === f.id}
                              className={`w-full text-left rounded-md px-2 py-1 cursor-pointer flex items-center gap-1.5 ${openId === f.id ? 'bg-emerald-50 dark:bg-emerald-950/30' : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'}`}>
                              <b className="font-mono text-xs min-w-0 truncate">{f.code}</b>
                              <span className="flex-1" />
                              {meta[f.id]?.edited && <Chip tone="sky">правлено</Chip>}
                              {f.status !== 'full' && <StatusChip status={f.status} />}
                            </button>
                          ))}
                        </div>
                      ))}
                      {!families.length && <Empty title="Семейств нет" text={q ? 'Измените поиск.' : 'Заведите первое семейство этого класса.'} />}
                    </div>
                  </div>
                  <div className="min-h-0">
                    {open ? (
                      <div className="h-full min-h-0 flex flex-col">
                        <button type="button" onClick={() => setOpenId('')} className="@[900px]:hidden text-left text-2xs text-emerald-700 dark:text-emerald-400 mb-1 cursor-pointer">← к списку</button>
                        <FamilyEditor catalog={catalog} family={open} canEdit={canEdit} edited={meta[open.id]?.edited}
                          onSaved={(f) => setOpenId(f.id)} onDeleted={() => setOpenId('')} />
                      </div>
                    ) : (
                      <Empty title="Выберите семейство" text={`В классе «${textOf(cls?.title)}» ${families.length} семейств. Карточка покажет позиции обозначения, коды, правила каталога и характеристики для бланка; всё правится и откатывается.`} />
                    )}
                  </div>
                </div>
              )}
              {tab === 'components' && <div className="h-full overflow-auto"><ComponentsPanel catalog={catalog} classId={classId} canEdit={canEdit} /></div>}
              {tab === 'tags' && <div className="h-full overflow-auto"><TagRulesPanel key={classId} catalog={catalog} classId={classId} canEdit={canEdit} /></div>}
              {tab === 'try' && (
                <div className="h-full overflow-auto">
                  <DescribeMatch catalog={catalog} classId={classId} learned={learned} acceptLabel="Показать в Каталоге"
                    onAccept={(a) => { setOpenId(a.familyId); setTab('families'); }} />
                </div>
              )}
              {tab === 'learned' && <div className="h-full overflow-auto"><LearnedPanel catalog={catalog} /></div>}
              {tab === 'check' && <div className="h-full overflow-auto"><CheckPanel catalog={catalog} classId={classId} onOpen={(id) => { setOpenId(id); setTab('families'); }} /></div>}
              {tab === 'exchange' && <div className="h-full overflow-auto"><ExchangePanel canEdit={canEdit} /></div>}
            </>
          )}
        </div>
      </div>
    </SectionErrorBoundary>
  );
}
