/**
 * Значки программ Flux — по одному на раздел (workspace/sections.tsx).
 *
 * Раньше разделы были значками lucide: однотонные линии 16 px, которые на
 * панели задач и в Пуске терялись между собой. Здесь у каждого раздела свой
 * цветной рисунок на сетке 32×32, в одном стиле с листом FileBadge и
 * папкой Проводника. Размер задаёт вызывающий (`size`) или класс w-N —
 * см. icons/resolveSize.ts; роли и размеры — ICON_SIZE в lib/metrics.ts.
 */
import React from 'react';
import FileBadge, { DocAppIcon, SheetAppIcon, PdfAppIcon, NotesAppIcon } from '../ui/FileBadge';
import { FileIcon } from './SystemIcons';
import { resolveIconSize } from './resolveSize';

export interface FluxAppIconProps {
  size?: number;
  className?: string;
  strokeWidth?: number;
}


function SvgBox({ size, className = '', children }: { size?: number; className?: string; children: React.ReactNode }) {
  const s = resolveIconSize(size, className);
  return (
    <svg width={s} height={s} viewBox="0 0 32 32" fill="none" aria-hidden="true" className={`shrink-0 ${className}`}>
      {children}
    </svg>
  );
}

/** 1. Главная (`/`) */
export function HomeAppIcon(props: FluxAppIconProps) {
  return (
    <SvgBox {...props}>
      <path d="M21 6.2h3.2v5.2h-3.2z" fill="#94a3b8" stroke="#475569" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M6.2 14.2L16 6l9.8 8.2v12.2a1.6 1.6 0 0 1-1.6 1.6H7.8a1.6 1.6 0 0 1-1.6-1.6z" fill="#e9f1f7" stroke="#475569" strokeWidth="1.25" strokeLinejoin="round" />
      <path d="M16 6l9.8 8.2v12.2a1.6 1.6 0 0 1-1.6 1.6H16z" fill="#d8e3ee" />
      <path d="M6.2 14.2L16 6l9.8 8.2v12.2a1.6 1.6 0 0 1-1.6 1.6H7.8a1.6 1.6 0 0 1-1.6-1.6z" stroke="#475569" strokeWidth="1.25" strokeLinejoin="round" />
      <rect x="12.8" y="17.2" width="6.4" height="10.8" rx="0.8" fill="#10b981" stroke="#475569" strokeWidth="1.15" />
      <path d="M16 17.2h3.2v10.8H16z" fill="#059669" />
      <rect x="12.8" y="17.2" width="6.4" height="10.8" rx="0.8" stroke="#475569" strokeWidth="1.15" />
      <circle cx="17.6" cy="22.8" r="0.65" fill="#ffffff" />
      <path d="M3.2 15.2L16 4.4l12.8 10.8-1.5 1.8L16 7.5 4.7 17z" fill="#94a3b8" stroke="#475569" strokeWidth="1.2" strokeLinejoin="round" />
    </SvgBox>
  );
}

/** 2. Проекты (`/projects`) */
export function ProjectsAppIcon(props: FluxAppIconProps) {
  return (
    <SvgBox {...props}>
      <path d="M3.5 7.5A2.2 2.2 0 0 1 5.7 5.3h6.2l2.3 2.5H26a2.2 2.2 0 0 1 2.2 2.2v15.2a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2z" fill="#e0ad3e" stroke="#a6761b" strokeWidth="1.2" />
      <rect x="3.5" y="9.6" width="24.7" height="17.8" rx="2.2" fill="#f5d06f" stroke="#a6761b" strokeWidth="1.2" />
      <path d="M15 27.4L26.5 9.6h.2a1.5 1.5 0 0 1 1.5 1.5v14.1a2.2 2.2 0 0 1-2.2 2.2z" fill="#e6bc53" />
      <rect x="3.5" y="9.6" width="24.7" height="17.8" rx="2.2" stroke="#a6761b" strokeWidth="1.2" />
      <path d="M5 11h21.7" stroke="#fff3c4" strokeWidth="0.95" strokeLinecap="round" />
      <rect x="6.5" y="12.6" width="5.2" height="11.8" rx="0.9" fill="#ffffff" stroke="#475569" strokeWidth="1.05" />
      <rect x="13.3" y="12.6" width="5.2" height="11.8" rx="0.9" fill="#ffffff" stroke="#475569" strokeWidth="1.05" />
      <rect x="20.1" y="12.6" width="5.2" height="11.8" rx="0.9" fill="#ffffff" stroke="#475569" strokeWidth="1.05" />
      <path d="M7.8 14.6h2.6M7.8 16.5h2.6M7.8 18.4h1.8M14.6 14.6h2.6M14.6 16.5h1.8M14.6 18.4h2.6M21.4 14.6h2.6M21.4 16.5h2.6" stroke="#64748b" strokeWidth="1" strokeLinecap="round" />
    </SvgBox>
  );
}

