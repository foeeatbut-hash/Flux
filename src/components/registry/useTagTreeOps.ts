/**
 * Операции над деревом тегов: удаление тега вместе со связями, сборка дерева для
 * вкладки «Дерево связей» и цепочка предков тега.
 *
 * Вынесено из Registry.tsx как есть. Собственного состояния у хука нет: всё,
 * что он читает или пишет, живёт у Registry (список тегов, выделение, открытая
 * карточка, запись метаданных) и приходит параметрами. Вызывается до сборщика
 * по сегментам, которому нужна `getParentTraceLineage`.
 */
import React from 'react';
import { useModalStore } from '../../store/modalStore';
import { parseTagMetadata, type ParsedMetadata } from './tagMeta';
import { useToastStore } from '../../store/toastStore';
import { deleteGoneText } from '../../lib/refusalTexts';
import { deleteTagRequest } from './tagWrite';
import { refusalOf, needsReread, type TagRefusal } from './tagRefusal';
import type { TagNames } from './changeRules';

// Диалоги программы вместо системных окон Windows
const { openConfirm } = useModalStore.getState();

type SetState<T> = React.Dispatch<React.SetStateAction<T>>;

export interface TagTreeOpsDeps {
  tags: any[];
  searchQuery: string;
  saveTagMetadata: (tagId: string, metadata: ParsedMetadata) => Promise<boolean | void>;
  setEditingTag: SetState<any | null>;
  setSelectedTagIds: SetState<Set<string>>;
  loadTags: () => Promise<void>;
  /** Имена для перечня «было → стало» и окно отказа (useTagRefusal) */
  names: () => TagNames;
  showRefusal: (title: string, refusal: TagRefusal) => void;
}

export interface TagTreeOps {
  handleDeleteTag: (tagId: string) => Promise<void>;
  /** Корни дерева с вложенными `children` и разобранными `meta` */
  buildTree: () => any[];
  getParentTraceLineage: (tagId: string) => string;
}

export function useTagTreeOps({
  tags, searchQuery, saveTagMetadata, setEditingTag, setSelectedTagIds, loadTags, names, showRefusal,
}: TagTreeOpsDeps): TagTreeOps {
  // Delete Node tag completely
  const handleDeleteTag = async (tagId: string) => {
    if (!await openConfirm('Удалить тег?', 'Тег и все его связи с другим оборудованием будут удалены. Действие необратимо.', { confirmLabel: 'Удалить тег', tone: 'danger' })) return;
    try {
      // Сначала удаление: связи соседей чистятся только у удалённого тега, иначе отказ оставил бы тег без связей
      const tag = tags.find((t) => t.id === tagId) || { id: tagId };
      const outcome = await deleteTagRequest(tag);
      if (outcome.kind !== 'ok') {
        // Изменили / открыт у коллеги / уже удалён / сбой: человек видит причину, ничего не удалено
        showRefusal('Тег не удалён', refusalOf(outcome, tag, names(), 'Не удалось удалить тег') as TagRefusal);
        if (needsReread(outcome)) loadTags();
        return;
      }
      // Повторное удаление сервер принимает (200): говорим словами словаря, а не молчим
      if (outcome.data?.alreadyGone) useToastStore.getState().addToast(deleteGoneText('tag'), 'info');
      for (const otherTag of tags) {
        if (otherTag.id === tagId) continue;
        const otherMeta = parseTagMetadata(otherTag);
        let updated = false;
        if (otherMeta.connections.includes(tagId)) {
          otherMeta.connections = otherMeta.connections.filter(id => id !== tagId);
          updated = true;
        }
        if (otherMeta.parentId === tagId) {
          otherMeta.parentId = undefined;
          updated = true;
        }
        if (updated) {
          await saveTagMetadata(otherTag.id, otherMeta);
        }
      }

      setEditingTag(null);
      // Убираем удалённый тег из выделения сразу, не дожидаясь перезагрузки
      setSelectedTagIds(prev => {
        if (!prev.has(tagId)) return prev;
        const next = new Set(prev);
        next.delete(tagId);
        return next;
      });
      loadTags();
    } catch (err) {
      console.error('Failed to delete tag:', err);
      useToastStore.getState().addToast('Не удалось удалить тег', 'error');
    }
  };

  // Build tree logic for dependencies view
  const buildTree = () => {
    const tagMap: { [id: string]: any } = {};
    const rootNodes: any[] = [];

    const matchingTags = tags.filter(t => 
      t.identifier.toLowerCase().includes(searchQuery.toLowerCase()) || 
      (t.department && t.department.toLowerCase().includes(searchQuery.toLowerCase()))
    );

    matchingTags.forEach(t => {
      const meta = parseTagMetadata(t);
      tagMap[t.id] = {
        ...t,
        meta,
        children: []
      };
    });

    matchingTags.forEach(t => {
      const node = tagMap[t.id];
      const pId = node.meta.parentId;
      if (pId && tagMap[pId]) {
        tagMap[pId].children.push(node);
      } else {
        rootNodes.push(node);
      }
    });

    return rootNodes;
  };

  // Calculate full lineage chain of tag (from parent down to child list)
  const getParentTraceLineage = (tagId: string): string => {
    const chainList: string[] = [];
    let currentId: string | undefined = tagId;
    const visited = new Set<string>();

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const tag = tags.find(t => t.id === currentId);
      if (tag) {
        chainList.unshift(tag.identifier);
        const meta = parseTagMetadata(tag);
        currentId = meta.parentId;
      } else {
        break;
      }
    }
    return chainList.join(' ➔ ');
  };

  return { handleDeleteTag, buildTree, getParentTraceLineage };
}
