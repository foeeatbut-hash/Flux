import React, { useState, useEffect } from 'react';
import { useStore } from '../store/store';
import { useToastStore } from '../store/toastStore';
import { useModalStore } from '../store/modalStore';
import { dataService, Project } from '../services/dataService';
import { can } from '../lib/permissions';
import ProjectFields, { draftOf, emptyProject, trimmed, type ProjectDraft } from '../components/ProjectFields';
import ProjectFormModal from '../components/ProjectFormModal';
import ProjectMembers from '../components/ProjectMembers';
import { Plus, Search, Trash2, Users } from 'lucide-react';
import { SectionHead, Btn, IconBtn, Input, Status, Empty, SectionTitle } from '../components/ui';
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
        userName: user?.name || '',
        userSymbol: user?.symbol || '',
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
        userName: user?.name || '',
        userSymbol: user?.symbol || '',
        description: `Обновлены сведения по проекту: ${updated.name}`,
        targetRoute: '/projects'
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
        userName: user?.name || '',
        userSymbol: user?.symbol || '',
        description: `Удален инженерный проект и все связанные файлы: ${projName}`,
        targetRoute: ''
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

  const fmtDate = (d: any) => new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  const isWorking = selectedProject && activeProject?.id === selectedProject.id;

  return (
    <div className="fx-page @container">
      <SectionHead
        title="Проекты"
        count={projects.length || undefined}
        actions={canCreate && (
          <Btn tone="primary" onClick={() => setShowCreate(true)} data-tour="project-create-btn" title="Создать новый проект"><Plus />Создать проект</Btn>
        )}
      />
      <div className="flex-1 min-h-0 flex">
        {/* Список проектов: строка 32 — код, название, дата. Тот, что в работе,
            отмечен точкой; выбранный в списке — подложкой */}
        <div className="fx-side w-60 @[820px]:w-80 shrink-0 flex flex-col min-h-0">
          <div className="p-2">
            <label className="relative block">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск: название или описание" aria-label="Поиск проектов" className="pl-7" />
            </label>
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {loading && projects.length === 0 ? (
              <div className="px-2 py-3 text-xs text-slate-400">Загрузка…</div>
            ) : filteredProjects.length === 0 ? (
              <div className="px-2 py-3 text-xs text-slate-400">Проекты не найдены</div>
            ) : filteredProjects.map((p) => {
              const working = activeProject?.id === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  data-share-route="/projects"
                  data-share-focus={`project:${p.id}`}
                  data-share-label={`Проект: ${p.name}`}
                  aria-current={selectedProject?.id === p.id ? 'true' : undefined}
                  onClick={() => { void selectProject(p); }}
                  title={p.description || p.name}
                  className="fx-li w-full text-left"
                >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${working ? 'bg-emerald-500' : 'bg-transparent'}`} aria-label={working ? 'в работе' : undefined} />
                  {(p as any).code && <span className="code text-xs text-slate-400 shrink-0">{(p as any).code}</span>}
                  <span className="truncate">{p.name}</span>
                  <span className="fx-n">{fmtDate(p.createdAt)}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Карточка выбранного проекта — одна поверхность */}
        <div className="flex-1 min-w-[320px] overflow-y-auto">
          {selectedProject ? (
            <div className="max-w-3xl px-6 py-3">
              <div className="flex items-start gap-3 pb-3">
                <div className="min-w-0 flex-1">
                  <h2 className="text-[15px] font-semibold text-slate-900 dark:text-white truncate" title={selectedProject.name}>{selectedProject.name}</h2>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    {isWorking && <Status tone="emerald">Выбран для работы</Status>}
                    {(selectedProject as any).code && <span>код {(selectedProject as any).code}</span>}
                    <span>заведён {fmtDate(selectedProject.createdAt)}</span>
                  </div>
                </div>
                <Btn onClick={() => handleToggleActiveProject(selectedProject)} title={isWorking ? 'Снять активный статус' : 'Выбрать как активный проект'}>
                  {isWorking ? 'Снять с работы' : 'Взять в работу'}
                </Btn>
                {/* Состав: кто видит проект. Раньше кнопка была только у тех, кто
                    не может править проект, — руководитель мог задать состав
                    лишь сразу после создания */}
                <Btn onClick={() => setMembersFor({ id: selectedProject.id, name: selectedProject.name })} title="Кто работает над проектом: кто не в списке — не увидит ни проекта, ни его файлов">
                  <Users />Участники
                </Btn>
                {canManage && (
                  <IconBtn label="Удалить проект" onClick={() => handleDeleteProject(selectedProject.id, selectedProject.name)} className="hover:text-rose-600">
                    <Trash2 />
                  </IconBtn>
                )}
              </div>

              {canManage ? (
                <>
                  <SectionTitle>Карточка проекта</SectionTitle>
                  <div className="@container pt-2">
                    <ProjectFields value={draft} onChange={setDraft} disabled={isSaving} showStatus />
                  </div>
                  <div className="flex justify-end gap-2 mt-4">
                    <Btn size="lg" onClick={() => initForm(selectedProject)}>Сбросить</Btn>
                    <Btn size="lg" tone="primary" disabled={isSaving} onClick={handleSaveProject}>{isSaving ? 'Сохранение…' : 'Сохранить'}</Btn>
                  </div>
                </>
              ) : (
                <>
                  <SectionTitle>Краткое описание</SectionTitle>
                  <p className="text-slate-700 dark:text-slate-300 py-1">{selectedProject.description || 'Не заполнено.'}</p>
                  <SectionTitle>Подробное описание</SectionTitle>
                  <p className="text-slate-700 dark:text-slate-300 py-1 whitespace-pre-line">{selectedProject.info || 'Не заполнено.'}</p>
                </>
              )}
            </div>
          ) : (
            <Empty title="Проект не выбран" text="Выберите проект слева или создайте новый." />
          )}
        </div>
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
    </div>
  );
}
