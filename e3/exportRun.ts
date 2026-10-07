/**
 * Исполнение плана выгрузки (8.2) и его следы: журнал шагов, итоговые связи,
 * продолжение прерванной выгрузки и «убрать сделанное». Мост передаётся
 * снаружи — настоящий или подставной; сервер Flux к E3 не подключается, поэтому
 * всё, что пишет в базу, получает результат от окна, а проверяет его здесь.
 */
import { E3BusyError, E3LostError, type E3Bridge, type E3BoundBlock, type E3PlanStep, type E3StepResult } from './bridgeTypes';
import { exportMark, sentAttrsAfter } from './exportPlan';
import type { Binding, ExportNode, ExportPlan } from './exportTypes';

/** Запись журнала: номер шага в плане и что получилось */
export interface JournalEntry { i: number; ok: boolean; message?: string }

export type RunState = 'DONE' | 'INTERRUPTED';
export interface RunResult { state: RunState; done: number; total: number; error?: string }

/** Какие шаги плана ещё не сделаны: по журналу, а не по счёту — повтор не ставит вторых блоков */
export const remainingSteps = (steps: E3PlanStep[], journal: JournalEntry[]): number[] => {
  const ok = new Set(journal.filter((j) => j.ok).map((j) => j.i));
  return steps.map((_, i) => i).filter((i) => !ok.has(i));
};

/** Сколько шагов плана выполнено из скольких: «сделано 7 из 12» */
export const progressOf = (steps: E3PlanStep[], journal: JournalEntry[]): { done: number; total: number } => ({ done: steps.length - remainingSteps(steps, journal).length, total: steps.length });

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Выполнить указанные шаги. Каждый результат уходит в `onStep` сразу — окно
 * пишет его в журнал, поэтому обрыв посреди плана теряет не больше одного шага.
 * «E3 занят»: ждём и повторяем, через `busyMs` сдаёмся сообщением, которое
 * инженер видит с кнопкой «Повторить».
 */
export async function runSteps(
  bridge: E3Bridge, steps: E3PlanStep[], indexes: number[], onStep: (e: JournalEntry) => Promise<void> | void,
  opts: { busyMs?: number; pauseMs?: number } = {},
): Promise<{ state: RunState; error?: string }> {
  const busyMs = opts.busyMs ?? 30_000;
  const pause = opts.pauseMs ?? 1000;
  const started = Date.now();
  let at = 0;
  while (at < indexes.length) {
    const batch = indexes.slice(at);
    const pending: Promise<void>[] = [];
    let seen = 0;
    try {
      // Мост сообщает о каждом шаге; запись журнала идёт вдогонку, но по порядку
      await bridge.apply(batch.map((i) => steps[i]), (r: E3StepResult) => {
        const entry: JournalEntry = { i: batch[seen++], ok: r.ok, ...(r.message ? { message: r.message } : {}) };
        pending.push(Promise.resolve(onStep(entry)));
      });
      await Promise.all(pending);
      return { state: 'DONE' };
    } catch (e: any) {
      await Promise.all(pending);
      if (e instanceof E3BusyError && Date.now() - started < busyMs) {
        // Часть шагов могла пройти до «занято»: продолжаем с первого невыполненного
        at += seen; await wait(pause); continue;
      }
      return { state: 'INTERRUPTED', error: e instanceof E3BusyError ? 'E3 не отвечает: закройте открытые окна E3' : e instanceof E3LostError ? e.message : String(e?.message || e) };
    }
  }
  return { state: 'DONE' };
}

/** Все ли шаги плана сделаны успешно */
export const isComplete = (steps: E3PlanStep[], journal: JournalEntry[]): boolean => remainingSteps(steps, journal).length === 0;

/**
 * Итоговые связи: по узлу, у которого сделаны все его шаги. Узел, у которого
 * шаги не дошли до конца, связи не получает — повтор найдёт его блок по отметке
 * выгрузки и допишет.
 */
