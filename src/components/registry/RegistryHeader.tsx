/**
 * Шапка раздела «Теги»: название, число, вкладки, «Новый тег» и плашка
 * «последний захват».
 *
 * Вынесена из Registry.tsx как есть. Обработчик «показать» остаётся в
 * Registry: он двигает камеру холста и зажигает подсветку, а это его рефы.
 */
import React from 'react';
import { Network, FolderTree, List, FileSpreadsheet, Plus, X } from 'lucide-react';
import { SectionHead, Btn, IconBtn, Status } from '../ui';
import { countOf } from '../../lib/plural';

export type RegistryTab = 'board' | 'tree' | 'segments' | 'table' | 'exchange' | 'equipment';

/** Итог последнего захвата с экрана: какие теги созданы, дополнены и оказались дублями */
export interface CaptureResult {
  created: string[];
  filled: string[];
  duplicated: string[];
}

export interface RegistryHeaderProps {
  tagCount: number;
  activeTab: RegistryTab;
  setActiveTab: (tab: RegistryTab) => void;
  onNewTag: () => void;
  lastCapture: CaptureResult | null;
  onShowCapture: (capture: CaptureResult) => void;
  onDismissCapture: () => void;
}

export default function RegistryHeader({
  tagCount, activeTab, setActiveTab, onNewTag, lastCapture, onShowCapture, onDismissCapture,
}: RegistryHeaderProps) {
  // Шапка: название, число, вкладки в порядке работы, главное действие.
  // Было: значок в зелёном квадрате, «Реестр технологических тегов» и
  // вкладки ручным переключателем справа
  return (
    <SectionHead title="Теги" count={countOf(tagCount, 'тег')}
      actions={<Btn tone="primary" onClick={onNewTag} title="Новый тег: строка создания над списком"><Plus />Новый тег</Btn>}>
      <div className="fx-tabs min-w-0 overflow-x-auto [scrollbar-width:none]" role="tablist" aria-label="Вкладки Тегов">
        <button type="button" role="tab" aria-selected={activeTab === 'board'} onClick={() => setActiveTab('board')} title="Схема связей между тегами" className="fx-tab">
          <Network className="w-3.5 h-3.5" /><span className="hidden @[760px]:inline">Схема</span>
        </button>
        <button type="button" role="tab" aria-selected={activeTab === 'tree'} onClick={() => setActiveTab('tree')} title="Дерево связей" className="fx-tab">
          <FolderTree className="w-3.5 h-3.5" /><span className="hidden @[760px]:inline">Дерево связей</span>
        </button>
        <button type="button" role="tab" aria-selected={activeTab === 'segments'} onClick={() => setActiveTab('segments')} title="Подбор по сегментам кода" className="fx-tab">
          <List className="w-3.5 h-3.5" /><span className="hidden @[760px]:inline">Подбор</span>
        </button>
        <button type="button" role="tab" aria-selected={activeTab === 'table'} data-tour="tag-table-tab" onClick={() => setActiveTab('table')} title="Спецификация" className="fx-tab">
          <List className="w-3.5 h-3.5" /><span className="hidden @[760px]:inline">Спецификация</span>
        </button>
        {/* Обмен с внешним миром — последним: сначала работа, потом выгрузка */}
        <button type="button" role="tab" aria-selected={activeTab === 'exchange'} data-tour="tag-exchange-tab" onClick={() => setActiveTab('exchange')} title="Импорт тегов, выгрузка и захват с экрана" className="fx-tab">
          <FileSpreadsheet className="w-3.5 h-3.5" /><span className="hidden @[760px]:inline">Экспорт и импорт</span>
        </button>
      </div>
      {/* Что принёс последний захват. Вспышка гаснет за секунды, а это
          остаётся, пока инженер сам не закроет */}
      {lastCapture && (
        <span className="inline-flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">
          <Status tone="emerald">последний захват: {lastCapture.created.length + lastCapture.filled.length}</Status>
          <button type="button" className="fx-btn fx-btn-quiet fx-btn-sm"
            onClick={() => onShowCapture(lastCapture)}>показать</button>
          <IconBtn label="Убрать отметку захвата" onClick={onDismissCapture}><X /></IconBtn>
        </span>
      )}
    </SectionHead>
  );
}
