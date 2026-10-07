/**
 * Выгрузка из окна: план → запись по шагам → журнал на сервере → связи. Мост
 * здесь подставной (dev-флаг `FLUX_E3_FAKE=1`): «проект E3» живёт в памяти
 * страницы, чтобы выгрузку можно было увидеть без E3.series. Настоящий мост
 * подключается этапом C на то же место: всё остальное — план, журнал, связи —
 * уже общее.
 */
import { FakeE3 } from '../../../e3/fakeBridge';
import { buildPlan } from '../../../e3/exportPlan';
import { buildBindings, isComplete, planUndo, remainingSteps, runSteps, undoSteps, type JournalEntry } from '../../../e3/exportRun';
import type { ExportNode, ExportPlan, PlanContext } from '../../../e3/exportTypes';
import type { E3BoundBlock, E3Rect } from '../../../e3/bridgeTypes';
import { defaultSize } from '../../../e3/layout';
import { e3ExportService, E3BusyExport, type E3ExportFull, type E3Link } from '../../services/e3ExportService';
import type { SchemeNode } from './useSchemeData';
import type { Placed } from './useSchemeState';

declare const __FLUX_E3_FAKE__: boolean | undefined;
/** Подставной мост включён сборкой (dev) */
export const E3_FAKE: boolean = typeof __FLUX_E3_FAKE__ !== 'undefined' && __FLUX_E3_FAKE__ === true;

// Один «E3» на страницу и проект: закрыли вкладку «Схема» — проект E3 в памяти остаётся
const fakes = new Map<string, FakeE3>();
export function fakeBridge(projectId: string, parts: string[]): FakeE3 {
  let b = fakes.get(projectId);
  if (!b) { b = new FakeE3({ parts, projectName: 'Корпус 3 — ВК (подставной E3)' }); fakes.set(projectId, b); }
  b.options.parts.splice(0, b.options.parts.length, ...parts);
  // Для отладки в консоли и проверок браузером: что стоит в подставном E3
  (window as any).__fluxFakeE3 = b;
  return b;
}

export interface Prepared {
  plan: ExportPlan; nodes: ExportNode[]; ctx: PlanContext; bound: E3BoundBlock[]; key: string; runId: string; sheet: string;
}

const rectOf = (n: SchemeNode, placed: Record<string, Placed>): E3Rect => placed[n.id]?.rect || { x: 0, y: 0, ...defaultSize(n.cls) };

