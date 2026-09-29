import {
  Plus,
  Edit2,
  Trash2,
  Check,
  X,
  Sliders,
  Settings,
  Layers,
  ChevronDown,
  ChevronUp
} from "lucide-react";
import type { MarkingDictController } from './useMarkingDict';

interface MarkingDictPanelProps {
  dictionaries: any[];
  activeMarkingTab: string | null;
  setActiveMarkingTab: (id: string | null) => void;
  ctl: MarkingDictController;
}

export default function MarkingDictPanel({ dictionaries, activeMarkingTab, setActiveMarkingTab, ctl }: MarkingDictPanelProps) {
  const {
    newMarkingCategoryName,
    setNewMarkingCategoryName,
    editingMarkingCategoryId,
    setEditingMarkingCategoryId,
    editingMarkingCategoryName,
    setEditingMarkingCategoryName,
    newMarkingOptionName,
    setNewMarkingOptionName,
    editingMarkingOptionId,
    setEditingMarkingOptionId,
    editingMarkingOptionName,
    setEditingMarkingOptionName,
    handleMoveMarkingCategory,
    handleAddMarkingCategory,
    handleRenameMarkingCategory,
    handleDeleteMarkingCategory,
    handleAddMarkingOption,
    handleSaveMarkingOptionName,
    handleDeleteMarkingOption,
  } = ctl;
  const configDict = dictionaries.find(d => d.name === '__tag_marking_config__');
  const items = configDict?.items || [];
  const categories = items
    .filter((i: any) => !i.parentId)
    .sort((a: any, b: any) => a.code.localeCompare(b.code));

  return (
    <div className="flex flex-col h-full w-full">
      <div className="p-5 border-b border-slate-200 dark:border-slate-850 bg-slate-50 dark:bg-slate-950 shrink-0">
        <div className="flex items-center gap-2">
          <Settings className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
          <h2 className="text-[15px] font-semibold text-slate-900 dark:text-white">
            Создание тегов / Маркировка
          </h2>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-350 mt-1">
          Разделы для ТЕГА: "Марка" (Брендирование и Тип оборудования). Шаблон марки генерируется выбором значений из справочника.
        </p>
      </div>

      <div className="p-2.5 @[700px]:p-5 grid grid-cols-1 @[900px]:grid-cols-2 gap-4 @[700px]:gap-6 items-start flex-1 overflow-y-auto min-w-0">
        {/* Categories Column */}
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
            <h3 className="min-w-0 text-xs font-semibold text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
              <Layers className="w-4 h-4 text-emerald-550" />
              Категории маркировки
            </h3>
            <span className="text-xs text-slate-400 tabular-nums shrink-0">всего {categories.length}
            </span>
          </div>

          <div className="fx-set-group space-y-3">
            {/* New Category Form */}
            <form onSubmit={handleAddMarkingCategory} className="flex flex-wrap gap-2 min-w-0">
              <input
                type="text"
                placeholder="Новая категория (напр., Тип оборудования)..."
                value={newMarkingCategoryName}
                onChange={(e) => setNewMarkingCategoryName(e.target.value)}
                className="flex-1 min-w-0 px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs text-slate-850 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
              <button
                type="submit"
                className="fx-btn fx-btn-primary shrink-0"
              >
                <Plus className="w-3.5 h-3.5" /> Добавить
              </button>
            </form>

            {/* Categories List */}
            <div className="space-y-2 max-h-[380px] overflow-y-auto pr-1">
              {categories.length > 0 ? (
                categories.map((cat: any, idx: number) => {
                  const isSelected = activeMarkingTab === cat.id;
                  const isEditing = editingMarkingCategoryId === cat.id;

                  return (
                    <div
                      key={cat.id}
                      onClick={() => !isEditing && setActiveMarkingTab(cat.id)}
                      className={`p-3 rounded-lg border flex items-center justify-between transition-ui ${isSelected ? "bg-emerald-500/10 border-emerald-550/40" : "bg-white dark:bg-slate-900 border-slate-200/60 dark:border-slate-850 hover:bg-slate-100/40 dark:hover:bg-slate-800/40"} ${!isEditing ? "cursor-pointer" : ""}`}
                    >
                      {isEditing ? (
                        <div className="flex items-center gap-1 flex-1 mr-2" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="text"
                            value={editingMarkingCategoryName}
                            onChange={(e) => setEditingMarkingCategoryName(e.target.value)}
                            className="flex-1 min-w-0 px-2.5 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                            autoFocus
                          />
                          <button type="button"
                            onClick={() => handleRenameMarkingCategory(cat.id)}
                            className="p-1 text-emerald-600 hover:bg-emerald-100/30 rounded"
                          >
                            <Check className="w-3.5 h-3.5" />
                          </button>
                          <button type="button"
                            onClick={() => setEditingMarkingCategoryId(null)}
                            className="p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex-1 min-w-0 pr-2">
                          <p className="text-xs font-medium text-slate-800 dark:text-slate-300 truncate">
                            {cat.nameRu}
                          </p>
                        </div>
                      )}

                      {!isEditing && (
                        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            disabled={idx === 0}
                            onClick={() => handleMoveMarkingCategory(idx, 'up')}
                            className="p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded cursor-pointer disabled:opacity-40"
                          >
                            <ChevronUp className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={idx === categories.length - 1}
                            onClick={() => handleMoveMarkingCategory(idx, 'down')}
                            className="p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded cursor-pointer disabled:opacity-40"
                          >
                            <ChevronDown className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingMarkingCategoryId(cat.id);
                              setEditingMarkingCategoryName(cat.nameRu);
                            }}
                            className="p-1 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/20 rounded cursor-pointer"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteMarkingCategory(cat.id)}
                            className="p-1 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/20 rounded cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })
              ) : (
                <div className="text-center py-12 text-xs text-slate-400">
                   Список категорий пуст. Создайте первую!
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Options/Values Column */}
        <div className="space-y-4">
          {activeMarkingTab ? (
            (() => {
              const activeCategory = categories.find((c: any) => c.id === activeMarkingTab);
              const options = items
                .filter((i: any) => i.parentId === activeMarkingTab)
                .sort((a: any, b: any) => a.code.localeCompare(b.code));

              return (
                <>
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 flex items-center gap-1.5 min-w-0">
                      <Layers className="w-4 h-4 text-emerald-550 shrink-0" />
                      <span className="truncate">Варианты для: "{activeCategory?.nameRu}"</span>
                    </h3>
                    <span className="text-xs text-slate-400 tabular-nums shrink-0">всего {options.length}
                    </span>
                  </div>

                  <div className="fx-set-group space-y-3">
                    {/* New Option/Value Form */}
                    <form onSubmit={handleAddMarkingOption} className="flex flex-wrap gap-2 min-w-0">
                      <input
                        type="text"
                        placeholder="Новый вариант маркировки..."
                        value={newMarkingOptionName}
                        onChange={(e) => setNewMarkingOptionName(e.target.value)}
                        className="flex-1 min-w-0 px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs text-slate-850 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      />
                      <button
                        type="submit"
                        className="fx-btn fx-btn-primary shrink-0"
                      >
                        <Plus className="w-3.5 h-3.5" /> Добавить
                      </button>
                    </form>

                    {/* Options List */}
                    <div className="space-y-1.5 max-h-[380px] overflow-y-auto pr-1">
                      {options.length > 0 ? (
                        options.map((opt: any) => {
                          const isEditingOpt = editingMarkingOptionId === opt.id;

                          return (
                            <div
                              key={opt.id}
                              className="fx-set-row justify-between"
                            >
                              {isEditingOpt ? (
                                <div className="flex items-center gap-1 flex-1 mr-2" onClick={(e) => e.stopPropagation()}>
                                  <input
                                    type="text"
                                    value={editingMarkingOptionName}
                                    onChange={(e) => setEditingMarkingOptionName(e.target.value)}
                                    className="flex-1 min-w-0 px-2.5 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                                    autoFocus
                                  />
                                  <button type="button"
                                    onClick={() => handleSaveMarkingOptionName(opt.id)}
                                    className="p-1 text-emerald-600 hover:bg-emerald-100/30 rounded"
                                  >
                                    <Check className="w-3.5 h-3.5" />
                                  </button>
                                  <button type="button"
                                    onClick={() => setEditingMarkingOptionId(null)}
                                    className="p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded"
                                  >
                                    <X className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              ) : (
                                <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">{opt.nameRu}</span>
                              )}

                              {!isEditingOpt && (
                                <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                                  <button type="button"
                                    onClick={() => {
                                      setEditingMarkingOptionId(opt.id);
                                      setEditingMarkingOptionName(opt.nameRu);
                                    }}
                                    className="p-1 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/20 rounded cursor-pointer"
                                  >
                                    <Edit2 className="w-3.5 h-3.5" />
                                  </button>
                                  <button type="button"
                                    onClick={() => handleDeleteMarkingOption(opt.id)}
                                    className="p-1 text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/20 rounded cursor-pointer"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })
                      ) : (
                        <div className="text-center py-8 text-xs text-slate-400">
                          Список вариантов пуст. Добавьте первый выше!
                        </div>
                      )}
                    </div>
                  </div>
                </>
              );
            })()
          ) : (
            <div className="fx-empty">
              <Sliders className="w-8 h-8 mb-2 opacity-30 text-emerald-500" />
              <span>Выберите категорию слева, чтобы редактировать список вариантов.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
