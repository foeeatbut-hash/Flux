/**
 * Что инженер сделал на холсте: формат листа, где стоят блоки, какие узлы
 * отмечены в выгрузку. Хранится на сервере за проектом (настройка проекта со
 * своей версией, как профиль): раскладку видят все, кто работает над схемой, и
 * она не пропадает с компьютером. Браузерная копия — запасная: пока сервер не
 * ответил, и для тех, у кого нет права вести схему (право `e3.export`).
 * Запись отложена на секунду, чтобы перетаскивание не слало запрос на каждый
 * шаг; чужая правка (409) — серверная раскладка принимается как есть.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { E3Rect } from '../../../e3/bridgeTypes';
import { DEFAULT_FORMAT } from '../../../e3/sheetFormats';
import { e3SolutionsService } from '../../services/e3SolutionsService';
import { onE3Changed } from '../../lib/e3Changed';

export interface Placed { rect: E3Rect; manual: boolean }
export interface SchemeSaved { format: string; placed: Record<string, Placed>; /** Снятые флажки «брать в выгрузку» */ off: Record<string, true> }

const keyOf = (projectId: string) => `flux_e3_scheme:${encodeURIComponent(projectId)}`;
const empty = (): SchemeSaved => ({ format: DEFAULT_FORMAT, placed: {}, off: {} });
const DELAY = 800;

function read(projectId: string): SchemeSaved | null {
  try {
    const raw = localStorage.getItem(keyOf(projectId));
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' && v.placed && typeof v.placed === 'object' ? { ...empty(), ...v } : null;
  } catch (_) { return null; }
}

export function useSchemeState(projectId: string, canSave: boolean) {
  const [saved, setSaved] = useState<SchemeSaved | null>(() => read(projectId));
  // Серверная раскладка прочитана (или недоступна): до этого автораскладка не запускается, иначе она перебила бы чужую
  const [ready, setReady] = useState(false);
  const version = useRef(0);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saving = useRef(false);

  // Серверная раскладка главнее браузерной копии: она общая
  useEffect(() => {
    let alive = true;
    e3SolutionsService.layout(projectId).then((doc) => {
      if (!alive) return;
      version.current = doc.version;
      if (doc.version > 0) setSaved({ format: doc.format || DEFAULT_FORMAT, placed: doc.placed, off: doc.off });
      setReady(true);
    }).catch(() => { if (alive) setReady(true); /* сервера нет или нет доступа — остаётся браузерная копия */ });
    return () => { alive = false; };
  }, [projectId]);

  useEffect(() => onE3Changed((detail) => {
    if (detail?.entity !== 'layout' || (detail.projectId && detail.projectId !== projectId)) return;
    // Не заменяем локальное перетаскивание, пока оно ожидает debounce или запись.
    if (dirty.current || timer.current || saving.current) return;
    e3SolutionsService.layout(projectId).then((doc) => {
      if (dirty.current || timer.current || saving.current) return;
      version.current = doc.version;
      if (doc.version > 0) setSaved({ format: doc.format || DEFAULT_FORMAT, placed: doc.placed, off: doc.off });
    }).catch(() => undefined);
  }), [projectId]);

  const flush = useCallback(async (value: SchemeSaved) => {
    try { localStorage.setItem(keyOf(projectId), JSON.stringify(value)); } catch (_) { /* без хранилища раскладка живёт до закрытия окна */ }
    if (!canSave) return;
    saving.current = true;
    try {
      const doc = await e3SolutionsService.saveLayout(projectId, value, version.current);
      version.current = doc.version;
    } catch (_) {
      // Коллега успел записать раньше (или сервер недоступен): берём серверную, свою — в браузерной копии
      try { const doc = await e3SolutionsService.layout(projectId); version.current = doc.version; if (doc.version > 0) setSaved({ format: doc.format || DEFAULT_FORMAT, placed: doc.placed, off: doc.off }); } catch (__) { /* остаётся как есть */ }
    } finally { saving.current = false; }
  }, [projectId, canSave]);

  useEffect(() => {
    if (!dirty.current || !saved) return;
    dirty.current = false;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = undefined; void flush(saved); }, DELAY);
  }, [saved, flush]);

  const update = useCallback((fn: (s: SchemeSaved) => SchemeSaved) => { dirty.current = true; setSaved((s) => fn(s || empty())); }, []);
  return { saved, update, ready };
}
