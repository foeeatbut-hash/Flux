/**
 * Что делает экран «Реестр» с отказом записи тега: в открытой карточке показывает на месте,
 * иначе — окном; имена для перечня берёт из того, что у экрана загружено.
 *
 * Состояние отказа карточки живёт здесь, а не в `TagCardModal`: пишет Registry (сохранение
 * идёт из его обработчиков), показывает карточка. Закрытие карточки или переход к другому тегу
 * снимает отказ: он относился к тому тегу, который был открыт.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useToastStore } from '../../store/toastStore';
import { DEFAULT_STAGES } from '../../lib/procurementStages';
import type { TagNames } from './changeRules';
import type { TagRefusal } from './tagRefusal';
import { useTagRefusalDialog } from './TagRefusalView';
import type { TagWriteDeps } from './tagWrite';

export interface TagRefusalState {
  writeDeps: Pick<TagWriteDeps, 'onRefusal' | 'names' | 'reload'>;
  names: () => TagNames;
  cardRefusal: TagRefusal | null;
  showRefusal: (title: string, refusal: TagRefusal) => void;
  element: ReactNode;
}

export function useTagRefusal({ tags, dictionaries, editingTagId, loadTags }: {
  tags: any[]; dictionaries: any[]; editingTagId: string | null; loadTags: () => void | Promise<void>;
}): TagRefusalState {
  const { addToast } = useToastStore();
  const dialog = useTagRefusalDialog((text, kind) => addToast(text, kind));
  const [cardRefusal, setCardRefusal] = useState<TagRefusal | null>(null);
  // Обработчик, замкнутый в запросе, видит устаревший editingTagId: актуальное — через ссылку
  const openId = useRef(editingTagId);
  openId.current = editingTagId;
  useEffect(() => { setCardRefusal(null); }, [editingTagId]);

  const namesRef = useRef<TagNames>({});
  namesRef.current = {
    tag: (id) => tags.find((t) => t.id === id)?.identifier,
    field: (key) => {
      const cfg = dictionaries.find((d) => d.name === '__tag_creation_config__');
      const cat = (cfg?.items || []).find((i: any) => !i.parentId && (i.id === key || i.nameRu === key));
      return cat?.nameRu;
    },
    stage: (id) => DEFAULT_STAGES.find((s) => s.id === id)?.label,
  };

  /** Отказ записи: в карточке этого тега — на месте, иначе окном */
  const onRefusal = (refusal: TagRefusal, tag: any) => {
    if (openId.current && openId.current === tag?.id) setCardRefusal(refusal);
    else dialog.show('Правка не записана', refusal);
  };
  const writeDeps = { onRefusal, names: () => namesRef.current, reload: () => { void loadTags(); } };
  return { writeDeps, names: () => namesRef.current, cardRefusal, showRefusal: dialog.show, element: dialog.element };
}
