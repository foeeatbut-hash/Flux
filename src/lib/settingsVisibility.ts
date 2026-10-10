import { isTopAdmin } from './roles';

const TOP_ADMIN_SETTINGS = new Set(['translate', 'browser']);

/** Видимость раздела по адресу использует то же правило, что и боковая панель. */
export function canSeeSettingsSection(section: string, user: { role?: string } | null | undefined): boolean {
  return !TOP_ADMIN_SETTINGS.has(section) || isTopAdmin(user);
}

/** Закрытый прямой адрес переключается на общие настройки до показа раздела. */
export function settingsSectionFromQuery(section: string | null, user: { role?: string } | null | undefined): string {
  return section && canSeeSettingsSection(section, user) ? section : 'general';
}
