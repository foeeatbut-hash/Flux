import { layoutWindowsDesktop, sortWindowsDesktopEntries } from '../src/components/desktop/WindowsDesktop';
import type { WindowsFileEntry } from '../filesystem/contracts';

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

const entry = (name: string, kind: WindowsFileEntry['kind'], modifiedAt: string): WindowsFileEntry => ({
  name, kind, modifiedAt, relativePath: name, storage: 'flux', fileId: name, size: 1, linked: false,
});
const files = [entry('z.txt', 'file', '2026-01-01'), entry('b', 'directory', '2026-03-01'), entry('a.xlsx', 'file', '2026-02-01')];
check('сортировка по имени не меняет исходный список', sortWindowsDesktopEntries(files, 'name').map((item) => item.name).join(',') === 'a.xlsx,b,z.txt' && files[0].name === 'z.txt');
check('сортировка по типу ставит папки перед файлами', sortWindowsDesktopEntries(files, 'type')[0].kind === 'directory');
check('сортировка по дате сначала показывает недавно изменённое', sortWindowsDesktopEntries(files, 'modified')[0].name === 'b');

console.log(`✓ ${passed} проверок раскладки рабочего стола Windows`);
