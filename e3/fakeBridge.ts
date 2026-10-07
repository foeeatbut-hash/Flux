/**
 * Подставной мост к E3: «проект E3» в памяти с теми же командами, что у
 * настоящего (e3/bridgeTypes.ts). На нём в контейнере проверяется вся логика
 * выгрузки и переподбора, а в dev-режиме его видно в окне. Настоящий E3 нужен
 * только для проверки самого моста и приёмки.
 *
 * Ведёт себя как E3, где это важно для выгрузки: блок без атрибутов связи —
 * «не дошло до конца» и находится по отметке выгрузки; атрибуты связи читает
 * `readBound`; «занят» и «обрыв на шаге N» включаются режимами.
 */
import {
  E3BusyError, E3LostError,
  type E3Bridge, type E3BoundBlock, type E3PartInfo, type E3PlanStep, type E3Rect, type E3SheetInfo, type E3Status, type E3StepResult, type E3Size,
} from './bridgeTypes';

export interface FakeBlock {
  /** Номер объекта E3: меняется при копировании, поэтому ключом не служит */
  id: number;
  block: string;
  sheet: string;
  rect: E3Rect;
  designation: string;
  /** Атрибуты блока и изделий: `<изделие>|<имя>`, служебные FLUX_* — по имени без изделия */
  attrs: Record<string, string>;
  /** Отметка выгрузки, пока нет атрибутов связи */
  mark: string;
  wired: boolean;
}

export interface FakeOptions {
  version?: string;
  projectName?: string;
  /** `FLUX_PROJECT`; пусто — проект ещё не связан */
  projectKey?: string | null;
  sheet?: string;
  sheetInfo?: E3SheetInfo;
  /** Блоки типовых решений, которые есть в базе E3 */
  parts?: string[];
  occupied?: E3Rect[];
  /** В базе заведены атрибуты связи */
  linkAttrs?: boolean;
  readOnly?: string;
}

const A3: E3SheetInfo = { format: 'А3', size: { w: 420, h: 297 }, work: { x: 20, y: 5, w: 395, h: 287 }, grid: 5 };

export class FakeE3 implements E3Bridge {
  readonly options: Required<Omit<FakeOptions, 'readOnly'>> & { readOnly?: string };
  blocks: FakeBlock[] = [];
  /** Режимы отказов */
  mode: { busy?: number | boolean; failAtStep?: number | null } = {};
  /** Сколько шагов выполнено за всё время — для «обрыва на шаге N» считается внутри apply */
  private nextId = 1;
  /** Все выполненные шаги: проверки смотрят, не было ли повторных */
  readonly log: E3PlanStep[] = [];
  private key: string | null;

  constructor(opts: FakeOptions = {}) {
    this.options = {
      version: '2025', projectName: 'Корпус 3 — ВК', projectKey: null, sheet: 'Лист 12', sheetInfo: A3, parts: [], occupied: [], linkAttrs: true, ...opts,
    } as any;
    this.key = this.options.projectKey;
  }

  async status(): Promise<E3Status> {
    return { instances: [{ version: this.options.version, project: this.options.projectName, sheet: this.options.sheet, sheetInfo: this.options.sheetInfo, ...(this.options.readOnly ? { readOnly: this.options.readOnly } : {}) }] };
  }

  async projectKey(set?: string): Promise<string | null> {
    if (set !== undefined) this.key = set;
    return this.key;
  }

  async listParts(names?: string[]): Promise<E3PartInfo[]> {
    const all = this.options.parts.map((name): E3PartInfo => ({ name, kind: 'block' }));
    return names ? all.filter((p) => names.includes(p.name)) : all;
  }

  async sheetOccupancy(): Promise<E3Rect[]> {
    // То, что уже стоит на листе помимо Flux: рамка, штамп, нарисованное инженером. Блоки Flux — не «занятое»: их место известно из связей
    return [...this.options.occupied];
  }

