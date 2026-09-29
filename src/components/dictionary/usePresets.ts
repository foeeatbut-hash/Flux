import { useState } from "react";
import { useStore } from "../../store/store";
import { useToastStore } from "../../store/toastStore";
import { useModalStore } from '../../store/modalStore';
import type { DictCtx } from './types';

// Диалоги программы вместо системных окон Windows
const { openConfirm } = useModalStore.getState();

// Выбранная вкладка живёт в экране: её читает и ставит загрузка словарей
export interface PresetsCtx extends DictCtx {
  activePresetId: string | null;
  setActivePresetId: (id: string | null) => void;
}

export function usePresets({ dictionaries, setDictionaries, fetchDictionaries, activePresetId, setActivePresetId }: PresetsCtx) {
  const { activeProject } = useStore();
  const { addToast } = useToastStore();

  // Preset state variables (mapped to Filter Categories & Variants)
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

  return {
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
    handleTogglePresetOption,
    handleCreateSubOption,
    handleSaveSubOptionEdit,
    handleDeleteSubOption,
  };
}

export type PresetsController = ReturnType<typeof usePresets>;
