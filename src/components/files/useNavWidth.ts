import { useCallback, useEffect, useState } from 'react';
import { windowsFilesRequest } from '../../lib/windowsFiles';
import { SIZE } from './explorerTheme';

/** Ширина панели навигации: 287 по эталону, тянется границей, запоминается через viewState. */
export const NAV_WIDTH_KEY = 'explorer.navWidth.v1';
export const NAV_MIN = 180;
export const NAV_MAX = 560;
export const clampNav = (value: number) => Math.min(NAV_MAX, Math.max(NAV_MIN, Math.round(value)));

export function useNavWidth(storageKey = NAV_WIDTH_KEY) {
  const [width, setWidth] = useState<number>(SIZE.navWidth);
  useEffect(() => {
    let active = true;
    void windowsFilesRequest<Record<string, unknown>>({ action: 'viewStateGet', keys: [storageKey] }).then((answer) => {
      const saved = answer.ok ? answer.data[storageKey] : undefined;
      // Сохранённому не доверяем вслепую: чужое значение не должно сделать панель нулевой
      if (active && typeof saved === 'number' && Number.isFinite(saved)) setWidth(clampNav(saved));
    });
    return () => { active = false; };
  }, [storageKey]);
  /** Запомнить: вызывается, когда человек отпустил границу, а не на каждом шаге мыши */
  const remember = useCallback((value: number) => { void windowsFilesRequest({ action: 'viewStateSet', entries: { [storageKey]: clampNav(value) } }); }, [storageKey]);
  return { width, setWidth: (value: number) => setWidth(clampNav(value)), remember };
}
