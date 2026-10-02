import { placeContextMenu, placeSubmenu } from '../src/lib/contextMenu';

let fail = 0;
const check = (name: string, result: boolean) => {
  if (result) console.log('  ✓', name);
  else { fail++; console.error('  ✗', name); }
};

const monitor = { x: 100, y: 40, w: 900, h: 650 };
const menu = placeContextMenu(980, 670, 280, 420, monitor);
check('меню сдвигается внутрь активного монитора справа', menu.left + 280 <= 996);
check('меню сдвигается вверх внутрь активного монитора', menu.top + 420 <= 686);

const narrow = placeContextMenu(110, 45, 400, 900, { x: 100, y: 40, w: 300, h: 180 });
check('длинное меню получает прокручиваемую доступную высоту', narrow.maxHeight === 172);
check('узкое меню ограничено шириной рабочего поля', narrow.maxWidth === 292);

const flipped = placeSubmenu(
  { x: 760, y: 120, w: 180, h: 30 }, { x: 944, y: 115, w: 220, h: 260 }, monitor,
);
check('подменю раскрывается влево, когда справа нет места', flipped.side === 'left');
check('подменю остаётся по вертикали внутри монитора', flipped.top + 260 <= 686);

console.log(`\n${fail ? `✗ ${fail} провалено` : 'Все проверки пройдены'}`);
process.exit(fail ? 1 : 0);
