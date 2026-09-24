/**
 * Ядро Каталога и Конструктора: обозначения, правила, разбор описаний, подбор.
 *
 * Эталоны — настоящие: обозначения из бланков E06-2001…2003 и каталогов ВЕЗА,
 * описания — строки MTO PDH2.12953-3700-PB-001-OV.MTO-0001 (рев. 3/AN3). Для
 * каждой строки MTO проверяется, что подбор выбирает то же семейство, что
 * инженер поставил в бланк.
 *
 * Запуск: npx tsx scripts/test-catalog-core.ts
 */
import { seedCatalog, detectorsFor } from '../catalog/seed';
import { buildDesignation, parseDesignation, parseWithFamily, sameDesignation } from '../catalog/designation';
import { checkConfig, optionsFor, sizeLimits } from '../catalog/rules';
import { describe, findSizes, findTags, tagTypeOf } from '../catalog/describe';
import { matchDescription } from '../catalog/match';
import { splitTagCell, derivedTag, duplicateTags } from '../catalog/tags';
import { foldCode, stripDecor, signatureOf } from '../catalog/text';

let ok = 0;
let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  if (good) { ok++; console.log('  ✓', name); } else { fail++; console.error('  ✗', name, '— получили', JSON.stringify(got), 'ждали', JSON.stringify(want)); }
};
const yes = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { ok++; console.log('  ✓', name); } else { fail++; console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail)); }
};

const cat = seedCatalog();
const fam = (code: string) => cat.families.find((f) => f.code === code)!;
const valveDetectors = detectorsFor('valve');

console.log('1. Приведение строк');
eq('латинская K в «KК» — та же буква', foldCode('KК'), foldCode('КК'));
eq('«х» в размере — звёздочка', foldCode('1000х800'), foldCode('1000*800'));
eq('буква О и цифра 0 в коде — одно', foldCode('РОН11О'), foldCode('РОН110'));
yes('МН220-Т и МН220 остаются разными', foldCode('МН220-Т') !== foldCode('МН220'));
eq('«Клапан » и номер б/з снимаются', stripDecor('Клапан ГЕРМИК-С-1200*1600-В-1*ЭПВ-SM24-S2-V-1-УХЛ2-0_255200653-1-КОМ'), 'ГЕРМИК-С-1200*1600-В-1*ЭПВ-SM24-S2-V-1-УХЛ2-0');
eq('пробел у дефиса — опечатка', stripDecor('КПУ-1Н-О-В-2800х1800 -2*ф'), 'КПУ-1Н-О-В-2800х1800-2*ф');
yes('кириллическое МВ (BELIMO) и латинское MV (ВЕЗА) — разные коды', foldCode('МВ24') !== foldCode('MV24'));

console.log('2. Каждое эталонное обозначение разбирается и собирается обратно');
for (const f of cat.families) {
  for (const ex of f.examples || []) {
    const r = parseWithFamily(f, ex);
    yes(`${f.code}: «${ex}» разобрано полностью`, r.complete, { stuckAt: r.stuckAt, rest: r.rest, values: r.values });
    if (!r.complete) continue;
    const back = buildDesignation(f, r.values);
    yes(`${f.code}: сборка совпадает с «${ex}»`, sameDesignation(back.text, ex), back.text);
  }
}

