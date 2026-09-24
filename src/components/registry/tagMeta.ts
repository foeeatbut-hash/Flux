import { CheckCircle2, AlertTriangle, XCircle, Info, HelpCircle } from 'lucide-react';
/**
 * Метаданные тега: разбор поля metadata и общий статус по описаниям.
 *
 * Вынесено из экрана Тегов: этими функциями пользуются и экран, и панель
 * поиска, а экран упирался в потолок размера файла.
 */
export interface DescriptionItem {
  id: string;
  text: string;
  comment: string;
  status: 'actual' | 'warning' | 'critical' | 'info' | 'draft';
  createdBy?: string;
  createdAt?: string;
  updatedBy?: string;
  updatedAt?: string;
}

export interface ParsedMetadata {
  x: number;
  y: number;
  /** Координат в базе не было — позицию назначает сетка при загрузке */
  _noPos?: boolean;
  mainName?: string;
  parentId?: string;
  connections: string[]; // List of tag IDs this tag has peer-connections with
  descriptions: DescriptionItem[];
  dynamicFields?: Record<string, string>;
  createdBy?: string;
  createdAt?: string;
  updatedBy?: string;
  updatedAt?: string;
  tagSegments?: string[];
  markSegments?: string[];
}

// Чистые функции уровня модуля: не зависят от состояния компонента,
// используются и главным экраном, и выделенным компонентом поиска
export function parseTagMetadata(tag: any): ParsedMetadata {
  if (!tag) {
    return {
      x: Math.floor(Math.random() * 550 + 80),
      y: Math.floor(Math.random() * 320 + 80),
      connections: [],
      descriptions: []
    };
  }
  if (tag.parsedMetadata) {
    return tag.parsedMetadata;
  }
  try {
    if (tag.metadata) {
      const parsed = typeof tag.metadata === 'string' ? JSON.parse(tag.metadata) : tag.metadata;
      const res: ParsedMetadata = {
        ...parsed,
        // Пометка «координат в базе нет»: раскладку такому тегу назначает
        // сетка при загрузке реестра. Без пометки пришлось бы разбирать
        // JSON второй раз — на двух тысячах тегов это заметно.
        _noPos: parsed.x === undefined || parsed.y === undefined,
        x: parsed.x !== undefined ? parsed.x : Math.floor(Math.random() * 500 + 100),
        y: parsed.y !== undefined ? parsed.y : Math.floor(Math.random() * 300 + 100),
        parentId: parsed.parentId,
        connections: Array.isArray(parsed.connections) ? parsed.connections : [],
        descriptions: Array.isArray(parsed.descriptions) ? parsed.descriptions : []
      };
      tag.parsedMetadata = res;
      return res;
    }
  } catch (e) {
    console.error('Error parsing tag metadata:', e);
  }
  const fallback: ParsedMetadata = {
    _noPos: true,
    x: Math.floor(Math.random() * 550 + 80),
    y: Math.floor(Math.random() * 320 + 80),
    connections: [],
    descriptions: []
  };
  tag.parsedMetadata = fallback;
  return fallback;
}

export function getTagOverallStatus(tag: any): 'actual' | 'warning' | 'critical' | 'info' | 'draft' {
  const meta = parseTagMetadata(tag);
  if (!meta.descriptions || meta.descriptions.length === 0) {
    return 'draft';
  }
  if (meta.descriptions.some(d => d.status === 'critical')) return 'critical';
  if (meta.descriptions.some(d => d.status === 'warning')) return 'warning';
  if (meta.descriptions.some(d => d.status === 'info')) return 'info';
  if (meta.descriptions.some(d => d.status === 'actual')) return 'actual';
  return 'draft';
}

export const statusConfig = {
  actual: { bg: 'bg-emerald-500/10 dark:bg-emerald-500/20', text: 'text-emerald-500 dark:text-emerald-400', border: 'border-emerald-500/20', icon: CheckCircle2, label: 'Актуально' },
  warning: { bg: 'bg-amber-500/10 dark:bg-amber-500/20', text: 'text-amber-500 dark:text-amber-400', border: 'border-amber-500/20', icon: AlertTriangle, label: 'Проверить' },
  critical: { bg: 'bg-rose-500/10 dark:bg-rose-500/20', text: 'text-rose-500 dark:text-rose-400', border: 'border-rose-500/20', icon: XCircle, label: 'Критично' },
  info: { bg: 'bg-sky-500/10 dark:bg-sky-500/20', text: 'text-sky-500 dark:text-sky-400', border: 'border-sky-500/20', icon: Info, label: 'В работе' },
  draft: { bg: 'bg-slate-500/10 dark:bg-slate-500/20', text: 'text-slate-500 dark:text-slate-400', border: 'border-slate-500/20', icon: HelpCircle, label: 'Устарело' }
};

