import React from 'react';
import { ArrowLeft, ArrowRight, ArrowUp, ChevronRight, RotateCw } from 'lucide-react';
import AddressInput from './AddressInput';
import PlaceIcon from './PlaceIcon';
import PlaceMenu from './PlaceMenu';
import SearchBox from './SearchBox';
import { placeChildren } from './placesApi';
import { canGoUp, placeForRoot, placeFromTrail, placeKey, topPlaces, type Place, type PlaceCatalog } from './places';
import { usePlacesStore } from '../../store/placesStore';
import { FONT_STACK, SIZE, X as T } from './explorerTheme';
import type { ExplorerSearch } from './useExplorerSearch';

/**
 * Строка адреса: Назад, Вперёд, Вверх, Обновить; поле с крошками; поиск.
 *
 * Крошки — звенья цепочки места, у каждого справа стрелка со списком
 * вложенного. Щелчок по пустому месту поля, Ctrl+L, Alt+D и F4 превращают поле
 * в текстовый путь. Кнопки идут шагом 48, поле — высотой 32, как на эталоне.
 * Сама строка ничего не знает о вкладках: ей дают место и обратные вызовы.
 */

function NavButton({ label, title, disabled, onClick, onContextMenu, buttonRef, children }: {
  label: string; title: string; disabled?: boolean; onClick: () => void; onContextMenu?: (event: React.MouseEvent) => void;
  buttonRef?: React.Ref<HTMLButtonElement>; children: React.ReactNode;
}) {
  return (
    <span className="flex shrink-0 items-center justify-center" style={{ width: SIZE.addressStep, height: SIZE.addressRow }}>
      <button ref={buttonRef} type="button" aria-label={label} title={title} disabled={disabled} onClick={onClick} onContextMenu={onContextMenu}
        className={`flex h-8 w-9 items-center justify-center rounded-md ${T.text} ${T.iconButton} disabled:opacity-35 disabled:hover:bg-transparent`}>
        {children}
      </button>
    </span>
  );
}

