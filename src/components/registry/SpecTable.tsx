/**
 * Вкладка «Спецификация» раздела «Теги»: таблица тегов с сортировкой,
 * раскрываемыми комментариями и двумя необязательными колонками.
 *
 * Вынесена из Registry.tsx как есть: таблица получает данные и обработчики
 * пропсами. Состояния здесь намеренно нет. Виртуализатор и список
 * `sortedTags` нужны и самому Registry («Найти дубли» листает таблицу к
 * нужной строке), а «Отдел/Среда» и раскрытые комментарии должны переживать
 * смену вкладки: вкладка монтируется заново и своё состояние теряла бы.
 */
import React from 'react';
import type { Virtualizer } from '@tanstack/react-virtual';
import { format } from 'date-fns';
import { Sliders, Eye, Edit2, Trash2 } from 'lucide-react';
import { Status, IconBtn } from '../ui';
import { parseTagMetadata, getTagOverallStatus, statusConfig } from './tagMeta';

export interface SpecTableProps {
  /** Сколько тегов в проекте вообще: пояснение пустой таблицы нужно только при нуле */
  tagCount: number;
  /** Теги после поиска и сортировки — ровно то, что показывает таблица */
  sortedTags: any[];
  tableVirtualizer: Virtualizer<HTMLDivElement, Element>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  sortConfig: { key: string; direction: 'asc' | 'desc' };
  onSort: (key: string) => void;
  showOptionalColumns: boolean;
  setShowOptionalColumns: (show: boolean) => void;
  showDescriptions: { [tagId: string]: boolean };
  setShowDescriptions: React.Dispatch<React.SetStateAction<{ [tagId: string]: boolean }>>;
  selectedTagIds: Set<string>;
  setSelectedTagIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setCardMenu: (menu: { x: number; y: number; tagId: string }) => void;
  onEditTag: (tag: any) => void;
  onDeleteTag: (tagId: string) => void;
}

