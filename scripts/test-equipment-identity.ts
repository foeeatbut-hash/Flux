/**
 * ID позиции при повторной загрузке: он принадлежит изделию, а не пути в файле
 * (docs/e3-integration.md, часть 1).
 *
 * Берётся выдуманная выгрузка САПР из scripts/fixtures/veza.ts, грузится в базу
 * в памяти, а потом тот же расчёт правится в памяти — так, как его правят в
 * жизни: сдвигаются коды блоков (Д1), убирается один из двух вентиляторов (Д2),
 * переименовывается установка (Д4), появляются одноимённые (Д5). На каждом
 * случае сверяется главное: ID следует за изделием, а ПЛАН и ЗАПИСЬ сходятся —
 * то, что предпросмотр назвал «в ту же запись», в базе лежит в той же записи.
 *
 * Запуск: npx tsx scripts/test-equipment-identity.ts
 */
import { VEZA_SAMPLE_XML } from './fixtures/veza';
import { memoryEquipmentDb, type MemoryDb } from './fixtures/memoryEquipmentDb';
import { parseVezaXml } from '../server/vezaXml';
import { detectEquipType, type ParsedBlock, type ParsedUnit } from '../server/equipmentParser';
import { planEquipmentImport, filterBySelection, blockKey, type ImportPlan } from '../server/equipmentPlan';
import { importEquipmentToDB } from '../server/equipmentImport';
import { setPrisma } from '../server/context';
import { registerEquipmentUndoRoutes } from '../server/routes/equipmentUndo';
import { missingKey } from '../server/equipmentResolve';
import express from 'express';

let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond ? console.log('  ✓', name) : (failed++, console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)));

// ── Расчёт и его правки в памяти ────────────────────────────────────────────
// Через JSON, а не structuredClone: разбор отдаёт двум двигателям один и тот же объект характеристик, и правка одного меняла бы оба
const sample = (): ParsedUnit[] => JSON.parse(JSON.stringify((parseVezaXml(VEZA_SAMPLE_XML, detectEquipType) as any).units));
/** Только первая установка: у второй из выгрузки нет моноблоков */
const veza = (opts: { tags?: boolean } = {}): ParsedUnit => {
  const u = sample()[0];
  if (!opts.tags) { u.tags = []; for (const mb of u.monoblocks) for (const b of mb.blocks) delete b.tags; }
  return u;
};
const blocksOf = (u: ParsedUnit) => u.monoblocks.flatMap(m => m.blocks);
const block = (u: ParsedUnit, name: string): ParsedBlock => blocksOf(u).find(b => b.name === name)!;
/** Меняет код блока и все пути внутри него: «1.3/вентилятор1» → «1.4/вентилятор1» */
const recode = (u: ParsedUnit, from: string, to: string) => {
  for (const b of blocksOf(u)) {
    if (b.name === from || b.name.startsWith(`${from}/`)) b.name = to + b.name.slice(from.length);
    if (b.parentName === from || b.parentName?.startsWith(`${from}/`)) b.parentName = to + b.parentName.slice(from.length);
  }
};
const mkBlock = (name: string, title: string, equipType: string, params: [string, string][] = []): ParsedBlock => ({
  name, title, equipType, role: 'БЛОК', sourceOrder: 0,
  groups: params.length ? [{ title: 'Параметры', params: params.map(([key, value]) => ({ key, value, unit: '' })) }] : [],
});

const FILE = 'расчёт.xml';
interface Run { plan: ImportPlan; summary: Awaited<ReturnType<typeof importEquipmentToDB>>; before: Set<string> }

/** План, затем запись — на одних и тех же данных и решениях, как это делает окно */
async function load(db: MemoryDb, units: ParsedUnit[], o: { file?: string; choices?: Record<string, string>; select?: Set<string> | null; remove?: boolean; mode?: 'wait' | 'immediate' } = {}): Promise<Run> {
  const file = o.file || FILE;
  const before = new Set(db.elements.map(e => e.id));
  const result: any = { units: JSON.parse(JSON.stringify(units)) };
  const plan = await planEquipmentImport(db.prisma, 'p1', 'AHU', result, { fileName: file, choices: o.choices, removeMissing: o.remove });
  const chosen = o.select ? filterBySelection(result, o.select) : result;
  const summary = await importEquipmentToDB(db.prisma, 'p1', 'AHU', file, chosen, o.mode || 'wait', plan.tagLinks, {}, { choices: o.choices, full: result, removeMissing: o.remove });
  return { plan, summary, before };
}

const systemNamed = (db: MemoryDb, name: string) => db.systems.filter(s => s.name === name);
function at(db: MemoryDb, unit: string, mb: string, code: string, systemId?: string) {
  const sys = systemId ? db.systems.find(s => s.id === systemId) : systemNamed(db, unit)[0];
  const m = db.monoblocks.find(x => x.systemId === sys?.id && x.name === (mb || '__unit__'));
  return db.elements.find(e => e.monoblockId === m?.id && e.itemCode === code && e.status !== 'REMOVED');
}
const idOf = (db: MemoryDb, unit: string, mb: string, code: string) => at(db, unit, mb, code)?.id;
const byId = (db: MemoryDb, id: string) => db.elements.find(e => e.id === id);

