/**
 * Типы выгрузки в E3 (docs/e3-integration.md, разделы 8 и 9): что Flux
 * отправляет, что запомнил после отправки и что решил по каждому узлу.
 * Отдельным файлом, чтобы план, сравнение, запуск и сервер читали одни типы.
 */
import type { E3PlanStep, E3Rect } from './bridgeTypes';

/** Значение атрибута у блока или изделия внутри блока */
export interface ExportAttr {
  name: string;
  value: string;
  /** Изделие внутри блока: пусто — сам блок, иначе `#2`, `двигатель` */
  owner: string;
  /** Служебный атрибут E3 (его считают скрипты) */
  service?: boolean;
  /** Настройка каталога разрешает писать и служебный (правило спора «Flux главнее») */
  allowService?: boolean;
  /** Без значения выгрузка этого узла запрещена */
  required?: boolean;
}

/** Узел Flux на момент нажатия «Выгрузить»: подбор и атрибуты считаются один раз — снимок (С17) */
export interface ExportNode {
  elementId: string;
  /** Версия узла: меняется, когда меняется решение, тег или значения атрибутов */
  version: string;
  tag: string;
  /** Обозначение изделия в E3 (`Device Designation`) */
  designation: string;
  status: 'one' | 'many' | 'none';
  solutionId: string;
  /** Имя блока решения = название схемы = имя блока в базе E3 */
  solutionName: string;
  /** Где узел стоит на холсте */
  rect: E3Rect;
  attrs: ExportAttr[];
  /** Отмечен в выгрузку (флажок в списке) */
  checked: boolean;
}

export type BindingState = 'PLACED' | 'REMOVED_IN_FLUX' | 'DELETED_IN_E3' | 'DETACHED';

/** Что было отправлено (E3Binding, 9.1) */
export interface Binding {
  elementId: string;
  solutionId: string;
  designation: string;
  sheet: string;
  x: number;
  y: number;
  rotation: number;
  sentVersion: string;
  /** Записанные значения: ключ `<изделие>|<имя>` */
  sentAttrs: Record<string, string>;
  overrides?: Record<string, string>;
  state: BindingState;
  lastExportId: string;
}

export const attrKey = (a: Pick<ExportAttr, 'owner' | 'name'>): string => `${a.owner}|${a.name}`;

export type ActionKind = 'place' | 'update' | 'replace' | 'keep' | 'skip' | 'remove';

/** Решение по одному узлу после сравнения трёх сторон */
export interface NodeAction {
  elementId: string;
  kind: ActionKind;
  /** Что именно записать (при update — только изменившееся) */
  attrs: ExportAttr[];
  /** Новое обозначение, если оно меняется */
  designation?: string;
  /** Где блок будет стоять; при update — там, где он стоит в E3 (С10) */
  rect: E3Rect;
  /** Инженер сдвинул блок в E3: положение берётся из E3 */
  movedInE3?: boolean;
  /** Значения, которые правили в E3: их не перезаписываем */
  keptE3: string[];
  /** Почему узел пропущен или как понимать действие */
  reason?: string;
  note?: string;
}

export interface PlanIssue { level: 'error' | 'warning'; code: string; elementId?: string; text: string }

export interface ExportSummary { place: number; update: number; replace: number; remove: number; skipped: number }

export interface ExportPlan {
  errors: PlanIssue[];
  warnings: PlanIssue[];
  actions: NodeAction[];
  steps: E3PlanStep[];
  summary: ExportSummary;
}

/** Что известно об E3 и проекте перед выгрузкой */
export interface PlanContext {
  /** Ключ связи, ожидаемый Flux, и ключ, прочитанный из E3 */
  expectedKey: string;
  e3Key: string | null;
  sheet: string;
  expectedSheet: string;
  /** Лист или проект только для чтения: причина словами */
  readOnly?: string;
  /** Имена блоков, которые есть в базе E3 */
  partsInBase: Set<string>;
  occupied: E3Rect[];
  work: E3Rect;
  /** Обозначения, уже стоящие в проекте E3, с ID узла Flux, которому они принадлежат (пусто — чужое) */
  designations: Map<string, string>;
  /** В базе E3 заведены атрибуты связи (FLUX_BLOCK, FLUX_VER, FLUX_PROJECT) */
  linkAttrsDefined: boolean;
  exportId: string;
  exportNo: number;
  classifierVersion: number;
}