export default function AddressBar({
  place, catalog, canBack, canForward, recent, search,
  onBack, onForward, onUp, onRefresh, onOpen, onJump,
  focusAddressToken = 0, focusSearchToken = 0,
}: {
  place: Place; catalog: PlaceCatalog;
  canBack: boolean; canForward: boolean;
  /** Недавние места для списка у «Назад»: от ближайшего; `delta` — на сколько шагов прыгнуть */
  recent: { place: Place; delta: number }[];
  search: ExplorerSearch;
  onBack: () => void; onForward: () => void; onUp: () => void; onRefresh: () => void;
  onOpen: (place: Place) => void;
  onJump: (delta: number) => void;
  /** Растёт на единицу — строка переходит к текстовому пути (Ctrl+L, Alt+D, F4) */
  focusAddressToken?: number;
  /** Растёт на единицу — фокус в поле поиска (Ctrl+E, Ctrl+F, F3) */
  focusSearchToken?: number;
}) {
  const [editing, setEditing] = React.useState(false);
  const [menu, setMenu] = React.useState<{ kind: 'back' } | { kind: 'top' } | { kind: 'crumb'; index: number } | null>(null);
  const anchors = React.useRef<Record<string, HTMLElement | null>>({});
  const backButton = React.useRef<HTMLButtonElement>(null);
  const crumbsRef = React.useRef<HTMLDivElement>(null);
  const barRef = React.useRef<HTMLDivElement>(null);
  const wasEditing = React.useRef(false);
  /** Сколько звеньев слева свёрнуто в «…»: помещаются последние */
  const [folded, setFolded] = React.useState(0);
  const [room, setRoom] = React.useState(0);
  const ghostRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => { if (focusAddressToken) setEditing(true); }, [focusAddressToken]);
  // Ввод или список закончились (Enter, Esc, выбор строки): элемент с фокусом исчез, и фокус упал бы на страницу — клавиши
  // окна (Ctrl+L, Ctrl+T) перестали бы слышать. Возвращаем его строке, но только если он никуда не ушёл сам:
  // щелчок по другому месту забирать назад нельзя
  const overlay = editing || menu !== null;
  React.useEffect(() => {
    if (wasEditing.current && !overlay && (!document.activeElement || document.activeElement === document.body)) barRef.current?.focus();
    wasEditing.current = overlay;
  }, [overlay]);
  // Другое место — поле снова крошки
  React.useEffect(() => { setEditing(false); }, [placeKey(place)]);

  // Ширина поля нужна для свёртки; сам список звеньев меряется по невидимой копии (ghost):
  // настоящие звенья, уже свёрнутые, измерить нельзя — их нет в разметке
  React.useEffect(() => {
    const box = crumbsRef.current; if (!box) return;
    const watcher = new ResizeObserver(() => setRoom(box.clientWidth));
    watcher.observe(box); setRoom(box.clientWidth);
    return () => watcher.disconnect();
  }, [editing]);
  React.useLayoutEffect(() => {
    const widths = [...(ghostRef.current?.children ?? [])].map((item) => (item as HTMLElement).offsetWidth);
    // Из ширины вычитаем значок, первую стрелку и многоточие, которые стоят всегда
    const avail = room - 12 - 20 - 20 - 28;
    // Последнее звено видно всегда; слева добавляем, пока помещается
    let used = 0, start = widths.length;
    for (let i = widths.length - 1; i >= 0; i--) {
      if (used + widths[i] > avail && i < widths.length - 1) break;
      used += widths[i]; start = i;
    }
    const hide = widths.length ? start : 0;
    setFolded((old) => old === hide ? old : hide);
  }, [room, placeKey(place), place.trail.length, editing]);

  // Путь вне подключённых мест: человек выбирает папку в окне Windows, она становится местом, и мы её открываем
  const connect = async () => {
    const root = await usePlacesStore.getState().connect();
    if (!root) return;
    const { roots, volumes, cloud } = usePlacesStore.getState();
    onOpen(placeForRoot(root.id, { roots, volumes, cloud }));
  };

  const trail = place.trail;
  const stepPlace = (index: number) => placeFromTrail(trail.slice(0, index + 1));
  const visible = trail.map((step, index) => ({ step, index })).slice(folded);

  const crumbList = async (index: number) => (await placeChildren(stepPlace(index), catalog)).map((child) => ({ place: child }));

  return (
    <div ref={barRef} tabIndex={-1} data-address-bar style={{ height: SIZE.addressRow, fontFamily: FONT_STACK }} className={`flex shrink-0 items-center outline-none ${T.surface} ${T.text}`}>
      <NavButton label="Назад" title="Назад (Alt+←)" disabled={!canBack} onClick={onBack} buttonRef={backButton}
        onContextMenu={(event) => { event.preventDefault(); if (recent.length) setMenu({ kind: 'back' }); }}><ArrowLeft width={18} height={18} /></NavButton>
      <NavButton label="Вперёд" title="Вперёд (Alt+→)" disabled={!canForward} onClick={onForward}><ArrowRight width={18} height={18} /></NavButton>
      <NavButton label="Вверх" title="Вверх (Alt+↑)" disabled={!canGoUp(place)} onClick={onUp}><ArrowUp width={18} height={18} /></NavButton>
      <NavButton label="Обновить" title="Обновить (F5)" onClick={onRefresh}><RotateCw width={16} height={16} /></NavButton>

      <div data-address-field style={{ height: SIZE.addressField }}
        className={`ml-1.5 mr-2 flex min-w-0 flex-1 items-center rounded-md ${T.field} ${T.fieldBorder}`}>
        {editing ? (
          <AddressInput place={place} catalog={catalog} onCancel={() => setEditing(false)} onOpen={(next) => { setEditing(false); onOpen(next); }} onConnect={() => { setEditing(false); void connect(); }} />
        ) : (
          /* Щелчок мимо крошек — текстовый путь. Крошки гасят всплытие сами: у них свои действия */
          <div ref={crumbsRef} onClick={() => setEditing(true)} className="relative flex h-full min-w-0 flex-1 cursor-text items-center overflow-hidden pl-3 text-[14px]">
            {/* Невидимая копия звеньев: по ней меряется, сколько их поместится (см. свёртку выше) */}
            <div ref={ghostRef} aria-hidden className="pointer-events-none invisible absolute left-0 top-0 flex h-0 overflow-hidden whitespace-nowrap">
              {trail.map((step, index) => <span key={index} className="flex shrink-0"><span className="px-2">{step.name}</span>{step.kind !== 'home' && <span className="w-5" />}</span>)}
            </div>
            <PlaceIcon kind={place.kind} name={place.name} fileRef={place.ref} size={16} className="mr-1" />
            <button type="button" aria-label="Верхние места" aria-expanded={menu?.kind === 'top'} ref={(el) => { anchors.current.top = el; }}
              onClick={(e) => { e.stopPropagation(); setMenu(menu?.kind === 'top' ? null : { kind: 'top' }); }}
              className={`flex h-7 w-5 shrink-0 items-center justify-center rounded ${T.iconButton}`}><ChevronRight width={14} height={14} className={menu?.kind === 'top' ? 'rotate-90' : ''} /></button>
            {folded > 0 && <span className="shrink-0 px-1 opacity-70" title={trail.slice(0, folded).map((step) => step.name).join(' › ')}>…</span>}
            <nav aria-label="Путь" className="flex min-w-0 items-center">
              {visible.map(({ step, index }) => {
                const last = index === trail.length - 1;
                return (
                  <span key={`${index}-${step.name}`} data-crumb-group className="flex shrink-0 items-center">
                    <button type="button" data-crumb={index} aria-current={last ? 'page' : undefined}
                      onClick={(e) => { e.stopPropagation(); if (!last) onOpen(stepPlace(index)); else onRefresh(); }}
                      className={`h-7 shrink-0 rounded px-2 ${T.iconButton}`}>{step.name}</button>
                    {step.kind !== 'home' && (
                      <button type="button" aria-label={`Подпапки: ${step.name}`} aria-expanded={menu?.kind === 'crumb' && menu.index === index}
                        ref={(el) => { anchors.current[`crumb${index}`] = el; }}
                        onClick={(e) => { e.stopPropagation(); setMenu(menu?.kind === 'crumb' && menu.index === index ? null : { kind: 'crumb', index }); }}
                        className={`flex h-7 w-5 shrink-0 items-center justify-center rounded ${T.iconButton}`}>
                        <ChevronRight width={14} height={14} className={menu?.kind === 'crumb' && menu.index === index ? 'rotate-90' : ''} />
                      </button>
                    )}
                  </span>
                );
              })}
            </nav>
          </div>
        )}
      </div>

      <div className="mr-2.5 shrink">
        <SearchBox search={search} placeName={place.name} focusToken={focusSearchToken} />
      </div>

      {menu?.kind === 'back' && (
        <PlaceMenu anchor={backButton.current} label="Недавние места" onClose={() => setMenu(null)}
          load={async () => recent.map((item) => ({ place: item.place }))} onPick={(_, index) => onJump(recent[index].delta)} />
      )}
      {menu?.kind === 'top' && (
        <PlaceMenu anchor={anchors.current.top} label="Верхние места" current={trail.length ? stepPlace(0) : null} onClose={() => setMenu(null)}
          load={async () => topPlaces(catalog).map((item) => ({ place: item }))} onPick={(next) => onOpen(next)} />
      )}
      {menu?.kind === 'crumb' && (
        <PlaceMenu anchor={anchors.current[`crumb${menu.index}`]} label={`Подпапки: ${trail[menu.index].name}`}
          current={trail[menu.index + 1] ? stepPlace(menu.index + 1) : null} onClose={() => setMenu(null)}
          load={() => crumbList(menu.index)} onPick={(next) => onOpen(next)} />
      )}
    </div>
  );
}
