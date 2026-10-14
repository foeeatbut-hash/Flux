/**
 * Значки Flux — вход для остальной программы.
 *
 * Рисунки лежат рядом: файлы и системные места — SystemIcons.tsx, программы
 * по разделам — AppIcons.tsx, лист файла — ui/FileBadge.tsx. Здесь же — метки
 * поверх значка («файл Flux», «общий»), которые не зависят от рисунка.
 */
import React from 'react';

export { FileIcon, type FileIconKind } from './SystemIcons';
export {
  AppIcon, APP_ICON_BY_PATH, type FluxAppIconProps,
  HomeAppIcon, ProjectsAppIcon, RegistryAppIcon, EquipmentAppIcon, DirectoryAppIcon,
  ManagementAppIcon, BuilderAppIcon, CatalogAppIcon, E3FluxAppIcon, ArchivesAppIcon,
  ExplorerAppIcon, GuideAppIcon, TranslateAppIcon, BrowserAppIcon, CalendarAppIcon,
  ChatAppIcon, MailAppIcon, FeedbackAppIcon, SettingsAppIcon, LogsAppIcon, UsersAppIcon,
} from './AppIcons';

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