/** 3. Теги (`/registry`) */
export function RegistryAppIcon(props: FluxAppIconProps) {
  return (
    <SvgBox {...props}>
      <path d="M17.2 4.2h8.6a2 2 0 0 1 2 2v8.6a2 2 0 0 1-.58 1.41L15.6 27.8a2.2 2.2 0 0 1-3.1 0L4.2 19.5a2.2 2.2 0 0 1 0-3.1L15.8 4.8a2 2 0 0 1 1.4-.6z" fill="#94a3b8" stroke="#475569" strokeWidth="1.25" strokeLinejoin="round" />
      <path d="M27.2 16.2L15.6 27.8a2.2 2.2 0 0 1-3.1 0l-4.2-4.2L24.8 7.1l3 3v4.7a2 2 0 0 1-.6 1.4z" fill="#7c8ea3" />
      <path d="M17.2 4.2h8.6a2 2 0 0 1 2 2v8.6a2 2 0 0 1-.58 1.41L15.6 27.8a2.2 2.2 0 0 1-3.1 0L4.2 19.5a2.2 2.2 0 0 1 0-3.1L15.8 4.8a2 2 0 0 1 1.4-.6z" stroke="#475569" strokeWidth="1.25" strokeLinejoin="round" />
      <circle cx="22.8" cy="9.2" r="2.6" fill="#f5d06f" stroke="#475569" strokeWidth="1.1" />
      <circle cx="22.8" cy="9.2" r="1.1" fill="#ffffff" stroke="#475569" strokeWidth="0.9" />
      <path d="M9.5 18.2l7.2-7.2M11.6 20.3l7.2-7.2M13.7 22.4l5.4-5.4" stroke="#10b981" strokeWidth="1.35" strokeLinecap="round" />
    </SvgBox>
  );
}

/** 4. Оборудование (`/equipment`) */
export function EquipmentAppIcon(props: FluxAppIconProps) {
  return (
    <SvgBox {...props}>
      <circle cx="16" cy="16" r="12.2" fill="#cbd5e1" stroke="#475569" strokeWidth="1.25" />
      <circle cx="16" cy="16" r="9.8" fill="#e9f1f7" stroke="#475569" strokeWidth="1.05" />
      {/* Четыре лопасти крыльчатки */}
      <path d="M16 13c-1.8-3.8-.5-6.2 2.2-6.2 2.4 0 3.2 2.3 1.1 5.2z" fill="#7dd3fc" stroke="#475569" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M19 16c3.8-1.8 6.2-.5 6.2 2.2 0 2.4-2.3 3.2-5.2 1.1z" fill="#38bdf8" stroke="#475569" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M16 19c1.8 3.8.5 6.2-2.2 6.2-2.4 0-3.2-2.3-1.1-5.2z" fill="#38bdf8" stroke="#475569" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M13 16c-3.8 1.8-6.2.5-6.2-2.2 0-2.4 2.3-3.2 5.2-1.1z" fill="#7dd3fc" stroke="#475569" strokeWidth="1.1" strokeLinejoin="round" />
      <circle cx="16" cy="16" r="3.2" fill="#e2e8f0" stroke="#475569" strokeWidth="1.2" />
      <circle cx="16" cy="16" r="1.2" fill="#64748b" />
    </SvgBox>
  );
}

