/**
 * Системные знаки Проводника и оболочки, нарисованные Flux: папка, этот
 * компьютер, диск, сеть, облако, корзина — и файл по расширению.
 *
 * Значков Windows в программе нет: раньше папки, диски и файлы показывали
 * картинки, которые отдавала оболочка системы, и рядом с рисунком Flux
 * стояли значки двадцатилетней давности другого размера и цвета. Теперь всё,
 * что можно увидеть в Проводнике, рисуется здесь в одном стиле с листом
 * FileBadge: те же цвета, тот же размер от 16 до 256 px.
 */
import React from 'react';
import FileBadge, { DocAppIcon, SheetAppIcon, PdfAppIcon } from '../ui/FileBadge';

export type FileIconKind =
  | 'folder' | 'this-pc' | 'bin' | 'drive' | 'network' | 'cloud'
  | 'word' | 'excel' | 'pdf' | 'unknown' | 'document';

const svgProps = (size: number, className: string) => ({
  width: size, height: size, viewBox: '0 0 32 32', fill: 'none', 'aria-hidden': true as const,
  className: `shrink-0 ${className}`,
});

/** Общие системные и офисные знаки: одна форма в Проводнике и оболочке, с мягкими тенями и деталями. */
export function FileIcon({ kind, size = 32, className = '' }: { kind: FileIconKind; size?: number; className?: string }) {
  if (kind === 'word') return <DocAppIcon size={size} className={className} />;
  if (kind === 'excel') return <SheetAppIcon size={size} className={className} />;
  if (kind === 'pdf') return <PdfAppIcon size={size} className={className} />;
  if (kind === 'document') return <FileBadge file="Документ.docx" size={size} className={className} />;
  if (kind === 'folder') return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" className={`shrink-0 ${className}`}>
      {/* Задняя стенка папки с ярлычком */}
      <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h6.8l2.6 2.8H26a2.5 2.5 0 0 1 2.5 2.5v13a2.5 2.5 0 0 1-2.5 2.5H5.5A2.5 2.5 0 0 1 3 24.3z" fill="#e0ad3e" stroke="#a6761b" strokeWidth="1.2" />
      {/* Лист документа внутри папки */}
      <path d="M6.2 9.2h16.2l2 2v4.5H6.2z" fill="#ffffff" stroke="#cbd5e1" strokeWidth="0.9" />
      <path d="M8.5 11.4h8.5" stroke="#94a3b8" strokeWidth="0.9" strokeLinecap="round" />
      {/* Передняя откидная створка с диагональной тенью */}
      <path d="M3.2 13.5h9.6l2.4-2.2H27.8a1.5 1.5 0 0 1 1.45 1.85l-2.1 11.6a2.2 2.2 0 0 1-2.16 1.75H5.4a2.2 2.2 0 0 1-2.18-2z" fill="#f5d06f" stroke="#a6761b" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M14.5 26.5l12.2-13.2h1.1a1.5 1.5 0 0 1 1.45 1.85l-2.1 11.6a2.2 2.2 0 0 1-2.16 1.75H14.5z" fill="#e6bc53" />
      <path d="M4.5 14.6h8.4l2.4-2.2h12.2" stroke="#fff3c4" strokeWidth="1" strokeLinecap="round" />
      <path d="M3.2 13.5h9.6l2.4-2.2H27.8a1.5 1.5 0 0 1 1.45 1.85l-2.1 11.6a2.2 2.2 0 0 1-2.16 1.75H5.4a2.2 2.2 0 0 1-2.18-2z" stroke="#a6761b" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
  if (kind === 'this-pc') return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" className={`shrink-0 ${className}`}>
      {/* Подставка монитора с тенью */}
      <path d="M13.2 21.5h5.6l1.1 4.2h-7.8z" fill="#cbd5e1" stroke="#52667a" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M9.5 25.7h13M10.8 27.6h10.4" stroke="#52667a" strokeWidth="1.35" strokeLinecap="round" />
      {/* Корпус монитора */}
      <rect x="3.5" y="4.5" width="25" height="17.2" rx="2.4" fill="#e9f1f7" stroke="#52667a" strokeWidth="1.3" />
      <path d="M19 4.5h7.1a2.4 2.4 0 0 1 2.4 2.4v12.4a2.4 2.4 0 0 1-2.4 2.4H12z" fill="#dce6f0" />
      <rect x="3.5" y="4.5" width="25" height="17.2" rx="2.4" stroke="#52667a" strokeWidth="1.3" />
      {/* Экран с диагональным бликом и индикатором диска */}
      <rect x="5.8" y="6.8" width="20.4" height="11.8" rx="1" fill="#b8d9ec" stroke="#60788c" strokeWidth="1" />
      <path d="M15.5 6.8h9.7a1 1 0 0 1 1 1v9.8a1 1 0 0 1-1 1H9.5z" fill="#a3cce4" />
      <path d="M6.8 8h18.4" stroke="#ffffff" strokeOpacity="0.75" strokeWidth="0.9" strokeLinecap="round" />
      <rect x="20.8" y="16.4" width="3.8" height="1.1" rx="0.4" fill="#60788c" fillOpacity="0.55" />
      <rect x="23" y="19.8" width="2.2" height="0.9" rx="0.4" fill="#52667a" />
    </svg>
  );
  if (kind === 'bin') return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" className={`shrink-0 ${className}`}>
      {/* Ручка и крышка корзины */}
      <path d="M13 4.2h6a1 1 0 0 1 1 1v1.6h-8V5.2a1 1 0 0 1 1-1z" fill="#e2e8f0" stroke="#607285" strokeWidth="1.2" />
      <rect x="6" y="6.8" width="20" height="2.8" rx="0.9" fill="#e9f1f7" stroke="#607285" strokeWidth="1.2" />
      {/* Трапециевидный бак с боковой тенью и тремя рёбрами */}
      <path d="M7.6 9.6h16.8l-1.5 16.8a1.8 1.8 0 0 1-1.8 1.6H10.9a1.8 1.8 0 0 1-1.8-1.6z" fill="#e8edf2" stroke="#607285" strokeWidth="1.2" />
      <path d="M16.5 9.6h7.9l-1.5 16.8a1.8 1.8 0 0 1-1.8 1.6h-5.8z" fill="#d8e1ea" />
      <path d="M7.6 9.6h16.8l-1.5 16.8a1.8 1.8 0 0 1-1.8 1.6H10.9a1.8 1.8 0 0 1-1.8-1.6z" stroke="#607285" strokeWidth="1.2" />
      <path d="M8.8 10.8h14.4" stroke="#ffffff" strokeOpacity="0.8" strokeWidth="0.9" strokeLinecap="round" />
      <rect x="10.8" y="12.5" width="1.8" height="11.8" rx="0.9" transform="rotate(-3 10.8 12.5)" fill="#b8c4d0" stroke="#607285" strokeWidth="0.9" />
      <rect x="15.1" y="12.5" width="1.8" height="11.8" rx="0.9" fill="#b8c4d0" stroke="#607285" strokeWidth="0.9" />
      <rect x="19.4" y="12.5" width="1.8" height="11.8" rx="0.9" transform="rotate(3 19.4 12.5)" fill="#b8c4d0" stroke="#607285" strokeWidth="0.9" />
    </svg>
  );
  if (kind === 'drive') return (
    <svg {...svgProps(size, className)}>
      {/* Корпус диска: светлая крышка, тёмное основание, индикатор работы */}
      <path d="M5.6 9.5h20.8l2.6 9.6v4.4a2.5 2.5 0 0 1-2.5 2.5H5.5A2.5 2.5 0 0 1 3 23.5v-4.4z" fill="#dde7f0" stroke="#52667a" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M3 19.1h26v4.4a2.5 2.5 0 0 1-2.5 2.5H5.5A2.5 2.5 0 0 1 3 23.5z" fill="#b8c7d6" stroke="#52667a" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M6 12h20" stroke="#ffffff" strokeOpacity="0.8" strokeWidth="1" strokeLinecap="round" />
      <circle cx="24.2" cy="22.6" r="1.3" fill="#10b981" stroke="#047857" strokeWidth="0.7" />
      <path d="M6.5 22.6h8" stroke="#52667a" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
  if (kind === 'network') return (
    <svg {...svgProps(size, className)}>
      {/* Узел сверху и два узла снизу, связанные шиной */}
      <path d="M16 11.5v4.5M8 20v-4h16v4" stroke="#52667a" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="10.5" y="3.5" width="11" height="8" rx="1.6" fill="#b8d9ec" stroke="#52667a" strokeWidth="1.3" />
      <path d="M12 5.6h8" stroke="#fff" strokeOpacity="0.8" strokeWidth="1" strokeLinecap="round" />
      <rect x="2.8" y="20" width="10.4" height="7.6" rx="1.6" fill="#e9f1f7" stroke="#52667a" strokeWidth="1.3" />
      <rect x="18.8" y="20" width="10.4" height="7.6" rx="1.6" fill="#e9f1f7" stroke="#52667a" strokeWidth="1.3" />
      <path d="M4.6 22.4h6.8M20.6 22.4h6.8" stroke="#10b981" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
  if (kind === 'cloud') return (
    <svg {...svgProps(size, className)}>
      <path d="M9 25.5a5.5 5.5 0 0 1-.6-10.96A7.6 7.6 0 0 1 23 12.6a6.4 6.4 0 0 1 .5 12.9z" fill="#cfe8f7" stroke="#3f7fa8" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M13 25.5h10.5a6.4 6.4 0 0 0 1.4-12.2 7.6 7.6 0 0 0-1.9-.7z" fill="#a8d3ec" />
      <path d="M9.5 16.2A6 6 0 0 1 15 11.8" stroke="#fff" strokeOpacity="0.85" strokeWidth="1.1" strokeLinecap="round" />
      <path d="M9 25.5a5.5 5.5 0 0 1-.6-10.96A7.6 7.6 0 0 1 23 12.6a6.4 6.4 0 0 1 .5 12.9z" stroke="#3f7fa8" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
  // Неизвестный объект (ссылка не на файл, служебная запись): закрытый лист без подписи
  return <FileBadge file="Объект" kind="closed" size={size} className={className} />;
}
