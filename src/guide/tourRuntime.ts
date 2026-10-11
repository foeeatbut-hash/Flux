import type { TourStep } from '../assistant/tours';

const PROJECT_TOURS = new Set([
  'add-tag', 'generate-tag', 'link-tags', 'delete-tag', 'export-data',
  'assign-tag-file', 'import-equipment', 'view-equipment', 'resolve-conflict',
  'create-dictionary', 'import-dictionary', 'tag-template', 'import-blank-preview',
  'procurement-stages', 'procurement-templates', 'equipment-tag-link',
  'equipment-import', 'link-tag-equipment', 'update-tag', 'project-fields',
]);

export function tourRequiresProject(tourId: string): boolean {
  return PROJECT_TOURS.has(tourId);
}

/** Шаг без цели — объяснение, цель считается выполненной только после действия сотрудника. */
export function tourStepNeedsAction(step: TourStep): boolean {
  return !!step.target;
}

export function canAdvanceTour(step: TourStep, completed: boolean): boolean {
  return !tourStepNeedsAction(step) || completed;
}

/** Контур декоративный: взаимодействие остаётся у самого элемента интерфейса. */
export function isTourTargetInteraction(target: EventTarget | null, element: Element | null): boolean {
  return !!element && !!target && (element === target || element.contains(target as Node));
}
