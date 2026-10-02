/** Открытые Ed25519-ключи входа владельца. Закрытые половины живут вне сборки.
 * Пустые значения запрещают вход; запасной ключ хранится офлайн отдельно. */
export const OWNER_PUBLIC_KEY_HEX = 'd39efc6215dde756750af48698640b3db90b6e467008ff24edccc950ec038e8b';
export const OWNER_BACKUP_PUBLIC_KEY_HEX = 'da6383133d9bca147c88a56a831baf43a4068579f396a57760ff87e31e8351d0';
/** Лицензии подписывает отдельный ключ: вход владельца им не разрешается. */
export const LICENSE_SIGNING_PUBLIC_KEY_HEX = '2861f72b18f75c4562b8967fb6a9e0316a900329189f4362f68acc497fc046bb';
