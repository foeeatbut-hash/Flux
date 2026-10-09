/**
 * Загрузка тегов раздела «Теги» и подсветка после захвата с экрана.
 *
 * Вынесено из Registry.tsx как есть, вместе с порядком эффектов: хук вызывается
 * на том месте, где раньше стояли подписки на `flux:tags-changed` и
 * `flux:capture-applied`, то есть после эффекта «загрузить при смене проекта».
 * Сам этот эффект остался у Registry: он зовёт заодно и загрузку словарей.
 *
 * Список тегов, признак загрузки и выделение остаются у Registry — их читают и
 * пишут доска, карточка и меню, поэтому в хук приходят их записывающие
 * функции. `fitToTags` объявлена в Registry ниже по тексту, а const до своей
 * строки не видна, поэтому передаётся обёрткой, которая обратится к ней уже
 * в момент вызова.
 */
import React, { useState, useEffect, useRef } from 'react';
import { dataService } from '../../services/dataService';
import { useToastStore } from '../../store/toastStore';
import { repairTagTree } from '../../lib/tagTree';
import { parseTagMetadata } from './tagMeta';

type SetState<T> = React.Dispatch<React.SetStateAction<T>>;

/** Что принёс захват: идентификаторы созданных, дополненных и совпавших тегов */
export interface CaptureResult { created: string[]; filled: string[]; duplicated: string[] }

export interface RegistryTagsDeps {
  activeProject: { id: string } | null;
  activeTab: string;
  setTags: SetState<any[]>;
  setIsLoading: SetState<boolean>;
  setSelectedTagIds: SetState<Set<string>>;
  fitToTags: (list: any[]) => void;
}

export interface RegistryTags {
  /** Последний прочитанный список: состояние в замыкании уже может быть устаревшим */
  loadedTagsRef: { current: any[] };
  loadTags: () => Promise<void>;
  lastCapture: CaptureResult | null;
  setLastCapture: SetState<CaptureResult | null>;
  captureUntilRef: { current: number };
  flashCapture: (data: CaptureResult) => void;
}

