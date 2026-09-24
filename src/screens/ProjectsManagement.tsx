import React, { useState, useEffect } from 'react';
import { useStore } from '../store/store';
import { useToastStore } from '../store/toastStore';
import { useModalStore } from '../store/modalStore';
import { dataService, Project } from '../services/dataService';
import { can } from '../lib/permissions';
import ProjectFields, { draftOf, emptyProject, trimmed, type ProjectDraft } from '../components/ProjectFields';
import ProjectFormModal from '../components/ProjectFormModal';
import ProjectMembers from '../components/ProjectMembers';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Plus, Search, Folder, Calendar, Trash2, Edit3, 
  Save, FileText, CheckCircle2, RefreshCw, Info, ArrowLeft, Layers, Users } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export default function ProjectsManagement() {
  const { user, activeProject, setActiveProject } = useStore();
  const { addToast } = useToastStore();
  const { openPrompt, openConfirm } = useModalStore();
  const navigate = useNavigate();
  
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  // Черновик карточки проекта. Поля те же, что и при создании: набор один,
  // и заведённые при создании код, заказчик и подрядчик теперь правятся тоже —
  // раньше их спрашивали один раз и исправить было нельзя.
  const [draft, setDraft] = useState<ProjectDraft>(() => emptyProject());
  const [isSaving, setIsSaving] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  /** Открытый состав проекта: спрашиваем после создания и по кнопке в карточке */
  const [membersFor, setMembersFor] = useState<{ id: string; name: string } | null>(null);

  // Load all projects
  const loadProjects = async (selectIdAfterLoad?: string) => {
    try {
      setLoading(true);
      const fetched = await dataService.getProjects();
      setProjects(fetched);
      
      if (fetched.length > 0) {
        if (selectIdAfterLoad) {
          const matching = fetched.find(p => p.id === selectIdAfterLoad);
          if (matching) {
            setSelectedProject(matching);
            initForm(matching);
          }
        } else if (!selectedProject) {
          setSelectedProject(fetched[0]);
          initForm(fetched[0]);
        } else {
          // Sync currently selected
          const current = fetched.find(p => p.id === selectedProject.id);
          if (current) {
            setSelectedProject(current);
            initForm(current);
          } else {
            setSelectedProject(fetched[0]);
            initForm(fetched[0]);
          }
        }
      } else {
        setSelectedProject(null);
      }
    } catch (err: any) {
      addToast(err.message || 'Ошибка загрузки проектов', 'error');
    } finally {
      setLoading(false);
    }
  };

  const initForm = (proj: Project) => setDraft(draftOf(proj as any));

  /**
   * Есть ли в карточке несохранённая правка.
   *
   * Сравниваем с тем, что пришло с сервера. Нужно ради одного: выбор другого
   * проекта раньше молча подменял форму, и набранное название или заказчик
   * исчезали без следа и без вопроса.
   */
  const isDirty = (): boolean => {
    if (!selectedProject) return false;
    return JSON.stringify(trimmed(draft)) !== JSON.stringify(trimmed(draftOf(selectedProject as any)));
  };

  /** Переключиться на другой проект, спросив про несохранённое. */
  const selectProject = async (p: Project) => {
    if (p.id === selectedProject?.id) return;
    if (isDirty()) {
      const go = await openConfirm(
        'Правки не сохранены',
        `В карточке «${selectedProject?.name}» есть несохранённые изменения. Перейти к другому проекту и потерять их?`,
        { confirmLabel: 'Перейти и потерять', tone: 'danger' },
      );
      if (!go) return;
    }
    setSelectedProject(p);
    initForm(p);
  };

  useEffect(() => {
    loadProjects();
  }, []);

  // Handle project selection as active project
  const handleToggleActiveProject = (proj: Project) => {
    if (activeProject?.id === proj.id) {
      setActiveProject(null);
      addToast(`Проект "${proj.name}" деактивирован.`, 'info');
    } else {
      setActiveProject(proj);
      addToast(`Проект "${proj.name}" теперь выбран как активный!`, 'success');
    }
  };

  const handleCreateProject = async (data: import('../services/dataService').ProjectInput) => {
    try {
      const proj = await dataService.createProject(data, user?.id);
      addToast('Проект успешно создан', 'success');
      await dataService.createLog({
        userName: user?.name || 'Главный Администратор',
        userSymbol: user?.symbol || 'RaupovKhKh',
        description: `Создан новый инженерный проект: ${proj.name}`,
        targetRoute: '/projects'
      });
      setShowCreate(false);
      await loadProjects(proj.id);
      // Сразу спрашиваем, кто в деле: проект без ответа на этот вопрос
      // остаётся общим, и ограничение доступа не включается никогда
      setMembersFor({ id: proj.id, name: proj.name });
    } catch (err: any) {
      addToast(err.message || 'Не удалось создать проект', 'error');
    }
  };

  const handleSaveProject = async () => {
    if (!selectedProject) return;
    const next = trimmed(draft);
    if (!next.name) {
      addToast('Название проекта не может быть пустым', 'error');
      return;
    }

    try {
      setIsSaving(true);
      const updated = await dataService.updateProject(selectedProject.id, next, user?.id);
      addToast('Данные проекта успешно сохранены', 'success');
      
      // Log change
      await dataService.createLog({
        userName: user?.name || 'Главный Администратор',
        userSymbol: user?.symbol || 'RaupovKhKh',
        description: `Обновлены сведения по проекту: ${updated.name}`,
        targetRoute: '/'
      });

      // Update local active project store if edited active
      if (activeProject?.id === selectedProject.id) {
        setActiveProject(updated);
      }

      await loadProjects(updated.id);
    } catch (err: any) {
      addToast(err.message || 'Ошибка сохранения проекта', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteProject = async (projId: string, projName: string) => {
    if (!await openConfirm(`Удалить проект «${projName}»?`, 'Вместе с проектом удалятся все его файлы, папки, теги и спецификации. Действие необратимо.', { confirmLabel: 'Удалить проект', tone: 'danger' })) {
      return;
    }

    try {
      await dataService.deleteProject(projId, user?.id);
      addToast(`Проект "${projName}" удален.`, 'success');

      // Log change
      await dataService.createLog({
        userName: user?.name || 'Главный Администратор',
        userSymbol: user?.symbol || 'RaupovKhKh',
        description: `Удален инженерный проект и все связанные файлы: ${projName}`,
        targetRoute: '/'
      });

      if (activeProject?.id === projId) {
        setActiveProject(null);
      }

      if (selectedProject?.id === projId) {
        setSelectedProject(null);
      }
      
      loadProjects();
    } catch (err: any) {
      addToast(err.message || 'Ошибка при удалении проекта', 'error');
    }
  };

  const filteredProjects = projects.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase()) || 
    (p.description && p.description.toLowerCase().includes(search.toLowerCase()))
  );

  const canCreate = can(user, 'project.manage');
  const canManage = can(user, 'project.manage');

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="flex-1 flex overflow-x-auto overflow-y-hidden h-full bg-slate-50 dark:bg-slate-950 font-sans"
    >
      {/* LEFT SIDEBAR: LIST OF PROJECTS */}
      <div className="w-60 @[820px]:w-80 border-r border-slate-200 dark:border-slate-850 bg-white dark:bg-slate-900 flex flex-col shrink-0 h-full">
        {/* Sidebar Header */}
        <div className="p-4 border-b border-slate-150 dark:border-slate-800 flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Layers className="w-4 h-4 text-emerald-600" />
            <span>Проекты</span>
          </h2>
          {canCreate && (
            <button type="button"
              onClick={() => setShowCreate(true)}
              data-tour="project-create-btn"
              className="p-1 px-2.5 bg-emerald-700 hover:bg-emerald-650 text-white text-xs font-bold rounded-md flex items-center gap-1 transition-ui cursor-pointer"
              title="Создать новый проект"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Создать</span>
            </button>
          )}
        </div>

        {/* Sidebar Search */}
        <div className="p-3 border-b border-slate-100 dark:border-slate-850">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-400" />
            <input
              type="text"
              placeholder="Поиск проектов..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full text-xs pl-8 pr-3 py-1.5 border border-slate-200 dark:border-slate-800 rounded-lg bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 focus:outline-none focus:border-emerald-500 transition-colors"
            />
          </div>
        </div>

        {/* Sidebar Project Nodes List */}
        <div className="flex-1 overflow-y-auto p-2.5 space-y-1.5">
          {loading ? (
            <div className="py-8 text-center text-xs text-slate-400 dark:text-slate-500">
              <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-slate-350" />
              <span>Загрузка списка проектов...</span>
            </div>
          ) : filteredProjects.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-400 dark:text-slate-500">
              Проекты не найдены
            </div>
          ) : (
            filteredProjects.map((p) => {
              const isActive = activeProject?.id === p.id;
              const isSelected = selectedProject?.id === p.id;
              return (
                <div
                  key={p.id}
                  data-share-route="/projects"
                  data-share-focus={`project:${p.id}`}
                  data-share-label={`Проект: ${p.name}`}
                  onClick={() => { void selectProject(p); }}
                  className={`p-3 rounded-xl border transition-ui cursor-pointer flex flex-col justify-between items-stretch gap-1.5 relative group ${
                    isSelected
                      ? 'bg-slate-50 dark:bg-slate-850 border-slate-300 dark:border-slate-700'
                      : 'bg-white dark:bg-slate-900 border-slate-150 hover:bg-slate-50 dark:hover:bg-slate-850/50'
                  }`}
                >
                  <div className="flex items-start justify-between gap-1.5">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={isActive}
                        onChange={(e) => {
                          e.stopPropagation();
                          handleToggleActiveProject(p);
                        }}
                        className="w-4 h-4 text-emerald-700 bg-slate-100 border-slate-300 rounded focus:ring-emerald-500 cursor-pointer"
                        title={isActive ? "Снять активный статус" : "Выбрать как активный проект"}
                      />
                      <span className="font-bold text-xs text-slate-800 dark:text-slate-150 group-hover:text-emerald-700 dark:group-hover:text-emerald-400 transition-colors leading-tight">
                        {p.name}
                      </span>
                    </div>
                    {isActive && (
                      <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-400">
                        выбран
                      </span>
                    )}
                  </div>
                  
                  {p.description && (
                    <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-1">
                      {p.description}
                    </p>
                  )}

                  <div className="flex items-center justify-between text-xs text-slate-400 mt-1">
                    <span className="flex items-center gap-1 font-mono">
                      <Calendar className="w-3 h-3" />
                      <span>{new Date(p.createdAt).toLocaleDateString('ru-RU')}</span>
                    </span>
                    {canManage && (
                      <button type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteProject(p.id, p.name);
                        }}
                        className="opacity-0 group-hover:opacity-100 hover:text-rose-500 p-1 rounded hover:bg-rose-50 dark:hover:bg-rose-950/20 transition-ui text-slate-400 cursor-pointer"
                        title="Удалить проект"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* RIGHT SIDEBAR: SELECTED PROJECT DETAIL WORKSPACE */}
      <div className="flex-1 min-w-[320px] flex flex-col overflow-hidden h-full bg-slate-50/50 dark:bg-slate-950">
        {selectedProject ? (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Detail Pane Header */}
            <div className="p-4 border-b border-slate-200 dark:border-slate-850 bg-white dark:bg-slate-900 flex flex-wrap items-center justify-between gap-2 shadow-xs">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 shrink-0 bg-emerald-100 dark:bg-emerald-950/45 text-emerald-700 dark:text-emerald-400 rounded-lg flex items-center justify-center">
                  <Folder className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <h1 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2 min-w-0">
                    <span className="truncate" title={selectedProject.name}>{selectedProject.name}</span>
                    {activeProject?.id === selectedProject.id && (
                      <span className="text-xs bg-emerald-700 text-white font-semibold rounded px-2.5 py-0.5 flex items-center gap-1 select-none shrink-0">
                        <CheckCircle2 className="w-3 h-3 shrink-0" />
                        <span className="hidden @[900px]:inline">Выбран для работы</span>
                      </span>
                    )}
                  </h1>
                  <p className="text-xs text-slate-400 font-mono truncate" title={selectedProject.id}>ID: {selectedProject.id}</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleToggleActiveProject(selectedProject)}
                  className={`px-3 py-1.5 text-xs font-bold rounded-lg border cursor-pointer transition-colors ${
                    activeProject?.id === selectedProject.id
                      ? 'bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-850 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'
                      : 'bg-emerald-600 hover:bg-emerald-700 border-emerald-700 text-white'
                  }`}
                >
                  {activeProject?.id === selectedProject.id ? 'Снять с работы' : 'Взять в работу'}
                </button>
              </div>
            </div>

            {/* Scrollable Details / Editable Fields */}
            <div className="flex-grow overflow-y-auto p-6 space-y-6">
              {canManage ? (
                // ADMIN EDIT MODE FORM
                <div className="@container max-w-2xl min-w-0 bg-white dark:bg-slate-900 p-3 @[700px]:p-6 rounded-lg border border-slate-200 dark:border-slate-800 shadow-xs space-y-5">
                  <div className="flex items-center gap-2 border-b border-slate-100 dark:border-slate-800 pb-3">
                    <Edit3 className="w-4 h-4 text-emerald-600" />
                    <h2 className="graf">Карточка проекта</h2>
                  </div>

                  <ProjectFields value={draft} onChange={setDraft} disabled={isSaving} showStatus />

                  <div className="pt-2 flex items-center justify-end gap-3 border-t border-slate-100 dark:border-slate-800/80">
                    <button
                      type="button"
                      onClick={() => initForm(selectedProject)}
                      className="px-4 py-2 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 text-xs font-bold rounded-lg transition-ui cursor-pointer"
                    >
                      Сбросить
                    </button>
                    <button
                      type="button"
                      disabled={isSaving}
                      onClick={handleSaveProject}
                      className="px-4.5 py-2 bg-emerald-700 hover:bg-emerald-650 text-white text-xs font-bold rounded-lg flex items-center gap-1.5 transition-ui shadow-xs cursor-pointer disabled:opacity-50"
                    >
                      {isSaving ? (
                        <>
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          <span>Сохранение...</span>
                        </>
                      ) : (
                        <>
                          <Save className="w-3.5 h-3.5" />
                          <span>Сохранить</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              ) : (
                // NON-ADMIN VIEW MODE
                <div className="max-w-2xl bg-white dark:bg-slate-900 duration-200 p-6 rounded-lg border border-slate-200 dark:border-slate-800 shadow-xs space-y-6">
                  {/* Status Block */}
                  <div className="flex items-center justify-between gap-4 border-b border-slate-100 dark:border-slate-800 pb-4">
                    <span className="text-xs font-bold text-slate-400 dark:text-slate-500 flex items-center gap-1">
                      <Calendar className="w-4 h-4 text-emerald-600" />
                      Дата регистрации проекта:
                    </span>
                    <span className="text-xs font-mono font-bold text-slate-700 dark:text-slate-300">
                      {new Date(selectedProject.createdAt).toLocaleDateString('ru-RU', {
                        day: 'numeric',
                        month: 'long',
                        year: 'numeric'
                      })}
                    </span>
                  </div>

                  {/* Состав: кто видит проект. Кнопка стоит в карточке, а не в
                      настройках, — состав меняют вместе с ходом работы */}
                  <button
                    type="button"
                    onClick={() => setMembersFor({ id: selectedProject.id, name: selectedProject.name })}
                    className="w-full flex items-center gap-2 px-4 py-2.5 rounded-xl cursor-pointer text-left
                               border border-slate-200 dark:border-slate-800 hover:border-emerald-500 transition-ui"
                  >
                    <Users className="w-4 h-4 shrink-0 text-emerald-600" />
                    <span className="min-w-0">
                      <span className="block text-xs font-bold text-slate-800 dark:text-slate-300">Кто работает над проектом</span>
                      <span className="block text-xs text-slate-500 dark:text-slate-400">
                        Кто не в списке — не увидит ни проекта, ни его файлов
                      </span>
                    </span>
                  </button>

                  {/* Short Description */}
                  <div className="p-4 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-200/40 dark:border-slate-800/50">
                    <h3 className="text-xs font-bold text-slate-800 dark:text-slate-300 mb-1 flex items-center gap-1.5">
                      <Info className="w-3.5 h-3.5 text-emerald-600" />
                      <span>Краткое резюме проекта:</span>
                    </h3>
                    <p className="text-xs text-slate-600 dark:text-slate-400 font-light leading-relaxed">
                      {selectedProject.description || 'Краткое описание отсутствует.'}
                    </p>
                  </div>

                  {/* Detail Info text */}
                  <div className="space-y-2">
                    <h3 className="text-xs font-bold text-slate-800 dark:text-slate-300 flex items-center gap-1.5 production-heading">
                      <FileText className="w-4 h-4 text-emerald-600" />
                      <span>Подробная техническая информация:</span>
                    </h3>
                    <div className="text-xs text-slate-705 dark:text-slate-350 leading-relaxed font-light whitespace-pre-line bg-slate-50/20 dark:bg-slate-950/20 p-4 border border-slate-150 rounded-xl">
                      {selectedProject.info || 'Технические подробности проекта еще не заполнены администратором.'}
                    </div>
                  </div>

                  {/* Объяснение «как работать с проектом» отсюда убрано: оно
                      платило собой каждый день, а помогало один раз. Всё, что
                      в нём было, есть в Руководстве (кнопка «?» и F1) — а тут
                      человеку нужен сам проект */}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-grow flex flex-col items-center justify-center text-slate-400 dark:text-slate-500 p-8 h-full">
            <Layers className="w-12 h-12 text-slate-300 dark:text-slate-700 mb-3" />
            <h3 className="text-md font-bold text-slate-850 dark:text-white">Проект не выбран</h3>
            <p className="text-xs text-center max-w-sm mt-1 opacity-75">
              Выберите проект слева или создайте новый.
            </p>
          </div>
        )}
      </div>

      {showCreate && (
        <ProjectFormModal title="Новый проект" onClose={() => setShowCreate(false)} onSave={handleCreateProject} />
      )}

      {membersFor && (
        <ProjectMembers
          projectId={membersFor.id}
          projectName={membersFor.name}
          onClose={() => setMembersFor(null)}
        />
      )}
    </motion.div>
  );
}