/** План и запись сошлись: каждая позиция плана лежит в базе в той записи, которую назвал план */
function parity(name: string, db: MemoryDb, run: Run, unitNames: string[]) {
  const bad: string[] = [];
  const mbOf = (el: any) => db.monoblocks.find(m => m.id === el.monoblockId)?.name;
  for (const b of run.plan.blocks) {
    if (!unitNames.includes(b.systemName)) continue;
    const want = b.elementId
      ? byId(db, b.elementId)
      : db.elements.find(e => !run.before.has(e.id) && e.itemCode === b.itemCode && mbOf(e) === (b.monoblockName || '__unit__')
        && db.systems.find(s => db.monoblocks.find(m => m.id === e.monoblockId)?.systemId === s.id)?.name === b.systemName);
    if (!want) { bad.push(`${b.key}: записи нет`); continue; }
    // Запись названа планом — значит, в ней лежит позиция по новому адресу, и она не снята
    if (want.itemCode !== b.itemCode || mbOf(want) !== (b.monoblockName || '__unit__') || want.status === 'REMOVED') bad.push(`${b.key}: в записи ${want.id} адрес ${mbOf(want)}/${want.itemCode}, ${want.status}`);
    if (b.replacesId && byId(db, b.replacesId)?.status !== 'REMOVED') bad.push(`${b.key}: прежняя запись не снята`);
  }
  ok(`${name}: план и запись называют одни и те же записи`, bad.length === 0, bad);
  ok(`${name}: счётчики плана и записи равны`,
    run.plan.totals.newBlocks === run.summary.newBlocks && run.plan.totals.updatedBlocks === run.summary.updatedBlocks,
    { plan: run.plan.totals, summary: [run.summary.newBlocks, run.summary.updatedBlocks] });
}

const U1 = 'PR-01-AS-001';
const mbN = 'Моноблок 1';
const fanKey = (u: string, n: string) => blockKey(u, mbN, n);