console.log('3. Разбор по всему каталогу находит своё семейство');
const byCatalog = (s: string) => parseDesignation(cat.families, s).filter((r) => r.complete).map((r) => cat.families.find((f) => f.id === r.familyId)!.code);
eq('КПУ-1Н из бланка E06-2002', byCatalog('КПУ-1Н-О-В-2800х1800 -2*ф-ЭПВ24-СН-КК-0-0-0-0-0'), ['КПУ-1Н']);
eq('МЕТРО отличается от КПУ-2Н приводом МЭО', byCatalog('КПУ-2Н-О-К-500х600-2*ф-МЭО220-СН-0-0-0-0-ВД-0'), ['КПУ-2Н МЕТРО']);
eq('КПУ-2Н-ВД — это КПУ-2Н с потоком ВД', byCatalog('КПУ-2Н-О-Н-500*600-2*ф-МН220-СН-0-РОН120-0-1*500-ВД-0'), ['КПУ-2Н']);
eq('ГЕРМИК-С с номером б/з', byCatalog('Клапан ГЕРМИК-С-800*1000-Н-1*SM24-S2-V-1-УХЛ2-0_255200654-1-КОМ'), ['ГЕРМИК-С']);
{
  const r = parseDesignation(cat.families, 'КПУ-1Н-О-В-1000х800-2*ф-ЭПВ99-СН-КК-0-0-0-0-0')[0];
  yes('неизвестный привод — частичный разбор с местом остановки', !!r && !r.complete && r.stuckAt === 'drive', r);
}
{
  const r = parseWithFamily(fam('КПУ-1Н'), 'КПУ-1Н-О-В-1000х800-2*ф-ЭПВ24-СН-КК-0-0-0-0-0').values;
  eq('размеры и коды из строки', [r.W, r.H, r.purpose, r.exec, r.type, r.drive, r.terminals], [1000, 800, 'О', 'В', '2*ф', 'ЭПВ24', 'КК']);
  const g = parseWithFamily(fam('ГЕРМИК-П'), 'ГЕРМИК-П-600*1000-Н-1*РУЧКА-1-УХЛ2-0').values;
  eq('ГЕРМИК пишет высоту первой: Н=600, В=1000', [g.H, g.W], [600, 1000]);
  const d = parseWithFamily(fam('КПУ-1Н'), 'КПУ-1Н-О-Н-500*600-2*ф-МН220-СН-0-РОН120-0-1*500-0-0').values;
  eq('переходник 1*500 — стороны и диаметр', [d.adapterN, d.adapterD], ['1', 500]);
}

console.log('4. Правила каталога');
{
  const f = fam('КПУ-1Н');
  const bad = checkConfig(f, { purpose: 'О', exec: 'В', W: 500, H: 500, type: '2*ф', drive: 'МН24' }).map((v) => v.ruleId);
  yes('взрывозащищённое исполнение с обычным приводом — ошибка', bad.includes('ex-drive'), bad);
  const good = checkConfig(f, { purpose: 'О', exec: 'В', W: 500, H: 500, type: '2*ф', drive: 'ЭПВ24' }).filter((v) => v.level === 'error');
  eq('В + ЭПВ24 + канальный — без ошибок', good, []);
  const place = optionsFor(f, 'placement', { type: '1*ф' });
  eq('у стенового СН недоступно, ВН доступно', place.map((o) => [o.value.code, o.allowed]), [['СН', false], ['ВН', true]]);
  yes('причина недоступности названа', !!place.find((o) => !o.allowed)?.reason);
  const t = optionsFor(f, 'drive', { purpose: 'З', exec: 'Н' }).filter((o) => o.value.code.endsWith('-Т')).every((o) => !o.allowed);
  yes('приводы с ТРУ недоступны у нормально закрытого', t);
  const small = checkConfig(f, { purpose: 'О', exec: 'Н', W: 50, H: 500, type: '2*ф', drive: 'МН24' }).map((v) => v.ruleId);
  yes('ширина меньше 100 — ошибка размера', small.includes('duct-w'), small);
  const cassette = checkConfig(f, { purpose: 'О', exec: 'В', W: 2800, H: 1800, type: '2*ф', drive: 'ЭПВ24' });
  yes('2800×1800 — предупреждение о кассете, не ошибка', cassette.some((v) => v.level === 'warning') && !cassette.some((v) => v.level === 'error'), cassette);
  eq('пределы размера для канального', [sizeLimits(f, { type: '2*ф' }).W.min, sizeLimits(f, { type: '2*ф' }).W.max], [100, 4100]);
  const round = checkConfig(f, { purpose: 'О', exec: 'Н', D: 330, type: '2*ф', drive: 'МН24' }).map((v) => v.ruleId);
  yes('диаметр вне ряда — ошибка', round.includes('round-series'), round);
}

