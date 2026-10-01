import React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import ExportBuilder from '../components/equipment/ExportBuilder';
import NoProject from '../components/NoProject';
import { Btn, Empty } from '../components/ui';
import { useStore } from '../store/store';
import { useToastStore } from '../store/toastStore';

import { buildExportSources, type ExportSystem } from '../lib/exportWorkspace';

export default function EquipmentExport() {
  const [params] = useSearchParams();
  const project = useStore(s => s.activeProject);
  const projectId = params.get('projectId') || project?.id || '';
  const name = project?.id === projectId ? project.name : 'Оборудование проекта';
  const navigate = useNavigate();
  const say = useToastStore(s => s.addToast);
  const [systems, setSystems] = React.useState<ExportSystem[]>([]);
  const [categories, setCategories] = React.useState<{ id: string; label: string }[]>([]);
  const [phase, setPhase] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = React.useState('');
  const phaseRef = React.useRef(phase); phaseRef.current = phase;
  const generation = React.useRef(0);
  const load = React.useCallback(async () => {
    if (!projectId) return;
    const current = ++generation.current;
    try {
      const responses = await Promise.all([fetch(`/api/projects/${encodeURIComponent(projectId)}/systems`), fetch('/api/equipment/categories')]);
      if (!responses[0].ok) throw new Error('Оборудование недоступно. Проверьте доступ к проекту');
      if (!responses[1].ok) throw new Error('Не удалось загрузить категории');
      const [data, kinds] = await Promise.all(responses.map(r => r.json()));
      if (generation.current !== current) return;
      setSystems(data.systems || []); setCategories(kinds.categories || []); setPhase('ready'); setError('');
    } catch (e: any) { if (generation.current === current) { setError(e.message || 'Не удалось загрузить оборудование'); if (phaseRef.current === 'ready') say(e.message || 'Не удалось обновить исходные данные', 'error'); else setPhase('error'); } }
  }, [projectId, say]);
  React.useEffect(() => { setPhase('loading'); void load(); return () => { generation.current++; }; }, [load]);
  React.useEffect(() => {
    const changed = (event: Event) => { const value = (event as CustomEvent).detail; if (value?.projectId === projectId && ['equipment', 'component', 'system'].includes(value?.kind)) void load(); };
    window.addEventListener('socket:entity:changed', changed);
    return () => window.removeEventListener('socket:entity:changed', changed);
  }, [projectId, load]);
  const sources = React.useMemo(() => buildExportSources(systems, categories), [systems, categories]);
  if (!projectId) return <NoProject what="выгрузки данных" />;
  if (phase === 'loading') return <div role="status" className="p-4 text-sm text-slate-500 dark:text-slate-400">Подготовка данных проекта…</div>;
  if (phase === 'error') return <Empty title="Выгрузка недоступна" text={error}><Btn onClick={load}>Повторить</Btn></Empty>;
  return <ExportBuilder key={projectId} projectId={projectId} projectName={name} initialScope={params.get('scope') || undefined} scopes={sources.scopes} rowsOf={sources.rows} say={say} onClose={() => navigate(`/equipment`)} />;
}
