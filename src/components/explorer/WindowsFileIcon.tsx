import React from 'react';
import type { WindowsFileEntry } from '../../lib/windowsFiles';
import type { ShellDesktopItem } from '../../../filesystem/shellDesktop';
import { FileIcon, IconBadges, AppIcon } from '../icons/FluxIcons';
import FileBadge from '../ui/FileBadge';
import { ICON_SIZE } from '../../lib/metrics';

/**
 * Значок записи Проводника — наш, а не системный.
 *
 * Раньше сюда подставлялась картинка, которую отдавала оболочка Windows
 * (`getIcon`): рядом с рисунками Flux стояли значки другого века, размера и
 * цвета, и по ним нельзя было понять, какие файлы Flux откроет сам. Теперь вид
 * считает lib/fileBadge.ts по расширению, а рисует ui/FileBadge.tsx; формат,
 * который у нас не открывается, получает «закрытый» лист. Мост `getIcon`
 * остаётся в контракте, но для показа не вызывается.
 */
export default function WindowsFileIcon({ entry, size = ICON_SIZE.row, className = '' }: { entry: WindowsFileEntry; size?: number; className?: string }) {
  const flux = entry.storage === 'flux';
  const glyph = entry.kind === 'directory' ? <FileIcon kind="folder" size={size} className={className} />
    : entry.kind === 'link' ? <FileBadge file={`${entry.name}.lnk`} size={size} className={className} />
      : entry.kind === 'file' ? <FileBadge file={entry.name} size={size} className={className} />
        : <FileIcon kind="unknown" size={size} className={className} />;
  return <IconBadges size={size} flux={flux}>{glyph}</IconBadges>;
}

/**
 * Значок объекта рабочего стола Windows. Оболочка отдаёт вместе с объектом
 * свою картинку, но она не используется: папка, ярлык и файл рисуются по
 * имени, а виртуальные места (Корзина, Этот компьютер, Сеть) — по названию.
 */
export function ShellItemIcon({ item, size = ICON_SIZE.desktop }: { item: Pick<ShellDesktopItem, 'name' | 'kind' | 'isFluxAppShortcut'>; size?: number }) {
  if (item.kind === 'directory') return <FileIcon kind="folder" size={size} />;
  if (item.isFluxAppShortcut) return <AppIcon path="/" size={size} />;
  if (item.kind === 'shortcut') return <FileBadge file={/\.(lnk|url)$/i.test(item.name) ? item.name : `${item.name}.lnk`} size={size} />;
  if (item.kind === 'virtual') {
    if (/корзин|recycle/i.test(item.name)) return <FileIcon kind="bin" size={size} />;
    if (/сеть|network/i.test(item.name)) return <FileIcon kind="network" size={size} />;
    if (/компьютер|this pc|computer/i.test(item.name)) return <FileIcon kind="this-pc" size={size} />;
    return <FileIcon kind="folder" size={size} />;
  }
  return <FileBadge file={item.name} size={size} />;
}
