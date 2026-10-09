import React from 'react';
import { FolderPlus } from 'lucide-react';
import PlaceIcon from './PlaceIcon';
import { listFolders } from './placesApi';
import { windowsFilesRequest, type WindowsFileRef } from '../../lib/windowsFiles';
import {
  childPlace, parseTypedPath, pathText, placeForRoot, placeForRef, topPlaces, volumeTitle, walkPlace,
  type Place, type PlaceCatalog, type TypedPath,
} from './places';
import { X as T } from './explorerTheme';

/**
 * Адрес текстом: Ctrl+L, Alt+D, F4 или щелчок по пустому месту поля.
 *
 * Принимает «C:\папка», «\\сервер\ресурс\папка» и имена мест. Пока человек
 * печатает, внизу — подсказки: подпапки того, что уже набрано. Путь вне
 * подключённых мест не открывается молча и не отвергается словом «ошибка»:
 * предлагается подключить папку — интерфейс не получает произвольного места
 * диска по строке, это граница моста безопасности.
 */

const OUTSIDE_WORDS: Record<Exclude<TypedPath, { kind: 'empty' } | { kind: 'place' }>['reason'], string> = {
  drive: 'Такого диска нет среди подключённых.',
  network: 'Сетевой папки с таким адресом нет среди подключённых.',
  env: 'Этот адрес с переменной не удалось открыть в подключённых папках.',
  unknown: 'Этого места нет среди подключённых.',
};