/** Снимок узлов на момент нажатия «Выгрузить» (С17) и план по нему. Ничего не пишет */
export async function prepare(
  bridge: FakeE3, projectId: string, nodes: SchemeNode[], off: Record<string, true>, placed: Record<string, Placed>, link: E3Link | null, exportsDone: number, classifierVersion: number,
): Promise<Prepared> {
  const status = (await bridge.status()).instances[0];
  const info = status.sheetInfo!;
  const e3Key = await bridge.projectKey();
  const key = link?.key || e3Key || crypto.randomUUID();
  const parts = new Set((await bridge.listParts()).map((p) => p.name));
  const bound = await bridge.readBound();
  const runId = crypto.randomUUID();
  const snapshot: ExportNode[] = nodes.map((n) => ({
    elementId: n.id, version: n.version, tag: n.label, designation: n.label, status: n.selection.status, solutionId: n.selection.solution?.id || '', solutionName: n.selection.solution?.name || '',
    rect: rectOf(n, placed), attrs: n.attrs, checked: !off[n.id],
  }));
  const ctx: PlanContext = {
    expectedKey: key, e3Key, sheet: status.sheet || '', expectedSheet: status.sheet || '', ...(status.readOnly ? { readOnly: status.readOnly } : {}),
    partsInBase: parts, occupied: await bridge.sheetOccupancy(), work: info.work, designations: new Map(bound.map((b) => [b.designation, b.positionId])),
    linkAttrsDefined: bridge.options.linkAttrs, exportId: runId, exportNo: exportsDone + 1, classifierVersion,
  };
  const plan = buildPlan(snapshot, nodes.flatMap((n) => (n.binding ? [n.binding] : [])), bound, ctx);
  return { plan, nodes: snapshot, ctx, bound, key, runId, sheet: ctx.sheet };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Запустить запись: создать выгрузку, дождаться очереди (С18), выполнить шаги, закрыть итогом */
export async function runExport(
  bridge: FakeE3, projectId: string, link: E3Link | null, p: Prepared, prev: SchemeNode[], onProgress: (done: number, total: number, text: string) => void,
  classifierVersion: number,
): Promise<{ state: 'DONE' | 'INTERRUPTED'; error?: string; exportId: string }> {
  // Первая выгрузка в проект E3: связываем его с проектом Flux и ставим FLUX_PROJECT
  const l = link || await e3ExportService.link(projectId, { key: p.key, name: bridge.options.projectName, e3Version: bridge.options.version });
  if (await bridge.projectKey() !== l.key) await bridge.projectKey(l.key);
  const created = await e3ExportService.create(projectId, l.id, {
    sheet: p.sheet, classifierVersion, plan: { runId: p.runId, steps: p.plan.steps, summary: p.plan.summary, actions: p.plan.actions },
  });
  // Проект E3 занят чужой выгрузкой — ждём (С18)
  for (let i = 0; ; i++) {
    try { await e3ExportService.start(created.id); break; }
    catch (e) { if (!(e instanceof E3BusyExport) || i >= 20) throw e; onProgress(0, p.plan.steps.length, 'В этот проект E3 идёт другая выгрузка — жду'); await sleep(3000); }
  }
  return drive(bridge, created.id, p.plan.steps.map((_, i) => i), p.plan.steps, [], p, prev, onProgress);
}

/** Общая часть запуска и продолжения: шаги → журнал по мере выполнения → итог */
async function drive(
  bridge: FakeE3, exportId: string, indexes: number[], steps: any[], journal: JournalEntry[], p: Pick<Prepared, 'plan' | 'nodes' | 'sheet'> | null, prev: SchemeNode[],
  onProgress: (done: number, total: number, text: string) => void,
): Promise<{ state: 'DONE' | 'INTERRUPTED'; error?: string; exportId: string }> {
  const all = [...journal];
  const run = await runSteps(bridge, steps, indexes, async (e) => {
    all.push(e);
    await e3ExportService.steps(exportId, [e]);
    onProgress(all.filter((j) => j.ok).length, steps.length, steps[e.i]?.detail || '');
  });
  const state = run.state === 'DONE' && isComplete(steps, all) ? 'DONE' : 'INTERRUPTED';
  const error = state === 'DONE' ? undefined : run.error || 'Не все шаги выполнены';
  if (state === 'INTERRUPTED' || !p) { await e3ExportService.finish(exportId, { state: 'INTERRUPTED', report: { error, done: all.filter((j) => j.ok).length, total: steps.length } }); return { state: 'INTERRUPTED', error, exportId }; }
  const prevBindings = prev.flatMap((n) => (n.binding ? [n.binding] : []));
  const bindings = buildBindings(p.plan, all, p.nodes, prevBindings, { sheet: p.sheet, exportId });
  await e3ExportService.finish(exportId, { state: 'DONE', bindings, report: { done: steps.length, summary: p.plan.summary } });
  return { state: 'DONE', exportId };
}

/** Продолжить прерванную: выполняются только шаги, которых нет в журнале. Связи — по сохранённому плану и текущим узлам */
export async function resumeExport(
  bridge: FakeE3, e: E3ExportFull, nodes: SchemeNode[], off: Record<string, true>, placed: Record<string, Placed>, onProgress: (done: number, total: number, text: string) => void,
): Promise<{ state: 'DONE' | 'INTERRUPTED'; error?: string; exportId: string }> {
  const got = await e3ExportService.resume(e.id);
  const steps = got.export.plan.steps;
  const snapshot: ExportNode[] = nodes.map((n) => ({
    elementId: n.id, version: n.version, tag: n.label, designation: n.label, status: n.selection.status, solutionId: n.selection.solution?.id || '', solutionName: n.selection.solution?.name || '',
    rect: rectOf(n, placed), attrs: n.attrs, checked: !off[n.id],
  }));
  const plan = { steps, actions: (got.export.plan as any).actions } as unknown as ExportPlan;
  return drive(bridge, e.id, got.remaining.length ? got.remaining : remainingSteps(steps, got.export.journal), steps, got.export.journal, { plan, nodes: snapshot, sheet: e.sheet }, nodes, onProgress);
}

/** «Убрать сделанное»: только блоки этой выгрузки, которых инженер не трогал; остальное — в отчёт */
export async function undoExport(bridge: FakeE3, e: E3ExportFull, nodes: SchemeNode[]): Promise<{ removed: string[]; kept: { positionId: string; reason: string }[] }> {
  const bound = await bridge.readBound();
  const mine = nodes.flatMap((n) => (n.binding && n.binding.lastExportId === e.id ? [n.binding] : []));
  const { remove, kept } = planUndo(e.plan.steps, e.journal, bound, mine);
  await bridge.apply(undoSteps((e.plan as any).runId || e.id, remove), () => undefined);
  await e3ExportService.undo(e.id, { removed: remove, kept });
  return { removed: remove, kept };
}