/** 5. Справочник (`/directory`) */
export function DirectoryAppIcon(props: FluxAppIconProps) {
  return (
    <SvgBox {...props}>
      <rect x="3.5" y="7.2" width="25" height="18.6" rx="1.8" fill="#f5d06f" stroke="#a6761b" strokeWidth="1.15" />
      <path d="M5 6c3.8 0 8.2.7 11 2.4V25c-2.8-1.6-7.2-2.2-11-2.2z" fill="#f8fafc" stroke="#475569" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M27 6c-3.8 0-8.2.7-11 2.4V25c2.8-1.6 7.2-2.2 11-2.2z" fill="#dbe6f0" stroke="#475569" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M7.6 10.5c2.2.1 4.4.5 6.2 1.3M7.6 13.3c2.2.1 4.4.5 6.2 1.3M7.6 16.1c2.2.1 4.4.5 6.2 1.3" stroke="#10b981" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M24.4 10.5c-2.2.1-4.4.5-6.2 1.3M24.4 13.3c-2.2.1-4.4.5-6.2 1.3M24.4 16.1c-2.2.1-4.4.5-6.2 1.3" stroke="#10b981" strokeWidth="1.2" strokeLinecap="round" />
    </SvgBox>
  );
}

/** 6. Менеджмент (`/management`) */
export function ManagementAppIcon(props: FluxAppIconProps) {
  return (
    <SvgBox {...props}>
      <path d="M12 8.2V5.8A1.6 1.6 0 0 1 13.6 4.2h4.8A1.6 1.6 0 0 1 20 5.8v2.4" stroke="#475569" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="4" y="8.2" width="24" height="18.2" rx="2.4" fill="#94a3b8" stroke="#475569" strokeWidth="1.25" />
      <path d="M16 8.2h9.6a2.4 2.4 0 0 1 2.4 2.4V24a2.4 2.4 0 0 1-2.4 2.4H11z" fill="#7c8ea3" />
      <path d="M4 10.6A2.4 2.4 0 0 1 6.4 8.2h19.2A2.4 2.4 0 0 1 28 10.6v4.6a2.2 2.2 0 0 1-2.2 2.2H6.2A2.2 2.2 0 0 1 4 15.2z" fill="#b4c3d2" stroke="#475569" strokeWidth="1.2" />
      <rect x="4" y="8.2" width="24" height="18.2" rx="2.4" stroke="#475569" strokeWidth="1.25" />
      <rect x="9.6" y="15.2" width="2.8" height="4.2" rx="0.7" fill="#f5d06f" stroke="#475569" strokeWidth="1.05" />
      <rect x="19.6" y="15.2" width="2.8" height="4.2" rx="0.7" fill="#f5d06f" stroke="#475569" strokeWidth="1.05" />
    </SvgBox>
  );
}

/** 7. Конструктор (`/builder`) */
export function BuilderAppIcon(props: FluxAppIconProps) {
  return (
    <SvgBox {...props}>
      {/* Верхний левый синий модуль */}
      <path d="M5 8.5h8.5v3a1.5 1.5 0 0 1 0 3v2H5z" fill="#93c5fd" stroke="#475569" strokeWidth="1.2" strokeLinejoin="round" />
      {/* Нижний левый и правый изумрудные модули */}
      <path d="M5 16.5h8.5v9.5H5z" fill="#86efac" stroke="#475569" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M13.5 16.5h9.5v9.5h-9.5v-3.2a1.5 1.5 0 0 0 0-3.1z" fill="#6ee7b7" stroke="#475569" strokeWidth="1.2" strokeLinejoin="round" />
      {/* Отдельный верхний правый подключаемый модуль */}
      <path d="M19.5 5h7.5v8.2h-7.5v-2.6a1.4 1.4 0 0 1 0-2.8z" fill="#7dd3fc" stroke="#475569" strokeWidth="1.2" strokeLinejoin="round" />
      <circle cx="7.2" cy="10.6" r="0.65" fill="#475569" />
      <circle cx="7.2" cy="23.8" r="0.65" fill="#475569" />
      <circle cx="20.8" cy="23.8" r="0.65" fill="#475569" />
      <circle cx="24.8" cy="7.2" r="0.65" fill="#475569" />
    </SvgBox>
  );
}

