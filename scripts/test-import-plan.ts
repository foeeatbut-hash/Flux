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

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 300) : ''));

// ── Заглушка базы: одна установка с одним блоком ────────────────────────────
const specs = JSON.stringify({
  groups: [{ title: 'Аэродинамика', params: [{ key: 'Расход воздуха', value: '5000', unit: 'м³/ч' }] }],
});
const makePrisma = (overrides?: Record<string, string>) => ({
  equipmentSystem: { findMany: async () => [{ id: 'sys1', name: 'У1' }] },
  monoblock: { findFirst: async ({ where }: any) => (where.name === 'M1' ? { id: 'mb1' } : null) },
  componentElement: {
    findFirst: async ({ where }: any) => (where.itemCode === 'Б1'
      ? { id: 'el1', specs, overrides: overrides ? JSON.stringify(overrides) : null }
      : null),
  },
});

const result = (value: string) => ({
  units: [{
    name: 'У1', title: 'Установка', groups: [],
    monoblocks: [{ name: 'M1', title: '', blocks: [{
      name: 'Б1', title: 'Вентилятор', equipType: 'ВЕНТИЛЯТОР',
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

  console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
  process.exit(f === 0 ? 0 : 1);
})();
