/**
 * Карточка доски: один тег на холсте схемы (компактная шапка, порты связи,
 * раскрытая часть со связями, комментариями и быстрым добавлением).
 *
 * Вынесена из Registry.tsx как есть. Состояние остаётся в Registry: его пишут
 * ещё и перетаскивание, меню правой кнопки, панель выделения и карточка тега,
 * а собственную копию здесь обработчики Registry не увидели бы. Поэтому
 * карточка получает значения и сеттеры пропсами и сама ничего не помнит.
 * Намеренно без React.memo: перерисовка карточек при каждом изменении
 * состояния экрана была и раньше, и замера, что мемоизация её не сломает
 * (рывки при перетаскивании), нет.
 */
import React from 'react';
import { Database, Link2, Info, X, Edit, Edit2, Trash2 } from 'lucide-react';
import CustomSelect from '../CustomSelect';
import {
  parseTagMetadata, getTagOverallStatus, statusConfig, actualitySelectOptions,
  type DescriptionItem, type ParsedMetadata,
} from './tagMeta';

const emojiOptions = [
  { value: 'actual', label: '🟢' },
  { value: 'warning', label: '🟡' },
  { value: 'critical', label: '🔴' },
  { value: 'info', label: '🔵' },
  { value: 'draft', label: '⚪' }
];

export interface PortHover {
  tagId: string;
  side: 'left' | 'right';
}

type SetState<T> = React.Dispatch<React.SetStateAction<T>>;

export interface BoardCardProps {
  tag: any;

  // Состояние экрана, которое карточка только читает
  tagsById: Record<string, any>;
  incomingByTagId: Record<string, string[]>;
  selectedTagIds: Set<string>;
  expandedCardIds: { [tagId: string]: boolean };
  linkMode: 'click' | 'drag';
  linkingFrom: string | null;
  /** Нужен только sourceId: «эту карточку сейчас тянут за порт» */
  activeConnectionDrag: { sourceId: string } | null;
  hoveredPort: PortHover | null;
  draggedTagId: string | null;
  /** Живые координаты при перетаскивании — в ref, а не в состоянии, чтобы не перерисовывать доску на каждый пиксель */
  cardPositionsRef: { current: Record<string, { x: number; y: number }> };
  /** Правая кнопка после панорамирования меню не открывает */
  panMovedRef: { current: boolean };

  // Выбор связи («родитель / ребёнок») и режим «Кликом»
  linkPicker: { tagId: string; search: string; dir: 'child' | 'parent' } | null;
  setLinkPicker: SetState<{ tagId: string; search: string; dir: 'child' | 'parent' } | null>;
  linkCandidates: (tagId: string, dir: 'child' | 'parent', search: string) => any[];
  setLinkingFrom: SetState<string | null>;
  setHoveredPort: SetState<PortHover | null>;

  // Выделение, раскрытие, меню, настройка
  setSelectedTagIds: SetState<Set<string>>;
  setExpandedCardIds: SetState<{ [tagId: string]: boolean }>;
  setCardMenu: SetState<{ x: number; y: number; tagId: string } | null>;
  setEditingTag: SetState<any | null>;

  // Правка комментария на месте
  editingDescId: string | null;
  setEditingDescId: SetState<string | null>;
  editDescForm: { text: string; comment: string; status: DescriptionItem['status'] };
  setEditDescForm: SetState<{ text: string; comment: string; status: DescriptionItem['status'] }>;

  // Быстрое добавление комментария: черновики по id тега
  quickDescText: { [tagId: string]: string };
  setQuickDescText: SetState<{ [tagId: string]: string }>;
  quickCommentText: { [tagId: string]: string };
  setQuickCommentText: SetState<{ [tagId: string]: string }>;
  quickStatus: { [tagId: string]: DescriptionItem['status'] };
  setQuickStatus: SetState<{ [tagId: string]: DescriptionItem['status'] }>;

