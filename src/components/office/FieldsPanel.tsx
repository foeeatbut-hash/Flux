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
import { Search, X, Trash2, Save, FolderOpen } from 'lucide-react';
import {
  GRAINS, catalogFields, searchFields, bySection, headerText,
  type CatalogField, type ProjectCatalog, type TableLayout,
} from '../../lib/tableLayout';

export default function FieldsPanel({
  catalog, layout, activeCol, onPick, onDrop, onGrain, onClose, templates,
  onSaveTemplate, onApplyTemplate, onDeleteTemplate,
}: {
  catalog: ProjectCatalog | null;
  layout: TableLayout;
  /** Куда встанет выбранное поле. Пусто — человек ещё не выбрал ячейку */
  activeCol: number | null;
  onPick: (field: CatalogField) => void;
  onDrop: (col: number) => void;
  onGrain: (grain: string) => void;
  onClose: () => void;
  templates: { id: string; name: string; scope: string; columns: { title: string }[] }[];
  onSaveTemplate: (name: string, personal: boolean) => void;
  onApplyTemplate: (id: string) => void;
  onDeleteTemplate: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [personal, setPersonal] = useState(false);
  const [shelf, setShelf] = useState(false);

  const all = useMemo(() => catalogFields(catalog, layout.grain), [catalog, layout.grain]);
  const found = useMemo(() => bySection(searchFields(all, query)), [all, query]);

  // Сменили вид строки — прежний поиск почти наверняка ничего не найдёт
  useEffect(() => { setQuery(''); }, [layout.grain]);

  const picked = new Set(layout.columns.map((c) => c.path));

  return (
    <aside className="w-72 shrink-0 border-l border-slate-200 dark:border-dark-border bg-white
                      dark:bg-dark-surface flex flex-col" aria-label="Поля проекта">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-dark-border">
        <span className="text-sm font-bold text-slate-800 dark:text-slate-100">Поля проекта</span>
        <span className="flex-1" />
        <button type="button" onClick={onClose} aria-label="Закрыть"
          className="w-6 h-6 rounded flex items-center justify-center cursor-pointer text-slate-400
                     hover:bg-slate-100 dark:hover:bg-slate-850">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Что считать строкой. От этого зависит весь список ниже, поэтому выбор
          стоит наверху, а не прячется в настройках */}
      <div className="px-3 py-2 border-b border-slate-200 dark:border-dark-border flex gap-1">
        {GRAINS.map((g) => (
          <button key={g.id} type="button" onClick={() => onGrain(g.id)}
            className={`px-2 py-1 rounded-lg text-2xs font-semibold cursor-pointer ${
              layout.grain === g.id
                ? 'bg-emerald-600 text-white'
                : 'bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800'
            }`}>
            {g.label}
          </button>
        ))}
      </div>

      {/* Что уже размечено: отсюда поле и снимается, без похода на лист */}
      {layout.columns.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-200 dark:border-dark-border">
          <div className="text-2xs font-semibold text-slate-500 dark:text-slate-400 mb-1">
            В шапке — {layout.columns.length}
          </div>
          <div className="flex flex-wrap gap-1">
            {layout.columns.map((c) => (
              <span key={c.col}
                className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md bg-emerald-50
                           dark:bg-emerald-950 text-2xs text-emerald-800 dark:text-emerald-200">
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
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Найти поле"
            className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800
                       rounded-lg pl-7 pr-2 py-1.5 text-xs text-slate-800 dark:text-slate-150 outline-none
                       focus:border-emerald-400" />
        </div>
        <p className="mt-1.5 text-2xs text-slate-500 dark:text-slate-400">
          {activeCol === null
            ? 'Выделите ячейку шапки на листе, потом нажмите поле'
            : 'Нажмите поле — оно встанет в выделенную ячейку'}
        </p>
      </div>

      <div className="flex-1 overflow-auto scrollbar-thin">
        {found.length === 0 && (
          <p className="px-3 py-4 text-xs text-slate-500 dark:text-slate-400">
            {all.length ? 'Ничего не нашлось' : 'В проекте пока нет данных, из которых можно собирать'}
          </p>
        )}
        {found.map((group) => (
          <div key={group.section}>
            <div className="px-3 py-1 text-2xs font-bold uppercase tracking-wide text-slate-400
                            dark:text-slate-500 bg-slate-50 dark:bg-slate-900 sticky top-0">
              {group.section}
            </div>
            {group.fields.map((f) => (
              <button key={f.path} type="button" onClick={() => onPick(f)}
                title={f.sample ? `Например: ${f.sample}` : undefined}
                className={`w-full text-left px-3 py-1.5 cursor-pointer flex items-baseline gap-2
                            hover:bg-slate-50 dark:hover:bg-slate-850 ${
                  picked.has(f.path) ? 'bg-emerald-50/60 dark:bg-emerald-950/40' : ''}`}>
                <span className="text-xs text-slate-800 dark:text-slate-150 truncate">{f.title}</span>
                {f.unit && <span className="text-2xs text-slate-400 shrink-0">{f.unit}</span>}
                <span className="flex-1" />
                {/* Заполненность важнее названия: поле, которого нет ни у кого,
                    в таблице даст пустой столбец, и лучше это знать заранее */}
                {f.filled !== undefined && (
                  <span className={`text-2xs shrink-0 ${f.filled ? 'text-slate-400' : 'text-amber-600'}`}>
                    {f.filled ? `есть у ${f.filled}` : 'пусто'}
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}
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
