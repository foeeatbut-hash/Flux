/**
 * Проверки папок на рабочем столе.
 *
 * Ошибка здесь выглядит как пропажа: значок, попавший в папку и не показанный
 * в ней, для человека просто исчез — на столе нет, в папке нет, а лежит он в
 * списке, которого не видно. Поэтому все правила проверяются отдельно от
 * разметки.
 *
 * Запуск: npx tsx scripts/test-desk-groups.ts
 */
import {
  fold, unfold, tidy, hiddenIds, rename, groupById, groupIdOf, isGroupId,
  withoutItems, folderItems, DEFAULT_NAME, type DeskGroup,
} from '../src/lib/deskGroups';
import { readFileSync } from 'fs';
import { join } from 'path';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

console.log('Складывание');
{
  const made = fold([], 'app:/registry', 'app:/equipment');
  check('два значка складываются в папку', made.length === 1 && made[0].items.length === 2, made);
  check('папка называется по умолчанию', made[0].name === DEFAULT_NAME);
  check('порядок: на что бросили — первым', made[0].items[0] === 'app:/equipment', made[0].items);

  const more = fold(made, 'app:/explorer', groupIdOf(made[0]));
  check('третий значок ложится в папку', more[0].items.length === 3, more[0].items);
  check('новых папок не появилось', more.length === 1);

  const dup = fold(more, 'app:/explorer', groupIdOf(more[0]));
  check('повтор ничего не меняет', dup[0].items.length === 3);

  const onto = fold(more, groupIdOf(more[0]), 'file-9');
  check('папку тянут на значок — значок ложится в папку', onto[0].items.includes('file-9'), onto[0].items);

  check('сам на себя не складывается', fold([], 'a', 'a').length === 0);
  check('пустые идентификаторы не складываются', fold([], '', 'b').length === 0);
}

console.log('Один значок — одна папка');
{
  const a = fold([], 'x', 'y');
  const b = fold(a, 'z', 'x');    // x уже в папке a — новую из x и z не делаем
  const holders = b.filter((g) => g.items.includes('x'));
  check('значок не оказывается в двух папках', holders.length === 1, b);
}

console.log('Уборка');
{
  const one: DeskGroup[] = [{ id: 'g1', name: 'П', items: ['a'] }];
  check('папка из одного распускается', tidy(one).length === 0);
  const none: DeskGroup[] = [{ id: 'g2', name: 'П', items: [] }];
  check('пустая исчезает', tidy(none).length === 0);
  const two: DeskGroup[] = [{ id: 'g3', name: 'П', items: ['a', 'b'] }];
  check('папка из двух остаётся', tidy(two).length === 1);

  const out = unfold(two, 'g3', 'a');
  check('вынули один — папка распустилась', out.length === 0, out);

  const three: DeskGroup[] = [{ id: 'g4', name: 'П', items: ['a', 'b', 'c'] }];
  const left = unfold(three, 'g4', 'b');
  check('из трёх вынули один — осталось два', left[0].items.join(',') === 'a,c', left[0].items);
}

console.log('Что прячется со стола');
{
  const groups: DeskGroup[] = [
    { id: 'g1', name: 'Документы', items: ['a', 'b'] },
    { id: 'g2', name: 'Разное', items: ['c', 'd'] },
  ];
  const hidden = hiddenIds(groups);
  check('спрятано всё содержимое', hidden.size === 4 && hidden.has('a') && hidden.has('d'));
  check('чужой значок не спрятан', !hidden.has('z'));

  const cleared = withoutItems(groups, ['a', 'b']);
  check('удаление содержимого распускает папку', cleared.length === 1 && cleared[0].id === 'g2', cleared);
}

console.log('Имя и поиск');
{
  const g: DeskGroup[] = [{ id: 'g1', name: 'Старое', items: ['a', 'b'] }];
  check('папка переименовывается', rename(g, 'g1', 'Документы')[0].name === 'Документы');
  check('пустое имя не проходит', rename(g, 'g1', '   ')[0].name === DEFAULT_NAME);
  check('папка находится по значку стола', groupById(g, groupIdOf(g[0]))?.id === 'g1');
  check('чужой значок папкой не считается', !isGroupId('app:/registry'));
  check('значок папки узнаётся', isGroupId(groupIdOf(g[0])));
}

console.log('Папка показывает то, что в ней лежит');
{
  // Ровно та поломка, из-за которой папка с программами открывалась белым
  // полотном: стол искал её значки в списке, где их уже не было — папка ведь
  // сама их и спрятала, — да ещё и без значков программ, которые к столу
  // добавляются отдельно
  const g: DeskGroup = { id: 'g1', name: 'Работа', items: ['app:/registry', 'app:/equipment'] };
  const pool = [
    { id: 'app:/registry', name: 'Теги' },
    { id: 'app:/equipment', name: 'Оборудование' },
    { id: 'file-7', name: 'Ведомость' },
  ];
  const inside = folderItems(g, pool);
  check('папка из двух программ показывает две программы', inside.length === 2, inside);
  check('и именно те, что складывали', inside.map((i) => i.id).join() === 'app:/registry,app:/equipment');
  check('порядок — тот, в каком складывали', inside[0].id === 'app:/registry');
  check('чужого в папке нет', !inside.some((i) => i.id === 'file-7'));

  // Значок мог быть удалён, пока лежал в папке: папка не должна падать
  check('исчезнувший значок просто не показывается',
    folderItems({ ...g, items: ['app:/registry', 'нет-такого'] }, pool).length === 1);
  check('пустая папка — пустой список, а не поломка', folderItems({ ...g, items: [] }, pool).length === 0);

  // Отфильтрованный список — это и была ошибка; проверка ловит её возврат
  const filtered = pool.filter((i) => !hiddenIds([g]).has(i.id));
  check('по отфильтрованному списку папка ничего не найдёт — так и было сломано',
    folderItems(g, filtered).length === 0);
}

console.log('Закрепление вынимает значок из папки');
{
  // Значок, убранный в папку, из списка закреплённых не исчезает — прячет его
  // отдельный состав папок. Пока закрепление смотрело только на список, оно
  // выходило сразу («уже закреплено»), папка продолжала прятать значок, и на
  // столе не появлялось ничего: кнопка выглядела сломанной
  const store = readFileSync(join(__dirname, '../src/store/desktopStore.ts'), 'utf8');
  const pin = store.slice(store.indexOf('pinApp: (path) =>'), store.indexOf('moveApp: (from, to) =>'));
  check('закрепление чистит состав папок', pin.includes('withoutItems(get().groups, [id])'));
  check('открепление тоже', pin.split('withoutItems(get().groups, [id])').length === 3);
  // Та же проверка, но уже на самой функции: спрятанный значок обязан вернуться
  const groups: DeskGroup[] = tidy([
    { id: 'g1', name: 'Программы', items: ['app:/registry', 'app:/equipment', 'app:/explorer'] },
  ]);
  check('значок числился спрятанным', hiddenIds(groups).has('app:/registry'));
  check('после выемки не прячется', !hiddenIds(withoutItems(groups, ['app:/registry'])).has('app:/registry'));
}

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки папок рабочего стола пройдены');
