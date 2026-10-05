import React from 'react';
import type { WindowsFileEntry, WindowsFileRef } from '../../lib/windowsFiles';
import { FileIcon, IconBadges } from '../icons/FluxIcons';

type Visual = { label: string; color: string; mark: 'lines' | 'grid' | 'photo' | 'code' | 'zip' | 'pdf' | 'generic' };

const visualFor = (name: string): Visual => {
  const extension = name.split('.').pop()?.toLocaleLowerCase('en') || '';
  if (['doc', 'docx', 'rtf', 'odt'].includes(extension)) return { label: 'W', color: '#185abd', mark: 'lines' };
  if (['xls', 'xlsx', 'csv', 'ods'].includes(extension)) return { label: 'X', color: '#217346', mark: 'grid' };
  if (['ppt', 'pptx', 'odp'].includes(extension)) return { label: 'P', color: '#c43e1c', mark: 'lines' };
  if (extension === 'pdf') return { label: 'PDF', color: '#c42b1c', mark: 'pdf' };
  if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'].includes(extension)) return { label: 'IMG', color: '#7a4cc2', mark: 'photo' };
  if (['zip', '7z', 'rar', 'gz', 'tar'].includes(extension)) return { label: 'ZIP', color: '#94722e', mark: 'zip' };
  if (['js', 'jsx', 'ts', 'tsx', 'html', 'css', 'json', 'xml', 'py', 'c', 'cpp', 'sql'].includes(extension)) return { label: '</>', color: '#4b6178', mark: 'code' };
  if (['txt', 'md', 'log', 'ini', 'yaml', 'yml'].includes(extension)) return { label: 'TXT', color: '#657789', mark: 'lines' };
  if (['exe', 'msi', 'bat', 'cmd', 'app'].includes(extension)) return { label: 'APP', color: '#526c88', mark: 'generic' };
  return { label: extension.slice(0, 3).toUpperCase() || 'FILE', color: '#718096', mark: 'generic' };
};