/** 8. Каталог (`/catalog`) */
export function CatalogAppIcon(props: FluxAppIconProps) {
  return (
    <SvgBox {...props}>
      {/* Левая папка-регистратор */}
      <rect x="4.5" y="5.5" width="6.2" height="21" rx="1.1" fill="#94a3b8" stroke="#475569" strokeWidth="1.2" />
      <path d="M6.2 8.8h2.8M6.2 10.6h2.8" stroke="#475569" strokeWidth="1.05" strokeLinecap="round" />
      <circle cx="7.6" cy="22.8" r="1.2" fill="#f8fafc" stroke="#475569" strokeWidth="1" />
      {/* Средняя янтарная папка-регистратор */}
      <rect x="11.8" y="5.5" width="6.2" height="21" rx="1.1" fill="#f5d06f" stroke="#a6761b" strokeWidth="1.2" />
      <path d="M13.5 8.8h2.8M13.5 10.6h2.8" stroke="#78530d" strokeWidth="1.05" strokeLinecap="round" />
      <circle cx="14.9" cy="22.8" r="1.2" fill="#f8fafc" stroke="#78530d" strokeWidth="1" />
      {/* Правая наклонная папка-регистратор */}
      <g transform="rotate(-14 21.5 16)">
        <rect x="19" y="5.5" width="6.2" height="20.5" rx="1.1" fill="#7c8ea3" stroke="#475569" strokeWidth="1.2" />
        <path d="M20.7 8.8h2.8M20.7 10.6h2.8" stroke="#f8fafc" strokeWidth="1.05" strokeLinecap="round" />
        <circle cx="22.1" cy="22.4" r="1.2" fill="#f8fafc" stroke="#475569" strokeWidth="1" />
      </g>
    </SvgBox>
  );
}

/** 9. E3Flux (`/e3flux`) */
export function E3FluxAppIcon(props: FluxAppIconProps) {
  return (
    <SvgBox {...props}>
      {/* Шины связей */}
      <path d="M14.5 9.5h8.2v7.2M9.5 14.5v8.2h8.2" stroke="#475569" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
      {/* Верхний левый узел */}
      <rect x="4.5" y="4.5" width="9.5" height="9.5" rx="1.4" fill="#93c5fd" stroke="#475569" strokeWidth="1.2" />
      <path d="M9.5 4.5h3.1a1.4 1.4 0 0 1 1.4 1.4v6.7a1.4 1.4 0 0 1-1.4 1.4H6.5z" fill="#60a5fa" fillOpacity="0.45" />
      <rect x="4.5" y="4.5" width="9.5" height="9.5" rx="1.4" stroke="#475569" strokeWidth="1.2" />
      <rect x="14" y="8.1" width="2.2" height="2.6" rx="0.4" fill="#cbd5e1" stroke="#475569" strokeWidth="1" />
      <rect x="8.1" y="14" width="2.6" height="2.2" rx="0.4" fill="#cbd5e1" stroke="#475569" strokeWidth="1" />
      {/* Нижний правый узел */}
      <rect x="18" y="18" width="9.5" height="9.5" rx="1.4" fill="#86efac" stroke="#475569" strokeWidth="1.2" />
      <path d="M23 18h3.1a1.4 1.4 0 0 1 1.4 1.4v6.7a1.4 1.4 0 0 1-1.4 1.4H20z" fill="#34d399" fillOpacity="0.45" />
      <rect x="18" y="18" width="9.5" height="9.5" rx="1.4" stroke="#475569" strokeWidth="1.2" />
      <rect x="21.4" y="15.8" width="2.6" height="2.2" rx="0.4" fill="#cbd5e1" stroke="#475569" strokeWidth="1" />
      <rect x="15.8" y="21.4" width="2.2" height="2.6" rx="0.4" fill="#cbd5e1" stroke="#475569" strokeWidth="1" />
    </SvgBox>
  );
}

/** 10. Архив (`/archives`) */
export function ArchivesAppIcon({ size, className = '' }: FluxAppIconProps) {
  return <FileBadge file="Архив.zip" kind="archive" size={resolveIconSize(size, className)} className={className} />;
}

