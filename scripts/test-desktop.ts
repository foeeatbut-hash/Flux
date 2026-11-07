/**
 * Проверки раскладки значков рабочего стола.
 *
 * Проверяется ровно то, что не видно глазом: два значка в одной клетке
 * выглядят как один, значок за краем стола выглядит как пропавший файл, а
 * значок, не поместившийся на маленьком столе, — как «я его точно клал сюда».
 * Поэтому здесь границы и столкновения, а не «в среднем раскладывается».
 */
import {
  gridSize, cellKey, cellToXY, xyToCell, insideGrid, nextFreeCell,
  sortItems, layout, arrange, place, withApps, CELL_W, CELL_H, PAD,
  type Cell, type DeskItem,
} from '../src/lib/desktop';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

const AREA = { w: 1000, h: 720 };
const item = (id: string, over: Partial<DeskItem> = {}): DeskItem =>
  ({ id, kind: 'file', name: id, shared: false, ...over });

console.log('Сетка');
{
  const s = gridSize(AREA);
  check('столбцы и строки посчитаны', s.cols === Math.floor((1000 - PAD * 2) / CELL_W) && s.rows === Math.floor((720 - PAD * 2) / CELL_H), s);
  const tiny = gridSize({ w: 40, h: 30 });
  check('на крошечном столе остаётся одна клетка', tiny.cols === 1 && tiny.rows === 1, tiny);
  const xy = cellToXY({ col: 2, row: 1 });
  check('клетка переводится в точки', xy.x === PAD + 2 * CELL_W && xy.y === PAD + CELL_H, xy);
  const back = xyToCell(xy.x, xy.y, AREA);
  check('и обратно', back.col === 2 && back.row === 1, back);
  check('за левый край не выпускает', xyToCell(-500, -500, AREA).col === 0);
  const far = xyToCell(99999, 99999, AREA);
  check('за правый и нижний края не выпускает', insideGrid(far, gridSize(AREA)), far);
}

console.log('Свободные клетки');
{
  const s = { cols: 2, rows: 2 };
  check('пустая сетка отдаёт первую клетку', cellKey(nextFreeCell(new Set(), s)!) === '0:0');
  check('заполняем сверху вниз, потом вправо', cellKey(nextFreeCell(new Set(['0:0']), s)!) === '0:1');
  check('столбец кончился — следующий', cellKey(nextFreeCell(new Set(['0:0', '0:1']), s)!) === '1:0');
  check('полная сетка честно отвечает «нет»', nextFreeCell(new Set(['0:0', '0:1', '1:0', '1:1']), s) === null);
}

console.log('Раскладка');
{
  const items = ['a', 'b', 'c'].map((id) => item(id));
  const l = layout(items, {}, AREA);
  check('всем нашлось место', l.cells.size === 3 && l.overflow.length === 0, l.overflow);
  const keys = [...l.cells.values()].map(cellKey);
  check('никто ни с кем не столкнулся', new Set(keys).size === 3, keys);
  check('все клетки внутри стола', [...l.cells.values()].every((c) => insideGrid(c, l.size)));

  const saved = { b: { col: 3, row: 2 } };
  const kept = layout(items, saved, AREA);
  check('сохранённое место уважается', cellKey(kept.cells.get('b')!) === '3:2', kept.cells.get('b'));

  // Стол стал у́же — сохранённое место оказалось за краем
  const narrow = layout(items, { b: { col: 40, row: 0 } }, AREA);
  check('уехавший за край значок вернулся на стол', insideGrid(narrow.cells.get('b')!, narrow.size), narrow.cells.get('b'));
  check('и никого не собой не накрыл', new Set([...narrow.cells.values()].map(cellKey)).size === 3);

  // Два значка претендуют на одну клетку — так бывает после переноса на другом мониторе
  const clash = layout(items, { a: { col: 1, row: 1 }, b: { col: 1, row: 1 } }, AREA);
  check('спор за клетку разрешён, оба на месте', clash.cells.size === 3 && new Set([...clash.cells.values()].map(cellKey)).size === 3,
    [...clash.cells.entries()].map(([id, c]) => `${id}→${cellKey(c)}`));

  const many = Array.from({ length: 6 }, (_, i) => item(`x${i}`));
  const full = layout(many, {}, { w: PAD * 2 + CELL_W * 2, h: PAD * 2 + CELL_H * 2 });
  check('что не влезло — объявлено, а не потеряно', full.cells.size === 4 && full.overflow.length === 2, full.overflow.map((i) => i.id));
  check('пустой стол не роняет', layout([], {}, AREA).cells.size === 0);
}

