import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { TOURS } from '../src/assistant/tours';
import {
  canAdvanceTour, evaluateTourResult, expectedResultForStep,
  tourRequiresProject, tourStepNeedsAction, withProjectContext,
} from '../src/guide/tourRuntime';

let failures = 0;
const check = (name: string, pass: boolean) => {
  if (pass) console.log(`✓ ${name}`);
  else { failures++; console.error(`✗ ${name}`); }
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    return statSync(file).isDirectory() ? sourceFiles(file) : /\.tsx?$/.test(file) ? [file] : [];
  });
}
const appSources = sourceFiles('src').filter((file) => !file.includes('/assistant/tours.ts'));
const appSourceText = appSources.map((file) => readFileSync(file, 'utf8')).join('\n');

const probe = (state: { route?: string; shown?: string[]; text?: Record<string, string>; attrs?: Record<string, string>; values?: Record<string, string>; project?: boolean } = {}) => ({
  activeRoute: state.route || '', projectSelected: state.project || false,
  visible: (selector: string) => (state.shown || []).includes(selector),
  text: (selector: string) => state.text?.[selector] || '',
  attribute: (selector: string, name: string) => state.attrs?.[`${selector}:${name}`] || null,
  value: (selector: string) => state.values?.[selector] || '',
});

check('идентификаторы демонстраций уникальны', new Set(TOURS.map((tour) => tour.id)).size === TOURS.length);
check('у каждой демонстрации есть шаг', TOURS.every((tour) => tour.steps.length > 0));
check('каждая целевая цель имеет проверяемое ожидаемое состояние', TOURS.every((tour) => tour.steps.every((step) => !step.target || !!expectedResultForStep(step))));
check('цели навигации совпадают с маршрутом шага', TOURS.every((tour) => tour.steps.every((step) => {
  const match = step.target?.match(/^\[data-tour="nav-(\/[^\"]+)"\]$/);
  return !match || (step.route || '').split(/[?#]/, 1)[0] === match[1];
})));
check('каждый data-tour target объявлен реальным компонентом приложения', TOURS.flatMap((tour) => tour.steps).every((step) => {
  if (!step.target) return true;
  const match = step.target.match(/^\[data-tour="([^"]+)"\]$/);
  if (!match) return true;
  const id = match[1];
  if (id.startsWith('nav-/')) return appSourceText.includes('data-tour={`nav-${b.path}`}') && appSourceText.includes('data-tour={`nav-${path}`}');
  if (id.startsWith('settings-')) return appSourceText.includes('data-tour={`settings-${s.id}`}');
  return appSourceText.includes(`data-tour="${id}"`) || appSourceText.includes(`data-tour={'${id}'}`);
}));
check('результат открытия мастера ограничен его фактическим заголовком', appSourceText.includes('<h2') && appSourceText.includes('Импорт из документов') && !TOURS.flatMap((tour) => tour.steps).some((step) => step.expectedResult?.kind === 'visible-text' && step.expectedResult.selector === 'body'));
check('информационный шаг можно продолжить', canAdvanceTour({ text: 'информация' }, false));
check('клик по целевой кнопке сам по себе не завершает шаг', !canAdvanceTour({ text: 'запись', target: '[data-tour="save"]', expectedResult: { kind: 'visible-text', selector: '[role="status"]', contains: 'Сохранено' } }, false));
check('целевая кнопка без ожидаемого результата заблокирована', !canAdvanceTour({ text: 'действие', target: '[data-tour="save"]' }, true));
check('маршрут подтверждается только активным разделом', evaluateTourResult({ kind: 'active-route', route: '/equipment' }, probe({ route: '/equipment' })) && !evaluateTourResult({ kind: 'active-route', route: '/equipment' }, probe({ route: '/explorer' })));
check('импорт подтверждается появлением предпросмотра, а не нажатием кнопки', evaluateTourResult({ kind: 'visible-text', selector: '[role="dialog"]', contains: 'Предпросмотр' }, probe({ shown: ['[role="dialog"]'], text: { '[role="dialog"]': 'Предпросмотр импорта' } })) && !evaluateTourResult({ kind: 'visible-text', selector: '[role="dialog"]', contains: 'Предпросмотр' }, probe({ shown: ['[role="dialog"]'], text: { '[role="dialog"]': 'Выберите файл' } })));
check('результат записи требует фактического статуса сохранения', evaluateTourResult({ kind: 'visible-text', selector: '[role="status"]', contains: 'Тег сохранён' }, probe({ shown: ['[role="status"]'], text: { '[role="status"]': 'Тег сохранён' } })) && !evaluateTourResult({ kind: 'visible-text', selector: '[role="status"]', contains: 'Тег сохранён' }, probe({ shown: ['[role="status"]'], text: { '[role="status"]': 'Сохранение…' } })));
check('вкладка считается выполненной только при выбранном aria-состоянии', evaluateTourResult({ kind: 'attribute', selector: '[data-tour="tag-table-tab"]', name: 'aria-selected', value: 'true' }, probe({ shown: ['[data-tour="tag-table-tab"]'], attrs: { '[data-tour="tag-table-tab"]:aria-selected': 'true' } })));
check('поле ввода должно содержать черновик', evaluateTourResult({ kind: 'input-nonempty', selector: '[data-tour="chat-input"]' }, probe({ shown: ['[data-tour="chat-input"]'], values: { '[data-tour="chat-input"]': 'проверка адресата' } })) && !evaluateTourResult({ kind: 'input-nonempty', selector: '[data-tour="chat-input"]' }, probe({ shown: ['[data-tour="chat-input"]'] })));
const contextual = withProjectContext(TOURS.find((tour) => tour.id === 'add-tag')!, false);
check('пустой проект получает обязательную ветку выбора проекта', contextual.steps[0].requiredContext === true && !canAdvanceTour(contextual.steps[0], false) && canAdvanceTour(contextual.steps[0], true));
check('ветка выбора проекта продолжается только после реального выбора', evaluateTourResult({ kind: 'project-selected' }, probe({ project: true })) && !evaluateTourResult({ kind: 'project-selected' }, probe()));
check('при уже выбранном проекте лишняя ветка не добавляется', withProjectContext(TOURS.find((tour) => tour.id === 'add-tag')!, true).steps.length === TOURS.find((tour) => tour.id === 'add-tag')!.steps.length);
check('безопасные финальные шаги не запускают запись кликом по цели', TOURS.flatMap((tour) => tour.steps).filter((step) => step.safeOnly).every((step) => step.action !== 'click'));

console.log(`\n${failures ? `${failures} проверок провалено` : 'Все проверки демонстраций пройдены'}`);
process.exit(failures ? 1 : 0);