/** 11. Проводник (`/explorer`) */
export function ExplorerAppIcon({ size, className = '' }: FluxAppIconProps) {
  return <FileIcon kind="folder" size={resolveIconSize(size, className)} className={className} />;
}

/** 12. Flux Guide (`/guide`) */
export function GuideAppIcon(props: FluxAppIconProps) {
  return (
    <SvgBox {...props}>
      <rect x="3.5" y="7.2" width="25" height="18.6" rx="1.8" fill="#94a3b8" stroke="#475569" strokeWidth="1.15" />
      <path d="M5 6c3.8 0 8.2.7 11 2.4V25c-2.8-1.6-7.2-2.2-11-2.2z" fill="#f8fafc" stroke="#475569" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M27 6c-3.8 0-8.2.7-11 2.4V25c2.8-1.6 7.2-2.2 11-2.2z" fill="#e2e8f0" stroke="#475569" strokeWidth="1.2" strokeLinejoin="round" />
      {/* Строки руководства слева */}
      <path d="M7.5 10h6M7.5 12.6h6M7.5 15.2h6M7.5 17.8h6M7.5 20.4h4.2" stroke="#64748b" strokeWidth="1.1" strokeLinecap="round" />
      {/* Янтарная закладка и изумрудная волна Flux справа */}
      <path d="M20.2 5.8h3.4v7.6l-1.7-1.4-1.7 1.4z" fill="#f5d06f" stroke="#a6761b" strokeWidth="1.05" strokeLinejoin="round" />
      <path d="M18.6 19.8c1.2-1.8 2.6-1.8 3.6 0s2.4 1.8 3.6 0" stroke="#059669" strokeWidth="1.5" strokeLinecap="round" />
    </SvgBox>
  );
}

/** 13. Переводчик (`/translate`) */
export function TranslateAppIcon(props: FluxAppIconProps) {
  return (
    <SvgBox {...props}>
      {/* Левый знак языка */}
      <path d="M10.5 5v2.4M5 7.4h11M7.6 7.4c.5 4.2 3.2 7.5 7.8 9.4M13.4 7.4c-.6 4.2-3.4 7.5-8 9.4" stroke="#475569" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" />
      {/* Двусторонние стрелки обмена */}
      <path d="M18 8.2c2.5.4 4.2 2 4.6 4.6m-1.8-1.2 1.8 1.4 1.4-1.8M14 23.8c-2.5-.4-4.2-2-4.6-4.6m1.8 1.2-1.8-1.4-1.4 1.8" stroke="#94a3b8" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      {/* Правая объёмная буква A */}
      <path d="M17.2 26.8l4.2-11.2h2.2l4.2 11.2h-2.3l-.9-2.6h-4.2l-.9 2.6zm4.1-4.6h2.4l-1.2-3.6z" fill="#38bdf8" stroke="#334155" strokeWidth="1.15" strokeLinejoin="round" />
    </SvgBox>
  );
}

/** 14. Браузер (`/browser`) */
export function BrowserAppIcon(props: FluxAppIconProps) {
  return (
    <SvgBox {...props}>
      <circle cx="16" cy="16" r="12" fill="#93c5fd" stroke="#334155" strokeWidth="1.25" />
      <path d="M24.5 7.5A12 12 0 0 1 7.5 24.5L24.5 7.5z" fill="#60a5fa" fillOpacity="0.45" />
      <ellipse cx="16" cy="16" rx="5.4" ry="12" stroke="#334155" strokeWidth="1.15" />
      <path d="M16 4v24M4 16h24M6 10.5c3 1.4 6.3 2.1 10 2.1s7-.7 10-2.1M6 21.5c3-1.4 6.3-2.1 10-2.1s7 .7 10 2.1" stroke="#334155" strokeWidth="1.1" />
      <circle cx="16" cy="16" r="12" stroke="#334155" strokeWidth="1.25" />
    </SvgBox>
  );
}

