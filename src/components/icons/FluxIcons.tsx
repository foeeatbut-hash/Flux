import React from 'react';
import { FileQuestion, Shapes } from 'lucide-react';
import { SECTIONS } from '../../workspace/sections';
import FileBadge, { DocAppIcon, SheetAppIcon, PdfAppIcon } from '../ui/FileBadge';

export type FileIconKind = 'folder' | 'this-pc' | 'bin' | 'word' | 'excel' | 'pdf' | 'unknown' | 'document';

/** Общие системные и офисные знаки: одна форма в Проводнике и оболочке. */
export function FileIcon({ kind, size = 32, className = '' }: { kind: FileIconKind; size?: number; className?: string }) {
  if (kind === 'word') return <DocAppIcon size={size} className={className} />;
  if (kind === 'excel') return <SheetAppIcon size={size} className={className} />;
  if (kind === 'pdf') return <PdfAppIcon size={size} className={className} />;
  if (kind === 'document') return <FileBadge file="Документ" size={size} className={className} />;
  if (kind === 'folder') return <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className={`shrink-0 ${className}`}>
    <path d="M3 9a2.5 2.5 0 0 1 2.5-2.5h7l3 3H26a2.5 2.5 0 0 1 2.5 2.5v12a2.5 2.5 0 0 1-2.5 2.5h-21A2.5 2.5 0 0 1 2.5 24z" fill="#edbd52" stroke="#bd8a27" strokeWidth="1.2" />
    <path d="M3 13h25l-2 10.5a2 2 0 0 1-2 1.6H5.2a2 2 0 0 1-2-2z" fill="#f4cf72" stroke="#d2a33e" strokeWidth=".8" />
    <path d="M4 14h23" stroke="#ffebad" strokeWidth="1" />
  </svg>;
  if (kind === 'this-pc') return <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className={`shrink-0 ${className}`}>
    <rect x="4" y="5" width="24" height="17" rx="2.5" fill="#e9f1f7" stroke="#60788c" strokeWidth="1.4" />
    <rect x="6.5" y="7.5" width="19" height="12" rx="1" fill="#b8d9ec" />
    <path d="M16 22v3m-6 2h12m-10-2h8" fill="none" stroke="#60788c" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M8 10h16" stroke="#fff" strokeOpacity=".8" />
  </svg>;
  if (kind === 'bin') return <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className={`shrink-0 ${className}`}>
    <path d="M8 10h16l-1.3 17H9.3z" fill="#e8edf1" stroke="#718293" strokeWidth="1.2" />
    <path d="M6 8h20m-13-3h6l1 3h-8z" fill="none" stroke="#718293" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M13 13v10m6-10v10" stroke="#9ba9b4" strokeWidth="1.2" strokeLinecap="round" />
    <path d="M9.5 10.5h13" stroke="#fff" strokeOpacity=".8" />
  </svg>;
  const UnknownIcon = kind === 'unknown' ? FileQuestion : Shapes;
  return <UnknownIcon size={size} strokeWidth={1.55} className={`shrink-0 text-slate-500 dark:text-slate-400 ${className}`} />;
}

/** App icons use the existing section glyphs, preserving Flux's established identity. */
export function AppIcon({ path, size = 20, className = '' }: { path: string; size?: number; className?: string }) {
  if (['/doc', '/office/doc', '/office-doc'].includes(path)) return <DocAppIcon size={size} className={className} />;
  if (['/sheet', '/office/sheet', '/office-sheet'].includes(path)) return <SheetAppIcon size={size} className={className} />;
  if (['/pdf', '/office/pdf', '/office-pdf'].includes(path)) return <PdfAppIcon size={size} className={className} />;
  const Icon = SECTIONS.find((section) => section.path === path)?.icon as React.ComponentType<{ size?: number; className?: string; strokeWidth?: number }> | undefined;
  return Icon ? <Icon size={size} strokeWidth={1.65} className={`text-slate-600 dark:text-slate-300 ${className}`} /> : <Shapes size={size} strokeWidth={1.65} className={`text-slate-500 dark:text-slate-400 ${className}`} />;
}

/** Малые метки занимают разные нижние углы и не закрывают рисунок документа. */
export function IconBadges({ children, flux = false, shared = false, size = 32, className = '' }: {
  children: React.ReactNode; flux?: boolean; shared?: boolean; size?: number; className?: string;
}) {
  if (!flux && !shared) return <>{children}</>;
  const badge = iconBadgeSize(size);
  return <span className={`relative inline-flex shrink-0 ${className}`} style={{ width: size, height: size }}>
    {children}
    {flux && <span aria-label="Файл Flux" title="Flux" className="absolute -bottom-0.5 -left-0.5 grid place-items-center rounded-full border border-white bg-white shadow-sm dark:border-slate-800 dark:bg-slate-800" style={{ width: badge, height: badge }}>
      <svg viewBox="0 0 100 100" width="72%" height="72%" fill="none" stroke="#0f9f8d" strokeWidth="12" strokeLinecap="round" aria-hidden="true"><path d="M16 62C36 28 64 28 84 62M16 40c20 34 48 34 68 0" /></svg>
    </span>}
    {shared && <span aria-label="Общий файл" title="Общий доступ" className="absolute -bottom-0.5 -right-0.5 grid place-items-center rounded-full border border-white bg-sky-600 text-white dark:border-slate-800" style={{ width: badge, height: badge }}>
      <svg viewBox="0 0 16 16" width="72%" height="72%" fill="currentColor" aria-hidden="true"><path d="M5.25 7.4a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Zm5.5-.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6ZM1.7 12.8c.1-2.2 1.4-3.4 3.55-3.4s3.45 1.2 3.55 3.4H1.7Zm7.4 0c-.02-1.45-.55-2.5-1.55-3.15.42-.25.92-.38 1.5-.38 1.85 0 2.95 1.15 3.05 3.53H9.1Z" /></svg>
    </span>}
  </span>;
}

export const iconBadgeSize = (size: number) => Math.max(10, Math.min(14, Math.round(size * 0.34)));
