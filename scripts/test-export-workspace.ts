import { buildExportSources, exportBookKey, exportDraftKey, exportProjectIdForWindow, exportSourcesAreCurrent, parseExportDraft, railWidth, saveAfterExportOperation, type ExportSystem } from '../src/lib/exportWorkspace';
import { exportGrid } from '../src/lib/exportGrid';
import { saveNewFile } from '../src/lib/officeFiles';
import { useStore } from '../src/store/store';
import { defaultSpec } from '../src/lib/exportSpec';

let passed = 0; let failed = 0;
function eq(name: string, got: unknown, expected: unknown) {
  if (JSON.stringify(got) === JSON.stringify(expected)) { passed++; return; }
  failed++; console.error(`✗ ${name}: ${JSON.stringify(got)} вместо ${JSON.stringify(expected)}`);
}
const system = (id: string, category: string, item: string): ExportSystem => ({ id, category, name: 'ПВ-1', monoblocks: [{ name: '', components: [{ id: item, itemCode: item, name: 'Привод', equipType: 'ПРИВОД', equipClass: 'ПРИВОД', specs: JSON.stringify({ groups: [{ title: 'Привод', params: [{ key: 'Мощность', value: '2', unit: 'кВт' }] }] }) }] }] });
const sources = buildExportSources([system('one', 'AHU', 'drive1'), system('two', 'VALVE', 'drive2')], [{ id: 'AHU', label: 'Кондиционеры' }, { id: 'VALVE', label: 'Клапаны' }]);
eq('Одинаковое имя установки не смешивает категории', sources.rows('cat:AHU').map(r => r.id), ['drive1']);
eq('Установка отбирается по id, а не имени', sources.rows('unit:two').map(r => r.id), ['drive2']);
eq('Весь проект включает обе установки', sources.rows('all').length, 2);
eq('Удалённая установка не даёт весь проект вместо пустого', sources.rows('unit:missing'), []);
eq('После смены проекта старые источники не считаются загруженными', exportSourcesAreCurrent('project-A', 'project-B'), false);
eq('Источники разрешены только для загруженного проекта', exportSourcesAreCurrent('project-B', 'project-B'), true);
eq('Окно без ссылки закрепляет проект первого открытия при смене global project', exportProjectIdForWindow('', 'project-A', 'project-B'), 'project-A');
eq('Ссылка на проект имеет приоритет над закреплённым проектом', exportProjectIdForWindow('project-C', 'project-A', 'project-B'), 'project-C');
eq('Окно без выбранного проекта ждёт первый active project', exportProjectIdForWindow('', '', 'project-B'), 'project-B');
eq('Неизвестный охват не даёт весь проект', sources.rows('missing'), []);
eq('Источники подписаны категориями каталога', sources.scopes.find(s => s.id === 'cat:AHU')?.label, 'Кондиционеры');
eq('Счётчик категории не завышен одинаковыми именами', sources.scopes.find(s => s.id === 'cat:VALVE')?.count, 1);
eq('Черновики разных сотрудников изолированы', exportDraftKey('project', 'first') !== exportDraftKey('project', 'second'), true);
eq('Черновики разных проектов изолированы', exportDraftKey('first', 'user') !== exportDraftKey('second', 'user'), true);
eq('Ссылки на книги разных сотрудников изолированы', exportBookKey('project', 'first') !== exportBookKey('project', 'second'), true);
eq('Разделитель не отнимает весь узкий лист', railWidth(480, 400), 232);
eq('Разделитель ограничен на большом экране', railWidth(900, 1600), 480);
eq('Повреждённый черновик игнорируется', parseExportDraft('{oops'), null);
const spec = { ...defaultSpec(), columns: [{ key: 'model', label: 'Марка' }, { key: 'formula:one', label: 'Расчёт', formula: '=SUM(A{row}:B{row})' }], grid: { deduplicate: true, blankRepeats: ['parentTag'] } };
const draft = parseExportDraft(JSON.stringify({ scope: 'cat:AHU', spec, name: 'Моя ведомость', tab: 'group', personal: true, railWidth: 10000 }));
eq('Черновик сохраняет имена столбцов', draft?.spec.columns.map(c => c.label), ['Марка', 'Расчёт']);
eq('Черновик сохраняет формулы', draft?.spec.columns[1].formula, '=SUM(A{row}:B{row})');
eq('Черновик сохраняет дедупликацию', draft?.spec.grid?.deduplicate, true);
eq('Восстановленная ширина не выходит за пределы', draft?.railWidth, 480);
const result = exportGrid(sources.rows('all'), spec, [], spec.grid);
eq('Дедупликация сохраняет одну одинаковую марку', result.rows.length, 1);
eq('Формула содержит фактический номер Excel строки', result.rows[0][1], '=SUM(A2:B2)');
async function checkFileProject() {
  const originalFetch = globalThis.fetch;
  const originalProject = useStore.getState().activeProject;
  let requested = '';
  globalThis.fetch = (async (url: any) => { requested = String(url); return new Response(JSON.stringify({ id: 'synthetic-file', name: 'test.xlsx' }), { status: 200 }); }) as typeof fetch;
  try {
    useStore.setState({ activeProject: { id: 'project-B' } as any });
    await saveNewFile(new Uint8Array([1, 2]), 'test.xlsx', 'exports', undefined, 'project-A');
    eq('Открытая выгрузка A не сохраняет книгу в выбранный позже проект B', new URL(requested, 'http://localhost').searchParams.get('projectId'), 'project-A');
    await saveNewFile(new Uint8Array([1, 2]), 'test.xlsx', 'exports');
    eq('Старые вызовы создания файла сохраняют текущий проект', new URL(requested, 'http://localhost').searchParams.get('projectId'), 'project-B');
  } finally { globalThis.fetch = originalFetch; useStore.setState({ activeProject: originalProject }); }
}
async function checkRefreshCloseOrder() {
  let finishRefresh!: () => void; let saved = 0; let closeReturned = false;
  const refresh = new Promise<void>(resolve => { finishRefresh = resolve; });
  const close = saveAfterExportOperation(refresh, async () => { saved++; return true; }).then(result => { closeReturned = true; return result; });
  await Promise.resolve();
  eq('Закрытие не завершает сохранение до окончания обновления листа', [closeReturned, saved], [false, 0]);
  finishRefresh();
  eq('После обновления закрытие сохраняет книгу', [await close, closeReturned, saved], [true, true, 1]);
}
Promise.all([checkFileProject(), checkRefreshCloseOrder()]).then(() => { console.log(`${passed} проверок пройдено, ${failed} провалено`); process.exit(failed ? 1 : 0); }).catch(e => { console.error(e); process.exit(1); });
