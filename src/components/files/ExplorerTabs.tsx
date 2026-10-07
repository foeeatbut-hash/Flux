import React from 'react';
import { Plus, X } from 'lucide-react';
import PlaceIcon from './PlaceIcon';
import { pathText } from './places';
import { placeOf, type ExplorerTab } from './tabsModel';
import { FONT_STACK, SIZE, X as T } from './explorerTheme';

/**
 * Вкладки Проводника, как в Windows 11: значок и название места, крестик,
 * «+». Лежат в заголовке окна (useWindowTitleBar), поэтому всё, на что можно
 * нажать, помечено `pointer-events-auto` — пустое место полосы остаётся
 * заголовком окна и тащит его.
 *
 * Здесь только вид и мышь. Что вкладка помнит, считает `tabsModel`; клавиши
 * (Ctrl+T/W/Tab) — в `explorerKeys`. Бросок файлов на вкладку наружу не
 * исполняется: компонент сообщает «на вкладку бросили», а как копировать или
 * переносить, решает тот, кто знает про операции.
 */

const DRAG_MIME = 'application/x-flux-explorer-tab';
const hasFiles = (event: React.DragEvent) => [...event.dataTransfer.types].some((type) => type === 'Files' || type === 'application/x-flux-entries');

export default function ExplorerTabs({ tabs, activeId, onPick, onClose, onNew, onMove, onDropOnTab }: {
  tabs: ExplorerTab[];
  activeId: string;
  onPick: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  /** Вкладку перетащили: поставить перед `beforeId`, null — в конец */
  onMove: (id: string, beforeId: string | null) => void;
  /** На вкладку бросили файлы — наружу, вместе с самой вкладкой и событием */
  onDropOnTab?: (tab: ExplorerTab, event: React.DragEvent) => void;
}) {
  const [dragging, setDragging] = React.useState<string | null>(null);
  /** Куда встанет вкладка: перед `id` либо после последней */
  const [mark, setMark] = React.useState<{ id: string; side: 'before' | 'after' } | null>(null);
  const [fileOver, setFileOver] = React.useState<string | null>(null);

  const over = (event: React.DragEvent, tab: ExplorerTab) => {
    if (dragging) {
      event.preventDefault(); event.dataTransfer.dropEffect = 'move';
      const box = event.currentTarget.getBoundingClientRect();
      setMark({ id: tab.id, side: event.clientX < box.left + box.width / 2 ? 'before' : 'after' });
    } else if (hasFiles(event)) {
      // Файлы над вкладкой: подсвечиваем, отпускание отдаём наружу
      event.preventDefault(); setFileOver(tab.id);
    }
  };
  const drop = (event: React.DragEvent, tab: ExplorerTab) => {
    if (dragging) {
      event.preventDefault();
      const side = mark?.id === tab.id ? mark.side : 'before';
      const at = tabs.findIndex((item) => item.id === tab.id);
      onMove(dragging, side === 'before' ? tab.id : tabs[at + 1]?.id ?? null);
    } else if (hasFiles(event)) {
      event.preventDefault(); onDropOnTab?.(tab, event);
    }
    setDragging(null); setMark(null); setFileOver(null);
  };

  return (
    <div role="tablist" aria-label="Вкладки Проводника" data-explorer-tabs style={{ fontFamily: FONT_STACK }}
      className={`flex h-full min-w-0 flex-1 items-end gap-0 pl-2 text-xs ${T.text}`}>
      {tabs.map((tab) => {
        const place = placeOf(tab);
        const active = tab.id === activeId;
        return (
          <div key={tab.id} role="tab" aria-selected={active} data-tab-id={tab.id} tabIndex={active ? 0 : -1} title={pathText(place)}
            draggable
            onDragStart={(event) => { setDragging(tab.id); event.dataTransfer.setData(DRAG_MIME, tab.id); event.dataTransfer.effectAllowed = 'move'; }}
            onDragEnd={() => { setDragging(null); setMark(null); }}
            onDragOver={(event) => over(event, tab)}
            onDragLeave={() => { setFileOver((id) => id === tab.id ? null : id); }}
            onDrop={(event) => drop(event, tab)}
            onClick={() => onPick(tab.id)}
            onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onClose(tab.id); } }}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onPick(tab.id); } }}
            style={{ height: SIZE.tabHeight }}
            className={`pointer-events-auto relative flex min-w-[56px] max-w-[240px] flex-[0_1_240px] cursor-default select-none items-center gap-2 rounded-t-lg pl-2 pr-1
              ${active ? `${T.surface} font-semibold` : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.06]'}
              ${fileOver === tab.id ? 'outline outline-2 -outline-offset-2 outline-[#0067c0] dark:outline-[#4cc2ff]' : ''}
              ${dragging === tab.id ? 'opacity-50' : ''}`}>
          {mark?.id === tab.id && dragging !== tab.id && (
            <span aria-hidden className={`absolute top-1 bottom-1 w-0.5 rounded bg-[#0067c0] dark:bg-[#4cc2ff] ${mark.side === 'before' ? '-left-px' : '-right-px'}`} />
          )}
          <PlaceIcon kind={place.kind} name={place.name} fileRef={place.ref} size={16} />
          <span className="min-w-0 flex-1 truncate">{place.name}</span>
          <button type="button" aria-label={`Закрыть вкладку «${place.name}»`} tabIndex={-1}
            onClick={(event) => { event.stopPropagation(); onClose(tab.id); }}
            onMouseDown={(event) => event.stopPropagation()}
            className={`pointer-events-auto flex h-6 w-6 shrink-0 items-center justify-center rounded ${T.iconButton}`}>
            <X width={14} height={14} />
          </button>
        </div>
        );
      })}
      <button type="button" aria-label="Новая вкладка" title="Новая вкладка (Ctrl+T)" onClick={onNew}
        style={{ height: SIZE.tabHeight }}
        className={`pointer-events-auto mx-1 flex w-8 shrink-0 items-center justify-center rounded-lg ${T.iconButton}`}>
        <Plus width={16} height={16} />
      </button>
    </div>
  );
}