/** Подсказки для набранного: подпапки родителя, у которых имя начинается с набранного хвоста. */
export async function suggestPlaces(text: string, catalog: PlaceCatalog): Promise<Place[]> {
  const normal = text.replace(/\//g, '\\');
  const cut = normal.lastIndexOf('\\');
  const prefix = (cut < 0 ? normal : normal.slice(cut + 1)).toLocaleLowerCase('ru');
  if (cut < 0) {
    // Ещё нет ни одного звена: предлагаем места верхнего уровня и диски — по имени и по букве
    if (!prefix) return [];
    const lower = (value: string) => value.toLocaleLowerCase('ru');
    const named = topPlaces(catalog).filter((place) => lower(place.name).startsWith(prefix));
    const disks = catalog.volumes.filter((volume) => lower(volume.letter || '').startsWith(prefix) || lower(volumeTitle(volume)).startsWith(prefix))
      .map((volume) => placeForRoot(volume.root.id, catalog));
    return [...named, ...disks].slice(0, 8);
  }
  const parent = parseTypedPath(normal.slice(0, cut + 1) || normal, catalog);
  if (parent.kind !== 'place') return [];
  const walked = await walkPlace(parent.place, parent.rest, catalog, (ref) => listFolders(ref));
  if (!('place' in walked) || !walked.place.ref) return [];
  const folders = await listFolders(walked.place.ref);
  return (folders ?? []).filter((folder) => folder.name.toLocaleLowerCase('ru').startsWith(prefix)).slice(0, 8).map((folder) => childPlace(walked.place, folder));
}

export default function AddressInput({ place, catalog, onOpen, onCancel, onConnect }: {
  place: Place; catalog: PlaceCatalog;
  onOpen: (place: Place) => void; onCancel: () => void;
  /** Человек согласился подключить папку: окно выбора и перечитывание мест — снаружи */
  onConnect: () => void;
}) {
  const [text, setText] = React.useState(pathText(place));
  const [hints, setHints] = React.useState<Place[]>([]);
  const [chosen, setChosen] = React.useState(-1);
  const [notice, setNotice] = React.useState<{ kind: 'outside'; reason: keyof typeof OUTSIDE_WORDS } | { kind: 'missing'; name: string } | null>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const version = React.useRef(0);

  React.useEffect(() => { input.current?.focus(); input.current?.select(); }, []);

  const typed = (value: string) => {
    setText(value); setNotice(null); setChosen(-1);
    const mine = ++version.current;
    // Подсказки считает мост, поэтому берём только ответ на последнее набранное
    void suggestPlaces(value, catalog).then((list) => { if (mine === version.current) setHints(list); });
  };

  const submit = async (value: string) => {
    let parsed = parseTypedPath(value, catalog);
    const relative = value.trim().replace(/^"(.*)"$/, '$1').replace(/\//g, '\\');
    // Относительный адрес считается от открытой папки, сохраняя проверку подключённых корней.
    if (place.ref && relative && !/^(?:[a-zа-я]:|\\)|%[^%]+%/i.test(relative)
      && (parsed.kind === 'empty' || (parsed.kind === 'outside' && parsed.reason === 'unknown'))) {
      parsed = parseTypedPath(`${pathText(place)}\\${relative}`, catalog);
    }
    if (parsed.kind === 'empty') { onCancel(); return; }
    if (parsed.kind === 'outside') {
      if (parsed.reason === 'env') {
        const answer = await windowsFilesRequest<WindowsFileRef | null>({ action: 'resolveAddress', text: relative });
        if (answer.ok && answer.data) { onOpen(placeForRef(answer.data, catalog)); return; }
      }
      setNotice({ kind: 'outside', reason: parsed.reason }); return;
    }
    const walked = await walkPlace(parsed.place, parsed.rest, catalog, (ref) => listFolders(ref));
    if (!('place' in walked)) { setNotice({ kind: 'missing', name: walked.missing }); return; }
    onOpen(walked.place);
  };

  const pick = (offset: number) => {
    if (!hints.length) return;
    const next = (chosen + offset + hints.length) % hints.length;
    setChosen(next); setText(pathText(hints[next]));
  };

  return (
    <div className="relative flex h-full min-w-0 flex-1 items-center">
      <PlaceIcon kind={place.kind} name={place.name} fileRef={place.ref} size={16} className="ml-3 mr-2" />
      <input ref={input} value={text} aria-label="Адрес" spellCheck={false} autoComplete="off" role="combobox" aria-expanded={hints.length > 0}
        onChange={(e) => typed(e.target.value)}
        onBlur={(e) => { if (!e.relatedTarget || !(e.currentTarget.parentElement?.contains(e.relatedTarget as Node))) onCancel(); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); void submit(text); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); pick(1); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); pick(-1); }
        }}
        className={`h-full min-w-0 flex-1 bg-transparent pr-3 text-[14px] outline-none ${T.text}`} />
      {(hints.length > 0 || notice) && (
        <div className={`absolute left-0 right-0 top-[calc(100%+4px)] z-30 rounded-lg py-1 text-sm shadow-md ${T.menu} ${T.text}`}>
          {hints.map((hint, index) => (
            <button key={`${hint.ref?.relativePath ?? hint.kind}-${index}`} type="button" role="option" aria-selected={index === chosen}
              onMouseDown={(e) => e.preventDefault()} onClick={() => void submit(pathText(hint))}
              className={`flex h-8 w-full items-center gap-2 px-3 text-left ${index === chosen ? T.paneSelected : T.paneHover}`}>
              <PlaceIcon kind={hint.kind} name={hint.name} fileRef={hint.ref} size={16} />
              <span className="truncate">{pathText(hint)}</span>
            </button>
          ))}
          {notice && (
            <div role="alert" className="px-3 py-2">
              <div>{notice.kind === 'missing' ? `Не удаётся найти «${notice.name}». Проверьте правильность написания и повторите попытку.` : `${OUTSIDE_WORDS[notice.reason]} Чтобы открыть эту папку, подключите её.`}</div>
              {notice.kind === 'outside' && (
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={onConnect}
                  className="mt-2 flex h-8 items-center gap-2 rounded border border-[#d6d6d6] px-3 text-xs dark:border-[#4a4a4a]">
                  <FolderPlus width={14} height={14} />Подключить папку…
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
