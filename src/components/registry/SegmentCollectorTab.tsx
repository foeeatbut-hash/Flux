/**
 * Вкладка «Подбор» раздела «Теги»: отбор по сегментам тега и марки, колонки
 * выгрузки и таблица результата.
 *
 * Только разметка и виртуализатор таблицы результата, которым не пользуется
 * никто, кроме неё. Состояние и логика — в `useSegmentCollector`, который
 * вызывает Registry: вкладка монтируется заново и своё состояние теряла бы.
 */
import React, { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Copy, FileSpreadsheet } from 'lucide-react';
import { countOf } from '../../lib/plural';
import { Status } from '../ui';
import SegmentColumn from './SegmentColumn';
import { parseTagMetadata, getTagOverallStatus, statusConfig } from './tagMeta';
import type { SegmentCollector } from './useSegmentCollector';

export interface SegmentCollectorTabProps {
  /** Состояние и логика сборщика — из хука, который вызывает Registry */
  collector: SegmentCollector;
  dictionaries: any[];
  splitSegments: (str: string) => string[];
}

export default function SegmentCollectorTab({ collector, dictionaries, splitSegments }: SegmentCollectorTabProps) {
  const {
    getMaximumTagSegmentLength,
    getMaximumMarkSegmentLength,
    addedTagSegmentsCount,
    setAddedTagSegmentsCount,
    addedMarkSegmentsCount,
    setAddedMarkSegmentsCount,
    getUniqueTagSegmentValuesForPos,
    getUniqueMarkSegmentValuesForPos,
    activeTagFilters,
    setActiveTagFilters,
    activeMarkFilters,
    setActiveMarkFilters,
    tagDictBindings,
    setTagDictBindings,
    markDictBindings,
    setMarkDictBindings,
    tagHierarchySelections,
    setTagHierarchySelections,
    markHierarchySelections,
    setMarkHierarchySelections,
    selectedTagFilterCategoryIds,
    setSelectedTagFilterCategoryIds,
    selectedMarkFilterCategoryIds,
    setSelectedMarkFilterCategoryIds,
    excludeEmptyWBS,
    setExcludeEmptyWBS,
    onlyWithWarning,
    setOnlyWithWarning,
    exportColumns,
    setExportColumns,
    handleCopySelectedAsTable,
    handleExportSelectedToExcel,
    matchedTagsList,
  } = collector;

  // List Virtualization:
  const parentRefSegments = useRef<HTMLDivElement>(null);
  const segmentsVirtualizer = useVirtualizer({
    count: matchedTagsList.length,
    getScrollElement: () => parentRefSegments.current,
    estimateSize: () => 75,
    overscan: 10,
  });

  return (
    <>

      {/* SELECTION FILTERS BLOCK */}
      <div className="grid grid-cols-1 @[880px]:grid-cols-2 gap-6 text-left">
        
        <SegmentColumn kind="tag" title="Отбор по сегментам тега" hint="По частям кода тега: только латиница и цифры."
          segmentLabel="Сегмент тега" className="@[880px]:border-r border-slate-100 dark:border-slate-850 @[880px]:pr-6"
          baseCount={getMaximumTagSegmentLength()} added={addedTagSegmentsCount} setAdded={setAddedTagSegmentsCount}
          uniqueValues={getUniqueTagSegmentValuesForPos} dictionaries={dictionaries}
          filters={activeTagFilters} setFilters={setActiveTagFilters}
          bindings={tagDictBindings} setBindings={setTagDictBindings}
          hierarchy={tagHierarchySelections} setHierarchy={setTagHierarchySelections}
          categoryIds={selectedTagFilterCategoryIds} setCategoryIds={setSelectedTagFilterCategoryIds} />
        <SegmentColumn kind="mark" title="Отбор по сегментам марки" hint="По частям марки оборудования: любой язык."
          segmentLabel="Сегмент марки"
          baseCount={getMaximumMarkSegmentLength()} added={addedMarkSegmentsCount} setAdded={setAddedMarkSegmentsCount}
          uniqueValues={getUniqueMarkSegmentValuesForPos} dictionaries={dictionaries}
          filters={activeMarkFilters} setFilters={setActiveMarkFilters}
          bindings={markDictBindings} setBindings={setMarkDictBindings}
          hierarchy={markHierarchySelections} setHierarchy={setMarkHierarchySelections}
          categoryIds={selectedMarkFilterCategoryIds} setCategoryIds={setSelectedMarkFilterCategoryIds} />

        {/* SEPARATOR AND SUPPLEMENTARY CONTROLS */}
        <div className="@[880px]:col-span-2 flex flex-wrap gap-6 pt-3 border-t border-slate-100 dark:border-slate-850 text-xs">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={excludeEmptyWBS}
              onChange={(e) => setExcludeEmptyWBS(e.target.checked)}
              className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 w-4 h-4 cursor-pointer"
            />
            <span className="text-slate-600 dark:text-slate-300 font-medium">Исключить пустые WBS элементы</span>
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={onlyWithWarning}
              onChange={(e) => setOnlyWithWarning(e.target.checked)}
              className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 w-4 h-4 cursor-pointer"
            />
            <span className="text-slate-600 dark:text-slate-300 font-medium">Только теги с предупреждениями (Критично/Проверить)</span>
          </label>

          <button
            type="button"
            onClick={() => {
              setActiveTagFilters({});
              setActiveMarkFilters({});
              setTagDictBindings({});
              setMarkDictBindings({});
              setTagHierarchySelections({});
              setMarkHierarchySelections({});
              setSelectedTagFilterCategoryIds({});
              setSelectedMarkFilterCategoryIds({});
              setAddedTagSegmentsCount(0);
              setAddedMarkSegmentsCount(0);
            }}
            className="fx-btn fx-btn-quiet ml-auto"
          >
            Сбросить сегменты
          </button>
        </div>
      </div>

      {/* EXPORT COLUMNS SETTINGS */}
      <div className="border-t border-slate-200 dark:border-slate-850 pt-3 space-y-3">
        <div className="flex flex-col @[880px]:flex-row @[880px]:items-center @[880px]:justify-between gap-4">
          <div>
            <h3 className="text-[13px] font-semibold text-slate-900 dark:text-white">
              Колонки для выгрузки
            </h3>
          </div>

          <div className="flex items-center gap-2">
            <button type="button" onClick={handleCopySelectedAsTable} title="Те же колонки — сразу в буфер обмена, без файла"
              className="fx-btn">
              <Copy className="w-4 h-4" /><span>Скопировать таблицей</span>
            </button>
            <button type="button" onClick={handleExportSelectedToExcel}
              className="fx-btn fx-btn-primary">
              <FileSpreadsheet className="w-4 h-4" /><span>Экспортировать подборку в Excel</span>
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-4 pt-1 text-xs">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={exportColumns.identifier}
              onChange={(e) => setExportColumns(p => ({ ...p, identifier: e.target.checked }))}
              className="rounded border-slate-300 text-emerald-600"
            />
            <span>Код тега (Identifier)</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={exportColumns.parts}
              onChange={(e) => setExportColumns(p => ({ ...p, parts: e.target.checked }))}
              className="rounded border-slate-300 text-emerald-600"
            />
            <span>Сегменты отдельными колонками</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={exportColumns.department}
              onChange={(e) => setExportColumns(p => ({ ...p, department: e.target.checked }))}
              className="rounded border-slate-300 text-emerald-600"
            />
            <span>Технологическая зона / Дисциплина</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={exportColumns.fluid}
              onChange={(e) => setExportColumns(p => ({ ...p, fluid: e.target.checked }))}
              className="rounded border-slate-300 text-emerald-600"
            />
            <span>Рабочая среда (Fluid)</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={exportColumns.chain}
              onChange={(e) => setExportColumns(p => ({ ...p, chain: e.target.checked }))}
              className="rounded border-slate-300 text-emerald-600"
            />
            <span>Связи по иерархической цепочке родителей</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={exportColumns.brand}
              onChange={(e) => setExportColumns(p => ({ ...p, brand: e.target.checked }))}
              className="rounded border-slate-300 text-emerald-600"
            />
            <span>Марка оборудования</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={exportColumns.brandParts}
              onChange={(e) => setExportColumns(p => ({ ...p, brandParts: e.target.checked }))}
              className="rounded border-slate-300 text-emerald-600"
            />
            <span>Сегменты марки отдельно</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={exportColumns.descriptions}
              onChange={(e) => setExportColumns(p => ({ ...p, descriptions: e.target.checked }))}
              className="rounded border-slate-300 text-emerald-600"
            />
            <span>Комментарии / Контрольные точки КИП</span>
          </label>
        </div>
      </div>

      {/* MATCHED RESULTS PREVIEW TABLE */}
      <div className="border-t border-slate-200 dark:border-slate-850">
        <div className="py-2 flex justify-between items-center gap-3 flex-wrap">
          <span className="text-[13px] font-semibold text-slate-900 dark:text-white block">
            Результат подбора · {countOf(matchedTagsList.length, 'запись')}
          </span>
        </div>

        <div 
          ref={parentRefSegments}
          className="overflow-auto max-h-[600px] style-scrollbar"
        >
          <table className="fx-table text-left">
            <thead className="sticky top-0 z-10">
              <tr>
                <th>Сегменты тега</th>
                <th>Сегменты марки</th>
                <th>Наименование тега</th>
                {/* Кнопка «добавить колонку» отсюда убрана: она только
                    сообщала, что возможность не готова. Кнопка, которая
                    ничего не делает, хуже отсутствующей — она обещает */}
                <th>Статус / Актуальность</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-850">
              {segmentsVirtualizer.getVirtualItems().length > 0 && (
                <tr style={{ height: `${segmentsVirtualizer.getVirtualItems()[0].start}px`, border: 'none' }}>
                  <td colSpan={4} style={{ padding: 0, border: 'none', height: 0 }} />
                </tr>
              )}
              {segmentsVirtualizer.getVirtualItems().map((virtualRow) => {
                const t = matchedTagsList[virtualRow.index];
                if (!t) return null;
                const tMeta = parseTagMetadata(t);
                const tagParts = tMeta.tagSegments && tMeta.tagSegments.length > 0
                  ? tMeta.tagSegments
                  : splitSegments(t.identifier || '');
                  
                const markParts = tMeta.markSegments && tMeta.markSegments.length > 0
                  ? tMeta.markSegments
                  : splitSegments(t.brand || '');

                const overallStatus = getTagOverallStatus(t);
                const statusCfg = statusConfig[overallStatus] || statusConfig.draft;

                return (
                  <tr 
                    key={t.id} 
                    ref={segmentsVirtualizer.measureElement}
                    data-index={virtualRow.index}
                    
                  >
                    {/* COLUMN 1: TAG SEGMENTS (KKS) */}
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {tagParts.map((part, idx) => {
                          const isMatched = activeTagFilters[idx] && activeTagFilters[idx] !== '*' && activeTagFilters[idx] === part;
                          return (
                            <span 
                              key={`tag-part-${idx}`} 
                              className={`px-2 py-0.5 rounded text-xs font-mono transition-ui ${
                                isMatched 
                                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200 border border-emerald-300 dark:border-emerald-800 ring-2 ring-emerald-400/25' 
                                  : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200/40'
                              }`}
                            >
                              {part}
                            </span>
                          );
                        })}
                      </div>
                    </td>

                    {/* COLUMN 2: MARK SEGMENTS */}
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {markParts.map((part, idx) => {
                          const isMatched = activeMarkFilters[idx] && activeMarkFilters[idx] !== '*' && activeMarkFilters[idx] === part;
                          return (
                            <span 
                              key={`mark-part-${idx}`} 
                              className={`px-2 py-0.5 rounded text-xs font-mono transition-ui ${
                                isMatched 
                                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200 border border-emerald-300 dark:border-emerald-800 ring-2 ring-emerald-400/25' 
                                  : 'bg-amber-50 dark:bg-slate-900 text-amber-800 dark:text-amber-400 border border-amber-200/40 dark:border-amber-900/45'
                              }`}
                            >
                              {part}
                            </span>
                          );
                        })}
                        {markParts.length === 0 && (
                          <span className="text-slate-400">—</span>
                        )}
                      </div>
                      {t.brand && (
                        <span className="text-xs text-slate-450 dark:text-slate-500 block mt-1 font-medium select-all font-mono">
                          {t.brand}
                        </span>
                      )}
                    </td>

                    {/* COLUMN 3: NAME */}
                    <td>
                      <p className="text-slate-900 dark:text-white select-all">
                        {tMeta.mainName || 'Без наименования'}
                      </p>
                      <span className="text-xs text-slate-400 font-sans block mt-0.5 font-medium leading-relaxed font-mono">
                        {t.identifier}
                      </span>
                    </td>

                    {/* COLUMN 4: STATUS / RELEVANCE */}
                    <td>
                      <div className="flex items-center gap-2">
                        <Status tone={statusCfg.tone}>{statusCfg.label}</Status>
                        {tMeta.descriptions.length > 0 && (
                          <span className="text-xs text-slate-500 dark:text-slate-400">
                            замечаний: {tMeta.descriptions.length}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {segmentsVirtualizer.getVirtualItems().length > 0 && (
                <tr style={{ height: `${segmentsVirtualizer.getTotalSize() - segmentsVirtualizer.getVirtualItems()[segmentsVirtualizer.getVirtualItems().length - 1].end}px`, border: 'none' }}>
                  <td colSpan={4} style={{ padding: 0, border: 'none', height: 0 }} />
                </tr>
              )}

              {matchedTagsList.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-6 text-slate-500 dark:text-slate-400">
                    Под запрашиваемые критерии Tag или Mark сегментов не подходит ни один тег. Пожалуйста, поменяйте конфигурацию фильтров.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
