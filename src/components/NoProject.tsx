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
    // Пустое состояние по методологии: слева сверху, заголовок, строка,
    // одно действие. Карточка по центру со значком в зелёном квадратике
    // была из тех примет, которые методология убирает
    <div className="w-full h-full overflow-y-auto">
      <div className="fx-empty max-w-md">
        <h3 className="fx-empty-title">Сначала выберите проект</h3>
        {/* Название раздела уводим в кавычки после слова «Раздел»: фраза была
            написана в среднем роде и подставляла туда имя раздела, отчего
            получалось «Закупки привязано» и «Реестр тегов привязано» — из трёх
            мест верным было одно. Теперь род фразы не зависит от подстановки. */}
        <p className="fx-empty-text">
          Раздел «{what}» ведётся по проекту. Выберите проект здесь или в трее панели задач.
        </p>

        {projects === null && (
          <p className="text-xs text-slate-400">Загружаю список проектов…</p>
        )}

        {projects !== null && projects.length > 0 && (
          <div className="w-full flex flex-col max-h-72 overflow-y-auto scrollbar-thin -mx-2">
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setActiveProject(p)}
                className="fx-li"
              >
                <FolderKanban /><span className="truncate">{p.name}</span>
              </button>
            ))}
          </div>
        )}

        {projects !== null && projects.length === 0 && (
          <button
            type="button"
            onClick={openProjects}
            className="fx-btn fx-btn-primary"
          >
            <Plus className="w-4 h-4" />
            Создать первый проект
          </button>
        )}
      </div>
    </div>
  );
}
