/**
 * Отмена импорта расчёта: что именно откат вернёт, что удалит и чего не тронет.
 *
 * Проверяется решение, а не запись: сама запись — тривиальный update, а вот
 * «когда откат обязан пройти мимо» — то место, где легко стереть чужую работу.
 */
import { planUndo, batchTime, describePlan, type HistoryRow, type ElementNow } from '../server/equipmentUndo.js';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 220) : ''));

const specs = (расход: string) => JSON.stringify({ groups: [{ title: 'Аэродинамика', params: [{ key: 'Расход', value: расход }] }] });

const row = (o: Partial<HistoryRow> = {}): HistoryRow => ({
  id: 'h1', elementId: 'e1', version: 1, changedAt: '2026-08-01T10:00:00.000Z',
  oldSpecs: specs('5000'), newSpecs: specs('5600'), changeType: 'UPDATE', ...o,
});

const el = (o: Partial<ElementNow> = {}): ElementNow => ({
  id: 'e1', itemCode: 'бл2.1', specs: specs('5600'), version: 2, where: 'у1 · мн1', ...o,
});

const mapOf = (...list: ElementNow[]) => new Map(list.map(e => [e.id, e]));

console.log('1. Обновлённые импортом элементы');
const p1 = planUndo('imp-1-a', [row()], mapOf(el()));
ok('элемент попадает на возврат', p1.restore.length === 1);
ok('возвращается именно то, что было до импорта', p1.restore[0].specs === specs('5000'));
ok('удалять нечего', p1.remove.length === 0);
ok('пропусков нет', p1.skip.length === 0);
ok('видно, где элемент', p1.restore[0].where === 'у1 · мн1');

console.log('2. Правки после импорта откат не трогает');
// Главное правило: молча стереть чужую работу хуже, чем не доделать откат
const p2 = planUndo('imp-1-a', [row()], mapOf(el({ specs: specs('7000') })));
ok('изменённый вручную элемент пропускается', p2.skip.length === 1 && p2.restore.length === 0);
ok('и сказано, почему', /после импорта/.test(p2.skip[0].reason || ''), p2.skip[0].reason);

console.log('3. Пересохранение — не правка');
// JSON пересохраняется с другим порядком ключей и пробелами; данные те же
const same = JSON.stringify({ groups: [{ title: 'Аэродинамика', params: [{ value: '5600', key: 'Расход' }] }] });
ok('перестановка ключей не считается чужой правкой',
  planUndo('imp-1-a', [row()], mapOf(el({ specs: same }))).restore.length === 1);
const reordered = JSON.stringify({
  groups: [
    { title: 'Б', params: [{ key: 'X', value: '1' }] },
    { title: 'А', params: [{ key: 'Y', value: '2' }] },
  ],
});
const asImported = JSON.stringify({
  groups: [
    { title: 'А', params: [{ key: 'Y', value: '2' }] },
    { title: 'Б', params: [{ key: 'X', value: '1' }] },
  ],
});
ok('перестановка групп — тоже не правка',
  planUndo('imp-1-a', [row({ newSpecs: asImported })], mapOf(el({ specs: reordered }))).restore.length === 1);

console.log('4. Заведённые импортом элементы');
const p4 = planUndo('imp-1-a', [row({ changeType: 'CREATE', oldSpecs: null, newSpecs: specs('5600') })], mapOf(el()));
ok('новый элемент идёт на удаление', p4.remove.length === 1 && p4.restore.length === 0);
const p4b = planUndo('imp-1-a', [row({ changeType: 'CREATE', oldSpecs: null, newSpecs: specs('5600') })],
  mapOf(el({ specs: specs('9000') })));
ok('но не тот, который успели поправить', p4b.remove.length === 0 && p4b.skip.length === 1);

console.log('5. Элемент трогали дважды за один импорт');
const twice = [
  row({ id: 'h1', changedAt: '2026-08-01T10:00:00.000Z', oldSpecs: specs('5000'), newSpecs: specs('5600'), version: 1 }),
  row({ id: 'h2', changedAt: '2026-08-01T10:00:05.000Z', oldSpecs: specs('5600'), newSpecs: specs('5900'), version: 2 }),
];
const p5 = planUndo('imp-1-a', twice, mapOf(el({ specs: specs('5900') })));
ok('возвращаемся к самому первому значению', p5.restore[0].specs === specs('5000'), p5.restore[0].specs);
ok('и к его версии', p5.restore[0].version === 1);

console.log('6. Элемента уже нет');
const p6 = planUndo('imp-1-a', [row()], new Map());
ok('пропускаем без падения', p6.skip.length === 1 && /уже нет/.test(p6.skip[0].reason || ''));

console.log('7. Несколько элементов сразу');
const many = planUndo('imp-1-a', [
  row({ elementId: 'e1' }),
  row({ id: 'h2', elementId: 'e2', changeType: 'CREATE', oldSpecs: null }),
  row({ id: 'h3', elementId: 'e3' }),
], mapOf(
  el(),
  el({ id: 'e2', itemCode: 'бл2.2' }),
  el({ id: 'e3', itemCode: 'бл2.3', specs: specs('1234') }),
));
ok('возврат, удаление и пропуск разложены по кучкам',
  many.restore.length === 1 && many.remove.length === 1 && many.skip.length === 1,
  { r: many.restore.length, d: many.remove.length, s: many.skip.length });
ok('список отсортирован по коду', many.restore[0].itemCode === 'бл2.1');

console.log('8. Сводка и время партии');
ok('сводка перечисляет всё', /вернём|удалим|пропустим/.test(describePlan(many)), describePlan(many));
ok('пустой план говорит прямо', describePlan({ batchId: 'x', restore: [], remove: [], skip: [], reinstate: [], reremove: [], unmove: [], retag: [], unrename: [] }) === 'отменять нечего');
ok('время партии читается', batchTime('imp-1750000000000-abc123') === 1750000000000);
ok('чужой идентификатор не ломает разбор', batchTime('что-то не то') === 0);

console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
process.exit(f === 0 ? 0 : 1);
