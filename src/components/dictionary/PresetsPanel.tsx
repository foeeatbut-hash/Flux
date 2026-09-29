import {
  Plus,
  Edit2,
  Trash2,
  Check,
  X,
  Sliders
} from "lucide-react";
import type { PresetsController } from './usePresets';

interface PresetsPanelProps {
  dictionaries: any[];
  activePresetId: string | null;
  setActivePresetId: (id: string | null) => void;
  ctl: PresetsController;
}

export default function PresetsPanel({ dictionaries, activePresetId, setActivePresetId, ctl }: PresetsPanelProps) {
  const {
    newPresetName,
    setNewPresetName,
    newPresetProjectNo,
    setNewPresetProjectNo,
    editingPresetId,
    setEditingPresetId,
    editingPresetName,
    setEditingPresetName,
    editingPresetProjectNo,
    setEditingPresetProjectNo,
    newSubOptionValue,
    setNewSubOptionValue,
    newSubOptionCode,
    setNewSubOptionCode,
    editingSubOptionId,
    setEditingSubOptionId,
    editingSubOptionValue,
    setEditingSubOptionValue,
    editingSubOptionCode,
    setEditingSubOptionCode,
    handleAddPreset,
    handleSavePresetEdit,
    handleDeletePreset,
    handleCreateSubOption,
    handleSaveSubOptionEdit,
    handleDeleteSubOption,
  } = ctl;
  const presetDict = dictionaries.find(d => d.name === '__tag_presets_config__');
  const presetItems = presetDict?.items || [];
  const presets = presetItems.filter((i: any) => !i.parentId);

  return (
    <div className="flex flex-col text-left">
      <div className="pb-3 flex items-center justify-between">
        <div>
          <h2 className="text-[15px] font-semibold text-slate-900 dark:text-white flex items-center gap-2">
            Категории фильтров и варианты для вкладки «Подбор» в Тегах
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Создайте категорию фильтра (например: Системы, Клапаны, Раздел), а затем наполните её вариантами значений. Эти списки появятся в карточках сегментов.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 @[900px]:grid-cols-12 divide-y @[900px]:divide-y-0 @[900px]:divide-x divide-slate-100 dark:divide-slate-800 min-h-[500px]">
        {/* LEFTSIDE: CATEGORIES LIST & ADD */}
        <div className="col-span-1 @[900px]:col-span-5 p-4 flex flex-col bg-slate-50/10 dark:bg-slate-950/10">
          <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-3">
            Категории фильтров
          </h3>

          {/* Add Category Form */}
          <form onSubmit={handleAddPreset} className="space-y-2 mb-4">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block fx-group-title mb-1">Название категории</label>
                <input
                  type="text"
                  value={newPresetName}
                  onChange={(e) => setNewPresetName(e.target.value)}
                  placeholder="например: Системы"
                  className="w-full px-2.5 py-1.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label className="block fx-group-title mb-1">Код/Сокращение</label>
                <input
                  type="text"
                  value={newPresetProjectNo}
                  onChange={(e) => setNewPresetProjectNo(e.target.value)}
                  placeholder="например: SYS"
                  className="w-full px-2.5 py-1.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>
            </div>
            <button
              type="submit"
              className="fx-btn fx-btn-primary w-full shrink-0"
            >
              <Plus className="w-3.5 h-3.5" /> Создать категорию
            </button>
          </form>

          {/* Category Items */}
          <div className="space-y-1.5 max-h-[360px] overflow-y-auto pr-1">
            {presets.length > 0 ? (
              presets.map((preset: any) => {
                const isActive = activePresetId === preset.id;
                const isEditing = editingPresetId === preset.id;

                return (
                  <div
                    key={preset.id}
                    onClick={() => !isEditing && setActivePresetId(preset.id)}
                    className={`p-2.5 rounded-lg border flex items-center justify-between transition-ui cursor-pointer ${isActive ? "bg-emerald-50/40 dark:bg-emerald-950/10 border-emerald-500" : "bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800/50 border-slate-200/60 dark:border-slate-850"}`}
                  >
                    {isEditing ? (
                      <div className="flex items-center gap-1.5 flex-1 mr-2" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="text"
                          value={editingPresetName}
                          onChange={(e) => setEditingPresetName(e.target.value)}
                          className="w-1/2 px-2 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded text-xs text-slate-900 dark:text-slate-100 focus:outline-none"
                          autoFocus
                        />
                        <input
                          type="text"
                          value={editingPresetProjectNo}
                          onChange={(e) => setEditingPresetProjectNo(e.target.value)}
                          className="w-1/2 px-2 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded text-xs text-slate-900 dark:text-slate-100 focus:outline-none"
                        />
                        <button type="button"
                          onClick={() => handleSavePresetEdit(preset.id)}
                          className="p-1 text-emerald-600 hover:bg-emerald-100/30 rounded"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                        <button type="button"
                          onClick={() => setEditingPresetId(null)}
                          className="p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-col">
                        <span className="text-xs font-medium text-slate-800 dark:text-slate-300">{preset.nameRu}</span>
                        <span className="code text-xs text-slate-400">{preset.code}</span>
                      </div>
                    )}

                    {!isEditing && (
                      <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                        <button type="button"
                          onClick={() => {
                            setEditingPresetId(preset.id);
                            setEditingPresetName(preset.nameRu);
                            setEditingPresetProjectNo(preset.code);
                          }}
                          className="p-1 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/20 rounded cursor-pointer"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button type="button"
                          onClick={() => handleDeletePreset(preset.id)}
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
                Категории не созданы. Добавьте первую выше!
              </div>
            )}
          </div>
        </div>

        {/* RIGHTSIDE: CATEGORY DETAILS, SUBOPTIONS LIST & ADD */}
        <div className="col-span-1 @[900px]:col-span-7 p-4 bg-slate-50/50 dark:bg-slate-950/10">
          {activePresetId ? (
            (() => {
              const activeCategory = presets.find((p: any) => p.id === activePresetId);
              const subOptions = presetItems.filter((i: any) => i.parentId === activePresetId);

              return (
                <div className="flex flex-col h-full space-y-4">
                  <div className="border-b border-slate-100 dark:border-slate-800 pb-2">
                    <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-300">
                      Варианты для категории: <span className="text-emerald-600">{activeCategory?.nameRu} ({activeCategory?.code})</span>
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Добавьте значения фильтров, которые будут сопоставлены с этой категорией.
                    </p>
                  </div>

                  {/* Form to add a sub-option value */}
                  <form onSubmit={(e) => handleCreateSubOption(e, presetDict!.id)} className="grid grid-cols-12 gap-2 py-2">
                    <div className="col-span-5">
                      <label className="fx-label block">Значение варианта</label>
                      <input
                        type="text"
                        required
                        value={newSubOptionValue}
                        onChange={(e) => setNewSubOptionValue(e.target.value)}
                        placeholder="например: В работе"
                        className="w-full mt-0.5 px-2 py-1 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      />
                    </div>
                    <div className="col-span-5">
                      <label className="fx-label block">Код (для вставки)</label>
                      <input
                        type="text"
                        value={newSubOptionCode}
                        onChange={(e) => setNewSubOptionCode(e.target.value)}
                        placeholder="В работе"
                        className="w-full mt-0.5 px-2 py-1 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      />
                    </div>
                    <div className="col-span-2 flex items-end">
                      <button
                        type="submit"
                        title="Добавить значение"
                        className="fx-btn fx-btn-primary w-full mt-0.5"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    </div>
                  </form>

                  {/* Sub options values list */}
                  <div className="space-y-1.5 max-h-[320px] overflow-y-auto pr-1">
                    {subOptions.length > 0 ? (
                      subOptions.map((opt: any) => {
                        const isEditingSub = editingSubOptionId === opt.id;
                        return (
                          <div
                            key={opt.id}
                            className="p-2 bg-white dark:bg-slate-900 border border-slate-200/65 dark:border-slate-850 rounded-lg flex items-center justify-between transition-colors"
                          >
                            {isEditingSub ? (
                              <div className="flex items-center gap-1.5 flex-1 mr-2" onClick={(e) => e.stopPropagation()}>
                                <input
                                  type="text"
                                  value={editingSubOptionValue}
                                  onChange={(e) => setEditingSubOptionValue(e.target.value)}
                                  className="w-1/2 px-2 py-0.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded text-xs text-slate-900 dark:text-slate-100 focus:outline-none"
                                  autoFocus
                                />
                                <input
                                  type="text"
                                  value={editingSubOptionCode}
                                  onChange={(e) => setEditingSubOptionCode(e.target.value)}
                                  className="w-1/2 px-2 py-0.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded text-xs text-slate-900 dark:text-slate-100 focus:outline-none"
                                />
                                <button type="button"
                                  onClick={() => handleSaveSubOptionEdit(opt.id)}
                                  className="p-1 text-emerald-600 hover:bg-emerald-100/30 rounded"
                                >
                                  <Check className="w-3.5 h-3.5" />
                                </button>
                                <button type="button"
                                  onClick={() => setEditingSubOptionId(null)}
                                  className="p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center gap-3">
                                <span className="text-xs font-medium text-slate-800 dark:text-slate-300">{opt.nameRu}</span>
                                {opt.code && opt.code !== opt.nameRu && (
                                  <span className="code text-xs text-slate-400">{opt.code}</span>
                                )}
                              </div>
                            )}

                            {!isEditingSub && (
                              <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                                <button type="button"
                                  onClick={() => {
                                    setEditingSubOptionId(opt.id);
                                    setEditingSubOptionValue(opt.nameRu);
                                    setEditingSubOptionCode(opt.code);
                                  }}
                                  className="p-1 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/20 rounded cursor-pointer"
                                >
                                  <Edit2 className="w-3.5 h-3.5" />
                                </button>
                                <button type="button"
                                  onClick={() => handleDeleteSubOption(opt.id)}
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
                      <div className="text-center py-6 text-xs text-slate-405">
                        Нет добавленных вариантов. Добавьте первый выше!
                      </div>
                    )}
                  </div>
                </div>
              );
            })()
          ) : (
            <div className="bg-slate-50 dark:bg-slate-950/30 rounded-xl border border-dashed border-slate-200 dark:border-slate-800 p-8 text-center text-xs text-slate-400 flex flex-col items-center justify-center h-full">
              <Sliders className="w-8 h-8 mb-2 opacity-30 text-emerald-500" />
              <span>Выберите категорию фильтра слева, чтобы наполнить её вариантами значений.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