console.log('Упорядочивание');
{
  const items = [
    item('f2', { kind: 'file', name: 'Бланк', updatedAt: 2000 }),
    item('app:/registry', { kind: 'app', name: 'Яблоко' }),
    item('d1', { kind: 'folder', name: 'Архив', updatedAt: 3000 }),
    item('f1', { kind: 'file', name: 'Акт', updatedAt: 1000 }),
  ];
  const byName = sortItems(items, 'name');
  check('программа впереди даже с последней буквой', byName[0].kind === 'app', byName.map((i) => i.name));
  check('остальное по алфавиту', byName.slice(1).map((i) => i.name).join(',') === 'Акт,Архив,Бланк', byName.map((i) => i.name));
  const byKind = sortItems(items, 'kind');
  check('по типу: папка раньше файлов', byKind[1].kind === 'folder', byKind.map((i) => i.kind));
  const byDate = sortItems(items, 'date');
  check('по дате: свежее раньше', byDate.slice(1).map((i) => i.id).join(',') === 'd1,f2,f1', byDate.map((i) => i.id));

  // Закреплённые программы стоят в порядке закрепления: рука привыкает тянуться
  // в определённое место, и алфавит здесь только мешает
  const pinned = withApps([item('f1', { name: 'Акт' })], ['/яблоко', '/абрикос']);
  const kept = sortItems(pinned, 'name');
  check('закреплённые программы порядка не меняют', kept.slice(0, 2).map((i) => i.path).join(',') === '/яблоко,/абрикос', kept.map((i) => i.path || i.name));
  check('корзина идёт следом за программами', kept[2].kind === 'bin', kept.map((i) => i.kind));
  check('и всё системное стоит впереди файлов', kept[3].kind === 'file', kept.map((i) => i.kind));

  const cells = arrange(items, 'name', AREA);
  check('упорядочивание расставило всех', Object.keys(cells).length === 4);
  check('без столкновений', new Set(Object.values(cells).map(cellKey)).size === 4, cells);
  const { rows } = gridSize(AREA);
  check('заполняет столбец сверху вниз', cells[sortItems(items, 'name')[1].id].col === (rows > 1 ? 0 : 1));
  const cramped = arrange(items, 'name', { w: PAD * 2 + CELL_W, h: PAD * 2 + CELL_H });
  check('на столе в одну клетку расставлен один', Object.keys(cramped).length === 1, cramped);
}

console.log('Перенос значка');
{
  const items = ['a', 'b'].map((id) => item(id));
  const l = layout(items, {}, AREA);
  const target: Cell = l.cells.get('b')!;
  const from = l.cells.get('a')!;
  const moved = place({}, 'a', target, l.cells);
  check('значок встал в занятую клетку', cellKey(moved.a) === cellKey(target), moved);
  check('прежний хозяин не накрыт, а уехал на освободившееся место', cellKey(moved.b) === cellKey(from), moved);
  const free: Cell = { col: 5, row: 3 };
  const toFree = place({}, 'a', free, l.cells);
  check('перенос в пустую клетку не трогает соседей', cellKey(toFree.a) === '5:3' && toFree.b === undefined, toFree);
  const after = layout(items, moved, AREA);
  check('после переноса раскладка без столкновений', new Set([...after.cells.values()].map(cellKey)).size === 2);
}

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки раскладки стола пройдены');
