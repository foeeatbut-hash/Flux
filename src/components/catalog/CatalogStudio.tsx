/**
 * Панель разработчика каталога: где справочник наполняют и правят.
 * Слева — разделы по порядку работы (записи → источники → проверка →
 * публикация), справа — выбранный раздел. Раньше всё это было одним
 * выпадающим списком «Инструмент редактора».
 */
import React, { useEffect, useState } from 'react';
import { ArrowLeft, ArrowLeftRight, Brain, FileSpreadsheet, Layers, Plus, Send, ShieldCheck, Sparkles, Tag as TagIcon, Users, Wrench } from 'lucide-react';
import SectionErrorBoundary from '../SectionErrorBoundary';
import CatalogManagement, { type RecordSection } from './CatalogManagement';
import CatalogPublications from './CatalogPublications';
import CatalogAccess from './CatalogAccess';
import type { CatalogMeta } from '../../services/catalogService';
import type { CatalogWorkspace } from '../../../catalog/publication';
import { plural } from '../../lib/plural';
import { Btn, Select } from './ui';

export type StudioSection = RecordSection | 'publication' | 'access';
type Icon = React.ComponentType<{ className?: string }>;
const GROUPS: Array<{ title: string; items: Array<{ id: StudioSection; label: string; icon: Icon; need?: 'editor' | 'admin' }> }> = [
  { title: 'Записи', items: [
    { id: 'families', label: 'Модели оборудования', icon: Layers, need: 'editor' }, { id: 'components', label: 'Комплектующие', icon: Wrench, need: 'editor' },
    { id: 'tags', label: 'Правила тегов', icon: TagIcon, need: 'editor' }] },
  { title: 'Источники', items: [
    { id: 'spreadsheet', label: 'Импорт из Excel', icon: FileSpreadsheet, need: 'editor' }, { id: 'exchange', label: 'Обмен файлами', icon: ArrowLeftRight, need: 'editor' }] },
  { title: 'Проверка', items: [
    { id: 'check', label: 'Проверка данных', icon: ShieldCheck, need: 'editor' }, { id: 'try', label: 'Пробный подбор', icon: Sparkles, need: 'editor' }, { id: 'learned', label: 'Выученное', icon: Brain, need: 'editor' }] },
  { title: 'Публикация', items: [
    { id: 'publication', label: 'Публикации', icon: Send }, { id: 'access', label: 'Доступ сотрудников', icon: Users, need: 'admin' }] },
];

export default function CatalogStudio({ workspace, meta, isAdmin, canUseEditor, workError, onBack, onChanged, onPublished }: {
  workspace: CatalogWorkspace; meta: CatalogMeta; isAdmin: boolean; canUseEditor: boolean; workError: string;
  onBack: () => void; onChanged: () => Promise<void>; onPublished: () => Promise<void>;
}) {
  const [section, setSection] = useState<StudioSection>(canUseEditor ? 'families' : 'publication');
  const [token, setToken] = useState(0);
  const { catalog } = workspace;
  const drafts = workspace.drafts.length;
  const allowed = (need?: string) => !need || (need === 'editor' ? canUseEditor : isAdmin);
  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => allowed(i.need)) })).filter((g) => g.items.length);
  const flat = groups.flatMap((g) => g.items);
  useEffect(() => { if (!flat.some((i) => i.id === section)) setSection(flat[0]?.id || 'publication'); }, [flat.length, section]); // eslint-disable-line react-hooks/exhaustive-deps
  const countOf = (id: StudioSection) => id === 'publication' && drafts ? drafts : undefined;
  const newModel = () => { setSection('families'); setToken((t) => t + 1); };
  const rights = { edit: workspace.rights.edit, import: workspace.rights.import };

  return <SectionErrorBoundary title="Каталог"><div className="@container flex h-full min-h-0 flex-col bg-[var(--flux-surface)] text-[var(--flux-text)]">
    {/* Своя шапка вместо SectionHead: в узком окне действия переносятся на вторую строку, а не уходят за край */}
    <div className="fx-head !h-auto min-h-11 flex-wrap py-1.5">
      <h1 className="fx-head-title">Панель разработчика</h1>
      <span className="fx-head-count">{`${catalog.classes.length} ${plural(catalog.classes.length, 'тип', 'типа', 'типов')} · ${catalog.families.length} ${plural(catalog.families.length, 'модель', 'модели', 'моделей')} · ${catalog.components.length} ${plural(catalog.components.length, 'компонент', 'компонента', 'компонентов')}`}</span>
      <div className="fx-head-acts flex-wrap">
        <Btn tone="ghost" onClick={onBack}><ArrowLeft />К просмотру каталога</Btn>
        {workspace.rights.edit && <Btn tone="primary" onClick={newModel} disabled={!catalog.classes.length || !catalog.manufacturers.length}><Plus />Новая модель</Btn>}
      </div>
    </div>
    {workError && <p role="alert" className="m-0 border-b border-[var(--flux-line)] px-4 py-2 text-xs text-[var(--flux-bad-text)]">{workError}</p>}
    <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] @[800px]:grid-cols-[232px_minmax(0,1fr)] @[800px]:grid-rows-1">
      <aside className="fx-side min-h-0 border-b border-r-0 @[800px]:border-b-0 @[800px]:border-r">
        <div className="p-2 @[800px]:hidden">
          <Select aria-label="Раздел панели" value={section} onChange={(v) => setSection(v as StudioSection)} className="w-full"
            options={flat.map((i) => ({ value: i.id, label: `${i.label}${countOf(i.id) ? ` · ${countOf(i.id)}` : ''}` }))} />
        </div>
        <nav aria-label="Разделы панели разработчика" className="hidden h-full flex-col gap-0.5 overflow-auto p-2 @[800px]:flex">
          {groups.map((g, gi) => <React.Fragment key={g.title}>
            <div className={`fx-gh ${gi ? 'mt-2' : ''}`}>{g.title}</div>
            {g.items.map((i) => <button key={i.id} type="button" className="fx-li" aria-current={section === i.id} onClick={() => setSection(i.id)}>
              <i.icon /><span className="truncate">{i.label}</span>{countOf(i.id) !== undefined && <span className="fx-badge fx-badge-accent ml-auto">{countOf(i.id)}</span>}</button>)}
          </React.Fragment>)}
        </nav>
      </aside>
      <main className="min-h-0 min-w-0 overflow-hidden">
        {section === 'publication' ? <div className="h-full overflow-auto"><CatalogPublications workspace={workspace} onChanged={onPublished} /></div>
          : section === 'access' ? <div className="h-full overflow-auto p-4"><CatalogAccess catalog={catalog} onSaved={() => void onChanged()} /></div>
          : <CatalogManagement catalog={catalog} meta={meta} rights={rights} section={section} newModelToken={token} onChanged={onChanged} />}
      </main>
    </div>
  </div></SectionErrorBoundary>;
}
