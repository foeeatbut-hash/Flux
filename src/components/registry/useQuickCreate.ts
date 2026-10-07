/**
 * Строка быстрого создания тега («Теги»): поля ввода, проверка кода, подсказки
 * существующих тегов и отправка нового тега на сервер.
 *
 * Состояние и логика вынесены из Registry.tsx как есть. Два куска состояния
 * остались у Registry и приходят параметрами: `dynamicCategorySelections` его
 * пишет загрузка словарей (раскладывает значения по умолчанию), а
 * `showAdvancedCreation` включает меню правой кнопки по холсту. Хук вызывается
 * после загрузки тегов и доски, поэтому их собственный `loadTags` и поиск
 * свободного места тоже приходят параметрами, а не создаются здесь заново.
 */
import React, { useState, useMemo } from 'react';
import { useToastStore } from '../../store/toastStore';
import { useModalStore } from '../../store/modalStore';
import { type Point } from '../../lib/tagLayout';
import { parseTagMetadata, type ParsedMetadata } from './tagMeta';

// Диалоги программы вместо системных окон Windows
const { openAlert } = useModalStore.getState();

type SetState<T> = React.Dispatch<React.SetStateAction<T>>;
export type Actuality = 'actual' | 'warning' | 'critical' | 'info' | 'draft';

export interface QuickCreateDeps {
  tags: any[];
  activeProject: { id: string } | null;
  user: { name?: string; login?: string } | null;
  /** Справочники проекта: из них берутся поля «Доп» (`__tag_creation_config__`) */
  dictionaries: any[];
  /** Сдвиг и масштаб холста: от них зависит, где появится новая карточка */
  pan: { x: number; y: number };
  zoom: number;
  findFreePosition: (baseX: number, baseY: number) => { x: number; y: number };
  /** Точка, куда нажали в меню правой кнопки; после создания сбрасывается */
  newTagSpotRef: { current: Point | null };
  splitSegments: (str: string) => string[];
  checkTagExists: (identifier: string) => boolean;
  loadTags: () => Promise<void>;
  /** Состояние остаётся у Registry: его пишет и загрузка словарей */
  dynamicCategorySelections: Record<string, string>;
  setDynamicCategorySelections: SetState<Record<string, string>>;
}

export interface QuickCreate {
  newTagIdentifier: string;
  setNewTagIdentifier: SetState<string>;
  newTagMainName: string;
  setNewTagMainName: SetState<string>;
  setNewTagDepartment: SetState<string>;
  setNewTagFluid: SetState<string>;
  newTagActuality: Actuality;
  setNewTagActuality: SetState<Actuality>;
  newTagBrand: string;
  setNewTagBrand: SetState<string>;
  isIdentifierUnique: boolean;
  matchingSuggestions: any[];
  handleDynamicCategoryChange: (catId: string, val: string) => void;
  handleTagIdentifierChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleCreateTag: (e: React.FormEvent) => Promise<void>;
}

