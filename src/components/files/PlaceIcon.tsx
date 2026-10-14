import React from 'react';
import { FileIcon, HomeAppIcon, IconBadges } from '../icons/FluxIcons';
import type { WindowsFileRef } from '../../lib/windowsFiles';
import { ICON_SIZE } from '../../lib/metrics';
import type { PlaceKind } from './places';

/**
 * Значок места — свой, нарисованный Flux. Раньше диски, папки и облачные
 * корни показывали картинки, которые отдавала оболочка Windows (`getIcon`,
 * `placeIcon`), и рядом с остальным интерфейсом стояли значки чужого стиля и
 * размера. Теперь: главная — дом, «Этот компьютер» — монитор, «Сеть» — узлы,
 * диск и облако — по `glyph` (его знает дерево навигации), остальное — папка.
 */
export default function PlaceIcon({ kind, fileRef, size = ICON_SIZE.row, flux = false, glyph = null, className = '' }: {
  kind: PlaceKind; name?: string; fileRef?: WindowsFileRef; size?: number; flux?: boolean; glyph?: 'cloud' | 'drive' | null; className?: string;
}) {
  const draft = flux || !!fileRef?.draftId;
  if (kind === 'home') return <HomeAppIcon size={size} className={className} />;
  if (kind === 'computer') return <FileIcon kind="this-pc" size={size} className={className} />;
  if (kind === 'network') return <FileIcon kind="network" size={size} className={className} />;
  return <IconBadges size={size} flux={draft}><FileIcon kind={glyph ?? 'folder'} size={size} className={className} /></IconBadges>;
}
