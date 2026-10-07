import React from 'react';
import Popover from '../Popover';
import PlaceIcon from './PlaceIcon';
import { placeKey, type Place } from './places';
import { FONT_STACK } from './explorerTheme';

/**
 * Список мест у кнопки: подпапки звена крошки, верхние места у первой
 * стрелки, недавние места у «Назад». Один компонент на все три, потому что
 * это один и тот же жест — «покажи куда отсюда можно пойти» — и выглядеть он
 * обязан одинаково.
 *
 * Места приходят готовыми или обещанием: подпапки читаются с диска, и
 * пока мост отвечает, список показывает «Загрузка…», а не пустоту.
 */
export default function PlaceMenu({ anchor, label, load, current, onPick, onClose }: {
  anchor: HTMLElement | null;
  label: string;
  /** Откуда взять места; у недавних — готовый список, у подпапок — запрос к мосту */
  load: () => Promise<{ place: Place; hint?: string }[]>;
  /** Место, которое уже открыто: отмечается в списке */
  current?: Place | null;
  onPick: (place: Place, index: number) => void;
  onClose: () => void;
}) {
  const [items, setItems] = React.useState<{ place: Place; hint?: string }[] | null>(null);
  React.useEffect(() => {
    let active = true;
    load().then((list) => { if (active) setItems(list); }).catch(() => { if (active) setItems([]); });
    return () => { active = false; };
  }, []);
  return (
    <Popover anchor={anchor} label={label} onClose={onClose}>
      <div role="listbox" aria-label={label} style={{ fontFamily: FONT_STACK }} className="max-h-80 min-w-[200px] max-w-[320px] overflow-y-auto scrollbar-thin">
        {items === null && <div className="px-3 py-2 text-xs opacity-70">Загрузка…</div>}
        {items?.length === 0 && <div className="px-3 py-2 text-xs opacity-70">Нет вложенных папок</div>}
        {items?.map(({ place, hint }, index) => (
          <button key={`${placeKey(place)}-${index}`} type="button" role="option" aria-selected={!!current && placeKey(current) === placeKey(place)}
            onClick={() => { onClose(); onPick(place, index); }} className="fx-menu-item">
            <PlaceIcon kind={place.kind} name={place.name} fileRef={place.ref} size={16} />
            <span className={`flex-1 truncate ${current && placeKey(current) === placeKey(place) ? 'font-semibold' : ''}`}>{place.name}</span>
            {hint && <span className="shrink-0 text-xs opacity-60">{hint}</span>}
          </button>
        ))}
      </div>
    </Popover>
  );
}
