/** Адреса внутренних окон не являются внешними URL или путями Windows. */
export function internalAppHref(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/') || value.startsWith('//')
    || /[\u0000-\u001f\\]/.test(value)) return null;
  try {
    const url = new URL(value, 'http://flux.internal');
    if (url.origin !== 'http://flux.internal' || /^\/(native-app|sticker|capture)(\/|$)/.test(url.pathname)) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
}
export interface NativeAppWindow {
  id: string; href: string; title: string; minimized: boolean; focused: boolean;
}
export const NATIVE_APP_OPEN = 'workspace:app-open';
export const NATIVE_APP_LIST = 'workspace:app-list';
export const NATIVE_APP_ACTION = 'workspace:app-action';
export const NATIVE_APP_CHANGED = 'workspace:app-changed';
export const NATIVE_APP_CLOSE_REQUEST = 'workspace:app-close-request';
export const NATIVE_APP_CLOSE_REPLY = 'workspace:app-close-reply';
export const NATIVE_APP_LOCATION = 'workspace:app-location';