  async readBound(): Promise<E3BoundBlock[]> {
    return this.blocks.filter((b) => b.attrs.FLUX_BLOCK).map((b) => {
      const attrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(b.attrs)) if (k.includes('|')) attrs[k] = v;
      const [version] = (b.attrs.FLUX_VER || '').split('#');
      return { positionId: b.attrs.FLUX_BLOCK, solutionId: b.block, version: b.attrs.FLUX_VER || '', designation: b.designation, sheet: b.sheet, rect: b.rect, positionVersion: version, attrs, wired: b.wired };
    });
  }

  async preview(solutionIds: string[]): Promise<{ solutionId: string; size: E3Size; image: string }[]> {
    return solutionIds.map((solutionId) => ({ solutionId, size: { w: 50, h: 40 }, image: '' }));
  }

  async apply(steps: E3PlanStep[], onStep: (r: E3StepResult) => void): Promise<void> {
    this.guardBusy();
    let executed = 0;
    for (const step of steps) {
      // Обрыв: E3 закрыли посреди выгрузки — уже сделанное остаётся в проекте
      if (this.mode.failAtStep !== undefined && this.mode.failAtStep !== null && executed >= this.mode.failAtStep) {
        this.mode.failAtStep = null;
        throw new E3LostError(`E3 закрыт после ${executed} шагов`);
      }
      const result = this.run(step);
      this.log.push(step);
      onStep(result);
      executed++;
    }
  }

  // ── Что делает инженер руками в E3 (для проверок) ─────────────────────────
  private byPosition(positionId: string): FakeBlock | undefined { return this.blocks.find((b) => b.attrs.FLUX_BLOCK === positionId); }
  move(positionId: string, to: { x: number; y: number }): void { const b = this.byPosition(positionId); if (b) b.rect = { ...b.rect, ...to }; }
  wire(positionId: string): void { const b = this.byPosition(positionId); if (b) b.wired = true; }
  editAttr(positionId: string, owner: string, name: string, value: string): void { const b = this.byPosition(positionId); if (b) b.attrs[`${owner}|${name}`] = value; }
  deleteBlock(positionId: string): void { this.blocks = this.blocks.filter((b) => b.attrs.FLUX_BLOCK !== positionId); }
  /** Блок по ID узла или по отметке выгрузки */
  find(positionId: string, mark?: string): FakeBlock | undefined { return this.byPosition(positionId) || (mark ? this.blocks.find((b) => b.mark === mark) : undefined); }

  private guardBusy(): void {
    const busy = this.mode.busy;
    if (busy === true) throw new E3BusyError();
    if (typeof busy === 'number' && busy > 0) { this.mode.busy = busy - 1; throw new E3BusyError(); }
  }

  private run(step: E3PlanStep): E3StepResult {
    const fail = (message: string): E3StepResult => ({ step, ok: false, message });
    if (step.kind === 'place') {
      const existing = this.find(step.positionId, step.mark);
      if (existing) return { step, ok: true, message: 'уже стоит' };
      if (!step.block || !this.options.parts.includes(step.block)) return fail(`Блока «${step.block}» нет в базе E3`);
      this.blocks.push({ id: this.nextId++, block: step.block, sheet: this.options.sheet, rect: step.rect!, designation: '', attrs: {}, mark: step.mark || '', wired: false });
      return { step, ok: true };
    }
    if (step.kind === 'remove') {
      const had = this.find(step.positionId, step.mark);
      this.blocks = this.blocks.filter((b) => b !== had);
      return { step, ok: true, ...(had ? {} : { message: 'блока уже нет' }) };
    }
    const b = this.find(step.positionId, step.mark) || this.blocks.find((x) => x.mark.endsWith(`:${step.positionId}`));
    if (!b) return fail('Блок не найден: сначала его нужно поставить');
    if (step.kind === 'designation') { b.designation = step.designation || ''; return { step, ok: true }; }
    if (step.kind === 'attribute') { b.attrs[`${step.owner || ''}|${step.name}`] = step.value ?? ''; return { step, ok: true }; }
    // Атрибуты связи — последними: до них блок для Flux «не дошёл до конца»
    b.attrs.FLUX_BLOCK = step.positionId;
    b.attrs.FLUX_VER = step.ver || '';
    return { step, ok: true };
  }
}
