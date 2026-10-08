/**
 * План выгрузки в E3 (docs/e3-integration.md, 8.1 и 8.2): проверки до записи и
 * шаги в порядке записи. План ничего не пишет и от E3 ничего не требует —
 * всё, что нужно знать об E3, приходит в `PlanContext`, поэтому план
 * проверяется в контейнере на подставном мосте.
 *
 * Ошибки блокируют выгрузку целиком; предупреждения — нет. Узел, у которого не
 * выбрано одно решение или решения нет в базе E3, не ошибка, а пропуск этого
 * узла: остальные выгружаются (С16). Спорное (9.3) план не решает за инженера:
 * действует умолчание таблицы, а вопрос уходит в `questions`; ответ приходит в
 * `decisions` и план строится заново.
 *
 * План строится по снимку узлов на момент нажатия (С17): копия делается здесь,
 * поэтому переподбор, который ОВ запустил позже, на ход выгрузки не влияет.
 */
import type { E3BoundBlock, E3PlanStep, E3Rect } from './bridgeTypes';
import { compareNode, writable } from './exportCompare';
import { attrKey, type Binding, type Decisions, type ExportAttr, type ExportNode, type ExportPlan, type NodeAction, type PlanContext, type PlanIssue, type PlanQuestion } from './exportTypes';

