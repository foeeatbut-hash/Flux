/**
 * Поля проекта — панель разметки шапки.
 *
 * Заменяет модальный мастер «Собрать данные». Разница не в оформлении: мастер
 * закрывал собой таблицу и спрашивал всё сразу — сущность, галочки столбцов,
 * фильтр, — а на выходе отдавал готовую таблицу, которую оставалось только
 * принять. Здесь панель стоит сбоку и не мешает смотреть на лист: выделил
 * ячейку — нажал поле — в ячейке встало его название. Выделил следующую —
 * следующее поле. Данные не собираются, пока не нажмут «Собрать».
 *
 * Список полей строится не по словарю программы, а по самому проекту: все
 * характеристики берутся из бланков, поэтому в одном проекте здесь «Расход
 * воздуха», а в другом «Расход теплоносителя». Правила списка — в
 * lib/tableLayout, и проверяются скриптом; здесь только показ.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Search, X, Trash2, Save, FolderOpen, Check, MousePointerClick, Boxes } from 'lucide-react';
import {
  GRAINS, catalogFields, searchFields, bySection, headerText, cellAddress, layoutRole,
  type CatalogField, type ProjectCatalog, type TableLayout,
} from '../../lib/tableLayout';
import { ROLES } from '../../../equipment/roles';

export default function FieldsPanel({
  catalog, layout, cursor, onPick, onDrop, onGrain, onRole, onClose, templates, views, onApplyView,
  onSaveTemplate, onApplyTemplate, onDeleteTemplate,
}: {
  catalog: ProjectCatalog | null;
  layout: TableLayout;
  /** Выделенная на листе ячейка — туда встанет поле. Пусто — ещё не выбрали */
  cursor: { row: number; col: number } | null;
  onPick: (field: CatalogField) => void;
  onDrop: (col: number) => void;
  onGrain: (grain: string) => void;
  /** Оставить в таблице позиции одной роли; пусто — все подряд */
  onRole: (role: string) => void;
  onClose: () => void;
  templates: { id: string; name: string; scope: string; columns: { title: string }[] }[];
  /** Шаблоны вида из «Оборудования»: какие характеристики нужны для работы */
  views: { id: string; name: string; scope: string; role: string; fields: { key: string }[]; spec?: { v?: number; columns?: unknown[] } | null }[];
  onApplyView: (id: string) => void;
  onSaveTemplate: (name: string, personal: boolean) => void;
  onApplyTemplate: (id: string) => void;
  onDeleteTemplate: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [personal, setPersonal] = useState(false);
  const [shelf, setShelf] = useState(false);
  const [viewShelf, setViewShelf] = useState(false);

  const all = useMemo(() => catalogFields(catalog, layout.grain), [catalog, layout.grain]);
  const found = useMemo(() => bySection(searchFields(all, query)), [all, query]);

  // Сменили вид строки — прежний поиск почти наверняка ничего не найдёт
  useEffect(() => { setQuery(''); }, [layout.grain]);

  const picked = new Set(layout.columns.map((c) => c.path));
  const at = cursor ? cellAddress(cursor.row, cursor.col) : '';

  return (
    <aside className="w-80 shrink-0 border-l border-slate-200 dark:border-dark-border bg-white
                      dark:bg-dark-surface flex flex-col" aria-label="Поля проекта">
      <div className="flex items-center gap-2 px-3 h-11 border-b border-slate-200 dark:border-dark-border">
        <span className="text-sm font-bold text-slate-800 dark:text-slate-100">Поля проекта</span>
        <span className="flex-1" />
        <button type="button" onClick={onClose} aria-label="Закрыть"
          className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer text-slate-400
                     hover:bg-slate-100 dark:hover:bg-slate-850 hover:text-slate-600">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Куда встанет поле. Это и есть весь ход разметки, поэтому строка стоит
          первой и называет ячейку так, как человек видит её на листе */}
      <div className={`px-3 py-2 flex items-center gap-2 border-b text-2xs ${
        at
          ? 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/50 text-emerald-800 dark:text-emerald-200'
          : 'border-slate-200 dark:border-dark-border bg-slate-50 dark:bg-slate-900 text-slate-500 dark:text-slate-400'
      }`}>
        <MousePointerClick className="w-3.5 h-3.5 shrink-0" />
        {at ? (
          <span>Поле встанет в <span className="font-bold font-mono">{at}</span></span>
        ) : (
          <span>Выделите ячейку шапки на листе</span>
        )}
      </div>

      {/* Что считать строкой. От этого зависит весь список ниже, поэтому выбор
          стоит наверху, а не прячется в настройках */}
      <div className="px-3 py-2 border-b border-slate-200 dark:border-dark-border">
        <div className="flex p-0.5 rounded-lg bg-slate-100 dark:bg-slate-900">
          {GRAINS.map((g) => (
            <button key={g.id} type="button" onClick={() => onGrain(g.id)}
              className={`flex-1 px-2 py-1 rounded-md text-2xs font-semibold cursor-pointer transition-colors ${
                layout.grain === g.id
                  ? 'bg-white dark:bg-slate-750 text-emerald-700 dark:text-emerald-300 shadow-sm'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
              }`}>
              {g.label}
            </button>
          ))}
        </div>

        {/* Роль строки. Это обычный отбор по обычному полю, а не третий вид
            строки: «вывести только датчики ПТС» — те же позиции, только не все */}
        {layout.grain === 'element' && (
          <label className="mt-1.5 flex items-center gap-1.5">
            <span className="text-2xs text-slate-500 dark:text-slate-400 shrink-0">Роль</span>
            <select value={layoutRole(layout)} onChange={(e) => onRole(e.target.value)}
              className="flex-1 min-w-0 px-1.5 py-1 text-2xs rounded-md border border-slate-200
                         dark:border-slate-700 bg-white dark:bg-slate-800 cursor-pointer">
              <option value="">все позиции</option>
              {ROLES.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
            </select>
          </label>
        )}
      </div>

      {/* Что уже размечено: отсюда поле и снимается, без похода на лист */}
      {layout.columns.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-200 dark:border-dark-border">
          <div className="text-2xs font-semibold text-slate-500 dark:text-slate-400 mb-1.5">
            В шапке — {layout.columns.length}
          </div>
          <div className="flex flex-wrap gap-1">
            {layout.columns.map((c) => (
              <span key={c.col}
                className="inline-flex items-center gap-1 pl-2 pr-0.5 py-0.5 rounded-md border
                           border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950
                           text-2xs text-emerald-800 dark:text-emerald-200">
                <span className="font-mono text-emerald-600 dark:text-emerald-400">
                  {cellAddress(layout.headerRow, c.col)}
                </span>
                {headerText(c)}
                <button type="button" onClick={() => onDrop(c.col)} aria-label={`Убрать ${c.title}`}
                  className="w-4 h-4 rounded flex items-center justify-center cursor-pointer
                             hover:bg-emerald-200 dark:hover:bg-emerald-900">
                  <X className="w-2.5 h-2.5" />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-200 dark:border-dark-border">
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Найти поле"
            className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800
                       rounded-lg pl-8 pr-2 py-1.5 text-xs text-slate-800 dark:text-slate-150 outline-none
                       focus:bg-white dark:focus:bg-slate-950 focus:border-emerald-400" />
        </div>
      </div>

      <div className="flex-1 overflow-auto scrollbar-thin">
        {found.length === 0 && (
          <p className="px-3 py-4 text-xs text-slate-500 dark:text-slate-400">
            {all.length ? 'Ничего не нашлось' : 'В проекте пока нет данных, из которых можно собирать'}
          </p>
        )}
        {found.map((group) => (
          <div key={group.section}>
            <div className="px-3 py-1.5 text-2xs font-bold uppercase tracking-wide text-slate-400
                            dark:text-slate-500 bg-slate-50 dark:bg-slate-900 border-y border-slate-100
                            dark:border-slate-850 sticky top-0 z-10">
              {group.section}
            </div>
            {group.fields.map((f) => (
              <button key={f.path} type="button" onClick={() => onPick(f)}
                title={f.sample ? `Например: ${f.sample}` : undefined}
                className={`w-full text-left pr-3 py-1.5 cursor-pointer grid items-baseline gap-x-2
                            grid-cols-[1fr_auto] border-l-2 hover:bg-slate-50 dark:hover:bg-slate-850 ${
                  picked.has(f.path)
                    ? 'pl-2.5 border-emerald-500 bg-emerald-50/70 dark:bg-emerald-950/40'
                    : 'pl-3 border-transparent'}`}>
                <span className="flex items-baseline gap-1.5 min-w-0">
                  {/* Уже размеченное поле должно быть видно сразу: иначе его
                      выбирают второй раз и удивляются двум одинаковым столбцам */}
                  {picked.has(f.path) && <Check className="w-3 h-3 shrink-0 text-emerald-600 self-center" />}
                  <span className="text-xs text-slate-800 dark:text-slate-150 truncate">{f.title}</span>
                  {f.unit && (
                    <span className="shrink-0 px-1 rounded bg-slate-100 dark:bg-slate-900 text-2xs text-slate-500">
                      {f.unit}
                    </span>
                  )}
                </span>
                {/* Заполненность важнее названия: поле, которого нет ни у кого,
                    в таблице даст пустой столбец, и лучше это знать заранее */}
                <span className={`text-2xs text-right tabular-nums ${
                  f.filled === undefined ? '' : f.filled ? 'text-slate-400' : 'text-amber-600 font-semibold'}`}>
                  {f.filled === undefined ? '' : f.filled ? `есть у ${f.filled}` : 'пусто'}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* Шаблоны вида — из раздела «Оборудование».
          Разделение здесь главное: шаблон вида отвечает «какие поля нужны», а
          таблица — «в каком порядке и в каких столбцах». Поэтому он кладёт
          поля подряд от выбранной ячейки, а дальше человек двигает столбцы */}
      <div className="border-t border-slate-200 dark:border-dark-border">
        <button type="button" onClick={() => setViewShelf((v) => !v)}
          className="w-full px-3 py-2 flex items-center gap-2 cursor-pointer text-2xs font-semibold
                     text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-850">
          <Boxes className="w-3.5 h-3.5" />
          Шаблоны вида
          <span className="flex-1" />
          <span className="text-slate-400">{views.length}</span>
        </button>

        {viewShelf && (
          <div className="px-3 pb-2 space-y-1 max-h-40 overflow-auto scrollbar-thin">
            {views.length === 0 && (
              <p className="text-2xs text-slate-500 dark:text-slate-400">
                Пока ни одного. Наборы характеристик заводят в разделе «Оборудование» —
                кнопкой «Сохранить вид» в карточке позиции.
              </p>
            )}
            {views.map((v) => (
              <button key={v.id} type="button" onClick={() => onApplyView(v.id)}
                className="w-full text-left px-2 py-1 rounded-lg cursor-pointer text-2xs
                           text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">
                {v.name}
                <span className="text-slate-400">
                  {' · '}{v.spec?.v === 2 ? `${(v.spec.columns || []).length} столбцов · разложить и собрать` : `${v.fields.length} полей`}{v.role ? ` · ${v.role.toLowerCase()}` : ''}{v.scope === 'PERSONAL' ? ' · личный' : ''}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Шаблоны шапки: набор полей без данных, общий на всю программу или свой */}
      <div className="border-t border-slate-200 dark:border-dark-border">
        <button type="button" onClick={() => setShelf((v) => !v)}
          className="w-full px-3 py-2 flex items-center gap-2 cursor-pointer text-2xs font-semibold
                     text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-850">
          <FolderOpen className="w-3.5 h-3.5" />
          Шаблоны шапки
          <span className="flex-1" />
          <span className="text-slate-400">{templates.length}</span>
        </button>

        {shelf && (
          <div className="px-3 pb-2 space-y-1 max-h-40 overflow-auto scrollbar-thin">
            {templates.length === 0 && (
              <p className="text-2xs text-slate-500 dark:text-slate-400">
                Пока ни одного. Разметьте шапку и сохраните — она откроется в любом проекте.
              </p>
            )}
            {templates.map((t) => (
              <div key={t.id} className="flex items-center gap-1">
                <button type="button" onClick={() => onApplyTemplate(t.id)}
                  className="flex-1 text-left px-2 py-1 rounded-lg cursor-pointer text-2xs
                             text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">
                  {t.name}
                  <span className="text-slate-400"> · {t.columns.length} полей{t.scope === 'PERSONAL' ? ' · личный' : ''}</span>
                </button>
                <button type="button" onClick={() => onDeleteTemplate(t.id)} aria-label={`Удалить ${t.name}`}
                  className="w-5 h-5 rounded flex items-center justify-center cursor-pointer text-slate-400
                             hover:bg-rose-50 dark:hover:bg-rose-950 hover:text-rose-600">
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}

            {saving ? (
              <div className="space-y-1 pt-1">
                <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
                  placeholder="Название шаблона"
                  onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) { onSaveTemplate(name.trim(), personal); setSaving(false); setName(''); } }}
                  className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800
                             rounded-lg px-2 py-1 text-2xs text-slate-800 dark:text-slate-150 outline-none
                             focus:border-emerald-400" />
                <label className="flex items-center gap-1.5 text-2xs text-slate-600 dark:text-slate-400 cursor-pointer">
                  <input type="checkbox" checked={personal} onChange={(e) => setPersonal(e.target.checked)} />
                  Только мне
                </label>
                <button type="button" disabled={!name.trim()}
                  onClick={() => { onSaveTemplate(name.trim(), personal); setSaving(false); setName(''); }}
                  className="w-full px-2 py-1 rounded-lg text-2xs font-semibold cursor-pointer bg-emerald-600
                             text-white hover:bg-emerald-700 disabled:opacity-50">
                  Сохранить
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => setSaving(true)} disabled={!layout.columns.length}
                title={layout.columns.length ? '' : 'Сначала разметьте шапку'}
                className="w-full mt-1 px-2 py-1 rounded-lg flex items-center justify-center gap-1
                           text-2xs font-semibold cursor-pointer bg-slate-100 dark:bg-slate-900
                           text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800
                           disabled:opacity-50">
                <Save className="w-3 h-3" /> Сохранить эту шапку
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
