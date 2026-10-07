/**
 * Место, в котором открыт Проводник, и путь до него — без React.
 *
 * Место — это либо виртуальный узел (Главная, Этот компьютер, Сеть), либо папка
 * Windows, заданная capability `{rootId, relativePath, draftId?}`. Рядом лежит
 * цепочка `trail`: от самого верха (Этот компьютер → диск → папка) до этого
 * места. Её читают крошки адресной строки, вкладки и текстовый путь.
 *
 * Цепочку приходится хранить, а не выводить из пути, из-за папок-черновиков:
 * у предка черновика свой `draftId`, и по относительному пути он не узнаётся.
 * Пока человек спускается по папкам, цепочка наращивается (`childPlace`) и
 * сохраняет эти номера; только место, открытое «снаружи» (Быстрый доступ,
 * введённый путь), строится по пути (`placeForRef`) без номеров предков.
 *
 * Интерфейс не получает абсолютных путей: «C:\Users\…» в тексте — это имя тома
 * и относительный путь, а не путь на диске. Введённый текст разбирается так же
 * в обратную сторону (`parseTypedPath`).
 */
import type {
  WindowsCloudRoot, WindowsFolderNode, WindowsFileRef, WindowsRoot, WindowsVolume,
} from '../../lib/windowsFiles';

export type PlaceKind = 'home' | 'computer' | 'network' | 'folder';

export interface TrailStep {
  name: string;
  kind: PlaceKind;
  ref?: WindowsFileRef;
  /** Как звено пишется в текстовом пути: у диска — «C:», у остальных — имя */
  text?: string;
}

export interface Place { kind: PlaceKind; name: string; ref?: WindowsFileRef; trail: TrailStep[] }

/** Что известно о подключённых местах: по этому списку папка получает своё имя и верх цепочки. */
export interface PlaceCatalog { roots: WindowsRoot[]; volumes: WindowsVolume[]; cloud: WindowsCloudRoot[] }
export const EMPTY_CATALOG: PlaceCatalog = { roots: [], volumes: [], cloud: [] };

const step = (name: string, kind: PlaceKind, ref?: WindowsFileRef, text?: string): TrailStep => ({ name, kind, ...(ref ? { ref } : {}), ...(text ? { text } : {}) });
const virtual = (kind: PlaceKind, name: string): Place => ({ kind, name, trail: [step(name, kind)] });

export const HOME: Place = virtual('home', 'Главная');
export const COMPUTER: Place = virtual('computer', 'Этот компьютер');
export const NETWORK: Place = virtual('network', 'Сеть');

export const placeFromTrail = (trail: TrailStep[]): Place => {
  const last = trail[trail.length - 1];
  return { kind: last.kind, name: last.name, ...(last.ref ? { ref: last.ref } : {}), trail };
};

/** Один и тот же ключ у одного и того же места: по нему сверяют «текущее» и дерево. Номер черновика в ключ не входит — на одном пути черновик и настоящая папка не живут. */
export const placeKey = (place: Place | null | undefined): string => {
  if (!place) return '';
  return place.ref ? `folder\u0000${place.ref.rootId}\u0000${place.ref.relativePath}` : place.kind;
};
export const refKey = (ref: WindowsFileRef) => `folder\u0000${ref.rootId}\u0000${ref.relativePath}`;

type RootInfo = { root: WindowsRoot; volume?: WindowsVolume };
function rootInfo(rootId: string, catalog: PlaceCatalog): RootInfo | null {
  const volume = catalog.volumes.find((item) => item.root.id === rootId);
  if (volume) return { root: volume.root, volume };
  const root = catalog.roots.find((item) => item.id === rootId) || catalog.cloud.find((item) => item.root.id === rootId)?.root;
  return root ? { root } : null;
}

/** Имя тома, как в Проводнике: «Локальный диск (C:)». Мост кладёт его в name; без него собираем из метки и буквы. */
export const volumeTitle = (volume: WindowsVolume) => volume.name || `${volume.label || 'Локальный диск'}${volume.letter ? ` (${volume.letter})` : ''}`;
const isNetwork = (info: RootInfo) => info.volume ? info.volume.kind === 'network' : !!info.root.network;