  // Обработчики экрана
  isDuplicateTag: (t: any) => boolean;
  formatDateStr: (isoString?: string) => string;
  handleTagMouseDown: (e: React.MouseEvent, tagId: string, currentMeta: ParsedMetadata) => void;
  handlePortMouseDown: (e: React.MouseEvent, tagId: string, side: 'left' | 'right') => void;
  handleAddConnection: (parentId: string, childId: string) => Promise<void>;
  handleRemoveConnection: (sourceId: string, targetId: string) => Promise<void>;
  handleAddDescription: (tagId: string, text: string, comment: string, status?: DescriptionItem['status']) => Promise<void>;
  handleUpdateDescription: (tagId: string, descId: string, fields: Partial<DescriptionItem>) => Promise<void>;
  handleRemoveDescription: (tagId: string, descId: string) => Promise<void>;
  handleDeleteTag: (tagId: string) => Promise<void>;
}

export default function BoardCard({
  tag, tagsById, incomingByTagId, selectedTagIds, expandedCardIds, linkMode, linkingFrom,
  activeConnectionDrag, hoveredPort, draggedTagId, cardPositionsRef, panMovedRef,
  linkPicker, setLinkPicker, linkCandidates, setLinkingFrom, setHoveredPort,
  setSelectedTagIds, setExpandedCardIds, setCardMenu, setEditingTag,
  editingDescId, setEditingDescId, editDescForm, setEditDescForm,
  quickDescText, setQuickDescText, quickCommentText, setQuickCommentText, quickStatus, setQuickStatus,
  isDuplicateTag, formatDateStr, handleTagMouseDown, handlePortMouseDown,
  handleAddConnection, handleRemoveConnection, handleAddDescription, handleUpdateDescription,
  handleRemoveDescription, handleDeleteTag,
}: BoardCardProps) {
  const meta = parseTagMetadata(tag);
  const isSourceOfDrag = activeConnectionDrag?.sourceId === tag.id;
  const hoveredLeft = hoveredPort?.tagId === tag.id && hoveredPort.side === 'left';
  const hoveredRight = hoveredPort?.tagId === tag.id && hoveredPort.side === 'right';

  const isExpanded = !!expandedCardIds[tag.id];
  const overallStatus = getTagOverallStatus(tag);
  const statusVal = statusConfig[overallStatus] || statusConfig.draft;
  const dup = isDuplicateTag(tag);
  const isSelected = selectedTagIds.has(tag.id);

  return (
    <div
      id={`tag-card-${tag.id}`}
      data-share-focus={`tag:${tag.id}`}
      className={`absolute pointer-events-auto w-[310px] rounded-lg border text-left transition-shadow duration-200 select-none ${
        linkingFrom === tag.id
          ? 'ring-2 ring-sky-500 border-sky-500 shadow-xl z-40'
          : linkingFrom
            ? 'bg-white dark:bg-slate-950 border-sky-300/60 dark:border-sky-800/50 shadow-xs hover:ring-2 hover:ring-sky-400 cursor-crosshair z-10'
          // «Тащу эту» и «выбрана» раньше различались цветом:
          // зелёный против синего. Синего в палитре нет, а
          // выбранное во всей программе зелёное — поэтому оба
          // состояния теперь зелёные и разведены весом: у
          // перетаскиваемой карточки кольцо темнее и тень выше.
          : isSourceOfDrag
          ? 'ring-2 ring-emerald-700 border-emerald-700 shadow-xl z-30'
          : isSelected
            ? `bg-white dark:bg-slate-950 ring-2 ring-emerald-500 border-emerald-400 dark:border-emerald-600 shadow-lg text-slate-900 dark:text-slate-100 ${isExpanded ? 'z-40' : 'z-20'}`
            : dup
              ? `bg-white dark:bg-slate-950 ring-2 ring-rose-400/70 border-rose-300 dark:border-rose-700/60 shadow-xs hover:shadow-md text-slate-900 dark:text-slate-100 ${isExpanded ? 'z-30' : 'z-10'}`
              : `bg-white dark:bg-slate-950 border-slate-200 dark:border-slate-850 shadow-xs hover:shadow-md text-slate-900 dark:text-slate-100 ${isExpanded ? 'z-30' : 'z-10'}`
      }`}
      style={{
        transform: (() => {
          const live = cardPositionsRef.current[tag.id] || meta;
          return `translate(${live.x}px, ${live.y}px)`;
        })(),
        left: 0,
        top: 0
      }}
      onMouseDown={(e) => handleTagMouseDown(e, tag.id, meta)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        // После правого перетаскивания (панорама) меню не показываем
        if (panMovedRef.current) { panMovedRef.current = false; return; }
        // ПКМ по невыделенной карточке — выделяем только её (как в проводнике)
        if (!selectedTagIds.has(tag.id)) setSelectedTagIds(new Set([tag.id]));
        setCardMenu({ x: e.clientX, y: e.clientY, tagId: tag.id });
      }}
    >
      {/* Порты для связи перетаскиванием — только в режиме «Перетаскиванием» */}
      {linkMode === 'drag' && (<>
      <div
        className={`absolute connection-port left-0 top-[22px] -translate-x-1/2 -translate-y-1/2 w-4 h-4 rounded-full border border-slate-300 dark:border-slate-800 transition-ui hover:scale-130 cursor-crosshair z-40 ${
          hoveredLeft
            ? 'bg-emerald-500 border-white scale-125 shadow-lg'
            : 'bg-slate-200 dark:bg-slate-800'
        }`}
        onMouseDown={(e) => handlePortMouseDown(e, tag.id, 'left')}
        onMouseEnter={() => { if (draggedTagId) return; setHoveredPort({ tagId: tag.id, side: 'left' }); }}
        onMouseLeave={() => setHoveredPort(null)}
        title="Сюда приходит линия от родителя"
      >
        <div className="w-1.5 h-1.5 rounded-full bg-slate-700 dark:bg-slate-300 m-auto mt-[4px]" />
      </div>

      <div
        className={`absolute connection-port right-0 top-[22px] translate-x-1/2 -translate-y-1/2 w-4 h-4 rounded-full border border-slate-300 dark:border-slate-800 transition-ui hover:scale-130 cursor-crosshair z-40 ${
          hoveredRight
            ? 'bg-emerald-500 border-white scale-125 shadow-lg'
            : 'bg-slate-200 dark:bg-slate-800'
        }`}
        onMouseDown={(e) => handlePortMouseDown(e, tag.id, 'right')}
        onMouseEnter={() => { if (draggedTagId) return; setHoveredPort({ tagId: tag.id, side: 'right' }); }}
        onMouseLeave={() => setHoveredPort(null)}
        title="Отсюда тянут линию к дочернему тегу"
      >
        <div className="w-1.5 h-1.5 rounded-full bg-slate-700 dark:bg-slate-300 m-auto mt-[4px]" />
      </div>
      </>)}

      {/* CARD COMPACT HEADER ROW (Always visible) */}
      <div className="px-4 py-3 cursor-move flex flex-col gap-1 w-full">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            {/* Actuality Color Dot */}
            <span 
              className={`w-3.5 h-3.5 rounded-full inline-block shrink-0 border border-slate-200 dark:border-slate-800 ${statusVal.text} bg-current`}
              title={`Актуальность: ${statusVal.label}`}
            />
            <Database className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span className="font-mono font-medium tracking-tight text-xs text-slate-800 dark:text-slate-100 truncate select-all">
              {tag.identifier}
            </span>
            {dup && (
              <span className="shrink-0 text-xs font-medium px-1.5 py-0.5 rounded-full bg-rose-100 dark:bg-rose-950/50 text-rose-600 dark:text-rose-300 border border-rose-200 dark:border-rose-800/60" title="Дубликат кода тега">
                дубль
              </span>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0 no-drag select-none">
            {/* Связать: клик → затем клик по целевому тегу (режим «Кликом») */}
            {linkMode === 'click' && (
              <button type="button"
                title={linkingFrom === tag.id ? 'Отменить связывание' : 'Связать: затем кликните целевой тег'}
                onClick={(e) => {
                  e.stopPropagation();
                  setLinkingFrom(prev => prev === tag.id ? null : tag.id);
                }}
                className={`p-1.5 rounded transition-colors cursor-pointer flex items-center justify-center ${
                  linkingFrom === tag.id
                    ? 'bg-sky-500 text-white'
                    : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-450 dark:hover:text-slate-200'
                }`}
              >
                <Link2 className="w-4 h-4" />
              </button>
            )}
            {/* Toggle Info / Expand Detailed View */}
            <button type="button"
              title={isExpanded ? "Свернуть комментарии" : "Открыть комментарии тега"}
              onClick={(e) => {
                e.stopPropagation();
                setExpandedCardIds(prev => ({ ...prev, [tag.id]: !prev[tag.id] }));
              }}
              className={`p-1.5 rounded transition-colors cursor-pointer flex items-center justify-center ${
                isExpanded
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                  : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-450 dark:hover:text-slate-200'
              }`}
            >
              <Info className="w-4 h-4" />
            </button>
          </div>
        </div>
        
        {/* Наименование — только если есть (пустые строки не занимают место) */}
        {meta.mainName && (
          <div className="text-xs font-semibold text-slate-600 dark:text-slate-350 truncate mt-0.5 pl-5" title={meta.mainName}>
            {meta.mainName}
          </div>
        )}

        {/* Марка и актуальность */}
        <div className="flex items-center gap-1.5 pl-5 mt-0.5 min-w-0">
          {tag.brand && (
            <span className="font-mono text-xs font-medium px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 truncate max-w-[140px]" title={`Марка: ${tag.brand}`}>
              {tag.brand}
            </span>
          )}
          <span className={`text-2xs font-semibold px-1.5 py-0.5 rounded-full border shrink-0 ${statusVal.bg} ${statusVal.text} ${statusVal.border}`} title={`Актуальность: ${statusVal.label}`}>
            {statusVal.label}
          </span>
        </div>
      </div>

      {/* EXPANDED SECTION */}
      {isExpanded && (
        <div className="border-t border-slate-105 dark:border-slate-850 animate-fadeIn text-slate-800 dark:text-slate-300">
          
          {/* INFO TAG FLUID/DEPT */}
          <div className="px-4 py-2 bg-slate-50/40 dark:bg-slate-950/20 text-xs text-slate-400 flex justify-between border-b border-slate-100 dark:border-slate-900 font-medium">
            <span className="truncate max-w-[130px]" title={tag.department}>
              Отд: <strong className="text-slate-700 dark:text-slate-300">{tag.department || 'Комплекс'}</strong>
            </span>
            <span className="truncate max-w-[120px]" title={tag.fluid}>
              Среда: <strong className="text-slate-700 dark:text-slate-300">{tag.fluid || 'Воздух'}</strong>
            </span>
          </div>

          {/* СВЯЗИ: родители и дочерние теги — добавить/снять в один клик */}
          <div className="px-3.5 py-2.5 border-b border-slate-100 dark:border-slate-900 no-drag space-y-1.5 text-left">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-400">Связи</span>
              {/* Две кнопки, а не одна: чипы связей и раньше показывали
                  и родителя (↑), и детей (↓), а завести можно было
                  только ребёнка. Родителя приходилось искать на холсте
                  и тянуть линию — из другого конца проекта это неудобно */}
              <span className="flex items-center gap-2 shrink-0">
                <button type="button"
                  onClick={(e) => { e.stopPropagation(); setLinkPicker(prev => (prev?.tagId === tag.id && prev.dir === 'parent') ? null : { tagId: tag.id, search: '', dir: 'parent' }); }}
                  className="fx-btn fx-btn-quiet fx-btn-sm"
                >
                  {(incomingByTagId[tag.id] || []).length ? '↑ сменить родителя' : '+ родительский тег'}
                </button>
                <button type="button"
                  onClick={(e) => { e.stopPropagation(); setLinkPicker(prev => (prev?.tagId === tag.id && prev.dir === 'child') ? null : { tagId: tag.id, search: '', dir: 'child' }); }}
                  className="fx-btn fx-btn-quiet fx-btn-sm"
                >
                  + дочерний тег
                </button>
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {(incomingByTagId[tag.id] || []).map(pid => tagsById[pid] && (
                <span key={`p-${pid}`} className="inline-flex items-center gap-1 pl-1.5 pr-0.5 py-0.5 rounded-md bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/50 text-xs font-medium text-emerald-700 dark:text-emerald-300" title={`Родитель: ${tagsById[pid].identifier}`}>
                  ↑ <span className="font-mono truncate max-w-[110px]">{tagsById[pid].identifier}</span>
                  <button type="button" onClick={(e) => { e.stopPropagation(); handleRemoveConnection(pid, tag.id); }} className="p-0.5 rounded hover:bg-emerald-100 dark:hover:bg-emerald-900 hover:text-rose-500 cursor-pointer" title="Разорвать связь с родителем">
                    <X className="w-2.5 h-2.5" />
                  </button>
                </span>
              ))}
              {(meta.connections || []).map(cid => tagsById[cid] && (
                <span key={`c-${cid}`} className="inline-flex items-center gap-1 pl-1.5 pr-0.5 py-0.5 rounded-md bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/50 text-xs font-medium text-emerald-700 dark:text-emerald-300" title={`Дочерний: ${tagsById[cid].identifier}`}>
                  ↓ <span className="font-mono truncate max-w-[110px]">{tagsById[cid].identifier}</span>
                  <button type="button" onClick={(e) => { e.stopPropagation(); handleRemoveConnection(tag.id, cid); }} className="p-0.5 rounded hover:bg-emerald-100 dark:hover:bg-emerald-900 hover:text-rose-500 cursor-pointer" title="Разорвать связь">
                    <X className="w-2.5 h-2.5" />
                  </button>
                </span>
              ))}
              {(incomingByTagId[tag.id] || []).length === 0 && (meta.connections || []).length === 0 && (
                <span className="text-2xs text-slate-400">Нет связей</span>
              )}
            </div>
            {linkPicker?.tagId === tag.id && (() => {
              const wantParent = linkPicker.dir === 'parent';
              const oldParent = (incomingByTagId[tag.id] || [])[0];
              const candidates = linkCandidates(tag.id, linkPicker.dir, linkPicker.search);
              return (
              <div className="pt-1 space-y-1">
                {/* Родитель у тега один, и linkChild сам отцепит прежнего.
                    Молчаливая подмена здесь и была бы возвратом к той
                    поломке, из-за которой строку «Родительский тег» убрали */}
                {wantParent && oldParent && tagsById[oldParent] && (
                  <p className="text-2xs text-amber-700 dark:text-amber-400">
                    Заменит нынешнего родителя:{' '}
                    <b className="font-mono">{tagsById[oldParent].identifier}</b>
                  </p>
                )}
                <input
                  autoFocus
                  value={linkPicker.search}
                  onChange={(e) => setLinkPicker({ tagId: tag.id, search: e.target.value, dir: linkPicker.dir })}
                  onKeyDown={(e) => { if (e.key === 'Escape') setLinkPicker(null); }}
                  placeholder={wantParent ? 'Найти родительский тег…' : 'Найти дочерний тег…'}
                  className="w-full px-2 py-1 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded text-xs text-slate-800 dark:text-slate-100 focus:outline-none focus:border-emerald-400"
                />
                <div className="max-h-32 overflow-y-auto space-y-0.5">
                  {candidates.length === 0 && (
                    <p className="px-2 py-1 text-2xs text-slate-400">
                      {wantParent
                        ? 'Подходящих тегов нет: свой же состав родителем стать не может.'
                        : 'Подходящих тегов нет.'}
                    </p>
                  )}
                  {candidates.map(t => (
                    <button type="button" key={t.id}
                      /* Порядок доводов и есть всё различие: первым идёт
                         РОДИТЕЛЬ, вторым — ребёнок. Перепутанный вызов
                         однажды перевернул дерево целиком */
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (wantParent) await handleAddConnection(t.id, tag.id);
                        else await handleAddConnection(tag.id, t.id);
                        setLinkPicker(null);
                      }}
                      className="fx-btn fx-btn-quiet fx-btn-sm w-full">
                      {wantParent ? '↑' : '↓'} {t.identifier}
                    </button>
                  ))}
                </div>
              </div>
              );
            })()}
          </div>

          {/* SUB-DESCRIPTIONS LIST (With full tracking timestamps and inline editing capability!) */}
          <div className="p-3.5 space-y-2 max-h-[220px] overflow-y-auto no-drag">
            <div className="text-xs font-medium text-slate-400 dark:text-slate-500">
              Комментарии ({meta.descriptions.length})
            </div>

            {meta.descriptions.map((desc) => {
              const config = statusConfig[desc.status] || statusConfig.draft;
              const StatusIcon = config.icon;
              const isEditingThisDesc = editingDescId === desc.id;

              return (
                <div key={desc.id} className="p-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-150/60 dark:border-slate-850 rounded-xl flex flex-col gap-1 text-left">
                  {isEditingThisDesc ? (
                    /* INLINE ITEM EDITOR FORM */
                    <div className="space-y-2 pt-1">
                      <div className="grid grid-cols-2 gap-1.5">
                        <div className="space-y-0.5">
                          <span className="text-xs font-medium text-slate-400">Название</span>
                          <input
                            type="text"
                            value={editDescForm.text}
                            onChange={(e) => setEditDescForm(prev => ({ ...prev, text: e.target.value }))}
                            className="w-full px-2 py-1 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded text-xs text-slate-800 dark:text-slate-100 focus:outline-none"
                          />
                        </div>
                        <div className="space-y-0.5">
                          <span className="text-xs font-medium text-slate-400">Актуальность</span>
                          <CustomSelect
                            value={editDescForm.status}
                            onChange={(val) => setEditDescForm(prev => ({ ...prev, status: val as any }))}
                            options={actualitySelectOptions}
                          />
                        </div>
                      </div>

                      <div className="space-y-0.5">
                        <span className="text-xs font-medium text-slate-400">Комментарий</span>
                        <textarea
                          value={editDescForm.comment}
                          onChange={(e) => setEditDescForm(prev => ({ ...prev, comment: e.target.value }))}
                          className="w-full p-2 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded text-xs text-slate-800 dark:text-slate-100 focus:outline-none"
                          rows={2}
                        />
                      </div>

                      <div className="flex justify-end gap-1.5 pt-1">
                        <button type="button"
                          onClick={() => setEditingDescId(null)}
                          className="px-2 py-0.5 text-xs text-slate-450 hover:text-slate-650 transition-colors cursor-pointer"
                        >
                          Отмена
                        </button>
                        <button type="button"
                          onClick={async () => {
                            await handleUpdateDescription(tag.id, desc.id, {
                              text: editDescForm.text,
                              comment: editDescForm.comment,
                              status: editDescForm.status
                            });
                            setEditingDescId(null);
                          }}
                          className="fx-btn fx-btn-primary fx-btn-sm"
                        >
                          Записать
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* STANDARD DISPLAY MODE WITH TIMESTAMPS */
                    <>
                      <div className="flex items-start justify-between gap-1.5">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <div className={`w-1.5 h-1.5 rounded-full ${config.text} bg-current shrink-0`} />
                          <span
                            className="text-xs font-medium text-slate-700 dark:text-slate-300 truncate"
                            title={`${desc.text}${desc.createdBy ? `\nСоздал: ${desc.createdBy}${desc.createdAt ? ` (${formatDateStr(desc.createdAt)})` : ''}` : ''}${desc.updatedBy ? `\nИзменил: ${desc.updatedBy}${desc.updatedAt ? ` (${formatDateStr(desc.updatedAt)})` : ''}` : ''}`}
                          >{desc.text}</span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <span className={`inline-flex items-center gap-0.5 px-1 py-0.2 rounded text-xs font-semibold border ${config.bg} ${config.text} ${config.border}`}>
                            <StatusIcon className="w-1.5 h-1.5" />
                            {config.label}
                          </span>
                          
                          {/* Actions */}
                          <button type="button"
                            title="Изменить комментарий"
                            onClick={() => {
                              setEditingDescId(desc.id);
                              setEditDescForm({
                                text: desc.text,
                                comment: desc.comment || '',
                                status: desc.status
                              });
                            }}
                            className="p-1 hover:text-emerald-600 hover:bg-slate-200 dark:hover:bg-slate-800 rounded transition-colors text-slate-400 cursor-pointer"
                          >
                            <Edit className="w-2.5 h-2.5" />
                          </button>
                          <button type="button"
                            title="Удалить комментарий"
                            onClick={() => handleRemoveDescription(tag.id, desc.id)}
                            className="p-1 hover:text-rose-500 hover:bg-slate-200 dark:hover:bg-slate-800 rounded transition-colors text-slate-400 cursor-pointer"
                          >
                            <Trash2 className="w-2.5 h-2.5" />
                          </button>
                        </div>
                      </div>

                      {desc.comment && (
                        <p className="text-xs text-slate-500 dark:text-slate-400 pl-2 border-l border-slate-200 dark:border-slate-800 leading-snug">
                          {desc.comment}
                        </p>
                      )}

                    </>
                  )}
                </div>
              );
            })}

            {meta.descriptions.length === 0 && (
              <div className="text-center py-6 text-slate-400 dark:text-slate-500 text-xs">
                Описания отсутствуют.
              </div>
            )}
          </div>

          {/* Быстрое добавление комментария */}
          <div className="p-3 bg-slate-50 dark:bg-slate-900 border-t border-slate-105 dark:border-slate-850 space-y-2 no-drag text-left text-xs">
            <div className="flex gap-1.5">
              <input
                type="text"
                placeholder="Напр. Вентилятор В-1"
                value={quickDescText[tag.id] || ''}
                onChange={(e) => setQuickDescText(prev => ({ ...prev, [tag.id]: e.target.value }))}
                className="px-2 py-1 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-850 rounded text-xs flex-1 text-slate-800 dark:text-slate-100 focus:outline-none"
              />
              <CustomSelect
                value={quickStatus[tag.id] || 'actual'}
                onChange={(val) => setQuickStatus(prev => ({ ...prev, [tag.id]: val as any }))}
                options={emojiOptions}
              />
            </div>
            
            <div className="flex gap-1.5">
              <input
                type="text"
                placeholder="Замечания..."
                value={quickCommentText[tag.id] || ''}
                onChange={(e) => setQuickCommentText(prev => ({ ...prev, [tag.id]: e.target.value }))}
                className="px-2 py-1 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-850 rounded text-xs flex-1 text-slate-800 dark:text-slate-100 focus:outline-none"
              />
              <button type="button"
                onClick={() => handleAddDescription(
                  tag.id, 
                  quickDescText[tag.id], 
                  quickCommentText[tag.id], 
                  quickStatus[tag.id] || 'actual'
                )}
                className="fx-btn fx-btn-primary fx-btn-sm"
              >
                +
              </button>
            </div>
          </div>

          {/* Действия карточки */}
          <div className="p-2 bg-slate-100/40 dark:bg-slate-950/40 border-t border-slate-200 dark:border-slate-850 flex items-center justify-end text-xs rounded-b-2xl no-drag">
            <div className="flex items-center gap-1.5">
              <button type="button"
                title="Настроить связи / свойства в модали"
                onClick={() => setEditingTag(tag)}
                className="flex items-center gap-1 px-2 py-1 hover:text-emerald-600 dark:hover:text-emerald-400 text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800 rounded transition-colors text-xs font-semibold cursor-pointer"
              >
                <Edit2 className="w-3 h-3" /> Настройка
              </button>
              <button type="button"
                title="Удалить тег с холста"
                onClick={() => handleDeleteTag(tag.id)}
                className="p-1 px-2 hover:text-rose-600 text-slate-550 hover:bg-rose-50 dark:hover:bg-rose-950/30 rounded transition-colors text-xs font-semibold cursor-pointer"
              >
                <Trash2 className="w-3 h-3" /> Удалить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
