import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, ExternalLink, LoaderCircle, X } from 'lucide-react';
import { dataService } from '../services/dataService';
import { openInProject, loadProjects, projectName } from '../lib/projectScope';
import { useTagNavigationStore } from '../store/tagNavigationStore';
import { parseTagMetadata } from './registry/tagMeta';

type TagRow = {
  id: string;
  projectId: string;
  identifier: string;
  componentElements?: Array<{
    id: string;
    name?: string;
    itemCode?: string;
    monoblock?: { name?: string; system?: { name?: string } };
  }>;
  metadata?: string | null;
};

function parentIdOf(tag: TagRow): string {
  try {
    const metadata = typeof tag.metadata === 'string' ? JSON.parse(tag.metadata) : tag.metadata;
    return typeof metadata?.parentId === 'string' ? metadata.parentId : '';
  } catch { return ''; }
}

/** Неблокирующая панель сведений: её можно держать открытой при работе в разделе. */
export default function TagNavigationPanel() {
  const target = useTagNavigationStore((s) => s.target);
  const close = useTagNavigationStore((s) => s.close);
  const navigate = useNavigate();
  const [tag, setTag] = useState<TagRow | null>(null);
  const [parents, setParents] = useState<TagRow[]>([]);
  const [children, setChildren] = useState<Array<{ tag: TagRow; depth: number }>>([]);
  const [project, setProject] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!target) return;
    let current = true;
    setLoading(true);
    setError('');
    setTag(null);
    setParents([]);
    setChildren([]);
    loadProjects().then(() => {
      if (current) {
        setProject(projectName(target.projectId));
      }
    });
    Promise.all([
      dataService.getTags(target.projectId),
      dataService.getSystems(target.projectId).catch(() => null),
    ])
      .then(([result, systemResult]: [any, any]) => {
        if (!current) return;
        const tags: TagRow[] = result?.tags || [];
        const found = tags.find((item) => item.id === target.tagId)
          || tags.find((item) => item.identifier?.trim().toLocaleLowerCase() === target.identifier.trim().toLocaleLowerCase());
        if (found) {
          const byId = new Map(tags.map((item) => [item.id, item]));
          const parentRows: TagRow[] = [];
          let parentId = parentIdOf(found);
          for (let depth = 0; parentId && depth < 2; depth++) {
            const parent = byId.get(parentId);
            if (!parent || parent.id === found.id || parentRows.some((item) => item.id === parent.id)) break;
            parentRows.push(parent);
            parentId = parentIdOf(parent);
          }
          setParents(parentRows);
          const directChildren = tags.filter((item) => parentIdOf(item) === found.id);
          setChildren([
            ...directChildren.map((item) => ({ tag: item, depth: 0 })),
            ...tags.filter((item) => directChildren.some((parent) => parentIdOf(item) === parent.id))
              .map((item) => ({ tag: item, depth: 1 })),
          ]);
          const componentLocations = new Map<string, { monoblockName?: string; systemName?: string }>();
          for (const system of systemResult?.systems || []) {
            for (const monoblock of system.monoblocks || []) {
              for (const component of monoblock.components || []) {
                componentLocations.set(component.id, { monoblockName: monoblock.name, systemName: system.name });
              }
            }
          }
          setTag({ ...found, componentElements: (found.componentElements || []).map((component) => {
            const location = componentLocations.get(component.id);
            return location ? { ...component, monoblock: { name: location.monoblockName, system: { name: location.systemName } } } : component;
          }) });
          // Список документов ВДР убран: связь ВДР с тегом отключена, пока она держится на коде строкой
        }
        else setError(`Тег ${target.identifier} в этом проекте не найден.`);
      })
      .catch((err: any) => { if (current) setError(err?.message || 'Не удалось загрузить сведения о теге.'); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [target, close]);

  if (!target) return null;

  const visit = (what: string, route: string) => openInProject({
    what,
    projectId: target.projectId,
    open: () => { close(); navigate(route); },
  });
  const showTag = (item: TagRow) => useTagNavigationStore.getState().open({
    projectId: item.projectId || target.projectId,
    tagId: item.id,
    identifier: item.identifier,
  });

  return (
    <aside
      aria-label={`Сведения о теге ${target.identifier}`}
      className="fixed right-3 top-16 z-[70] flex max-h-[calc(100vh-5rem)] w-[min(360px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl"
    >
      <header className="flex items-start gap-3 border-b border-slate-200 dark:border-slate-700 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">Тег {tag?.identifier || target.identifier}</h2>
          <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">{project || `Проект ${target.projectId}`}</p>
        </div>
        <button type="button" className="fx-ibtn shrink-0" aria-label="Закрыть сведения о теге" title="Закрыть" onClick={close}><X className="h-4 w-4" /></button>
      </header>
      <div className="overflow-y-auto p-4 text-sm">
        {loading && <p className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400"><LoaderCircle className="h-4 w-4 animate-spin" />Загружаю сведения…</p>}
        {error && !loading && <p role="status" className="text-xs text-rose-700 dark:text-rose-300">{error}</p>}
        {tag && !loading && <>
          <button type="button" className="fx-btn fx-btn-quiet w-full justify-between" onClick={() => visit(`Тег ${tag.identifier}`, `/registry?tag=${encodeURIComponent(tag.identifier)}`)}>
            Открыть карточку тега <ExternalLink className="h-3.5 w-3.5" />
          </button>
          {(parents.length > 0 || children.length > 0) && <section className="mt-4" aria-labelledby="tag-links-heading">
            <h3 id="tag-links-heading" className="mb-2 text-xs font-medium text-slate-500 dark:text-slate-400">Состав тегов</h3>
            {parents.length > 0 && <div className="mb-2">
              <p className="mb-1 text-2xs text-slate-400 dark:text-slate-500">Родители</p>
              {parents.map((item, index) => <button key={item.id} type="button" className="fx-li w-full truncate text-left text-xs" onClick={() => showTag(item)}>
                <span className="text-slate-400 dark:text-slate-500">{'·'.repeat(index + 1)} </span>{item.identifier}
              </button>)}
            </div>}
            {children.length > 0 && <div>
              <p className="mb-1 text-2xs text-slate-400 dark:text-slate-500">Дочерние теги</p>
              {children.map(({ tag: item, depth }) => <button key={item.id} type="button" className="fx-li w-full truncate text-left text-xs" style={{ paddingLeft: `${8 + depth * 16}px` }} onClick={() => showTag(item)}>
                {item.identifier}
              </button>)}
            </div>}
          </section>}
          <section className="mt-4" aria-labelledby="tag-equipment-heading">
            <h3 id="tag-equipment-heading" className="mb-2 text-xs font-medium text-slate-500 dark:text-slate-400">Оборудование и место в составе</h3>
            {tag.componentElements?.length ? (
              <ul className="space-y-1">
                {tag.componentElements.map((component) => {
                  const system = component.monoblock?.system?.name;
                  const label = component.itemCode || component.name || 'Позиция без названия';
                  const composition = [system, component.monoblock?.name, component.name && component.name !== label ? component.name : ''].filter(Boolean).join(' · ');
                  return <li key={component.id}>
                    <button type="button" className="fx-li flex w-full items-center justify-between gap-2 text-left" onClick={() => visit(`Оборудование ${label}`, `/equipment?component=${encodeURIComponent(component.id)}`)}>
                      <span className="min-w-0"><span className="block truncate text-xs text-slate-800 dark:text-slate-100">{label}</span>{composition && <span className="block truncate text-2xs text-slate-500 dark:text-slate-400">{composition}</span>}</span>
                      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
                    </button>
                  </li>;
                })}
              </ul>
            ) : <p className="text-xs text-slate-500 dark:text-slate-400">Оборудование к тегу пока не привязано.</p>}
          </section>
          {parseTagMetadata(tag).descriptions.filter((item) => item.comment?.trim()).length > 0 && <section className="mt-4" aria-labelledby="tag-comments-heading">
            <h3 id="tag-comments-heading" className="mb-2 text-xs font-medium text-slate-500 dark:text-slate-400">Обсуждения</h3>
            <ul className="space-y-2">
              {parseTagMetadata(tag).descriptions.filter((item) => item.comment?.trim()).slice(0, 3).map((item) => <li key={item.id} className="border-l-2 border-slate-200 dark:border-slate-700 pl-2 text-xs text-slate-600 dark:text-slate-300">
                <p className="line-clamp-2">{item.comment}</p>
                {item.createdBy && <span className="text-2xs text-slate-400 dark:text-slate-500">{item.createdBy}</span>}
              </li>)}
            </ul>
          </section>}
        </>}
      </div>
    </aside>
  );
}
