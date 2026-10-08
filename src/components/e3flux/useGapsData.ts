/**
 * Данные раздела «Нет данных»: справочник атрибутов, каталог решений, профиль и
 * позиции проекта — те же загрузки, что у соседних вкладок. Список живой: данные
 * перечитываются, когда в E3Flux что-то записали (`flux:e3-changed`), когда
 * изменилось оборудование (событие сокета), когда окно вернулось в фокус и раз
 * в минуту, пока вкладка на виду. Прежний список остаётся на экране, пока
 * идёт перечитывание, — он не мигает.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { E3AttributeBook } from '../../../e3/attributes';
import { collectGaps, type Gap, type GapPosition } from '../../../e3/gaps';
import type { E3Profile, E3SolutionBook } from '../../../e3/solutionTypes';
import { onE3Changed } from '../../lib/e3Changed';
import { buildGapPositions } from '../../lib/e3GapPositions';
import type { ExportSystem } from '../../lib/exportWorkspace';
import { e3AttributesService } from '../../services/e3AttributesService';
import { e3SolutionsService } from '../../services/e3SolutionsService';

const EVERY = 60_000;

export function useGapsData(projectId: string) {
  const [attributes, setAttributes] = useState<E3AttributeBook | null>(null);
  const [solutionBook, setSolutionBook] = useState<E3SolutionBook | null>(null);
  const [positions, setPositions] = useState<GapPosition[] | null>(null);
  const [profile, setProfile] = useState<E3Profile>({});
  const [error, setError] = useState('');
  const [loadedAt, setLoadedAt] = useState(0);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const [a, b, sys, prof] = await Promise.all([
        e3AttributesService.load(), e3SolutionsService.load(),
        projectId ? fetch(`/api/projects/${encodeURIComponent(projectId)}/systems`).then((r) => { if (!r.ok) throw new Error('Оборудование недоступно. Проверьте доступ к проекту'); return r.json(); }) : Promise.resolve(null),
        projectId ? e3SolutionsService.profile(projectId) : Promise.resolve(null),
      ]);
      if (mine !== seq.current) return; // пока читали, началось новое чтение — берём его
      setAttributes(a); setSolutionBook(b); setError('');
      setPositions(sys ? buildGapPositions((sys.systems || []) as ExportSystem[], a.items || []) : []);
      setProfile(prof?.answers || {});
      setLoadedAt(Date.now());
    } catch (e: any) { if (mine === seq.current) setError(e.message || 'Не удалось загрузить данные'); }
  }, [projectId]);

  useEffect(() => { setPositions(null); void reload(); }, [reload]);
  useEffect(() => {
    const again = () => { void reload(); };
    const visible = () => { if (document.visibilityState === 'visible') again(); };
    const off = onE3Changed(again);
    window.addEventListener('focus', again);
    window.addEventListener('socket:entity:changed', again);
    window.addEventListener('socket:tag:updated', again);
    document.addEventListener('visibilitychange', visible);
    const timer = window.setInterval(visible, EVERY);
    return () => {
      off(); window.removeEventListener('focus', again); window.removeEventListener('socket:entity:changed', again);
      window.removeEventListener('socket:tag:updated', again); document.removeEventListener('visibilitychange', visible); window.clearInterval(timer);
    };
  }, [reload]);

  const ready = !!attributes && !!solutionBook && (!projectId || positions !== null);
  const gaps: Gap[] = useMemo(() => (ready ? collectGaps({ attributes, solutionBook, positions: positions || [], profile }) : []), [ready, attributes, solutionBook, positions, profile]);
  return { gaps, ready, error, loadedAt, reload };
}
