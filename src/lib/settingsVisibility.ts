import { isOwner } from './roles';

// Листы владельца: переводчик и браузер подключают внешние сервисы за счёт всей программы
const OWNER_SETTINGS = new Set(['translate', 'browser']);

/** Видимость раздела по адресу использует то же правило, что и боковая панель. */
export function canSeeSettingsSection(section: string, user: { role?: string } | null | undefined): boolean {
  return !OWNER_SETTINGS.has(section) || isOwner(user);
}

/** Закрытый прямой адрес переключается на общие настройки до показа раздела. */
export function settingsSectionFromQuery(section: string | null, user: { role?: string } | null | undefined): string {
  return section && canSeeSettingsSection(section, user) ? section : 'general';
}
