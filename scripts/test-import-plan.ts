/**
 * План импорта бланка (dry-run): что изменится в проекте до записи.
 *
 * Проверяется то, чего в интерфейсе не видно, пока не станет поздно: считается
 * ли новое новым, изменённое — изменённым, и предупреждает ли план, что
 * обновление затрёт ручную правку инженера. Последнее не работало вовсе:
 * правка пишется ключом «группа||ключ», а план читал «группа|ключ».
 */
import { planEquipmentImport, applyEdits, filterBySelection, blockKey } from '../server/equipmentPlan.js';
import { overrideKey } from '../server/specUtils.js';
import { normalizeTag, planTagLinks, applyTagLinks } from '../server/equipmentTags.js';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 300) : ''));

// ── Заглушка базы: одна установка с одним блоком ────────────────────────────
const specs = JSON.stringify({
  groups: [{ title: 'Аэродинамика', params: [{ key: 'Расход воздуха', value: '5000', unit: 'м³/ч' }] }],
});
const makePrisma = (overrides?: Record<string, string>, tags: any[] = []) => ({
  equipmentSystem: { findMany: async () => [{ id: 'sys1', name: 'У1' }] },
  monoblock: { findFirst: async ({ where }: any) => (where.name === 'M1' ? { id: 'mb1' } : null) },
  componentElement: {
    findFirst: async ({ where }: any) => (where.itemCode === 'Б1'
      ? { id: 'el1', specs, overrides: overrides ? JSON.stringify(overrides) : null }
      : null),
  },
  tag: { findMany: async () => tags },
});

const result = (value: string, tags?: string[]) => ({
  units: [{
    name: 'У1', title: 'Установка', groups: [],
    monoblocks: [{ name: 'M1', title: '', blocks: [{
      name: 'Б1', title: 'Вентилятор', equipType: 'ВЕНТИЛЯТОР',
      tags,
      groups: [{ title: 'Аэродинамика', params: [{ key: 'Расход воздуха', value, unit: 'м³/ч' }] }],
    }] }],
  }],
});

