/**
 * Библиотека Flux Office: что лежит в программе и чем это открыть.
 *
 * Вынесена из экрана по двум причинам. Экран держал и библиотеку, и редактор
 * книги, и обвязку — найти в нём разметку карточки было отдельной задачей, а
 * храповик размера давно упирался. И вторая: «Таблица» и «Документ» —
 * ОДИН экран с разным умолчанием, и это различие должно быть видно в одном
 * месте, а не размазано по тысяче строк.
 *
 * Здесь только разметка и обработчики наверх: ни запросов, ни знания о том,
 * что такое проект.
 */
import React, { useState } from 'react';
import {
  Table2, FileText, Plus, Copy, Trash2, RotateCcw, Lock, Users2, Search,
  ChevronDown, Loader2, Stamp,
} from 'lucide-react';
import { fmtDate, type DocMeta } from '../../lib/officeDocs';

export type LibraryTab = 'all' | 'sheet' | 'text';
export type NewKind = 'DOC' | 'TEXT' | 'TITLE';

export interface DocLibraryProps {
  loading: boolean;
  /** Какая это программа семьи: «Таблица» (DOC) или «Документ» (TEXT) */
  myKind: 'DOC' | 'TEXT';
  tab: LibraryTab;
  onTab: (t: LibraryTab) => void;
  query: string;
  onQuery: (v: string) => void;
  sort: 'updated' | 'name';
  onSort: (v: 'updated' | 'name') => void;
  recents: DocMeta[];
  myDocs: DocMeta[];
  sharedDocs: DocMeta[];
  templates: DocMeta[];
  titleTemplates: DocMeta[];
  trash: DocMeta[];
  trashOpen: boolean;
  onTrashOpen: (v: boolean) => void;
  onOpen: (id: string) => void;
  onCreate: (kind: NewKind) => void;
  onDuplicate: (id: string) => void;
  onPatch: (id: string, body: any, okMsg?: string) => void;
  onFromTemplate: (d: DocMeta) => void;
  onDeleteForever: (id: string) => void;
}

