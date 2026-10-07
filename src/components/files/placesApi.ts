/**
 * Подпапки места через мост: для списков у стрелок крошек, подсказок пути и
 * дерева. Один способ спросить, а не три — иначе правила «что считать
 * вложенной папкой» (черновики, ссылки, скрытое) разошлись бы между ними.
 */
import { windowsFilesRequest, type WindowsFileRef, type WindowsFolderNode } from '../../lib/windowsFiles';
import { childPlace, placeForRoot, type Place, type PlaceCatalog } from './places';

type ChildrenAnswer = { folders: WindowsFolderNode[]; truncated: boolean };

/** Подпапки папки; null — мост отказал (нет папки, нет прав). `peek` добавляет «есть ли внутри папки» для стрелок дерева. */
export async function listFolders(ref: WindowsFileRef, peek = false): Promise<WindowsFolderNode[] | null> {
  const answer = await windowsFilesRequest<ChildrenAnswer>({ action: 'children', ref, peek });
  return answer.ok ? answer.data.folders : null;
}

/** Тома, чьи корни сетевые, — для «Сети» и списка у её стрелки. */
export const networkRootIds = (catalog: PlaceCatalog): string[] => [...new Set([
  ...catalog.volumes.filter((volume) => volume.kind === 'network').map((volume) => volume.root.id),
  ...catalog.roots.filter((root) => root.network).map((root) => root.id),
])];

/** Диски «Этого компьютера» и подключённые папки, не относящиеся ни к облаку, ни к известным местам, ни к сети. */
export function computerPlaces(catalog: PlaceCatalog): Place[] {
  const disks = catalog.volumes.filter((volume) => volume.kind !== 'network').map((volume) => placeForRoot(volume.root.id, catalog));
  const taken = new Set([...catalog.volumes.map((volume) => volume.root.id), ...catalog.cloud.map((item) => item.root.id), ...networkRootIds(catalog)]);
  const custom = catalog.roots.filter((root) => root.kind === 'custom' && root.available && !taken.has(root.id)).map((root) => placeForRoot(root.id, catalog));
  return [...disks, ...custom];
}

export const networkPlaces = (catalog: PlaceCatalog): Place[] => networkRootIds(catalog).map((rootId) => placeForRoot(rootId, catalog));

/** Что лежит «внутри» места — для списка у стрелки крошки. Home ничего не раскрывает. */
export async function placeChildren(place: Place, catalog: PlaceCatalog): Promise<Place[]> {
  if (place.kind === 'computer') return computerPlaces(catalog);
  if (place.kind === 'network') return networkPlaces(catalog);
  if (place.kind === 'home' || !place.ref) return [];
  const folders = await listFolders(place.ref);
  return (folders ?? []).map((folder) => childPlace(place, folder));
}