(async () => {
  console.log('1. Первая загрузка без единого тега: ID на всех уровнях, установка тоже (Д6)');
  const db1 = memoryEquipmentDb();
  const first = veza();
  const bare: ParsedUnit = { name: 'П-пустая', title: 'Без параметров', groups: [], monoblocks: [{ name: 'М1', title: '', blocks: [mkBlock('1', 'Фильтр карманный', 'ФИЛЬТР')] }] };
  const lone: ParsedUnit = { name: 'П-одна', title: '', groups: [], monoblocks: [] };
  const r1 = await load(db1, [first, bare, lone]);
  const names = [U1, 'П-пустая', 'П-одна'];
  ok('все записи получили ID, и он у каждой свой', db1.elements.every(e => !!e.id) && new Set(db1.elements.map(e => e.id)).size === db1.elements.length);
  ok('записей ровно столько, сколько позиций в плане', db1.elements.length === r1.plan.blocks.length, [db1.elements.length, r1.plan.blocks.length]);
  ok('у каждой установки есть своя запись, даже без параметров', names.every(n => !!idOf(db1, n, '', '__unit__')));
  ok('план говорит об этом же: служебный блок «создать»', names.every(n => r1.plan.blocks.find(b => b.systemName === n && b.itemCode === '__unit__')?.action === 'create'));
  const motor = block(first, '1.3/вентилятор1/двигатель1');
  ok('уровни: блок, подпозиция, подпозиция подпозиции',
    !!at(db1, U1, mbN, '1.3') && !!at(db1, U1, mbN, '1.3/вентилятор1') && !!at(db1, U1, mbN, motor.name));
  ok('владелец записан ссылкой на запись, а не на путь',
    at(db1, U1, mbN, motor.name)!.parentElementId === idOf(db1, U1, mbN, '1.3/вентилятор1'));
  parity('первая загрузка', db1, r1, names);
  const ids1 = new Map(db1.elements.map(e => [`${e.monoblockId}|${e.itemCode}`, e.id]));
  const again = await load(db1, [first, bare, lone]);
  ok('повторная загрузка того же расчёта ничего не заводит', again.summary.newBlocks === 0 && db1.elements.length === ids1.size, again.summary);
  ok('и не спрашивает: спорных строк нет', again.plan.matches.length === 0 && again.plan.systemRows.length === 0);
  ok('ID не сменился ни у одной записи', db1.elements.every(e => ids1.get(`${e.monoblockId}|${e.itemCode}`) === e.id));

  {
    // Окно присылает выбор области: установка без параметров и без блоков в нём тоже выбрана
    const dbSel = memoryEquipmentDb();
    const keys = new Set<string>([blockKey('П-одна', '', '__unit__')]);
    const sel = await load(dbSel, [lone], { select: keys });
    ok('выбор области не отбрасывает установку без параметров и блоков', !!idOf(dbSel, 'П-одна', '', '__unit__'), sel.summary);
    const none = await load(memoryEquipmentDb(), [lone], { select: new Set<string>() });
    ok('а если не выбрано ничего — не заводит', none.summary.systems === 0 && none.summary.newBlocks === 0, none.summary);
    const dbTwin = memoryEquipmentDb();
    const twins = await load(dbTwin, [{ ...lone, title: 'Первая' }, { ...lone, title: 'Вторая' }]);
    ok('одноимённые установки одного ввоза остаются двумя', dbTwin.systems.length === 2 && twins.summary.systems === 2, dbTwin.systems);
  }

  console.log('2. Тег, поставленный потом, ложится на нужный ID');
  {
    const motorId = idOf(db1, U1, mbN, motor.name)!;
    const tagged = veza(); block(tagged, motor.name).tags = ['PR-01-MT-001A'];
    const r = await load(db1, [tagged, bare, lone]);
    ok('тег создан и стоит на том же двигателе', db1.tagsOf(motorId).includes('PR-01-MT-001A'), db1.tags);
    ok('новых записей нет — тег лёг на прежнюю', r.summary.newBlocks === 0, r.summary);
    ok('других позиций тег не получил', db1.elements.filter(e => db1.tagsOf(e.id).includes('PR-01-MT-001A')).length === 1);
  }

  console.log('3. Д1: в установку вставили блок, коды сдвинулись (теги не проставлены)');
  const shifted = (): ParsedUnit => {
    const u = veza();
    recode(u, '1.3', '1.4'); recode(u, '1.2', '1.3');
    u.monoblocks[0].blocks.splice(2, 0, mkBlock('1.2', 'Нагреватель водяной', 'НАГРЕВАТЕЛЬ', [['Мощность', '40']]));
    return u;
  };
  const dbA = memoryEquipmentDb();
  await load(dbA, [veza()]);
  const filterId = idOf(dbA, U1, mbN, '1.2')!, fanId = idOf(dbA, U1, mbN, '1.3')!;
  const clapanId = idOf(dbA, U1, mbN, '1.1/клапан1')!;
  const fan1Id = idOf(dbA, U1, mbN, '1.3/вентилятор1')!, motor1Id = idOf(dbA, U1, mbN, '1.3/вентилятор1/двигатель1')!;
  const fan2Id = idOf(dbA, U1, mbN, '1.3/вентилятор2')!;
  const rA = await load(dbA, [shifted()]);
  ok('фильтр поехал на новый адрес вместе со своим ID', idOf(dbA, U1, mbN, '1.3') === filterId);
  ok('вентиляторная секция — со своим', idOf(dbA, U1, mbN, '1.4') === fanId);
  ok('подпозиции секции пошли за ней', idOf(dbA, U1, mbN, '1.4/вентилятор1') === fan1Id && idOf(dbA, U1, mbN, '1.4/вентилятор2') === fan2Id
    && idOf(dbA, U1, mbN, '1.4/вентилятор1/двигатель1') === motor1Id);
  ok('и владелец у них прежний', byId(dbA, motor1Id).parentElementId === fan1Id);
  ok('блок с клапаном остался на месте', idOf(dbA, U1, mbN, '1.1/клапан1') === clapanId);
  const heater = at(dbA, U1, mbN, '1.2');
  ok('новый нагреватель получил новый ID, а не фильтра', !!heater && heater.id !== filterId && !rA.before.has(heater.id));
  ok('спрашивается только о переехавших верхнего уровня', rA.plan.matches.map(m => m.kind).join() === 'moved,moved'
    && rA.plan.matches.every(m => m.choice === 'same'), rA.plan.matches.map(m => [m.key, m.kind, m.choice]));
  ok('строка плана называет, откуда и куда', rA.plan.matches.some(m => /1\.2.*1\.3/.test(m.why)), rA.plan.matches.map(m => m.why));
  ok('в плане переехавший — «обновить прежнюю запись»', rA.plan.blocks.find(b => b.itemCode === '1.3')?.elementId === filterId
    && rA.plan.blocks.find(b => b.itemCode === '1.3')?.matchedBy === 'moved');
  parity('Д1', dbA, rA, [U1]);

  console.log('3а. То же, но инженер решил иначе');
  {
    const k = fanKey(U1, '1.3');
    const dbB = memoryEquipmentDb();
    await load(dbB, [veza()]);
    const fid = idOf(dbB, U1, mbN, '1.2')!;
    const r = await load(dbB, [shifted()], { choices: { [k]: 'reselect' } });
    const newId = idOf(dbB, U1, mbN, '1.3')!;
    ok('«Переподобрано»: на адрес встала новая запись', newId !== fid && !r.before.has(newId));
    ok('прежняя снята, а не удалена', byId(dbB, fid)?.status === 'REMOVED');
    const log = JSON.parse(byId(dbB, fid)!.conflictLog);
    ok('связь «заменено на» указывает на новую запись', log.__removal?.replacedBy === newId && log.__removal.why === 'reselected' && !!log.__removal.batchId, log);
    ok('снятие записано в историю партии', dbB.history.some(h => h.elementId === fid && h.changeType === 'REMOVE' && h.batchId === r.summary.batchId));
    ok('план показал то же: создать, прежнюю снять', r.plan.blocks.find(b => b.itemCode === '1.3')?.replacesId === fid
      && r.plan.blocks.find(b => b.itemCode === '1.3')?.action === 'create');
    parity('Д1, переподобрано', dbB, r, [U1]);

    const dbC = memoryEquipmentDb();
    await load(dbC, [veza()]);
    const cid = idOf(dbC, U1, mbN, '1.2')!;
    const rc = await load(dbC, [shifted()], { choices: { [k]: 'other' } });
    ok('«Другое изделие»: прежняя снята без связи', byId(dbC, cid)?.status === 'REMOVED'
      && JSON.parse(byId(dbC, cid)!.conflictLog).__removal.replacedBy === undefined);
    ok('«Другое изделие»: на адресе новая запись', idOf(dbC, U1, mbN, '1.3') !== cid);
    parity('Д1, другое изделие', dbC, rc, [U1]);
    const repeat = await load(dbC, [shifted()]);
    ok('повторная загрузка не поднимает снятую запись и не снимает новую',
      repeat.summary.newBlocks === 0 && !repeat.summary.supersededBlocks && byId(dbC, cid)?.status === 'REMOVED' && repeat.plan.matches.length === 0, repeat.summary);
    const junk = await load(memoryEquipmentDb(), [veza()], { choices: { [k]: 'что-то' } });
    ok('чужое значение выбора ничего не ломает', junk.summary.newBlocks === junk.plan.blocks.length);
  }

  console.log('3б. Выбор области не меняет, кому достанется прежняя запись');
  {
    const dbS = memoryEquipmentDb();
    await load(dbS, [veza()]);
    const fid = idOf(dbS, U1, mbN, '1.2')!;
    const u = shifted();
    const all = new Set<string>();
    all.add(blockKey(u.name, '', '__unit__'));
    for (const b of blocksOf(u)) all.add(blockKey(u.name, mbN, b.name));
    all.delete(blockKey(u.name, mbN, '1.2'));            // нагреватель не нужен
    const r = await load(dbS, [u], { select: all });
    ok('нагреватель не заведён', !at(dbS, U1, mbN, '1.2'));
    ok('фильтр всё равно нашёл свою запись', idOf(dbS, U1, mbN, '1.3') === fid, r.summary);
  }

  console.log('3в. Д1 с тегами: тег называет позицию, даже если код и типоразмер другие');
  {
    const dbT = memoryEquipmentDb();
    await load(dbT, [veza({ tags: true })]);
    const f1 = idOf(dbT, U1, mbN, '1.3/вентилятор1')!, c1 = idOf(dbT, U1, mbN, '1.1/клапан1')!;
    const u = veza({ tags: true });
    recode(u, '1.3', '1.4'); recode(u, '1.2', '1.3');
    u.monoblocks[0].blocks.splice(2, 0, mkBlock('1.2', 'Нагреватель', 'НАГРЕВАТЕЛЬ'));
    block(u, '1.4/вентилятор1').title = 'Вентилятор ДРУГОЙ-200 №1';       // типоразмер уже иной, а тег прежний
    const r = await load(dbT, [u]);
    ok('вентилятор найден по тегу', idOf(dbT, U1, mbN, '1.4/вентилятор1') === f1);
    ok('в плане отмечено, чем найден', r.plan.blocks.find(b => b.itemCode === '1.4/вентилятор1')?.matchedBy === 'tag');
    ok('клапан с тегом — тоже по тегу', idOf(dbT, U1, mbN, '1.1/клапан1') === c1);
    ok('тег не «занят самим собой» в плане', r.plan.tagLinks.every(l => !l.takenBy), r.plan.tagLinks.filter(l => l.takenBy));
    ok('тег остался на той же записи', dbT.tagsOf(f1).includes('PR-01-BL-001A'));
    parity('Д1 с тегами', dbT, r, [U1]);
  }

  console.log('4. По адресу теперь другой тип или другой типоразмер');
  {
    const dbX = memoryEquipmentDb();
    await load(dbX, [veza()]);
    const fid = idOf(dbX, U1, mbN, '1.2')!;
    const u = veza();
    u.monoblocks[0].blocks[u.monoblocks[0].blocks.findIndex(b => b.name === '1.2')] = mkBlock('1.2', 'Нагреватель водяной', 'НАГРЕВАТЕЛЬ', [['Мощность', '40']]);
    const r = await load(dbX, [u]);
    const row = r.plan.matches.find(m => m.kind === 'address');
    ok('смена типа по адресу — строка с вариантами', !!row && row.closeness === 'other' && row.options.map(o => o.label).join() === 'То же изделие,Другое изделие', row);
    ok('умолчание — «Другое изделие»', row?.default === 'other' && row?.choice === 'other');
    ok('прежний фильтр снят, нагреватель — новая запись', byId(dbX, fid)?.status === 'REMOVED' && idOf(dbX, U1, mbN, '1.2') !== fid);
    parity('смена типа', dbX, r, [U1]);

    const dbY = memoryEquipmentDb();
    await load(dbY, [veza()]);
    const yid = idOf(dbY, U1, mbN, '1.2')!;
    const ry = await load(dbY, [u], { choices: { [blockKey(U1, mbN, '1.2')]: 'same' } });
    ok('инженер сказал «то же изделие» — данные легли в прежнюю запись', idOf(dbY, U1, mbN, '1.2') === yid && byId(dbY, yid)?.status !== 'REMOVED');
    parity('смена типа, «то же»', dbY, ry, [U1]);

    const dbZ = memoryEquipmentDb();
    await load(dbZ, [veza()]);
    const zid = idOf(dbZ, U1, mbN, '1.2')!;
    const z = veza();
    block(z, '1.2').title = 'Фильтр карманный F9 увеличенный';        // тот же тип, другой типоразмер
    const rz = await load(dbZ, [z]);
    const zrow = rz.plan.matches[0];
    ok('другой типоразмер того же типа — «Переподобрано» по умолчанию', zrow?.closeness === 'far' && zrow.default === 'reselect', zrow);
    ok('варианта три', zrow?.options.map(o => o.label).join() === 'То же изделие,Переподобрано,Другое изделие');
    ok('прежняя снята со связью на новую', JSON.parse(byId(dbZ, zid)!.conflictLog).__removal.replacedBy === idOf(dbZ, U1, mbN, '1.2'));
    parity('другой типоразмер', dbZ, rz, [U1]);

    const dbW = memoryEquipmentDb();
    await load(dbW, [veza()]);
    const w = veza(); block(w, '1.2').groups[0].params.push({ key: 'Масса', value: '55', unit: 'кг' });       // масса в подпись не входит
    const rw = await load(dbW, [w]);
    ok('изменившаяся характеристика вне подписи — обычное обновление, без вопросов', rw.plan.matches.length === 0 && rw.summary.updatedBlocks === 1, rw.summary);
  }

  console.log('5. Д2: из двух вентиляторов убрали первый');
  for (const withTags of [false, true]) {
    const label = withTags ? 'с тегами' : 'без тегов';
    const base = veza({ tags: withTags });
    block(base, '1.3/вентилятор2').title = 'Вентилятор ПРОБА62-120-02200-06-1-Г-УХЛ2 №2';    // два вентилятора — два разных изделия
    block(base, '1.3/вентилятор2/двигатель1').groups[0].params[0].value = '22';
    const dbD = memoryEquipmentDb();
    await load(dbD, [base]);
    const f1 = idOf(dbD, U1, mbN, '1.3/вентилятор1')!, f2 = idOf(dbD, U1, mbN, '1.3/вентилятор2')!;
    const m2 = idOf(dbD, U1, mbN, '1.3/вентилятор2/двигатель1')!;
    const u: ParsedUnit = JSON.parse(JSON.stringify(base));
    u.monoblocks[0].blocks = blocksOf(u).filter(b => !b.name.startsWith('1.3/вентилятор1'));
    for (const b of blocksOf(u)) {                                  // оставшийся стал «первым»: номер выдаётся по порядку в файле
      if (b.name.startsWith('1.3/вентилятор2')) { b.name = b.name.replace('вентилятор2', 'вентилятор1'); if (b.parentName) b.parentName = b.parentName.replace('вентилятор2', 'вентилятор1'); }
    }
    block(u, '1.3/вентилятор1').instanceNo = 1;
    const r = await load(dbD, [u]);
    ok(`Д2 ${label}: оставшийся вентилятор остался собой — запись второго встала на адрес первого`, byId(dbD, f2)?.itemCode === '1.3/вентилятор1' && f2 !== f1, dbD.elements.map(e => [e.id, e.itemCode]));
    ok(`Д2 ${label}: двигатель пошёл за своим вентилятором`, byId(dbD, m2)?.itemCode === '1.3/вентилятор1/двигатель1' && byId(dbD, m2)?.parentElementId === f2);
    ok(`Д2 ${label}: запись первого вентилятора не перезаписана данными второго`, byId(dbD, f1)?.status !== 'REMOVED' && byId(dbD, f1)?.name === block(base, '1.3/вентилятор1').title);
    ok(`Д2 ${label}: заведено новых записей — ноль`, r.summary.newBlocks === 0, r.summary);
    ok(`Д2 ${label}: ${withTags ? 'найден по тегу, спрашивать нечего' : 'переезд предложен строкой плана'}`,
      withTags ? r.plan.matches.length === 0 : r.plan.matches.length === 1 && r.plan.matches[0].choice === 'same', r.plan.matches.map(m => m.why));
    parity(`Д2 ${label}`, dbD, r, [U1]);
  }

  console.log('6. Д4: установку переименовали («это не опечатка»)');
  {
    const dbR = memoryEquipmentDb();
    await load(dbR, [veza()]);
    const sysId = systemNamed(dbR, U1)[0].id;
    const elId = idOf(dbR, U1, mbN, '1.3/вентилятор1')!;
    const u = veza(); u.name = `${U1}.1`;
    const r = await load(dbR, [u]);
    const row = r.plan.systemRows[0];
    ok('в плане строка «это она?» с умолчанием «да»', row?.kind === 'rename' && row.default === 'rename' && /это она/.test(row.why), row);
    ok('план называет прежнее имя', r.plan.systems[0].renamedFrom === U1 && r.plan.systems[0].action === 'match');
    ok('установка та же, имя новое', dbR.systems.length === 1 && dbR.systems[0].id === sysId && dbR.systems[0].name === `${U1}.1`, dbR.systems);
    ok('позиции остались при ней, ID прежние', at(dbR, `${U1}.1`, mbN, '1.3/вентилятор1')?.id === elId && r.summary.newBlocks === 0, r.summary);
    parity('Д4', dbR, r, [`${U1}.1`]);

    const dbN = memoryEquipmentDb();
    await load(dbN, [veza()]);
    const rn = await load(dbN, [u], { choices: { [rn0(u)]: 'new' } });
    ok('«нет, новая»: заведена вторая установка, старая цела', dbN.systems.length === 2 && systemNamed(dbN, U1).length === 1 && rn.summary.newBlocks === rn.plan.blocks.length);
    parity('Д4, «новая»', dbN, rn, [`${U1}.1`]);

    const dbO = memoryEquipmentDb();
    await load(dbO, [veza()]);
    const other = veza(); other.name = 'Совсем-другая'; other.monoblocks[0].blocks.splice(1);
    const ro = await load(dbO, [other]);
    ok('несвязанное имя и другой состав — просто новая установка, без вопросов', ro.plan.systemRows.length === 0 && dbO.systems.length === 2);
  }

  console.log('7. Д5: одинаковые имена установок');
  {
    const dbE = memoryEquipmentDb();
    const a = veza(); a.name = 'У1';
    const b: ParsedUnit = { name: 'У1', title: 'Другая', groups: [], monoblocks: [{ name: 'М7', title: '', blocks: [mkBlock('7.1', 'Клапан воздушный', 'КЛАПАН')] }] };
    const both = await load(dbE, [{ ...a, fileName: 'a.xml' }, { ...b, fileName: 'b.xml' }]);
    ok('два одноимённых в одном ввозе — две установки', systemNamed(dbE, 'У1').length === 2, dbE.systems);
    parity('Д5, один ввоз', dbE, both, ['У1']);
    const ids = systemNamed(dbE, 'У1').map(s => s.id);
    const elA = dbE.elements.filter(e => dbE.monoblocks.find(m => m.id === e.monoblockId)?.systemId === ids[0]).length;

    const again = await load(dbE, [{ ...a, fileName: 'a.xml' }, { ...b, fileName: 'b.xml' }]);
    ok('повторный ввоз находит каждую по имени и имени файла, без вопросов',
      again.summary.newBlocks === 0 && dbE.systems.length === 2 && again.plan.systemRows.length === 0, again.summary);
    ok('и записи не удвоились', dbE.elements.filter(e => dbE.monoblocks.find(m => m.id === e.monoblockId)?.systemId === ids[0]).length === elA);

    const third: ParsedUnit = { name: 'У1', title: 'Третья', groups: [], monoblocks: [{ name: 'М9', title: '', blocks: [mkBlock('9.1', 'Вентилятор', 'ВЕНТИЛЯТОР')] }] };
    const rt = await load(dbE, [third], { file: 'c.xml' });
    const row = rt.plan.systemRows[0];
    ok('третья с тем же именем из нового файла: план просит выбрать', row?.kind === 'pick' && row.options.length === 3 && row.default === 'new', row);
    ok('без выбора заводится новая, а не сливается с чужой', dbE.systems.length === 3);

    const dbF = memoryEquipmentDb();
    await load(dbF, [{ ...a, fileName: 'a.xml' }], { file: 'a.xml' });
    const diff = await load(dbF, [{ ...b, fileName: 'b.xml' }], { file: 'b.xml' });
    ok('одноимённая из другого файла и с другим составом не сливается молча',
      diff.plan.systemRows[0]?.kind === 'pick' && diff.plan.systemRows[0].default === 'new' && dbF.systems.length === 2, diff.plan.systemRows);
    const pick = diff.plan.systemRows[0].options[0].value;
    const dbG = memoryEquipmentDb();
    await load(dbG, [{ ...a, fileName: 'a.xml' }], { file: 'a.xml' });
    const chosen = await load(dbG, [{ ...b, fileName: 'b.xml' }], { file: 'b.xml', choices: { [diff.plan.systemRows[0].key]: pick } });
    ok('инженер сказал «та же» — данные ложатся в прежнюю установку', dbG.systems.length === 1, chosen.summary);
    const same = await load(dbG, [{ ...a, fileName: 'a-новый.xml' }], { file: 'a-новый.xml' });
    ok('тот же расчёт под другим именем файла сливается без вопросов (состав сходится)', same.plan.systemRows.length === 0 && dbG.systems.length === 1, same.plan.systemRows);
  }

  console.log('8. Ручные позиции файл не трогает');
  {
    const dbM = memoryEquipmentDb();
    await load(dbM, [veza()]);
    const mb = dbM.monoblocks.find(m => m.name === mbN)!;
    const manual = await dbM.prisma.componentElement.create({ data: { monoblockId: mb.id, itemCode: '1.2', name: 'Фильтр вручную', equipType: 'ФИЛЬТР', specs: null, status: 'OK', role: 'БЛОК', manual: true } });
    const orig = idOf(dbM, U1, mbN, '1.2')!;
    const rm = await load(dbM, [veza()]);
    ok('позиция из файла нашла свою запись, а не ручную с тем же адресом', rm.plan.blocks.find(b => b.itemCode === '1.2')?.elementId === orig && byId(dbM, manual.id)?.manual === true);
  }

  await lifecycle();

  console.log(failed === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();

/** Ключ строки «это она?» для переименованной установки */
function rn0(u: ParsedUnit): string { return `unit‖${u.name}‖${FILE}`; }

/** Отмена партии — тем же маршрутом, что вызывает окно, на той же памяти */
async function undoBatch(db: MemoryDb, batchId: string) {
  setPrisma(db.prisma);
  const app = express();
  registerEquipmentUndoRoutes(app as any);
  const call = async (method: 'get' | 'post', path: string, body: any = {}, params: any = {}) => {
    const layer = (app as any)._router.stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
    const res: any = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json(v: any) { this.body = v; return this; } };
    await layer.route.stack[0].handle({ body, params, query: {} }, res);
    return res;
  };
  const plan = (await call('get', '/api/equipment/import-undo/:batchId', {}, { batchId })).body;
  const done = (await call('post', '/api/equipment/import-undo', { batchId })).body;
  return { plan, done };
}

const rm = (el: any) => (el?.conflictLog ? JSON.parse(el.conflictLog).__removal : undefined);

async function lifecycle() {
  console.log('9. Д3: позиция пропала из расчёта — снята, а не удалена; вернулась — та же запись');
  const withTags = () => veza({ tags: true });
  const dbL = memoryEquipmentDb();
  await load(dbL, [withTags()]);
  const mbRow = dbL.monoblocks.find(m => m.name === mbN)!;
  const manual = await dbL.prisma.componentElement.create({ data: { monoblockId: mbRow.id, itemCode: 'рук-1', name: 'Датчик вручную', equipType: 'ДАТЧИК', specs: null, status: 'OK', role: 'ДАТЧИК', manual: true, version: 1 } });
  const ids = (code: string) => idOf(dbL, U1, mbN, code)!;
  const filterId = ids('1.2'), fan2 = ids('1.3/вентилятор2'), motor2 = ids('1.3/вентилятор2/двигатель1');
  const v0 = new Map(dbL.elements.map(e => [e.id, e.version]));
  const smaller = (): ParsedUnit => {
    const u = withTags();
    u.monoblocks[0].blocks = blocksOf(u).filter(b => b.name !== '1.2' && !b.name.startsWith('1.3/вентилятор2'));
    return u;
  };
  const frag = await load(dbL, [smaller()]);
  ok('без признака «полный файл» ничего не снимается (фрагмент не удаляет)', frag.plan.missing.length === 0 && !frag.summary.removedBlocks && byId(dbL, filterId).status !== 'REMOVED', frag.summary);

  const gone = await load(dbL, [smaller()], { remove: true });
  ok('в плане список «будет снято» и счётчик', gone.plan.missing.length === 3 && gone.plan.totals.removed === 3
    && [filterId, fan2, motor2].every(id => gone.plan.missing.some(m => m.id === id)), gone.plan.missing.map(m => m.at));
  ok('сняты три, записи на месте', [filterId, fan2, motor2].every(id => byId(dbL, id)?.status === 'REMOVED') && gone.summary.removedBlocks === 3, gone.summary);
  ok('отметка о снятии: когда, какой партией, почему', rm(byId(dbL, filterId))?.why === 'missing' && rm(byId(dbL, filterId))?.batchId === gone.summary.batchId && !!rm(byId(dbL, filterId))?.at);
  ok('строка истории REMOVE с партией', dbL.history.filter(h => h.changeType === 'REMOVE' && h.batchId === gone.summary.batchId).length === 3);
  ok('ручная позиция не снята', byId(dbL, manual.id)?.status === 'OK');
  ok('остальные не тронуты', byId(dbL, ids('1.3'))?.status === 'OK' && byId(dbL, ids('1.1/клапан1'))?.status === 'OK');
  ok('тег снятой позиции остаётся при ней', dbL.tagsOf(fan2).includes('PR-01-BL-002A'));
  ok('версия снятых выросла, у нетронутых — нет', byId(dbL, filterId).version === v0.get(filterId)! + 1 && byId(dbL, ids('1.1/клапан1')).version === v0.get(ids('1.1/клапан1')));
  ok('план и запись называют одни записи', gone.plan.missing.every(m => byId(dbL, m.id)?.status === 'REMOVED') && gone.plan.totals.removed === gone.summary.removedBlocks);

  const again = await load(dbL, [smaller()], { remove: true });
  ok('повторная загрузка того же не снимает снятое второй раз', again.plan.missing.length === 0 && !again.summary.removedBlocks);

  const back = await load(dbL, [withTags()], { remove: true });
  ok('вернулись в расчёт — та же запись, статус OK, отметка убрана',
    [filterId, fan2, motor2].every(id => byId(dbL, id)?.status === 'OK' && byId(dbL, id)?.conflictLog === null) && back.summary.newBlocks === 0 && back.summary.restoredBlocks === 3, back.summary);
  ok('в плане видно, что вернётся', back.plan.blocks.filter(b => b.restores).length === 3 && back.plan.totals.restored === 3);
  ok('новых записей нет, тег на месте', dbL.elements.filter(e => e.itemCode === '1.3/вентилятор2').length === 1 && dbL.tagsOf(fan2).includes('PR-01-BL-002A'));
  ok('возврат поднял версию', byId(dbL, filterId).version === v0.get(filterId)! + 2);
  parity('возврат', dbL, back, [U1]);

  const keep = await load(dbL, [smaller()], { remove: true, choices: { [missingKey(filterId)]: 'keep' } });
  ok('«оставить» из плана уважается', keep.plan.missing.find(m => m.id === filterId)?.remove === false && byId(dbL, filterId).status === 'OK' && byId(dbL, fan2).status === 'REMOVED', keep.summary);

  console.log('9а. Отмена партии возвращает всё, что партия сделала');
  {
    const db = memoryEquipmentDb();
    await load(db, [withTags()]);
    const f = idOf(db, U1, mbN, '1.2')!, fan2b = idOf(db, U1, mbN, '1.3/вентилятор2')!;
    const r = await load(db, [smaller()], { remove: true });
    const { plan, done } = await undoBatch(db, r.summary.batchId);
    ok('план отмены называет снятые', plan.reinstate.length === 3, plan);
    ok('снятые вернулись: OK и без отметки', [f, fan2b].every(id => byId(db, id)?.status === 'OK' && byId(db, id)?.conflictLog === null) && done.reinstated === 3, done);

    // Переезды: прежний код и адрес
    const dbM = memoryEquipmentDb();
    await load(dbM, [veza()]);
    const fid = idOf(dbM, U1, mbN, '1.2')!, fanBlock = idOf(dbM, U1, mbN, '1.3')!;
    const sh = shifted2();
    const rm2 = await load(dbM, [sh]);
    ok('переезд записан в историю со старым адресом', dbM.history.some(h => h.changeType === 'MOVE' && h.elementId === fid && JSON.parse(h.oldSpecs).itemCode === '1.2'));
    const u2 = await undoBatch(dbM, rm2.summary.batchId);
    ok('отмена вернула прежние коды', byId(dbM, fid)?.itemCode === '1.2' && byId(dbM, fanBlock)?.itemCode === '1.3' && u2.done.unmoved >= 2, [byId(dbM, fid)?.itemCode, u2.done]);
    ok('и внутри блока — прежние пути, владелец прежний', byId(dbM, idOf(dbM, U1, mbN, '1.3/вентилятор1/двигатель1')!)?.parentElementId === idOf(dbM, U1, mbN, '1.3/вентилятор1'));
    ok('нагреватель, заведённый партией, убран', !dbM.elements.some(e => e.name === 'Нагреватель водяной'));

    // Возврат тоже отменяется
    const dbR = memoryEquipmentDb();
    await load(dbR, [withTags()]);
    await load(dbR, [smaller()], { remove: true });
    const rb = await load(dbR, [withTags()], { remove: true });
    const ur = await undoBatch(dbR, rb.summary.batchId);
    ok('возврат этой партией отменяем: позиции снова сняты, отметка прежняя', ur.done.reinstated === 0 && [f, fan2b].every(id => byId(dbR, id)?.status === 'REMOVED' && rm(byId(dbR, id))?.why === 'missing'), ur);
  }

  console.log('10. «Переподобрано» переносит тег на новую запись; «Другое изделие» — нет');
  {
    // Файл без тегов: тег поставили руками, а расчёт пересобрали с другим вентилятором
    const retype = (): ParsedUnit => { const u = veza(); block(u, '1.3/вентилятор1').title = 'Вентилятор ДРУГОЙ-200 №1'; return u; };
    const fanKeyN = blockKey(U1, mbN, '1.3/вентилятор1');
    const db = memoryEquipmentDb();
    await load(db, [withTags()]);
    const old = idOf(db, U1, mbN, '1.3/вентилятор1')!;
    const r = await load(db, [retype()], { choices: { [fanKeyN]: 'reselect' } });
    const neu = db.elements.find(e => e.itemCode === '1.3/вентилятор1' && e.status !== 'REMOVED' && e.id !== old)!;
    ok('тег перешёл на новую запись', db.tagsOf(neu.id).includes('PR-01-BL-001A') && !db.tagsOf(old).includes('PR-01-BL-001A'), [db.tagsOf(neu.id), db.tagsOf(old)]);
    ok('у снятой остаётся ссылка «заменено на»', rm(byId(db, old))?.replacedBy === neu.id && byId(db, old)?.status === 'REMOVED');
    ok('в истории — строка о переносе', db.history.some(h => h.changeType === 'TAG_MOVE' && h.elementId === old && h.batchId === r.summary.batchId));
    ok('новая запись заведена этим ввозом — версия 1, хотя тег уже на ней', neu.version === 1, neu.version);
    ok('снятая версией выросла', byId(db, old).version === 2, byId(db, old).version);
    parity('переподбор с тегом', db, r, [U1]);
    const un = await undoBatch(db, r.summary.batchId);
    ok('отмена: тег вернулся прежней записи, она снова действует, новая убрана',
      db.tagsOf(old).includes('PR-01-BL-001A') && byId(db, old)?.status === 'OK' && !db.elements.some(e => e.id === neu.id) && un.done.retagged === 1, un.done);

    const db2 = memoryEquipmentDb();
    await load(db2, [withTags()]);
    const old2 = idOf(db2, U1, mbN, '1.3/вентилятор1')!;
    const r2 = await load(db2, [retype()], { choices: { [fanKeyN]: 'other' } });
    const neu2 = db2.elements.find(e => e.itemCode === '1.3/вентилятор1' && e.status !== 'REMOVED' && e.id !== old2)!;
    ok('«Другое изделие»: тег остаётся на снятой', db2.tagsOf(old2).includes('PR-01-BL-001A') && db2.tagsOf(neu2.id).length === 0 && byId(db2, old2).status === 'REMOVED' && !rm(byId(db2, old2)).replacedBy, db2.tagsOf(old2));

    const free = retype(); block(free, '1.3/вентилятор1').tags = ['PR-01-BL-777A'];
    const db3 = memoryEquipmentDb();
    await load(db3, [withTags()]);
    const r3 = await load(db3, [free], { choices: { [fanKeyN]: 'other' } });
    const neu3 = db3.elements.find(e => e.itemCode === '1.3/вентилятор1' && e.status !== 'REMOVED' && e.id !== idOf(db3, U1, mbN, '1.3/вентилятор2'))!;
    ok('«Другое изделие»: свободный тег из файла достаётся новой записи', db3.tagsOf(neu3.id).includes('PR-01-BL-777A') && r3.summary.tagConflicts.length === 0, [r3.summary.tagConflicts, db3.tagsOf(neu3.id)]);

    // Тот же тег в файле на изделии другого типа: тег занят снятой записью — объясняем, не отнимаем
    const clash = withTags(); const cb = block(clash, '1.3/вентилятор1'); cb.role = 'ПРИВОД'; cb.equipType = 'ПРИВОД';
    const db4 = memoryEquipmentDb();
    await load(db4, [withTags()]);
    const o4 = idOf(db4, U1, mbN, '1.3/вентилятор1')!;
    const r4 = await load(db4, [clash]);
    ok('тег на изделии другого типа: по умолчанию «Другое изделие», тег остаётся прежней записи и это сказано',
      r4.plan.matches.some(m => m.closeness === 'other' && m.choice === 'other') && db4.tagsOf(o4).includes('PR-01-BL-001A') && r4.summary.tagConflicts.length === 1, [r4.plan.matches.map(m => m.choice), r4.summary.tagConflicts]);
  }

  console.log('11. Версия позиции растёт при любом принятом изменении');
  {
    const db = memoryEquipmentDb();
    await load(db, [veza()]);
    ok('новая запись — версия 1', db.elements.every(e => e.version === 1));
    await load(db, [veza()]);
    ok('повторная загрузка того же не меняет версий', db.elements.every(e => e.version === 1), db.elements.map(e => e.version));

    const motorId = idOf(db, U1, mbN, '1.3/вентилятор1/двигатель1')!;
    const t = veza(); block(t, '1.3/вентилятор1/двигатель1').tags = ['PR-01-MT-001A'];
    await load(db, [t]);
    ok('тег привязан — версия +1', byId(db, motorId).version === 2, byId(db, motorId).version);
    await load(db, [t]);
    ok('тот же тег повторно — версия прежняя', byId(db, motorId).version === 2);

    await load(db, [shifted2()]);
    const filter = db.elements.find(e => e.name === 'Фильтр карманный')!;
    ok('переезд — версия +1', filter.version === 2, filter.version);
    ok('нетронутая позиция — версия прежняя', byId(db, idOf(db, U1, mbN, '1.1/клапан1')!).version === 1);
    ok('состав (владелец, адрес) тоже считается: мотор переехал вместе с вентилятором', byId(db, motorId).version === 3, byId(db, motorId).version);

    const before = byId(db, motorId).version;
    // Расчёт тот же по составу, но коды уже сдвинуты — берём сдвинутый
    const sh2 = shifted2(); block(sh2, '1.4/вентилятор1/двигатель1').groups[0].params[0].value = '15.5';
    sh2.monoblocks[0].blocks.find(b => b.name === '1.4/вентилятор1/двигатель1')!.tags = ['PR-01-MT-001A'];
    await load(db, [sh2], { mode: 'immediate' });
    ok('принятая правка характеристик — ровно +1', byId(db, motorId).version === before + 1 && /15\.5/.test(byId(db, motorId).specs), [before, byId(db, motorId).version]);
  }
}

/** Д1: вставили блок, коды сдвинулись */
function shifted2(): ParsedUnit {
  const u = veza();
  recode(u, '1.3', '1.4'); recode(u, '1.2', '1.3');
  u.monoblocks[0].blocks.splice(2, 0, mkBlock('1.2', 'Нагреватель водяной', 'НАГРЕВАТЕЛЬ', [['Мощность', '40']]));
  return u;
}
