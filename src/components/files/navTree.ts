/**
 * Строки панели навигации как данные: что показано сверху вниз, что раскрыто и
 * какая строка подсвечена. Без React — правила порядка и подсветки проверяются
 * скриптом (scripts/test-explorer-shell.ts), а разметка только рисует строки.
 *
 * Порядок — как в Проводнике Windows 11, без «Галереи» (решение владельца):
 * Главная; закреплённые (Быстрый доступ Windows); облачные папки; Этот
 * компьютер; Сеть.
 */
import type { WindowsFileRef, WindowsFolderNode, WindowsQuickAccessItem } from '../../lib/windowsFiles';
import { computerPlaces, networkPlaces } from './placesApi';
import { HOME, COMPUTER, NETWORK, childPlace, placeForRef, placeForRoot, placeKey, refKey, type Place, type PlaceCatalog } from './places';

export type Kids = { status: 'loading' } | { status: 'error' } | { status: 'done'; folders: WindowsFolderNode[] };

export interface NavRow {
  key: string;
  kind: 'row' | 'sep';
  depth: number;
  label: string;
  place?: Place;
  /** Что читать с диска при раскрытии; у Этого компьютера и Сети — ничего, их дети известны из каталога */
  ref?: WindowsFileRef;
  expandable: boolean;
  expanded: boolean;
  loading: boolean;
  /** Булавка справа: папка закреплена в Быстром доступе Windows */
  pinned: boolean;
  /** Закреплённые и частые — ссылки без стрелки; ветви дерева — со стрелкой */
  quick: boolean;
  /** Папка-черновик: видна только во Flux, помечается */
  flux: boolean;
  /** Значок облачного корня, который отдал Windows; у остальных — значок по ссылке */
  icon: string | null;
  selected: boolean;
}

const KNOWN = new Set(['desktop', 'documents', 'downloads']);

/** Что раскрыть, чтобы показать место: верхние ветви и все папки-предки. Папка вне дерева (Рабочий стол) ничего не раскрывает. */
export function expandChain(place: Place, catalog: PlaceCatalog): { key: string; ref?: WindowsFileRef }[] {
  const out: { key: string; ref?: WindowsFileRef }[] = [];
  const root = place.ref ? catalog.roots.find((item) => item.id === place.ref!.rootId) : undefined;
  const taken = new Set([...catalog.volumes.map((volume) => volume.root.id), ...catalog.cloud.map((item) => item.root.id)]);
  // Подключённая папка не диск и не облако: живёт под «Этим компьютером»
  if (root && root.kind === 'custom' && !taken.has(root.id) && !root.network) out.push({ key: 'computer' });
  place.trail.slice(0, -1).forEach((step) => {
    if (step.kind === 'computer') out.push({ key: 'computer' });
    else if (step.kind === 'network') out.push({ key: 'network' });
    else if (step.ref) out.push({ key: refKey(step.ref), ref: { rootId: step.ref.rootId, relativePath: step.ref.relativePath, ...(step.ref.draftId ? { draftId: step.ref.draftId } : {}) } });
  });
  return out;
}

export function buildRows(input: {
  catalog: PlaceCatalog; quick: WindowsQuickAccessItem[]; quickSupported: boolean;
  kids: Record<string, Kids>; expanded: ReadonlySet<string>; current: Place | null;
}): NavRow[] {
  const { catalog, kids, expanded, current } = input;
  const rows: NavRow[] = [];
  const base = { expandable: false, expanded: false, loading: false, pinned: false, quick: false, flux: false, icon: null, selected: false };
  const sep = (key: string) => rows.push({ ...base, key, kind: 'sep', depth: 0, label: '' });

  // Подсвечивается первая подходящая строка: папка из Быстрого доступа не горит дважды — и в нём, и в дереве
  let marked = false;
  const mark = (place: Place | undefined) => {
    if (marked || !place || !current || placeKey(place) !== placeKey(current)) return false;
    marked = true; return true;
  };

  rows.push({ ...base, key: 'home', kind: 'row', depth: 0, label: HOME.name, place: HOME, selected: mark(HOME) });

  const quick = input.quickSupported
    ? input.quick.map((item) => ({ name: item.name, pinned: item.pinned, ref: item.ref }))
    : catalog.roots.filter((root) => KNOWN.has(root.kind) && root.available).map((root) => ({ name: root.name, pinned: true, ref: { rootId: root.id, relativePath: '' } }));
  if (quick.length) {
    sep('sep-quick');
    for (const item of quick) {
      const place = placeForRef(item.ref, catalog);
      rows.push({ ...base, key: `q:${refKey(item.ref)}`, kind: 'row', depth: 0, label: item.name, place, ref: item.ref, pinned: item.pinned, quick: true, selected: mark(place) });
    }
  }

  sep('sep-tree');

  /** Ветвь с папками: свои дети читаются с диска лениво и лежат в `kids` */
  const folderBranch = (key: string, label: string, place: Place, depth: number, icon: string | null = null, flux = false, hasChildren?: boolean) => {
    const open = expanded.has(key);
    const state = kids[key];
    const known = state?.status === 'done';
    const expandable = known ? state.folders.length > 0 : hasChildren !== false;
    rows.push({
      ...base, key, kind: 'row', depth, label, place, ref: place.ref, expandable, expanded: open && expandable,
      loading: open && state?.status === 'loading', icon, flux, selected: mark(place),
    });
    if (open && known) {
      for (const folder of state.folders) {
        const child = childPlace(place, folder);
        folderBranch(refKey(child.ref!), folder.name, child, depth + 1, null, folder.storage === 'flux', folder.hasChildren);
      }
    }
  };

  for (const cloud of catalog.cloud) folderBranch(refKey({ rootId: cloud.root.id, relativePath: '' }), cloud.name, placeForRoot(cloud.root.id, catalog), 0, cloud.icon);

  const computerOpen = expanded.has('computer');
  const disks = computerPlaces(catalog);
  rows.push({ ...base, key: 'computer', kind: 'row', depth: 0, label: COMPUTER.name, place: COMPUTER, expandable: disks.length > 0, expanded: computerOpen && disks.length > 0, selected: mark(COMPUTER) });
  if (computerOpen) for (const disk of disks) folderBranch(refKey(disk.ref!), disk.name, disk, 1);

  const shared = networkPlaces(catalog);
  const networkOpen = expanded.has('network');
  rows.push({ ...base, key: 'network', kind: 'row', depth: 0, label: NETWORK.name, place: NETWORK, expandable: shared.length > 0, expanded: networkOpen && shared.length > 0, selected: mark(NETWORK) });
  if (networkOpen) for (const item of shared) folderBranch(refKey(item.ref!), item.name, item, 1);

  return rows;
}
