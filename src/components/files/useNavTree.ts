import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onWindowsFilesChanged, type WindowsFileRef } from '../../lib/windowsFiles';
import { listFolders } from './placesApi';
import { buildRows, expandChain, type Kids } from './navTree';
import { placeKey, refKey, type Place, type PlaceCatalog } from './places';
import type { WindowsQuickAccessItem } from '../../lib/windowsFiles';

/**
 * Состояние дерева панели навигации: что раскрыто и какие папки уже прочитаны.
 *
 * Папки читаются лениво, по одной ветви, и один раз: свёрнутая и раскрытая
 * снова ветвь не ходит на диск. Исключение — изменение извне: наблюдатель
 * моста сообщает, где что-то создали или убрали, и прочитанная ветвь с этим
 * местом перечитывается. Открытое место раскрывает дерево до себя само.
 */
export function useNavTree(current: Place | null, catalog: PlaceCatalog, quick: WindowsQuickAccessItem[], quickSupported: boolean) {
  // «Этот компьютер» раскрыт с самого начала — так на эталоне, и так человек сразу видит диски
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['computer']));
  const [kids, setKids] = useState<Record<string, Kids>>({});
  const refs = useRef(new Map<string, WindowsFileRef>());
  const kidsRef = useRef(kids); kidsRef.current = kids;

  const load = useCallback(async (key: string, ref: WindowsFileRef, quiet = false) => {
    refs.current.set(key, ref);
    if (!quiet) setKids((old) => old[key]?.status === 'done' ? old : { ...old, [key]: { status: 'loading' } });
    const folders = await listFolders(ref, true);
    setKids((old) => ({ ...old, [key]: folders ? { status: 'done', folders } : { status: 'error' } }));
  }, []);

  const open = useCallback((key: string, ref?: WindowsFileRef) => {
    setExpanded((old) => old.has(key) ? old : new Set(old).add(key));
    if (ref && kidsRef.current[key]?.status !== 'done') void load(key, ref);
  }, [load]);
  const toggle = useCallback((key: string, ref?: WindowsFileRef) => {
    setExpanded((old) => { const next = new Set(old); if (next.has(key)) next.delete(key); else next.add(key); return next; });
    if (ref && kidsRef.current[key]?.status !== 'done') void load(key, ref);
  }, [load]);

  // Открытое место: раскрыть всё, что над ним. Ключ места, а не сам объект — иначе эффект гонялся бы за каждым новым массивом
  const chainKey = current ? placeKey(current) : '';
  const catalogKey = `${catalog.roots.length}|${catalog.volumes.length}|${catalog.cloud.length}`;
  useEffect(() => {
    if (!current) return;
    for (const step of expandChain(current, catalog)) open(step.key, step.ref);
  }, [chainKey, catalogKey, open]);

  // Изменение извне: ветвь, в которой что-то создали или убрали, перечитывается тихо
  useEffect(() => onWindowsFilesChanged((change) => {
    const parent = change.relativePath.split('/').slice(0, -1).join('/');
    for (const [key, ref] of refs.current) {
      if (ref.rootId === change.rootId && (ref.relativePath === parent || ref.relativePath === change.relativePath)) void load(key, ref, true);
    }
  }), [load]);

  const rows = useMemo(() => buildRows({ catalog, quick, quickSupported, kids, expanded, current }), [catalog, quick, quickSupported, kids, expanded, current]);
  return { rows, expanded, toggle, open, refresh: (ref: WindowsFileRef) => load(refKey(ref), ref, true) };
}