(async () => {
  console.log('1. Что план видит в проекте');
  {
    const plan = await planEquipmentImport(makePrisma(), 'p1', 'AHU', result('5000') as any);
    ok('существующая установка сопоставлена, а не создана', plan.systems[0].action === 'match', plan.systems[0]);
    ok('одинаковое значение — без изменений', plan.blocks[0].action === 'unchanged', plan.blocks[0]);
  }
  {
    const plan = await planEquipmentImport(makePrisma(), 'p1', 'AHU', result('6200') as any);
    ok('другое значение — обновление', plan.blocks[0].action === 'update', plan.blocks[0].action);
    ok('старое значение показано рядом', plan.blocks[0].params[0].oldValue === '5000', plan.blocks[0].params[0]);
    ok('конфликт посчитан', plan.totals.conflicts === 1, plan.totals);
  }

  console.log('2. Ручная правка инженера');
  {
    const ov = { [overrideKey('Аэродинамика', 'Расход воздуха')]: '5500' };
    const plan = await planEquipmentImport(makePrisma(ov), 'p1', 'AHU', result('6200') as any);
    ok('план предупреждает, что затрёт правку', plan.totals.overrides === 1, plan.totals);
  }
  {
    // Тот же ключ с одинарной чертой правкой не является: если план снова
    // начнёт его засчитывать, значит запись и чтение опять разошлись
    const plan = await planEquipmentImport(makePrisma({ 'Аэродинамика|Расход воздуха': '5500' }), 'p1', 'AHU', result('6200') as any);
    ok('чужой формат ключа за правку не принимается', plan.totals.overrides === 0, plan.totals);
  }

  console.log('3. Правки предпросмотра и выбор области');
  {
    const key = blockKey('У1', 'M1', 'Б1');
    const edited = applyEdits(result('6200') as any, { [key]: { 'Аэродинамика‖Расход воздуха': '7000' } });
    ok('правка предпросмотра дошла до значения',
      edited.units[0].monoblocks[0].blocks[0].groups[0].params[0].value === '7000');
    const only = filterBySelection(result('6200') as any, new Set([key]));
    ok('выбранный блок остался', only.units[0].monoblocks[0].blocks.length === 1);
    const none = filterBySelection(result('6200') as any, new Set(['другой']));
    ok('невыбранное отброшено целиком', none.units.length === 0, none);
  }
  {
    // Привод внутри клапана и двигатель внутри вентилятора — второй уровень
    // состава. Раньше выбор блоков их отбрасывал всегда: владельцем привода
    // считался только блок, а у привода владелец — клапан
    const deep = {
      units: [{ name: 'У1', title: '', groups: [], monoblocks: [{ name: 'M1', title: '', blocks: [
        { name: '4', title: 'Блок', equipType: 'ВОЗДУХОПРИЁМНЫЙ', groups: [], role: 'БЛОК' },
        { name: '4/клапан1', title: 'Клапан', equipType: 'КЛАПАН', groups: [], role: 'КЛАПАН', parentName: '4' },
        { name: '4/клапан1/привод1', title: 'Привод №1', equipType: 'ПРИВОД', groups: [], role: 'ПРИВОД', parentName: '4/клапан1' },
        { name: '4/клапан1/привод2', title: 'Привод №2', equipType: 'ПРИВОД', groups: [], role: 'ПРИВОД', parentName: '4/клапан1' },
      ] }] }],
    };
    const keys = deep.units[0].monoblocks[0].blocks.map((b) => blockKey('У1', 'M1', b.name));
    const all = filterBySelection(deep as any, new Set(keys));
    ok('приводы внутри клапана пережили выбор', all.units[0].monoblocks[0].blocks.length === 4,
      all.units[0].monoblocks[0].blocks.map((b: any) => b.name));
    const noDrive = filterBySelection(deep as any, new Set(keys.filter((k) => !k.endsWith('привод2'))));
    ok('снятый привод не уезжает', noDrive.units[0].monoblocks[0].blocks.length === 3);
    const noValve = filterBySelection(deep as any, new Set(keys.filter((k) => !k.endsWith('клапан1'))));
    ok('без клапана не уезжают и его приводы', noValve.units[0].monoblocks[0].blocks.length === 1,
      noValve.units[0].monoblocks[0].blocks.map((b: any) => b.name));
  }

  console.log('4. Новое оборудование');
  {
    const fresh = {
      units: [{ name: 'У9', title: 'Новая', groups: [], monoblocks: [{ name: 'M1', title: '', blocks: [{
        name: 'Б9', title: 'Клапан', equipType: 'КЛАПАН',
        groups: [{ title: 'Общие', params: [{ key: 'Марка', value: 'КПУ-1Н', unit: '' }] }],
      }] }] }],
    };
    const plan = await planEquipmentImport(makePrisma(), 'p1', 'AHU', fresh as any);
    ok('незнакомая установка — создание', plan.systems[0].action === 'create');
    ok('незнакомый блок — создание', plan.blocks[0].action === 'create');
    ok('новых параметров посчитано', plan.blocks[0].newCount === 1, plan.blocks[0]);
  }

  console.log('5. Теги бланка: найти, привязать, создать');
  ok('написание тега приводится к одному виду',
    normalizeTag('3700-C01-BL-001Е') === normalizeTag('3700-c01-bl-001e'),
    [normalizeTag('3700-C01-BL-001Е'), normalizeTag('3700-c01-bl-001e')]);
  ok('подчёркивание и точка равны дефису', normalizeTag('AHU_2.1') === normalizeTag('ahu-2-1'));
  {
    const links = planTagLinks(
      [{ key: 'k1', tags: ['3700-A01-HU-001A', '3700-A01-HU-002'] }],
      [{ id: 't1', identifier: '3700-a01-hu-001a', componentIds: [] }],
    );
    ok('известный тег предлагается привязать', links[0].action === 'link' && links[0].existingTagId === 't1', links[0]);
    ok('неизвестный — создать', links[1].action === 'create', links[1]);
    ok('оба тега разобраны по отдельности', links.length === 2);
  }
  {
    // Те же знаки, разные разделители: пробела в теге быть не может (правило
    // проекта его отвергает раньше поиска), а вот дефисы расставляют по-разному
    const links = planTagLinks([{ key: 'k1', tags: ['AHU21'] }], [{ id: 't9', identifier: 'AHU-2-1' }]);
    ok('похожий тег предложен кандидатом', (links[0].candidates || []).length === 1, links[0]);
    const spaced = planTagLinks([{ key: 'k1', tags: ['AHU 2 1'] }], [{ id: 't9', identifier: 'AHU-2-1' }]);
    ok('тег с пробелом отвергнут до поиска похожих', spaced[0].action === 'invalid', spaced[0]);
  }
  {
    const links = planTagLinks([{ key: 'k1', tags: ['T-1'] }], [{ id: 't1', identifier: 'T-1', componentIds: ['other'] }]);
    ok('занятость тега видна заранее', links[0].takenBy === 'other', links[0]);
  }
  {
    // «3700-B01-СС-001A» с кириллическими «СС» — из присланного владельцем файла.
    // Раньше план говорил «недопустим» и тег не писался вовсе
    const strict = { allowCyrillic: false, prefixes: ['3700'], masks: [], version: 1 };
    const [cc] = planTagLinks([{ key: 'k1', tags: ['3700-B01-СС-001A'] }], [], strict);
    ok('опечатка раскладки исправлена сразу', cc.identifier === '3700-B01-CC-001A' && cc.action === 'create', cc);
    ok('видно, как было в файле', cc.corrected?.from === '3700-B01-СС-001A', cc.corrected);
    ok('при запрете кириллицы «оставить как есть» недоступно', cc.corrected?.keepValid === false, cc.corrected);
    const [known] = planTagLinks([{ key: 'k1', tags: ['3700-B01-СС-001A'] }], [{ id: 't7', identifier: '3700-B01-CC-001A' }], strict);
    ok('исправленный тег находит уже заведённый', known.action === 'link' && known.existingTagId === 't7', known);
    const cyr = { ...strict, allowCyrillic: true };
    const [mixed] = planTagLinks([{ key: 'k1', tags: ['3700-B01-СС-001A'] }], [], cyr);
    ok('смешение алфавитов исправляется и при разрешённой кириллице', mixed.identifier === '3700-B01-CC-001A', mixed);
    ok('а оставить как есть тогда можно', mixed.corrected?.keepValid === true, mixed.corrected);
  }
  {
    // Установка ищется одинаково в плане и при записи
    const { matchSystem } = await import('../server/specUtils.js');
    const got = matchSystem([{ name: '3700-B02-AS-001А' }], '3700-B02-AS-001A');
    ok('установка с опечаткой находится по исправленному имени', got.how === 'similar', got);
    ok('точное имя — точное', matchSystem([{ name: 'У1' }], 'У1').how === 'exact');
    ok('чужая не находится', matchSystem([{ name: '3700-B02-AS-001B' }], '3700-B02-AS-001A').how === 'none');
  }
  {
    // Применение решений: занятый тег не перевешивается молча
    const created: any[] = [];
    const connected: any[] = [];
    const prisma: any = {
      tag: {
        create: async ({ data }: any) => { created.push(data); return { id: 'new1', ...data }; },
        // `projectId` здесь не для полноты: без него применение решений обязано
        // отказать — тег чужого проекта привязывать нельзя
        findUnique: async ({ where }: any) => (where.id === 'busy'
          ? { id: 'busy', projectId: 'p1', identifier: 'T-9', componentElements: [{ id: 'other', name: 'Другое изделие' }] }
          : { id: where.id, projectId: 'p1', identifier: 'T-1', componentElements: [] }),
      },
      componentElement: { update: async ({ where, data }: any) => { connected.push({ where, data }); return {}; } },
    };
    const map = new Map([['k1', 'el1'], ['k2', 'el2'], ['k3', 'el3']]);
    const res = await applyTagLinks(prisma, 'p1', [
      { blockKey: 'k1', identifier: 'T-1', action: 'link', existingTagId: 'ok1' },
      { blockKey: 'k2', identifier: 'T-NEW', action: 'create' },
      { blockKey: 'k3', identifier: 'T-9', action: 'link', existingTagId: 'busy' },
    ], map);
    ok('существующий тег привязан', res.linked === 2, res);
    ok('новый тег заведён один', res.created === 1 && created[0].identifier === 'T-NEW', created);
    ok('занятый тег не перевешен, а объяснён', res.conflicts.length === 1 && /уже привязан/.test(res.conflicts[0]), res.conflicts);

    // Тег чужого проекта не привязывается, как бы ни выглядел запрос
    const alien: any = {
      ...prisma,
      tag: { ...prisma.tag, findUnique: async ({ where }: any) => ({ id: where.id, projectId: 'p2', identifier: 'T-1', componentElements: [] }) },
    };
    const res2 = await applyTagLinks(alien, 'p1', [
      { blockKey: 'k1', identifier: 'T-1', action: 'link', existingTagId: 'ok1' },
    ], map);
    ok('чужой тег не привязан', res2.linked === 0 && /другому проекту/.test(res2.conflicts[0] || ''), res2);
  }
  {
    const plan = await planEquipmentImport(
      makePrisma(undefined, [{ id: 't1', identifier: 'TEG-1', componentElements: [] }]),
      'p1', 'AHU', result('5000', ['TEG-1', 'TEG-2']) as any,
    );
    ok('план несёт теги бланка', plan.tagLinks.length === 2, plan.tagLinks);
    ok('счётчики тегов посчитаны', plan.totals.tagsLinked === 1 && plan.totals.tagsNew === 1, plan.totals);
    ok('тег привязан к своей позиции', plan.tagLinks[0].blockKey === blockKey('У1', 'M1', 'Б1'), plan.tagLinks[0]);
  }

  console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
  process.exit(f === 0 ? 0 : 1);
})();
