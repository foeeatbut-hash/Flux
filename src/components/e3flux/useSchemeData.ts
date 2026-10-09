/**
 * Данные вкладки «Схема»: оборудование проекта, каталог решений, профиль и
 * справочник атрибутов — и узлы схемы, посчитанные из них. Модуль подбора и
 * состояния узла чистые, здесь только чтение и сборка. Связи с E3 пока нет
 * (моста нет), поэтому состояние узла считается с пустой связью.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { attributesForClass, type E3AttributeBook } from '../../../e3/attributes';
import { attrKey, type Binding, type ExportAttr } from '../../../e3/exportTypes';
import { nodeState, type E3NodeStateId } from '../../../e3/nodeState';
import { selectSolution } from '../../../e3/solutionSelect';
import type { E3Profile, E3Selection, E3SolutionBook } from '../../../e3/solutionTypes';
import { e3AttributesService } from '../../services/e3AttributesService';
import { e3SolutionsService } from '../../services/e3SolutionsService';
import { e3ExportService, type E3ExportInfo, type E3Link } from '../../services/e3ExportService';
import { buildExportSources, type ExportSystem } from '../../lib/exportWorkspace';
import type { ExchangeComponent } from '../../lib/equipmentExchange';
import { e3AttrValue } from '../../lib/e3Table';
import { toPositions } from '../../lib/e3Positions';
import { onE3Changed } from '../../lib/e3Changed';

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
  /** Позиция снята во Flux, а в схеме стоит (С4): узел нужен, чтобы решить судьбу блока */
  removed?: boolean;
  /** Позицию заменила новая (С6) */
  replacedBy?: string;
  /** Классификатор или профиль изменились с прошлой выгрузки (С14) */
  rulesChanged?: boolean;
}

export interface SchemeUnit { id: string; name: string; nodes: SchemeNode[] }

const NO_IDS: ReadonlySet<string> = new Set();

