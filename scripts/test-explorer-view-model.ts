import assert from 'node:assert/strict';
import { DEFAULT_VIEW, contentsRows, normalizeFolderView, orderedEntries, type FolderView } from '../src/components/files/viewModel';
import { folderViewStorageKey } from '../src/components/files/useFolderView';
import type { WindowsFileEntry } from '../src/lib/windowsFiles';

let passed = 0;
function check(value: unknown, message: string) { assert.ok(value, message); passed++; console.log(`✓ ${message}`); }

const entry = (name: string, size: number, modifiedAt: string, kind: WindowsFileEntry['kind'] = 'file'): WindowsFileEntry => ({
  name, size, modifiedAt, kind, relativePath: name, storage: 'windows', fileId: name, linked: false,
});

const source = [
  entry('zeta.txt', 100, '2025-03-01T00:00:00.000Z'),
  entry('Folder', 0, '2025-02-01T00:00:00.000Z', 'directory'),
  entry('alpha.docx', 20, '2025-01-01T00:00:00.000Z'),
  entry('report.pdf', 50, '2025-04-01T00:00:00.000Z'),
];

check(DEFAULT_VIEW.layout === 'details' && DEFAULT_VIEW.columns.join(',') === 'name,modified,type,size', 'По умолчанию включена таблица с четырьмя основными столбцами');
const normalized = normalizeFolderView({
  layout: 'tiles', sort: 'size', descending: true, group: 'type', columns: ['size', 'size', 'nope'],
  widths: { size: 9000, name: 12, modified: 135.7 }, checkboxes: true, extensions: false, hidden: true,
});
check(normalized.layout === 'tiles' && normalized.sort === 'size' && normalized.group === 'type' && normalized.descending,
  'Нормализация принимает сохранённые enum значения и флаги');
check(normalized.columns.join(',') === 'name,size' && normalized.widths.name === 60 && normalized.widths.size === 800 && normalized.widths.modified === 136,
  'Нормализация закрепляет столбец имени, удаляет повторы и ограничивает ширины');
check(normalized.checkboxes && !normalized.extensions && normalized.hidden, 'Переключатели вида сохраняются как boolean');
check(JSON.stringify(normalizeFolderView(normalized)) === JSON.stringify(normalized), 'Нормализация сохранённого вида идемпотентна');
check(folderViewStorageKey('root-a:folder-x') === folderViewStorageKey('root-a:folder-x') && folderViewStorageKey('root-a:folder-x') !== folderViewStorageKey('root-a:folder-y'),
  'Ключ сохранения стабилен для папки и различает соседние папки');
const invalid = normalizeFolderView({ layout: 'fake', sort: 'bad', group: 'bad', columns: [], widths: [] });
check(invalid.layout === DEFAULT_VIEW.layout && invalid.sort === DEFAULT_VIEW.sort && invalid.group === 'none' && invalid.columns[0] === 'name',
  'Повреждённые настройки безопасно возвращаются к виду по умолчанию');

const sortedByName = orderedEntries(source, DEFAULT_VIEW).map((item) => item.name);
check(sortedByName.join(',') === 'Folder,alpha.docx,report.pdf,zeta.txt', 'Сортировка по имени оставляет папки первыми без мутации исходного списка');
const bySize: FolderView = { ...DEFAULT_VIEW, sort: 'size' };
check(orderedEntries(source, bySize).map((item) => item.name).join(',') === 'Folder,alpha.docx,report.pdf,zeta.txt', 'Сортировка по размеру использует размер с именем как tie-breaker');
check(orderedEntries(source, { ...DEFAULT_VIEW, sort: 'modified', descending: true }).map((item) => item.name).join(',') === 'Folder,report.pdf,zeta.txt,alpha.docx',
  'Обратная сортировка не переносит папки за файлы');
const grouped = contentsRows(source, { ...DEFAULT_VIEW, group: 'type' });
check(grouped[0].kind === 'group' && grouped[0].label === 'Папки · Папки' && grouped.some((row) => row.kind === 'group' && row.label === 'Файлы · DOCX'),
  'Группы следуют тому же порядку, что и клавиатурная навигация');
check(grouped.filter((row) => row.kind === 'group').length === 4, 'Заголовок появляется при смене группы в отсортированном списке');
check(source[0].name === 'zeta.txt', 'Построение модели не меняет исходный массив');
console.log(`ALL TESTS PASSED (${passed})`);
