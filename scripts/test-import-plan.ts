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
    const links = planTagLinks([{ key: 'k1', tags: ['AHU 2 1'] }], [{ id: 't9', identifier: 'AHU-2-1' }]);
    ok('похожий тег предложен кандидатом', (links[0].candidates || []).length === 1, links[0]);
  }
  {
    const links = planTagLinks([{ key: 'k1', tags: ['T-1'] }], [{ id: 't1', identifier: 'T-1', componentIds: ['other'] }]);
    ok('занятость тега видна заранее', links[0].takenBy === 'other', links[0]);
  }
  {
    // Применение решений: занятый тег не перевешивается молча
    const created: any[] = [];
    const connected: any[] = [];
    const prisma: any = {
      tag: {
        create: async ({ data }: any) => { created.push(data); return { id: 'new1', ...data }; },
        findUnique: async ({ where }: any) => (where.id === 'busy'
          ? { id: 'busy', identifier: 'T-9', componentElements: [{ id: 'other', name: 'Другое изделие' }] }
          : { id: where.id, identifier: 'T-1', componentElements: [] }),
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
  }
  {
    const plan = await planEquipmentImport(
      makePrisma(undefined, [{ id: 't1', identifier: 'ТЕГ-1', componentElements: [] }]),
      'p1', 'AHU', result('5000', ['ТЕГ-1', 'ТЕГ-2']) as any,
    );
    ok('план несёт теги бланка', plan.tagLinks.length === 2, plan.tagLinks);
    ok('счётчики тегов посчитаны', plan.totals.tagsLinked === 1 && plan.totals.tagsNew === 1, plan.totals);
    ok('тег привязан к своей позиции', plan.tagLinks[0].blockKey === blockKey('У1', 'M1', 'Б1'), plan.tagLinks[0]);
  }

  console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
  process.exit(f === 0 ? 0 : 1);
})();
