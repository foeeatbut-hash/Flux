/**
 * Данные вкладки «Схема»: оборудование проекта, каталог решений, профиль и
 * справочник атрибутов — и узлы схемы, посчитанные из них. Модуль подбора и
 * состояния узла чистые, здесь только чтение и сборка. Связи с E3 пока нет
 * (моста нет), поэтому состояние узла считается с пустой связью.
 */
import { useEffect, useMemo, useState } from 'react';
import { attributesForClass, type E3AttributeBook } from '../../../e3/attributes';
import { attrKey, type Binding, type ExportAttr } from '../../../e3/exportTypes';
import { nodeState, type E3NodeStateId } from '../../../e3/nodeState';
import { selectSolution } from '../../../e3/solutionSelect';
import type { E3Profile, E3Selection, E3SolutionBook } from '../../../e3/solutionTypes';
import { e3AttributesService } from '../../services/e3AttributesService';
import { e3SolutionsService } from '../../services/e3SolutionsService';
import { e3ExportService, type E3ExportInfo, type E3Link } from '../../services/e3ExportService';
import { buildExportSources, type ExportSystem } from '../../lib/exportWorkspace';
import { equipmentCell, type ExchangeComponent } from '../../lib/equipmentExchange';
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
  /** Атрибуты с «Да» и их значения сейчас — то, что уйдёт в E3 */
  attrs: ExportAttr[];
  /** Версия узла: решение, тег и значения; по ней видно «изменился после выгрузки» */
  version: string;
  /** Что отправлено в E3 в прошлый раз */
  binding?: Binding;
}

/** Короткий отпечаток строки: хватает, чтобы заметить изменение, и не тянет криптографию в окно */
const stamp = (s: string): string => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
export interface SchemeUnit { id: string; name: string; nodes: SchemeNode[] }

export function useSchemeData(projectId: string) {
  const [systems, setSystems] = useState<ExportSystem[] | null>(null);
  const [book, setBook] = useState<E3SolutionBook | null>(null);
  const [profile, setProfile] = useState<E3Profile>({});
  const [attrs, setAttrs] = useState<E3AttributeBook | null>(null);
  const [error, setError] = useState('');
  const [e3, setE3] = useState<E3Link | null>(null);
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [exports, setExports] = useState<E3ExportInfo[]>([]);
  const [tick, setTick] = useState(0);

  // Связь с проектом E3 и то, что туда отправлено. Нет моделей на сервере или нет доступа — связей просто нет
  useEffect(() => {
    let alive = true;
    e3ExportService.projects(projectId).then(async (list) => {
      const link = list[0] || null;
      const [b, x] = link ? await Promise.all([e3ExportService.bindings(projectId, link.id), e3ExportService.exports(projectId, link.id)]) : [[], []];
      if (alive) { setE3(link); setBindings(b); setExports(x); }
    }).catch(() => { if (alive) { setE3(null); setBindings([]); setExports([]); } });
    return () => { alive = false; };
  }, [projectId, tick]);

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
    const byElement = new Map(bindings.map((b) => [b.elementId, b]));
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
        const rows: ExportAttr[] = attrs ? attributesForClass(attrs.items, p.cls).filter((a) => a.fromFlux).map((a) => ({
          name: a.name, owner: '', service: a.service, allowService: a.conflict === 'flux',
          value: a.source.kind === 'none' ? '' : equipmentCell(it, `e3:${a.name}`, a.source.kind === 'param' ? a.source.unit || '' : '', a.source),
        })) : [];
        const label = (it.tags || [])[0]?.identifier || '';
        const id = `${it.id}:${i}`;
        const binding = byElement.get(id);
        const version = stamp(JSON.stringify([sol?.id || '', label, rows.map((a) => [attrKey(a), a.value])]));
        nodes.push({
          id, label, name: String(it.name || ''), cls: p.cls, unitId: sys.id, unitName: sys.name,
          order: it.sourceOrder ?? i, item: it, selection, attrs: rows, version, ...(binding ? { binding } : {}),
          state: nodeState(selection, binding ? { bound: binding.state === 'PLACED', changed: binding.sentVersion !== version } : null), twoLevel: !!sol?.twoLevel,
          hasLeft: !!sol && names.has(`${sol.name}_влево`.toLocaleLowerCase('ru')),
        });
      });
      if (nodes.length) units.push({ id: sys.id, name: sys.name, nodes });
    }
    return { units, skipped };
  }, [systems, book, profile, attrs, bindings]);

  return { loading: !systems || !book || !attrs, error, book, attrs, profile, units: model.units, skipped: model.skipped, e3, bindings, exports, reloadBindings: () => setTick((t) => t + 1) };
}