export default function DocLibrary({
  loading, myKind, tab, onTab, query, onQuery, sort, onSort,
  recents, myDocs, sharedDocs, templates, titleTemplates, trash, trashOpen, onTrashOpen,
  onOpen, onCreate, onDuplicate, onPatch, onFromTemplate, onDeleteForever,
}: DocLibraryProps) {
  const Card = ({ d, inTrash }: { d: DocMeta; inTrash?: boolean }) => (
    <div className="group bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 hover:border-emerald-400 dark:hover:border-emerald-700 hover:shadow-md transition-ui cursor-pointer"
      onClick={() => !inTrash && onOpen(d.id)}>
      <div className="flex items-start justify-between gap-2">
        {/* Тип видно по иконке: таблица — изумруд, документ — синий, титул — рамка */}
        {d.kind === 'TEXT'
          ? <FileText className="w-5 h-5 text-sky-600 dark:text-sky-500 shrink-0 mt-0.5" />
          : d.kind === 'TITLE'
            ? <FileText className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" />
            : <Table2 className="w-5 h-5 text-emerald-600 dark:text-emerald-500 shrink-0 mt-0.5" />}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
          {!inTrash && (
            <>
              <button type="button" title="Дублировать" onClick={() => onDuplicate(d.id)} className="p-1.5 text-slate-400 hover:text-emerald-600 rounded cursor-pointer"><Copy className="w-3.5 h-3.5" /></button>
              <button type="button" title="В корзину" onClick={() => onPatch(d.id, { deleted: true }, 'Перемещён в корзину')} className="p-1.5 text-slate-400 hover:text-rose-500 rounded cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>
            </>
          )}
          {inTrash && (
            <>
              <button type="button" title="Восстановить" onClick={() => onPatch(d.id, { deleted: false }, 'Восстановлен')} className="p-1.5 text-slate-400 hover:text-emerald-600 rounded cursor-pointer"><RotateCcw className="w-3.5 h-3.5" /></button>
              <button type="button" title="Удалить навсегда" onClick={() => onDeleteForever(d.id)} className="p-1.5 text-slate-400 hover:text-rose-500 rounded cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>
            </>
          )}
        </div>
      </div>
      <div className="mt-2.5 font-semibold text-sm text-slate-800 dark:text-white min-w-0 flex items-center gap-1.5">
        {d.scope === 'PERSONAL' && <Lock className="w-3 h-3 text-slate-400 shrink-0" />}
        <span className="flex-1 min-w-0 truncate">{d.name}</span>
      </div>
      <div className="mt-1 text-xs text-slate-400 flex items-center gap-2">
        <span>{fmtDate(d.updatedAt)}</span>
        {d.kind === 'TEMPLATE' && <span className="px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 font-bold">ШАБЛОН</span>}
        {d.kind === 'TITLE' && <span className="px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 font-bold">ТИТУЛ</span>}
        {!d.named && d.kind !== 'TEMPLATE' && d.kind !== 'TITLE' && <span className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 font-bold">ЧЕРНОВИК</span>}
      </div>
      {d.kind === 'TEMPLATE' && !inTrash && (
        <button type="button"
          onClick={e => { e.stopPropagation(); onFromTemplate(d); }}
          className="mt-2.5 w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold cursor-pointer">
          <Plus className="w-3 h-3" /> Создать документ
        </button>
      )}
    </div>
  );

  const Section = ({ title, icon: Icon, items, inTrash }: any) => (
    <div>
      <h2 className="text-sm font-bold text-slate-600 dark:text-slate-300 mb-3 flex items-center gap-2">
        <Icon className="w-4 h-4 text-slate-400" /> {title} <span className="text-slate-400 font-normal">({items.length})</span>
      </h2>
      {items.length > 0 ? (
        <div className="grid grid-cols-1 @[560px]:grid-cols-2 @[820px]:grid-cols-3 @[1100px]:grid-cols-4 gap-3">
          {items.map((d: DocMeta) => <Card key={d.id} d={d} inTrash={inTrash} />)}
        </div>
      ) : (
        <div className="border border-dashed border-slate-200 dark:border-slate-800 rounded-xl px-4 py-7 text-center">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {inTrash
              ? 'В корзине пусто.'
              : myKind === 'TEXT' ? 'Здесь появятся ваши документы.' : 'Здесь появятся ваши таблицы.'}
          </p>
          {!inTrash && (
            <div className="flex items-center justify-center gap-2 mt-3">
              <button type="button" onClick={() => onCreate(myKind)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 transition-ui cursor-pointer">
                <Plus className="w-3.5 h-3.5" /> Создать {myKind === 'TEXT' ? 'документ' : 'таблицу'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );

  const [createOpen, setCreateOpen] = useState(false);
  const NEW_KINDS: Array<{ kind: 'DOC' | 'TEXT' | 'TITLE'; label: string; hint: string; Icon: any }> = [
    { kind: 'DOC', label: 'Таблица', hint: 'Формулы, данные проекта, метки', Icon: Table2 },
    { kind: 'TEXT', label: 'Документ', hint: 'Страницы, стили, списки — как в Word', Icon: FileText },
    { kind: 'TITLE', label: 'Шаблон титула', hint: 'Присваивается документам проекта', Icon: Stamp },
  ];
  const mine = NEW_KINDS.find(k => k.kind === myKind) || NEW_KINDS[0];

  return (
    <div className="space-y-5">
      {/*
        Одна полоса вместо карточки в четверть окна.
        Заголовок первого уровня, подзаголовок и три кнопки повторяли то, что
        и так написано в заголовке окна и на кнопке панели задач: человек
        открыл «Таблицу» — он знает, что это «Таблица». Две строки из десяти
        уходили на повтор, а список документов начинался ниже сгиба.
      */}
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        <div className="relative flex">
          <button type="button" data-tour="doc-create-btn" onClick={() => onCreate(mine.kind)}
            title={`Создать: ${mine.hint}`}
            className="flex items-center gap-2 pl-3 pr-2.5 py-2 rounded-l-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold cursor-pointer">
            <Plus className="w-4 h-4 shrink-0" /> Создать
          </button>
          <button type="button" onClick={() => setCreateOpen(v => !v)} aria-expanded={createOpen}
            title="Что ещё можно создать"
            className="px-1.5 py-2 rounded-r-lg bg-emerald-600 hover:bg-emerald-700 text-white border-l border-emerald-500 cursor-pointer">
            <ChevronDown className="w-4 h-4" />
          </button>
          {createOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setCreateOpen(false)} />
              <div className="absolute left-0 top-full mt-1 z-50 w-64 p-1 rounded-xl shadow-2xl
                              bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                {NEW_KINDS.map(k => (
                  <button type="button" key={k.kind}
                    onClick={() => { setCreateOpen(false); onCreate(k.kind); }}
                    className="w-full flex items-start gap-2.5 px-2.5 py-2 rounded-lg text-left
                               hover:bg-slate-100 dark:hover:bg-slate-850 cursor-pointer">
                    <k.Icon className="w-4 h-4 mt-0.5 shrink-0 text-emerald-600" />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-slate-800 dark:text-white">{k.label}</span>
                      <span className="block text-2xs text-slate-500 dark:text-slate-400">{k.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {([
          { id: 'sheet' as const, label: 'Таблицы' },
          { id: 'text' as const, label: 'Документы' },
          { id: 'all' as const, label: 'Все' },
        ]).map(t => (
          <button type="button" key={t.id} onClick={() => onTab(t.id)}
            className={`px-3 py-2 rounded-lg text-xs font-bold border cursor-pointer transition-ui ${tab === t.id
              ? 'bg-slate-800 dark:bg-slate-100 text-white dark:text-slate-900 border-slate-800 dark:border-slate-100'
              : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 hover:border-slate-400'}`}>
            {t.label}
          </button>
        ))}

        <div className="flex-1 min-w-[6rem]" />

        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Найти по названию"
            aria-label="Поиск по документам"
            className="pl-8 pr-3 py-2 w-40 @[560px]:w-56 min-w-0 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 text-xs outline-none focus:border-emerald-600 dark:focus:border-emerald-400"
          />
        </div>
        <select
          value={sort}
          onChange={(e) => onSort(e.target.value as 'updated' | 'name')}
          aria-label="Порядок документов"
          title="Порядок в списке"
          className="px-2 py-2 max-w-36 min-w-0 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 text-xs cursor-pointer"
        >
          <option value="updated">Сначала недавние</option>
          <option value="name">По названию</option>
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-slate-400"><Loader2 className="w-6 h-6 animate-spin" /></div>
      ) : (
        <>
          {recents.length > 0 && (
            <Section title="Продолжить" icon={RotateCcw} items={recents} />
          )}
          <Section title="Мои файлы" icon={Lock} items={myDocs} />
          <Section title="Общие файлы" icon={Users2} items={sharedDocs} />
          {templates.length > 0 && <Section title="Шаблоны" icon={Copy} items={templates} />}
          {titleTemplates.length > 0 && <Section title="Шаблоны титула" icon={FileText} items={titleTemplates} />}

          {trash.length > 0 && (
            <div>
              <button type="button" onClick={() => onTrashOpen(!trashOpen)} className="text-sm font-bold text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 flex items-center gap-2 cursor-pointer">
                <Trash2 className="w-4 h-4" /> Корзина ({trash.length}) {trashOpen ? '▾' : '▸'}
              </button>
              {trashOpen && (
                <div className="mt-3 grid grid-cols-1 @[560px]:grid-cols-2 @[820px]:grid-cols-3 @[1100px]:grid-cols-4 gap-3 opacity-70">
                  {trash.map(d => <Card key={d.id} d={d} inTrash />)}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
