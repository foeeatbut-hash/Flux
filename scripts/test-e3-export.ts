/**
 * Выгрузка в E3 на подставном мосте (docs/e3-integration.md, разделы 8 и 9.2):
 * проверки плана, порядок шагов, сравнение трёх сторон (С1, С2, С5, С7, С10,
 * С16), обрыв и продолжение без дублей, «убрать сделанное». Мост — объект в
 * памяти с теми же командами, что у настоящего.
 *
 * Запуск: npx tsx scripts/test-e3-export.ts
 */
import { FakeE3 } from '../e3/fakeBridge';
import { buildPlan, summaryText } from '../e3/exportPlan';
import { compareNode } from '../e3/exportCompare';
import { buildBindings, isComplete, planUndo, progressOf, remainingSteps, runSteps, undoSteps, type JournalEntry } from '../e3/exportRun';
import type { Binding, ExportNode, PlanContext } from '../e3/exportTypes';

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  failed++;
  console.error(`  ✗ ${name} — получили ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`);
};
const yes = (name: string, cond: boolean) => eq(name, cond, true);

const node = (id: string, tag: string, extra: Partial<ExportNode> = {}): ExportNode => ({
  elementId: id, version: 'v1', tag, designation: tag, status: 'one', solutionId: '08.01.03', solutionName: 'Клапан_К24_КП2', rect: { x: 60, y: 30, w: 40, h: 30 },
  attrs: [{ name: 'GLOBAL_TAG_DEVICE', value: tag, owner: '' }, { name: 'MOTOR_Мощность', value: '5,5', owner: '#2' }], checked: true, ...extra,
});
const ctxOf = (bridge: FakeE3, extra: Partial<PlanContext> = {}): PlanContext => ({
  expectedKey: 'KEY', e3Key: 'KEY', sheet: 'Лист 12', expectedSheet: 'Лист 12', partsInBase: new Set(bridge.options.parts), occupied: [],
  work: bridge.options.sheetInfo.work, designations: new Map(), linkAttrsDefined: true, exportId: 'X1', exportNo: 1, classifierVersion: 3, ...extra,
});
const fresh = (parts = ['Клапан_К24_КП2', 'Фильтр_ФВД']) => new FakeE3({ projectKey: 'KEY', parts });

/** Выгрузка целиком, как её делает окно: план → шаги → журнал → связи */
async function exportAll(bridge: FakeE3, nodes: ExportNode[], prev: Binding[] = [], ctx: Partial<PlanContext> = {}) {
  const bound = await bridge.readBound();
  const plan = buildPlan(nodes, prev, bound, ctxOf(bridge, ctx));
  const journal: JournalEntry[] = [];
  const run = await runSteps(bridge, plan.steps, plan.steps.map((_, i) => i), (e) => { journal.push(e); }, { pauseMs: 0 });
  return { plan, journal, run, bindings: buildBindings(plan, journal, nodes, prev, { sheet: 'Лист 12', exportId: ctx.exportId || 'X1' }) };
}

