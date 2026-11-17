import { useState } from "react";
import { useStore } from "../../store/store";
import { useToastStore } from "../../store/toastStore";
import { getOrderNumber } from '../../lib/dictOrder';
import { useOpenRecords } from '../useOpenRecords';
import { putItem, deleteItem, createItem, settleWrite, type SettleOptions } from './dictWrite';
import { dictNamesOf } from './changeRules';
import type { DictCtx } from './types';

// Выбранная вкладка живёт в экране: её читает и ставит загрузка словарей
export interface MarkingDictCtx extends DictCtx {
  activeMarkingTab: string | null;
  setActiveMarkingTab: (id: string | null) => void;
}

export function useMarkingDict(ctx: MarkingDictCtx) {
  const { dictionaries, setDictionaries, fetchDictionaries, clearRefusal, activeMarkingTab, setActiveMarkingTab } = ctx;
  const activeProject = useStore((s) => s.activeProject);
  const { addToast } = useToastStore();
  // Код категории здесь служебный («001_ab12»), человек видит название и место в списке
  const how = (o: Pick<SettleOptions, 'mode' | 'title' | 'fallback'>): SettleOptions => ({ ...o, names: dictNamesOf(dictionaries, true) });

  // Tag marking dynamic config states
  const [newMarkingCategoryName, setNewMarkingCategoryName] = useState("");
  const [editingMarkingCategoryId, setEditingMarkingCategoryId] = useState<string | null>(null);
  const [editingMarkingCategoryName, setEditingMarkingCategoryName] = useState("");

  const [newMarkingOptionName, setNewMarkingOptionName] = useState("");
  const [editingMarkingOptionId, setEditingMarkingOptionId] = useState<string | null>(null);
  const [editingMarkingOptionName, setEditingMarkingOptionName] = useState("");

  // Категория или параметр, который правят в строке, у коллег показан как открытый: удалить его нельзя
  useOpenRecords('dict-marking', [editingMarkingCategoryId, editingMarkingOptionId].filter(Boolean).map((id) => ({ model: 'DictionaryItem', id: id as string })));

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
    // Версии и перечень берутся у пунктов, какими их видел экран, — до того как коды сменятся на месте
    const shownA = { ...catA };
    const shownB = { ...catB };

    const codeA = `${getOrderNumber(otherIndex)}_${catA.id}`;
    const codeB = `${getOrderNumber(index)}_${catB.id}`;

    clearRefusal();
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

  const handleAddMarkingCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMarkingCategoryName.trim()) return;
    const configDict = dictionaries.find(d => d.name === '__tag_marking_config__');
    if (!configDict) return;

    const items = configDict.items || [];
    const categoriesList = items.filter((i: any) => !i.parentId);
    const orderCode = `${getOrderNumber(categoriesList.length)}_${Math.random().toString(36).substr(2, 4)}`;

    clearRefusal();
    const outcome = await createItem(activeProject!.id, configDict.id, { code: orderCode, nameRu: newMarkingCategoryName.trim(), parentId: null });
    if (!settleWrite(outcome, null, ctx, how({ mode: 'dialog', title: 'Категория не добавлена', fallback: 'Ошибка добавления категории' }))) return;

    addToast("Категория добавлена", "success");
    setNewMarkingCategoryName("");
    fetchDictionaries();
    if (outcome.kind === 'ok') setActiveMarkingTab(outcome.data.item.id);
  };

  const handleRenameMarkingCategory = async (categoryId: string) => {
    if (!editingMarkingCategoryName.trim()) return;
    const configDict = dictionaries.find(d => d.name === '__tag_marking_config__');
    if (!configDict) return;
    const catItem = configDict.items.find((i: any) => i.id === categoryId);
    if (!catItem) return;

    clearRefusal();
    const outcome = await putItem(categoryId, catItem, { code: catItem.code, nameRu: editingMarkingCategoryName.trim(), parentId: null });
    // Отказ: строка переименования остаётся открытой с набранным названием
    if (!settleWrite(outcome, catItem, ctx, how({ mode: 'edit', title: 'Правка не записана', fallback: 'Ошибка переименования категории' }))) return;
    addToast("Категория переименована", "success");
    setEditingMarkingCategoryId(null);
    fetchDictionaries();
  };

  const handleDeleteMarkingCategory = async (categoryId: string) => {
    if (!window.confirm("Вы уверены, что хотите удалить эту категорию вместе с её параметрами?")) return;
    const configDict = dictionaries.find(d => d.name === '__tag_marking_config__');
    if (!configDict) return;

    clearRefusal();
    const shown = configDict.items.find((i: any) => i.id === categoryId);
    if (!settleWrite(await deleteItem(categoryId, shown), shown, ctx, how({ mode: 'dialog', title: 'Категория не удалена', fallback: 'Ошибка удаления категории' }))) return;

    // Порядок оставшихся категорий пересчитывается (пишем только тех, у кого он сменился)
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
    if (activeMarkingTab === categoryId) {
      setActiveMarkingTab(null);
    }
    fetchDictionaries();
  };

  const handleAddMarkingOption = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMarkingOptionName.trim() || !activeMarkingTab) return;
    const configDict = dictionaries.find(d => d.name === '__tag_marking_config__');
    if (!configDict) return;

    clearRefusal();
    const outcome = await createItem(activeProject!.id, configDict.id, { code: newMarkingOptionName.trim(), nameRu: newMarkingOptionName.trim(), parentId: activeMarkingTab });
    if (!settleWrite(outcome, null, ctx, how({ mode: 'dialog', title: 'Параметр не добавлен', fallback: 'Ошибка добавления параметра' }))) return;

    addToast("Параметр добавлен", "success");
    setNewMarkingOptionName("");
    fetchDictionaries();
  };

  const handleSaveMarkingOptionName = async (optionId: string) => {
    if (!editingMarkingOptionName.trim() || !activeMarkingTab) return;
    clearRefusal();
    const shown = (dictionaries.find(d => d.name === '__tag_marking_config__')?.items || []).find((i: any) => i.id === optionId);
    const outcome = await putItem(optionId, shown, { code: editingMarkingOptionName.trim(), nameRu: editingMarkingOptionName.trim(), parentId: activeMarkingTab });
    if (!settleWrite(outcome, shown, ctx, how({ mode: 'edit', title: 'Правка не записана', fallback: 'Ошибка редактирования параметра' }))) return;
    addToast("Параметр изменен", "success");
    setEditingMarkingOptionId(null);
    fetchDictionaries();
  };

  const handleDeleteMarkingOption = async (optionId: string) => {
    clearRefusal();
    const shown = (dictionaries.find(d => d.name === '__tag_marking_config__')?.items || []).find((i: any) => i.id === optionId);
    if (!settleWrite(await deleteItem(optionId, shown), shown, ctx, how({ mode: 'dialog', title: 'Параметр не удалён', fallback: 'Ошибка удаления параметра' }))) return;
    addToast("Параметр удален", "success");
    fetchDictionaries();
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
