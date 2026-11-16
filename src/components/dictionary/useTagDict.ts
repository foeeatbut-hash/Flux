import { useState } from "react";
import { useStore } from "../../store/store";
import { useToastStore } from "../../store/toastStore";
import { useModalStore } from '../../store/modalStore';
import { getOrderNumber } from '../../lib/dictOrder';
import { useOpenRecords } from '../useOpenRecords';
import { putItem, deleteItem, createItem, settleWrite, type SettleOptions } from './dictWrite';
import { dictNamesOf } from './changeRules';
import type { DictCtx } from './types';

// Диалоги программы вместо системных окон Windows
const { openConfirm } = useModalStore.getState();

// Выбранная вкладка живёт в экране: её читает и ставит загрузка словарей
export interface TagDictCtx extends DictCtx {
  activeCategoryTab: string | null;
  setActiveCategoryTab: (id: string | null) => void;
}

export function useTagDict(ctx: TagDictCtx) {
  const { dictionaries, setDictionaries, fetchDictionaries, clearRefusal, activeCategoryTab, setActiveCategoryTab } = ctx;
  const activeProject = useStore((s) => s.activeProject);
  const { addToast } = useToastStore();
  // Код категории здесь служебный («001_ab12»), человек видит название и место в списке
  const how = (o: Pick<SettleOptions, 'mode' | 'title' | 'fallback'>): SettleOptions => ({ ...o, names: dictNamesOf(dictionaries, true) });

  // Tag creation dynamic config states
  const [newCategoryName, setNewCategoryName] = useState("");
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editingCategoryName, setEditingCategoryName] = useState("");

  const [newOptionName, setNewOptionName] = useState("");
  const [editingOptionId, setEditingOptionId] = useState<string | null>(null);
  const [editingOptionName, setEditingOptionName] = useState("");

  // Категория или вариант, который правят в строке, у коллег показан как открытый: удалить его нельзя
  useOpenRecords('dict-tag', [editingCategoryId, editingOptionId].filter(Boolean).map((id) => ({ model: 'DictionaryItem', id: id as string })));

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
    // Версии и перечень берутся у пунктов, какими их видел экран, — до того как коды сменятся на месте
    const shownA = { ...catA };
    const shownB = { ...catB };

    const codeA = `${getOrderNumber(otherIndex)}_${catA.id}`;
    const codeB = `${getOrderNumber(index)}_${catB.id}`;

    clearRefusal();
    // Optimistically update local state to avoid flickers
    catA.code = codeA;
    catB.code = codeB;
    setDictionaries([...dictionaries]);

    // Два запроса: отказ любого показываем и перечитываем справочник — порядок не «всё или ничего»
    const how2 = { ...how({ mode: 'edit', title: 'Порядок не изменён', fallback: 'Ошибка при изменении порядка' }), rereadAlways: true };
    if (!settleWrite(await putItem(catA.id, shownA, { code: codeA, nameRu: catA.nameRu, parentId: null }), shownA, ctx, how2)) return;
    if (!settleWrite(await putItem(catB.id, shownB, { code: codeB, nameRu: catB.nameRu, parentId: null }), shownB, ctx, how2)) return;

    addToast("Порядок категорий изменен", "success");
    fetchDictionaries();
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

    clearRefusal();
    const outcome = await createItem(activeProject!.id, configDict.id, { code: orderCode, nameRu: newCategoryName.trim(), parentId: null });
    if (!settleWrite(outcome, null, ctx, how({ mode: 'dialog', title: 'Категория не добавлена', fallback: 'Ошибка добавления категории' }))) return;

    addToast("Категория добавлена", "success");
    setNewCategoryName("");
    fetchDictionaries();
    if (outcome.kind === 'ok') setActiveCategoryTab(outcome.data.item.id);
  };

  // Renaming category
  const handleRenameCategory = async (categoryId: string) => {
    if (!editingCategoryName.trim()) return;
    const configDict = dictionaries.find(d => d.name === '__tag_creation_config__');
    if (!configDict) return;
    const catItem = configDict.items.find((i: any) => i.id === categoryId);
    if (!catItem) return;

    clearRefusal();
    const outcome = await putItem(categoryId, catItem, { code: catItem.code, nameRu: editingCategoryName.trim(), parentId: null });
    // Отказ: строка переименования остаётся открытой с набранным названием
    if (!settleWrite(outcome, catItem, ctx, how({ mode: 'edit', title: 'Правка не записана', fallback: 'Ошибка переименования категории' }))) return;
    addToast("Категория переименована", "success");
    setEditingCategoryId(null);
    fetchDictionaries();
  };

  // Deleting category
  const handleDeleteCategory = async (categoryId: string) => {
    if (!await openConfirm('Удалить категорию?', 'Вместе с категорией удалятся все её параметры. Действие необратимо.', { confirmLabel: 'Удалить категорию', tone: 'danger' })) return;
    const configDict = dictionaries.find(d => d.name === '__tag_creation_config__');
    if (!configDict) return;

    clearRefusal();
    const shown = configDict.items.find((i: any) => i.id === categoryId);
    if (!settleWrite(await deleteItem(categoryId, shown), shown, ctx, how({ mode: 'dialog', title: 'Категория не удалена', fallback: 'Ошибка удаления категории' }))) return;

    // Re-index remaining categories (только те, у кого порядок сменился)
    const remaining = (configDict.items || [])
      .filter((i: any) => !i.parentId && i.id !== categoryId)
      .sort((a: any, b: any) => a.code.localeCompare(b.code));

    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      const newCode = `${getOrderNumber(i)}_${c.id}`;
      if (c.code === newCode) continue;
      if (!settleWrite(await putItem(c.id, c, { code: newCode, nameRu: c.nameRu, parentId: null }), c, ctx, { ...how({ mode: 'edit', title: 'Порядок не изменён', fallback: 'Ошибка при изменении порядка' }), rereadAlways: true })) return;
    }

    addToast("Категория удалена", "success");
    if (activeCategoryTab === categoryId) {
      setActiveCategoryTab(null);
    }
    fetchDictionaries();
  };

  // Adding option
  const handleAddOption = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newOptionName.trim() || !activeCategoryTab) return;
    const configDict = dictionaries.find(d => d.name === '__tag_creation_config__');
    if (!configDict) return;

    clearRefusal();
    const outcome = await createItem(activeProject!.id, configDict.id, { code: newOptionName.trim(), nameRu: newOptionName.trim(), parentId: activeCategoryTab });
    if (!settleWrite(outcome, null, ctx, how({ mode: 'dialog', title: 'Параметр не добавлен', fallback: 'Ошибка добавления параметра' }))) return;

    addToast("Параметр добавлен", "success");
    setNewOptionName("");
    fetchDictionaries();
  };

  // Editing option
  const handleSaveOptionName = async (optionId: string) => {
    if (!editingOptionName.trim() || !activeCategoryTab) return;
    clearRefusal();
    const shown = (dictionaries.find(d => d.name === '__tag_creation_config__')?.items || []).find((i: any) => i.id === optionId);
    const outcome = await putItem(optionId, shown, { code: editingOptionName.trim(), nameRu: editingOptionName.trim(), parentId: activeCategoryTab });
    if (!settleWrite(outcome, shown, ctx, how({ mode: 'edit', title: 'Правка не записана', fallback: 'Ошибка редактирования параметра' }))) return;
    addToast("Параметр изменен", "success");
    setEditingOptionId(null);
    fetchDictionaries();
  };

  // Deleting option
  const handleDeleteOption = async (optionId: string) => {
    clearRefusal();
    const shown = (dictionaries.find(d => d.name === '__tag_creation_config__')?.items || []).find((i: any) => i.id === optionId);
    if (!settleWrite(await deleteItem(optionId, shown), shown, ctx, how({ mode: 'dialog', title: 'Параметр не удалён', fallback: 'Ошибка удаления параметра' }))) return;
    addToast("Параметр удален", "success");
    fetchDictionaries();
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
