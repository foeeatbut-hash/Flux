/**
 * Заглушка «проект не выбран» для разделов, которые без проекта не работают.
 *
 * Раньше каждый такой раздел показывал свой тупик: значок, заголовок и совет
 * пойти на другую вкладку — причём вкладку называли по-разному, а одна из
 * подсказок отправляла в «Дашборд», которого в программе нет. Кнопки выбора
 * не было ни на одном экране.
 */
import React from 'react';
import { FolderKanban, Plus } from 'lucide-react';
import { useStore } from '../store/store';
import { dataService } from '../services/dataService';
import { rememberSectionUse } from '../store/workspaceStore';
import { useWindowStore } from '../store/windowStore';

type Project = { id: string; name: string };

export default function NoProject({ what }: { what: string }) {
  const setActiveProject = useStore((s) => s.setActiveProject);
  const [projects, setProjects] = React.useState<Project[] | null>(null);

  React.useEffect(() => {
    let alive = true;
    dataService.getProjects()
      .then((list: any[]) => { if (alive) setProjects((list || []).map((p) => ({ id: p.id, name: p.name }))); })
      .catch(() => { if (alive) setProjects([]); });
    return () => { alive = false; };
  }, []);

  const openProjects = () => { rememberSectionUse('/projects'); useWindowStore.getState().open('/projects'); };

  return (
    <div className="w-full h-full flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-lg border border-slate-200 dark:border-dark-border bg-white dark:bg-dark-surface p-6 text-center">
        <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/50 flex items-center justify-center">
          <FolderKanban className="w-6 h-6 text-emerald-700 dark:text-emerald-400" />
        </div>
        <h3 className="text-base font-bold text-slate-800 dark:text-white">Сначала выберите проект</h3>
        {/* Название раздела уводим в кавычки после слова «Раздел»: фраза была
            написана в среднем роде и подставляла туда имя раздела, отчего
            получалось «Закупки привязано» и «Реестр тегов привязано» — из трёх
            мест верным было одно. Теперь род фразы не зависит от подстановки. */}
        <p className="text-sm text-slate-500 dark:text-dark-text-muted mt-1">
          Раздел «{what}» ведётся по проекту. Выберите проект здесь или в трее панели задач.
        </p>

        {projects === null && (
          <p className="text-xs text-slate-400 mt-5">Загружаю список проектов…</p>
        )}

        {projects !== null && projects.length > 0 && (
          <div className="mt-5 flex flex-col gap-1 max-h-56 overflow-y-auto scrollbar-thin text-left">
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setActiveProject(p)}
                className="w-full px-3 py-2 rounded-lg text-sm font-medium text-slate-700 dark:text-dark-text-main bg-slate-50 dark:bg-dark-panel hover:bg-emerald-50 dark:hover:bg-emerald-950/40 hover:text-emerald-800 dark:hover:text-emerald-300 transition-ui cursor-pointer truncate"
              >
                {p.name}
              </button>
            ))}
          </div>
        )}

        {projects !== null && projects.length === 0 && (
          <button
            type="button"
            onClick={openProjects}
            className="mt-5 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 transition-ui cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Создать первый проект
          </button>
        )}
      </div>
    </div>
  );
}
