import { getPrisma } from './context.js';
import { withBump } from './equipmentVersion.js';
import { bindingKey } from './equipmentCatalog.js';

export interface CatalogSourceSnapshot {
  catalogSource: Record<string, any> | null;
  overrides: string | null;
  version: number;
}
export interface CatalogSourceUndoAction {
  elementId: string; itemCode: string; where: string; action: 'restore' | 'skip'; reason?: string;
  before: CatalogSourceSnapshot; after: CatalogSourceSnapshot;
}
export interface CatalogSourceUndoPlan {
  batchId: string; restore: CatalogSourceUndoAction[]; skip: CatalogSourceUndoAction[];
}

const parse = (value: unknown): any => { try { return typeof value === 'string' ? JSON.parse(value) : value ?? null; } catch { return null; } };
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const snapshot = (value: unknown): CatalogSourceSnapshot | null => {
  const parsed = parse(value);
  if (!parsed || typeof parsed !== 'object' || !Object.hasOwn(parsed, 'catalogSource') || !Object.hasOwn(parsed, 'version')) return null;
  return { catalogSource: parsed.catalogSource || null, overrides: parsed.overrides ?? null, version: Number(parsed.version) };
};

export function isCatalogSourceUndoBatch(batchId: string): boolean {
  return /^catalog-\d+-/.test(String(batchId || ''));
}

/** Откат безопасен только пока снимки привязки, ручных полей и версия не менялись. */
export function planCatalogSourceUndo(batchId: string, rows: any[], elements: Map<string, any>, bindings: Map<string, string | null>): CatalogSourceUndoPlan {
  const byElement = new Map<string, any[]>();
  for (const row of rows.filter(item => item.batchId === batchId && item.changeType === 'CATALOG_SOURCE')) {
    const group = byElement.get(row.elementId) || [];
    group.push(row); byElement.set(row.elementId, group);
  }
  const plan: CatalogSourceUndoPlan = { batchId, restore: [], skip: [] };
  for (const [elementId, history] of byElement) {
    history.sort((a, b) => new Date(a.changedAt).getTime() - new Date(b.changedAt).getTime());
    const first = history[0], last = history[history.length - 1];
    const before = snapshot(first.oldSpecs), after = snapshot(last.newSpecs), element = elements.get(elementId);
    const bindingValue = bindings.get(elementId) ?? null;
    const current = snapshot({ catalogSource: parse(bindingValue), overrides: element?.overrides ?? null, version: Number(element?.version || 0) });
    const item: CatalogSourceUndoAction = {
      elementId, itemCode: String(element?.itemCode || element?.name || '—'), where: String(element?.where || ''),
      action: 'skip', before: before || { catalogSource: null, overrides: null, version: 0 }, after: after || { catalogSource: null, overrides: null, version: 0 },
    };
    if (!element || !before || !after) { item.reason = 'данные для отката неполны'; plan.skip.push(item); continue; }
    if (!same(current, after)) { item.reason = 'после применения источника карточку или привязку изменили'; plan.skip.push(item); continue; }
    item.action = 'restore'; plan.restore.push(item);
  }
  const order = (a: CatalogSourceUndoAction, b: CatalogSourceUndoAction) => a.itemCode.localeCompare(b.itemCode, 'ru');
  plan.restore.sort(order); plan.skip.sort(order);
  return plan;
}

export async function applyCatalogSourceUndo(batchId: string, plan: CatalogSourceUndoPlan, _req?: unknown): Promise<{ restored: number; skipped: number; changedElementIds: string[] }> {
  const prisma = getPrisma();
  let restored = 0;
  const changedElementIds: string[] = [];
  for (const item of plan.restore) {
    try {
      await prisma.$transaction(async (tx: any) => {
        const key = bindingKey(item.elementId);
        const currentBinding = await tx.appSetting.findFirst({ where: { key, userId: null } });
        const currentElement = await tx.componentElement.findUnique({ where: { id: item.elementId } });
        const actual = snapshot({ catalogSource: parse(currentBinding?.value), overrides: currentElement?.overrides ?? null, version: Number(currentElement?.version || 0) });
        if (!currentElement || !same(actual, item.after)) throw new Error('conflict');
        const beforeValue = currentBinding?.value ?? null;
        const afterValue = item.before.catalogSource ? JSON.stringify(item.before.catalogSource) : null;
        const bumpedVersion = Number(currentElement.version || 1) + 1;
        const undoBatch = `catalog-${Date.now()}-undo-${batchId}`;
        await tx.equipmentHistory.create({ data: {
          elementId: item.elementId, version: Number(currentElement.version || 1), oldSpecs: JSON.stringify({ catalogSource: parse(beforeValue), overrides: currentElement.overrides ?? null, version: Number(currentElement.version || 1) }),
          newSpecs: JSON.stringify({ catalogSource: item.before.catalogSource, overrides: item.before.overrides, version: bumpedVersion }), changeType: 'CATALOG_SOURCE', batchId: undoBatch,
        } });
        const elementUpdate = await tx.componentElement.updateMany({
          where: { id: item.elementId, version: item.after.version, overrides: item.after.overrides },
          data: withBump({ overrides: item.before.overrides }),
        });
        if (elementUpdate.count !== 1) throw new Error('conflict');
        if (currentBinding) {
          const changed = afterValue
            ? await tx.appSetting.updateMany({ where: { id: currentBinding.id, value: currentBinding.value }, data: { value: afterValue } })
            : await tx.appSetting.deleteMany({ where: { id: currentBinding.id, value: currentBinding.value } });
          if (changed.count !== 1) throw new Error('conflict');
        } else if (afterValue) await tx.appSetting.create({ data: { id: `ecb-${item.elementId}`, key, userId: null, value: afterValue } });
      });
      restored++; changedElementIds.push(item.elementId);
    } catch (_) { /* CAS задели параллельной правкой — оставляем позицию целиком как есть */ }
  }
  return { restored, skipped: plan.skip.length + plan.restore.length - restored, changedElementIds };
}
