/**
 * Панель «Метки данных»: значения проекта в текст документа.
 *
 * Значения берутся теми же серверными функциями, что и формулы таблиц
 * (/api/constructor/fn), — иначе шифр проекта в записке и шифр в ведомости
 * однажды разойдутся. В документ попадает значение, а не формула: документ
 * уходит в Ворд и к заказчику, где считать некому.
 *
 * Но откуда значение взято, документ помнит: вставка сообщает наверх не только
 * текст, но и функцию с доводами. Из этого получается метка, и вкладка «В
 * документе» показывает их списком с кнопкой обновления. Раньше здесь
 * вставлялся мёртвый текст, и человек справедливо говорил, что умные блоки не
 * работают: в таблице связь жила, в записке умирала в момент вставки.
 */
import React, { useState } from 'react';
import { Database, X, RefreshCw } from 'lucide-react';
import type { DocLabel } from '../lib/docLabels';

type Source = { fn: string; args: string[] };

export default function DataFieldsPanel({ projectId, projectName, userName, labels, onInsert, onRefresh, onClose }: {
  projectId: string; projectName: string; userName: string;
  labels: DocLabel[];
  onInsert: (text: string, source?: Source) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'project' | 'tag' | 'now' | 'doc'>('project');
  const [tagId, setTagId] = useState('');
  const [tagField, setTagField] = useState('brand');
  const [paramGroup, setParamGroup] = useState('');
  const [paramKey, setParamKey] = useState('');
  const [busy, setBusy] = useState(false);

  const callFn = async (fn: string, args: string[]): Promise<string> => {
    try {
      const r = await fetch('/api/constructor/fn', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, calls: [{ fn, args }] }),
      });
      if (!r.ok) return '';
      const v = (await r.json()).results?.[0];
      return v == null || v === '#ОШИБКА' ? '' : String(v);
    } catch (_) { return ''; }
  };

  // Значение есть — вставляем меткой; значения нет — вставляем заметный
  // пропуск, но меткой его не делаем: обновлять нечего, а список меток врал бы
  const insert = async (fn: string, args: string[], gap: string) => {
    setBusy(true);
    const v = await callFn(fn, args);
    setBusy(false);
    if (v) onInsert(v, { fn, args });
    else onInsert(gap);
  };

  const insertProject = (field: string) => insert('project', [field], `{Проект.${field}}`);
  const insertTagField = () => tagId.trim()
    && insert('tag', [tagId.trim(), tagField], `{Тег ${tagId}: ${tagField}}`);
  const insertParam = () => tagId.trim() && paramKey.trim()
    && insert('param', [tagId.trim(), paramGroup.trim(), paramKey.trim()], `{Параметр ${tagId}: ${paramKey}}`);

  return (
    <div className="shrink-0 w-72 @[900px]:w-80 h-full flex flex-col overflow-hidden bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-slate-800">
        <span className="text-sm font-bold text-slate-800 dark:text-white flex items-center gap-1.5"><Database className="w-4 h-4 text-sky-600" /> Метки данных</span>
        <button type="button" title="Закрыть панель меток" onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"><X className="w-4 h-4" /></button>
      </div>
      <div className="flex border-b border-slate-100 dark:border-slate-850">
        {([['project', 'Проект'], ['tag', 'Тег'], ['now', 'Дата'], ['doc', `В документе${labels.length ? ` (${labels.length})` : ''}`]] as const).map(([id, label]) => (
          <button type="button" key={id} onClick={() => setTab(id)}
            className={`flex-1 px-2 py-2 text-xs font-bold cursor-pointer ${tab === id ? 'bg-sky-50 dark:bg-sky-950/30 text-sky-700 dark:text-sky-400 border-b-2 border-sky-500' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-850'}`}>
            {label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 p-4 space-y-2.5 overflow-auto">
        {tab === 'project' && (
          <>
            <p className="text-xs text-slate-400">Проект: <b>{projectName || '—'}</b></p>
            {[['name', 'Название'], ['code', 'Код проекта'], ['customer', 'Заказчик'], ['contractor', 'Подрядчик'], ['description', 'Описание']].map(([f, label]) => (
              <button type="button" key={f} disabled={busy} onClick={() => insertProject(f)}
                className="w-full text-left px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-sky-50 dark:hover:bg-sky-950/20 text-sm text-slate-700 dark:text-slate-300 cursor-pointer disabled:opacity-50">
                {label}
              </button>
            ))}
          </>
        )}
        {tab === 'tag' && (
          <>
            <label className="block text-xs font-bold text-slate-500 uppercase">Обозначение тега</label>
            <input value={tagId} onChange={e => setTagId(e.target.value)} placeholder="напр. AHU-01"
              className="w-full px-2.5 py-1.5 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-800 dark:text-white focus:outline-none focus:border-sky-500" />
            <label className="block text-xs font-bold text-slate-500 uppercase mt-2">Поле тега</label>
            <div className="flex gap-2">
              <select value={tagField} onChange={e => setTagField(e.target.value)}
                className="flex-1 min-w-0 px-2 py-1.5 text-sm border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-950 text-slate-800 dark:text-white">
                <option value="brand">Марка</option>
                <option value="department">Отдел</option>
                <option value="fluid">Среда</option>
                <option value="wbs">WBS</option>
              </select>
              <button type="button" disabled={busy || !tagId.trim()} onClick={insertTagField}
                className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-700 disabled:opacity-40 text-white text-xs font-bold cursor-pointer">Вставить</button>
            </div>
            <div className="pt-2 mt-1 border-t border-slate-100 dark:border-slate-850">
              <label className="block text-xs font-bold text-slate-500 uppercase">Параметр оборудования по тегу</label>
              <input value={paramGroup} onChange={e => setParamGroup(e.target.value)} placeholder="группа (напр. Габариты)"
                className="w-full mt-1 px-2.5 py-1.5 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-800 dark:text-white focus:outline-none focus:border-sky-500" />
              <div className="flex gap-2 mt-1.5">
                <input value={paramKey} onChange={e => setParamKey(e.target.value)} placeholder="параметр (напр. Высота)"
                  className="flex-1 min-w-0 px-2.5 py-1.5 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-800 dark:text-white focus:outline-none focus:border-sky-500" />
                <button type="button" disabled={busy || !tagId.trim() || !paramKey.trim()} onClick={insertParam}
                  className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-700 disabled:opacity-40 text-white text-xs font-bold cursor-pointer">Вставить</button>
              </div>
            </div>
          </>
        )}
        {tab === 'now' && (
          <>
            {/* Дата и автор вставляются обычным текстом: дата выпуска не должна
                переезжать сама, когда документ откроют через полгода */}
            <p className="text-xs text-slate-400">Вставляется как обычный текст и потом не меняется.</p>
            <button type="button" onClick={() => onInsert(new Date().toLocaleDateString('ru-RU'))}
              className="w-full text-left px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-sky-50 dark:hover:bg-sky-950/20 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
              Сегодняшняя дата ({new Date().toLocaleDateString('ru-RU')})
            </button>
            <button type="button" onClick={() => onInsert(new Date().toLocaleString('ru-RU'))}
              className="w-full text-left px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-sky-50 dark:hover:bg-sky-950/20 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
              Дата и время
            </button>
            <button type="button" onClick={() => onInsert(userName)}
              className="w-full text-left px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-sky-50 dark:hover:bg-sky-950/20 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
              Автор ({userName})
            </button>
          </>
        )}
        {tab === 'doc' && (
          <>
            {!labels.length && (
              <p className="text-xs text-slate-400">
                В документе пока нет меток. Вставьте значение из вкладок «Проект» или «Тег» — документ запомнит,
                откуда оно взято, и потом обновит его одной кнопкой.
              </p>
            )}
            {labels.map((l) => (
              <div key={l.id} className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800">
                <div className="text-xs font-bold text-slate-500 truncate" title={l.title}>{l.title}</div>
                <div className="text-sm text-slate-800 dark:text-white truncate" title={l.value}>{l.value}</div>
              </div>
            ))}
            {labels.length > 0 && (
              <button type="button" onClick={onRefresh}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-xs font-bold cursor-pointer">
                <RefreshCw className="w-3.5 h-3.5" /> Обновить данные
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
