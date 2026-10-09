import React from 'react';
import { Home, Monitor, Network } from 'lucide-react';
import { NativeWindowsFileIcon } from '../explorer/WindowsFileIcon';
import type { WindowsFileEntry, WindowsFileRef } from '../../lib/windowsFiles';
import { windowsFilesRequest, type WindowsThumbnail } from '../../lib/windowsFiles';
import type { PlaceKind } from './places';

/**
 * Значок места. У папки, диска и облачного корня — настоящий значок Windows
 * через мост (`getIcon`), своих рисованных на месте системных нет. У
 * У виртуальных мест мост принимает только фиксированные имена оболочки.
 */
export default function PlaceIcon({ kind, name, fileRef, size = 16, flux = false, className = '' }: {
  kind: PlaceKind; name: string; fileRef?: WindowsFileRef; size?: number; flux?: boolean; className?: string;
}) {
  const [icon, setIcon] = React.useState<string | null>(null);
  React.useEffect(() => {
    let active = true; setIcon(null);
    if (kind === 'home' || kind === 'computer' || kind === 'network') {
      void windowsFilesRequest<WindowsThumbnail | null>({ action: 'placeIcon', place: kind, size: Math.max(16, Math.min(512, Math.round(size))) }).then((answer) => {
        if (active && answer.ok && answer.data?.dataUrl?.startsWith('data:image/png;base64,')) setIcon(answer.data.dataUrl);
      }).catch(() => undefined);
    }
    return () => { active = false; };
  }, [kind, size]);
  if (icon) return <img src={icon} width={size} height={size} alt="" draggable={false} className={`shrink-0 ${className}`} />;
  if (kind === 'home') return <Home width={size} height={size} aria-hidden className={`shrink-0 ${className}`} />;
  if (kind === 'computer') return <Monitor width={size} height={size} aria-hidden className={`shrink-0 ${className}`} />;
  if (kind === 'network') return <Network width={size} height={size} aria-hidden className={`shrink-0 ${className}`} />;
  const entry: WindowsFileEntry = {
    name, relativePath: fileRef?.relativePath ?? '', storage: flux || fileRef?.draftId ? 'flux' : 'windows', ...(fileRef?.draftId ? { draftId: fileRef.draftId } : {}),
    kind: 'directory', fileId: '', size: 0, modifiedAt: '', linked: false,
  };
  return <NativeWindowsFileIcon entry={entry} fileRef={fileRef ?? { rootId: '', relativePath: '' }} size={size} className={className} />;
}
