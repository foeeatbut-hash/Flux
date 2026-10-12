import { useEffect, useRef, useState } from 'react';
import { ChevronDown, FolderKanban, Search } from 'lucide-react';
import { useStore } from '../../store/store';
import { useGuideStore } from '../../guide/store';

// ── Выбор проекта: панель под кнопкой, поиск, отметка текущего (ТЗ v3 §3) ──

export function ProjectSelector() {
  const projects = useGuideStore((s) => s.projects);
  const projectsError = useGuideStore((s) => s.projectsError);
  const projectId = useGuideStore((s) => s.projectId);
  const projectName = useGuideStore((s) => s.projectName);
  const setProject = useGuideStore((s) => s.setProject);
  const loadProjects = useGuideStore((s) => s.loadProjects);
  const user = useStore((s) => s.user);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (user?.id) void loadProjects(); }, [loadProjects, user?.id]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const current = projects.find((p) => p.id === projectId);
  const filtered = projects.filter((p) => !q || `${p.name} ${p.code || ''} ${p.customer || ''}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div ref={boxRef} className="relative min-w-0">
      <button type="button" onClick={() => setOpen((v) => !v)}
        title={current ? `Проект: ${current.name}${current.code ? ` (${current.code})` : ''}` : 'Выбрать проект'}
        aria-expanded={open}
        className="flex items-center gap-1.5 max-w-[260px] px-2.5 py-1.5 rounded-lg text-xs font-semibold
                   bg-slate-100 dark:bg-slate-850 hover:bg-slate-200 dark:hover:bg-slate-800
                   text-slate-700 dark:text-dark-text-main cursor-pointer min-w-0">
        <FolderKanban className="w-3.5 h-3.5 shrink-0 text-slate-500 dark:text-slate-400" />
        <span className="truncate">{projectName || 'Проект не выбран'}</span>
        <ChevronDown className="w-3 h-3 shrink-0 text-slate-400" />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1.5 z-30 w-[300px] max-w-[86vw] rounded-xl border border-slate-200 dark:border-slate-700
                        bg-white dark:bg-slate-900 shadow-sm p-2 flex flex-col gap-1.5">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
            <input autoFocus type="text" value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Поиск проекта"
              className="w-full pl-8 pr-2 py-1.5 text-sm rounded-lg bg-slate-100 dark:bg-slate-850 outline-none
                         focus:border-emerald-600 border border-transparent text-slate-900 dark:text-white" />
          </div>
          <div className="max-h-64 overflow-y-auto scrollbar-thin flex flex-col gap-0.5">
            {projectsError && <div className="px-2 py-2 text-xs text-rose-700 dark:text-rose-300" role="alert">
              {projectsError}<button type="button" onClick={() => void loadProjects()} className="ml-1 underline cursor-pointer">Повторить</button>
            </div>}
            {!projectsError && filtered.length === 0 && <div className="text-xs text-slate-400 px-2 py-2">Доступных проектов нет — их выдаёт администратор.</div>}
            {filtered.map((p) => (
              <button key={p.id} type="button"
                onClick={() => { setProject(p.id, p.name); setOpen(false); setQ(''); }}
                className={`text-left px-2.5 py-1.5 rounded-lg cursor-pointer flex items-center gap-2 min-w-0 ${
                  p.id === projectId ? 'bg-slate-100 dark:bg-slate-850' : 'hover:bg-slate-100 dark:hover:bg-slate-850'
                }`}>
                <span className="flex-1 min-w-0">
                  <span className="block text-xs font-semibold text-slate-800 dark:text-dark-text-main truncate">{p.name}</span>
                  <span className="block text-2xs text-slate-400 truncate">{p.code ? `Код ${p.code} · ` : ''}{p.customer || ''}</span>
                </span>
                {p.id === projectId && <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 shrink-0" />}
              </button>
            ))}
          </div>
          <div className="text-2xs text-slate-400 px-1">Проект Guide — только для ответов; активный проект Flux не меняется.</div>
        </div>
      )}
    </div>
  );
}