console.log('5. Размеры, теги и коды в описаниях');
eq('900x400(h) — ширина × высота', findSizes('section;900x400(h); Fire')[0] && [findSizes('900x400(h)')[0].W, findSizes('900x400(h)')[0].H], [900, 400]);
eq('200(h)x300 — высота первой', [findSizes('wheel damper 200(h)x300;')[0].W, findSizes('200(h)x300')[0].H], [300, 200]);
eq('1100 (h) x1600 с пробелами', [findSizes('Air vent valve; 1100 (h) x1600 with')[0].H, findSizes('1100 (h) x1600')[0].W], [1100, 1600]);
eq('Ø900 — круглый', findSizes('Check channel valve; -; Ø900;')[0].D, 900);
eq('без пометки 700x600 — ширина × высота', [findSizes('section 700x600 with')[0].W, findSizes('700x600')[0].H], [700, 600]);
yes('M25x1.5 не размер клапана', findSizes('М25x1.5 glands').length === 0, findSizes('М25x1.5 glands'));
eq('несколько тегов в ячейке MTO', splitTagCell('3700-B01-DN-001A, 3700-B01-DN-001B, 3700-B01-DN-002A').tags, ['3700-B01-DN-001A', '3700-B01-DN-001B', '3700-B01-DN-002A']);
eq('теги через пробел из бланка', splitTagCell('3700-C01-DV-001 3700-C01-DV-002').tags, ['3700-C01-DV-001', '3700-C01-DV-002']);
eq('код типа из тега', tagTypeOf('3700-B02-DF-004'), 'DF');
eq('тег привода: DF → DFD', derivedTag('3700-B01-DF-001', 'DF', 'DFD'), '3700-B01-DFD-001');
eq('дубли тегов между позициями', [...duplicateTags([{ id: 'a', tags: ['3700-A01-DV-001'] }, { id: 'b', tags: ['3700-a01-dv-001'] }]).keys()], ['3700-A01-DV-001']);
yes('размер «2800-1800» не тег', findTags('2800-1800-2').length === 0);

