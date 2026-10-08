/**
 * Загрузка заполненной книги атрибутов E3: выгрузил → заполнил в памяти →
 * загрузил → значения в группе «КИП» и в следующей выгрузке; ошибки ключей;
 * отмена партии (docs/e3-integration.md, 5.5 и 9.1).
 *
 * Книга выгружается ровно тем кодом, что и окно (e3Columns, e3Rows,
 * buildAttributeSheets), база — в памяти с теми же вызовами Prisma, что делают
 * план и запись. Загрузка и отмена идут теми же маршрутами, что вызывает окно.
 *
 * Запуск: npx tsx scripts/test-e3-attribute-upload.ts
 */
import express from 'express';
import { VEZA_SAMPLE_XML } from './fixtures/veza';
import { memoryEquipmentDb, type MemoryDb } from './fixtures/memoryEquipmentDb';
import { parseVezaXml } from '../server/vezaXml';
import { detectEquipType } from '../server/equipmentParser';
import { planEquipmentImport } from '../server/equipmentPlan';
import { importEquipmentToDB } from '../server/equipmentImport';
import { setPrisma } from '../server/context';
import { registerE3AttributeUploadRoutes } from '../server/routes/e3AttributeUpload';
import { registerEquipmentUndoRoutes } from '../server/routes/equipmentUndo';
import { e3Columns, KIP_GROUP, type E3Attribute } from '../e3/attributes';
import { buildAttributeSheets } from '../e3/attributeWorkbook';
import { kipOf, planUpload, readBook } from '../e3/attributeUpload';
import { buildExportSources } from '../src/lib/exportWorkspace';
import { e3Rows } from '../src/lib/e3Table';

let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond ? console.log('  ✓', name) : (failed++, console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)));

// ── Справочник: теги, характеристика, два атрибута КИП, атрибуты без «Да» ──
const attr = (name: string, o: Partial<E3Attribute>): E3Attribute => ({
  name, title: `${name} (описание)`, carrier: 'Изделие', attrClass: 'Общий', service: false, fromFlux: true,
  script: '', comment: '', source: { kind: 'none' }, classes: [], conflict: 'ask', ...o,
});
const ALL = ['ВЕНТИЛЯТОР', 'ДВИГАТЕЛЬ', 'КЛАПАН', 'ПРИВОД', 'ФИЛЬТР', 'СЕКЦИЯ'];
const BOOK: E3Attribute[] = [
  attr('GLOBAL_TAG_DEVICE_SHORT', { source: { kind: 'field', key: 'tag' }, classes: ALL }),
  attr('MOTOR_POWER', { source: { kind: 'param', name: 'Номинальная мощность' }, classes: ['ДВИГАТЕЛЬ'] }),
  attr('INST_RANGE_MIN', { attrClass: 'КИП', classes: ALL }),
  attr('SIGNAL_TYPE', { attrClass: 'КИП', classes: ALL }),
  attr('CBL_LEN', { fromFlux: false, classes: ALL }),
];

const U1 = 'PR-01-AS-001';

/** Установки в том виде, в каком их отдаёт API и читает окно */
const systemsJson = (db: MemoryDb) => db.systems.map(s => ({
  ...s,
  monoblocks: db.monoblocks.filter(m => m.systemId === s.id).map(m => ({
    ...m, components: db.elements.filter(e => e.monoblockId === m.id).map(e => ({ ...e, tags: db.tags.filter(t => db.tagsOf(e.id).includes(t.identifier)).map(t => ({ id: t.id, identifier: t.identifier })) })),
  })),
}));

/** Выгрузка книги — тем же кодом, что кнопка «Скачать Excel» */
function exportBook(db: MemoryDb) {
  const sources = buildExportSources(systemsJson(db) as any, []);
  const columns = e3Columns(BOOK, [], { header: 'name' });
  const table = e3Rows(sources.rows('all'), BOOK, columns, { classes: [], taggedOnly: false });
  return { sheets: buildAttributeSheets({ columns, items: BOOK, rows: table.rows, mode: 'class' }), table, columns };
}