export function buildBindings(
  plan: Pick<ExportPlan, 'actions' | 'steps'>, journal: JournalEntry[], nodes: ExportNode[], prev: Binding[], ctx: { sheet: string; exportId: string },
): Binding[] {
  const ok = new Set(journal.filter((j) => j.ok).map((j) => j.i));
  const byNode = new Map(nodes.map((n) => [n.elementId, n]));
  const before = new Map(prev.map((b) => [b.elementId, b]));
  const out: Binding[] = [];
  const retire = (id: string, state: Binding['state']) => {
    const old = before.get(id);
    if (old) out.push({ ...old, state, lastExportId: ctx.exportId });
  };
  for (const a of plan.actions) {
    // Отвязывание шагов не требует: связь меняется сразу (С4, С11)
    if (a.kind === 'detach') { retire(a.elementId, 'DETACHED'); continue; }
    // Явное «оставить значение E3» запоминается в связи, чтобы вопрос не повторялся
    if (a.kind === 'keep' && a.conflicts?.some((c) => c.decided)) { const old = before.get(a.elementId); if (old) out.push({ ...old, sentAttrs: sentAttrsAfter(old, a), lastExportId: ctx.exportId }); continue; }
    if (a.kind === 'skip' || a.kind === 'keep') continue;
    const mine = plan.steps.map((s, i) => ({ s, i })).filter(({ s }) => s.positionId === a.elementId || (a.replaces !== undefined && s.positionId === a.replaces));
    if (mine.some(({ i }) => !ok.has(i))) continue;
    if (a.kind === 'remove') { retire(a.elementId, 'DETACHED'); continue; }
    if (a.kind === 'mark-removed') { retire(a.elementId, 'REMOVED_IN_FLUX'); continue; }
    const node = byNode.get(a.elementId);
    if (!node) continue;
    const old = before.get(a.elementId);
    out.push({
      elementId: a.elementId, solutionId: node.solutionId, designation: a.designation ?? old?.designation ?? node.designation, sheet: ctx.sheet,
      x: a.rect.x, y: a.rect.y, rotation: 0, sentVersion: node.version, sentAttrs: sentAttrsAfter(old, a), ...(old?.overrides ? { overrides: old.overrides } : {}),
      state: 'PLACED', lastExportId: ctx.exportId,
    });
    // С6: старая позиция заменена — её связь закрывается, новая заняла её место
    if (a.replaces) retire(a.replaces, 'DETACHED');
  }
  return out;
}

/**
 * «Убрать сделанное» (8.2): удаляются только блоки, поставленные этой
 * выгрузкой, и только если инженер их не трогал — не провёл провода, не двигал,
 * не правил. Остальные попадают в отчёт, решает инженер.
 */
export function planUndo(
  steps: E3PlanStep[], journal: JournalEntry[], bound: E3BoundBlock[], binding: Binding[],
): { remove: string[]; kept: { positionId: string; reason: string }[] } {
  const ok = new Set(journal.filter((j) => j.ok).map((j) => j.i));
  const placed = [...new Set(steps.filter((s, i) => s.kind === 'place' && ok.has(i)).map((s) => s.positionId))];
  const boundBy = new Map(bound.map((b) => [b.positionId, b]));
  const sent = new Map(binding.map((b) => [b.elementId, b]));
  const remove: string[] = []; const kept: { positionId: string; reason: string }[] = [];
  for (const id of placed) {
    const b = boundBy.get(id); const s = sent.get(id);
    // Блока со связью нет: либо выгрузка оборвалась до связи (блок найдётся по отметке), либо инженер его удалил — шаг «убрать» безвреден в обоих случаях
    if (!b) { remove.push(id); continue; }
    if (b.wired) { kept.push({ positionId: id, reason: 'к блоку проведены провода' }); continue; }
    if (s && (b.rect.x !== s.x || b.rect.y !== s.y)) { kept.push({ positionId: id, reason: 'блок сдвинут в E3' }); continue; }
    if (s && b.attrs && Object.entries(s.sentAttrs).some(([k, v]) => b.attrs![k] !== undefined && b.attrs![k] !== v)) { kept.push({ positionId: id, reason: 'значения атрибутов правили в E3' }); continue; }
    remove.push(id);
  }
  return { remove, kept };
}

/** Шаги «убрать» для блоков, которые выгрузка поставила и которых инженер не трогал */
export const undoSteps = (exportId: string, positionIds: string[]): E3PlanStep[] =>
  positionIds.map((positionId) => ({ kind: 'remove' as const, positionId, mark: exportMark(exportId, positionId), detail: `Убрать блок ${positionId}` }));
