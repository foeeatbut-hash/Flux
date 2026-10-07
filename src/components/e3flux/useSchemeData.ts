/**
 * Данные вкладки «Схема»: оборудование проекта, каталог решений, профиль и
 * справочник атрибутов — и узлы схемы, посчитанные из них. Модуль подбора и
 * состояния узла чистые, здесь только чтение и сборка. Связи с E3 пока нет
 * (моста нет), поэтому состояние узла считается с пустой связью.
 */
import { useEffect, useMemo, useState } from 'react';
import type { E3AttributeBook } from '../../../e3/attributes';
import { nodeState, type E3NodeStateId } from '../../../e3/nodeState';
import { selectSolution } from '../../../e3/solutionSelect';
import type { E3Profile, E3Selection, E3SolutionBook } from '../../../e3/solutionTypes';
import { e3AttributesService } from '../../services/e3AttributesService';
import { e3SolutionsService } from '../../services/e3SolutionsService';
import { buildExportSources, type ExportSystem } from '../../lib/exportWorkspace';
import type { ExchangeComponent } from '../../lib/equipmentExchange';
import { toPositions } from '../../lib/e3Positions';

export interface SchemeNode {
  /** Ключ узла: id позиции и номер среди её тегов — у позиции с четырьмя тегами четыре узла */
  id: string;
  label: string;
  name: string;
  cls: string;
  unitId: string;
  unitName: string;
  order: number;
  item: ExchangeComponent;
  selection: E3Selection;
  state: E3NodeStateId;
  twoLevel: boolean;
  /** В каталоге есть вариант выбранного решения «Влево» */
  hasLeft: boolean;
}
export interface SchemeUnit { id: string; name: string; nodes: SchemeNode[] }

export function useSchemeData(projectId: string) {
  const [systems, setSystems] = useState<ExportSystem[] | null>(null);
  const [book, setBook] = useState<E3SolutionBook | null>(null);
  const [profile, setProfile] = useState<E3Profile>({});
  const [attrs, setAttrs] = useState<E3AttributeBook | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setSystems(null); setError('');
    Promise.all([
      fetch(`/api/projects/${encodeURIComponent(projectId)}/systems`).then((r) => { if (!r.ok) throw new Error('Оборудование недоступно. Проверьте доступ к проекту'); return r.json(); }),
      e3SolutionsService.load(), e3SolutionsService.profile(projectId), e3AttributesService.load(),
    ]).then(([data, b, p, a]) => { if (alive) { setSystems(data.systems || []); setBook(b); setProfile(p.answers); setAttrs(a); } })
      .catch((e: any) => { if (alive) setError(e.message || 'Не удалось загрузить данные'); });
    return () => { alive = false; };
  }, [projectId]);

  const model = useMemo(() => {
    if (!systems || !book) return { units: [] as SchemeUnit[], skipped: 0 };
    const sources = buildExportSources(systems, []);
    const names = new Set(book.solutions.filter((s) => !s.removed).map((s) => s.name.toLocaleLowerCase('ru')));
    const units: SchemeUnit[] = [];
    let skipped = 0;
    for (const sys of systems) {
      const items = sources.rows(`unit:${sys.id}`);
      const positions = toPositions(items);
      const nodes: SchemeNode[] = [];
      items.forEach((it, i) => {
        const p = positions[i];
        // Типы без решения по природе (шумоглушитель, секция, двигатель внутри блока) в схему не входят
        if (!(book.classMap[p.cls] || []).length) { skipped++; return; }
        const selection = selectSolution(p, positions, book, profile);
        const sol = selection.solution;
        nodes.push({
          id: `${it.id}:${i}`, label: (it.tags || [])[0]?.identifier || '', name: String(it.name || ''), cls: p.cls, unitId: sys.id, unitName: sys.name,
          order: it.sourceOrder ?? i, item: it, selection, state: nodeState(selection), twoLevel: !!sol?.twoLevel,
          hasLeft: !!sol && names.has(`${sol.name}_влево`.toLocaleLowerCase('ru')),
        });
      });
      if (nodes.length) units.push({ id: sys.id, name: sys.name, nodes });
    }
    return { units, skipped };
  }, [systems, book, profile]);

  return { loading: !systems || !book || !attrs, error, book, attrs, profile, units: model.units, skipped: model.skipped };
}
