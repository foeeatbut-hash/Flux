import type { Tour, TourExpectedResult, TourStep } from './support/tours';

const PROJECT_TOURS = new Set([
  'add-tag', 'generate-tag', 'link-tags', 'delete-tag',
  'assign-tag-file', 'import-equipment', 'view-equipment', 'resolve-conflict',
  'create-dictionary', 'import-dictionary', 'tag-template', 'import-blank-preview',
  'procurement-stages', 'procurement-templates', 'equipment-tag-link',
  'equipment-import', 'link-tag-equipment', 'update-tag', 'project-fields',
]);

export function tourRequiresProject(tourId: string): boolean {
  return PROJECT_TOURS.has(tourId);
}

export function withProjectContext(tour: Tour, projectSelected: boolean): Tour {
  if (!tourRequiresProject(tour.id) || projectSelected) return tour;
  return {
    ...tour,
    steps: [{
      text: 'Проект не выбран. Приостановите демонстрацию, выберите доступный проект в панели Flux и продолжите. Если список пуст, завершите демонстрацию: проект создаёт администратор.',
      action: 'info', requiredContext: true, expectedResult: { kind: 'project-selected' },
    }, ...tour.steps],
  };
}

/** Шаг без цели — объяснение, цель считается выполненной только после действия сотрудника. */
export function expectedResultForStep(step: TourStep): TourExpectedResult | null {
  if (step.expectedResult) return step.expectedResult;
  if (step.action === 'navigate' && step.route) return { kind: 'active-route', route: step.route };
  return null;
}

export function tourStepNeedsAction(step: TourStep): boolean {
  return !!step.target || !!step.requiredContext;
}

export function canAdvanceTour(step: TourStep, resultObserved: boolean): boolean {
  return !tourStepNeedsAction(step) || (!!expectedResultForStep(step) && resultObserved);
}

export interface TourResultProbe {
  activeRoute?: string;
  projectSelected?: boolean;
  visible(selector: string): boolean;
  text(selector: string): string;
  attribute(selector: string, name: string): string | null;
  value(selector: string): string;
}

export function evaluateTourResult(result: TourExpectedResult, probe: TourResultProbe): boolean {
  switch (result.kind) {
    case 'active-route':
      return normalizeRoute(probe.activeRoute || '') === normalizeRoute(result.route);
    case 'visible':
      return probe.visible(result.selector);
    case 'visible-text':
      return probe.visible(result.selector) && probe.text(result.selector).includes(result.contains);
    case 'attribute':
      return probe.visible(result.selector) && probe.attribute(result.selector, result.name) === result.value;
    case 'input-nonempty':
      return probe.visible(result.selector) && !!probe.value(result.selector).trim();
    case 'project-selected':
      return probe.projectSelected === true;
  }
}

export function normalizeRoute(route: string): string {
  const path = route.split(/[?#]/, 1)[0] || '/';
  return path.replace(/\/$/, '') || '/';
}
