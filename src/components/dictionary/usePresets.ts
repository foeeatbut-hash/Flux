import { useState } from "react";
import { useStore } from "../../store/store";
import { useToastStore } from "../../store/toastStore";
import { useModalStore } from '../../store/modalStore';
import { useOpenRecords } from '../useOpenRecords';
import { putItem, deleteItem, createItem, settleWrite, type SettleOptions } from './dictWrite';
import { dictNamesOf } from './changeRules';
import type { DictCtx } from './types';

// Диалоги программы вместо системных окон Windows
const { openConfirm } = useModalStore.getState();

// Выбранная вкладка живёт в экране: её читает и ставит загрузка словарей
export interface PresetsCtx extends DictCtx {
  activePresetId: string | null;
  setActivePresetId: (id: string | null) => void;
}

export function usePresets(ctx: PresetsCtx) {
  const { dictionaries, setDictionaries, fetchDictionaries, clearRefusal, activePresetId, setActivePresetId } = ctx;
  const activeProject = useStore((s) => s.activeProject);
  const { addToast } = useToastStore();
  // Код здесь показывается человеку (сокращение категории, код варианта), поэтому остаётся в перечне
  const how = (o: Pick<SettleOptions, 'mode' | 'title' | 'fallback'>): SettleOptions => ({ ...o, names: dictNamesOf(dictionaries) });
  const itemOf = (id: string) => (dictionaries.find(d => d.name === '__tag_presets_config__')?.items || []).find((i: any) => i.id === id);

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

  // Категория или вариант, который правят в строке, у коллег показан как открытый: удалить его нельзя
  useOpenRecords('dict-presets', [editingPresetId, editingSubOptionId].filter(Boolean).map((id) => ({ model: 'DictionaryItem', id: id as string })));

  const handleAddPreset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPresetName.trim() || !newPresetProjectNo.trim()) {
      addToast("Заполните оба поля", "error");
      return;
    }

    const presetDict = dictionaries.find(d => d.name === '__tag_presets_config__');
    if (!presetDict) return;

    clearRefusal();
    const outcome = await createItem(activeProject!.id, presetDict.id, { code: newPresetProjectNo.trim(), nameRu: newPresetName.trim(), parentId: null });
    if (!settleWrite(outcome, null, ctx, how({ mode: 'dialog', title: 'Предустановка не добавлена', fallback: 'Ошибка добавления предустановки' }))) return;
    addToast("Предустановка добавлена", "success");
    setNewPresetName("");
    setNewPresetProjectNo("");
    await fetchDictionaries();
    if (outcome.kind === 'ok') setActivePresetId(outcome.data.item.id);
  };

  const handleSavePresetEdit = async (presetId: string) => {
    if (!editingPresetName.trim() || !editingPresetProjectNo.trim()) return;

    clearRefusal();
    const shown = itemOf(presetId);
    const outcome = await putItem(presetId, shown, { code: editingPresetProjectNo.trim(), nameRu: editingPresetName.trim(), parentId: null });
    // Отказ: строка правки остаётся открытой с набранным
    if (!settleWrite(outcome, shown, ctx, how({ mode: 'edit', title: 'Правка не записана', fallback: 'Ошибка редактирования предустановки' }))) return;
    addToast("Предустановка изменена", "success");
    setEditingPresetId(null);
    fetchDictionaries();
  };

  const handleDeletePreset = async (presetId: string) => {
    if (!await openConfirm('Удалить предустановку?', 'Восстановить её будет нельзя.', { confirmLabel: 'Удалить', tone: 'danger' })) return;

    clearRefusal();
    const shown = itemOf(presetId);
    if (!settleWrite(await deleteItem(presetId, shown), shown, ctx, how({ mode: 'dialog', title: 'Предустановка не удалена', fallback: 'Ошибка удаления предустановки' }))) return;
    addToast("Предустановка удалена", "success");
    if (activePresetId === presetId) {
      setActivePresetId(null);
    }
    fetchDictionaries();
  };

  const handleTogglePresetOption = async (presetId: string, catName: string, optName: string, presetDictId: string, presetItems: any[]) => {
    const subItem = presetItems.find((i: any) => i.parentId === presetId && i.code === catName);

    clearRefusal();
    if (subItem) {
      const currentValues = subItem.nameRu ? subItem.nameRu.split(',').filter(Boolean) : [];
      const isChecked = currentValues.includes(optName);
      const newValues = isChecked 
        ? currentValues.filter((v: string) => v !== optName)
        : [...currentValues, optName];

      // Версия и перечень — по пункту, каким его видел экран, до того как значения сменятся на месте
      const shown = { ...subItem };
      // Optimistic state update:
      subItem.nameRu = newValues.join(',');
      setDictionaries([...dictionaries]);

      const outcome = await putItem(subItem.id, shown, { code: catName, nameRu: newValues.join(','), parentId: presetId });
      if (!settleWrite(outcome, shown, ctx, { ...how({ mode: 'edit', title: 'Правка не записана', fallback: 'Ошибка редактирования варианта' }), rereadAlways: true })) return;
      fetchDictionaries();
    } else {
      const outcome = await createItem(activeProject!.id, presetDictId, { code: catName, nameRu: optName, parentId: presetId });
      if (!settleWrite(outcome, null, ctx, how({ mode: 'dialog', title: 'Вариант не добавлен', fallback: 'Ошибка добавления варианта' }))) return;
      fetchDictionaries();
    }
  };

  const handleCreateSubOption = async (e: React.FormEvent, presetDictId: string) => {
    e.preventDefault();
    if (!activePresetId) return;
    if (!newSubOptionValue.trim()) {
      addToast("Введите значение варианта", "error");
      return;
    }
    clearRefusal();
    const outcome = await createItem(activeProject!.id, presetDictId, { code: newSubOptionCode.trim() || newSubOptionValue.trim(), nameRu: newSubOptionValue.trim(), parentId: activePresetId });
    if (!settleWrite(outcome, null, ctx, how({ mode: 'dialog', title: 'Вариант не добавлен', fallback: 'Ошибка добавления варианта' }))) return;
    addToast("Вариант успешно добавлен", "success");
    setNewSubOptionValue("");
    setNewSubOptionCode("");
    fetchDictionaries();
  };

  const handleSaveSubOptionEdit = async (itemId: string) => {
    if (!editingSubOptionValue.trim()) return;
    clearRefusal();
    const shown = itemOf(itemId);
    const outcome = await putItem(itemId, shown, { code: editingSubOptionCode.trim() || editingSubOptionValue.trim(), nameRu: editingSubOptionValue.trim(), parentId: activePresetId });
    if (!settleWrite(outcome, shown, ctx, how({ mode: 'edit', title: 'Правка не записана', fallback: 'Ошибка изменения варианта' }))) return;
    addToast("Вариант сохранен", "success");
    setEditingSubOptionId(null);
    fetchDictionaries();
  };

  const handleDeleteSubOption = async (itemId: string) => {
    if (!await openConfirm('Удалить вариант?', 'Восстановить его будет нельзя.', { confirmLabel: 'Удалить', tone: 'danger' })) return;
    clearRefusal();
    const shown = itemOf(itemId);
    if (!settleWrite(await deleteItem(itemId, shown), shown, ctx, how({ mode: 'dialog', title: 'Вариант не удалён', fallback: 'Ошибка удаления варианта' }))) return;
    addToast("Вариант удален", "success");
    fetchDictionaries();
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
