import { layoutWindowsDesktop } from '../src/components/desktop/WindowsDesktop';

let passed = 0;
function check(name: string, condition: boolean): void {
  if (!condition) throw new Error(`✗ ${name}`);
  passed++;
}

const firstFileId = 'device-file-id-1';
const secondFileId = 'device-file-id-2';
const placed = layoutWindowsDesktop([firstFileId, secondFileId], {
  [firstFileId]: { col: 2, row: 1 },
  [secondFileId]: { col: 0, row: 0 },
}, 3);
check('раскладка сохраняет положения по стабильным fileId', placed[firstFileId].col === 2 && placed[firstFileId].row === 1);
check('раскладка не использует имена или содержимое файлов', Object.keys(placed).join(',') === `${firstFileId},${secondFileId}`);

const collision = layoutWindowsDesktop(['a', 'b', 'c'], {
  a: { col: 0, row: 0 }, b: { col: 0, row: 0 }, c: { col: 5, row: 0 },
}, 2);
const keys = Object.values(collision).map(({ col, row }) => `${col}:${row}`);
check('занятые и вышедшие за край клетки получают свободное место', new Set(keys).size === keys.length && keys.every((key) => Number(key.split(':')[0]) < 2));

console.log(`✓ ${passed} проверок раскладки рабочего стола Windows`);