/** Звено для корня: с «Этим компьютером» или «Сетью» впереди, если корень — диск. */
function rootTrail(info: RootInfo | null, rootId: string): TrailStep[] {
  if (!info) return [step('Папка', 'folder', { rootId, relativePath: '' })];
  const ref = { rootId, relativePath: '' };
  if (info.volume) {
    const head = isNetwork(info) ? NETWORK.trail[0] : COMPUTER.trail[0];
    return [head, step(volumeTitle(info.volume), 'folder', ref, info.volume.letter || undefined)];
  }
  return [...(isNetwork(info) ? [NETWORK.trail[0]] : []), step(info.root.name, 'folder', ref)];
}

/** Место по capability: цепочка строится по пути, номера черновиков предков неизвестны. */
export function placeForRef(ref: WindowsFileRef, catalog: PlaceCatalog): Place {
  const trail = rootTrail(rootInfo(ref.rootId, catalog), ref.rootId);
  const parts = ref.relativePath.split('/').filter(Boolean);
  parts.forEach((name, index) => {
    const last = index === parts.length - 1;
    trail.push(step(name, 'folder', { rootId: ref.rootId, relativePath: parts.slice(0, index + 1).join('/'), ...(last && ref.draftId ? { draftId: ref.draftId } : {}) }));
  });
  return placeFromTrail(trail);
}

export const placeForRoot = (rootId: string, catalog: PlaceCatalog): Place => placeForRef({ rootId, relativePath: '' }, catalog);

/** Шаг вниз по папкам: цепочка наследуется, номер черновика берётся у самой папки. */
export function childPlace(parent: Place, folder: { name: string; relativePath: string; draftId?: string }, _catalog?: PlaceCatalog): Place {
  // Из виртуального места (Этот компьютер) вниз идут не папки, а диски: их открывают через placeForRoot
  if (!parent.ref) return parent;
  const ref: WindowsFileRef = { rootId: parent.ref.rootId, relativePath: folder.relativePath, ...(folder.draftId ? { draftId: folder.draftId } : {}) };
  return placeFromTrail([...parent.trail, step(folder.name, 'folder', ref)]);
}

/** Куда ведёт «Вверх». У Главной и у корня без верха (Рабочий стол) — никуда: объемлющей папки интерфейс не знает. */
export const parentPlace = (place: Place): Place | null => place.trail.length > 1 ? placeFromTrail(place.trail.slice(0, -1)) : null;

/** Только ли «Вверх» возможен — для приглушения кнопки. */
export const canGoUp = (place: Place) => place.trail.length > 1;

/** Путь для строки ввода: «C:\Users\Анна», «Рабочий стол\Проекты». У виртуальных мест — их имя. */
export function pathText(place: Place): string {
  const real = place.trail.filter((item) => item.kind === 'folder');
  if (!real.length) return place.name;
  return real.map((item) => item.text || item.name).join('\\');
}

/** Верхние места для списка у первой стрелки и для подсказок: Главная, известные папки, этот компьютер, сеть. */
export function topPlaces(catalog: PlaceCatalog): Place[] {
  const known = catalog.roots.filter((root) => root.kind !== 'custom' && root.available).map((root) => placeForRoot(root.id, catalog));
  return [HOME, ...known, COMPUTER, NETWORK];
}

// --- Введённый путь ---------------------------------------------------------

export type TypedPath =
  | { kind: 'empty' }
  /** Путь вне подключённых мест: молча не открывается, предлагается подключить папку */
  | { kind: 'outside'; reason: 'drive' | 'network' | 'env' | 'unknown' }
  /** `place` разобрано до корня; `rest` — звенья, которые ещё надо найти на диске по именам */
  | { kind: 'place'; place: Place; rest: string[] };

const same = (a: string, b: string) => a.localeCompare(b, 'ru', { sensitivity: 'base' }) === 0;
const norm = (value: string) => value.toLocaleLowerCase('ru');