console.log('6. Подбор по строкам MTO — тот же выбор, что в бланках E06');
type Case = { name: string; text: string; tags: string; family: string; expect?: Record<string, unknown>; designation?: string };
const CASES: Case[] = [
  {
    name: 'DF, взрывозащищённый, пружинный привод 24 В — КПУ-1Н-О-В',
    tags: '3700-B02-DF-001, 3700-B02-DF-004',
    text: 'Fire damper, rectangular cross-section;900x400(h); Fire resistance - EI 60. Function - normally open. Design - explosion proof; Climatic design as per GOST 15150-69 - U3 Damper type - duct damper Control - open/closed. electromechanical spring return actuator in explosion proof enclosure - 1pc. Rated voltage - 24 V (DC). Power consumption 8.5 W Limit switches (open/closed positions) - yes Junction box with a terminal strip - yes Power cable, alarm cable supplied with the damper / Клапан противопожарный прямоугольного сечения; 900x400(h); Предел огнестойкости - EI 60. Функциональное назначение - нормально открытый. Исполнение - взрывозащищенное; E=VVFIP009760',
    family: 'КПУ-1Н',
    expect: { purpose: 'О', exec: 'В', type: '2*ф', drive: 'ЭПВ24', placement: 'СН', terminals: 'КК', W: 900, H: 400 },
    designation: 'КПУ-1Н-О-В-900х400-2*ф-ЭПВ24-СН-КК-0-0-0-0-0',
  },
  {
    name: 'DS, нормально закрытый, реверсивный — КПУ-1Н-З-В',
    tags: '3700-D01-DS-002, 3700-D01-DS-003',
    text: 'Fire damper, rectangular cross-section;1000x800(h); Fire resistance - EI 60. Function - normally closed. Design - explosion proof; Damper type - duct damper. reversible actuator in explosion proof enclosure - 1pc. Rated voltage - 24 V (DC). Power consumption 12 W Junction box with a terminal strip - yes / Клапан противопожарный прямоугольного сечения; 1000x800(h); нормально закрытый; реверсивный привод во взрывозащищенной оболочке',
    family: 'КПУ-1Н',
    expect: { purpose: 'З', exec: 'В', drive: 'ЭПВ24' },
  },
  {
    name: 'DS, двойного действия EI 15 — КПУ-ДД',
    tags: '3700-D03-DS-001',
    text: 'Double acting fire fighting wheel damper 200(h)x300; Fire resistance - EI 15. Function - double acting. Design - explosion proof; Drive type - reversing drive MBE(24). Rated voltage - 24 V (DC). Power consumption 4 W Junction box with a terminal strip - no',
    family: 'КПУ-ДД',
    expect: { act: 'Р', exec: 'В', W: 300, H: 200 },
  },
  {
    name: 'DF, общепромышленный, 220 В, круглый — КПУ-1Н круглый',
    tags: '3700-C03-DF-001',
    text: 'Fire damper, round cross-section; Ø100; Fire resistance - EI 60. Function - normally open. Design - general industrial; spring return actuator. Rated voltage - 24 V',
    family: 'КПУ-1Н',
    expect: { D: 100, exec: 'Н', purpose: 'О' },
  },
  {
    name: 'DN, лепестковый 400(h)x900 — ТЮЛЬПАН-1',
    tags: '3700-B03-DN-001',
    text: 'Check channel valve; petal; 400(h)x900; Execution - explosion-proof; Operating pressure - not more than 1500; Climatic execution UKhL2; Spatial orientation - vertical; Material of construction - brass/steel; Blade adjacency - lock; Leakage ABAP class - 1; Control - no drive Клапан обратный канальный; лепестковый',
    family: 'ТЮЛЬПАН-1',
    expect: { H: 400, W: 900, exec: 'В' },
  },
  {
    name: 'DN, круглый Ø900 из углеродистой стали — НЕРПА-КО',
    tags: '3700-C01-DN-001',
    text: 'Check channel valve; -; Ø900; Execution - general industrial; carbon steel with protective coating; Leakage ABAP class - 2; Wheel valve length - max. 350 mm / Клапан обратный канальный; углеродистая сталь',
    family: 'НЕРПА-КО',
    expect: { D: 900 },
  },
  {
    name: 'DN, одна лопатка с противовесом 200(h)x250 — КЛАРА',
    tags: '3700-C05-DN-001',
    text: 'Duct check valve; with one blade and counterweight outside of the valve; 200(h)x250; Design - general industrial / Клапан обратный канальный с одной лопаткой и противовесом',
    family: 'КЛАРА',
    designation: 'КЛАРА-200х250-Н',
  },
  {
    name: 'DP, избыточного давления 800x600(h) — КИД',
    tags: '3700-G03-DP-001',
    text: 'Overpressure valve; 800x600(h); general industrial execution; opening pressure customization range - from 20 to 150 Pa / Клапан избыточного давления',
    family: 'КИД',
    expect: { W: 800, H: 600, exec: 'Н' },
  },
  {
    name: 'DW, утеплённый взрывозащищённый 230 В — ГЕРМИК-С',
    tags: '3700-B09-DW-001',
    text: 'Heat-insulated damper, 1200(h)x1600, with perimeter heating, design - explosion proof; electrical/mechanical actuator without spring return - 2 pce.; rated voltage - 230 V (AC); power consumption - 2.5 W / Клапан утепленный',
    family: 'ГЕРМИК-С',
    expect: { H: 1200, W: 1600, exec: 'В', driveEx: 'ЭПВ-' },
  },
  {
    name: 'DW, воздушный с обогревом, класс утечки 3 — КЕДР-С',
    tags: '3700-C01-DW-001',
    text: 'Air vent valve; 1100 (h) x1600 with perimeter heating; execution - general industrial; nominal voltage - 24 V (DC); power consumption - 5 W; leakage class - 3; junction box with terminal block - no',
    family: 'КЕДР-С',
    expect: { H: 1100, W: 1600, exec: 'Н' },
  },
  {
    name: 'DW, воздушный взрывозащищённый без обогрева — ГЕРМИК-Р',
    tags: '3700-B10-DW-002',
    text: 'Air damper, 1200(h)x1800, design - explosion proof; electric actuator - 1 pce; rated voltage - 24 V (DC); power consumption - 2.5 W',
    family: 'ГЕРМИК-Р',
    expect: { H: 1200, W: 1800, exec: 'В' },
  },
  {
    name: 'DV, ручная заслонка 700x600 — ГЕРМИК-П с ручкой',
    tags: '3700-A01-DV-001',
    text: 'Damper, rectangular section 700x600 with manual control ; - / Заслонка с прямоугольным сечением 700x600 с ручным управлением; - E=VFLA1000318',
    family: 'ГЕРМИК-П',
    expect: { drive: 'РУЧКА' },
  },
];
for (const c of CASES) {
  const d = describe(c.text, valveDetectors, { tags: splitTagCell(c.tags).tags });
  const list = matchDescription(cat, d);
  const top = list[0];
  const topFam = cat.families.find((f) => f.id === top.familyId)!;
  yes(`${c.name}: семейство`, topFam.code === c.family, { got: topFam.code, next: list.slice(1, 3).map((x) => [cat.families.find((f) => f.id === x.familyId)!.code, x.score]), score: top.score, reasons: top.reasons });
  if (topFam.code !== c.family) continue;
  for (const [k, want] of Object.entries(c.expect || {})) {
    yes(`${c.name}: ${k} = ${want}`, top.values[k] === want, { got: top.values[k], source: top.sources[k] });
  }
  if (c.designation) yes(`${c.name}: обозначение`, sameDesignation(top.designation, c.designation), top.designation);
  yes(`${c.name}: нет ошибок каталога`, !top.violations.some((v) => v.level === 'error'), top.violations);
}

