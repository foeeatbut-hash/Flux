/** Открытые Ed25519-ключи входа владельца. Закрытые половины живут вне сборки.
 * Пустые значения запрещают вход; запасной ключ хранится офлайн отдельно. */
export const OWNER_PUBLIC_KEY_HEX = 'e7fd6ed8be839bf3b80487c9c80c6f36f82d216d778355d9752143cc18a06b73';
export const OWNER_BACKUP_PUBLIC_KEY_HEX = '4f31b886accedd2669b1c26024fe9766fb2bb200e6c1bf3f3eac1108d12285ab';
/** Лицензии подписывает отдельный ключ: вход владельца им не разрешается. */
export const LICENSE_SIGNING_PUBLIC_KEY_HEX = '5f2f7042f79b55e9fc0837978705b435c9fd3ce9b986c7946a27c3b7b9e3b79c';
