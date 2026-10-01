import { SectionHead, Btn } from '../components/ui';
import React, { useState, useEffect, useRef } from "react";
import SymbolsEditor from '../components/SymbolsEditor';
import { useStore } from "../store/store";
import { motion } from "motion/react";
import CustomSelect from "../components/CustomSelect";
import {
  Upload,
  Plus,
  Edit2,
  Trash2,
  Check,
  X,
  Database,
  Sliders,
} from "lucide-react";
import { useToastStore } from "../store/toastStore";
import * as xlsx from "xlsx";
import { countOf } from '../lib/plural';
import { useModalStore } from '../store/modalStore';
import { getOrderedItems } from '../lib/dictOrder';
import { useTagDict } from '../components/dictionary/useTagDict';
import TagDictPanel from '../components/dictionary/TagDictPanel';
import { useMarkingDict } from '../components/dictionary/useMarkingDict';
import MarkingDictPanel from '../components/dictionary/MarkingDictPanel';
import { usePresets } from '../components/dictionary/usePresets';
import PresetsPanel from '../components/dictionary/PresetsPanel';

// Диалоги программы вместо системных окон Windows
const { openConfirm } = useModalStore.getState();

export default function DictionaryEditor() {
  const activeProject = useStore((s) => s.activeProject);
  const { addToast } = useToastStore();

  const [dictionaries, setDictionaries] = useState<any[]>([]);
  const [activeDictId, setActiveDictId] = useState<string | null>(null);

  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    code: "",
    nameRu: "",
    parentId: "",
  });

  const [isAdding, setIsAdding] = useState(false);
  const [addForm, setAddForm] = useState({
    code: "",
    nameRu: "",
    parentId: "",
  });

  // Tag creation dynamic config states
  const [activeCategoryTab, setActiveCategoryTab] = useState<string | null>(null);

  // Tag marking dynamic config states
  const [activeMarkingTab, setActiveMarkingTab] = useState<string | null>(null);

  const [showTagCreationSidebar, setShowTagCreationSidebar] = useState(true);

  // Preset state variables (mapped to Filter Categories & Variants)
  const [activePresetId, setActivePresetId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (activeProject) {
      fetchDictionaries();
    }
  }, [activeProject?.id]); // по идентификатору, а не по объекту: иначе перезапрос при каждой смене ссылки

  const runAutoSeed = async (existingDicts: any[]) => {
    try {
      // 1. Create the root config dictionary
      const res = await fetch(`/api/projects/${activeProject!.id}/dictionaries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "__tag_creation_config__",
          items: [
            { code: "001_dep", nameRu: "Тех. дисциплина / Отдел" },
            { code: "002_fluid", nameRu: "Технологическая среда" }
          ]
        })
      });
      if (!res.ok) throw new Error("Auto seed failed");
      const data = await res.json();
      const newDict = data.dictionary;
      
      // 2. Add defaults
      const depCategory = newDict.items.find((i: any) => i.code === '001_dep');
      const fluidCategory = newDict.items.find((i: any) => i.code === '002_fluid');

      if (depCategory) {
        const defaultDeps = ["Отдел КИПиА", "Отдел АСУ ТП", "Технологический отдел", "Электротехнический отдел"];
        // Одним заходом, а не по одному: на общей базе по сети каждый
        // такой POST — отдельный круг до сервера.
        await Promise.all(defaultDeps.map((dep) => fetch(`/api/projects/${activeProject!.id}/dictionaries/${newDict.id}/items`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: dep, nameRu: dep, parentId: depCategory.id })
        })));
      }

      if (fluidCategory) {
        const defaultFluids = ["Воздух", "Вода", "Пар", "Газ", "Нефть"];
        // Одним заходом, а не по одному: на общей базе по сети каждый
        // такой POST — отдельный круг до сервера.
        await Promise.all(defaultFluids.map((fluid) => fetch(`/api/projects/${activeProject!.id}/dictionaries/${newDict.id}/items`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: fluid, nameRu: fluid, parentId: fluidCategory.id })
        })));
      }
      
      // Update dictionaries from API again
      const updateRes = await fetch(`/api/projects/${activeProject!.id}/dictionaries`);
      const updateData = await updateRes.json();
      setDictionaries(updateData.dictionaries);
      
      const seeded = updateData.dictionaries.find((d: any) => d.name === '__tag_creation_config__');
      if (seeded && seeded.items.length > 0) {
        const firstCat = seeded.items.find((i: any) => !i.parentId);
        if (firstCat) setActiveCategoryTab(firstCat.id);
      }
      return seeded;
    } catch (err) {
      console.error("Error auto seeding:", err);
    }
  };

  const runPresetAutoSeed = async (projectId: string) => {
    try {
      const res = await fetch(`/api/projects/${projectId}/dictionaries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "__tag_presets_config__",
          items: [
            { code: "3700", nameRu: "Проект 3700" }
          ]
        })
      });
      return res.ok;
    } catch (err) {
      console.error("Auto seeding presets failed:", err);
      return false;
    }
  };

  const runMarkingAutoSeed = async (projectId: string) => {
    try {
      const res = await fetch(`/api/projects/${projectId}/dictionaries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "__tag_marking_config__",
          items: [
            { code: "001_m1", nameRu: "Тип оборудования" },
            { code: "002_m2", nameRu: "Блок/Сегмент" }
          ]
        })
      });
      if (!res.ok) throw new Error("Auto seed marking failed");
      const data = await res.json();
      const newDict = data.dictionary;

      const m1Category = newDict.items.find((i: any) => i.code === '001_m1');
      const m2Category = newDict.items.find((i: any) => i.code === '002_m2');

      if (m1Category) {
        const defaultM1 = ["Датчик", "Клапан", "Вентилятор", "Кабель", "Контроллер"];
        for (const m of defaultM1) {
          await fetch(`/api/projects/${projectId}/dictionaries/${newDict.id}/items`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: m, nameRu: m, parentId: m1Category.id })
          });
        }
      }

      if (m2Category) {
        const defaultM2 = ["К1", "К2", "В1", "В2", "Р1"];
        for (const m of defaultM2) {
          await fetch(`/api/projects/${projectId}/dictionaries/${newDict.id}/items`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: m, nameRu: m, parentId: m2Category.id })
          });
        }
      }

      return true;
    } catch (err) {
      console.error("Auto seeding marking failed:", err);
      return false;
    }
  };

  const fetchDictionaries = async () => {
    try {
      const res = await fetch(
        `/api/projects/${activeProject!.id}/dictionaries`,
      );
      const data = await res.json();
      
      // Look for our special dictionary
      let configDict = data.dictionaries.find((d: any) => d.name === '__tag_creation_config__');
      if (!configDict) {
        configDict = await runAutoSeed(data.dictionaries);
      } else {
        // Ensure activeCategoryTab is set
        if (configDict.items && configDict.items.length > 0) {
          const firstCat = configDict.items
            .filter((i: any) => !i.parentId)
            .sort((a: any, b: any) => a.code.localeCompare(b.code))[0];
          if (firstCat && !activeCategoryTab) {
            setActiveCategoryTab(firstCat.id);
          }
        }
      }

      // Look for presets dictionary
      let presetDict = data.dictionaries.find((d: any) => d.name === '__tag_presets_config__');
      if (!presetDict) {
        await runPresetAutoSeed(activeProject!.id);
      }

      // Look for marking config dictionary
      let markingDict = data.dictionaries.find((d: any) => d.name === '__tag_marking_config__');
      if (!markingDict) {
        await runMarkingAutoSeed(activeProject!.id);
      }

      // Reload all dictionaries to ensure everything is fresh
      const reloadRes = await fetch(`/api/projects/${activeProject!.id}/dictionaries`);
      const reloadData = await reloadRes.json();
      setDictionaries(reloadData.dictionaries);

      const finalPresetDict = reloadData.dictionaries.find((d: any) => d.name === '__tag_presets_config__');
      if (finalPresetDict && finalPresetDict.items && finalPresetDict.items.length > 0) {
        const firstPreset = finalPresetDict.items.find((i: any) => !i.parentId);
        if (firstPreset && !activePresetId) {
          setActivePresetId(firstPreset.id);
        }
      }

      const finalMarkingDict = reloadData.dictionaries.find((d: any) => d.name === '__tag_marking_config__');
      if (finalMarkingDict && finalMarkingDict.items && finalMarkingDict.items.length > 0) {
        const firstMarking = finalMarkingDict.items.filter((i: any) => !i.parentId).sort((a: any, b: any) => a.code.localeCompare(b.code))[0];
        if (firstMarking && !activeMarkingTab) {
          setActiveMarkingTab(firstMarking.id);
        }
      }
      
      if (!activeDictId) {
        setActiveDictId('tag-creation-config'); // Set as default active section!
      }
    } catch (e) {
      console.error(e);
      addToast("Ошибка загрузки справочников", "error");
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !activeProject) return;

    try {
      const data = await file.arrayBuffer();
      const workbook = xlsx.read(data);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const parsed = xlsx.utils.sheet_to_json(sheet, { header: 1 });

      // Skip header (row 0). Actually {header: 1} gives us arrays of rows.
      // So row 0 is header, row 1... are data.
      const items = [];
      for (let i = 1; i < parsed.length; i++) {
        const row = parsed[i] as any[];
        if (row[0] !== undefined) {
          items.push({
            code: String(row[0]).trim(),
            nameRu: row[1] !== undefined ? String(row[1]).trim() : "",
          });
        }
      }

      if (items.length === 0) {
        addToast("Не найдено валидных данных в файле", "error");
        return;
      }

      const dictName = file.name.replace(/\.[^/.]+$/, ""); // Use filename as dict name

      const res = await fetch(
        `/api/projects/${activeProject.id}/dictionaries`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: dictName, items }),
        },
      );

      if (!res.ok) throw new Error("Failed to upload");

      addToast(
        `Загружен справочник ${dictName} (${countOf(items.length, 'элемент')})`,
        "success",
      );
      await fetchDictionaries();
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err: any) {
      console.error(err);
      addToast("Ошибка при обработке Excel файла", "error");
    }
  };

  const handleSaveItem = async (itemId: string) => {
    try {
      const payload = {
        code: editForm.code,
        nameRu: editForm.nameRu,
        parentId: editForm.parentId ? editForm.parentId : null,
      };

      // Optimistic update
      const activeDict = dictionaries.find((d) => d.id === activeDictId);
      if (activeDict) {
        activeDict.items = activeDict.items.map((i: any) =>
          i.id === itemId ? { ...i, ...payload } : i,
        );
        setDictionaries([...dictionaries]);
      }

      const res = await fetch(`/api/dictionaries/items/${itemId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Failed to update");
      setEditingItemId(null);
      addToast("Запись обновлена", "success");
    } catch (e) {
      console.error(e);
      addToast("Ошибка сохранения", "error");
    }
  };

  const handleDeleteItem = async (itemId: string) => {
    if (!await openConfirm('Удалить элемент справочника?', 'Восстановить его будет нельзя.', { confirmLabel: 'Удалить', tone: 'danger' }))
      return;
    try {
      // Optimistic
      const activeDict = dictionaries.find((d) => d.id === activeDictId);
      if (activeDict) {
        activeDict.items = activeDict.items.filter((i: any) => i.id !== itemId);
        setDictionaries([...dictionaries]);
      }

      const res = await fetch(`/api/dictionaries/items/${itemId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete");
      addToast("Запись удалена", "success");
    } catch (e) {
      console.error(e);
      addToast("Ошибка удаления", "error");
    }
  };

  const handleAddItem = async () => {
    if (!activeDictId || !addForm.code) return;
    try {
      const tempId = "temp-" + Date.now();
      const activeDict = dictionaries.find((d) => d.id === activeDictId);

      const payload = {
        code: addForm.code,
        nameRu: addForm.nameRu,
        parentId: addForm.parentId ? addForm.parentId : null,
      };
      const newItem = { id: tempId, dictionaryId: activeDictId, ...payload };

      if (activeDict) {
        activeDict.items.push(newItem);
        setDictionaries([...dictionaries]);
      }

      const res = await fetch(
        `/api/projects/${activeProject!.id}/dictionaries/${activeDictId}/items`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const data = await res.json();

      if (activeDict) {
        activeDict.items = activeDict.items.map((i: any) =>
          i.id === tempId ? data.item : i,
        );
        setDictionaries([...dictionaries]);
      }

      setIsAdding(false);
      setAddForm({ code: "", nameRu: "", parentId: "" });
      addToast("Запись добавлена", "success");
    } catch (e) {
      console.error(e);
      addToast("Ошибка добавления", "error");
    }
  };

  const tagCtl = useTagDict({ dictionaries, setDictionaries, fetchDictionaries, activeCategoryTab, setActiveCategoryTab });

  const markingCtl = useMarkingDict({ dictionaries, setDictionaries, fetchDictionaries, activeMarkingTab, setActiveMarkingTab });

  const presetsCtl = usePresets({ dictionaries, setDictionaries, fetchDictionaries, activePresetId, setActivePresetId });

  if (!activeProject)
    return (
      <div className="p-4 text-slate-500">
        Пожалуйста, сначала выберите проект.
      </div>
    );

  const activeDict = activeDictId === 'tag-creation-config'
    ? dictionaries.find((d) => d.name === '__tag_creation_config__')
    : activeDictId === 'tag-marking-config'
    ? dictionaries.find((d) => d.name === '__tag_marking_config__')
    : dictionaries.find((d) => d.id === activeDictId);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.2 }}
      className="fx-page @container"
    >
      <SectionHead title="Справочник"
        actions={<>
          <input type="file" accept=".xlsx, .xls, .csv" className="hidden" ref={fileInputRef} onChange={handleFileUpload} />
          <Btn tone="primary" onClick={() => fileInputRef.current?.click()}><Upload />Загрузить базу из Excel</Btn>
        </>} />

      <div className="flex-1 min-h-0 flex flex-col @[820px]:flex-row text-left w-full">
        {/* Боковой список: три группы по назначению. «Обозначения» стояли в
            «Создании тегов», хотя ими пользуется разбор бланков Оборудования */}
        <nav className="fx-side w-full @[820px]:w-56 @[1100px]:w-64 shrink-0 overflow-y-auto p-2" aria-label="Справочники">
          <div className="fx-gh">Создание тегов</div>
            <button type="button" onClick={() => setActiveDictId('tag-creation-config')} aria-current={activeDictId === 'tag-creation-config' ? 'true' : undefined} className="fx-li">
              <Sliders /><span className="truncate">Доп. параметры</span>
            </button>
            <button type="button" onClick={() => setActiveDictId('tag-marking-config')} aria-current={activeDictId === 'tag-marking-config' ? 'true' : undefined} className="fx-li">
              <Sliders /><span className="truncate">Маркировка</span>
            </button>
            <button type="button" onClick={() => setActiveDictId('tag-presets-config')} aria-current={activeDictId === 'tag-presets-config' ? 'true' : undefined} className="fx-li" title="Готовые списки значений для отбора тегов на вкладке «Подбор»">
              <Sliders /><span className="truncate">Пресеты подбора</span>
            </button>
          <div className="fx-gh mt-2">Разбор бланков</div>
            <button type="button" onClick={() => setActiveDictId('symbols-config')} aria-current={activeDictId === 'symbols-config' ? 'true' : undefined} className="fx-li" title="Условные обозначения бланков: «L, м³/ч» — расход, «N» — мощность, «n» — обороты">
              <Sliders /><span className="truncate">Обозначения</span>
            </button>
          <div className="fx-gh mt-2">Справочники проекта</div>
          {dictionaries.filter((d) => d.name !== '__tag_creation_config__' && d.name !== '__tag_presets_config__' && d.name !== '__tag_marking_config__').length === 0 ? (
            <div className="px-2 py-2 text-xs text-slate-400">Нет загруженных справочников.</div>
          ) : dictionaries
            .filter((d) => d.name !== '__tag_creation_config__' && d.name !== '__tag_presets_config__' && d.name !== '__tag_marking_config__')
            .map((dict) => (
              <button key={dict.id} type="button" onClick={() => setActiveDictId(dict.id)} aria-current={activeDictId === dict.id ? 'true' : undefined} className="fx-li">
                <span className="truncate">{dict.name}</span>
                <span className="fx-n">{dict.items.length}</span>
              </button>
            ))}
        </nav>

        <div className="flex-1 min-w-0 w-full overflow-y-auto px-6 py-4">
          {activeDictId === 'symbols-config' ? (
            <SymbolsEditor />
          ) : activeDictId === 'tag-creation-config' ? (
            <TagDictPanel dictionaries={dictionaries} activeCategoryTab={activeCategoryTab} setActiveCategoryTab={setActiveCategoryTab} ctl={tagCtl} />
          ) : activeDictId === 'tag-marking-config' ? (
            <MarkingDictPanel dictionaries={dictionaries} activeMarkingTab={activeMarkingTab} setActiveMarkingTab={setActiveMarkingTab} ctl={markingCtl} />
          ) : activeDictId === 'tag-presets-config' ? (
            <PresetsPanel dictionaries={dictionaries} activePresetId={activePresetId} setActivePresetId={setActivePresetId} ctl={presetsCtl} />
          ) : activeDict ? (
            <div className="flex flex-col h-full w-full">
              <div className="p-4 border-b border-slate-200 dark:border-slate-850 bg-slate-50 dark:bg-slate-950 flex items-center justify-between shrink-0">
                <h2 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
                  <Database className="w-4 h-4 text-emerald-500" />
                  {activeDict.name}
                </h2>
                <button
                  type="button"
                  onClick={() => setIsAdding(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-75 * text-slate-700 dark:text-slate-300 rounded text-sm font-semibold transition-colors cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" /> Добавить запись
                </button>
              </div>

              <div className="overflow-x-auto flex-1 overflow-y-auto">
                <table className="w-full text-sm text-left">
                  <thead className="bg-white dark:bg-slate-900 text-slate-500 border-b border-slate-200 dark:border-slate-800  z-10 sticky top-0">
                    <tr>
                      <th className="flux-cell font-medium text-slate-700 dark:text-slate-300">
                        Код (A)
                      </th>
                      <th className="flux-cell font-medium text-slate-700 dark:text-slate-300">
                        Наименование (B)
                      </th>
                      <th className="flux-cell font-medium text-slate-700 dark:text-slate-300">
                        Родительская категория
                      </th>
                      <th className="flux-cell font-medium w-24 text-right text-slate-700 dark:text-slate-300">
                        Действия
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800/40">
                    {isAdding && (
                      <tr className="bg-emerald-500/5">
                        <td className="flux-cell">
                          <input
                            autoFocus
                            type="text"
                            value={addForm.code}
                            onChange={(e) =>
                              setAddForm({ ...addForm, code: e.target.value })
                            }
                            className="w-full px-2 py-1 text-sm border border-emerald-300 dark:border-emerald-800 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                            placeholder="Код..."
                          />
                        </td>
                        <td className="flux-cell">
                          <input
                            type="text"
                            value={addForm.nameRu}
                            onChange={(e) =>
                              setAddForm({ ...addForm, nameRu: e.target.value })
                            }
                            className="w-full px-2 py-1 text-sm border border-emerald-300 dark:border-emerald-800 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                            placeholder="Наименование..."
                          />
                        </td>
                        <td className="flux-cell">
                          <CustomSelect
                            value={addForm.parentId}
                            onChange={(val) =>
                              setAddForm({
                                ...addForm,
                                parentId: val,
                              })
                            }
                            options={[
                              { value: "", label: "Нет (Главная категория)" },
                              ...activeDict.items.map((i: any) => ({
                                value: i.id,
                                label: `${i.code} — ${i.nameRu}`,
                              })),
                            ]}
                          />
                        </td>
                        <td className="flux-cell text-right">
                          <div className="flex items-center justify-end gap-2">
                            <button type="button"
                              onClick={handleAddItem}
                              title="Сохранить значение"
                              className="p-1.5 text-emerald-600 hover:bg-emerald-100 dark:hover:bg-emerald-950/40 rounded transition-colors"
                            >
                              <Check className="w-4 h-4" />
                            </button>
                            <button type="button"
                              onClick={() => {
                                setIsAdding(false);
                                setAddForm({
                                  code: "",
                                  nameRu: "",
                                  parentId: "",
                                });
                              }}
                              className="p-1.5 text-rose-600 hover:bg-rose-100 dark:hover:bg-rose-950/20 rounded transition-colors"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}

                    {getOrderedItems(activeDict.items).map(({ item, depth }) => {
                      const isEditing = editingItemId === item.id;

                      if (isEditing) {
                        return (
                          <tr key={item.id} className="bg-emerald-500/5">
                            <td className="flux-cell">
                              <input
                                autoFocus
                                type="text"
                                value={editForm.code}
                                onChange={(e) =>
                                  setEditForm({
                                    ...editForm,
                                    code: e.target.value,
                                  })
                                }
                                className="w-full px-2 py-1 text-sm border border-emerald-300 dark:border-emerald-800 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                              />
                            </td>
                            <td className="flux-cell">
                              <input
                                type="text"
                                value={editForm.nameRu}
                                onChange={(e) =>
                                  setEditForm({
                                    ...editForm,
                                    nameRu: e.target.value,
                                  })
                                }
                                className="w-full px-2 py-1 text-sm border border-emerald-300 dark:border-emerald-800 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                              />
                            </td>
                            <td className="flux-cell">
                              <CustomSelect
                                value={editForm.parentId}
                                onChange={(val) =>
                                  setEditForm({
                                    ...editForm,
                                    parentId: val,
                                  })
                                }
                                options={[
                                  { value: "", label: "Нет (Главная категория)" },
                                  ...activeDict.items
                                    .filter((i: any) => i.id !== item.id)
                                    .map((i: any) => ({
                                      value: i.id,
                                      label: `${i.code} — ${i.nameRu}`,
                                    })),
                                ]}
                              />
                            </td>
                            <td className="flux-cell text-right">
                              <div className="flex items-center justify-end gap-2">
                                <button type="button"
                                  onClick={() => handleSaveItem(item.id)}
                                  className="p-1.5 text-emerald-600 hover:bg-emerald-100 dark:hover:bg-emerald-950/40 rounded transition-colors"
                                >
                                  <Check className="w-4 h-4" />
                                </button>
                                <button type="button"
                                  onClick={() => setEditingItemId(null)}
                                  className="p-1.5 text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800 rounded transition-colors"
                                >
                                  <X className="w-4 h-4" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      }

                      const parentItem = activeDict.items.find(
                        (i: any) => i.id === item.parentId,
                      );

                      return (
                        <tr
                          key={item.id}
                          className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors group"
                        >
                          <td
                            className="flux-cell font-semibold text-slate-800 dark:text-slate-300 font-mono text-xs flex items-center shadow-none border-none outline-none"
                            style={{ paddingLeft: `${depth * 24 + 16}px` }}
                          >
                            {depth > 0 && (
                              <span className="text-slate-400 font-mono mr-1.5 opacity-60">
                                ├─
                              </span>
                            )}
                            {item.code}
                          </td>
                          <td className="flux-cell text-slate-600 dark:text-slate-400">
                            {item.nameRu}
                          </td>
                          <td className="flux-cell text-slate-500 font-sans text-xs">
                            {parentItem ? (
                              <span className="inline-flex items-center px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-350 border border-slate-200 dark:border-slate-800 text-xs font-mono">
                                {parentItem.code} ({parentItem.nameRu})
                              </span>
                            ) : (
                              <span className="text-xs text-slate-400">
                                Главная категория
                              </span>
                            )}
                          </td>
                          <td className="flux-cell text-right font-sans">
                            <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button type="button"
                                onClick={() => {
                                  setEditingItemId(item.id);
                                  setEditForm({
                                    code: item.code,
                                    nameRu: item.nameRu,
                                    parentId: item.parentId || "",
                                  });
                                }}
                                className="p-1.5 text-emerald-600 hover:bg-emerald-100 dark:hover:bg-emerald-950/40 rounded transition-colors"
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                              <button type="button"
                                onClick={() => handleDeleteItem(item.id)}
                                className="p-1.5 text-rose-600 hover:bg-rose-100 dark:hover:bg-rose-950/20 rounded transition-colors"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {activeDict.items.length === 0 && !isAdding && (
                  <div className="text-center py-10 text-sm text-slate-500 dark:text-slate-400">
                    В этом справочнике еще нет элементов.
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-slate-400 w-full">
              <Database className="w-12 h-12 mb-4 opacity-50 text-emerald-600" />
              <p className="text-slate-605 dark:text-slate-300 font-medium">
                Справочник не выбран
              </p>
              <p className="text-sm mt-1 text-slate-500 dark:text-slate-450">
                Выберите слева или загрузите новый
              </p>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
