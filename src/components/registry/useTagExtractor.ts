/**
 * Инструмент «Вытащить теги из текста»: вставленный текст документации,
 * найденные в нём обозначения и быстрая регистрация найденного.
 *
 * Состояние и обработчики вынесены из Registry.tsx как есть. Ничего из того,
 * что хук получает, он не пишет: тег заводится запросом, а список тегов
 * обновляет собственный `loadTags` Registry. Разбор текста — чистая функция
 * в lib/tagExtract.ts.
 *
 * В разметке этот инструмент сейчас не используется: хук перенесён вместе с
 * мёртвым кодом, чтобы не менять поведение при выносе.
 */
import React, { useState } from 'react';
import { findTagCandidates } from '../../lib/tagExtract';
import { type ParsedMetadata } from './tagMeta';

export interface TagExtractorDeps {
  activeProject: { id: string } | null;
  pan: { x: number; y: number };
  zoom: number;
  findFreePosition: (baseX: number, baseY: number) => { x: number; y: number };
  checkTagExists: (identifier: string) => boolean;
  loadTags: () => Promise<void>;
}

export interface ExtractedTag {
  identifier: string;
  exists: boolean;
}

export interface TagExtractor {
  pastedDocText: string;
  setPastedDocText: React.Dispatch<React.SetStateAction<string>>;
  extractedTags: ExtractedTag[];
  handleExtractTagsText: () => void;
  handleQuickRegisterExtracted: (identifier: string) => Promise<void>;
}

export function useTagExtractor({
  activeProject, pan, zoom, findFreePosition, checkTagExists, loadTags,
}: TagExtractorDeps): TagExtractor {
  // Text Extractor Tool State
  const [pastedDocText, setPastedDocText] = useState('');
  const [extractedTags, setExtractedTags] = useState<ExtractedTag[]>([]);

  // Extract tags from raw documentation text
  const handleExtractTagsText = () => {
    if (!pastedDocText) {
      setExtractedTags([]);
      return;
    }

    const uniqueMatches = findTagCandidates(pastedDocText);

    const evaluated = uniqueMatches.map((identifier: string) => ({
      identifier,
      exists: checkTagExists(identifier)
    }));

    setExtractedTags(evaluated);
  };

  // Fast register extracted tag from text tool
  const handleQuickRegisterExtracted = async (identifier: string) => {
    if (!activeProject || checkTagExists(identifier)) return;
    try {
      const { x: dropX, y: dropY } = findFreePosition((300 - pan.x) / zoom, (250 - pan.y) / zoom);

      const initialMeta: ParsedMetadata = {
        x: dropX,
        y: dropY,
        connections: [],
        descriptions: [
          { id: 'ext1', text: 'Зарегистрирован из текста', comment: 'Быстрый импорт через текстовый инспектор.', status: 'info' }
        ]
      };

      const res = await fetch(`/api/projects/${activeProject.id}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier,
          department: 'Технологический отдел',
          fluid: 'Автодетект',
          wbs: 'WBS-EXTRACTED',
          metadata: JSON.stringify(initialMeta)
        })
      });

      if (res.ok) {
        await loadTags();
        // Update live extractor checklist
        setExtractedTags(prev => prev.map(t => t.identifier === identifier ? { ...t, exists: true } : t));
      }
    } catch (err) {
      console.error('Failed to quick register tag:', err);
    }
  };

  return { pastedDocText, setPastedDocText, extractedTags, handleExtractTagsText, handleQuickRegisterExtracted };
}
