/**
 * Значки Flux: размеры, состав и отсутствие системных значков Windows.
 *
 * Тихая ошибка здесь — значок не того размера или чужой картинкой из
 * оболочки Windows: интерфейс работает, но выглядит как набор из разных
 * программ. Поэтому проверяется и отрисовка, и то, что показ не опирается на
 * мост `getIcon`.
 *
 * Запуск: npx tsx scripts/test-flux-icons.tsx
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppIcon, APP_ICON_BY_PATH, FileIcon, IconBadges, iconBadgeSize } from '../src/components/icons/FluxIcons';
import WindowsFileIcon, { ShellItemIcon } from '../src/components/explorer/WindowsFileIcon';
import FileBadge from '../src/components/ui/FileBadge';
import { resolveIconSize } from '../src/components/icons/resolveSize';
import { badgeOf, BADGE_COLOR, type BadgeKind } from '../src/lib/fileBadge';
import { ICON_SIZE, explorerIconSize, BAR_BTN, BAR_ICON, TILE_BOX, TILE_ICON, DESK } from '../src/lib/metrics';
import type { WindowsFileEntry } from '../src/lib/windowsFiles';

for (const size of [24, 32, 48]) {
  const badge = iconBadgeSize(size);
  assert.ok(badge * 2 <= size, `corner badges fit at ${size}px`);
  assert.equal(renderToStaticMarkup(<IconBadges size={size} flux shared><FileIcon kind="folder" size={size} /></IconBadges>).match(/aria-label="(?:Файл Flux|Общий файл)"/g)?.length, 2);
}

const KINDS = ['folder', 'this-pc', 'bin', 'drive', 'network', 'cloud', 'word', 'excel', 'pdf', 'document', 'unknown'] as const;
for (const kind of KINDS) {
  for (const size of [16, 24, 32, 48, 96, 256]) {
    const markup = renderToStaticMarkup(<FileIcon kind={kind} size={size} />);
    assert.match(markup, new RegExp(`width="${size}"`), `${kind} scales to ${size}px`);
    assert.match(markup, /aria-hidden="true"/);
  }
}

const APP_PATHS = [
  '/', '/projects', '/registry', '/equipment', '/directory', '/management',
  '/builder', '/catalog', '/e3flux', '/archives', '/explorer', '/sheet',
  '/doc', '/pdf', '/guide', '/translate', '/browser', '/calendar',
  '/notes', '/chat', '/mail', '/feedback', '/settings', '/logs', '/users',
] as const;
for (const path of APP_PATHS) {
  for (const size of [16, 24, 32, 48]) {
    const markup = renderToStaticMarkup(<AppIcon path={path} size={size} />);
    assert.match(markup, new RegExp(`width="${size}"`), `AppIcon ${path} scales to ${size}px`);
    assert.match(markup, /aria-hidden="true"/);
  }
}

// Каждый раздел программы имеет свой значок: путь, которого нет в таблице,
// показывался бы заглушкой «программа» среди цветных значков
const sections = readFileSync('src/workspace/sections.tsx', 'utf8');
const paths = [...sections.matchAll(/\{ path: '([^']+)', title:/g)].map((m) => m[1]);
assert.ok(paths.length > 20, 'sections.tsx разобран');
for (const path of paths) assert.ok(APP_ICON_BY_PATH[path], `у раздела ${path} есть значок в AppIcons`);
assert.ok(!/from 'lucide-react'/.test(sections), 'значки разделов не из lucide');

// Размер из класса Tailwind: старые места задают значок через w-N
assert.equal(resolveIconSize(undefined, 'w-4 h-4'), 16);
assert.equal(resolveIconSize(undefined, 'shrink-0 w-3.5 h-3.5'), 14);
assert.equal(resolveIconSize(undefined, 'w-12'), 48);
assert.equal(resolveIconSize(undefined, 'w-[18px]'), 18);
assert.equal(resolveIconSize(20, 'w-4'), 20, 'явный size важнее класса');
assert.equal(resolveIconSize(), ICON_SIZE.row);
assert.match(renderToStaticMarkup(<AppIcon path="/mail" className="w-4 h-4" />), /width="16"/);
assert.match(renderToStaticMarkup(<AppIcon path="/doc" className="w-4 h-4" />), /width="16"/);
assert.match(renderToStaticMarkup(<AppIcon path="/нет-такого" size={32} />), /data-kind="app"/);

// Лестница размеров, как в Windows 11 при 100 %
assert.deepEqual(
  { row: ICON_SIZE.row, title: ICON_SIZE.title, taskbar: ICON_SIZE.taskbar, start: ICON_SIZE.start, desktop: ICON_SIZE.desktop, medium: ICON_SIZE.medium, large: ICON_SIZE.large, extraLarge: ICON_SIZE.extraLarge },
  { row: 16, title: 16, taskbar: 24, start: 32, desktop: 48, medium: 48, large: 96, extraLarge: 256 },
);
assert.equal(BAR_ICON, 24, 'значок на панели задач — 24');
assert.equal(TILE_ICON, 32, 'значок в Пуске — 32');
assert.ok(BAR_ICON < BAR_BTN && TILE_ICON < TILE_BOX, 'значок помещается в свою область');
assert.equal(DESK.normal.icon, 48, 'значок стола — 48');
for (const [layout, size] of Object.entries({ small: 16, list: 16, details: 16, tiles: 48, content: 32, medium: 48, large: 96, extraLarge: 256 })) {
  assert.equal(explorerIconSize(layout), size, `вид «${layout}» — значок ${size}`);
}

// Файлы: вид по расширению, у каждого вида свой цвет, закрытый лист для неоткрываемого
const entry = (name: string, kind: WindowsFileEntry['kind'] = 'file'): WindowsFileEntry =>
  ({ name, relativePath: name, storage: 'windows', kind, fileId: name, size: 1, modifiedAt: '2026-10-01T00:00:00Z', linked: false });
const FORMATS: Array<[string, BadgeKind]> = [
  ['a.doc', 'doc'], ['a.docx', 'doc'], ['a.rtf', 'doc'], ['a.odt', 'doc'],
  ['a.xls', 'sheet'], ['a.xlsx', 'sheet'], ['a.xlsm', 'sheet'], ['a.csv', 'sheet'], ['a.ods', 'sheet'],
  ['a.pdf', 'pdf'], ['a.txt', 'text'], ['a.log', 'text'], ['a.md', 'markdown'],
  ['a.png', 'image'], ['a.jpg', 'image'], ['a.jpeg', 'image'], ['a.gif', 'image'], ['a.bmp', 'image'], ['a.svg', 'image'], ['a.webp', 'image'], ['a.tif', 'image'],
  ['a.zip', 'archive'], ['a.rar', 'archive'], ['a.7z', 'archive'], ['a.dwg', 'cad'], ['a.dxf', 'cad'],
  ['a.e3s', 'e3'], ['a.e3p', 'e3'], ['a.xml', 'code'], ['a.json', 'code'], ['a.html', 'code'],
  ['a.exe', 'app'], ['a.msi', 'app'], ['a.bat', 'app'], ['a.cmd', 'app'], ['a.lnk', 'shortcut'], ['a.url', 'shortcut'],
  ['a.mp4', 'video'], ['a.avi', 'video'], ['a.mp3', 'audio'], ['a.wav', 'audio'], ['a.pptx', 'slide'],
  ['a.dll', 'closed'], ['a.psd', 'closed'], ['a.sldprt', 'closed'],
];
for (const [name, kind] of FORMATS) {
  assert.equal(badgeOf(name), kind, `${name} → ${kind}`);
  for (const size of [16, 32, 48, 96]) {
    const markup = renderToStaticMarkup(<WindowsFileIcon entry={entry(name)} size={size} />);
    assert.match(markup, new RegExp(`width="${size}"`), `${name} at ${size}px`);
    assert.match(markup, new RegExp(`data-kind="${kind}"`), `${name} draws ${kind}`);
    assert.ok(!/<img/.test(markup), `${name}: никаких <img> с системной картинкой`);
  }
}
assert.equal(new Set(Object.values(BADGE_COLOR)).size, Object.keys(BADGE_COLOR).length, 'у каждого вида свой цвет полосы');

// Подпись с 32 px: расширение до четырёх букв, на меньшем — только знак
const label = (name: string, size: number) => renderToStaticMarkup(<FileBadge file={name} size={size} />).match(/<text[^>]*>([^<]*)<\/text>/)?.[1];
assert.equal(label('a.docx', 16), undefined, 'на 16 px подписи нет');
assert.equal(label('a.docx', 32), 'DOCX');
assert.equal(label('a.sldprt', 48), 'SLDP', 'длинное расширение — четыре буквы');
assert.equal(label('a.dll', 48), 'DLL', 'закрытый лист подписан расширением');
assert.match(renderToStaticMarkup(<FileBadge file="a.dll" size={48} />), /data-kind="closed"/);

// Папки, диски и объекты — свои знаки, не картинка
assert.match(renderToStaticMarkup(<WindowsFileIcon entry={entry('Папка', 'directory')} size={16} />), /width="16"/);
assert.ok(!/<img/.test(renderToStaticMarkup(<WindowsFileIcon entry={entry('Папка', 'directory')} size={48} />)));
assert.match(renderToStaticMarkup(<WindowsFileIcon entry={entry('Ссылка', 'link')} size={32} />), /data-kind="shortcut"/);
assert.match(renderToStaticMarkup(<WindowsFileIcon entry={{ ...entry('Черновик.docx'), storage: 'flux' }} size={48} />), /aria-label="Файл Flux"/);

// Рабочий стол Windows: картинку из оболочки не берём, рисуем по имени
const shell = (item: Parameters<typeof ShellItemIcon>[0]['item']) => renderToStaticMarkup(<ShellItemIcon item={item} size={48} />);
assert.ok(!/<img/.test(shell({ name: 'Корзина', kind: 'virtual' })));
assert.match(shell({ name: 'Проект', kind: 'directory' }), /width="48"/);
assert.match(shell({ name: 'Excel', kind: 'shortcut' }), /data-kind="shortcut"/);
assert.match(shell({ name: 'Смета.xlsx', kind: 'file' }), /data-kind="sheet"/);

// Показ не вызывает системные значки: ни getIcon, ни placeIcon, ни <img> из data:
for (const file of [
  'src/components/explorer/WindowsFileIcon.tsx', 'src/components/files/PlaceIcon.tsx', 'src/components/files/ContentsPane.tsx',
  'src/components/files/SelectionPane.tsx', 'src/components/files/NavPane.tsx', 'src/components/desktop/WindowsDesktop.tsx',
  'src/components/ImportFileChooser.tsx',
]) {
  const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\.getIcon\b|getIcon\?\.|action: 'placeIcon'|NativeWindowsFileIcon|icon\.dataUrl/.test(source), `${file}: без системных значков`);
}
// Миниатюры содержимого просят только настоящие снимки: оболочка не подсунет свой значок
assert.match(readFileSync('src/components/files/ContentsPane.tsx', 'utf8'), /action: 'thumbnail'[^}]*thumbnailOnly: true/);

console.log('Значки Flux: всё верно');
