import { useEffect, useMemo } from 'react';
import { usePlacesStore } from '../../store/placesStore';
import type { PlaceCatalog } from './places';

/** Каталог мест из общего хранилища; первое использование запускает чтение. Один объект на один набор данных — на него можно опираться в зависимостях эффектов. */
export function usePlaceCatalog() {
  const roots = usePlacesStore((s) => s.roots);
  const volumes = usePlacesStore((s) => s.volumes);
  const cloud = usePlacesStore((s) => s.cloud);
  const quick = usePlacesStore((s) => s.quick);
  const quickSupported = usePlacesStore((s) => s.quickSupported);
  const loaded = usePlacesStore((s) => s.loaded);
  const error = usePlacesStore((s) => s.error);
  useEffect(() => { void usePlacesStore.getState().load(); }, []);
  const catalog = useMemo<PlaceCatalog>(() => ({ roots, volumes, cloud }), [roots, volumes, cloud]);
  return { catalog, quick, quickSupported, loaded, error };
}