/**
 * Разбор строки, которую набрал человек. Принимает «C:\папка», «\\сервер\ресурс\папка»,
 * имена мест («Рабочий стол\Проекты», «Этот компьютер»). Подстановки вида %USERPROFILE%
 * не раскрываются: значения переменных знает только main, а интерфейсу они не выдаются.
 */
export function parseTypedPath(input: string, catalog: PlaceCatalog): TypedPath {
  const text = input.trim().replace(/^"(.*)"$/, '$1').trim();
  if (!text) return { kind: 'empty' };
  if (/%[^%]+%/.test(text)) return { kind: 'outside', reason: 'env' };
  const slashes = text.replace(/\//g, '\\');
  const unc = slashes.startsWith('\\\\');
  const parts = slashes.replace(/^\\+/, '').split('\\').filter((part) => part !== '');

  // «.» и «..»: считаются на месте. Выйти выше корня нельзя — это уже «вне мест»
  const rest: string[] = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') { if (!rest.length) return { kind: 'outside', reason: 'unknown' }; rest.pop(); continue; }
    rest.push(part);
  }
  if (!rest.length) return { kind: 'empty' };

  const [head, ...tail] = rest;
  if (unc) {
    // \\сервер\ресурс\…: ищем сетевой том или сетевую папку, чей путь — начало набранного
    const typed = norm(`\\\\${rest.join('\\')}`);
    const hit = catalog.volumes
      .filter((volume) => volume.kind === 'network' && volume.networkPath)
      .map((volume) => ({ volume, base: norm(volume.networkPath!.replace(/\\+$/, '')) }))
      .filter(({ base }) => typed === base || typed.startsWith(`${base}\\`))
      .sort((a, b) => b.base.length - a.base.length)[0];
    if (!hit) return { kind: 'outside', reason: 'network' };
    const depth = hit.volume.networkPath!.replace(/\\+$/, '').split('\\').filter(Boolean).length;
    return { kind: 'place', place: placeForRoot(hit.volume.root.id, catalog), rest: rest.slice(depth) };
  }
  const letter = /^([a-zA-Zа-яА-Я]):$/.exec(head);
  if (letter) {
    const volume = catalog.volumes.find((item) => item.letter && same(item.letter, head));
    return volume ? { kind: 'place', place: placeForRoot(volume.root.id, catalog), rest: tail } : { kind: 'outside', reason: 'drive' };
  }
  if (same(head, COMPUTER.name)) {
    if (!tail.length) return { kind: 'place', place: COMPUTER, rest: [] };
    return parseTypedPath(tail.join('\\'), catalog);
  }
  if (same(head, NETWORK.name)) return { kind: 'place', place: NETWORK, rest: [] };
  if (same(head, HOME.name) && !tail.length) return { kind: 'place', place: HOME, rest: [] };
  // Имя тома («Новый том (D:)») и имя корня («Рабочий стол», «Яндекс Диск»)
  const volume = catalog.volumes.find((item) => same(volumeTitle(item), head));
  if (volume) return { kind: 'place', place: placeForRoot(volume.root.id, catalog), rest: tail };
  const root = catalog.roots.find((item) => same(item.name, head)) || catalog.cloud.find((item) => same(item.name, head))?.root;
  if (root) return { kind: 'place', place: placeForRoot(root.id, catalog), rest: tail };
  return { kind: 'outside', reason: 'unknown' };
}

export type WalkResult = { ok: true; place: Place } | { ok: false; missing: string; at: Place };

/**
 * Дойти по звеньям от разобранного места, сверяя имена с настоящими подпапками.
 * Регистр берётся с диска (Windows его не различает, а крошки должны писаться как
 * в самой папке), номер черновика — у найденной подпапки.
 */
export async function walkPlace(base: Place, rest: string[], catalog: PlaceCatalog, children: (ref: WindowsFileRef) => Promise<WindowsFolderNode[] | null>): Promise<WalkResult> {
  let place = base;
  for (const name of rest) {
    if (!place.ref) return { ok: false, missing: name, at: place };
    const folders = await children(place.ref);
    const found = folders?.find((folder) => same(folder.name, name));
    if (!found) return { ok: false, missing: name, at: place };
    place = childPlace(place, found, catalog);
  }
  return { ok: true, place };
}
