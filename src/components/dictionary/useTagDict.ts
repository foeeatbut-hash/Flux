import { useState } from "react";
import { useStore } from "../../store/store";
import { useToastStore } from "../../store/toastStore";
import { useModalStore } from '../../store/modalStore';
import { getOrderNumber } from '../../lib/dictOrder';
import type { DictCtx } from './types';

// Диалоги программы вместо системных окон Windows
const { openConfirm } = useModalStore.getState();

// Выбранная вкладка живёт в экране: её читает и ставит загрузка словарей
export interface TagDictCtx extends DictCtx {
  activeCategoryTab: string | null;
  setActiveCategoryTab: (id: string | null) => void;
}

export function useTagDict({ dictionaries, setDictionaries, fetchDictionaries, activeCategoryTab, setActiveCategoryTab }: TagDictCtx) {
  const activeProject = useStore((s) => s.activeProject);
  const { addToast } = useToastStore();

  // Tag creation dynamic config states
  const [newCategoryName, setNewCategoryName] = useState("");
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editingCategoryName, setEditingCategoryName] = useState("");

  const [newOptionName, setNewOptionName] = useState("");
  const [editingOptionId, setEditingOptionId] = useState<string | null>(null);
  const [editingOptionName, setEditingOptionName] = useState("");

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

  return {
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
  };
}

export type TagDictController = ReturnType<typeof useTagDict>;
