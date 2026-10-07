/**
 * План выгрузки в E3 (docs/e3-integration.md, 8.1 и 8.2): проверки до записи и
 * шаги в порядке записи. План ничего не пишет и от E3 ничего не требует —
 * всё, что нужно знать об E3, приходит в `PlanContext`, поэтому план
 * проверяется в контейнере на подставном мосте.
 *
 * Ошибки блокируют выгрузку целиком; предупреждения — нет. Узел, у которого не
 * выбрано одно решение или решения нет в базе E3, не ошибка, а пропуск этого
 * узла: остальные выгружаются (С16).
 */
import type { E3BoundBlock, E3PlanStep, E3Rect } from './bridgeTypes';
import { compareNode, writable } from './exportCompare';
import { attrKey, type Binding, type ExportAttr, type ExportNode, type ExportPlan, type NodeAction, type PlanContext, type PlanIssue } from './exportTypes';

const overlaps = (a: E3Rect, b: E3Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (r: E3Rect, w: E3Rect): boolean => r.x >= w.x && r.y >= w.y && r.x + r.w <= w.x + w.w && r.y + r.h <= w.y + w.h;

const SKIP_TEXT: Record<string, string> = {
  'need-answer': 'не хватает признака, чтобы выбрать одно решение',
  'blocked': 'решения нет',
  'not-in-base': 'блока решения нет в базе E3',
  'not-checked': 'не отмечен в выгрузку',
  'deleted-in-e3': 'удалён в E3 (не восстанавливается без согласия)',
};

/** Отметка выгрузки на блоке: по ней продолжение находит блок без атрибутов связи */
export const exportMark = (exportId: string, elementId: string): string => `${exportId}:${elementId}`;

export function buildPlan(
  nodes: ExportNode[], bindings: Binding[], bound: E3BoundBlock[], ctx: PlanContext, opts: { remove?: string[] } = {},
): ExportPlan {
  const errors: PlanIssue[] = [];
  const warnings: PlanIssue[] = [];
  const err = (code: string, text: string, elementId?: string) => errors.push({ level: 'error', code, text, ...(elementId ? { elementId } : {}) });
  const warn = (code: string, text: string, elementId?: string) => warnings.push({ level: 'warning', code, text, ...(elementId ? { elementId } : {}) });

  // Проект и лист: тот же, что при подготовке, и открыт на запись
  if (!ctx.linkAttrsDefined) err('no-link-attrs', 'В базе E3 нет атрибутов связи: администратор базы должен завести FLUX_BLOCK, FLUX_VER, FLUX_PROJECT, FLUX_ID');
  if (ctx.e3Key !== null && ctx.e3Key !== ctx.expectedKey) err('project-mismatch', 'Открыт другой проект E3, чем при подготовке выгрузки');
  if (ctx.sheet !== ctx.expectedSheet) err('sheet-mismatch', `Открыт другой лист: ждали «${ctx.expectedSheet}», открыт «${ctx.sheet}»`);
  if (ctx.readOnly) err('read-only', `Лист или проект только для чтения: ${ctx.readOnly}`);

  const sentBy = new Map(bindings.map((b) => [b.elementId, b]));
  const boundBy = new Map(bound.map((b) => [b.positionId, b]));
  const actions: NodeAction[] = [];

  for (const node of nodes) {
    // Решения нет в базе E3 — узел выгрузить нельзя, как и узел без выбранного решения
    let action = compareNode(sentBy.get(node.elementId), node, boundBy.get(node.elementId));
    if (node.checked && node.status === 'one' && !ctx.partsInBase.has(node.solutionName) && (action.kind === 'place' || action.kind === 'replace')) {
      action = { ...action, kind: 'skip', attrs: [], reason: 'not-in-base' };
    }
    actions.push(action);
    const label = node.tag || node.elementId;
    if (action.kind === 'skip') {
      if (action.reason !== 'not-checked') warn(action.reason || 'skip', `${label}: ${SKIP_TEXT[action.reason || ''] || 'пропущен'} — пропущен`, node.elementId);
      continue;
    }

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
    if (a.kind === 'skip' || a.kind === 'keep' || a.kind === 'remove') continue;
    const node = nodes.find((n) => n.elementId === a.elementId)!;
    const d = a.designation ?? node.designation;
    if (!d || (a.kind === 'update' && a.designation === undefined)) continue;
    const owner = ctx.designations.get(d);
    if (owner !== undefined && owner !== a.elementId) err('duplicate-designation', `${node.tag || a.elementId}: обозначение «${d}» уже есть в проекте E3`, a.elementId);
    else if (seen.has(d) && seen.get(d) !== a.elementId) err('duplicate-designation', `${node.tag || a.elementId}: обозначение «${d}» повторяется в выгрузке`, a.elementId);
    seen.set(d, a.elementId);
  }

  // Удаление — только отмеченное инженером и только то, что стоит в E3 по нашей связи
  for (const id of opts.remove || []) {
    if (boundBy.has(id)) actions.push({ elementId: id, kind: 'remove', attrs: [], rect: boundBy.get(id)!.rect, keptE3: [] });
    else warn('remove-missing', `${id}: удалять нечего — блока нет в E3`, id);
  }

  const todo = actions.filter((a) => a.kind !== 'skip' && a.kind !== 'keep');
  if (!todo.length && !errors.length) err('nothing', 'Выгружать нечего: все узлы пропущены или без изменений');

  const steps = errors.length ? [] : planSteps(actions, nodes, ctx);
  const count = (k: string) => actions.filter((a) => a.kind === k).length;
  return { errors, warnings, actions, steps, summary: { place: count('place'), update: count('update'), replace: count('replace'), remove: count('remove'), skipped: count('skip') } };
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
    if (a.kind === 'remove') { blocks.push({ kind: 'remove', positionId: a.elementId, detail: `Убрать блок ${label}` }); continue; }
    if (!node || a.kind === 'skip' || a.kind === 'keep') continue;
    if (a.kind === 'replace') blocks.push({ kind: 'remove', positionId: a.elementId, detail: `Убрать старый блок ${label}` });
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
export const summaryText = (s: ExportPlan['summary']): string => `поставить ${s.place} · обновить ${s.update} · заменить ${s.replace} · удалить ${s.remove}`;

/** Что узел записал в E3: основа для новой связи */
export function sentAttrsAfter(prev: Binding | undefined, action: NodeAction): Record<string, string> {
  const out: Record<string, string> = action.kind === 'place' || action.kind === 'replace' ? {} : { ...(prev?.sentAttrs || {}) };
  for (const a of action.attrs as ExportAttr[]) out[attrKey(a)] = a.value;
  return out;
}