/** Маршруты — так же, как их вызывает окно */
function api(db: MemoryDb) {
  setPrisma(db.prisma);
  const app = express();
  registerE3AttributeUploadRoutes(app as any, { loadBook: async () => BOOK });
  registerEquipmentUndoRoutes(app as any);
  const call = async (method: 'get' | 'post', path: string, body: any = {}, params: any = {}) => {
    const layer = (app as any)._router.stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
    const res: any = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json(v: any) { this.body = v; return this; } };
    await layer.route.stack[0].handle({ body, params, query: {}, authUser: { id: 'u1', role: 'ADMIN' } }, res);
    return res;
  };
  const P = '/api/projects/:projectId/e3-attribute-upload';
  return {
    plan: (sheets: any, projectId = 'p1') => call('post', `${P}/plan`, { sheets }, { projectId }),
    apply: (sheets: any, projectId = 'p1') => call('post', `${P}/apply`, { sheets }, { projectId }),
    undoPlan: (batchId: string) => call('get', '/api/equipment/import-undo/:batchId', {}, { batchId }),
    undo: (batchId: string) => call('post', '/api/equipment/import-undo', { batchId }),
  };
}

const colOf = (aoa: unknown[][], name: string) => (aoa[0] as string[]).indexOf(name);
const rowOf = (aoa: unknown[][], id: string) => aoa.findIndex((r, i) => i >= 2 && r[0] === id);
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

