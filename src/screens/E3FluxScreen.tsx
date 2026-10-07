/**
 * E3Flux — отдельная программа Flux для всего, что связано с E3.series.
 *
 * Выгрузка оборудования в таком виде уберётся (решение владельца), поэтому
 * атрибуты E3 живут здесь, а не в «Выгрузке данных» и не в Каталоге. Готовы
 * четыре рабочих места: таблица атрибутов проекта, справочник атрибутов,
 * типовые решения (каталог, профиль и подбор по позициям) и схема (список,
 * холст листа и карточка узла). Выгрузка в E3 ждёт моста.
 */
import React, { useEffect, useState } from 'react';
import SectionErrorBoundary from '../components/SectionErrorBoundary';
import E3AttributesPanel from '../components/catalog/E3AttributesPanel';
import E3ProjectTable from '../components/e3flux/E3ProjectTable';
import E3SchemeTab from '../components/e3flux/E3SchemeTab';
import E3SolutionsTab from '../components/e3flux/E3SolutionsTab';
import NoProject from '../components/NoProject';
import { SectionHead, Tabs } from '../components/ui';
import { catalogWorkspaceService } from '../services/catalogWorkspaceService';
import { useStore } from '../store/store';
import { useToastStore } from '../store/toastStore';

type Tab = 'project' | 'book' | 'solutions' | 'scheme';

export default function E3FluxScreen() {
  const project = useStore((s) => s.activeProject);
  const say = useToastStore((s) => s.addToast);
  const [tab, setTab] = useState<Tab>('project');
  // Права справочника — те же, что у рабочей области Каталога: справочник хранится там
  const [rights, setRights] = useState({ edit: false, import: false });
  useEffect(() => {
    let alive = true;
    catalogWorkspaceService.load().then((w) => { if (alive) setRights({ edit: !!w.rights.edit, import: !!w.rights.import }); }).catch(() => { /* без прав справочник открыт только для чтения */ });
    return () => { alive = false; };
  }, []);

  return <SectionErrorBoundary title="E3Flux"><div className="fx-page">
    <SectionHead title={project ? `E3Flux · ${project.name}` : 'E3Flux'}>
      <Tabs label="Разделы E3Flux" value={tab} onChange={setTab} tabs={[
        { value: 'project', label: 'Атрибуты проекта' }, { value: 'book', label: 'Справочник атрибутов' },
        { value: 'solutions', label: 'Типовые решения' }, { value: 'scheme', label: 'Схема' },
      ]} />
    </SectionHead>
    <div className="min-h-0 flex-1">
      {tab === 'project' ? (project ? <E3ProjectTable key={project.id} projectId={project.id} projectName={project.name} onOpenBook={() => setTab('book')} say={say} /> : <NoProject what="атрибутов E3" />)
        : tab === 'book' ? <div className="h-full p-3"><E3AttributesPanel rights={rights} /></div>
        : tab === 'solutions' ? <E3SolutionsTab rights={rights} projectId={project?.id || ''} />
        : project ? <E3SchemeTab key={project.id} projectId={project.id} onOpenProfile={() => setTab('solutions')} /> : <NoProject what="схемы E3" />}
    </div>
  </div></SectionErrorBoundary>;
}