export default function SpecTable({
  tagCount, sortedTags, tableVirtualizer, scrollRef, sortConfig, onSort,
  showOptionalColumns, setShowOptionalColumns, showDescriptions, setShowDescriptions,
  selectedTagIds, setSelectedTagIds, setCardMenu, onEditTag, onDeleteTag,
}: SpecTableProps) {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Счётчик записей — в шапке раздела; здесь только вид таблицы */}
      <div className="fx-tools shrink-0 justify-end">
        <button
          type="button"
          aria-pressed={showOptionalColumns}
          onClick={() => setShowOptionalColumns(!showOptionalColumns)}
          className="fx-btn"
        >
          <Sliders className="w-3.5 h-3.5" />
          Колонки «Отдел» и «Среда»
        </button>
      </div>

      <div 
        ref={scrollRef}
        className="overflow-auto flex-1 min-h-0 style-scrollbar"
      >
        <table className="fx-table text-left">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="cursor-pointer" onClick={() => onSort('identifier')}>
                Тег / Главное наименование {sortConfig.key === 'identifier' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
              </th>
              <th className="cursor-pointer" onClick={() => onSort('brand')}>
                Марка {sortConfig.key === 'brand' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
              </th>
              {showOptionalColumns && (
                <>
                  <th className="cursor-pointer" onClick={() => onSort('department')}>
                    Зона / Отдел {sortConfig.key === 'department' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                  </th>
                  <th className="cursor-pointer" onClick={() => onSort('fluid')}>
                    Тех. Среда {sortConfig.key === 'fluid' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                  </th>
                </>
              )}
              <th>Актуальность</th>
              <th>Комментарии</th>
              <th className="cursor-pointer" onClick={() => onSort('createdAt')}>
                Регистрация {sortConfig.key === 'createdAt' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
              </th>
              <th className="w-20"><span className="sr-only">Действия</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-850">
            {tableVirtualizer.getVirtualItems().length > 0 && (
              <tr style={{ height: `${tableVirtualizer.getVirtualItems()[0].start}px`, border: 'none' }}>
                <td colSpan={showOptionalColumns ? 8 : 6} style={{ padding: 0, border: 'none', height: 0 }} />
              </tr>
            )}
            {tableVirtualizer.getVirtualItems().map((virtualRow) => {
              const t = sortedTags[virtualRow.index];
              if (!t) return null;
              const meta = parseTagMetadata(t);
              return (
                <tr
                  key={t.id}
                  id={`spec-row-${t.id}`}
                  ref={tableVirtualizer.measureElement}
                  data-index={virtualRow.index}
                  onClick={(e) => {
                    // Ctrl+клик — мультивыбор строк для «Поделиться»
                    if (e.ctrlKey || e.metaKey) {
                      e.preventDefault();
                      setSelectedTagIds(prev => {
                        const next = new Set(prev);
                        if (next.has(t.id)) next.delete(t.id);
                        else next.add(t.id);
                        return next;
                      });
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!selectedTagIds.has(t.id)) setSelectedTagIds(new Set([t.id]));
                    setCardMenu({ x: e.clientX, y: e.clientY, tagId: t.id });
                  }}
                  aria-selected={selectedTagIds.has(t.id)}
                >
                  <td>
                    <div className="font-mono text-slate-900 dark:text-white select-all leading-5">
                      {t.identifier}
                    </div>
                    {/* Вторая строка: наименование, а при скрытых колонках — отдел и среда */}
                    <div className="text-xs text-slate-500 dark:text-slate-400 leading-4 truncate max-w-[36rem]">
                      {meta.mainName || 'Без наименования'}
                      {!showOptionalColumns && ` · ${t.department || 'Комплексный'} · среда ${t.fluid || '—'}`}
                    </div>
                  </td>
                  <td className="max-w-[160px] truncate" title={t.brand || undefined}>
                    {t.brand || <span className="text-slate-400 dark:text-slate-500">—</span>}
                  </td>
                  {showOptionalColumns && (
                    <>
                      <td className="text-slate-600 dark:text-slate-300">
                        {t.department || '-'}
                      </td>
                      <td className="text-slate-600 dark:text-slate-300">
                        {t.fluid || '-'}
                      </td>
                    </>
                  )}
                  {/* Актуальность тега — отдельной колонкой: за ней и
                      приходят в спецификацию, а раньше её приходилось
                      выискивать среди комментариев */}
                  <td>
                    {(() => {
                      const look = statusConfig[getTagOverallStatus(t)] || statusConfig.draft;
                      return <Status tone={look.tone}>{look.label}</Status>;
                    })()}
                  </td>
                  <td>
                    {meta.descriptions.length > 0 ? (
                      <div className="space-y-1">
                        <button
                          type="button"
                          onClick={() => {
                            setShowDescriptions(p => ({ ...p, [t.id]: !p[t.id] }));
                            setTimeout(() => tableVirtualizer.measure(), 20);
                          }}
                          aria-expanded={!!showDescriptions[t.id]}
                          className="fx-btn fx-btn-quiet"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>{showDescriptions[t.id] ? 'Скрыть' : 'Показать'} · {meta.descriptions.length}</span>
                        </button>
                        
                        {showDescriptions[t.id] && (
                          <div className="space-y-1.5 max-w-[420px] pt-1.5 animate-fadeIn">
                            {meta.descriptions.map((d) => {
                              const config = statusConfig[d.status] || statusConfig.draft;
                              const Icon = config.icon;
                              return (
                                <div key={d.id} className="flex items-start gap-1.5 text-xs text-slate-700 dark:text-slate-300 text-left">
                                  <Icon className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${config.text}`} />
                                  <div className="text-left">
                                    <span className="font-medium text-slate-900 dark:text-slate-100">{d.text}: </span>
                                    <span className="text-slate-500 dark:text-slate-400">{d.comment}</span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-slate-400 dark:text-slate-500">—</span>
                    )}
                  </td>
                  <td className="text-slate-500 dark:text-slate-400 whitespace-nowrap">
                    {t.createdAt ? format(new Date(t.createdAt), 'dd.MM.yyyy HH:mm') : '-'}
                  </td>
                  <td>
                    <div className="fx-row-acts">
                      <IconBtn label="Изменить тег" onClick={() => onEditTag(t)}>
                        <Edit2 className="w-4 h-4" />
                      </IconBtn>
                      <IconBtn label="Удалить тег" onClick={() => onDeleteTag(t.id)}>
                        <Trash2 className="w-4 h-4" />
                      </IconBtn>
                    </div>
                  </td>
                </tr>
              );
            })}
            {tableVirtualizer.getVirtualItems().length > 0 && (
              <tr style={{ height: `${tableVirtualizer.getTotalSize() - tableVirtualizer.getVirtualItems()[tableVirtualizer.getVirtualItems().length - 1].end}px`, border: 'none' }}>
                <td colSpan={showOptionalColumns ? 8 : 6} style={{ padding: 0, border: 'none', height: 0 }} />
              </tr>
            )}

            {tagCount === 0 && (
              <tr>
                <td colSpan={showOptionalColumns ? 8 : 6} className="py-6 text-slate-500 dark:text-slate-400">
                  В проекте пока нет тегов. Заполните строку выше или нажмите «Новый тег».
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
