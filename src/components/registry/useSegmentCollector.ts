/**
 * Сборщик по сегментам («Подбор» в разделе «Теги»): отбор тегов по частям кода
 * и марки, выбор колонок и выгрузка подборки.
 *
 * Состояние и логика вынесены из Registry.tsx как есть. Хук вызывается в самом
 * Registry, а не во вкладке: вкладка монтируется заново при каждой смене, и её
 * собственное состояние — введённые фильтры, отмеченные колонки — пропадало бы.
 * К тому же список подборки (`matchedTagsList`) читают и «Обмен», и счётчики.
 * Словари и разбиение на сегменты остаются у Registry: ими пользуются и другие
 * места, поэтому они приходят параметрами.
 */
import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToastStore } from '../../store/toastStore';
import { useModalStore } from '../../store/modalStore';
import { copyAsTable } from '../../lib/copyTable';
import { toXlsx, fileName } from '../../lib/exchange';
import { saveNewFile, editorHref } from '../../lib/officeFiles';
import { buildSegmentTable } from '../../lib/tagExchange';
import { parseTagMetadata } from './tagMeta';

// Диалоги программы вместо системных окон Windows
const { openAlert } = useModalStore.getState();

export interface SegmentCollectorDeps {
  tags: any[];
  dictionaries: any[];
  splitSegments: (str: string) => string[];
  splitTagIntoParts: (identifier: string) => string[];
  getParentTraceLineage: (tagId: string) => string;
}

