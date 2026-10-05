import type { WindowsFileRef } from './contracts';

/** Shell Windows — отдельная область: виртуальный значок не является файлом. */
export interface ShellDesktopPoint { x: number; y: number }
export interface ShellDesktopIcon { dataUrl: string; width: number; height: number }
export interface ShellDesktopItem {
  id: string;
  name: string;
  kind: 'file' | 'directory' | 'shortcut' | 'virtual';
  /** Ярлык ведёт ровно на исполняемый файл этого приложения; сам .lnk сохраняется. */
  isFluxAppShortcut?: boolean;
  /** Глобальные экранные DIP; начало окна вычитается только при показе. */
  position: ShellDesktopPoint;
  icon: ShellDesktopIcon | null;
  monitorId: number | null;
  /** Размер клетки в DIP монитора этого значка. */
  cell?: { width: number; height: number };
  /** Физический файл открывается редакторами через уже разрешённую папку. */
  fileRef?: WindowsFileRef;
}
export interface ShellDesktopSnapshot {
  status: 'ready' | 'unavailable' | 'unsupported';
  message?: string;
  revision: string;
  items: ShellDesktopItem[];
  view: {
    /** Это физические пиксели источника, повторно масштабировать DIP нельзя. */
    physicalBounds: { x: number; y: number; width: number; height: number };
    iconSize: number;
    spacing: ShellDesktopPoint;
    iconsVisible: boolean;
  } | null;
}
export interface ShellDesktopActionResult { ok: boolean; message?: string }
export interface ShellDesktopBridge {
  snapshot: () => Promise<ShellDesktopSnapshot>;
  open: (id: string) => Promise<ShellDesktopActionResult>;
  onChanged: (callback: () => void) => () => void;
}
export const SHELL_DESKTOP_SNAPSHOT = 'desktop-shell:snapshot';
export const SHELL_DESKTOP_OPEN = 'desktop-shell:open';
export const SHELL_DESKTOP_CHANGED = 'desktop-shell:changed';
