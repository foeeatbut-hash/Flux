import React from 'react';
import { Home, Monitor, Network } from 'lucide-react';
import { NativeWindowsFileIcon } from '../explorer/WindowsFileIcon';
import type { WindowsFileEntry, WindowsFileRef } from '../../lib/windowsFiles';
import type { PlaceKind } from './places';

/**
 * Значок места. У папки, диска и облачного корня — настоящий значок Windows
 * через мост (`getIcon`), своих рисованных на месте системных нет. У
 * Главной, Этого компьютера и Сети ссылки на файл не существует, и мост не
 * умеет отдать значок виртуального узла, поэтому там стоят простые линейные
 * значки — пока владелец не решит, нужна ли для них отдельная команда моста.
 */
export default function PlaceIcon({ kind, name, fileRef, size = 16, flux = false, className = '' }: {
  kind: PlaceKind; name: string; fileRef?: WindowsFileRef; size?: number; flux?: boolean; className?: string;
}) {
  if (kind === 'home') return <Home width={size} height={size} aria-hidden className={`shrink-0 ${className}`} />;
  if (kind === 'computer') return <Monitor width={size} height={size} aria-hidden className={`shrink-0 ${className}`} />;
  if (kind === 'network') return <Network width={size} height={size} aria-hidden className={`shrink-0 ${className}`} />;
  const entry: WindowsFileEntry = {
    name, relativePath: fileRef?.relativePath ?? '', storage: flux || fileRef?.draftId ? 'flux' : 'windows', ...(fileRef?.draftId ? { draftId: fileRef.draftId } : {}),
    kind: 'directory', fileId: '', size: 0, modifiedAt: '', linked: false,
  };
  return <NativeWindowsFileIcon entry={entry} fileRef={fileRef ?? { rootId: '', relativePath: '' }} size={size} className={className} />;
}
