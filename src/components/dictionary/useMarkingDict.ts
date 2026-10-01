import { useState } from "react";
import { useStore } from "../../store/store";
import { useToastStore } from "../../store/toastStore";
import { getOrderNumber } from '../../lib/dictOrder';
import type { DictCtx } from './types';

// Выбранная вкладка живёт в экране: её читает и ставит загрузка словарей
export interface MarkingDictCtx extends DictCtx {
  activeMarkingTab: string | null;
  setActiveMarkingTab: (id: string | null) => void;
}

export function useMarkingDict({ dictionaries, setDictionaries, fetchDictionaries, activeMarkingTab, setActiveMarkingTab }: MarkingDictCtx) {
  const activeProject = useStore((s) => s.activeProject);
  const { addToast } = useToastStore();

  // Tag marking dynamic config states
  const [newMarkingCategoryName, setNewMarkingCategoryName] = useState("");
  const [editingMarkingCategoryId, setEditingMarkingCategoryId] = useState<string | null>(null);
  const [editingMarkingCategoryName, setEditingMarkingCategoryName] = useState("");

  const [newMarkingOptionName, setNewMarkingOptionName] = useState("");
  const [editingMarkingOptionId, setEditingMarkingOptionId] = useState<string | null>(null);
  const [editingMarkingOptionName, setEditingMarkingOptionName] = useState("");

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

  return {
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
  };
}

export type MarkingDictController = ReturnType<typeof useMarkingDict>;
