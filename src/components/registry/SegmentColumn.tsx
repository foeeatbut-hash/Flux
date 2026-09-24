/**
 * Колонка «Подбора» в Тегах: отбор по сегментам кода тега или марки.
 *
 * Колонок две, и раньше это были две копии по 280 строк, различавшиеся
 * только именами состояний и цветом выбранного значения (зелёный у тега,
 * оранжевый у марки). Цвет категории смысла не несёт — выбранное значение
 * теперь одного цвета, а копия стала параметром.
 */
import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import CustomSelect from '../CustomSelect';

type ByPos<T> = { [position: number]: T };
type Setter<T> = React.Dispatch<React.SetStateAction<ByPos<T>>>;

export default function SegmentColumn({
  kind, title, hint, segmentLabel, className = '',
  baseCount, added, setAdded, uniqueValues, dictionaries,
  filters, setFilters, bindings, setBindings, hierarchy, setHierarchy, categoryIds, setCategoryIds,
}: {
  kind: 'tag' | 'mark';
  title: string;
  hint: string;
  segmentLabel: string;
  className?: string;
  /** Сколько сегментов у самых длинных кодов в базе */
  baseCount: number;
  /** Сколько сегментов добавлено вручную сверх этого */
  added: number;
  setAdded: React.Dispatch<React.SetStateAction<number>>;
  uniqueValues: (idx: number) => string[];
  dictionaries: any[];
  filters: ByPos<string>; setFilters: Setter<string>;
  bindings: ByPos<string>; setBindings: Setter<string>;
  hierarchy: ByPos<any>; setHierarchy: Setter<any>;
  categoryIds: ByPos<string>; setCategoryIds: Setter<string>;
}) {
  return (
    <div className={`space-y-3 ${className}`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-semibold text-slate-900 dark:text-white">
            
            {title}
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">{hint}</p>
        </div>
        <button type="button"
          onClick={() => setAdded(prev => prev + 1)}
          className="fx-btn"
        >
          <Plus className="w-3 h-3" /> Добавить сегмент
        </button>
      </div>

      <div className="grid grid-cols-1 @[720px]:grid-cols-2 gap-4">
        {Array.from({ length: baseCount + added }).map((_, idx) => {
          const uniqueList = uniqueValues(idx);
          const currentVal = filters[idx] || '';

          const boundDictId = bindings[idx] || '';
          const boundDict = dictionaries.find(d => d.id === boundDictId);

          const selection = hierarchy[idx] || {};

          const mainCategories = boundDict ? boundDict.items.filter((i: any) => !i.parentId) : [];
          const subCategories = boundDict && selection.mainId 
            ? boundDict.items.filter((i: any) => i.parentId === selection.mainId) 
            : [];
          const subSubCategories = boundDict && selection.subId 
            ? boundDict.items.filter((i: any) => i.parentId === selection.subId) 
            : [];

          const handleMainChange = (mainId: string) => {
            const mainItem = boundDict?.items.find((i: any) => i.id === mainId);
            setHierarchy(prev => ({
              ...prev,
              [idx]: { mainId, subId: '', subSubId: '' }
            }));
            setFilters(prev => ({
              ...prev,
              [idx]: mainItem ? mainItem.code : '*'
            }));
          };

          const handleSubChange = (subId: string) => {
            const subItem = boundDict?.items.find((i: any) => i.id === subId);
            setHierarchy(prev => ({
              ...prev,
              [idx]: { ...prev[idx], subId, subSubId: '' }
            }));
            setFilters(prev => ({
              ...prev,
              [idx]: subItem 
                ? subItem.code 
                : (boundDict?.items.find((i: any) => i.id === selection.mainId)?.code || '*')
            }));
          };

          const handleSubSubChange = (subSubId: string) => {
            const subSubItem = boundDict?.items.find((i: any) => i.id === subSubId);
            setHierarchy(prev => ({
              ...prev,
              [idx]: { ...prev[idx], subSubId }
            }));
            setFilters(prev => ({
              ...prev,
              [idx]: subSubItem 
                ? subSubItem.code 
                : (boundDict?.items.find((i: any) => i.id === selection.subId)?.code || '*')
            }));
          };

          return (
            <div key={`${kind}-seg-${idx}`} className="p-3 border border-slate-200 dark:border-slate-800 rounded-lg space-y-2 relative group transition-ui text-xs flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-slate-700 dark:text-slate-100">
                    {segmentLabel} {idx + 1}
                  </span>
                  {idx >= baseCount && (
                    <button type="button"
                      onClick={() => {
                        setAdded(prev => Math.max(0, prev - 1));
                        setFilters(prev => {
                          const clone = { ...prev };
                          delete clone[idx];
                          return clone;
                        });
                      }}
                      className="fx-ibtn" aria-label="Удалить сегмент"
                      title="Удалить сегмент"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {/* Unified Custom Input */}
                <div className="space-y-1">
                  <span className="fx-label block">
                    Поиск сегмента:
                  </span>
                  <input
                    type="text"
                    placeholder="Значение..."
                    value={currentVal === '*' ? '' : currentVal}
                    onChange={(e) =>
                      setFilters(prev => ({ ...prev, [idx]: e.target.value || '*' }))
                    }
                    className="fx-input w-full"
                  />
                </div>

                {/* Quick Select from Custom Preset Filter Categories */}
                {(() => {
                  const presetDict = dictionaries.find(d => d.name === '__tag_presets_config__');
                  const presetItems = presetDict?.items || [];
                  const filterCategories = presetItems.filter((i: any) => !i.parentId);
                  const activeCatId = categoryIds[idx] || '';
                  const categoryOptions = presetItems.filter((i: any) => i.parentId === activeCatId);

                  if (filterCategories.length === 0) return null;

                  return (
                    <div className="space-y-1 border-t border-slate-200/40 dark:border-slate-800/40 mt-2 pt-2">
                      <span className="fx-label block">
                        Категория фильтра:
                      </span>
                      <CustomSelect
                        value={activeCatId}
                        onChange={(val) => setCategoryIds(prev => ({ ...prev, [idx]: val }))}
                        placeholder="-- Категории справочника --"
                        options={filterCategories.map((cat: any) => ({
                          value: cat.id,
                          label: cat.nameRu
                        }))}
                      />

                      {activeCatId && (
                        <div className="pt-1 space-y-1">
                          <span className="fx-label block">
                            Каталог:
                          </span>
                          <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto style-scrollbar pr-1">
                            {categoryOptions.map((opt: any) => {
                              const optVal = opt.code || opt.nameRu;
                              const isSel = currentVal === optVal;
                              return (
                                <button
                                  key={opt.id}
                                  type="button"
                                  onClick={() => setFilters(prev => ({ ...prev, [idx]: optVal }))}
                                  className={`px-1.5 py-0.5 border rounded text-xs font-mono transition-ui duration-150 cursor-pointer border-none ${
                                    isSel
                                      ? 'bg-emerald-600 border-emerald-600 text-white'
                                      : 'bg-white hover:bg-slate-100 dark:bg-slate-950 dark:hover:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400'
                                  }`}
                                >
                                  {opt.nameRu}
                                </button>
                              );
                            })}
                            {categoryOptions.length === 0 && (
                              <span className="text-xs text-slate-400 dark:text-slate-500">Вариантов нет</span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Base database match list with max-h and scrollbar */}
                {uniqueList.length > 0 && (
                  <div className="space-y-1 text-left border-t border-slate-200/40 dark:border-slate-800/40 mt-2 pt-2">
                    <span className="fx-label block">
                      В базе ({uniqueList.length}):
                    </span>
                    <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto style-scrollbar">
                      {uniqueList.map((val) => {
                        const isSelected = currentVal === val;
                        return (
                          <button
                            key={val}
                            type="button"
                            onClick={() => setFilters(prev => ({ ...prev, [idx]: val }))}
                            className={`px-1.5 py-0.5 rounded text-xs cursor-pointer font-mono font-semibold transition-ui duration-150 border-none ${
                              isSelected
                                ? 'bg-emerald-600 text-white'
                                : 'bg-white hover:bg-slate-150 dark:bg-slate-950 dark:hover:bg-slate-900 text-slate-600 dark:text-slate-400 border border-slate-200/80 dark:border-slate-800'
                            }`}
                          >
                            {val}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Dictionary Integration Binding Section */}
              <div className="space-y-1 border-t border-slate-200/40 dark:border-slate-800/40 mt-2 pt-2">
                <div className="space-y-1">
                  <span className="fx-label block">
                    Справочник значений:
                  </span>
                  <CustomSelect
                    value={boundDictId}
                    onChange={(val) => {
                      setBindings(prev => ({ ...prev, [idx]: val }));
                      setHierarchy(prev => ({ ...prev, [idx]: {} }));
                    }}
                    placeholder="-- Без справочника --"
                    options={dictionaries.map((dict) => ({
                      value: dict.id,
                      label: dict.name
                    }))}
                  />
                </div>

                {boundDict && (
                  <div className="space-y-1 mt-1 text-xs">
                    {/* Main Category */}
                    <div className="space-y-0.5 animate-fadeIn">
                      <span className="fx-label block">1. Главная</span>
                      <CustomSelect
                        value={selection.mainId || ''}
                        onChange={(val) => handleMainChange(val)}
                        placeholder="Не выбрано"
                        options={mainCategories.map((cat: any) => ({
                          value: cat.id,
                          label: `${cat.code} — ${cat.nameRu}`
                        }))}
                      />
                    </div>

                    {/* Subcategory */}
                    {selection.mainId && subCategories.length > 0 && (
                      <div className="space-y-0.5 animate-fadeIn">
                        <span className="fx-label block">2. Подкатегория</span>
                        <CustomSelect
                          value={selection.subId || ''}
                          onChange={(val) => handleSubChange(val)}
                          placeholder="Не выбрано"
                          options={subCategories.map((sub: any) => ({
                            value: sub.id,
                            label: `${sub.code} — ${sub.nameRu}`
                          }))}
                        />
                      </div>
                    )}

                    {/* Sub-subcategory */}
                    {selection.subId && subSubCategories.length > 0 && (
                      <div className="space-y-0.5 animate-fadeIn">
                        <span className="fx-label block">3. Подподкатегория</span>
                        <CustomSelect
                          value={selection.subSubId || ''}
                          onChange={(val) => handleSubSubChange(val)}
                          placeholder="Не выбрано"
                          options={subSubCategories.map((s: any) => ({
                            value: s.id,
                            label: `${s.code} — ${s.nameRu}`
                          }))}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
