/**
 * Строка быстрого создания тега: код, марка, наименование, актуальность и
 * свёрнутые поля «Доп» из справочника настройки.
 *
 * Вынесена из Registry.tsx как есть. Состояние ввода живёт в useQuickCreate, а
 * `showAdvancedCreation` и выбор «Доп» — у Registry (их трогает ещё и меню правой
 * кнопки по холсту и загрузка словарей), поэтому всё приходит пропсами, а сама
 * строка ничего не помнит. Показывать её только на схеме и в спецификации —
 * решает Registry: условие осталось там, где известна вкладка.
 */
import React from 'react';
import { Plus, ChevronDown, Sliders } from 'lucide-react';
import { motion } from 'motion/react';
import CustomSelect from '../CustomSelect';
import { Status } from '../ui';
import { parseTagMetadata, getTagOverallStatus, actualitySelectOptions } from './tagMeta';
import type { Actuality } from './useQuickCreate';

type SetState<T> = React.Dispatch<React.SetStateAction<T>>;

export interface QuickCreateBarProps {
  newTagIdentifier: string;
  setNewTagIdentifier: SetState<string>;
  handleTagIdentifierChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  isIdentifierUnique: boolean;
  /** Существующие теги, похожие на введённый код */
  matchingSuggestions: any[];
  newTagBrand: string;
  setNewTagBrand: SetState<string>;
  newTagMainName: string;
  setNewTagMainName: SetState<string>;
  newTagActuality: Actuality;
  setNewTagActuality: SetState<Actuality>;
  /** Подсказка подставляет в форму и отдел со средой существующего тега */
  setNewTagDepartment: SetState<string>;
  setNewTagFluid: SetState<string>;
  showAdvancedCreation: boolean;
  setShowAdvancedCreation: SetState<boolean>;
  dictionaries: any[];
  dynamicCategorySelections: Record<string, string>;
  handleDynamicCategoryChange: (catId: string, val: string) => void;
  handleCreateTag: (e: React.FormEvent) => void;
}

