import { TOURS } from '../src/assistant/tours';
import { canAdvanceTour, isTourTargetInteraction, tourRequiresProject, tourStepNeedsAction } from '../src/guide/tourRuntime';

let failures = 0;
const check = (name: string, pass: boolean) => {
  if (pass) console.log(`✓ ${name}`);
  else { failures++; console.error(`✗ ${name}`); }
};

check('идентификаторы демонстраций уникальны', new Set(TOURS.map((tour) => tour.id)).size === TOURS.length);
check('у каждой демонстрации есть шаг', TOURS.every((tour) => tour.steps.length > 0));
check('цели указывают на реальный контракт data-tour', TOURS.every((tour) => tour.steps.every((step) => !step.target || /^\[data-tour="[a-zA-Z0-9_./:-]+"\]$/.test(step.target))));
check('целевой шаг нельзя продолжить до действия', !canAdvanceTour({ text: 'действие', target: '[data-tour="save"]' }, false));
check('целевой шаг продолжается после замеченного действия', canAdvanceTour({ text: 'действие', target: '[data-tour="save"]' }, true));
check('информационный шаг можно продолжить', canAdvanceTour({ text: 'информация' }, false));
check('пропуск действия не объявляет его выполненным', tourStepNeedsAction({ text: 'действие', target: '[data-tour="save"]' }));
check('проектные туры распознаются для пустого проекта', tourRequiresProject('add-tag') && !tourRequiresProject('change-theme'));
const parent = { contains: (node: unknown) => node === child } as unknown as Element;
const child = {} as EventTarget;
check('событие внутри цели распознаётся', isTourTargetInteraction(child, parent));
check('событие вне цели не засчитывается', !isTourTargetInteraction(new EventTarget(), parent));

console.log(`\n${failures ? `${failures} проверок провалено` : 'Все проверки демонстраций пройдены'}`);
process.exit(failures ? 1 : 0);