const overlaps = (a: E3Rect, b: E3Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (r: E3Rect, w: E3Rect): boolean => r.x >= w.x && r.y >= w.y && r.x + r.w <= w.x + w.w && r.y + r.h <= w.y + w.h;

const SKIP_TEXT: Record<string, string> = {
  'need-answer': 'не хватает признака, чтобы выбрать одно решение',
  'blocked': 'решения нет',
  'not-in-base': 'блока решения нет в базе E3',
  'not-checked': 'не отмечен в выгрузку',
  'deleted-in-e3': 'удалён в E3 (не восстанавливается без согласия)',
  'solution-removed': 'решение убрано из каталога: новые блоки с ним запрещены',
};
/** Пропуски без предупреждения: так задумано, говорить о них нечего */
const QUIET = new Set(['not-checked', 'detached', 'removed-handled', 'removed-kept', 'replaced']);

/** Отметка выгрузки на блоке: по ней продолжение находит блок без атрибутов связи */
export const exportMark = (exportId: string, elementId: string): string => `${exportId}:${elementId}`;

/** С13: тот же ключ связи при другом пути проекта — копия проекта E3 или переезд */
export const projectCopyAsked = (ctx: Pick<PlanContext, 'e3Key' | 'expectedKey' | 'e3Path' | 'linkedPath'>): boolean =>
  ctx.e3Key !== null && ctx.e3Key === ctx.expectedKey && ctx.linkedPath !== undefined && ctx.e3Path !== undefined && ctx.linkedPath !== ctx.e3Path;

/** С13, «это новый проект»: связи переносятся в новый проект E3 как есть, у копии свой ключ */
export const copyBindings = (bindings: Binding[]): Binding[] => bindings.map((b) => ({ ...b, sentAttrs: { ...b.sentAttrs } }));

export function buildPlan(
  sourceNodes: ExportNode[], bindings: Binding[], bound: E3BoundBlock[], ctx: PlanContext, opts: { remove?: string[]; decisions?: Decisions } = {},
): ExportPlan {
  const nodes: ExportNode[] = structuredClone(sourceNodes); // С17: снимок
  const decisions = opts.decisions || {};
  const errors: PlanIssue[] = [];
  const warnings: PlanIssue[] = [];
  const questions: PlanQuestion[] = [];
  const err = (code: string, text: string, elementId?: string) => errors.push({ level: 'error', code, text, ...(elementId ? { elementId } : {}) });
  const warn = (code: string, text: string, elementId?: string) => warnings.push({ level: 'warning', code, text, ...(elementId ? { elementId } : {}) });

  // Проект и лист: тот же, что при подготовке, и открыт на запись
  if (!ctx.linkAttrsDefined) err('no-link-attrs', 'В базе E3 нет атрибутов связи: администратор базы должен завести FLUX_BLOCK, FLUX_VER, FLUX_PROJECT, FLUX_ID');
  if (ctx.e3Key !== null && ctx.e3Key !== ctx.expectedKey) err('project-mismatch', 'Открыт другой проект E3, чем при подготовке выгрузки');
  if (ctx.sheet !== ctx.expectedSheet) err('sheet-mismatch', `Открыт другой лист: ждали «${ctx.expectedSheet}», открыт «${ctx.sheet}»`);
  if (ctx.readOnly) err('read-only', `Лист или проект только для чтения: ${ctx.readOnly}`);
  if (projectCopyAsked(ctx) && !ctx.projectChoice) {
    err('project-copy', 'Проект E3 с тем же ключом лежит по другому пути: это копия проекта или он переехал? Выберите ниже.');
    questions.push({ id: 'project|project', elementId: '', topic: 'project', text: 'Проект E3 с тем же ключом открыт по другому пути', default: '',
      options: [{ value: 'new', label: 'это новый проект — завести свою связь (связи скопируются)' }, { value: 'moved', label: 'тот же проект переехал' }] });
  }

  const sentBy = new Map(bindings.map((b) => [b.elementId, b]));
  const boundAll = new Map<string, E3BoundBlock[]>();
  for (const b of bound) boundAll.set(b.positionId, [...(boundAll.get(b.positionId) || []), b]);
  // С6: позиция заменена новой — блок старой меняется на новую на том же месте
  const replacing = new Map<string, string>();
  for (const n of nodes) if (n.removed && n.replacedBy && sentBy.get(n.elementId)?.state === 'PLACED') replacing.set(n.replacedBy, n.elementId);
  const actions: NodeAction[] = [];

  for (const node of nodes) {
    const label = node.tag || node.elementId;
    // С12: две копии блока с одним FLUX_BLOCK — до любой записи спрашиваем, какая главная
    const copies = boundAll.get(node.elementId) || [];
    let blockOf = copies[0];
    let unlink: number[] = [];
    if (copies.length > 1) {
      const choice = Number(decisions[`${node.elementId}|dup`]);
      const main = copies.find((c) => c.objectId === choice);
      if (!main) {
        err('duplicate-block', `${label}: в E3 два блока с одним ID узла — выберите главный, второй будет отвязан`, node.elementId);
        questions.push({ id: `${node.elementId}|dup`, elementId: node.elementId, topic: 'dup', text: `${label}: в E3 два устройства с одним ID`, default: '',
          options: copies.map((c) => ({ value: String(c.objectId), label: `№${c.objectId} · ${c.sheet} · (${c.rect.x}, ${c.rect.y})` })) });
        continue;
      }
      blockOf = main; unlink = copies.filter((c) => c !== main).map((c) => c.objectId as number);
    }
    const oldId = replacing.get(node.elementId);
    const replaced = node.removed && node.replacedBy && replacing.get(node.replacedBy) === node.elementId && nodes.some((x) => x.elementId === node.replacedBy && x.status === 'one' && x.checked);
    let action = replaced
      ? ({ elementId: node.elementId, kind: 'skip', attrs: [], rect: node.rect, keptE3: [], reason: 'replaced' } as NodeAction)
      : compareNode(sentBy.get(node.elementId), node, blockOf, {
        decisions, pins: ctx.pins, unlink,
        ...(oldId ? { replaces: { id: oldId, sent: sentBy.get(oldId), inE3: (boundAll.get(oldId) || [])[0] } } : {}),
      });
    if (node.checked && node.status === 'one' && !node.removed && !ctx.partsInBase.has(node.solutionName) && (action.kind === 'place' || action.kind === 'replace')) {
      action = { ...action, kind: 'skip', attrs: [], reason: 'not-in-base' };
    }
    actions.push(action);
    for (const x of action.questions || []) questions.push(x);
    if (action.kind === 'skip') {
      if (!QUIET.has(action.reason || '')) warn(action.reason || 'skip', `${label}: ${SKIP_TEXT[action.reason || ''] || 'пропущен'} — пропущен`, node.elementId);
      continue;
    }
    if (action.proposal) warn('rules', `${label}: по новым правилам подобралось ${action.proposal.solutionName} — блок не меняется без вашего согласия`, node.elementId);
    if (action.dangling?.length) warn('dangling-wires', `${label}: при замене блока повиснут провода на выводах: ${action.dangling.join(', ')}`, node.elementId);
    if (action.kind === 'mark-removed' || action.kind === 'detach') continue;

    // Пустые атрибуты с «Да» перечисляются, обязательные пустые блокируют узел
    const empty = node.attrs.filter((a) => writable(a) && a.value === '');
    const required = empty.filter((a) => a.required);
    if (required.length) err('required-empty', `${label}: не заполнены обязательные атрибуты ${required.map((a) => a.name).join(', ')}`, node.elementId);
    const optional = empty.filter((a) => !a.required);
    if (optional.length) warn('empty-attr', `${label}: нет данных для ${optional.map((a) => a.name).join(', ')} — не записываются`, node.elementId);
    const service = node.attrs.filter((a) => a.service && !a.allowService && a.value !== '');
    if (service.length) warn('service-skipped', `${label}: служебные атрибуты не пишутся: ${service.map((a) => a.name).join(', ')}`, node.elementId);
    if (action.keptE3.length) warn('edited-in-e3', `${label}: значения правили в E3 — оставлены как есть: ${action.keptE3.join(', ')}`, node.elementId);

    // Холст не должен пересекать занятое; уже стоящее в E3 не проверяем: оно там, где его поставил инженер
    if (action.kind === 'place' || action.kind === 'replace') {
      if (!inside(action.rect, ctx.work)) err('outside', `${label}: блок вылезает за рабочее поле листа`, node.elementId);
      else if (ctx.occupied.some((o) => overlaps(action.rect, o))) err('overlap', `${label}: блок лежит на занятом месте листа`, node.elementId);
    }
  }

  // Обозначения не повторяются ни с уже стоящими в проекте E3, ни друг с другом
  const seen = new Map<string, string>();
  for (const a of actions) {
    if (!['place', 'update', 'replace'].includes(a.kind)) continue;
    const node = nodes.find((n) => n.elementId === a.elementId)!;
    const d = a.designation ?? node.designation;
    if (!d || (a.kind === 'update' && a.designation === undefined)) continue;
    const owner = ctx.designations.get(d);
    const own = owner === a.elementId || (a.replaces !== undefined && owner === a.replaces);
    if (owner !== undefined && !own) err('duplicate-designation', `${node.tag || a.elementId}: обозначение «${d}» уже есть в проекте E3`, a.elementId);
    else if (seen.has(d) && seen.get(d) !== a.elementId) err('duplicate-designation', `${node.tag || a.elementId}: обозначение «${d}» повторяется в выгрузке`, a.elementId);
    seen.set(d, a.elementId);
  }

  // Удаление — только отмеченное инженером и только то, что стоит в E3 по нашей связи
  for (const id of opts.remove || []) {
    if (actions.some((a) => a.elementId === id && a.kind === 'remove')) continue;
    if (boundAll.has(id)) actions.push({ elementId: id, kind: 'remove', attrs: [], rect: boundAll.get(id)![0].rect, keptE3: [] });
    else warn('remove-missing', `${id}: удалять нечего — блока нет в E3`, id);
  }

  const todo = actions.filter((a) => (a.kind !== 'skip' && a.kind !== 'keep') || (a.kind === 'keep' && a.conflicts?.some((c) => c.decided)));
  if (!todo.length && !errors.length) err('nothing', 'Выгружать нечего: все узлы пропущены или без изменений');

  const steps = errors.length ? [] : planSteps(actions, nodes, ctx);
  const count = (k: string) => actions.filter((a) => a.kind === k).length;
  return {
    questions, errors, warnings, actions, steps,
    summary: { place: count('place'), update: count('update') + count('mark-removed'), replace: count('replace'), remove: count('remove'), skipped: count('skip'), mark: count('mark-removed'), detach: count('detach') },
  };
}

/** Шаги в порядке записи (8.2): блоки → обозначения → атрибуты → атрибуты связи последними */
export function planSteps(actions: NodeAction[], nodes: ExportNode[], ctx: PlanContext): E3PlanStep[] {
  const byId = new Map(nodes.map((n) => [n.elementId, n]));
  const blocks: E3PlanStep[] = [];
  const designations: E3PlanStep[] = [];
  const attributes: E3PlanStep[] = [];
  const links: E3PlanStep[] = [];
  for (const a of actions) {
    const node = byId.get(a.elementId);
    const label = node?.tag || a.elementId;
    for (const objectId of a.unlink || []) blocks.push({ kind: 'unlink', positionId: a.elementId, objectId, detail: `Снять связь с копией блока №${objectId} (${label})` });
    if (a.kind === 'remove') { blocks.push({ kind: 'remove', positionId: a.elementId, detail: `Убрать блок ${label}` }); continue; }
    if (a.kind === 'mark-removed') {
      attributes.push({ kind: 'attribute', positionId: a.elementId, owner: '', name: 'FLUX_STATUS', value: 'снята', detail: `${label}: FLUX_STATUS = снята` });
      continue;
    }
    if (!node || a.kind === 'skip' || a.kind === 'keep' || a.kind === 'detach') continue;
    if (a.kind === 'replace') blocks.push({ kind: 'remove', positionId: a.replaces || a.elementId, detail: `Убрать старый блок ${a.replaces ? '' : label}`.trim() });
    else if (a.kind === 'place' && a.replaces) blocks.push({ kind: 'remove', positionId: a.replaces, detail: 'Убрать связь старой позиции' });
    if (a.kind === 'place' || a.kind === 'replace') {
      blocks.push({ kind: 'place', positionId: a.elementId, block: node.solutionName, rect: a.rect, mark: exportMark(ctx.exportId, a.elementId), detail: `Поставить ${node.solutionName} (${label}) в (${a.rect.x}, ${a.rect.y})` });
    }
    if (a.designation) designations.push({ kind: 'designation', positionId: a.elementId, designation: a.designation, detail: `Обозначение ${label}: ${a.designation}` });
    for (const at of a.attrs) {
      attributes.push({ kind: 'attribute', positionId: a.elementId, owner: at.owner, name: at.name, value: at.value, detail: `${label}: ${at.name} = ${at.value}` });
    }
    links.push({ kind: 'link', positionId: a.elementId, ver: `${node.version}#${ctx.exportNo}`, detail: `Связь ${label}: FLUX_BLOCK, FLUX_VER` });
  }
  return [...blocks, ...designations, ...attributes, ...links];
}

/** Сводка словами для окна плана: «поставить 3 · обновить 2 · заменить 1 · удалить 0» */
export const summaryText = (s: ExportPlan['summary']): string =>
  `поставить ${s.place} · обновить ${s.update} · заменить ${s.replace} · удалить ${s.remove}${s.detach ? ` · отвязать ${s.detach}` : ''}`;

/** Что узел записал в E3: основа для новой связи */
export function sentAttrsAfter(prev: Binding | undefined, action: NodeAction): Record<string, string> {
  const out: Record<string, string> = action.kind === 'place' || action.kind === 'replace' ? {} : { ...(prev?.sentAttrs || {}) };
  for (const a of action.attrs as ExportAttr[]) out[attrKey(a)] = a.value;
  // Значение, которое инженер явно оставил в E3, считается отправленным: иначе вопрос повторялся бы при каждой выгрузке
  for (const c of action.conflicts || []) if (c.decided && c.applied === 'e3') out[c.key] = c.e3;
  return out;
}