export function useQuickCreate({
  tags, activeProject, user, dictionaries, pan, zoom, findFreePosition, newTagSpotRef,
  splitSegments, checkTagExists, loadTags, dynamicCategorySelections, setDynamicCategorySelections,
}: QuickCreateDeps): QuickCreate {
  const { addToast } = useToastStore();

  // Quick manually create tag
  const [newTagIdentifier, setNewTagIdentifier] = useState('');
  const [newTagMainName, setNewTagMainName] = useState('');
  const [newTagDepartment, setNewTagDepartment] = useState('Отдел КИПиА');
  const [newTagFluid, setNewTagFluid] = useState('Воздух');
  const [newTagActuality, setNewTagActuality] = useState<'actual' | 'warning' | 'critical' | 'info' | 'draft'>('info');

  // Brand (Марка) Creation & Editing States
  const [newTagBrand, setNewTagBrand] = useState('');
  const [newTagMarkingSelections, setNewTagMarkingSelections] = useState<Record<string, string>>({});
  const [newTagMarkingSeparator, setNewTagMarkingSeparator] = useState('-');

  const handleDynamicCategoryChange = (catId: string, val: string) => {
    setDynamicCategorySelections(prev => ({
      ...prev,
      [catId]: val
    }));
  };

  // Cyrillic layout warning and char blocker
  const handleTagIdentifierChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (/[а-яА-ЯёЁ]/.test(val)) {
      addToast("Смените раскладку! Ввод тегов разрешен только на латинице.", "error");
      return;
    }
    setNewTagIdentifier(val);
  };

  const matchingSuggestions = useMemo(() => {
    if (!newTagIdentifier) return [];
    const searchVal = newTagIdentifier.trim().toLowerCase();
    const prefix = tags.filter(t => t.identifier.toLowerCase().startsWith(searchVal));
    const sub = tags.filter(t => !t.identifier.toLowerCase().startsWith(searchVal) && t.identifier.toLowerCase().includes(searchVal));
    return [...prefix, ...sub].slice(0, 8);
  }, [newTagIdentifier, tags]);

  // Manual fast tag create with verification
  const handleCreateTag = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTagIdentifier || !newTagBrand.trim() || !activeProject) {
      addToast("Ошибка: Заполните обязательные поля Tag и Mark!", "error");
      return;
    }

    if (checkTagExists(newTagIdentifier)) {
      void openAlert('Такой тег уже есть', `Тег «${newTagIdentifier}» уже заведён в этом проекте. Укажите другой код.`);
      return;
    }

    try {
      // Новая карточка появляется на свободном месте — не перекрывая существующие.
      // Если тег заводят через меню правой кнопки, «свободное место» ищется от
      // той точки, куда нажали, а не от центра экрана
      const spot = newTagSpotRef.current || { x: (300 - pan.x) / zoom, y: (200 - pan.y) / zoom };
      newTagSpotRef.current = null;
      const { x: dropX, y: dropY } = findFreePosition(spot.x, spot.y);

      const configDict = dictionaries.find(d => d.name === '__tag_creation_config__');
      const cats = configDict
        ? (configDict.items || [])
            .filter((i: any) => !i.parentId)
            .sort((a: any, b: any) => a.code.localeCompare(b.code))
        : [];

      let finalDepartment = newTagDepartment;
      let finalFluid = newTagFluid || 'Воздух';
      const finalDynamicFields: Record<string, string> = {};

      cats.forEach((cat: any) => {
        const value = dynamicCategorySelections[cat.id] || '';
        finalDynamicFields[cat.nameRu] = value;

        const lowName = cat.nameRu.toLowerCase();
        const lowCode = cat.code.toLowerCase();
        if (lowCode.includes('dep') || lowName.includes('дисциплина') || lowName.includes('отдел')) {
          finalDepartment = value;
        } else if (lowCode.includes('fluid') || lowName.includes('среда') || lowName.includes('свойство') || lowName.includes('fluid')) {
          finalFluid = value;
        }
      });

      const initialMeta: ParsedMetadata = {
        x: dropX,
        y: dropY,
        connections: [],
        descriptions: [
          {
            id: 'desc-' + Math.random().toString(36).substr(2, 9),
            text: 'Первичный статус',
            comment: 'Установлено при создании тега',
            status: newTagActuality,
            createdBy: user?.name || user?.login || 'Пользователь',
            createdAt: new Date().toISOString()
          }
        ],
        mainName: newTagMainName.trim(),
        dynamicFields: finalDynamicFields,
        createdBy: user?.name || user?.login || 'Пользователь',
        createdAt: new Date().toISOString(),
        tagSegments: splitSegments(newTagIdentifier.trim()),
        markSegments: splitSegments(newTagBrand.trim())
      };

      const res = await fetch(`/api/projects/${activeProject.id}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: newTagIdentifier.trim(),
          department: finalDepartment,
          fluid: finalFluid,
          wbs: '',
          brand: newTagBrand.trim() || null,
          metadata: JSON.stringify(initialMeta)
        })
      });

      if (res.ok) {
        setNewTagIdentifier('');
        setNewTagMainName('');
        setNewTagBrand('');
        setNewTagMarkingSelections({});
        // reset to default status 'info' (В работе)
        setNewTagActuality('info');
        loadTags();
      }
    } catch (err) {
      console.error('Failed to create tag manually:', err);
    }
  };

  const isIdentifierUnique = !newTagIdentifier || !checkTagExists(newTagIdentifier);

  return {
    newTagIdentifier, setNewTagIdentifier,
    newTagMainName, setNewTagMainName,
    setNewTagDepartment, setNewTagFluid,
    newTagActuality, setNewTagActuality,
    newTagBrand, setNewTagBrand,
    isIdentifierUnique, matchingSuggestions,
    handleDynamicCategoryChange, handleTagIdentifierChange, handleCreateTag,
  };
}