export default function QuickCreateBar({
  newTagIdentifier, setNewTagIdentifier, handleTagIdentifierChange, isIdentifierUnique,
  matchingSuggestions, newTagBrand, setNewTagBrand, newTagMainName, setNewTagMainName,
  newTagActuality, setNewTagActuality, setNewTagDepartment, setNewTagFluid,
  showAdvancedCreation, setShowAdvancedCreation, dictionaries, dynamicCategorySelections,
  handleDynamicCategoryChange, handleCreateTag,
}: QuickCreateBarProps) {
  return (
    <form onSubmit={handleCreateTag} className="flex flex-col gap-1.5 min-w-0 flex-1 text-left" aria-label="Новый тег">
      <div className="flex flex-wrap items-center gap-2">
        {/* Tag identifier code */}
        <div className="relative w-44">
          <div className="relative animate-fadeIn">
            <input
              type="text"
              required
              data-tour="tag-code-input"
              placeholder="Код тега *"
              aria-label="Код тега (EN)"
              value={newTagIdentifier}
              onChange={handleTagIdentifierChange}
              className={`fx-input code pr-16 ${newTagIdentifier && !isIdentifierUnique ? 'border-rose-400 dark:border-rose-700' : ''}`}
            />
            {newTagIdentifier && (
              <div className="absolute right-2 top-1/2 -translate-y-1/2 z-10 text-xs">
                {isIdentifierUnique ? <Status tone="emerald">Свободен</Status> : <Status tone="rose">Занят</Status>}
              </div>
            )}
          </div>
              
          {/* Auto Suggestions list */}
          {newTagIdentifier && matchingSuggestions.length > 0 && (
            <div className="absolute top-full left-0 w-full mt-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xl z-50 p-2 max-h-64 overflow-y-auto">
              <div className="text-xs font-mono font-medium text-slate-400 dark:text-slate-550 pb-1 mb-1 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center pl-1">
                <span>Существующие теги</span>
                <span className="text-xs font-sans font-normal lowercase text-slate-500">выберите</span>
              </div>
              <div className="space-y-0.5">
                {matchingSuggestions.map((st) => (
                  <button
                    key={st.id}
                    type="button"
                    onClick={() => {
                      setNewTagIdentifier(st.identifier);
                      if (st.department) setNewTagDepartment(st.department);
                      if (st.fluid) setNewTagFluid(st.fluid);
                      const stMeta = parseTagMetadata(st);
                      if (stMeta.mainName) setNewTagMainName(stMeta.mainName);
                      setNewTagActuality(getTagOverallStatus(st));
                    }}
                    className="w-full text-left px-2 py-1 text-xs text-slate-707 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded flex justify-between items-center transition-colors font-mono cursor-pointer"
                  >
                    <span className="font-medium text-emerald-600 dark:text-emerald-400">{st.identifier}</span>
                    <span className="text-xs text-slate-500 dark:text-slate-400 font-sans truncate ml-2 max-w-[240px]" title={parseTagMetadata(st).mainName || 'Без наименования'}>
                      {parseTagMetadata(st).mainName || <span className="opacity-40 text-xs">Без наименования</span>}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Required Mark input field */}
        <div className="w-40">
          <input
            type="text"
            required
            placeholder="Марка *" aria-label="Марка оборудования"
            value={newTagBrand}
            onChange={(e) => setNewTagBrand(e.target.value)}
            className="fx-input"
          />
        </div>

        {/* Main Name string input */}
        <div className="w-56">
          <input
            type="text"
            placeholder="Наименование" aria-label="Главное наименование"
            value={newTagMainName}
            onChange={(e) => setNewTagMainName(e.target.value)}
            className="fx-input"
          />
        </div>

        {/* Actuality Selector */}
        <div className="w-40" title="Актуальность">
          <CustomSelect
            value={newTagActuality}
            onChange={(val) => setNewTagActuality(val as any)}
            options={actualitySelectOptions}
          />
        </div>

        {/* Actions (Buttons) */}
        <div className="flex items-center gap-1.5">
          {/* Advanced Toggle button */}
          <button
            type="button"
            onClick={() => setShowAdvancedCreation(!showAdvancedCreation)}
            aria-pressed={showAdvancedCreation}
            className="fx-btn fx-btn-quiet"
            title="Дополнительные поля спецификации"
          >
            <Sliders className="w-3.5 h-3.5 shrink-0" />
            <span>Доп</span>
            <ChevronDown className={`w-3 h-3 transition-transform duration-200 shrink-0 ${showAdvancedCreation ? 'rotate-180' : ''}`} />
          </button>

          {/* Submit create button */}
          <button
            type="submit"
            data-tour="tag-create-btn"
            disabled={!isIdentifierUnique || !newTagIdentifier || !newTagBrand.trim()}
            className="fx-btn fx-btn-primary"
          >
            <Plus />Создать
          </button>
        </div>
      </div>

      {/* Collapsible advanced details row */}
      {showAdvancedCreation && (
        <motion.div 
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          style={{ overflow: 'visible' }}
          className="flex flex-wrap items-center gap-3 pt-2.5 border-t border-slate-100 dark:border-slate-900/60 overflow-visible text-left"
        >
          {(() => {
            const configDict = dictionaries.find(d => d.name === '__tag_creation_config__');
            const cats = configDict
              ? (configDict.items || [])
                  .filter((i: any) => !i.parentId)
                  .sort((a: any, b: any) => a.code.localeCompare(b.code))
              : [];

            if (cats.length > 0) {
              return cats.map((cat: any) => {
                const options = (configDict?.items || [])
                  .filter((i: any) => i.parentId === cat.id)
                  .sort((a: any, b: any) => a.nameRu.localeCompare(b.nameRu));

                return (
                  <div key={cat.id} className="flex flex-col gap-1 min-w-[160px] @[760px]:min-w-[180px] @[1080px]:min-w-[200px] flex-1 max-w-[300px]" id={`dynamic-field-${cat.id}`}>
                    <span className="text-xs font-medium text-slate-450 dark:text-slate-500 leading-none truncate" title={cat.nameRu}>
                      {cat.nameRu}
                    </span>
                    <CustomSelect
                      value={dynamicCategorySelections[cat.id] || ''}
                      onChange={(val) => handleDynamicCategoryChange(cat.id, val)}
                      placeholder="-- выбрать --"
                      options={options.map((opt: any) => ({
                        value: opt.nameRu,
                        label: opt.nameRu
                      }))}
                    />
                  </div>
                );
              });
            }
            return <span className="text-xs text-slate-400">Дополнительные поля для ККС не настроены в справочниках.</span>;
          })()}
        </motion.div>
      )}
    </form>
  );
}
