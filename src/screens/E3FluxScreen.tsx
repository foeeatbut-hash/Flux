/**
 * E3Flux — отдельная программа Flux для всего, что связано с E3.series.
 *
 * Выгрузка оборудования в таком виде уберётся (решение владельца), поэтому
 * атрибуты E3 живут здесь, а не в «Выгрузке данных» и не в Каталоге. Готовы
 * четыре рабочих места: таблица атрибутов проекта, справочник атрибутов,
 * типовые решения (каталог, профиль и подбор по позициям) и схема (список,
 * холст листа и карточка узла). «Нет данных» — живой список мест, где данных не
 * хватает, со ссылками на них. Выгрузка в E3 ждёт моста.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import SectionErrorBoundary from '../components/SectionErrorBoundary';
import E3AttributesPanel from '../components/catalog/E3AttributesPanel';
import E3GapsTab from '../components/e3flux/E3GapsTab';
import { jumpFor, type E3Jump } from '../components/e3flux/e3Jump';
import { useGapsData } from '../components/e3flux/useGapsData';
import E3ProjectTable from '../components/e3flux/E3ProjectTable';
import E3SchemeTab from '../components/e3flux/E3SchemeTab';
import E3SolutionsTab from '../components/e3flux/E3SolutionsTab';
import type { GapWhere } from '../../e3/gaps';
import { gapCount } from '../../e3/gaps';
import NoProject from '../components/NoProject';
import { SectionHead, Tabs } from '../components/ui';
import { catalogWorkspaceService } from '../services/catalogWorkspaceService';
import { useStore } from '../store/store';
import { useToastStore } from '../store/toastStore';

type Tab = 'project' | 'book' | 'solutions' | 'scheme' | 'gaps';

export default function E3FluxScreen() {
  const project = useStore((s) => s.activeProject);
  const say = useToastStore((s) => s.addToast);
  // Из карточки позиции («В схеме E3 …») окно открывается на схеме и на этой позиции (docs/e3-integration.md, 6.5)
  const [params] = useSearchParams();
  const focus = params.get('position') || '';
  const [tab, setTab] = useState<Tab>(focus ? 'scheme' : 'project');
  // Переход из «Нет данных»: вкладка, раздел и запись; принявшая панель гасит его
  const [jump, setJump] = useState<E3Jump | null>(null);
  const jumps = useRef(0);
  const done = useCallback(() => setJump(null), []);
  const pick = (t: Tab) => { setJump(null); setTab(t); };
  const open = (where: GapWhere) => { const j = jumpFor(where, ++jumps.current); setJump(j); setTab(j.tab); };
  // Данные раздела «Нет данных» читаются всегда: число в названии вкладки должно быть видно с любой другой
  const gapsData = useGapsData(project?.id || '');
  useEffect(() => { if (focus) setTab('scheme'); }, [focus]);
  // Права справочника — те же, что у рабочей области Каталога: справочник хранится там
  const [rights, setRights] = useState({ edit: false, import: false });
  useEffect(() => {
    let alive = true;
    catalogWorkspaceService.load().then((w) => { if (alive) setRights({ edit: !!w.rights.edit, import: !!w.rights.import }); }).catch(() => { /* без прав справочник открыт только для чтения */ });
    return () => { alive = false; };
  }, []);

  return <SectionErrorBoundary title="E3Flux"><div className="fx-page">
    <SectionHead title={project ? `E3Flux · ${project.name}` : 'E3Flux'}>
      <Tabs label="Разделы E3Flux" value={tab} onChange={pick} tabs={[
        { value: 'project', label: 'Атрибуты проекта' }, { value: 'book', label: 'Справочник атрибутов' },
        { value: 'solutions', label: 'Типовые решения' }, { value: 'scheme', label: 'Схема' },
        { value: 'gaps', label: 'Нет данных', count: gapsData.ready ? gapCount(gapsData.gaps) : undefined, title: 'Где не хватает данных: справочник атрибутов, каталог решений, позиции проекта' },
      ]} />
    </SectionHead>
    <div className="min-h-0 flex-1">
      {tab === 'project' ? (project ? <E3ProjectTable key={project.id} projectId={project.id} projectName={project.name} onOpenBook={() => pick('book')} say={say} jump={{ jump, done }} /> : <NoProject what="атрибутов E3" />)
        : tab === 'book' ? <div className="h-full p-3"><E3AttributesPanel rights={rights} jump={{ jump, done }} /></div>
        : tab === 'solutions' ? <E3SolutionsTab rights={rights} projectId={project?.id || ''} jump={jump} done={done} />
        : tab === 'gaps' ? <E3GapsTab gaps={gapsData.gaps} ready={gapsData.ready} error={gapsData.error} hasProject={!!project} loadedAt={gapsData.loadedAt} onOpen={open} />
        : project ? <E3SchemeTab key={project.id} projectId={project.id} focusId={focus} onOpenProfile={() => pick('solutions')} /> : <NoProject what="схемы E3" />}
    </div>
  </div></SectionErrorBoundary>;
}
