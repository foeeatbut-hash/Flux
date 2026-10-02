export interface WindowsNotificationItem {
  id: string;
  source: 'windows';
  appName: string;
  title: string;
  body: string;
  createdAt: string;
}
export interface WindowsNotificationsSnapshot {
  status: 'ready' | 'not-installed' | 'consent-required' | 'denied' | 'unavailable' | 'unsupported';
  message?: string;
  updatedAt?: string;
  items: WindowsNotificationItem[];
}
export interface WindowsNotificationsBridge {
  snapshot: () => Promise<WindowsNotificationsSnapshot>;
  requestConsent: () => Promise<{ ok: boolean; message?: string }>;
  onChanged: (callback: () => void) => () => void;
}
export const WINDOWS_NOTIFICATIONS_SNAPSHOT = 'windows-notifications:snapshot';
export const WINDOWS_NOTIFICATIONS_CONSENT = 'windows-notifications:consent';
export const WINDOWS_NOTIFICATIONS_CHANGED = 'windows-notifications:changed';
