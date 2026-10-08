/**
 * Переход из раздела «Нет данных» на запись: вкладка, раздел и сама запись.
 * Номер `n` растёт с каждым переходом, чтобы повторный клик по той же ссылке
 * открывал запись снова; панель, которая приняла переход, гасит его (`done`),
 * иначе он сработал бы ещё раз при следующем открытии панели.
 */
import { useEffect } from 'react';
import type { GapWhere } from '../../../e3/gaps';

export interface E3Jump {
  n: number;
  tab: 'project' | 'book' | 'solutions';
  /** Раздел «Типовых решений»: solutions, features, rules, io, io-rules, classmap, selection */
  section?: string;
  id?: string;
  /** Тип Flux в виде «По типам» */
  cls?: string;
  positionId?: string;
}
export type JumpProps = { jump: E3Jump | null; done: () => void };

export function jumpFor(where: GapWhere, n: number): E3Jump {
  if ('positionId' in where) return where.view === 'attributes' ? { n, tab: 'project', section: 'project', positionId: where.positionId } : { n, tab: 'solutions', section: 'selection', positionId: where.positionId };
  return { n, ...where };
}

/**
 * Панель принимает переход: если он для одного из её разделов, применяет и
 * гасит его. `ready` — данные панели уже есть (иначе запись ещё не найти).
 */
export function useJump(p: Partial<JumpProps> | undefined, sections: string[], apply: (j: E3Jump) => void, ready = true): void {
  const jump = p?.jump;
  useEffect(() => {
    if (!jump || !ready || !p?.done || !jump.section || !sections.includes(jump.section)) return;
    apply(jump);
    p.done();
    // apply — только setState панели; зависеть от него не нужно
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump, ready]);
}
