import {
  Plus,
  Edit2,
  Trash2,
  Check,
  X,
  ArrowUp,
  ArrowDown,
  Sliders,
  Settings,
  Layers
} from "lucide-react";
import type { TagDictController } from './useTagDict';

interface TagDictPanelProps {
  dictionaries: any[];
  activeCategoryTab: string | null;
  setActiveCategoryTab: (id: string | null) => void;
  ctl: TagDictController;
}

export default function TagDictPanel({ dictionaries, activeCategoryTab, setActiveCategoryTab, ctl }: TagDictPanelProps) {
  const {
    newCategoryName,
    setNewCategoryName,
    editingCategoryId,
    setEditingCategoryId,
    editingCategoryName,
    setEditingCategoryName,
    newOptionName,
    setNewOptionName,
    editingOptionId,
    setEditingOptionId,
    editingOptionName,
    setEditingOptionName,
    handleMoveCategory,
    handleAddCategory,
    handleRenameCategory,
    handleDeleteCategory,
    handleAddOption,
    handleSaveOptionName,
    handleDeleteOption,
  } = ctl;
  const configDict = dictionaries.find(d => d.name === '__tag_creation_config__');
  const items = configDict?.items || [];
  const categories = items
    .filter((i: any) => !i.parentId)
    .sort((a: any, b: any) => a.code.localeCompare(b.code));

  return (
    <div className="flex flex-col h-full w-full">
      <div className="p-2.5 @[700px]:p-5 border-b border-slate-200 dark:border-slate-850 bg-slate-50 dark:bg-slate-950 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
           <Settings className="w-5 h-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
           <h2 className="min-w-0 text-[15px] font-semibold text-slate-900 dark:text-white text-pretty">
             Создание тегов / Дополнительные параметры
           </h2>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-350 mt-1">
          Категории и списки значений, которые предлагаются при создании тега. Порядок меняется стрелками справа от строки.
        </p>
      </div>

      <div className="p-2.5 @[700px]:p-5 grid grid-cols-1 @[900px]:grid-cols-2 gap-4 @[700px]:gap-6 items-start flex-1 overflow-y-auto min-w-0">
        {/* Categories Column */}
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
            <h3 className="min-w-0 text-xs font-semibold text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
              <Layers className="w-4 h-4 text-emerald-550" />
              Категории параметров
            </h3>
            <span className="text-xs text-slate-400 tabular-nums shrink-0">всего {categories.length}
            </span>
          </div>

          <div className="fx-set-group space-y-3">
            {/* New Category Form */}
            <form onSubmit={handleAddCategory} className="flex flex-wrap gap-2 min-w-0">
              <input
                type="text"
                placeholder="Новая категория (напр., Класс надежности)..."
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
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
                categories.map((cat: any, index: number, arr: any[]) => {
                  const isActive = activeCategoryTab === cat.id;
                  const isRenaming = editingCategoryId === cat.id;

                  return (
                    <div
                      key={cat.id}
                      onClick={() => {
                        if (!isRenaming) {
                          setActiveCategoryTab(cat.id);
                        }
                      }}
                      className={`p-3 rounded-lg border flex items-center justify-between transition-ui cursor-pointer group ${
                        isActive
                          ? "bg-white dark:bg-slate-900 border-emerald-555 shadow-xs text-slate-850 dark:text-white"
                          : "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-850 text-slate-600 dark:text-slate-350 hover:border-slate-300 hover:bg-slate-50/50"
                      }`}
                    >
                      {isRenaming ? (
                        <div className="flex items-center gap-1 flex-1 mr-2" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="text"
                            value={editingCategoryName}
                            onChange={(e) => setEditingCategoryName(e.target.value)}
                            className="flex-1 min-w-0 px-2.5 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded text-xs text-slate-900 dark:text-slate-100 focus:outline-none"
                            autoFocus
                          />
                          <button type="button"
                            onClick={() => handleRenameCategory(cat.id)}
                            className="p-1 text-emerald-600 hover:bg-emerald-100/30 rounded"
                          >
                            <Check className="w-3.5 h-3.5" />
                          </button>
                          <button type="button"
                            onClick={() => setEditingCategoryId(null)}
                            className="p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 overflow-hidden flex-1 select-none">
                          <span className="text-xs text-slate-400 tabular-nums">{index + 1}</span>
                          <span className="text-xs font-medium font-sans truncate">{cat.nameRu}</span>
                        </div>
                      )}

                      {!isRenaming && (
                        <div className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                          <button type="button"
                            onClick={() => handleMoveCategory(index, 'up')}
                            disabled={index === 0}
                            className="p-1 text-slate-400 hover:text-slate-800 dark:hover:text-white disabled:opacity-20 rounded cursor-pointer"
                            title="Вверх"
                          >
                            <ArrowUp className="w-3.5 h-3.5" />
                          </button>
                          <button type="button"
                            onClick={() => handleMoveCategory(index, 'down')}
                            disabled={index === arr.length - 1}
                            className="p-1 text-slate-400 hover:text-slate-800 dark:hover:text-white disabled:opacity-20 rounded cursor-pointer"
                            title="Вниз"
                          >
                            <ArrowDown className="w-3.5 h-3.5" />
                          </button>
                          <button type="button"
                            onClick={() => {
                              setEditingCategoryId(cat.id);
                              setEditingCategoryName(cat.nameRu);
                            }}
                            className="p-1 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/20 rounded cursor-pointer"
                            title="Переименовать"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button type="button"
                            onClick={() => handleDeleteCategory(cat.id)}
                            className="p-1 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/20 rounded cursor-pointer"
                            title="Удалить"
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
                  Список категорий пуст. Создайте первую выше!
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Options Column */}
        <div className="space-y-4">
          {activeCategoryTab ? (
            (() => {
              const activeCategory = categories.find((c: any) => c.id === activeCategoryTab);
              const options = items
                .filter((i: any) => i.parentId === activeCategoryTab)
                .sort((a: any, b: any) => a.nameRu.localeCompare(b.nameRu));

              return (
                <>
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold text-slate-550 dark:text-slate-400 flex items-center gap-1.5 min-w-0 max-w-[240px]">
                      <Sliders className="w-4 h-4 text-emerald-500 shrink-0" />
                      Варианты: <span className="text-emerald-600 dark:text-emerald-400 font-medium flex-1 min-w-0 truncate">«{activeCategory?.nameRu}»</span>
                    </h3>
                    <span className="text-xs text-slate-400 tabular-nums shrink-0">всего {options.length}
                    </span>
                  </div>

                  <div className="fx-set-group space-y-3">
                    {/* New Option Form */}
                    <form onSubmit={handleAddOption} className="flex flex-wrap gap-2 min-w-0">
                      <input
                        type="text"
                        placeholder="Вариант (напр., КИП, Тепло)..."
                        value={newOptionName}
                        onChange={(e) => setNewOptionName(e.target.value)}
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
                          const isEditingOpt = editingOptionId === opt.id;

                          return (
                            <div
                              key={opt.id}
                              className="fx-set-row justify-between"
                            >
                              {isEditingOpt ? (
                                <div className="flex items-center gap-1 flex-1 mr-2" onClick={(e) => e.stopPropagation()}>
                                  <input
                                    type="text"
                                    value={editingOptionName}
                                    onChange={(e) => setEditingOptionName(e.target.value)}
                                    className="flex-1 min-w-0 px-2.5 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                                    autoFocus
                                  />
                                  <button type="button"
                                    onClick={() => handleSaveOptionName(opt.id)}
                                    className="p-1 text-emerald-600 hover:bg-emerald-100/30 rounded"
                                  >
                                    <Check className="w-3.5 h-3.5" />
                                  </button>
                                  <button type="button"
                                    onClick={() => setEditingOptionId(null)}
                                    className="p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded"
                                  >
                                    <X className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              ) : (
                                <span className="text-xs font-semibold text-slate-705 dark:text-slate-300">{opt.nameRu}</span>
                              )}

                              {!isEditingOpt && (
                                <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                                  <button type="button"
                                    onClick={() => {
                                      setEditingOptionId(opt.id);
                                      setEditingOptionName(opt.nameRu);
                                    }}
                                    className="p-1 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/20 rounded cursor-pointer"
                                  >
                                    <Edit2 className="w-3.5 h-3.5" />
                                  </button>
                                  <button type="button"
                                    onClick={() => handleDeleteOption(opt.id)}
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