/** 15. Календарь (`/calendar`) */
export function CalendarAppIcon(props: FluxAppIconProps) {
  return (
    <SvgBox {...props}>
      <rect x="4.5" y="6.5" width="23" height="21" rx="2.8" fill="#f8fafc" stroke="#475569" strokeWidth="1.25" />
      <path d="M18 27.5h6.7a2.8 2.8 0 0 0 2.8-2.8V11.8L14 27.5z" fill="#dce5ef" />
      <path d="M4.5 9.3A2.8 2.8 0 0 1 7.3 6.5h17.4a2.8 2.8 0 0 1 2.8 2.8v3H4.5z" fill="#10b981" stroke="#475569" strokeWidth="1.2" />
      <rect x="4.5" y="6.5" width="23" height="21" rx="2.8" stroke="#475569" strokeWidth="1.25" />
      <rect x="9.5" y="4.2" width="2.4" height="4.6" rx="1.1" fill="#cbd5e1" stroke="#475569" strokeWidth="1.1" />
      <rect x="20.1" y="4.2" width="2.4" height="4.6" rx="1.1" fill="#cbd5e1" stroke="#475569" strokeWidth="1.1" />
      <circle cx="14.2" cy="16" r="1.05" fill="#10b981" />
      <circle cx="17.8" cy="16" r="1.05" fill="#f59e0b" />
      <circle cx="21.4" cy="16" r="1.05" fill="#64748b" />
      <circle cx="10.6" cy="19.6" r="1.05" fill="#10b981" />
      <circle cx="14.2" cy="19.6" r="1.05" fill="#10b981" />
      <circle cx="17.8" cy="19.6" r="1.05" fill="#64748b" />
      <circle cx="21.4" cy="19.6" r="1.05" fill="#64748b" />
      <circle cx="10.6" cy="23.2" r="1.05" fill="#64748b" />
      <circle cx="14.2" cy="23.2" r="1.05" fill="#64748b" />
      <circle cx="17.8" cy="23.2" r="1.05" fill="#64748b" />
      <circle cx="21.4" cy="23.2" r="1.05" fill="#64748b" />
    </SvgBox>
  );
}

/** 16. Мессенджер (`/chat`) */
export function ChatAppIcon(props: FluxAppIconProps) {
  return (
    <SvgBox {...props}>
      {/* Заднее синее облачко */}
      <path d="M12.5 11.2h13.2a2.2 2.2 0 0 1 2.2 2.2v9a2.2 2.2 0 0 1-2.2 2.2h-2.1v3.2l-3.6-3.2h-7.5a2.2 2.2 0 0 1-2.2-2.2v-9a2.2 2.2 0 0 1 2.2-2.2z" fill="#7dd3fc" stroke="#475569" strokeWidth="1.2" strokeLinejoin="round" />
      {/* Переднее светлое облачко с диагональной тенью */}
      <path d="M6.2 5.5h14.6a2.2 2.2 0 0 1 2.2 2.2v9.6a2.2 2.2 0 0 1-2.2 2.2H11.4l-3.8 3.4v-3.4H6.2A2.2 2.2 0 0 1 4 17.3V7.7a2.2 2.2 0 0 1 2.2-2.2z" fill="#f8fafc" stroke="#475569" strokeWidth="1.25" strokeLinejoin="round" />
      <path d="M13 19.5h7.8a2.2 2.2 0 0 0 2.2-2.2V7.7L11 19.5z" fill="#dbe6f0" />
      <path d="M6.2 5.5h14.6a2.2 2.2 0 0 1 2.2 2.2v9.6a2.2 2.2 0 0 1-2.2 2.2H11.4l-3.8 3.4v-3.4H6.2A2.2 2.2 0 0 1 4 17.3V7.7a2.2 2.2 0 0 1 2.2-2.2z" stroke="#475569" strokeWidth="1.25" strokeLinejoin="round" />
      <path d="M8.2 10.5h10.2M8.2 14h6.8" stroke="#64748b" strokeWidth="1.3" strokeLinecap="round" />
    </SvgBox>
  );
}