export function useSegmentCollector({
  tags, dictionaries, splitSegments, splitTagIntoParts, getParentTraceLineage,
}: SegmentCollectorDeps) {
  const navigate = useNavigate();
  const { addToast } = useToastStore();

  // Independent segment filters for Tag (left) and Mark (right)
  const [activeTagFilters, setActiveTagFilters] = useState<{ [position: number]: string }>({});
  const [activeMarkFilters, setActiveMarkFilters] = useState<{ [position: number]: string }>({});
  

  const [tagDictBindings, setTagDictBindings] = useState<{ [position: number]: string }>({});
  const [markDictBindings, setMarkDictBindings] = useState<{ [position: number]: string }>({});

  const [tagHierarchySelections, setTagHierarchySelections] = useState<{ [position: number]: any }>({});
  const [markHierarchySelections, setMarkHierarchySelections] = useState<{ [position: number]: any }>({});

  const [selectedTagFilterCategoryIds, setSelectedTagFilterCategoryIds] = useState<{ [position: number]: string }>({});
  const [selectedMarkFilterCategoryIds, setSelectedMarkFilterCategoryIds] = useState<{ [position: number]: string }>({});

  const [addedTagSegmentsCount, setAddedTagSegmentsCount] = useState<number>(0);
  const [addedMarkSegmentsCount, setAddedMarkSegmentsCount] = useState<number>(0);


  const [excludeEmptyWBS, setExcludeEmptyWBS] = useState(false);
  const [onlyWithWarning, setOnlyWithWarning] = useState(false);
  const [exportColumns, setExportColumns] = useState({
    identifier: true,
    brand: true,
    brandParts: true,
    department: true,
    fluid: true,
    parts: true,
    chain: true,
    descriptions: true
  });

  // Extract all unique values at a specific segment/part index across all tags
  const getUniqueTagSegmentValuesForPos = (idx: number): string[] => {
    const values = new Set<string>();
    tags.forEach(t => {
      const parts = splitSegments(t.identifier);
      if (parts[idx]) {
        values.add(parts[idx]);
      }
    });
    return Array.from(values).sort();
  };

  const getUniqueMarkSegmentValuesForPos = (idx: number): string[] => {
    const values = new Set<string>();
    tags.forEach(t => {
      const parts = splitSegments(t.brand || '');
      if (parts[idx]) {
        values.add(parts[idx]);
      }
    });
    return Array.from(values).sort();
  };

  // Find max segment depth across all items
  const getMaximumTagSegmentLength = (): number => {
    let max = 0;
    tags.forEach(t => {
      const parts = splitSegments(t.identifier);
      if (parts.length > max) max = parts.length;
    });
    return max || 3;
  };

  const getMaximumMarkSegmentLength = (): number => {
    let max = 0;
    tags.forEach(t => {
      const parts = splitSegments(t.brand || '');
      if (parts.length > max) max = parts.length;
    });
    return max || 3;
  };

  // Safe mappings to keep existing references happy
  const getUniqueSegmentValuesForPos = getUniqueTagSegmentValuesForPos;
  const getMaximumSegmentLength = getMaximumTagSegmentLength;

  // Perform multi-segment query selection with independent Tag & Mark filter vectors
  const getSegmentMatchedTags = () => {
    return tags.filter(t => {
      const tagParts = splitSegments(t.identifier);
      const markParts = splitSegments(t.brand || '');
      
      // Left-side card filter values check only the data inside the Tag Segments column
      for (const posKey in activeTagFilters) {
        const filterVal = activeTagFilters[posKey];
        if (!filterVal || filterVal === '*') continue;
        
        const partVal = tagParts[Number(posKey)];
        if (!partVal || !partVal.toLowerCase().includes(filterVal.toLowerCase())) {
          return false;
        }
      }

      // Right-side card filter values check only data inside the Mark Segments column
      for (const posKey in activeMarkFilters) {
        const filterVal = activeMarkFilters[posKey];
        if (!filterVal || filterVal === '*') continue;
        
        const partVal = markParts[Number(posKey)];
        if (!partVal || !partVal.toLowerCase().includes(filterVal.toLowerCase())) {
          return false;
        }
      }

      // Supplementary filters
      if (excludeEmptyWBS && !t.wbs) return false;
      if (onlyWithWarning) {
        const meta = parseTagMetadata(t);
        const hasFlags = meta.descriptions.some(d => d.status === 'warning' || d.status === 'critical');
        if (!hasFlags) return false;
      }

      return true;
    });
  };

  const splitBrandIntoParts = (brandStr: string) => {
    if (!brandStr) return [];
    return brandStr.split(/[-/\.\s]+/);
  };

  const getMaximumBrandSegmentLength = () => {
    let max = 0;
    tags.forEach(t => {
      if (t.brand) {
        const len = splitBrandIntoParts(t.brand).length;
        if (len > max) max = len;
      }
    });
    return max;
  };

  const matchedTagsList = useMemo(() => getSegmentMatchedTags(), [tags, activeTagFilters, activeMarkFilters, excludeEmptyWBS, onlyWithWarning, dictionaries]);

  // Сборка таблицы подбора уехала в lib/tagExchange: раздел «Теги» — самый
  // большой файл программы, и держать в нём ещё и разбор сегментов значит
  // растить его дальше. Заодно эту сборку теперь можно проверить скриптом
  const buildExportTable = (): { headers: string[]; rows: string[][] } | null => {
    const matched = getSegmentMatchedTags();
    if (matched.length === 0) return null;
    return buildSegmentTable(matched, exportColumns, {
      segments: getMaximumSegmentLength(),
      brandSegments: getMaximumBrandSegmentLength(),
      splitTag: splitTagIntoParts,
      splitBrand: splitBrandIntoParts,
      lineage: getParentTraceLineage,
      meta: parseTagMetadata,
    });
  };

  // Раньше здесь был CSV под видом Excel: без форматов и с вопросом про
  // кодировку. Теперь — книга .xlsx в «Выгрузках», сразу открытая Таблицей
  const handleExportSelectedToExcel = async () => {
    const table = buildExportTable();
    if (!table) {
      void openAlert('Нечего выгружать', 'Под текущие фильтры не попала ни одна строка. Измените условия отбора и повторите.');
      return;
    }
    try {
      const made = await saveNewFile(await toXlsx(table.headers, table.rows, 'Подбор'), fileName('Теги — подбор', 'xlsx'), 'exports');
      addToast(`Выгружено в «Выгрузки»: ${made.name}`, 'success');
      navigate(editorHref(made));
    } catch (e: any) {
      addToast(`Не удалось выгрузить: ${e?.message || e}`, 'error');
    }
  };

  /** Та же подборка — сразу в буфер, чтобы вставить в письмо или протокол */
  const handleCopySelectedAsTable = async () => {
    const table = buildExportTable();
    if (!table) {
      void openAlert('Нечего копировать', 'Под текущие фильтры не попала ни одна строка. Измените условия отбора и повторите.');
      return;
    }
    const objects = table.rows.map(r => Object.fromEntries(table.headers.map((h, i) => [h, r[i] ?? ''])));
    const ok = await copyAsTable(objects, table.headers);
    addToast(
      ok ? `Скопировано строк: ${objects.length} — вставьте в Ворд или Эксель` : 'Не удалось скопировать',
      ok ? 'success' : 'error',
    );
  };

  return {
    getMaximumTagSegmentLength,
    getMaximumMarkSegmentLength,
    addedTagSegmentsCount,
    setAddedTagSegmentsCount,
    addedMarkSegmentsCount,
    setAddedMarkSegmentsCount,
    getUniqueTagSegmentValuesForPos,
    getUniqueMarkSegmentValuesForPos,
    activeTagFilters,
    setActiveTagFilters,
    activeMarkFilters,
    setActiveMarkFilters,
    tagDictBindings,
    setTagDictBindings,
    markDictBindings,
    setMarkDictBindings,
    tagHierarchySelections,
    setTagHierarchySelections,
    markHierarchySelections,
    setMarkHierarchySelections,
    selectedTagFilterCategoryIds,
    setSelectedTagFilterCategoryIds,
    selectedMarkFilterCategoryIds,
    setSelectedMarkFilterCategoryIds,
    excludeEmptyWBS,
    setExcludeEmptyWBS,
    onlyWithWarning,
    setOnlyWithWarning,
    exportColumns,
    setExportColumns,
    handleCopySelectedAsTable,
    handleExportSelectedToExcel,
    matchedTagsList,
  };
}

export type SegmentCollector = ReturnType<typeof useSegmentCollector>;
