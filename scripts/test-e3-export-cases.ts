/**
 * Случаи повторной выгрузки С3–С20 (docs/e3-integration.md, 9.3) на подставном
 * мосте: у каждого случая — умолчание из таблицы и ответ инженера, который его
 * меняет. Мост — объект в памяти с теми же командами, что у настоящего.
 *
 * Запуск: npx tsx scripts/test-e3-export-cases.ts
 */
import { FakeE3 } from '../e3/fakeBridge';
import { buildPlan, copyBindings, projectCopyAsked, summaryText } from '../e3/exportPlan';
import { resolveManualChoice, whereStands } from '../e3/exportCompare';
import { buildBindings, runSteps, type JournalEntry } from '../e3/exportRun';
import type { Binding, Decisions, ExportAttr, ExportNode, PlanContext } from '../e3/exportTypes';

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  failed++;
  console.error(`  ✗ ${name} — получили ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`);
};

const POWER = (value: string, extra: Partial<ExportAttr> = {}): ExportAttr => ({ name: 'MOTOR_Мощность', value, owner: '#2', ...extra });
const node = (id: string, tag: string, extra: Partial<ExportNode> = {}): ExportNode => ({
  elementId: id, version: '1', tag, designation: tag, status: 'one', solutionId: '08.01.03', solutionName: 'Клапан_К24_КП2', rect: { x: 60, y: 30, w: 40, h: 30 },
  attrs: [POWER('5,5')], checked: true, ...extra,
});
const fresh = () => new FakeE3({ projectKey: 'KEY', parts: ['Клапан_К24_КП2', 'Клапан_КР24', 'Клапан_К24_ПОК'], pins: { 'Клапан_К24_КП2': ['1', '2', '3', '4'], 'Клапан_КР24': ['1', '2'], 'Клапан_К24_ПОК': ['1', '2', '3', '4'] } });
const ctxOf = (bridge: FakeE3, extra: Partial<PlanContext> = {}): PlanContext => ({
  expectedKey: 'KEY', e3Key: 'KEY', sheet: 'Лист 12', expectedSheet: 'Лист 12', partsInBase: new Set(bridge.options.parts), occupied: [], work: bridge.options.sheetInfo.work,
  designations: new Map(), linkAttrsDefined: true, exportId: 'X1', exportNo: 1, classifierVersion: 3, pins: new Map(Object.entries(bridge.options.pins)), ...extra,
});

/** Выгрузка целиком: план по свежему readBound → шаги → связи (как делает окно) */
async function go(bridge: FakeE3, nodes: ExportNode[], prev: Binding[], extra: Partial<PlanContext> = {}, decisions: Decisions = {}) {
  const bound = await bridge.readBound();
  const exportId = extra.exportId || 'X1';
  const plan = buildPlan(nodes, prev, bound, ctxOf(bridge, { ...extra, exportId }), { decisions });
  const journal: JournalEntry[] = [];
  await runSteps(bridge, plan.steps, plan.steps.map((_, i) => i), (e) => { journal.push(e); }, { pauseMs: 0 });
  const made = buildBindings(plan, journal, nodes, prev, { sheet: 'Лист 12', exportId });
  // Итоговая карта связей: новые поверх прежних, как пишет сервер
  const map = new Map(prev.map((b) => [b.elementId, b]));
  for (const b of made) map.set(b.elementId, b);
  return { plan, journal, bindings: [...map.values()], made };
}
const first = async (bridge: FakeE3, nodes: ExportNode[]) => (await go(bridge, nodes, [])).bindings;
const blockOf = async (bridge: FakeE3, id: string) => (await bridge.readBound()).find((b) => b.positionId === id);