/** 17. Почта (`/mail`) */
export function MailAppIcon(props: FluxAppIconProps) {
  return (
    <SvgBox {...props}>
      <rect x="3.5" y="7" width="25" height="18" rx="2.2" fill="#94a3b8" stroke="#475569" strokeWidth="1.25" />
      <path d="M4.2 24.2l8.5-7.6M27.8 24.2l-8.5-7.6" stroke="#475569" strokeWidth="1.15" strokeLinecap="round" />
      <path d="M4.2 7.8L16 17l11.8-9.2A2 2 0 0 0 26.3 7H5.7a2 2 0 0 0-1.5.8z" fill="#bae6fd" stroke="#475569" strokeWidth="1.2" strokeLinejoin="round" />
      <rect x="3.5" y="7" width="25" height="18" rx="2.2" stroke="#475569" strokeWidth="1.25" />
    </SvgBox>
  );
}

/** 18. Замечания и предложения (`/feedback`) */
export function FeedbackAppIcon(props: FluxAppIconProps) {
  return (
    <SvgBox {...props}>
      <path d="M6.2 6h19.6A2.2 2.2 0 0 1 28 8.2v12.6a2.2 2.2 0 0 1-2.2 2.2H13.2l-4.4 4v-4H6.2A2.2 2.2 0 0 1 4 20.8V8.2A2.2 2.2 0 0 1 6.2 6z" fill="#f8fafc" stroke="#475569" strokeWidth="1.25" strokeLinejoin="round" />
      <path d="M15 23h10.8a2.2 2.2 0 0 0 2.2-2.2V8.2L13 23z" fill="#dce5ef" />
      <path d="M6.2 6h19.6A2.2 2.2 0 0 1 28 8.2v12.6a2.2 2.2 0 0 1-2.2 2.2H13.2l-4.4 4v-4H6.2A2.2 2.2 0 0 1 4 20.8V8.2A2.2 2.2 0 0 1 6.2 6z" stroke="#475569" strokeWidth="1.25" strokeLinejoin="round" />
      <path d="M10.5 11.4v6.2M7.4 14.5h6.2" stroke="#059669" strokeWidth="1.85" strokeLinecap="round" />
      <path d="M16.5 12.6h7M16.5 16.2h4.6" stroke="#64748b" strokeWidth="1.35" strokeLinecap="round" />
    </SvgBox>
  );
}

/** 19. Настройки (`/settings`) */
export function SettingsAppIcon(props: FluxAppIconProps) {
  return (
    <SvgBox {...props}>
      <path d="M14.2 3.8h3.6l.6 2.6a8.8 8.8 0 0 1 2.2.9l2.3-1.4 2.5 2.5-1.4 2.3c.4.7.7 1.4.9 2.2l2.6.6v3.6l-2.6.6a8.8 8.8 0 0 1-.9 2.2l1.4 2.3-2.5 2.5-2.3-1.4a8.8 8.8 0 0 1-2.2.9l-.6 2.6h-3.6l-.6-2.6a8.8 8.8 0 0 1-2.2-.9l-2.3 1.4-2.5-2.5 1.4-2.3a8.8 8.8 0 0 1-.9-2.2l-2.6-.6v-3.6l2.6-.6c.2-.8.5-1.5.9-2.2L6.6 8.4l2.5-2.5 2.3 1.4c.7-.4 1.4-.7 2.2-.9z" fill="#cbd5e1" stroke="#475569" strokeWidth="1.25" strokeLinejoin="round" />
      <circle cx="16" cy="16" r="5.6" fill="#94a3b8" stroke="#475569" strokeWidth="1.15" />
      <circle cx="16" cy="16" r="3.1" fill="#f8fafc" stroke="#475569" strokeWidth="1.15" />
    </SvgBox>
  );
}

/** 20. Журнал (`/logs`) */
export function LogsAppIcon(props: FluxAppIconProps) {
  return (
    <SvgBox {...props}>
      <rect x="5.5" y="6.2" width="21" height="21.6" rx="2.2" fill="#94a3b8" stroke="#475569" strokeWidth="1.25" />
      <rect x="7.6" y="8.4" width="16.8" height="17.2" rx="1" fill="#f8fafc" stroke="#475569" strokeWidth="1.05" />
      <path d="M11.5 5.2h2.8a1.7 1.7 0 0 1 3.4 0h2.8a1 1 0 0 1 1 1v2.6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V6.2a1 1 0 0 1 1-1z" fill="#f5d06f" stroke="#a6761b" strokeWidth="1.15" strokeLinejoin="round" />
      <circle cx="16" cy="5.8" r="0.65" fill="#78530d" />
      <circle cx="10.8" cy="13.5" r="1.15" fill="#10b981" />
      <path d="M13.5 13.5h8.2" stroke="#64748b" strokeWidth="1.25" strokeLinecap="round" />
      <circle cx="10.8" cy="17.2" r="1.15" fill="#f59e0b" />
      <path d="M13.5 17.2h8.2" stroke="#64748b" strokeWidth="1.25" strokeLinecap="round" />
      <circle cx="10.8" cy="20.9" r="1.15" fill="#e11d48" />
      <path d="M13.5 20.9h8.2" stroke="#64748b" strokeWidth="1.25" strokeLinecap="round" />
    </SvgBox>
  );
}