(async () => {
  const db = memoryEquipmentDb();
  const unit: any = (parseVezaXml(VEZA_SAMPLE_XML, detectEquipType) as any).units[0];
  const result: any = { units: [JSON.parse(JSON.stringify(unit))] };
  const plan0 = await planEquipmentImport(db.prisma, 'p1', 'AHU', result, { fileName: 'a.xml' });
  await importEquipmentToDB(db.prisma, 'p1', 'AHU', 'a.xml', result, 'wait', plan0.tagLinks, {}, { full: result });
  const idOf = (code: string) => db.elements.find(e => e.itemCode === code)!.id;
  const fan1 = idOf('1.3/вентилятор1'), fan2 = idOf('1.3/вентилятор2'), motor1 = idOf('1.3/вентилятор1/двигатель1');
  const el = (id: string) => db.elements.find(e => e.id === id)!;
  const routes = api(db);

  console.log('1. Выгрузка: столбцы КИП на листах, пока пустые');
  const out = exportBook(db);
  const fans = out.sheets.find(s => s.name === 'Вентиляторы')!;
  ok('на листе вентиляторов есть столбцы КИП и тег', colOf(fans.aoa, 'INST_RANGE_MIN') > 0 && colOf(fans.aoa, 'SIGNAL_TYPE') > 0 && colOf(fans.aoa, 'GLOBAL_TAG_DEVICE_SHORT') > 0);
  ok('столбец A — ID позиции', fans.aoa[2][0] === fan1 || fans.aoa[2][0] === fan2, fans.aoa[2]);
  ok('данные КИП пока пусты', out.table.rows.every(r => r.cells[out.columns.findIndex(c => c.key === 'e3:INST_RANGE_MIN')] === ''));

  console.log('2. Заполнили в памяти — загрузили: значения в группе «КИП»');
  const sheets = clone(out.sheets);
  const fansS = sheets.find(s => s.name === 'Вентиляторы')!;
  const r1 = rowOf(fansS.aoa, fan1), r2 = rowOf(fansS.aoa, fan2);
  fansS.aoa[r1][colOf(fansS.aoa, 'INST_RANGE_MIN')] = '0';
  fansS.aoa[r1][colOf(fansS.aoa, 'SIGNAL_TYPE')] = 'AI';
  fansS.aoa[r2][colOf(fansS.aoa, 'INST_RANGE_MIN')] = '-50';
  fansS.aoa[r1][colOf(fansS.aoa, 'CBL_LEN')] = '12';                         // без «Да» — не ведётся
  const mot = sheets.find(s => s.name === 'Двигатели')!;
  const rm = rowOf(mot.aoa, motor1);
  mot.aoa[rm][colOf(mot.aoa, 'MOTOR_POWER')] = '999';                         // считает Flux — не перезаписывается
  mot.aoa[rm][colOf(mot.aoa, 'INST_RANGE_MIN')] = '4';
  const before = new Map(db.elements.map(e => [e.id, { specs: e.specs, version: e.version }]));

  const planned = (await routes.plan(sheets)).body;
  ok('план называет три позиции и пять значений', planned.plan.writes.length === 3 && planned.plan.writes.reduce((n: number, w: any) => n + w.changes.length, 0) === 4, planned.plan.writes.map((w: any) => [w.label, w.changes.length]));
  ok('план ничего не пишет', db.elements.every(e => e.specs === before.get(e.id)!.specs && e.version === before.get(e.id)!.version) && !db.history.some(h => /^kip-/.test(h.batchId || '')));
  ok('предупреждение: значение считает Flux', planned.plan.notes.some((n: any) => n.code === 'flux' && n.names.includes('MOTOR_POWER')), planned.plan.notes);
  ok('предупреждение: Flux этот атрибут не ведёт', planned.plan.notes.some((n: any) => n.code === 'no-yes' && n.names.includes('CBL_LEN')));
  ok('ошибок ключей нет', planned.plan.errors.length === 0, planned.plan.errors);

  const done = (await routes.apply(sheets)).body;
  ok('записано три позиции', done.ok && done.written === 3 && /^kip-/.test(done.batchId), done);
  ok('значения лежат в группе «КИП» позиции', kipOf(el(fan1).specs).INST_RANGE_MIN === '0' && kipOf(el(fan1).specs).SIGNAL_TYPE === 'AI' && kipOf(el(fan2).specs).INST_RANGE_MIN === '-50' && kipOf(el(motor1).specs).INST_RANGE_MIN === '4');
  ok('группа называется «КИП» и стоит рядом с остальными', JSON.parse(el(fan1).specs).groups.some((g: any) => g.title === KIP_GROUP) && JSON.parse(el(fan1).specs).groups.length > 1);
  ok('прежние характеристики целы', JSON.parse(el(fan1).specs).groups.filter((g: any) => g.title !== KIP_GROUP).length === JSON.parse(before.get(fan1)!.specs!).groups.length);
  ok('значение, которое считает Flux, не тронуто', !/999/.test(el(motor1).specs));
  ok('версия позиции выросла ровно на единицу', el(fan1).version === before.get(fan1)!.version + 1 && el(motor1).version === before.get(motor1)!.version + 1);
  ok('у остальных позиций версия прежняя', el(idOf('1.2')).version === before.get(idOf('1.2'))!.version);
  ok('история партии: строка на позицию', db.history.filter(h => h.batchId === done.batchId && h.changeType === 'UPDATE').length === 3);

  console.log('3. Следующая выгрузка несёт значения КИП');
  const next = exportBook(db);
  const nf = next.sheets.find(s => s.name === 'Вентиляторы')!;
  ok('INST_RANGE_MIN вентилятора — в книге', nf.aoa[rowOf(nf.aoa, fan1)][colOf(nf.aoa, 'INST_RANGE_MIN')] === '0' && nf.aoa[rowOf(nf.aoa, fan2)][colOf(nf.aoa, 'INST_RANGE_MIN')] === '-50', nf.aoa.slice(2));
  ok('SIGNAL_TYPE — тоже', nf.aoa[rowOf(nf.aoa, fan1)][colOf(nf.aoa, 'SIGNAL_TYPE')] === 'AI');
  const nm = next.sheets.find(s => s.name === 'Двигатели')!;
  ok('двигатель: КИП из группы, а мощность — как считает Flux', nm.aoa[rowOf(nm.aoa, motor1)][colOf(nm.aoa, 'INST_RANGE_MIN')] === '4' && nm.aoa[rowOf(nm.aoa, motor1)][colOf(nm.aoa, 'MOTOR_POWER')] === '15', nm.aoa[rowOf(nm.aoa, motor1)]);
  const again = (await routes.plan(next.sheets)).body.plan;
  ok('та же книга второй раз ничего не меняет', again.writes.length === 0 && again.same >= 3 && again.errors.length === 0, again);
  const empty = clone(next.sheets); empty.find(s => s.name === 'Вентиляторы')!.aoa[rowOf(nf.aoa, fan1)][colOf(nf.aoa, 'INST_RANGE_MIN')] = '';
  ok('пустая ячейка значение не стирает', (await routes.plan(empty)).body.plan.writes.length === 0);

  console.log('4. Ошибки ключей — в плане, а не молча');
  {
    const bad = clone(next.sheets);
    const b = bad.find(s => s.name === 'Вентиляторы')!;
    const tagCol = colOf(b.aoa, 'GLOBAL_TAG_DEVICE_SHORT'), kip = colOf(b.aoa, 'INST_RANGE_MIN');
    const rA = rowOf(b.aoa, fan1), rB = rowOf(b.aoa, fan2);
    b.aoa[rA][kip] = '1';                                 // нормальная строка с правкой
    b.aoa[rB][tagCol] = 'PR-01-BL-001A';                  // тег первого вентилятора на строке второго
    b.aoa[rB][kip] = '77';
    b.aoa.push(['', ...Array(b.aoa[0].length - 1).fill('').map((_, j) => (j + 1 === kip ? '5' : ''))]);                       // без ID
    b.aoa.push(['нет-такой-позиции', ...Array(b.aoa[0].length - 1).fill('').map((_, j) => (j + 1 === kip ? '5' : ''))]);       // чужой ID
    b.aoa.push([...b.aoa[rA]]);                                                                                                 // дубль ID
    const p = (await routes.plan(bad)).body.plan;
    ok('строка без ID — ошибка', p.errors.some((e: any) => /Нет ID/.test(e.message)), p.errors);
    ok('чужой ID — ошибка', p.errors.some((e: any) => e.id === 'нет-такой-позиции' && /нет в этом проекте/.test(e.message)));
    ok('чужой тег — ошибка с обоими тегами', p.errors.some((e: any) => e.id === fan2 && /Чужой тег/.test(e.message) && /PR-01-BL-001A/.test(e.message) && /PR-01-BL-002A/.test(e.message)), p.errors);
    ok('дубль ID — ошибка', p.errors.some((e: any) => /уже встречался/.test(e.message)));
    ok('в ошибке — лист и номер строки', p.errors.every((e: any) => e.sheet && e.line >= 3));
    ok('нормальная строка плана не пострадала, а строка с чужим тегом не пишется', p.writes.length === 1 && p.writes[0].id === fan1, p.writes.map((w: any) => w.id));
    const w = (await routes.apply(bad)).body;
    ok('запись пишет только годное и возвращает те же ошибки', w.written === 1 && w.errors.length === p.errors.length && kipOf(el(fan2).specs).INST_RANGE_MIN === '-50', w);
    await routes.undo(w.batchId);

    const other = (await routes.plan(next.sheets, 'p-чужой')).body.plan;
    ok('книга от другого проекта: каждая строка — ошибка', other.errors.length === other.rows && other.writes.length === 0, other.errors.length);
    const foreign = (await routes.plan([{ name: 'X', aoa: [['что-то', 'A'], ['', '1'], ['2', '3']] }])).body;
    ok('лист не из Flux не читается', foreign.plan.rows === 0 && /не книга, скачанная из Flux/.test(foreign.issues[0]), foreign.issues);
    const removedPos = clone(next.sheets);
    el(fan1).status = 'REMOVED';
    const rp = (await routes.plan(removedPos)).body.plan;
    ok('снятая позиция — ошибка, данные в неё не пишутся', rp.errors.some((e: any) => e.id === fan1 && /снята/.test(e.message)));
    el(fan1).status = 'OK';
  }

  console.log('5. Отмена партии');
  {
    const vBefore = el(fan1).version;
    const sh = clone(next.sheets);
    sh.find(s => s.name === 'Вентиляторы')!.aoa[rowOf(nf.aoa, fan1)][colOf(nf.aoa, 'INST_RANGE_MIN')] = '10';
    const w = (await routes.apply(sh)).body;
    ok('вторая загрузка меняет значение', kipOf(el(fan1).specs).INST_RANGE_MIN === '10' && w.written === 1, w);
    const up = (await routes.undoPlan(w.batchId)).body;
    ok('план отмены называет позицию к возврату', up.restore.length === 1, up);
    const u = (await routes.undo(w.batchId)).body;
    ok('отмена вернула прежнее значение КИП', kipOf(el(fan1).specs).INST_RANGE_MIN === '0' && u.restored === 1, u);
    ok('и версия выросла, а не откатилась', el(fan1).version === vBefore + 2, [vBefore, el(fan1).version]);
    // Первая загрузка: после отмены группы «КИП» у вентилятора 2 не остаётся вовсе
    const first = (await routes.undo(done.batchId)).body;
    ok('отмена самой первой загрузки: группы «КИП» нет', !JSON.parse(el(fan2).specs).groups.some((g: any) => g.title === KIP_GROUP) && first.restored >= 1, first);
    const re = (await routes.plan(exportBook(db).sheets)).body.plan;
    ok('следующая выгрузка снова пустая по КИП', exportBook(db).table.rows.every(r => r.cells[exportBook(db).columns.findIndex(c => c.key === 'e3:INST_RANGE_MIN')] === '') && re.writes.length === 0);
  }

  console.log('6. Разбор книги отдельно от базы');
  {
    const r = readBook([{ name: 'Л', aoa: [['ID позиции Flux', 'A1', 'A2'], ['Служебный', 'о1', 'о2'], ['id1', '5', ''], ['', '', ''], ['id2', '', '7']] }]);
    ok('пустая строка — хвост листа', r.rows.length === 2 && r.rows[1].line === 5 && r.rows[0].cells.A1 === '5' && !('A2' in r.rows[0].cells), r.rows);
    const p = planUpload(r, [], []);
    ok('нет справочника и позиций — все строки в ошибках, а не в тишине', p.errors.length === 2 && p.writes.length === 0);
  }

  console.log('7. Источник по типу позиции');
  {
    // GLOBAL_DEVICE_TYPE: у клапана значение считает Flux (характеристика), у привода — «нет» (его вводит инженер КИП)
    const byType = attr('GLOBAL_DEVICE_TYPE', { source: { kind: 'none' }, sourceByClass: { 'КЛАПАН': { kind: 'param', name: 'Тип привода' } }, classes: ['КЛАПАН', 'ПРИВОД'] });
    const tagAttr = attr('TAG_X', { source: { kind: 'none' }, sourceByClass: { 'КЛАПАН': { kind: 'field', key: 'tag' } }, classes: ['КЛАПАН', 'ПРИВОД'] });
    const pos = (id: string, cls: string, tag: string) => ({ id, cls, tags: [tag], label: tag, kip: {} as Record<string, string> });
    const r = readBook([{ name: 'Л', aoa: [['ID позиции Flux', 'GLOBAL_DEVICE_TYPE', 'TAG_X'], ['Служебный', 'a', 'b'], ['v1', 'SF', 'V-1'], ['p1', 'SM', 'чужой']] }]);
    const p = planUpload(r, [byType, tagAttr], [pos('v1', 'КЛАПАН', 'V-1'), pos('p1', 'ПРИВОД', 'P-1')]);
    ok('клапан: значение считает Flux — не пишется; привод — «нет», пишется в КИП', p.writes.length === 1 && p.writes[0].id === 'p1' && p.writes[0].changes.some(c => c.attr === 'GLOBAL_DEVICE_TYPE' && c.after === 'SM'), p);
    ok('тег проверяется только у типа, где источник — тег (у привода «чужой» не ошибка)', p.errors.length === 0 && !p.notes.some(n => n.code === 'no-tag'), p);
    ok('замечание «считает Flux» названо', p.notes.some(n => n.code === 'flux' && n.names.includes('GLOBAL_DEVICE_TYPE')), p.notes);
    const bad = planUpload(readBook([{ name: 'Л', aoa: [['ID позиции Flux', 'TAG_X'], ['Служебный', 'b'], ['v1', 'V-9']] }]), [tagAttr], [pos('v1', 'КЛАПАН', 'V-1')]);
    ok('у типа с тегом чужой тег — ошибка', bad.errors.length === 1 && /Чужой тег/.test(bad.errors[0].message), bad);
  }

  console.log(failed === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();