console.log('7. Признаки описания');
{
  const d = describe('electrical/mechanical actuator without spring return - 2 pce', valveDetectors);
  eq('«without spring return» — реверсивный, а не пружинный', d.facts.actuator, 'reversible');
  const r = describe('электропривод с возвратной пружиной, ~220 В', valveDetectors);
  eq('«с возвратной пружиной» по-русски', r.facts.actuator, 'spring');
  eq('230 В читается как 220', describe('rated voltage - 230 V (AC)', valveDetectors).facts.voltage, 220);
  eq('кириллическая Е в «ЕI 90»', describe('огнестойкость ЕI 90', valveDetectors).facts.ei, 90);
  const t = describe('Fire damper… normally open… / нормально закрытый', valveDetectors);
  yes('противоречие НО/НЗ в одном тексте — конфликт', t.conflicts.some((c) => c.key === 'function'), t.conflicts);
  const fd = describe('Fire damper, rectangular cross-section; Damper type - duct damper', valveDetectors);
  yes('«duct damper» внутри противопожарного не даёт конфликта рода', !fd.conflicts.some((c) => c.key === 'kind'), fd.conflicts);
  eq('«общепромышленное» — не взрывозащищённое', describe('Исполнение - общепромышленное', valveDetectors).facts.ex, false);
  eq('«но» в тексте не назначение', describe('клапан, но без привода', valveDetectors).facts.function, undefined);
}

console.log('8. Обозначение в тексте и обучение');
{
  const d = describe('Позиция 5: Клапан КПУ-1Н-О-Н-500*600-2*ф-МН220-СН-0-РОН120-0-1*500-0-0, 2 шт.', valveDetectors);
  const top = matchDescription(cat, d)[0];
  eq('готовое обозначение в тексте берётся как есть', [cat.families.find((f) => f.id === top.familyId)!.code, top.confidence], ['КПУ-1Н', 1]);
  const text = 'Damper, rectangular section 500x400 with manual control';
  const sig = signatureOf(text);
  eq('подпись описания не зависит от размера', sig, signatureOf('Damper, rectangular section 1200x900 with manual control'));
  const learned = [{ signature: sig, familyId: 'veza-regular-l', values: { exec: 'Н', drive: 'РУЧКА', driveCount: 1 }, count: 3 }];
  const withLearn = matchDescription(cat, describe(text, valveDetectors), { learned })[0];
  eq('выученный выбор побеждает', withLearn.familyId, 'veza-regular-l');
  eq('размер при этом берётся из текста', [withLearn.values.W, withLearn.values.H], [500, 400]);
}

console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
