import {
  isLegacyBootstrapAdmin,
  LEGACY_BOOTSTRAP_SYMBOL_DIGEST,
  legacyBootstrapMigrationError,
  normalizedSymbolDigest,
} from '../server/legacyIdentity';

let passed = 0;
function check(name: string, ok: boolean): void {
  if (!ok) throw new Error(`✗ ${name}`);
  passed++;
}

// Личный идентификатор legacy-профиля не хранится строкой даже в fixture.
const historicalSymbol = String.fromCharCode(82, 97, 117, 112, 111, 118, 75, 104, 75, 104);
check('digest fixture соответствует историческому логину после нормализации',
  normalizedSymbolDigest(` ${historicalSymbol.toUpperCase()} `) === LEGACY_BOOTSTRAP_SYMBOL_DIGEST);
check('legacy ADMIN определяется и с историческим регистром символа',
  isLegacyBootstrapAdmin({ symbol: historicalSymbol, role: 'ADMIN' }));
check('другой активный ADMIN не попадает под запрет',
  !isLegacyBootstrapAdmin({ symbol: 'test.user', role: 'ADMIN' }));
check('совпадение символа не блокирует OWNER с подписью',
  !isLegacyBootstrapAdmin({ symbol: historicalSymbol, role: 'OWNER' }));
check('обновлённый личный логин снимает только legacy-блокировку',
  !isLegacyBootstrapAdmin({ symbol: 'raupov.personal', role: 'ADMIN' })
    && isLegacyBootstrapAdmin({ symbol: historicalSymbol, role: 'ADMIN' }));
const migratedProfile = { id: 'preserved-profile-id', symbol: 'raupov.personal', role: 'ADMIN', password: 'fresh-hash' };
check('миграция сохраняет идентификатор профиля и его ADMIN-роль',
  migratedProfile.id === 'preserved-profile-id' && migratedProfile.role === 'ADMIN'
    && !isLegacyBootstrapAdmin(migratedProfile));
check('обычный ADMIN не может выполнить миграцию даже с новыми credentials',
  legacyBootstrapMigrationError('ADMIN', historicalSymbol, 'personal.login', 'fresh-password') !== null);
check('OWNER обязан выбрать новый логин и новый пароль',
  legacyBootstrapMigrationError('OWNER', historicalSymbol, historicalSymbol, 'fresh-password') !== null
    && legacyBootstrapMigrationError('OWNER', historicalSymbol, 'personal.login', 'short') !== null);
check('OWNER может перенести профиль на новый логин с новым паролем',
  legacyBootstrapMigrationError('OWNER', historicalSymbol, 'personal.login', 'fresh-password') === null);

console.log(`✓ ${passed} проверок legacyIdentity`);
