import crypto from 'node:crypto';

// Совместимость с прежним установочным логином определяется только digest,
// чтобы исходный идентификатор не хранился в исполняемом коде.
export const LEGACY_BOOTSTRAP_SYMBOL_DIGEST = '5326414bd34894b18c77f577d105a46cc6dc3fd5f6fe1fe7b71b8548f9ba4ed0';
export const LEGACY_BOOTSTRAP_REFUSAL = 'Эта начальная учётная запись отключена. Войдите с ключом владельца и создайте личный профиль администратора.';

export function normalizedSymbolDigest(symbol: unknown): string {
  return crypto.createHash('sha256').update(String(symbol ?? '').trim().toLowerCase(), 'utf8').digest('hex');
}

export function isLegacyBootstrapAdmin(user: { symbol?: unknown; role?: unknown } | null | undefined): boolean {
  return user?.role === 'ADMIN' && normalizedSymbolDigest(user.symbol) === LEGACY_BOOTSTRAP_SYMBOL_DIGEST;
}

/** Requirements for an owner-mediated credential migration of the blocked profile. */
export function legacyBootstrapMigrationError(actorRole: unknown, oldSymbol: unknown, symbol: unknown, password: unknown): string | null {
  if (actorRole !== 'OWNER') return 'Перенести начальный профиль может только владелец Flux';
  const next = String(symbol ?? '').trim();
  if (!next || next.toLowerCase() === String(oldSymbol ?? '').trim().toLowerCase()) return 'Для переноса укажите новый личный логин';
  if (typeof password !== 'string' || password.trim().length < 8) return 'Для переноса задайте новый пароль длиной не менее 8 символов';
  return null;
}