/** `edited` — узлы, у которых инженер правил значения в E3 после выгрузки (знак ⇄): это знает только мост */
export function useSchemeData(projectId: string, edited: ReadonlySet<string> = NO_IDS) {
  const [systems, setSystems] = useState<ExportSystem[] | null>(null);
  const [book, setBook] = useState<E3SolutionBook | null>(null);
  const [profile, setProfile] = useState<E3Profile>({});
  const [attrs, setAttrs] = useState<E3AttributeBook | null>(null);
  const [error, setError] = useState('');
  const [e3, setE3] = useState<E3Link | null>(null);
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [exports, setExports] = useState<E3ExportInfo[]>([]);
  const [tick, setTick] = useState(0);
  const inputRequest = useRef(0);

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

  const reloadInputs = useCallback(() => {
    const request = ++inputRequest.current;
    Promise.all([
      fetch(`/api/projects/${encodeURIComponent(projectId)}/systems?removed=1`).then((r) => { if (!r.ok) throw new Error('Оборудование недоступно. Проверьте доступ к проекту'); return r.json(); }),
      e3SolutionsService.load(), e3SolutionsService.profile(projectId), e3AttributesService.load(),
    ]).then(([data, b, p, a]) => { if (request === inputRequest.current) { setSystems(data.systems || []); setBook(b); setProfile(p.answers); setAttrs(a); setError(''); } })
      .catch((e: any) => { if (request === inputRequest.current) setError(e.message || 'Не удалось загрузить данные'); });
  }, [projectId]);

  useEffect(() => {
    setSystems(null); setError('');
    reloadInputs();
    return () => { inputRequest.current++; };
  }, [reloadInputs]);

  useEffect(() => onE3Changed((detail) => {
    if (detail?.projectId && detail.projectId !== projectId) return;
    if (!detail?.entity || ['attributes', 'solutions', 'profile'].includes(detail.entity)) reloadInputs();
  }), [projectId, reloadInputs]);

  useEffect(() => {
    const onEntity = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: string; projectId?: string }>).detail;
      if (detail?.projectId && detail.projectId !== projectId) return;
      if (detail?.kind === 'tag' || detail?.kind === 'element') reloadInputs();
    };
    window.addEventListener('socket:entity:changed', onEntity);
    return () => window.removeEventListener('socket:entity:changed', onEntity);
  }, [projectId, reloadInputs]);

  const model = useMemo(() => {
    if (!systems || !book) return { units: [] as SchemeUnit[], skipped: 0 };
    // Снятые позиции (`REMOVED`) в схему не входят, но нужны, чтобы решить судьбу их блоков в E3 (С4, С6)
    const meta = new Map<string, { version: string; removed: boolean; replacedBy?: string }>();
    const live = systems.map((s: any) => ({ ...s, monoblocks: (s.monoblocks || []).map((m: any) => ({ ...m, components: (m.components || []).filter((c: any) => {
      let replacedBy: string | undefined;
      try { replacedBy = c.conflictLog ? JSON.parse(c.conflictLog)?.__removal?.replacedBy : undefined; } catch (_) { replacedBy = undefined; }
      meta.set(c.id, { version: String(c.version ?? 1), removed: c.status === 'REMOVED', ...(replacedBy ? { replacedBy } : {}) });
      return c.status !== 'REMOVED';
    }) })) }));
    const sources = buildExportSources(live, []);
    const lastDone = exports.find((x) => x.state === 'DONE');
    const rulesChanged = !!lastDone && (lastDone.classifierVersion !== book.version || JSON.stringify(lastDone.profile ?? {}) !== JSON.stringify(profile));
    const byElement = new Map(bindings.map((b) => [b.elementId, b]));
    const names = new Set(book.solutions.filter((s) => !s.removed).map((s) => s.name.toLocaleLowerCase('ru')));
    const units: SchemeUnit[] = [];
    let skipped = 0;
    for (const sys of live) {
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
          name: a.name, owner: '', service: a.service, allowService: a.conflict === 'flux', conflict: a.conflict, script: !!a.script,
          value: e3AttrValue(it, a, p.cls),
        })) : [];
        const label = (it.tags || [])[0]?.identifier || '';
        // Ключ узла — ID позиции: по нему связь переживает и перестановку, и новую загрузку расчёта
        const id = String(it.id);
        const binding = byElement.get(id);
        const version = meta.get(id)?.version || '1';
        nodes.push({
          id, label, name: String(it.name || ''), cls: p.cls, unitId: sys.id, unitName: sys.name,
          order: it.sourceOrder ?? i, item: it, selection, attrs: rows, version, ...(binding ? { binding } : {}),
          rulesChanged, state: nodeState(selection, binding ? { bound: binding.state === 'PLACED', changed: binding.sentVersion !== version || (!!sol && binding.solutionId !== sol.id), editedInE3: edited.has(id) } : null), twoLevel: !!sol?.twoLevel,
          hasLeft: !!sol && names.has(`${sol.name}_влево`.toLocaleLowerCase('ru')),
        });
      });
      if (nodes.length) units.push({ id: sys.id, name: sys.name, nodes });
    }
    // Связи, чьих позиций больше нет среди действующих: снята во Flux (✕). Отвязанные не показываем
    const known = new Set(units.flatMap((u) => u.nodes.map((n) => n.id)));
    const gone: SchemeNode[] = bindings.filter((b) => (b.state === 'PLACED' || b.state === 'REMOVED_IN_FLUX') && !known.has(b.elementId)).map((b) => ({
      id: b.elementId, label: b.designation, name: '', cls: 'ПРОЧЕЕ', unitId: '__removed', unitName: 'Сняты во Flux', order: 0,
      item: { id: b.elementId, itemCode: '', name: '', equipType: '', groups: [], systemName: '', monoblockName: '' } as ExchangeComponent,
      selection: { status: 'none', candidates: [], answers: [], nearest: [] }, attrs: [], version: meta.get(b.elementId)?.version || '', binding: b, removed: true,
      ...(meta.get(b.elementId)?.replacedBy ? { replacedBy: meta.get(b.elementId)!.replacedBy } : {}),
      state: nodeState(null, { bound: true, removedInFlux: true }), twoLevel: false, hasLeft: false,
    }));
    if (gone.length) units.push({ id: '__removed', name: 'Сняты во Flux', nodes: gone });
    return { units, skipped };
  }, [systems, book, profile, attrs, bindings, exports, edited]);

  return { loading: !systems || !book || !attrs, error, book, attrs, profile, units: model.units, skipped: model.skipped, e3, bindings, exports, reloadBindings: () => setTick((t) => t + 1) };
}