/** 21. Сотрудники (`/users`) */
export function UsersAppIcon(props: FluxAppIconProps) {
  return (
    <SvgBox {...props}>
      {/* Задний голубой силуэт */}
      <circle cx="21.2" cy="11.2" r="3.8" fill="#93c5fd" stroke="#60a5fa" strokeWidth="1.1" />
      <path d="M16.5 24.5c.4-3.4 2.4-5.4 5.5-5.4 3 0 5 2 5.4 5.4z" fill="#93c5fd" stroke="#60a5fa" strokeWidth="1.1" strokeLinejoin="round" />
      {/* Передний силуэт со значком сотрудника */}
      <circle cx="13.5" cy="10.5" r="4.6" fill="#94a3b8" stroke="#475569" strokeWidth="1.25" />
      <path d="M4.8 26.8c.5-4.8 3.6-7.6 8.7-7.6s8.2 2.8 8.7 7.6z" fill="#94a3b8" stroke="#475569" strokeWidth="1.25" strokeLinejoin="round" />
      <path d="M10.8 19.4L13.5 22l2.7-2.6" stroke="#475569" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="14.5" y="22.4" width="3.8" height="2.4" rx="0.5" fill="#ffffff" stroke="#475569" strokeWidth="0.95" />
    </SvgBox>
  );
}

export const APP_ICON_BY_PATH: Record<string, React.ComponentType<FluxAppIconProps>> = {
  '/': HomeAppIcon,
  '/projects': ProjectsAppIcon,
  '/registry': RegistryAppIcon,
  '/equipment': EquipmentAppIcon,
  '/windows-file': DocAppIcon,
  '/directory': DirectoryAppIcon,
  '/management': ManagementAppIcon,
  '/builder': BuilderAppIcon,
  '/catalog': CatalogAppIcon,
  '/e3flux': E3FluxAppIcon,
  '/archives': ArchivesAppIcon,
  '/explorer': ExplorerAppIcon,
  '/sheet': SheetAppIcon,
  '/office/sheet': SheetAppIcon,
  '/office-sheet': SheetAppIcon,
  '/doc': DocAppIcon,
  '/office/doc': DocAppIcon,
  '/office-doc': DocAppIcon,
  '/pdf': PdfAppIcon,
  '/office/pdf': PdfAppIcon,
  '/office-pdf': PdfAppIcon,
  '/guide': GuideAppIcon,
  '/translate': TranslateAppIcon,
  '/browser': BrowserAppIcon,
  '/calendar': CalendarAppIcon,
  '/notes': NotesAppIcon,
  '/chat': ChatAppIcon,
  '/mail': MailAppIcon,
  '/feedback': FeedbackAppIcon,
  '/settings': SettingsAppIcon,
  '/logs': LogsAppIcon,
  '/users': UsersAppIcon,
};

/**
 * Значок раздела по адресу. Адрес с запросом (`/doc?file=…`) — тот же раздел.
 * Раздела нет в таблице — значок «программа»: серой заглушки из lucide нет,
 * чтобы незнакомый путь не выбивался из набора.
 */
export function AppIcon({ path, size, className = '' }: { path: string; size?: number; className?: string }) {
  const clean = path.split('?')[0] || '/';
  const Icon = APP_ICON_BY_PATH[clean];
  if (Icon) return <Icon size={size} className={className} />;
  return <FileBadge file="Программа" kind="app" size={resolveIconSize(size, className)} className={className} />;
}
