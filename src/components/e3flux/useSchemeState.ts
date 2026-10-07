/**
 * Что инженер сделал на холсте: формат листа, где стоят блоки, какие узлы
 * отмечены в выгрузку. Серверного места для раскладки пока нет, поэтому она
 * хранится в браузере за проектом — это первый шаг: на другом компьютере
 * раскладка не видна. Когда появятся связи и выгрузки на сервере (этап E),
 * положение блоков уйдёт туда, а источником для выгруженного станет E3.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { E3Rect } from '../../../e3/bridgeTypes';
import { DEFAULT_FORMAT } from '../../../e3/sheetFormats';

export interface Placed { rect: E3Rect; manual: boolean }
export interface SchemeSaved { format: string; placed: Record<string, Placed>; /** Снятые флажки «брать в выгрузку» */ off: Record<string, true> }

const keyOf = (projectId: string) => `flux_e3_scheme:${encodeURIComponent(projectId)}`;
const empty = (): SchemeSaved => ({ format: DEFAULT_FORMAT, placed: {}, off: {} });

function read(projectId: string): SchemeSaved | null {
  try {
    const raw = localStorage.getItem(keyOf(projectId));
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' && v.placed && typeof v.placed === 'object' ? { ...empty(), ...v } : null;
  } catch (_) { return null; }
}

export function useSchemeState(projectId: string) {
  const [saved, setSaved] = useState<SchemeSaved | null>(() => read(projectId));
  // Что в хранилище, то и на экране: запись не должна ронять холст, если браузер её не принимает
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    try { if (saved) localStorage.setItem(keyOf(projectId), JSON.stringify(saved)); } catch (_) { /* без хранилища раскладка живёт до закрытия окна */ }
  }, [saved, projectId]);
  const update = useCallback((fn: (s: SchemeSaved) => SchemeSaved) => setSaved((s) => fn(s || empty())), []);
  return { saved, update };
}
