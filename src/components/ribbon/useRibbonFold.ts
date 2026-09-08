/**
 * Свёрнута ли лента — одно решение на все программы Flux Office.
 *
 * Раньше это состояние жило внутри каждого редактора и заводилось заново при
 * каждом открытии документа: человек сворачивал ленту, чтобы увидеть лист
 * целиком, закрывал документ — и в следующем она снова разворачивалась. Свёрнутая
 * лента возвращает листу 70 точек, и решать это каждый раз заново значит
 * отбирать их обратно.
 *
 * Хранится у сотрудника, а не в базе: это привычка рук, как размер значков на
 * столе, и у разных мониторов она разная.
 */
import { useCallback, useEffect, useState } from 'react';

const KEY = 'flux_ribbon_folded';
/** Свернули ленту в одном окне — остальные обязаны узнать в том же кадре */
const EVENT = 'flux:ribbon-fold';

const read = (): boolean => {
  try { return localStorage.getItem(KEY) === '1'; } catch (_) { return false; }
};

export function useRibbonFold(): [boolean, (v: boolean) => void] {
  const [folded, setFolded] = useState(read);

  useEffect(() => {
    const onFold = () => setFolded(read());
    window.addEventListener(EVENT, onFold);
    // Другое ОКНО браузера меняет то же значение: storage приходит только оттуда
    window.addEventListener('storage', onFold);
    return () => {
      window.removeEventListener(EVENT, onFold);
      window.removeEventListener('storage', onFold);
    };
  }, []);

  const set = useCallback((v: boolean) => {
    try { localStorage.setItem(KEY, v ? '1' : '0'); } catch (_) { /* приватный режим */ }
    setFolded(v);
    window.dispatchEvent(new CustomEvent(EVENT));
  }, []);

  return [folded, set];
}
