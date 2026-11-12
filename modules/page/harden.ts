/**
 * Закрытие того, что CSP не покрывает: WebRTC (утечка адресов и обход connect-src через ICE), запросы разрешений
 * (камера, микрофон, геопозиция, уведомления…) и предзагрузка DNS. Касается кадров flux-module:// и форм v1, и страниц v2.
 * Для остальных окон Flux поведение прежнее: Electron по умолчанию разрешает всё, и здесь это не меняется.
 */
import { MODULE_SCHEME } from '../protocol';

interface SessionLike {
  setPermissionRequestHandler(handler: (wc: unknown, permission: string, callback: (granted: boolean) => void, details: { requestingUrl?: string }) => void): void;
  setPermissionCheckHandler(handler: (wc: unknown, permission: string, origin: string, details: { requestingUrl?: string }) => boolean): void;
}
interface ContentsLike { setWebRTCIPHandlingPolicy(policy: 'default' | 'default_public_interface_only' | 'default_public_and_private_interfaces' | 'disable_non_proxied_udp'): void }

const isModuleUrl = (url?: string) => !!url && url.startsWith(`${MODULE_SCHEME}:`);
/** Решение по разрешению: кадру программы — никогда, остальным — как прежде (разрешено) */
export const permissionAllowed = (url?: string) => !isModuleUrl(url);

export function hardenModuleSession(session: SessionLike) {
  session.setPermissionRequestHandler((_wc, _permission, callback, details) => callback(permissionAllowed(details?.requestingUrl)));
  session.setPermissionCheckHandler((_wc, _permission, origin, details) => permissionAllowed(details?.requestingUrl || origin));
}
/** Только прокси-трафик: UDP-обмен ICE напрямую отключён, адреса компьютера кадру не раскрываются */
export function hardenModuleContents(contents: ContentsLike) {
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
}
