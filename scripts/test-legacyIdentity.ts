import {
  isLegacyBootstrapAdmin,
  LEGACY_BOOTSTRAP_SYMBOL_DIGEST,
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

console.log(`✓ ${passed} проверок legacyIdentity`);
