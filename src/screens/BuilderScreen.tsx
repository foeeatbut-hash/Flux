/**
 * Конструктор — проектная спецификация, подбор изделий и выпуск документов.
 * Каталог задаёт доступные классы и модели; здесь хранятся решения проекта.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookOpen, Download, FileOutput, Link2, Plus, Upload, Undo2 } from 'lucide-react';
import { useStore } from '../store/store';
import { useCatalogStore } from '../store/catalogStore';
import { useBuilderStore } from '../store/builderStore';
import { useShallow } from 'zustand/react/shallow';
import { useCatalogLive } from '../components/catalog/useCatalogLive';
import { useToastStore } from '../store/toastStore';
import { useWindowStore } from '../store/windowStore';
import { can } from '../lib/permissions';
import { saveNewFile, editorHref } from '../lib/officeFiles';
import NoProject from '../components/NoProject';
import SectionErrorBoundary from '../components/SectionErrorBoundary';
import ItemsTable from '../components/builder/ItemsTable';
import ItemPanel from '../components/builder/ItemPanel';
import ImportWizard from '../components/builder/ImportWizard';
import BlankDesigner from '../components/builder/BlankDesigner';
import IssuePanel from '../components/builder/IssuePanel';
import TagLinksPanel from '../components/builder/TagLinksPanel';
import { itemOps, exportListXlsx } from '../components/builder/useItemOps';
import { checkList } from '../../catalog/checks';
import { textOf } from '../../catalog/model';
import { Btn, Empty, Select, confirmAsk, promptAsk, plural } from '../components/catalog/ui';
import { newItemId, nextSort } from '../store/builderStore';

type Action = 'import' | 'templates' | 'issue' | null;

export default function BuilderScreen() {
  const navigate = useNavigate();
  const project = useStore((s) => s.activeProject);
  const user = useStore((s) => s.user);
  const catalog = useCatalogStore((s) => s.catalog);
  const catLoaded = useCatalogStore((s) => s.loaded);
  const catError = useCatalogStore((s) => s.error);
  const loadCatalog = useCatalogStore((s) => s.load);
  const learned = useCatalogStore((s) => s.learned);
  const loadLearned = useCatalogStore((s) => s.loadLearned);
  const addToast = useToastStore((s) => s.addToast);
  const b = useBuilderStore(useShallow((s) => ({
    lists: s.lists, listId: s.listId, list: s.list, items: s.items, loading: s.loading, saving: s.saving, undoStack: s.undoStack,
    loadLists: s.loadLists, openList: s.openList, reload: s.reload, createList: s.createList, updateList: s.updateList,
    removeList: s.removeList, apply: s.apply, undo: s.undo,
  })));
  const [openId, setOpenId] = useState('');
  const [tagsOpen, setTagsOpen] = useState(false);
  const [action, setAction] = useState<Action>(null);
  const [newClassId, setNewClassId] = useState('');

  useEffect(() => { loadCatalog(); loadLearned(); }, [loadCatalog, loadLearned]);
  useCatalogLive({ list: true });
  useEffect(() => { b.loadLists(project?.id || ''); }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!newClassId && catalog.classes[0]) setNewClassId(catalog.classes[0].id); }, [catalog.classes, newClassId]);

  // Ctrl+Z — отмена записи спецификации. В полях ввода сочетание остаётся
  // обычной отменой набора, чтобы не потерять незаписанные значения.
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || e.shiftKey) return;
      if ((e.target as HTMLElement)?.closest?.('input,textarea,select,[contenteditable]')) return;
      if (!useBuilderStore.getState().undoStack.length) return;
      e.preventDefault();
      const t = await useBuilderStore.getState().undo().catch((err) => { addToast(err?.message || 'Не отменилось', 'error'); return ''; });
      if (t) addToast(`Отменено: ${t}`, 'info');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addToast]);

  const classId = b.list?.classId || newClassId || catalog.classes[0]?.id || 'cls-valve';
  const problems = useMemo(() => (catLoaded ? checkList(catalog, b.items) : []), [catalog, b.items, catLoaded]);
  const canEdit = can(user as any, 'builder.edit');
  const canLearn = can(user as any, 'catalog.edit') || can(user as any, 'catalog.manage');
  const ops = useMemo(() => itemOps(catalog, classId, b.items, learned, b.apply, canLearn), [catalog, classId, b.items, learned, b.apply, canLearn]);
  const openItem = b.items.find((i) => i.id === openId);

  const run = async <T,>(what: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try { return await fn(); } catch (e: any) { addToast(`${what}: ${e?.message || e}`, 'error'); return undefined; }
  };

  if (!project) return <NoProject what="Конструктор" />;

  const newList = async () => {
    const targetClassId = newClassId || classId;
    const cls = catalog.classes.find((c) => c.id === targetClassId);
    const className = cls ? textOf(cls.title) : 'оборудование';
    const name = await promptAsk('Новая спецификация', 'Как назвать спецификацию?', `${className} — ${project.name}`);
    if (!name) return;
    await run('Спецификация не создалась', () => b.createList(name, targetClassId));
  };
  const addItem = async () => {
    if (!b.list || !canEdit) return;
    try {
      const created = await b.apply('Добавление позиции', [{
        id: newItemId(), classId: b.list.classId, tags: [], qty: 1, values: {}, designation: '', status: 'draft', sort: nextSort(b.items),
      }]);
      if (created[0]) setOpenId(created[0].id);
    } catch (e: any) { addToast(`Позиция не добавилась: ${e?.message || e}`, 'error'); }
  };
  const renameList = async () => {
    if (!b.list) return;
    const name = await promptAsk('Переименовать спецификацию', undefined, b.list.name);
    if (name && name !== b.list.name) await run('Не переименовалось', () => b.updateList({ name }));
  };
  const deleteList = async () => {
    if (!b.list) return;
    if (!(await confirmAsk('Удалить спецификацию?', `«${b.list.name}» и её ${b.items.length} поз. пропадут из проекта. Выпущенные файлы в Проводнике останутся.`, { confirmLabel: 'Удалить', tone: 'danger' }))) return;
    await run('Не удалилось', () => b.removeList(b.list!.id));
  };
  const undo = async () => {
    const t = await run('Не отменилось', () => b.undo());
    if (t) addToast(`Отменено: ${t}`, 'info');
  };
  const exportList = async () => {
    try {
      const bytes = await exportListXlsx(catalog, b.items, b.list?.name || 'Спецификация');
      const name = `${(b.list?.name || 'Спецификация').replace(/[\\/:*?"<>|]+/g, '-')}.xlsx`;
      const made = await saveNewFile(bytes, name);
      addToast(`Спецификация выгружена: ${made.name}`, 'success');
      navigate(editorHref(made));
    } catch (e: any) { addToast(e?.message || 'Не выгрузилось', 'error'); }
  };

  return (
    <SectionErrorBoundary title="Конструктор оборудования">
      <div className="relative h-full min-h-0 flex flex-col @container gap-2">
        <div className="flex items-center gap-2 flex-wrap min-h-11">
          <span className="text-[15px] leading-5 font-semibold">Спецификация</span>
          <span className="text-xs text-slate-400 tabular-nums">{b.items.length} поз.</span>
          <span className="flex-1" />
          {b.lists.length > 0 && (
            <Select value={b.listId} onChange={(id) => { setOpenId(''); b.openList(id); }} className="!w-auto max-w-[280px]" aria-label="Спецификация"
              options={b.lists.map((l) => ({ value: l.id, label: `${l.name}${l.items !== undefined ? ` · ${l.items} поз.` : ''}` }))} />
          )}
          {canEdit && catalog.classes.length > 1 && <Select value={newClassId} onChange={setNewClassId} className="!w-auto max-w-[220px]" aria-label="Вид оборудования для новой спецификации"
            options={catalog.classes.map((c) => ({ value: c.id, label: textOf(c.title) }))} />}
          {canEdit && <Btn tone="primary" onClick={b.list ? addItem : newList}><Plus className="w-3.5 h-3.5" /> {b.list ? 'Добавить позицию' : 'Создать спецификацию'}</Btn>}
          {b.list && canEdit && <Btn tone="ghost" onClick={newList}><Plus className="w-3.5 h-3.5" /> Спецификация</Btn>}
          {b.list && canEdit && <Btn onClick={() => setAction('import')}><Upload className="w-3.5 h-3.5" /> Загрузить ведомость</Btn>}
          {b.list && <Btn onClick={() => setAction('issue')} disabled={!b.items.length}><FileOutput className="w-3.5 h-3.5" /> Выпустить документы</Btn>}
          {b.list && <Btn tone="ghost" onClick={() => setAction('templates')} title="Выбрать или настроить шаблоны документов">Шаблоны</Btn>}
          {b.list && canEdit && <Btn tone="ghost" onClick={renameList} aria-label="Переименовать спецификацию">Переименовать</Btn>}
          {b.list && canEdit && <Btn tone="ghost" onClick={deleteList} aria-label="Удалить спецификацию">Удалить</Btn>}
          <Btn tone="ghost" onClick={() => useWindowStore.getState().open('/catalog')} title="Открыть Каталог оборудования"><BookOpen className="w-3.5 h-3.5" /> Каталог</Btn>
        </div>

        {catError && <div className="text-xs text-rose-600 dark:text-rose-400">{catError}</div>}

        {!b.list ? (
          b.loading ? <div className="text-xs text-slate-400">Загружаю…</div> : (
            <Empty title="В проекте ещё нет спецификаций" text="Создайте спецификацию или выберите вид оборудования. В неё можно загрузить ведомость, добавить позиции вручную и выпустить документы.">
              {canEdit && <Btn tone="primary" onClick={newList}><Plus className="w-3.5 h-3.5" /> Создать спецификацию</Btn>}
            </Empty>
          )
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-slate-100 dark:border-slate-800 pb-1.5">
              <span className="text-xs font-medium truncate">{b.list.name}</span>
              {b.saving && <span className="text-xs text-slate-400">Сохраняю…</span>}
              <span className="flex-1" />
              {b.undoStack.length > 0 && <Btn tone="ghost" onClick={undo} title={`Отменить: ${b.undoStack[0].title} (Ctrl+Z)`}><Undo2 className="w-3.5 h-3.5" /> Отменить</Btn>}
              {canEdit && <Btn tone="ghost" onClick={() => setTagsOpen(true)} title="Связать позиции с тегами проекта"><Link2 className="w-3.5 h-3.5" /> Теги проекта</Btn>}
              <Btn tone="ghost" onClick={exportList} disabled={!b.items.length}><Download className="w-3.5 h-3.5" /> Excel</Btn>
            </div>

            <div className="flex-1 min-h-0">
              {tagsOpen ? <TagLinksPanel listId={b.list.id} onClose={() => setTagsOpen(false)} onDone={() => { setTagsOpen(false); b.reload(); }} /> : (
                <div className={`h-full min-h-0 grid gap-3 ${openItem ? 'grid-cols-1 @[1000px]:grid-cols-[minmax(0,1fr)_minmax(360px,440px)]' : 'grid-cols-1'}`}>
                  <div className={`min-h-0 ${openItem ? 'hidden @[1000px]:block' : ''}`}>
                    <ItemsTable catalog={catalog} items={b.items} problems={problems} openId={openId} actions={{
                      onOpen: setOpenId,
                      onRematch: async (ids) => { const r = await run('Подбор', () => ops.rematch(ids)); if (r) addToast(`Подобрано заново: ${r.done}${r.skipped ? `, пропущено ${r.skipped} (правлены руками или без описания)` : ''}`, 'info'); },
                      onSplit: (ids) => { run('Разбиение', () => ops.split(ids)); },
                      onMerge: async (ids) => { const r = await run('Объединение', () => ops.merge(ids)); if (r && !r.merged) addToast('Объединяются только позиции с одинаковым изделием', 'info'); },
                      onRemove: async (ids) => {
                        if (await confirmAsk(`Удалить ${ids.length} ${plural(ids.length, 'позицию', 'позиции', 'позиций')}?`, 'Удаление отменяется кнопкой «Отменить» или Ctrl+Z.', { confirmLabel: 'Удалить', tone: 'danger' })) {
                          if (ids.includes(openId)) setOpenId('');
                          run('Удаление', () => ops.remove(ids));
                        }
                      },
                      onBulkSet: (ids, key, value) => { run('Групповая правка', () => ops.bulkSet(ids, key, value)); },
                      onPaste: async (text) => {
                        if (!canEdit) return;
                        const result = await run('Вставка', () => ops.paste(text));
                        if (result?.inserted) addToast(`Вставлено ${result.inserted} поз.`, 'success');
                        if (result?.invalidQtyRows) addToast(`Не добавлено строк с нераспознанным количеством: ${result.invalidQtyRows}. Исправьте ввод и вставьте снова.`, 'error');
                      },
                    }} />
                  </div>
                  {openItem && (
                    <div className="min-h-0 border-l border-slate-200 dark:border-slate-800 pl-3">
                      <ItemPanel catalog={catalog} item={openItem} learned={learned} onClose={() => setOpenId('')}
                        onRematch={(id) => { run('Подбор', () => ops.rematch([id])); }}
                        onMatch={async (id, accepted) => {
                          try { await ops.matchItem(id, accepted); return true; }
                          catch (e: any) { addToast(`Подбор не сохранился: ${e?.message || e}`, 'error'); return false; }
                        }}
                        onSave={async (next, title) => (await run('Не сохранилось', () => b.apply(title, [next])))?.[0]} />
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}

        {action && b.list && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/30 p-3" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setAction(null); }}>
            <section className="flex flex-col min-h-0 w-full h-full max-w-[1400px] rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm" role="dialog" aria-modal="true" aria-label={action === 'import' ? 'Загрузить ведомость' : action === 'issue' ? 'Выпустить документы' : 'Шаблоны документов'}>
              <div className="flex items-center gap-3 px-4 py-2 border-b border-slate-200 dark:border-slate-700">
                <span className="text-sm font-semibold">{action === 'import' ? 'Загрузить ведомость' : action === 'issue' ? 'Выпустить документы' : 'Шаблоны документов'}</span>
                <span className="flex-1" />
                <Btn tone="ghost" onClick={() => setAction(null)}>К спецификации</Btn>
              </div>
              <div className="flex-1 min-h-0 overflow-auto p-3">
                {action === 'import' && <ImportWizard catalog={catalog} classId={classId} items={b.items} learned={learned} canLearn={canLearn}
                  onApply={async (title, upserts, removeIds) => { await b.apply(title, upserts, removeIds); }}
                  onDone={() => { setAction(null); addToast('Импорт записан. Отменить можно кнопкой «Отменить».', 'success'); }} />}
                {action === 'templates' && <BlankDesigner catalog={catalog} items={b.items} header={b.list.header} orderNos={b.list.orderNos} canEdit={can(user as any, 'blanks.manage')} />}
                {action === 'issue' && <IssuePanel catalog={catalog} list={b.list} items={b.items} canIssue={can(user as any, 'builder.issue')} onUpdateList={(patch) => b.updateList(patch)} />}
              </div>
            </section>
          </div>
        )}
      </div>
    </SectionErrorBoundary>
  );
}
