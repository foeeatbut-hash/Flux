import React, { useState, useEffect, useRef } from "react";
import SymbolsEditor from '../components/SymbolsEditor';
import { useStore } from "../store/store";
import { motion } from "motion/react";
import CustomSelect from "../components/CustomSelect";
import {
  Book,
  Upload,
  Plus,
  Edit2,
  Trash2,
  Check,
  X,
  Database,
  ArrowUp,
  ArrowDown,
  Sliders,
  Settings,
  Layers,
  ChevronRight,
  ChevronDown,
  ChevronUp
} from "lucide-react";
import { useToastStore } from "../store/toastStore";
import * as xlsx from "xlsx";
import { countOf } from '../lib/plural';
import { useModalStore } from '../store/modalStore';

// Диалоги программы вместо системных окон Windows
const { openConfirm } = useModalStore.getState();

export default function DictionaryEditor() {
  const { activeProject } = useStore();
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
  const [newCategoryName, setNewCategoryName] = useState("");
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editingCategoryName, setEditingCategoryName] = useState("");

  const [newOptionName, setNewOptionName] = useState("");
  const [editingOptionId, setEditingOptionId] = useState<string | null>(null);
  const [editingOptionName, setEditingOptionName] = useState("");

  // Tag marking dynamic config states
  const [activeMarkingTab, setActiveMarkingTab] = useState<string | null>(null);
  const [newMarkingCategoryName, setNewMarkingCategoryName] = useState("");
  const [editingMarkingCategoryId, setEditingMarkingCategoryId] = useState<string | null>(null);
  const [editingMarkingCategoryName, setEditingMarkingCategoryName] = useState("");

  const [newMarkingOptionName, setNewMarkingOptionName] = useState("");
  const [editingMarkingOptionId, setEditingMarkingOptionId] = useState<string | null>(null);
  const [editingMarkingOptionName, setEditingMarkingOptionName] = useState("");

  const [showTagCreationSidebar, setShowTagCreationSidebar] = useState(true);

  // Preset state variables (mapped to Filter Categories & Variants)
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [newPresetName, setNewPresetName] = useState("");
  const [newPresetProjectNo, setNewPresetProjectNo] = useState("");
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [editingPresetName, setEditingPresetName] = useState("");
  const [editingPresetProjectNo, setEditingPresetProjectNo] = useState("");

  // Sub-items (variants / options) state variables
  const [newSubOptionValue, setNewSubOptionValue] = useState("");
  const [newSubOptionCode, setNewSubOptionCode] = useState("");
  const [editingSubOptionId, setEditingSubOptionId] = useState<string | null>(null);
  const [editingSubOptionValue, setEditingSubOptionValue] = useState("");
  const [editingSubOptionCode, setEditingSubOptionCode] = useState("");

  // Helper function for formatted order codes
  const getOrderNumber = (index: number) => {
    return String(index + 1).padStart(3, '0');
  };

  const getOrderedItems = (items: any[]) => {
    if (!items) return [];
    const map: Record<string, any[]> = {};
    const rootItems: any[] = [];

    items.forEach((item) => {
      if (item.parentId) {
        if (!map[item.parentId]) map[item.parentId] = [];
        map[item.parentId].push(item);
      } else {
        rootItems.push(item);
      }
    });

    const ordered: { item: any; depth: number }[] = [];

    const traverse = (item: any, depth: number) => {
      ordered.push({ item, depth });
      const children = map[item.id] || [];
      const sortedChildren = [...children].sort((a, b) =>
        a.code.localeCompare(b.code),
      );
      sortedChildren.forEach((child) => traverse(child, depth + 1));
    };

    const sortedRoots = [...rootItems].sort((a, b) =>
      a.code.localeCompare(b.code),
    );
    sortedRoots.forEach((root) => traverse(root, 0));

    items.forEach((item) => {
      if (!ordered.some((o) => o.item.id === item.id)) {
        ordered.push({ item, depth: 0 });
      }
    });

    return ordered;
  };

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

  // Moving category (Up or Down)
  const handleMoveCategory = async (index: number, direction: 'up' | 'down') => {
    const configDict = dictionaries.find(d => d.name === '__tag_creation_config__');
    if (!configDict) return;
    const items = configDict.items || [];
    const categoriesList = items
      .filter((i: any) => !i.parentId)
      .sort((a: any, b: any) => a.code.localeCompare(b.code));

    const otherIndex = direction === 'up' ? index - 1 : index + 1;
    if (otherIndex < 0 || otherIndex >= categoriesList.length) return;

    const catA = categoriesList[index];
    const catB = categoriesList[otherIndex];

    const codeA = `${getOrderNumber(otherIndex)}_${catA.id}`;
    const codeB = `${getOrderNumber(index)}_${catB.id}`;

    try {
      // Optimistically update local state to avoid flickers
      catA.code = codeA;
      catB.code = codeB;
      setDictionaries([...dictionaries]);

      await fetch(`/api/dictionaries/items/${catA.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: codeA, nameRu: catA.nameRu, parentId: null })
      });

      await fetch(`/api/dictionaries/items/${catB.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: codeB, nameRu: catB.nameRu, parentId: null })
      });

      addToast("Порядок категорий изменен", "success");
      fetchDictionaries();
    } catch (err) {
      console.error(err);
      addToast("Ошибка при изменении порядка", "error");
    }
  };

  // Adding category
  const handleAddCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCategoryName.trim()) return;
    const configDict = dictionaries.find(d => d.name === '__tag_creation_config__');
    if (!configDict) return;

    const items = configDict.items || [];
    const categoriesList = items.filter((i: any) => !i.parentId);
    const orderCode = `${getOrderNumber(categoriesList.length)}_${Math.random().toString(36).substr(2, 4)}`;

    try {
      const res = await fetch(`/api/projects/${activeProject!.id}/dictionaries/${configDict.id}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: orderCode,
          nameRu: newCategoryName.trim(),
          parentId: null
        })
      });
      if (!res.ok) throw new Error("Add failed");
      const data = await res.json();
      
      addToast("Категория добавлена", "success");
      setNewCategoryName("");
      fetchDictionaries();
      setActiveCategoryTab(data.item.id);
    } catch (err) {
      console.error(err);
      addToast("Ошибка добавления категории", "error");
    }
  };

  // Renaming category
  const handleRenameCategory = async (categoryId: string) => {
    if (!editingCategoryName.trim()) return;
    const configDict = dictionaries.find(d => d.name === '__tag_creation_config__');
    if (!configDict) return;
    const catItem = configDict.items.find((i: any) => i.id === categoryId);
    if (!catItem) return;

    try {
      const res = await fetch(`/api/dictionaries/items/${categoryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: catItem.code,
          nameRu: editingCategoryName.trim(),
          parentId: null
        })
      });
      if (!res.ok) throw new Error("Rename failed");
      addToast("Категория переименована", "success");
      setEditingCategoryId(null);
      fetchDictionaries();
    } catch (err) {
      console.error(err);
      addToast("Ошибка переименования категории", "error");
    }
  };

  // Deleting category
  const handleDeleteCategory = async (categoryId: string) => {
    if (!await openConfirm('Удалить категорию?', 'Вместе с категорией удалятся все её параметры. Действие необратимо.', { confirmLabel: 'Удалить категорию', tone: 'danger' })) return;
    const configDict = dictionaries.find(d => d.name === '__tag_creation_config__');
    if (!configDict) return;

    try {
      const res = await fetch(`/api/dictionaries/items/${categoryId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      
      // Re-index remaining categories
      const remaining = (configDict.items || [])
        .filter((i: any) => !i.parentId && i.id !== categoryId)
        .sort((a: any, b: any) => a.code.localeCompare(b.code));

      for (let i = 0; i < remaining.length; i++) {
        const c = remaining[i];
        const newCode = `${getOrderNumber(i)}_${c.id}`;
        await fetch(`/api/dictionaries/items/${c.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: newCode, nameRu: c.nameRu, parentId: null })
        });
      }

      addToast("Категория удалена", "success");
      if (activeCategoryTab === categoryId) {
        setActiveCategoryTab(null);
      }
      fetchDictionaries();
    } catch (err) {
      console.error(err);
      addToast("Ошибка удаления категории", "error");
    }
  };

  // Adding option
  const handleAddOption = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newOptionName.trim() || !activeCategoryTab) return;
    const configDict = dictionaries.find(d => d.name === '__tag_creation_config__');
    if (!configDict) return;

    try {
      const res = await fetch(`/api/projects/${activeProject!.id}/dictionaries/${configDict.id}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: newOptionName.trim(),
          nameRu: newOptionName.trim(),
          parentId: activeCategoryTab
        })
      });
      if (!res.ok) throw new Error("Add option failed");
      
      addToast("Параметр добавлен", "success");
      setNewOptionName("");
      fetchDictionaries();
    } catch (err) {
      console.error(err);
      addToast("Ошибка добавления параметра", "error");
    }
  };

  // Editing option
  const handleSaveOptionName = async (optionId: string) => {
    if (!editingOptionName.trim() || !activeCategoryTab) return;
    try {
      const res = await fetch(`/api/dictionaries/items/${optionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: editingOptionName.trim(),
          nameRu: editingOptionName.trim(),
          parentId: activeCategoryTab
        })
      });
      if (!res.ok) throw new Error("Update option failed");
      addToast("Параметр изменен", "success");
      setEditingOptionId(null);
      fetchDictionaries();
    } catch (err) {
      console.error(err);
      addToast("Ошибка редактирования параметра", "error");
    }
  };

  // Deleting option
  const handleDeleteOption = async (optionId: string) => {
    try {
      const res = await fetch(`/api/dictionaries/items/${optionId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error("Delete failed");
      addToast("Параметр удален", "success");
      fetchDictionaries();
    } catch (err) {
      console.error(err);
      addToast("Ошибка удаления параметра", "error");
    }
  };

  // --- BRAND MARKING (МАРКИРОВКА) DICTIONARY EVENT HANDLERS ---
  const handleMoveMarkingCategory = async (index: number, direction: 'up' | 'down') => {
    const configDict = dictionaries.find(d => d.name === '__tag_marking_config__');
    if (!configDict) return;
    const items = configDict.items || [];
    const categoriesList = items
      .filter((i: any) => !i.parentId)
      .sort((a: any, b: any) => a.code.localeCompare(b.code));

    const otherIndex = direction === 'up' ? index - 1 : index + 1;
    if (otherIndex < 0 || otherIndex >= categoriesList.length) return;

    const catA = categoriesList[index];
    const catB = categoriesList[otherIndex];

    const codeA = `${getOrderNumber(otherIndex)}_${catA.id}`;
    const codeB = `${getOrderNumber(index)}_${catB.id}`;

    try {
      catA.code = codeA;
      catB.code = codeB;
      setDictionaries([...dictionaries]);

      await fetch(`/api/dictionaries/items/${catA.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: codeA, nameRu: catA.nameRu, parentId: null })
      });

      await fetch(`/api/dictionaries/items/${catB.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: codeB, nameRu: catB.nameRu, parentId: null })
      });

      addToast("Порядок категорий изменен", "success");
      fetchDictionaries();
    } catch (err) {
      console.error(err);
      addToast("Ошибка при изменении порядка", "error");
    }
  };

  const handleAddMarkingCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMarkingCategoryName.trim()) return;
    const configDict = dictionaries.find(d => d.name === '__tag_marking_config__');
    if (!configDict) return;

    const items = configDict.items || [];
    const categoriesList = items.filter((i: any) => !i.parentId);
    const orderCode = `${getOrderNumber(categoriesList.length)}_${Math.random().toString(36).substr(2, 4)}`;

    try {
      const res = await fetch(`/api/projects/${activeProject!.id}/dictionaries/${configDict.id}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: orderCode,
          nameRu: newMarkingCategoryName.trim(),
          parentId: null
        })
      });
      if (!res.ok) throw new Error("Add failed");
      const data = await res.json();
      
      addToast("Категория добавлена", "success");
      setNewMarkingCategoryName("");
      fetchDictionaries();
      setActiveMarkingTab(data.item.id);
    } catch (err) {
      console.error(err);
      addToast("Ошибка добавления категории", "error");
    }
  };

  const handleRenameMarkingCategory = async (categoryId: string) => {
    if (!editingMarkingCategoryName.trim()) return;
    const configDict = dictionaries.find(d => d.name === '__tag_marking_config__');
    if (!configDict) return;
    const catItem = configDict.items.find((i: any) => i.id === categoryId);
    if (!catItem) return;

    try {
      const res = await fetch(`/api/dictionaries/items/${categoryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: catItem.code,
          nameRu: editingMarkingCategoryName.trim(),
          parentId: null
        })
      });
      if (!res.ok) throw new Error("Rename failed");
      addToast("Категория переименована", "success");
      setEditingMarkingCategoryId(null);
      fetchDictionaries();
    } catch (err) {
      console.error(err);
      addToast("Ошибка переименования категории", "error");
    }
  };

  const handleDeleteMarkingCategory = async (categoryId: string) => {
    if (!window.confirm("Вы уверены, что хотите удалить эту категорию вместе с её параметрами?")) return;
    const configDict = dictionaries.find(d => d.name === '__tag_marking_config__');
    if (!configDict) return;

    try {
      const res = await fetch(`/api/dictionaries/items/${categoryId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      
      const remaining = (configDict.items || [])
        .filter((i: any) => !i.parentId && i.id !== categoryId)
        .sort((a: any, b: any) => a.code.localeCompare(b.code));

      for (let i = 0; i < remaining.length; i++) {
        const c = remaining[i];
        const newCode = `${getOrderNumber(i)}_${c.id}`;
        await fetch(`/api/dictionaries/items/${c.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: newCode, nameRu: c.nameRu, parentId: null })
        });
      }

      addToast("Категория удалена", "success");
      if (activeMarkingTab === categoryId) {
        setActiveMarkingTab(null);
      }
      fetchDictionaries();
    } catch (err) {
      console.error(err);
      addToast("Ошибка удаления категории", "error");
    }
  };

  const handleAddMarkingOption = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMarkingOptionName.trim() || !activeMarkingTab) return;
    const configDict = dictionaries.find(d => d.name === '__tag_marking_config__');
    if (!configDict) return;

    try {
      const res = await fetch(`/api/projects/${activeProject!.id}/dictionaries/${configDict.id}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: newMarkingOptionName.trim(),
          nameRu: newMarkingOptionName.trim(),
          parentId: activeMarkingTab
        })
      });
      if (!res.ok) throw new Error("Add option failed");
      
      addToast("Параметр добавлен", "success");
      setNewMarkingOptionName("");
      fetchDictionaries();
    } catch (err) {
      console.error(err);
      addToast("Ошибка добавления параметра", "error");
    }
  };

  const handleSaveMarkingOptionName = async (optionId: string) => {
    if (!editingMarkingOptionName.trim() || !activeMarkingTab) return;
    try {
      const res = await fetch(`/api/dictionaries/items/${optionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: editingMarkingOptionName.trim(),
          nameRu: editingMarkingOptionName.trim(),
          parentId: activeMarkingTab
        })
      });
      if (!res.ok) throw new Error("Update option failed");
      addToast("Параметр изменен", "success");
      setEditingMarkingOptionId(null);
      fetchDictionaries();
    } catch (err) {
      console.error(err);
      addToast("Ошибка редактирования параметра", "error");
    }
  };

  const handleDeleteMarkingOption = async (optionId: string) => {
    try {
      const res = await fetch(`/api/dictionaries/items/${optionId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error("Delete failed");
      addToast("Параметр удален", "success");
      fetchDictionaries();
    } catch (err) {
      console.error(err);
      addToast("Ошибка удаления параметра", "error");
    }
  };

  const handleAddPreset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPresetName.trim() || !newPresetProjectNo.trim()) {
      addToast("Заполните оба поля", "error");
      return;
    }

    const presetDict = dictionaries.find(d => d.name === '__tag_presets_config__');
    if (!presetDict) return;

    try {
      const res = await fetch(`/api/projects/${activeProject!.id}/dictionaries/${presetDict.id}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: newPresetProjectNo.trim(),
          nameRu: newPresetName.trim(),
          parentId: null
        })
      });

      if (!res.ok) throw new Error("Preset add failed");
      const data = await res.json();
      addToast("Предустановка добавлена", "success");
      setNewPresetName("");
      setNewPresetProjectNo("");
      await fetchDictionaries();
      setActivePresetId(data.item.id);
    } catch (err) {
      console.error(err);
      addToast("Ошибка добавления предустановки", "error");
    }
  };

  const handleSavePresetEdit = async (presetId: string) => {
    if (!editingPresetName.trim() || !editingPresetProjectNo.trim()) return;

    try {
      const res = await fetch(`/api/dictionaries/items/${presetId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: editingPresetProjectNo.trim(),
          nameRu: editingPresetName.trim(),
          parentId: null
        })
      });

      if (!res.ok) throw new Error("Update preset failed");
      addToast("Предустановка изменена", "success");
      setEditingPresetId(null);
      fetchDictionaries();
    } catch (err) {
      console.error(err);
      addToast("Ошибка редактирования предустановки", "error");
    }
  };

  const handleDeletePreset = async (presetId: string) => {
    if (!await openConfirm('Удалить предустановку?', 'Восстановить её будет нельзя.', { confirmLabel: 'Удалить', tone: 'danger' })) return;

    try {
      const res = await fetch(`/api/dictionaries/items/${presetId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error("Delete failed");
      addToast("Предустановка удалена", "success");
      if (activePresetId === presetId) {
        setActivePresetId(null);
      }
      fetchDictionaries();
    } catch (err) {
      console.error(err);
      addToast("Ошибка удаления предустановки", "error");
    }
  };

  const handleTogglePresetOption = async (presetId: string, catName: string, optName: string, presetDictId: string, presetItems: any[]) => {
    const subItem = presetItems.find((i: any) => i.parentId === presetId && i.code === catName);

    if (subItem) {
      const currentValues = subItem.nameRu ? subItem.nameRu.split(',').filter(Boolean) : [];
      const isChecked = currentValues.includes(optName);
      const newValues = isChecked 
        ? currentValues.filter((v: string) => v !== optName)
        : [...currentValues, optName];

      try {
        // Optimistic state update:
        subItem.nameRu = newValues.join(',');
        setDictionaries([...dictionaries]);

        await fetch(`/api/dictionaries/items/${subItem.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: catName,
            nameRu: newValues.join(','),
            parentId: presetId
          })
        });
        fetchDictionaries();
      } catch (err) {
        console.error(err);
      }
    } else {
      try {
        await fetch(`/api/projects/${activeProject!.id}/dictionaries/${presetDictId}/items`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: catName,
            nameRu: optName,
            parentId: presetId
          })
        });
        fetchDictionaries();
      } catch (err) {
        console.error(err);
      }
    }
  };

  const handleCreateSubOption = async (e: React.FormEvent, presetDictId: string) => {
    e.preventDefault();
    if (!activePresetId) return;
    if (!newSubOptionValue.trim()) {
      addToast("Введите значение варианта", "error");
      return;
    }
    try {
      const res = await fetch(`/api/projects/${activeProject!.id}/dictionaries/${presetDictId}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: newSubOptionCode.trim() || newSubOptionValue.trim(),
          nameRu: newSubOptionValue.trim(),
          parentId: activePresetId
        })
      });
      if (!res.ok) throw new Error("Failed to add sub option");
      addToast("Вариант успешно добавлен", "success");
      setNewSubOptionValue("");
      setNewSubOptionCode("");
      fetchDictionaries();
    } catch (err) {
      console.error(err);
      addToast("Ошибка добавления варианта", "error");
    }
  };

  const handleSaveSubOptionEdit = async (itemId: string) => {
    if (!editingSubOptionValue.trim()) return;
    try {
      const res = await fetch(`/api/dictionaries/items/${itemId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: editingSubOptionCode.trim() || editingSubOptionValue.trim(),
          nameRu: editingSubOptionValue.trim(),
          parentId: activePresetId
        })
      });
      if (!res.ok) throw new Error("Failed to edit sub option");
      addToast("Вариант сохранен", "success");
      setEditingSubOptionId(null);
      fetchDictionaries();
    } catch (err) {
      console.error(err);
      addToast("Ошибка изменения варианта", "error");
    }
  };

  const handleDeleteSubOption = async (itemId: string) => {
    if (!await openConfirm('Удалить вариант?', 'Восстановить его будет нельзя.', { confirmLabel: 'Удалить', tone: 'danger' })) return;
    try {
      const res = await fetch(`/api/dictionaries/items/${itemId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error("Delete sub option failed");
      addToast("Вариант удален", "success");
      fetchDictionaries();
    } catch (err) {
      console.error(err);
      addToast("Ошибка удаления варианта", "error");
    }
  };

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
      className="w-full h-full flex flex-col space-y-4 min-h-0"
    >
      <div className="flex justify-between items-center bg-white dark:bg-slate-900 p-6 rounded-lg border border-slate-200 dark:border-slate-800  transition-colors shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white tracking-tight flex items-center gap-2">
            <Book className="w-6 h-6 text-emerald-600 dark:text-emerald-400" />
            Редактор справочников
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Списки значений, из которых собираются коды тегов.
          </p>
        </div>
        <div className="flex gap-4">
          <input
            type="file"
            accept=".xlsx, .xls, .csv"
            className="hidden"
            ref={fileInputRef}
            onChange={handleFileUpload}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-semibold text-sm transition-colors shadow-sm cursor-pointer"
          >
            <Upload className="w-4 h-4" />
            Загрузить базу из Excel
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col @[820px]:flex-row gap-6 text-left w-full">
        <div className="w-full @[820px]:w-56 @[1100px]:w-64 shrink-0 space-y-5 h-full overflow-y-auto pr-1">
          {/* SECTION: TAG CREATION */}
          <div className="space-y-2">
            <button type="button"
              onClick={() => setShowTagCreationSidebar(!showTagCreationSidebar)}
              /* py-1.5: заголовок-переключатель был высотой в 16 точек — по
                 такому промахиваются мышью чаще, чем попадают */
              className="w-full flex items-center justify-between py-1.5 text-xs font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 uppercase tracking-widest cursor-pointer select-none"
            >
              <span className="flex items-center gap-1.5">
                <Settings className="w-3.5 h-3.5 text-emerald-500" />
                Создание тегов
              </span>
              {showTagCreationSidebar ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </button>
            {showTagCreationSidebar && (
              <div className="bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden flex flex-col transition-colors">
                <button
                  type="button"
                  onClick={() => setActiveDictId('tag-creation-config')}
                  className={`px-4 py-3 text-left text-xs font-semibold tracking-wide transition-colors flex items-center justify-between gap-1.5 ${activeDictId === 'tag-creation-config' ? "bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-400 font-bold border-l-2 border-emerald-500" : "hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-350"}`}
                >
                  <span className="flex items-center gap-2">
                    <Sliders className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    <span>Доп. параметры</span>
                  </span>
                  <span className="text-xs uppercase font-bold text-emerald-600 bg-emerald-500/10 px-1 py-0.5 rounded leading-none shrink-0">
                    сист
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveDictId('tag-marking-config')}
                  className={`px-4 py-3 text-left text-xs font-semibold tracking-wide transition-colors flex items-center justify-between gap-1.5 ${activeDictId === 'tag-marking-config' ? "bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-400 font-bold border-l-2 border-emerald-500" : "hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-350"}`}
                >
                  <span className="flex items-center gap-2">
                    <Sliders className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    <span>Маркировка</span>
                  </span>
                  <span className="text-xs uppercase font-bold text-emerald-600 bg-emerald-500/10 px-1 py-0.5 rounded leading-none shrink-0">
                    сист
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveDictId('symbols-config')}
                  title="Условные обозначения бланков: «L, м³/ч» — расход, «N» — мощность, «n» — обороты"
                  className={`px-4 py-3 text-left text-xs font-semibold tracking-wide transition-colors flex items-center justify-between gap-1.5 ${activeDictId === 'symbols-config' ? "bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-400 font-bold border-l-2 border-emerald-500" : "hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-350"}`}
                >
                  <span className="flex items-center gap-2">
                    <Sliders className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    <span>Обозначения</span>
                  </span>
                  <span className="text-xs uppercase font-bold text-emerald-600 bg-emerald-500/10 px-1 py-0.5 rounded leading-none shrink-0">
                    сист
                  </span>
                </button>
              </div>
            )}
          </div>

          {/* SECTION: STANDARD EXCEL DICTIONARIES */}
          <div className="space-y-2">
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest">
              Справочники проекта
            </label>
            <div className="bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden flex flex-col transition-colors">
              {dictionaries.filter((d) => d.name !== '__tag_creation_config__' && d.name !== '__tag_presets_config__' && d.name !== '__tag_marking_config__').length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-400 dark:text-slate-500 italic">
                  Нет загруженных справочников.
                </div>
              ) : (
                <div className="flex flex-col divide-y divide-slate-100 dark:divide-slate-800 max-h-[420px] overflow-y-auto">
                  {dictionaries
                    .filter((d) => d.name !== '__tag_creation_config__' && d.name !== '__tag_presets_config__' && d.name !== '__tag_marking_config__')
                    .map((dict) => (
                      <button
                        key={dict.id}
                        type="button"
                        onClick={() => setActiveDictId(dict.id)}
                        className={`px-4 py-3 text-left text-xs font-medium transition-colors flex items-center justify-between gap-2 border-l-2 hover:bg-slate-50 dark:hover:bg-slate-800 ${activeDictId === dict.id ? "bg-slate-50 dark:bg-slate-800/50 border-emerald-500 text-slate-900 dark:text-white font-bold" : "border-transparent text-slate-655 dark:text-slate-350"}`}
                      >
                        <span className="truncate flex-1">{dict.name}</span>
                        <span className="text-xs text-slate-400 font-mono bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded shrink-0">
                          {dict.items.length}
                        </span>
                      </button>
                    ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex-1 min-w-0 w-full">
          {activeDictId === 'symbols-config' ? (
            <SymbolsEditor />
          ) : activeDictId === 'tag-creation-config' ? (
            (() => {
              const configDict = dictionaries.find(d => d.name === '__tag_creation_config__');
              const items = configDict?.items || [];
              const categories = items
                .filter((i: any) => !i.parentId)
                .sort((a: any, b: any) => a.code.localeCompare(b.code));

              return (
                <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800  flex flex-col transition-colors overflow-hidden h-full w-full">
                  <div className="p-2.5 @[700px]:p-5 border-b border-slate-200 dark:border-slate-850 bg-slate-50 dark:bg-slate-950 shrink-0">
                    <div className="flex items-center gap-2 min-w-0">
                       <Settings className="w-5 h-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                       <h2 className="min-w-0 font-bold text-slate-800 dark:text-white text-base @[700px]:text-lg font-mono text-pretty">
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
                        <h3 className="min-w-0 text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
                          <Layers className="w-4 h-4 text-emerald-550" />
                          Категории параметров
                        </h3>
                        <span className="text-xs font-mono font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-2 py-0.5 rounded">
                          Всего: {categories.length}
                        </span>
                      </div>

                      <div className="bg-slate-50 dark:bg-slate-950 p-2.5 @[700px]:p-4 rounded-xl border border-slate-200/60 dark:border-slate-850 space-y-4">
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
                            className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold transition-colors select-none cursor-pointer flex items-center gap-1 shrink-0"
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
                                      <span className="font-mono text-xs text-slate-405 dark:text-slate-500 font-bold">#{index + 1}</span>
                                      <span className="text-xs font-bold font-sans truncate">{cat.nameRu}</span>
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
                            <div className="text-center py-8 text-xs text-slate-400 italic">
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
                                <h3 className="text-xs font-bold text-slate-550 dark:text-slate-400 uppercase tracking-widest flex items-center gap-1.5 min-w-0 max-w-[240px]">
                                  <Sliders className="w-4 h-4 text-emerald-500 shrink-0" />
                                  Варианты: <span className="text-emerald-600 dark:text-emerald-400 font-bold flex-1 min-w-0 truncate">«{activeCategory?.nameRu}»</span>
                                </h3>
                                <span className="text-xs font-mono font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-2 py-0.5 rounded leading-none shrink-0">
                                  Всего: {options.length}
                                </span>
                              </div>

                              <div className="bg-slate-50 dark:bg-slate-950 p-2.5 @[700px]:p-4 rounded-xl border border-slate-200/60 dark:border-slate-850 space-y-4">
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
                                    className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold transition-colors select-none cursor-pointer flex items-center gap-1 shrink-0"
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
                                          className="p-2.5 rounded-lg border border-slate-200/60 dark:border-slate-850 bg-white dark:bg-slate-900 flex items-center justify-between transition-ui"
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
                                    <div className="text-center py-8 text-xs text-slate-400 italic">
                                      Список вариантов пуст. Добавьте первый выше!
                                    </div>
                                  )}
                                </div>
                              </div>
                            </>
                          );
                        })()
                      ) : (
                        <div className="bg-slate-50 dark:bg-slate-950/40 rounded-xl border border-dashed border-slate-200 dark:border-slate-800 p-8 text-center text-xs text-slate-400 flex flex-col items-center justify-center h-full">
                          <Sliders className="w-8 h-8 mb-2 opacity-30 text-emerald-500" />
                          <span>Выберите категорию слева, чтобы редактировать список вариантов.</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()
          ) : activeDictId === 'tag-marking-config' ? (
            (() => {
              const configDict = dictionaries.find(d => d.name === '__tag_marking_config__');
              const items = configDict?.items || [];
              const categories = items
                .filter((i: any) => !i.parentId)
                .sort((a: any, b: any) => a.code.localeCompare(b.code));

              return (
                <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800  flex flex-col transition-colors overflow-hidden h-full w-full">
                  <div className="p-5 border-b border-slate-200 dark:border-slate-850 bg-slate-50 dark:bg-slate-950 shrink-0">
                    <div className="flex items-center gap-2">
                      <Settings className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                      <h2 className="font-bold text-slate-800 dark:text-white text-lg font-mono">
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
                        <h3 className="min-w-0 text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
                          <Layers className="w-4 h-4 text-emerald-550" />
                          Категории маркировки
                        </h3>
                        <span className="text-xs font-mono font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-2 py-0.5 rounded">
                          Всего: {categories.length}
                        </span>
                      </div>

                      <div className="bg-slate-50 dark:bg-slate-950 p-2.5 @[700px]:p-4 rounded-xl border border-slate-200/60 dark:border-slate-850 space-y-4">
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
                            className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold transition-colors select-none cursor-pointer flex items-center gap-1 shrink-0"
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
                                      <p className="text-xs font-bold text-slate-800 dark:text-slate-300 truncate">
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
                            <div className="text-center py-12 text-xs text-slate-400 italic">
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
                                <h3 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest flex items-center gap-1.5 min-w-0">
                                  <Layers className="w-4 h-4 text-emerald-550 shrink-0" />
                                  <span className="truncate">Варианты для: "{activeCategory?.nameRu}"</span>
                                </h3>
                                <span className="text-xs font-mono font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-2 py-0.5 rounded shrink-0">
                                  Всего: {options.length}
                                </span>
                              </div>

                              <div className="bg-slate-50 dark:bg-slate-950 p-2.5 @[700px]:p-4 rounded-xl border border-slate-200/60 dark:border-slate-850 space-y-4">
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
                                    className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold transition-colors select-none cursor-pointer flex items-center gap-1 shrink-0"
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
                                          className="p-2.5 rounded-lg border border-slate-200/60 dark:border-slate-850 bg-white dark:bg-slate-900 flex items-center justify-between transition-ui"
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
                                    <div className="text-center py-8 text-xs text-slate-400 italic">
                                      Список вариантов пуст. Добавьте первый выше!
                                    </div>
                                  )}
                                </div>
                              </div>
                            </>
                          );
                        })()
                      ) : (
                        <div className="bg-slate-50 dark:bg-slate-950/40 rounded-xl border border-dashed border-slate-200 dark:border-slate-800 p-8 text-center text-xs text-slate-400 flex flex-col items-center justify-center h-full">
                          <Sliders className="w-8 h-8 mb-2 opacity-30 text-emerald-500" />
                          <span>Выберите категорию слева, чтобы редактировать список вариантов.</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()
          ) : activeDictId === 'tag-presets-config' ? (
            (() => {
              const presetDict = dictionaries.find(d => d.name === '__tag_presets_config__');
              const presetItems = presetDict?.items || [];
              const presets = presetItems.filter((i: any) => !i.parentId);

              return (
                <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800  flex flex-col transition-colors overflow-hidden text-left">
                  <div className="p-4 border-b border-slate-100 dark:border-slate-800/60 bg-slate-50/50 dark:bg-slate-950/20 flex items-center justify-between">
                    <div>
                      <h2 className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
                        <Sliders className="w-4 h-4 text-emerald-500" />
                        Категории фильтров и варианты для «Экспорт и импорт»
                      </h2>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                        Создайте категорию фильтра (например: Системы, Клапаны, Раздел), а затем наполните её вариантами значений. Эти списки появятся в карточках сегментов.
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 @[900px]:grid-cols-12 divide-y @[900px]:divide-y-0 @[900px]:divide-x divide-slate-100 dark:divide-slate-800 min-h-[500px]">
                    {/* LEFTSIDE: CATEGORIES LIST & ADD */}
                    <div className="col-span-1 @[900px]:col-span-5 p-4 flex flex-col bg-slate-50/10 dark:bg-slate-950/10">
                      <h3 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-3">
                        Категории фильтров
                      </h3>

                      {/* Add Category Form */}
                      <form onSubmit={handleAddPreset} className="space-y-2 mb-4">
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="block text-xs uppercase font-bold text-slate-400 mb-1">Название категории</label>
                            <input
                              type="text"
                              value={newPresetName}
                              onChange={(e) => setNewPresetName(e.target.value)}
                              placeholder="например: Системы"
                              className="w-full px-2.5 py-1.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                            />
                          </div>
                          <div>
                            <label className="block text-xs uppercase font-bold text-slate-400 mb-1">Код/Сокращение</label>
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
                          className="w-full py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-md text-xs font-bold transition-colors select-none cursor-pointer flex items-center justify-center gap-1 shrink-0"
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
                                    <span className="text-xs font-bold text-slate-800 dark:text-slate-300">{preset.nameRu}</span>
                                    <span className="text-xs font-mono text-emerald-600 dark:text-emerald-400">Код: {preset.code}</span>
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
                          <div className="text-center py-8 text-xs text-slate-400 italic">
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
                                <h3 className="text-xs font-bold text-slate-800 dark:text-slate-300">
                                  Варианты для категории: <span className="text-emerald-600">{activeCategory?.nameRu} ({activeCategory?.code})</span>
                                </h3>
                                <p className="text-xs text-slate-500 mt-0.5">
                                  Добавьте значения фильтров, которые будут сопоставлены с этой категорией.
                                </p>
                              </div>

                              {/* Form to add a sub-option value */}
                              <form onSubmit={(e) => handleCreateSubOption(e, presetDict!.id)} className="grid grid-cols-12 gap-2 bg-white dark:bg-slate-900 duration-150 p-3 rounded-lg border border-slate-100 dark:border-slate-850">
                                <div className="col-span-5">
                                  <label className="block text-xs uppercase font-bold text-slate-400">Значение варианта</label>
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
                                  <label className="block text-xs uppercase font-bold text-slate-400">Код (для вставки)</label>
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
                                    className="w-full py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-xs font-bold transition-colors select-none cursor-pointer flex items-center justify-center h-7 mt-0.5"
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
                                            <span className="text-xs font-bold text-slate-800 dark:text-slate-300">{opt.nameRu}</span>
                                            {opt.code && opt.code !== opt.nameRu && (
                                              <span className="text-xs font-mono bg-slate-100 dark:bg-slate-800 text-slate-500 px-1 py-0.5 rounded leading-none">Код: {opt.code}</span>
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
                                  <div className="text-center py-6 text-xs text-slate-405 italic">
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
            })()
          ) : activeDict ? (
            <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800  flex flex-col transition-colors h-full w-full overflow-hidden">
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
                              <span className="text-xs text-slate-400 italic">
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
            <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800  flex flex-col items-center justify-center h-full text-slate-400 transition-colors w-full overflow-hidden">
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
