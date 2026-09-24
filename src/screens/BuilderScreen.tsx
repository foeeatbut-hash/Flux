/**
 * Конструктор — подбор оборудования по проекту и выпуск бланков.
 *
 * Путь инженера: MTO или спецификация → ведомость (строка = тег) → подбор
 * изделия из Каталога по описанию или мастером → проверка → бланки заказа в
 * Excel и PDF с ревизией. Первый класс оборудования — клапаны; следующий
 * добавится в Каталог данными, и Конструктор подберёт его тем же путём.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ClipboardList, Sparkles, Upload, LayoutTemplate, Send, Plus, Pencil, Trash2, Undo2, Link2, Download, BookOpen, AlertTriangle } from 'lucide-react';
import { useStore } from '../store/store';
import { useCatalogStore } from '../store/catalogStore';
import { useBuilderStore } from '../store/builderStore';
import { useShallow } from 'zustand/react/shallow';
import { useCatalogLive } from '../components/catalog/useCatalogLive';
import { useToastStore } from '../store/toastStore';
import { useWindowStore } from '../store/windowStore';
import { can } from '../lib/permissions';
import { saveBytes } from '../lib/saveToWindows';
import NoProject from '../components/NoProject';
import SectionErrorBoundary from '../components/SectionErrorBoundary';
import ItemsTable from '../components/builder/ItemsTable';
import ItemPanel from '../components/builder/ItemPanel';
import ImportWizard from '../components/builder/ImportWizard';
import BlankDesigner from '../components/builder/BlankDesigner';
import IssuePanel from '../components/builder/IssuePanel';
import TagLinksPanel from '../components/builder/TagLinksPanel';
import DescribeMatch from '../components/catalog/DescribeMatch';
import { itemOps, exportListXlsx } from '../components/builder/useItemOps';
import { checkList } from '../../catalog/checks';
import { Btn, Chip, Empty, Select, confirmAsk, promptAsk, plural } from '../components/catalog/ui';

type Tab = 'list' | 'match' | 'import' | 'blanks' | 'issue';

const TABS: Array<{ id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'list', label: 'Ведомость', icon: ClipboardList },
  { id: 'match', label: 'Подбор', icon: Sparkles },
  { id: 'import', label: 'Импорт MTO', icon: Upload },
  { id: 'blanks', label: 'Бланки', icon: LayoutTemplate },
  { id: 'issue', label: 'Выпуск', icon: Send },
];

export default function BuilderScreen() {
  const project = useStore((s) => s.activeProject);
  const user = useStore((s) => s.user);
  const catalog = useCatalogStore((s) => s.catalog);
  const catLoaded = useCatalogStore((s) => s.loaded);
  const catError = useCatalogStore((s) => s.error);
  const loadCatalog = useCatalogStore((s) => s.load);
  const learned = useCatalogStore((s) => s.learned);
  const loadLearned = useCatalogStore((s) => s.loadLearned);
  const addToast = useToastStore((s) => s.addToast);
  // Селектором, а не всем хранилищем: экран перерисовывается от того, что
  // показывает, а не от каждого флажка стора
  const b = useBuilderStore(useShallow((s) => ({
    lists: s.lists, listId: s.listId, list: s.list, items: s.items, loading: s.loading, saving: s.saving, undoStack: s.undoStack,
    loadLists: s.loadLists, openList: s.openList, reload: s.reload, createList: s.createList, updateList: s.updateList,
    removeList: s.removeList, apply: s.apply, undo: s.undo,
  })));
  const [tab, setTab] = useState<Tab>('list');
  const [openId, setOpenId] = useState('');
  const [tagsOpen, setTagsOpen] = useState(false);

  useEffect(() => { loadCatalog(); loadLearned(); }, [loadCatalog, loadLearned]);
  useCatalogLive({ list: true });
  useEffect(() => { b.loadLists(project?.id || ''); }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ctrl+Z — отмена последнего действия ведомости. В полях ввода у Ctrl+Z своя
  // работа (отмена набора), её не перехватываем
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

  const classId = b.list?.classId || catalog.classes[0]?.id || 'cls-valve';
  const problems = useMemo(() => (catLoaded ? checkList(catalog, b.items) : []), [catalog, b.items, catLoaded]);
  const canEdit = can(user as any, 'builder.edit');
  const ops = useMemo(() => itemOps(catalog, classId, b.items, learned, b.apply), [catalog, classId, b.items, learned, b.apply]);
  const openItem = b.items.find((i) => i.id === openId);

  const run = async <T,>(what: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try { return await fn(); } catch (e: any) { addToast(`${what}: ${e?.message || e}`, 'error'); return undefined; }
  };

  if (!project) return <NoProject what="Конструктор" />;

  const newList = async () => {
    const name = await promptAsk('Новая ведомость', 'Как назвать ведомость? Например, «Клапаны — ДГП-2, E06»', `Клапаны — ${project.name}`);
    if (!name) return;
    await run('Ведомость не создалась', () => b.createList(name, classId));
  };
  const renameList = async () => {
    if (!b.list) return;
    const name = await promptAsk('Переименовать ведомость', undefined, b.list.name);
    if (name && name !== b.list.name) await run('Не переименовалось', () => b.updateList({ name }));
  };
  const deleteList = async () => {
    if (!b.list) return;
    if (!(await confirmAsk('Удалить ведомость?', `«${b.list.name}» и её ${b.items.length} поз. пропадут из проекта. Выпущенные файлы в Проводнике останутся.`, { confirmLabel: 'Удалить', tone: 'danger' }))) return;
    await run('Не удалилось', () => b.removeList(b.list!.id));
  };
  const undo = async () => {
    const t = await run('Не отменилось', () => b.undo());
    if (t) addToast(`Отменено: ${t}`, 'info');
  };
  const exportList = async () => {
    const bytes = await exportListXlsx(catalog, b.items, b.list?.name || 'Ведомость');
    const r = await saveBytes(`${(b.list?.name || 'Ведомость').replace(/[\\/:*?"<>|]+/g, '-')}.xlsx`, bytes);
    if (r.ok) addToast('Ведомость выгружена', 'success'); else if (!r.canceled) addToast(r.error || 'Не выгрузилось', 'error');
  };

  return (
    <SectionErrorBoundary title="Конструктор">
      <div className="h-full flex flex-col min-h-0 @container gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <b className="text-base font-bold">Конструктор</b>
          <span className="text-2xs text-slate-400">подбор по Каталогу и бланки заказа</span>
          <span className="flex-1" />
          {b.lists.length > 0 && (
            <Select value={b.listId} onChange={(id) => { setOpenId(''); b.openList(id); }} className="!w-auto max-w-[280px]" aria-label="Ведомость"
              options={b.lists.map((l) => ({ value: l.id, label: `${l.name}${l.items !== undefined ? ` · ${l.items} поз.` : ''}` }))} />
          )}
          {canEdit && <Btn onClick={newList}><Plus className="w-3.5 h-3.5" /> Ведомость</Btn>}
          {b.list && canEdit && <Btn tone="ghost" onClick={renameList} aria-label="Переименовать"><Pencil className="w-3.5 h-3.5" /></Btn>}
          {b.list && canEdit && <Btn tone="ghost" onClick={deleteList} aria-label="Удалить ведомость"><Trash2 className="w-3.5 h-3.5" /></Btn>}
          <Btn tone="ghost" onClick={() => useWindowStore.getState().open('/catalog')} title="Открыть Каталог оборудования"><BookOpen className="w-3.5 h-3.5" /> Каталог</Btn>
        </div>

        {catError && <div className="text-xs text-rose-600 dark:text-rose-400 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> {catError}</div>}

        {!b.list ? (
          b.loading ? <div className="text-xs text-slate-400">Загружаю…</div> : (
            <Empty title="В проекте ещё нет ведомостей подбора" text="Ведомость — это список позиций с тегами из MTO или спецификации. Из неё собираются бланки заказа.">
              {canEdit && <Btn tone="primary" onClick={newList}><Plus className="w-3.5 h-3.5" /> Создать ведомость</Btn>}
            </Empty>
          )
        ) : (
          <>
            <div className="flex items-center gap-1 border-b border-slate-100 dark:border-slate-800 flex-wrap">
              {TABS.map((t) => (
                <button key={t.id} type="button" onClick={() => setTab(t.id)} aria-pressed={tab === t.id}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border-b-2 -mb-px cursor-pointer ${tab === t.id ? 'border-emerald-600 text-emerald-700 dark:text-emerald-400' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-emerald-700'}`}>
                  <t.icon className="w-3.5 h-3.5" /> {t.label}
                  {t.id === 'list' && <span className="tabular-nums text-slate-400">{b.items.length}</span>}
                </button>
              ))}
              <span className="flex-1" />
              {b.saving && <Chip tone="sky">сохраняю…</Chip>}
              {b.undoStack.length > 0 && <Btn tone="ghost" onClick={undo} title={`Отменить: ${b.undoStack[0].title} (Ctrl+Z)`}><Undo2 className="w-3.5 h-3.5" /> Отменить</Btn>}
              {tab === 'list' && canEdit && <Btn tone="ghost" onClick={() => setTagsOpen(true)} title="Связать позиции с тегами проекта"><Link2 className="w-3.5 h-3.5" /> Теги проекта</Btn>}
              {tab === 'list' && <Btn tone="ghost" onClick={exportList} disabled={!b.items.length}><Download className="w-3.5 h-3.5" /> Ведомость в Excel</Btn>}
            </div>

            <div className="flex-1 min-h-0">
              {tab === 'list' && (
                tagsOpen ? <TagLinksPanel listId={b.list.id} onClose={() => setTagsOpen(false)} onDone={() => { setTagsOpen(false); b.reload(); }} /> : (
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
                        onPaste: async (text) => { if (!canEdit) return; const n = await run('Вставка', () => ops.paste(text)); if (n) addToast(`Вставлено ${n} поз.`, 'success'); },
                      }} />
                    </div>
                    {openItem && (
                      <div className="min-h-0 rounded-lg border border-slate-200 dark:border-slate-800 p-3 bg-white dark:bg-slate-900">
                        <ItemPanel catalog={catalog} item={openItem} onClose={() => setOpenId('')}
                          onRematch={(id) => { run('Подбор', () => ops.rematch([id])); }}
                          onSave={async (next, title) => (await run('Не сохранилось', () => b.apply(title, [next])))?.[0]} />
                      </div>
                    )}
                  </div>
                )
              )}
              {tab === 'match' && (
                <div className="h-full overflow-auto">
                  {catLoaded
                    ? <DescribeMatch catalog={catalog} classId={classId} learned={learned} onAccept={async (a) => { await run('Не добавилось', () => ops.accept(a)); addToast(`Добавлено в ведомость: ${a.tags[0] || catalog.families.find((f) => f.id === a.familyId)?.code}`, 'success'); }} />
                    : <div className="text-xs text-slate-400">Загружаю Каталог…</div>}
                </div>
              )}
              {tab === 'import' && (
                <div className="h-full min-h-0">
                  <ImportWizard catalog={catalog} classId={classId} items={b.items} learned={learned}
                    onApply={async (title, upserts, removeIds) => { await b.apply(title, upserts, removeIds); }}
                    onDone={() => { setTab('list'); addToast('Импорт записан. Отменить можно кнопкой «Отменить».', 'success'); }} />
                </div>
              )}
              {tab === 'blanks' && (
                <BlankDesigner catalog={catalog} items={b.items} header={b.list.header} orderNos={b.list.orderNos} canEdit={can(user as any, 'blanks.manage')} />
              )}
              {tab === 'issue' && (
                <div className="h-full overflow-auto">
                  <IssuePanel catalog={catalog} list={b.list} items={b.items} canIssue={can(user as any, 'builder.issue')} onUpdateList={(patch) => b.updateList(patch)} />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </SectionErrorBoundary>
  );
}