(async () => {
console.log('С3: другое решение — блок ставится на место старого, висящие провода в отчёте');
{
  const b = fresh();
  const prev = await first(b, [node('a', 'К1')]);
  b.wire('a', ['3', '4']); // провода на выводах 3 и 4, а у нового блока их нет
  const next = node('a', 'К1', { solutionId: '08.02.01', solutionName: 'Клапан_КР24' });
  const r = await go(b, [next], prev, { exportId: 'X2', exportNo: 2 });
  eq('действие — замена, сводка', [r.plan.actions[0].kind, summaryText(r.plan.summary)], ['replace', 'поставить 0 · обновить 0 · заменить 1 · удалить 0']);
  eq('висящие провода названы по выводам', [r.plan.actions[0].dangling, r.plan.warnings.map((w) => w.code)], [['3', '4'], ['dangling-wires']]);
  eq('в E3 стоит новый блок на старом месте, старого нет', [b.blocks.length, b.blocks[0].block, b.blocks[0].rect.x, b.blocks[0].rect.y], [1, 'Клапан_КР24', 60, 30]);
  eq('связь знает новое решение', r.bindings[0].solutionId, '08.02.01');
  // тот же выбор, где выводы совпадают, висящих проводов нет
  const b2 = fresh(); const p2 = await first(b2, [node('a', 'К1')]); b2.wire('a', ['1', '2']);
  const same = await go(b2, [node('a', 'К1', { solutionId: '08.01.05', solutionName: 'Клапан_К24_ПОК' })], p2, { exportId: 'X2', exportNo: 2 });
  eq('выводы совпали — отчёта о проводах нет', same.plan.actions[0].dangling, []);
  eq('нет проводов — тоже нет', (await go(fresh(), [next], [])).plan.actions[0].dangling, undefined);
}

console.log('С4: позиция снята во Flux');
{
  const make = async () => { const b = fresh(); const prev = await first(b, [node('a', 'К1')]); return { b, prev }; };
  const gone = node('a', 'К1', { removed: true, attrs: [] });
  const { b, prev } = await make();
  const r = await go(b, [gone], prev, { exportId: 'X2', exportNo: 2 });
  eq('умолчание: оставить и пометить FLUX_STATUS = снята', [r.plan.actions[0].kind, b.blocks.length, b.blocks[0].attrs['|FLUX_STATUS'], r.bindings[0].state], ['mark-removed', 1, 'снята', 'REMOVED_IN_FLUX']);
  eq('вопрос с четырьмя вариантами', r.plan.questions[0].options.map((o) => o.value), ['mark', 'detach', 'delete', 'keep']);
  const again = await go(b, [gone], r.bindings, { exportId: 'X3', exportNo: 3 });
  eq('помеченная больше не беспокоит', [again.plan.errors.map((e) => e.code), again.plan.questions.length], [['nothing'], 0]);
  const d = await make();
  const del = await go(d.b, [gone], d.prev, { exportId: 'X2' }, { 'a|removed': 'delete' });
  eq('«удалить» убирает блок из E3 и закрывает связь', [del.plan.actions[0].kind, d.b.blocks.length, del.bindings[0].state], ['remove', 0, 'DETACHED']);
  const e = await make();
  const det = await go(e.b, [gone], e.prev, { exportId: 'X2' }, { 'a|removed': 'detach' });
  eq('«отвязать» оставляет блок без пометки и закрывает связь', [det.plan.actions[0].kind, e.b.blocks.length, e.b.blocks[0].attrs['|FLUX_STATUS'], det.bindings[0].state], ['detach', 1, undefined, 'DETACHED']);
  const k = await make();
  const keep = await go(k.b, [gone], k.prev, { exportId: 'X2' }, { 'a|removed': 'keep' });
  eq('«как есть» — ничего не делает', [keep.plan.actions[0].reason, k.b.blocks[0].attrs['|FLUX_STATUS']], ['removed-kept', undefined]);
}

console.log('С6: переподобрано — старая позиция заменена новой');
{
  const b = fresh();
  const prev = await first(b, [node('old', 'К1')]);
  const removed = node('old', 'К1', { removed: true, replacedBy: 'new', attrs: [] });
  const added = node('new', 'К1', { solutionId: '08.02.01', solutionName: 'Клапан_КР24', attrs: [POWER('7,5')], designation: 'К1' });
  const r = await go(b, [removed, added], prev, { exportId: 'X2', exportNo: 2, designations: new Map([['К1', 'old']]) });
  eq('старая молчит, новая заменяет', r.plan.actions.map((a) => [a.elementId, a.kind, a.replaces]), [['old', 'skip', undefined], ['new', 'replace', 'old']]);
  eq('в E3 один блок — новый, на старом месте', [b.blocks.length, b.blocks[0].block, b.blocks[0].attrs.FLUX_BLOCK, b.blocks[0].rect.x], [1, 'Клапан_КР24', 'new', 60]);
  eq('обозначение старой позиции не считается повтором', r.plan.errors, []);
  eq('связи: новая стоит, старая закрыта', r.bindings.map((x) => [x.elementId, x.state]).sort(), [['new', 'PLACED'], ['old', 'DETACHED']]);
  const lost = await go(fresh(), [removed, added], prev, { exportId: 'X2' });
  eq('старого блока в E3 нет — новая ставится на холсте', lost.plan.actions[1].kind, 'place');
}

console.log('С8, С9, С19: значение правили и в E3');
{
  const setup = async (conflict?: ExportAttr['conflict'], script?: boolean) => {
    const b = fresh();
    const attr = (v: string) => POWER(v, { ...(conflict ? { conflict } : {}), ...(script ? { script: true } : {}) });
    const prev = await first(b, [node('a', 'К1', { attrs: [attr('5,5')] })]);
    b.editAttr('a', '#2', 'MOTOR_Мощность', '5,0');
    return { b, prev, attr };
  };
  // С8: правили только в E3
  let s = await setup();
  let r = await go(s.b, [node('a', 'К1', { attrs: [s.attr('5,5')] })], s.prev, { exportId: 'X2' });
  eq('С8: по умолчанию оставляем значение E3 и спрашиваем', [r.plan.actions[0].kind, r.plan.questions[0].values, r.plan.questions[0].default], ['keep', { e3: '5,0', sent: '5,5', flux: '5,5' }, 'e3']);
  eq('С8: в E3 осталось 5,0', (await blockOf(s.b, 'a'))!.attrs!['#2|MOTOR_Мощность'], '5,0');
  s = await setup();
  r = await go(s.b, [node('a', 'К1', { attrs: [s.attr('5,5')] })], s.prev, { exportId: 'X2' }, { 'a|attr:#2|MOTOR_Мощность': 'flux' });
  eq('С8: «записать значение Flux» возвращает 5,5', [(await blockOf(s.b, 'a'))!.attrs!['#2|MOTOR_Мощность'], r.plan.actions[0].conflicts![0].applied], ['5,5', 'flux']);
  s = await setup();
  r = await go(s.b, [node('a', 'К1', { attrs: [s.attr('5,5')] })], s.prev, { exportId: 'X2' }, { 'a|attr:#2|MOTOR_Мощность': 'e3' });
  eq('С8: явное «оставить» запоминается — вопрос не повторится', [r.bindings[0].sentAttrs['#2|MOTOR_Мощность'], r.plan.questions.length], ['5,0', 0]);
  // С9: правили и в E3, и во Flux
  s = await setup();
  r = await go(s.b, [node('a', 'К1', { attrs: [s.attr('7,5')] })], s.prev, { exportId: 'X2' });
  eq('С9: три значения, не трогаем до решения', [r.plan.actions[0].conflicts![0].kind, r.plan.questions[0].values, (await blockOf(s.b, 'a'))!.attrs!['#2|MOTOR_Мощность']], ['both-changed', { e3: '5,0', sent: '5,5', flux: '7,5' }, '5,0']);
  s = await setup();
  await go(s.b, [node('a', 'К1', { attrs: [s.attr('7,5')] })], s.prev, { exportId: 'X2' }, { 'a|attr:#2|MOTOR_Мощность': 'flux' });
  eq('С9: после ответа «Flux» записано 7,5', (await blockOf(s.b, 'a'))!.attrs!['#2|MOTOR_Мощность'], '7,5');
  // С19 и правила из настройки атрибута
  s = await setup('ask', true);
  r = await go(s.b, [node('a', 'К1', { attrs: [s.attr('5,5')] })], s.prev, { exportId: 'X2' });
  eq('С19: переписал скрипт — отдельный вид, не правка инженера', r.plan.actions[0].conflicts![0].kind, 'script');
  s = await setup('flux', true);
  await go(s.b, [node('a', 'К1', { attrs: [s.attr('5,5')] })], s.prev, { exportId: 'X2' });
  eq('правило «Flux главнее» пишет без вопроса', (await blockOf(s.b, 'a'))!.attrs!['#2|MOTOR_Мощность'], '5,5');
  s = await setup('script', true);
  r = await go(s.b, [node('a', 'К1', { attrs: [s.attr('5,5')] })], s.prev, { exportId: 'X2' });
  eq('правило «скрипт главнее» оставляет значение E3 без вопроса', [r.plan.questions.length, (await blockOf(s.b, 'a'))!.attrs!['#2|MOTOR_Мощность']], [0, '5,0']);
  s = await setup('flux-once');
  r = await go(s.b, [node('a', 'К1', { attrs: [s.attr('5,5')] })], s.prev, { exportId: 'X2' });
  eq('правило «Flux только первый раз» не перезаписывает', [r.plan.questions.length, (await blockOf(s.b, 'a'))!.attrs!['#2|MOTOR_Мощность']], [0, '5,0']);
}

console.log('С11: инженер удалил устройство в E3');
{
  const make = async () => { const b = fresh(); const prev = await first(b, [node('a', 'К1')]); b.deleteBlock('a'); return { b, prev }; };
  const now = node('a', 'К1');
  let m = await make();
  let r = await go(m.b, [now], m.prev, { exportId: 'X2' });
  eq('умолчание: не восстанавливать, спросить', [r.plan.errors.map((e) => e.code), r.plan.actions[0].reason, r.plan.questions[0].options.map((o) => o.value)], [['nothing'], 'deleted-in-e3', ['skip', 'redo', 'detach']]);
  eq('блок не появился', m.b.blocks.length, 0);
  m = await make();
  r = await go(m.b, [now], m.prev, { exportId: 'X2' }, { 'a|deleted': 'redo' });
  eq('«выгрузить снова» ставит блок заново', [m.b.blocks.length, r.bindings[0].state, r.plan.actions[0].kind], [1, 'PLACED', 'place']);
  m = await make();
  r = await go(m.b, [now], m.prev, { exportId: 'X2' }, { 'a|deleted': 'detach' });
  eq('«не нужно» закрывает связь', [m.b.blocks.length, r.bindings[0].state], [0, 'DETACHED']);
  const after = await go(m.b, [now], r.bindings, { exportId: 'X3' });
  eq('отвязанное больше не предлагается', [after.plan.actions[0].reason, after.plan.questions.length], ['detached', 0]);
}

console.log('С12: копия блока с тем же FLUX_BLOCK');
{
  const b = fresh();
  const prev = await first(b, [node('a', 'К1')]);
  const copy = b.copyBlock('a')!;
  const r = await go(b, [node('a', 'К1', { attrs: [POWER('7,5')] })], prev, { exportId: 'X2' });
  eq('до любой записи — ошибка и вопрос «какой главный»', [r.plan.errors.map((e) => e.code), r.plan.steps.length, r.plan.questions[0].options.length], [['duplicate-block'], 0, 2]);
  eq('E3 не тронут', b.blocks.length, 2);
  const mainId = (await b.readBound()).find((x) => x.objectId !== copy.id)!.objectId;
  const ok = await go(b, [node('a', 'К1', { attrs: [POWER('7,5')] })], prev, { exportId: 'X2' }, { 'a|dup': String(mainId) });
  eq('после ответа: у копии снята связь, главный обновлён', [ok.plan.errors, b.blocks.find((x) => x.id === copy.id)!.attrs.FLUX_BLOCK, b.blocks.find((x) => x.id === mainId)!.attrs['#2|MOTOR_Мощность']], [[], undefined, '7,5']);
  eq('шаг «отвязать» идёт среди блоков, до записи значений', ok.plan.steps[0].kind, 'unlink');
}

console.log('С13: копия проекта E3');
{
  const ctx = { e3Key: 'KEY', expectedKey: 'KEY', e3Path: 'D:\\E3\\Корпус3_ред2.e3s', linkedPath: 'D:\\E3\\Корпус3.e3s' };
  eq('тот же ключ, другой путь — вопрос', projectCopyAsked(ctx), true);
  eq('тот же путь — не копия', projectCopyAsked({ ...ctx, e3Path: ctx.linkedPath }), false);
  eq('другой ключ — это уже другая ошибка', projectCopyAsked({ ...ctx, e3Key: 'OTHER' }), false);
  const b = fresh();
  const asked = buildPlan([node('a', 'К1')], [], [], ctxOf(b, { e3Path: ctx.e3Path, linkedPath: ctx.linkedPath }));
  eq('план спрашивает и ничего не пишет', [asked.errors.map((e) => e.code), asked.questions[0].options.map((o) => o.value), asked.steps.length], [['project-copy'], ['new', 'moved'], 0]);
  eq('«переехал» — выгрузка идёт', buildPlan([node('a', 'К1')], [], [], ctxOf(b, { e3Path: ctx.e3Path, linkedPath: ctx.linkedPath, projectChoice: 'moved' })).errors, []);
  const sent: Binding[] = [{ elementId: 'a', solutionId: 's', designation: 'К1', sheet: 'Лист 12', x: 1, y: 2, rotation: 0, sentVersion: '1', sentAttrs: { '|A': '1' }, state: 'PLACED', lastExportId: 'X1' }];
  const copy = copyBindings(sent);
  copy[0].sentAttrs['|A'] = '2';
  eq('«новый проект» — связи копируются, а не делятся', [copy[0].elementId, sent[0].sentAttrs['|A']], ['a', '1']);
}

console.log('С14: классификатор или профиль изменились');
{
  const b = fresh();
  const prev = await first(b, [node('a', 'К1')]);
  const now = node('a', 'К1', { solutionId: '08.02.01', solutionName: 'Клапан_КР24', rulesChanged: true });
  const r = await go(b, [now], prev, { exportId: 'X2' });
  eq('по умолчанию не меняем, показываем «по новым правилам»', [r.plan.actions[0].kind, r.plan.actions[0].proposal?.solutionName, r.plan.questions[0].text.includes('по новым правилам: Клапан_КР24'), b.blocks[0].block], ['keep', 'Клапан_КР24', true, 'Клапан_К24_КП2']);
  const apply = await go(b, [now], prev, { exportId: 'X2' }, { 'a|rules': 'apply' });
  eq('с согласием блок заменяется', [apply.plan.actions[0].kind, b.blocks[0].block], ['replace', 'Клапан_КР24']);
}

console.log('С15: ручной выбор и смена типа');
{
  eq('тип тот же — ручной выбор остаётся', resolveManualChoice({ solutionId: '08.01.07', cls: 'КЛАПАН' }, 'КЛАПАН', '08.01.03'), { solutionId: '08.01.07', dropped: false });
  eq('тип сменился — ручной выбор снят, новый подбор', resolveManualChoice({ solutionId: '08.01.07', cls: 'КЛАПАН' }, 'ФИЛЬТР', '03.02.01'), { solutionId: '03.02.01', dropped: true });
  eq('ручного выбора не было', resolveManualChoice(undefined, 'ФИЛЬТР', '03.02.01'), { solutionId: '03.02.01', dropped: false });
}

console.log('С17: выгрузка идёт по снимку');
{
  const b = fresh();
  const nodes = [node('a', 'К1'), node('c', 'К2', { rect: { x: 120, y: 30, w: 40, h: 30 } })];
  const plan = buildPlan(nodes, [], [], ctxOf(b));
  // ОВ переподбирает, пока КИП выгружает: узлы меняются после нажатия
  nodes[0].solutionName = 'Клапан_КР24'; nodes[0].attrs[0].value = '99'; nodes[1].tag = 'другой';
  const journal: JournalEntry[] = [];
  await runSteps(b, plan.steps, plan.steps.map((_, i) => i), (e) => { journal.push(e); });
  eq('в E3 то, что было в снимке', [b.blocks.map((x) => x.block), (await b.readBound())[0].attrs!['#2|MOTOR_Мощность']], [['Клапан_К24_КП2', 'Клапан_К24_КП2'], '5,5']);
  const bindings = buildBindings(plan, journal, [node('a', 'К1'), node('c', 'К2', { rect: { x: 120, y: 30, w: 40, h: 30 } })], [], { sheet: 'Лист 12', exportId: 'X1' });
  const after = await go(b, [node('a', 'К1', { version: '2', solutionId: '08.02.01', solutionName: 'Клапан_КР24' })], bindings, { exportId: 'X2' });
  eq('после выгрузки позиция видна как изменившаяся', after.plan.actions[0].kind, 'replace');
}

console.log('С20: решение убрано из каталога, а блок уже стоит');
{
  const b = fresh();
  const prev = await first(b, [node('a', 'К1'), node('c', 'К2', { rect: { x: 120, y: 30, w: 40, h: 30 } })]);
  const gone = { solutionRemoved: true };
  const r = await go(b, [node('a', 'К1', gone), node('n', 'К9', { ...gone, rect: { x: 200, y: 30, w: 40, h: 30 } })], prev, { exportId: 'X2' });
  eq('новый блок с убранным решением запрещён, стоящий не тронут', [r.plan.actions.map((a) => a.kind), r.plan.warnings.map((w) => w.code), b.blocks.length], [['keep', 'skip'], ['solution-removed'], 2]);
  eq('видно, где решение стоит', whereStands('08.01.03', prev), ['a', 'c']);
}

if (failed) { console.error(`\nПровалено проверок: ${failed}`); process.exit(1); }
console.log('\nВсе проверки случаев повторной выгрузки E3 пройдены');
})().catch((e) => { console.error(e); process.exit(1); });