/** Иконки Проводника держат знакомый силуэт и различают тип по знаку и подписи. */
export default function WindowsFileIcon({ entry, size = 18, className = '', nativeIcon }: { entry: WindowsFileEntry; size?: number; className?: string; nativeIcon?: string | null }) {
  const large = size > 20;
  if (nativeIcon) return <IconBadges size={size} flux={entry.storage === 'flux'}>
    <img src={nativeIcon} alt="" draggable={false} width={size} height={size} className={`shrink-0 object-contain ${className}`} />
  </IconBadges>;
  if (entry.kind === 'directory') return <IconBadges size={size} flux={entry.storage === 'flux'}><FileIcon kind="folder" size={size} className={className} /></IconBadges>;
  if (entry.kind !== 'file') return <IconBadges size={size} flux={entry.storage === 'flux'}><FileIcon kind="unknown" size={size} className={className} /></IconBadges>;
  const visual = visualFor(entry.name);
  const ext = entry.name.split('.').pop()?.toLocaleLowerCase('en') || '';
  if (['doc', 'docx', 'rtf', 'odt'].includes(ext)) return <IconBadges size={size} flux={entry.storage === 'flux'}><FileIcon kind="word" size={size} className={className} /></IconBadges>;
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return <IconBadges size={size} flux={entry.storage === 'flux'}><FileIcon kind="excel" size={size} className={className} /></IconBadges>;
  if (ext === 'pdf') return <IconBadges size={size} flux={entry.storage === 'flux'}><FileIcon kind="pdf" size={size} className={className} /></IconBadges>;
  if (['exe', 'msi', 'bat', 'cmd', 'app'].includes(ext) || visual.mark === 'generic') return <IconBadges size={size} flux={entry.storage === 'flux'}><FileIcon kind="unknown" size={size} className={className} /></IconBadges>;
  return <IconBadges size={size} flux={entry.storage === 'flux'}><svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className={`shrink-0 ${className}`}>
    <path d="M7 3.5h12l6 6V26a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 7 26z" fill="#fff" stroke="#a9b5c1" strokeWidth="1" />
    <path d="M19 4v4a2 2 0 0 0 2 2h4" fill="#e8edf2" stroke="#a9b5c1" strokeWidth="1" />
    {visual.mark === 'grid' ? <g fill="none" stroke={visual.color} strokeWidth="1"><rect x="10" y="12" width="11" height="8" rx=".8"/><path d="M10 15h11M10 17.5h11M13.7 12v8M17.4 12v8"/></g>
      : visual.mark === 'photo' ? <g fill="none" stroke={visual.color} strokeWidth="1.1"><rect x="10" y="12" width="11" height="8" rx=".8"/><circle cx="17.8" cy="14.3" r="1" fill={visual.color}/><path d="m10.5 19 3-3 2 1.7 2-1.5 3 2.8"/></g>
        : visual.mark === 'code' ? <path d="m14 12-3 4 3 4m3-8-1.5 8m3.5-8 3 4-3 4" fill="none" stroke={visual.color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
          : visual.mark === 'zip' ? <g stroke={visual.color} strokeWidth="1.2"><path d="M16 11v9" strokeDasharray="1.5 1.2"/><rect x="14.8" y="17.5" width="2.4" height="2.8" rx=".4" fill={visual.color}/></g>
            : visual.mark === 'pdf' ? <path d="M11 19c2-1.5 3.8-4.8 4.5-7.2.4-1.5-1-1.7-1.2-.3-.3 2.8 2.2 5.9 6.1 6.3 1.3.1 1.3-1.1.2-1.2-3-.1-7.4 1.2-9.6 2.4z" fill="none" stroke={visual.color} strokeWidth="1.1"/>
              : <g fill="none" stroke={visual.color} strokeWidth="1.1" strokeLinecap="round"><path d="M11 13h10M11 16h10M11 19h7"/></g>}
    <path d="M6 22h19v4a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z" fill={visual.color} />
    {large && <text x="15.5" y="26.3" textAnchor="middle" fontSize={visual.label.length > 2 ? 4.4 : 6.2} fontWeight="600" fill="#fff">{visual.label}</text>}
  </svg></IconBadges>;
}

const iconCache = new Map<string, { at: number; request: Promise<string | null> }>();

/** Берёт значок оболочки Windows, когда приложение запущено в Electron. */
export function NativeWindowsFileIcon({ entry, fileRef, size = 18, className = '' }: { entry: WindowsFileEntry; fileRef: WindowsFileRef; size?: number; className?: string }) {
  const [nativeIcon, setNativeIcon] = React.useState<string | null>(null);
  React.useEffect(() => {
    let active = true;
    const key = `${fileRef.rootId}\0${fileRef.relativePath}\0${fileRef.draftId || ''}\0${entry.modifiedAt}`;
    const bridge = (window as any).electron?.windowsFiles?.getIcon;
    setNativeIcon(null);
    if (typeof bridge !== 'function' || entry.draftId) return () => { active = false; };
    let cached = iconCache.get(key);
    if (!cached || Date.now() - cached.at > 60000) {
      if (iconCache.size >= 512) iconCache.delete(iconCache.keys().next().value!);
      cached = { at: Date.now(), request: Promise.resolve().then(() => bridge(fileRef)).then((icon: string | null) =>
        typeof icon === 'string' && icon.startsWith('data:image/png;base64,') ? icon : null).catch(() => null) };
      iconCache.set(key, cached);
    }
    void cached.request.then((icon) => { if (active) setNativeIcon(icon); });
    return () => { active = false; };
  }, [entry.kind, entry.modifiedAt, entry.draftId, fileRef.rootId, fileRef.relativePath, fileRef.draftId]);
  return <WindowsFileIcon entry={entry} size={size} className={className} nativeIcon={nativeIcon} />;
}
