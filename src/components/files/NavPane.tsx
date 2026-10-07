import React from 'react';
import { ChevronRight, Pin } from 'lucide-react';
import ContextMenu, { type MenuItem } from '../ContextMenu';
import PlaceIcon from './PlaceIcon';
import { useNavTree } from './useNavTree';
import { usePlaceCatalog } from './usePlaceCatalog';
import { NAV_MAX, NAV_MIN, clampNav, useNavWidth } from './useNavWidth';
import type { NavRow } from './navTree';
import { refKey, type Place } from './places';
import { usePlacesStore } from '../../store/placesStore';
import { useToastStore } from '../../store/toastStore';
import { FONT_STACK, SIZE, X as T } from './explorerTheme';

/**
 * Панель навигации: Главная, закреплённое (Быстрый доступ Windows), облачные
 * папки, Этот компьютер с дисками и деревом, Сеть. Без «Галереи».
 *
 * Строка 32 точки; стрелка, значок и подпись стоят на тех же отступах, что на
 * эталоне, и каждый уровень вложенности сдвигает их на 8. Ширина 287, границу
 * можно тянуть, ширина запоминается. Что показано и в каком порядке, считает
 * `navTree`; здесь разметка, мышь и клавиатура.
 */

const INDENT = 8;

export default function NavPane({ place, onOpen, onOpenInNewTab }: {
  place: Place;
  onOpen: (place: Place) => void;
  /** Пункт «Открыть в новой вкладке» в меню; без него пункта нет */
  onOpenInNewTab?: (place: Place) => void;
}) {
  const { catalog, quick, quickSupported, loaded } = usePlaceCatalog();
  const { rows, toggle } = useNavTree(place, catalog, quick, quickSupported);
  const { width, setWidth, remember } = useNavWidth();
  const [menu, setMenu] = React.useState<{ x: number; y: number; row: NavRow } | null>(null);
  const paneRef = React.useRef<HTMLDivElement>(null);
  const pinnedKeys = React.useMemo(() => new Set(quick.filter((item) => item.pinned).map((item) => refKey(item.ref))), [quick]);

  const items = rows.filter((row) => row.kind === 'row');
  const focusKey = (items.find((row) => row.selected) ?? items[0])?.key;

  const menuItems = (row: NavRow): MenuItem[] => {
    const target = row.place!;
    const list: MenuItem[] = [{ label: 'Открыть', onClick: () => onOpen(target) }];
    if (onOpenInNewTab) list.push({ label: 'Открыть в новой вкладке', onClick: () => onOpenInNewTab(target) });
    // Закрепляются только настоящие папки: у черновика Flux нет пути в Windows
    if (quickSupported && target.ref && !target.ref.draftId && target.kind === 'folder') {
      const pinned = pinnedKeys.has(refKey(target.ref));
      list.push({
        label: pinned ? 'Открепить из Быстрого доступа' : 'Закрепить в Быстром доступе', separated: true,
        onClick: () => { void usePlacesStore.getState().pin(target.ref!, !pinned).then((answer) => { if (!answer.ok) useToastStore.getState().addToast(answer.message || 'Не удалось изменить Быстрый доступ.', 'error'); }); },
      });
    }
    return list;
  };

  // Клавиатура дерева: стрелки ходят по строкам, → раскрывает, ← сворачивает или уходит к родителю, Enter открывает
  const onKeyDown = (event: React.KeyboardEvent) => {
    const nodes = [...(paneRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])];
    const at = nodes.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    const row = items.find((item) => item.key === nodes[at].dataset.navKey);
    if (!row) return;
    const go = (index: number) => { event.preventDefault(); nodes[Math.min(nodes.length - 1, Math.max(0, index))]?.focus(); };
    if (event.key === 'ArrowDown') go(at + 1);
    else if (event.key === 'ArrowUp') go(at - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(nodes.length - 1);
    else if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (row.expandable && !row.expanded) toggle(row.key, row.ref); else go(at + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (row.expanded) toggle(row.key, row.ref);
      else { for (let i = at - 1; i >= 0; i--) if (Number(nodes[i].getAttribute('aria-level')) < row.depth + 1) { nodes[i].focus(); break; } }
    } else if (event.key === 'Enter' && row.place) { event.preventDefault(); onOpen(row.place); }
    else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const box = nodes[at].getBoundingClientRect();
      if (row.place) setMenu({ x: box.left + 40, y: box.bottom, row });
    }
  };

  // Граница: тянется указателем, ширина запоминается, когда отпустили
  const drag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget; handle.setPointerCapture(event.pointerId);
    const left = paneRef.current!.getBoundingClientRect().left;
    let latest = width;
    const move = (e: PointerEvent) => { latest = clampNav(e.clientX - left); setWidth(latest); };
    const up = () => { handle.releasePointerCapture(event.pointerId); handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); remember(latest); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up);
  };

  return (
    <div ref={paneRef} data-nav-pane style={{ width, fontFamily: FONT_STACK }}
      className={`relative shrink-0 border-r border-[#e5e5e5] dark:border-[#202020] ${T.pane} ${T.text}`}>
      <div role="tree" aria-label="Панель навигации" aria-busy={!loaded} onKeyDown={onKeyDown} className="h-full overflow-y-auto overflow-x-hidden pt-1.5 text-xs scrollbar-thin">
        {rows.map((row) => row.kind === 'sep'
          ? <div key={row.key} role="separator" className="flex items-center px-2" style={{ height: SIZE.navItem }}><div className={`h-px w-full ${T.groupLine}`} /></div>
          : (
            <div key={row.key} role="treeitem" data-nav-key={row.key} aria-level={row.depth + 1} aria-selected={row.selected}
              aria-current={row.selected ? 'page' : undefined} aria-expanded={row.expandable ? row.expanded : undefined}
              tabIndex={row.key === focusKey ? 0 : -1} title={row.label}
              onClick={() => row.place && onOpen(row.place)}
              onContextMenu={(event) => { if (!row.place) return; event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, row }); }}
              className="group relative cursor-default select-none outline-none" style={{ height: SIZE.navItem }}>
              <span aria-hidden className={`absolute inset-y-px left-px right-[3px] rounded group-focus-visible:outline group-focus-visible:outline-2 group-focus-visible:outline-[#0067c0] dark:group-focus-visible:outline-[#4cc2ff] ${row.selected ? T.paneSelected : T.paneHover}`} />
              <span className="relative flex h-full items-center" style={{ paddingLeft: 13 + row.depth * INDENT, paddingRight: 10 }}>
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {row.expandable && (
                    <button type="button" tabIndex={-1} aria-label={`${row.expanded ? 'Свернуть' : 'Развернуть'}: ${row.label}`} data-nav-chevron
                      onClick={(event) => { event.stopPropagation(); toggle(row.key, row.ref); }} onDoubleClick={(event) => event.stopPropagation()}
                      className={`flex h-4 w-4 items-center justify-center ${T.muted}`}>
                      <ChevronRight width={12} height={12} className={`transition-transform ${row.expanded ? 'rotate-90' : ''}`} />
                    </button>
                  )}
                </span>
                <span className="ml-2 flex h-4 w-4 shrink-0 items-center justify-center">
                  {row.icon
                    ? <img src={row.icon} alt="" width={16} height={16} draggable={false} className="h-4 w-4 object-contain" />
                    : <PlaceIcon kind={row.place!.kind} name={row.label} fileRef={row.place!.ref} flux={row.flux} size={16} />}
                </span>
                <span className="ml-1.5 min-w-0 flex-1 truncate">{row.label}</span>
                {row.loading && <span className={`ml-2 shrink-0 ${T.faint}`}>…</span>}
                {row.flux && <span className={`ml-2 shrink-0 text-[11px] ${T.faint}`}>Только в Flux</span>}
                {row.pinned && <Pin width={12} height={12} aria-label="Закреплено" className={`ml-2 shrink-0 ${T.faint}`} />}
              </span>
            </div>
          ))}
      </div>
      <div role="separator" aria-orientation="vertical" aria-label="Ширина панели навигации" aria-valuemin={NAV_MIN} aria-valuemax={NAV_MAX} aria-valuenow={width} tabIndex={0}
        data-nav-resizer onPointerDown={drag}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault(); const next = clampNav(width + (event.key === 'ArrowRight' ? 16 : -16)); setWidth(next); remember(next);
        }}
        className="absolute -right-[3px] top-0 bottom-0 z-10 w-[7px] cursor-col-resize hover:bg-[#0067c0]/30 focus-visible:bg-[#0067c0]/40 dark:hover:bg-[#4cc2ff]/30" />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.row)} onClose={() => setMenu(null)} />}
    </div>
  );
}