(async () => {
console.log('Проверки плана');
{
  const b = fresh();
  const ok = buildPlan([node('a', 'К1')], [], [], ctxOf(b));
  eq('чистый план: ошибок нет', [ok.errors.length, ok.summary.place], [0, 1]);
  eq('другой проект E3 — ошибка', buildPlan([node('a', 'К1')], [], [], ctxOf(b, { e3Key: 'OTHER' })).errors.map((e) => e.code), ['project-mismatch']);
  eq('проект ещё не связан — не ошибка', buildPlan([node('a', 'К1')], [], [], ctxOf(b, { e3Key: null })).errors.length, 0);
  eq('другой лист — ошибка', buildPlan([node('a', 'К1')], [], [], ctxOf(b, { sheet: 'Лист 3' })).errors.map((e) => e.code), ['sheet-mismatch']);
  eq('лист только для чтения — ошибка', buildPlan([node('a', 'К1')], [], [], ctxOf(b, { readOnly: 'взят другим' })).errors.map((e) => e.code), ['read-only']);
  eq('нет атрибутов связи — ошибка', buildPlan([node('a', 'К1')], [], [], ctxOf(b, { linkAttrsDefined: false })).errors.map((e) => e.code), ['no-link-attrs']);
  const bad = buildPlan([node('a', 'К1')], [], [], ctxOf(b, { linkAttrsDefined: false }));
  eq('при ошибке шагов нет', bad.steps, []);

  const two = buildPlan([node('a', 'К1'), node('c', 'К2', { status: 'many' })], [], [], ctxOf(b));
  eq('С16: «нужен ответ» пропущен, остальные выгружаются', [two.errors.length, two.summary.place, two.summary.skipped, two.warnings.map((w) => w.code)], [0, 1, 1, ['need-answer']]);
  eq('С16: «решения нет» пропущен', buildPlan([node('a', 'К1'), node('d', 'К3', { status: 'none' })], [], [], ctxOf(b)).warnings.map((w) => w.code), ['blocked']);
  const notBase = buildPlan([node('a', 'К1'), node('e', 'Ф1', { solutionName: 'Нет_такого' })], [], [], ctxOf(b));
  eq('решения нет в базе E3 — узел пропущен', [notBase.warnings.map((w) => w.code), notBase.summary.place], [['not-in-base'], 1]);
  eq('не отмечен — молча пропущен, без предупреждения', buildPlan([node('a', 'К1'), node('f', 'К4', { checked: false })], [], [], ctxOf(b)).warnings.length, 0);
  eq('всё пропущено — ошибка «нечего выгружать»', buildPlan([node('c', 'К2', { status: 'many' })], [], [], ctxOf(b)).errors.map((e) => e.code), ['nothing']);

  const empty = buildPlan([node('a', 'К1', { attrs: [{ name: 'GLOBAL_TAG_DEVICE', value: '', owner: '' }, { name: 'X', value: '1', owner: '' }] })], [], [], ctxOf(b));
  eq('пустой атрибут с «Да» перечислен и не пишется', [empty.warnings.map((w) => w.code), empty.steps.some((s) => s.name === 'GLOBAL_TAG_DEVICE')], [['empty-attr'], false]);
  eq('обязательный пустой — ошибка', buildPlan([node('a', 'К1', { attrs: [{ name: 'REQ', value: '', owner: '', required: true }] })], [], [], ctxOf(b)).errors.map((e) => e.code), ['required-empty']);
  const svc = buildPlan([node('a', 'К1', { attrs: [{ name: 'GLOBAL_NUM', value: '5', owner: '', service: true }, { name: 'ALLOWED', value: '7', owner: '', service: true, allowService: true }] })], [], [], ctxOf(b));
  eq('служебный не пишется, разрешённый настройкой — пишется', [svc.steps.filter((s) => s.kind === 'attribute').map((s) => s.name), svc.warnings.map((w) => w.code)], [['ALLOWED'], ['service-skipped']]);
  eq('Device Designation — не атрибут, а обозначение', buildPlan([node('a', 'К1', { attrs: [{ name: 'Device Designation', value: 'К1', owner: '' }] })], [], [], ctxOf(b)).steps.filter((s) => s.kind === 'attribute').length, 0);

  eq('обозначение уже есть в проекте E3', buildPlan([node('a', 'К1')], [], [], ctxOf(b, { designations: new Map([['К1', 'чужой']]) })).errors.map((e) => e.code), ['duplicate-designation']);
  eq('своё же обозначение — не повтор', buildPlan([node('a', 'К1')], [], [], ctxOf(b, { designations: new Map([['К1', 'a']]) })).errors.length, 0);
  eq('повтор внутри выгрузки', buildPlan([node('a', 'К1'), node('c', 'К1')], [], [], ctxOf(b)).errors.map((e) => e.code), ['duplicate-designation']);
  eq('блок на занятом месте', buildPlan([node('a', 'К1')], [], [], ctxOf(b, { occupied: [{ x: 50, y: 20, w: 100, h: 100 }] })).errors.map((e) => e.code), ['overlap']);
  eq('блок за рабочим полем', buildPlan([node('a', 'К1', { rect: { x: 400, y: 30, w: 40, h: 30 } })], [], [], ctxOf(b)).errors.map((e) => e.code), ['outside']);
  eq('ошибки перечислены вместе', buildPlan([node('a', 'К1')], [], [], ctxOf(b, { e3Key: 'OTHER', sheet: 'Лист 3' })).errors.length, 2);
}

console.log('Шаги и сводка');
{
  const b = fresh();
  const plan = buildPlan([node('a', 'К1'), node('c', 'К2', { solutionName: 'Фильтр_ФВД', solutionId: '03.02.01', rect: { x: 120, y: 30, w: 45, h: 35 } })], [], [], ctxOf(b));
  const kinds = plan.steps.map((s) => s.kind);
  const order = ['place', 'designation', 'attribute', 'link'];
  yes('порядок: блоки → обозначения → атрибуты → связь', kinds.every((k, i) => i === 0 || order.indexOf(kinds[i - 1]) <= order.indexOf(k)));
  eq('атрибуты связи — последними', kinds.slice(-2), ['link', 'link']);
  yes('на каждый блок своя отметка выгрузки', plan.steps.filter((s) => s.kind === 'place').every((s) => s.mark === `X1:${s.positionId}`));
  eq('сводка словами', summaryText(plan.summary), 'поставить 2 · обновить 0 · заменить 0 · удалить 0');
  yes('версия связи — версия узла и номер выгрузки', plan.steps.filter((s) => s.kind === 'link').every((s) => s.ver === 'v1#1'));
}

console.log('Выгрузка на подставном мосте');
{
  const b = fresh();
  const r = await exportAll(b, [node('a', 'К1'), node('c', 'К2', { rect: { x: 120, y: 30, w: 40, h: 30 } })]);
  eq('выгрузка прошла целиком', [r.run.state, isComplete(r.plan.steps, r.journal), r.journal.every((j) => j.ok)], ['DONE', true, true]);
  eq('в E3 два блока со связью', (await b.readBound()).map((x) => [x.positionId, x.designation, x.version]), [['a', 'К1', 'v1#1'], ['c', 'К2', 'v1#1']]);
  eq('атрибуты изделий записаны', (await b.readBound())[0].attrs, { '|GLOBAL_TAG_DEVICE': 'К1', '#2|MOTOR_Мощность': '5,5' });
  eq('связи собраны по узлам', r.bindings.map((x) => [x.elementId, x.sentVersion, x.state, x.lastExportId, x.x]), [['a', 'v1', 'PLACED', 'X1', 60], ['c', 'v1', 'PLACED', 'X1', 120]]);
  eq('в журнале по записи на шаг', r.journal.length, r.plan.steps.length);
  // блока нет в базе: шаг не проходит, а выгрузка не притворяется целой
  const lack = new FakeE3({ projectKey: 'KEY', parts: [] });
  const plan = buildPlan([node('a', 'К1')], [], [], ctxOf(lack, { partsInBase: new Set(['Клапан_К24_КП2']) }));
  const journal: JournalEntry[] = [];
  await runSteps(lack, plan.steps, plan.steps.map((_, i) => i), (e) => { journal.push(e); });
  eq('шаг не прошёл — неполная выгрузка', [journal[0].ok, isComplete(plan.steps, journal)], [false, false]);
  // «занят» — подождали и прошло
  const busy = fresh(); busy.mode.busy = 2;
  const wait = await exportAll(busy, [node('a', 'К1')]);
  eq('«занят» два раза — выгрузка прошла после ожидания', [wait.run.state, wait.bindings.length], ['DONE', 1]);
  const stuck = fresh(); stuck.mode.busy = true;
  const stop = buildPlan([node('a', 'К1')], [], [], ctxOf(stuck));
  const out = await runSteps(stuck, stop.steps, stop.steps.map((_, i) => i), () => undefined, { busyMs: 20, pauseMs: 5 });
  eq('«занят» без конца — прервана с понятным сообщением', [out.state, out.error], ['INTERRUPTED', 'E3 не отвечает: закройте открытые окна E3']);
}

console.log('Обрыв и продолжение без дублей');
{
  const b = fresh();
  const nodes = [node('a', 'К1'), node('c', 'К2', { rect: { x: 120, y: 30, w: 40, h: 30 } }), node('d', 'К3', { rect: { x: 180, y: 30, w: 40, h: 30 } })];
  const plan = buildPlan(nodes, [], [], ctxOf(b));
  b.mode.failAtStep = 5; // посреди плана: блоки поставлены, связи ещё нет
  const journal: JournalEntry[] = [];
  const first = await runSteps(b, plan.steps, plan.steps.map((_, i) => i), (e) => { journal.push(e); });
  eq('обрыв: выгрузка прервана, сделано 5 шагов', [first.state, progressOf(plan.steps, journal)], ['INTERRUPTED', { done: 5, total: plan.steps.length }]);
  eq('до обрыва блоки уже стоят, а связи нет — E3 их «не видит»', [b.blocks.length, (await b.readBound()).length], [3, 0]);
  eq('невыполненные шаги найдены по журналу', remainingSteps(plan.steps, journal).length, plan.steps.length - 5);
  // продолжение: те же шаги плана, только оставшиеся
  const second = await runSteps(b, plan.steps, remainingSteps(plan.steps, journal), (e) => { journal.push(e); });
  eq('продолжение довело выгрузку до конца', [second.state, isComplete(plan.steps, journal)], ['DONE', true]);
  eq('дублей нет: три блока, три связи', [b.blocks.length, (await b.readBound()).length], [3, 3]);
  eq('каждый блок поставлен ровно раз', b.log.filter((s) => s.kind === 'place').length, 3);
  // повтор самого шага «поставить» (журнал потерялся) тоже не плодит блоки: блок находят по отметке выгрузки
  const lost = fresh();
  const p2 = buildPlan([node('a', 'К1')], [], [], ctxOf(lost));
  b.mode.failAtStep = null;
  await runSteps(lost, p2.steps, [0], () => undefined);
  await runSteps(lost, p2.steps, p2.steps.map((_, i) => i), () => undefined);
  eq('повтор шага без журнала не ставит второй блок', lost.blocks.length, 1);
  const all = buildBindings(plan, journal, nodes, [], { sheet: 'Лист 12', exportId: 'X1' });
  eq('связи появились после продолжения', all.length, 3);
}

console.log('Убрать сделанное');
{
  const b = fresh();
  const nodes = [node('a', 'К1'), node('c', 'К2', { rect: { x: 120, y: 30, w: 40, h: 30 } }), node('d', 'К3', { rect: { x: 180, y: 30, w: 40, h: 30 } })];
  const r = await exportAll(b, nodes);
  b.wire('c');           // инженер провёл провода
  b.move('d', { x: 200, y: 60 }); // сдвинул блок
  const undo = planUndo(r.plan.steps, r.journal, await b.readBound(), r.bindings);
  eq('убираются только нетронутые', undo.remove, ['a']);
  eq('тронутые называются с причиной', undo.kept, [{ positionId: 'c', reason: 'к блоку проведены провода' }, { positionId: 'd', reason: 'блок сдвинут в E3' }]);
  await b.apply(undoSteps('X1', undo.remove), () => undefined);
  eq('в E3 остались только тронутые блоки', b.blocks.map((x) => x.attrs.FLUX_BLOCK), ['c', 'd']);
  const edited = fresh();
  const e = await exportAll(edited, [node('a', 'К1')]);
  edited.editAttr('a', '#2', 'MOTOR_Мощность', '7,5');
  eq('правка атрибута в E3 — тоже «трогали»', planUndo(e.plan.steps, e.journal, await edited.readBound(), e.bindings).kept.map((k) => k.reason), ['значения атрибутов правили в E3']);
  // обрыв: блок поставлен, связи нет — убрать можно по журналу
  const cut = fresh(); cut.mode.failAtStep = 2;
  const p = buildPlan([node('a', 'К1')], [], [], ctxOf(cut));
  const j: JournalEntry[] = [];
  await runSteps(cut, p.steps, p.steps.map((_, i) => i), (x) => { j.push(x); });
  const u = planUndo(p.steps, j, await cut.readBound(), []);
  eq('прерванную выгрузку убрать можно: блок без связи найдётся по отметке', [u.remove, cut.blocks.length], [['a'], 1]);
  await cut.apply(undoSteps('X1', u.remove), () => undefined);
  eq('после «убрать» блока нет', cut.blocks.length, 0);
}

console.log('Сравнение трёх сторон');
{
  const sent = (id = 'a', extra: Partial<Binding> = {}): Binding => ({
    elementId: id, solutionId: '08.01.03', designation: 'К1', sheet: 'Лист 12', x: 60, y: 30, rotation: 0, sentVersion: 'v1',
    sentAttrs: { '|GLOBAL_TAG_DEVICE': 'К1', '#2|MOTOR_Мощность': '5,5' }, state: 'PLACED', lastExportId: 'X0', ...extra,
  });
  const inE3 = (extra: Record<string, unknown> = {}) => ({
    positionId: 'a', solutionId: '08.01.03', version: 'v1#1', designation: 'К1', sheet: 'Лист 12', rect: { x: 60, y: 30, w: 40, h: 30 },
    attrs: { '|GLOBAL_TAG_DEVICE': 'К1', '#2|MOTOR_Мощность': '5,5' }, ...extra,
  });
  eq('ничего не изменилось — не трогаем', compareNode(sent(), node('a', 'К1'), inE3()).kind, 'keep');
  // С1
  const c1 = compareNode(sent(), node('a', 'К1', { attrs: [{ name: 'GLOBAL_TAG_DEVICE', value: 'К1', owner: '' }, { name: 'MOTOR_Мощность', value: '7,5', owner: '#2' }] }), inE3());
  eq('С1: изменилась характеристика — обновить только её', [c1.kind, c1.attrs.map((a) => a.name), c1.attrs[0].value], ['update', ['MOTOR_Мощность'], '7,5']);
  // С2
  const c2 = compareNode(sent(), node('a', 'К1', { attrs: [{ name: 'GLOBAL_TAG_DEVICE', value: 'К1', owner: '' }, { name: 'MOTOR_Мощность', value: '5,5', owner: '#2' }, { name: 'MOTOR_Мощность', value: '11', owner: '#3' }] }), inE3());
  eq('С2: решение то же, появилось другое изделие — обновить атрибуты, блок не трогать', [c2.kind, c2.attrs.map((a) => `${a.owner}|${a.name}`)], ['update', ['#3|MOTOR_Мощность']]);
  // С5
  eq('С5: новая позиция — поставить', compareNode(undefined, node('n', 'К9'), undefined).kind, 'place');
  eq('С5: без отметки — не выгружать', [compareNode(undefined, node('n', 'К9', { checked: false }), undefined).kind, compareNode(undefined, node('n', 'К9', { checked: false }), undefined).reason], ['skip', 'not-checked']);
  // С7
  const c7 = compareNode(sent(), node('a', 'К7', { designation: 'К7' }), inE3());
  eq('С7: изменился тег — обновить обозначение', [c7.kind, c7.designation], ['update', 'К7']);
  const c7e = compareNode(sent(), node('a', 'К7', { designation: 'К7' }), inE3({ designation: 'К-инж' }));
  eq('С7: обозначение правил инженер — не перезаписывается (атрибуты с тегом обновляются)', [c7e.kind, c7e.designation, c7e.keptE3], ['update', undefined, ['Device Designation']]);
  // С10
  const c10 = compareNode(sent(), node('a', 'К1', { attrs: [{ name: 'GLOBAL_TAG_DEVICE', value: 'К1', owner: '' }, { name: 'MOTOR_Мощность', value: '7,5', owner: '#2' }] }), inE3({ rect: { x: 200, y: 90, w: 40, h: 30 } }));
  eq('С10: блок сдвинут в E3 — положение берётся из E3', [c10.movedInE3, c10.rect.x, c10.rect.y, c10.kind], [true, 200, 90, 'update']);
  eq('С10: сам сдвиг ничего не пишет', compareNode(sent(), node('a', 'К1'), inE3({ rect: { x: 200, y: 90, w: 40, h: 30 } })).kind, 'keep');
  // С16
  eq('С16: нужен ответ', compareNode(sent(), node('a', 'К1', { status: 'many' }), inE3()).reason, 'need-answer');
  eq('С16: нельзя выгрузить', compareNode(sent(), node('a', 'К1', { status: 'none' }), inE3()).reason, 'blocked');
  // правка в E3 не перезаписывается (умолчание С8)
  const c8 = compareNode(sent(), node('a', 'К1', { attrs: [{ name: 'MOTOR_Мощность', value: '7,5', owner: '#2' }] }), inE3({ attrs: { '#2|MOTOR_Мощность': '5,0' } }));
  eq('правку инженера в E3 не затираем', [c8.kind, c8.keptE3], ['keep', ['#2|MOTOR_Мощность']]);
  // другое решение и удалённое в E3
  eq('другое решение — заменить', compareNode(sent(), node('a', 'К1', { solutionId: '08.02.01' }), inE3()).kind, 'replace');
  eq('удалено в E3 — не восстанавливаем', compareNode(sent(), node('a', 'К1'), undefined).reason, 'deleted-in-e3');
}

console.log('Повторная выгрузка по трём сторонам');
{
  const b = fresh();
  const first = await exportAll(b, [node('a', 'К1')]);
  // во Flux изменилась мощность, инженер сдвинул блок в E3, тег поменялся
  const changed = node('a', 'К7', { version: 'v2', designation: 'К7', attrs: [{ name: 'GLOBAL_TAG_DEVICE', value: 'К7', owner: '' }, { name: 'MOTOR_Мощность', value: '7,5', owner: '#2' }] });
  b.move('a', { x: 200, y: 90 });
  const again = await exportAll(b, [changed], first.bindings, { exportId: 'X2', exportNo: 2 });
  eq('сводка: обновить 1', summaryText(again.plan.summary), 'поставить 0 · обновить 1 · заменить 0 · удалить 0');
  const bound = (await b.readBound())[0];
  eq('в E3 обновились обозначение и значения, блок остался там, куда его сдвинули', [bound.designation, bound.attrs!['#2|MOTOR_Мощность'], bound.rect.x, bound.rect.y, bound.version], ['К7', '7,5', 200, 90, 'v2#2']);
  eq('блок один — второй не поставлен', b.blocks.length, 1);
  eq('связь запомнила новую версию и положение из E3', again.bindings.map((x) => [x.sentVersion, x.x, x.y, x.lastExportId]), [['v2', 200, 90, 'X2']]);
}

if (failed) { console.error(`\nПровалено проверок: ${failed}`); process.exit(1); }
console.log('\nВсе проверки выгрузки в E3 пройдены');
})().catch((e) => { console.error(e); process.exit(1); });