export function useRegistryTags({
  activeProject, activeTab, setTags, setIsLoading, setSelectedTagIds, fitToTags,
}: RegistryTagsDeps): RegistryTags {
  const { addToast } = useToastStore();

  // Load all tags
  // Последний прочитанный список — состояние в замыкании эффекта уже устарело,
  // а подсветке после захвата нужны свежие карточки прямо сейчас
  const loadedTagsRef = useRef<any[]>([]);

  const loadTags = async () => {
    if (!activeProject) return;
    setIsLoading(true);
    try {
      const data = await dataService.getTags(activeProject.id);
      const tagsList = data.tags || [];
      const tagsWithParsedMetadata = tagsList.map((t: any) => ({
        ...t,
        parsedMetadata: parseTagMetadata(t)
      }));
      /**
       * Выправить дерево, если его успели испортить.
       *
       * Прежняя строка «Родительский тег» писала выбранного родителя в
       * СОБСТВЕННЫЙ список детей тега: связь смотрела в обе стороны сразу, и
       * дерево читалось наизнанку — родитель оказывался ребёнком своего же
       * ребёнка. Строку убрали, но записи в базе остались, и сами они не
       * выпрямятся. Правки нужны редко: здоровое дерево не даёт ни одной.
       */
      const patches = repairTagTree(tagsWithParsedMetadata.map((t: any) => ({
        id: t.id,
        connections: t.parsedMetadata.connections || [],
        parentId: t.parsedMetadata.parentId,
      })));
      for (const patch of patches) {
        const t = tagsWithParsedMetadata.find((x: any) => x.id === patch.id);
        if (!t) continue;
        t.parsedMetadata = { ...t.parsedMetadata, connections: patch.connections, parentId: patch.parentId };
        t.metadata = JSON.stringify(t.parsedMetadata);
        void fetch(`/api/tags/${patch.id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          // Только связи: сервер сливает ключи, и снимок остального чужих правок не затрёт; null снимает родителя
          body: JSON.stringify({ metadata: { connections: patch.connections, parentId: patch.parentId ?? null } }),
        }).catch(() => { /* не записалось — выправим на следующей загрузке */ });
      }
      if (patches.length) {
        addToast(`Связи тегов выправлены: ${patches.length}`, 'info');
      }
      setTags(tagsWithParsedMetadata);
      loadedTagsRef.current = tagsWithParsedMetadata;
      // Выделение не должно ссылаться на удалённые теги (иначе «Выбрано: 2»
      // после удаления одного из выбранных и лишние рендеры)
      const liveIds = new Set(tagsList.map((t: any) => t.id));
      setSelectedTagIds(prev => {
        if (prev.size === 0) return prev;
        const next = new Set(Array.from(prev).filter(id => liveIds.has(id)));
        return next.size === prev.size ? prev : next;
      });
    } catch (err) {
      console.error('Failed to load tags:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const loadTagsRef = useRef(loadTags);
  loadTagsRef.current = loadTags;

  // Другие программы меняют теги через сервер; перечитываем список по общему
  // событию, чтобы новые теги и правки появлялись без повторного входа.
  useEffect(() => {
    const onLegacyTagsChanged = () => { void loadTagsRef.current(); };
    const onEntityChanged = (event: Event) => {
      if ((event as CustomEvent).detail?.kind === 'tag') void loadTagsRef.current();
    };
    window.addEventListener('flux:tags-changed', onLegacyTagsChanged);
    window.addEventListener('socket:entity:changed', onEntityChanged);
    return () => {
      window.removeEventListener('flux:tags-changed', onLegacyTagsChanged);
      window.removeEventListener('socket:entity:changed', onEntityChanged);
    };
  }, []);

  // ── Подсветка после захвата с экрана ────────────────────────────────────
  //
  // Вспышки мало: отвернулся — и всё, что добавилось, потерялось. Поэтому
  // кроме волны в шапке остаётся закрываемая плашка «последний захват».
  // И вспышка обязана переезжать за инженером: подсветку зажигаем в том виде,
  // который открыт сейчас, и перезажигаем при переключении вкладки.
  const [lastCapture, setLastCapture] = useState<
    { created: string[]; filled: string[]; duplicated: string[] } | null
  >(null);
  const captureUntilRef = useRef(0);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  const flashCapture = (data: { created: string[]; filled: string[]; duplicated: string[] }) => {
    const queue: { id: string; cls: string }[] = [
      ...data.created.map((id) => ({ id, cls: 'capture-pulse-new' })),
      ...data.filled.map((id) => ({ id, cls: 'capture-pulse-fill' })),
      ...data.duplicated.map((id) => ({ id, cls: 'capture-pulse-dup' })),
    ];
    queue.forEach(({ id, cls }, i) => {
      setTimeout(() => {
        // Один и тот же тег в разных видах живёт под своим идентификатором;
        // подсвечиваем тот элемент, который сейчас есть в разметке
        for (const domId of [`tag-card-${id}`, `tree-node-${id}`, `spec-row-${id}`]) {
          const el = document.getElementById(domId);
          if (!el) continue;
          el.classList.add(cls);
          setTimeout(() => el.classList.remove(cls), 3000);
        }
      }, i * 60);
    });
  };

  useEffect(() => {
    const onApplied = async (e: Event) => {
      const d = (e as CustomEvent).detail as
        { created: string[]; filled: string[]; duplicated: string[] };
      if (!d) return;
      const total = d.created.length + d.filled.length + d.duplicated.length;
      if (!total) return;
      setLastCapture(d);
      captureUntilRef.current = Date.now() + 3600 + total * 60;
      await loadTags();
      // Ждём отрисовку списка, иначе подсвечивать ещё нечего
      requestAnimationFrame(() => setTimeout(() => {
        const ids = [...d.created, ...d.filled];
        const cards = ids.map((id) => loadedTagsRef.current.find((t: any) => t.id === id)).filter(Boolean);
        // Наводим камеру только на холсте: в дереве и таблице она ни при чём
        if (cards.length && activeTabRef.current === 'board') fitToTags(cards as any[]);
        flashCapture(d);
      }, 60));
    };
    window.addEventListener('flux:capture-applied', onApplied as EventListener);
    return () => window.removeEventListener('flux:capture-applied', onApplied as EventListener);
  }, []);

  // Переключили вид, пока окно подсветки не истекло — зажигаем заново
  useEffect(() => {
    if (!lastCapture || Date.now() > captureUntilRef.current) return;
    const t = setTimeout(() => flashCapture(lastCapture), 140);
    return () => clearTimeout(t);
  }, [activeTab]);

  return { loadedTagsRef, loadTags, lastCapture, setLastCapture, captureUntilRef, flashCapture };
}
