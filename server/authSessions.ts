import crypto from 'node:crypto';
import type { Express } from 'express';
import { getPrisma, onDatabaseSwapped } from './context.js';
import { authTokenFromRequest, createCookieAuth } from './authCookies.js';
import { isLegacyBootstrapAdmin, LEGACY_BOOTSTRAP_REFUSAL } from './legacyIdentity.js';
import { recordServerError } from './diagnostics.js';
import { positionPermissionsString } from './positionPermissions.js';
import { extraPositionCodes, primaryPositionCode } from '../shared/positions.js';

/** Отказ выдать сессию по существу (профиль отключён, вход только по ключу): его текст можно показать человеку. */
export class SessionRefused extends Error { constructor(message: string) { super(message); this.name = 'SessionRefused'; } }
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
interface Claims { v: 2; uid: string; iat: number; exp: number; stamp: string; sid: string }
interface SessionDeps { secret: string; getUser?: (id: string) => Promise<any> }

/** Имя, аватар и последний вход сессию не отзывают; изменения прав и пароля — отзывают. */
export function credentialStamp(user: any, rolePermissions: string | null = null): string {
  const until = user?.validUntil ? new Date(user.validUntil).toISOString() : null;
  // Должности добавляются в штамп, только если записаны: у профилей до их
  // появления штамп прежний, и обновление программы не закрывает сессии. Смена
  // основной или дополнительной должности штамп меняет и сессию отзывает.
  const positions = user?.positionCode || user?.extraPositions ? [user.positionCode ?? null, user.extraPositions ?? null] : [];
  return crypto.createHash('sha256').update(JSON.stringify([user?.id, user?.password, user?.role, user?.isActive !== false, until, user?.permissions || null, rolePermissions, ...positions])).digest('base64url');
}
function signature(payload: string, secret: string): string { return crypto.createHmac('sha256', secret).update(payload).digest('base64url'); }
function same(a: string, b: string): boolean { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && crypto.timingSafeEqual(left, right); }
export function sessionClaims(token: string, secret: string, now = Date.now()): Claims | null {
  try {
    if (token.length > 2048) return null;
    const parts = token.split('.');
    if (parts.length !== 2 || !same(signature(parts[0], secret), parts[1])) return null;
    const c = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (c?.v !== 2 || typeof c.uid !== 'string' || !c.uid || typeof c.stamp !== 'string' || typeof c.sid !== 'string' || c.sid.length !== 32) return null;
    if (!Number.isFinite(c.iat) || !Number.isFinite(c.exp) || c.iat > now + 30000 || c.exp <= now || c.exp - c.iat > SESSION_TTL_MS || c.exp <= c.iat) return null;
    return c;
  } catch (_) { return null; }
}
/**
 * Права должностей одним запросом на всех, а не по запросу на каждую: на пакет
 * сокета проверка шла 3 запроса и ещё по одному на каждую дополнительную
 * должность. Кэша нет намеренно — снятое право действует сразу, в том числе
 * на втором сервере той же базы.
 */
async function rolePermissions(user: any): Promise<string | null> {
  if (!user?.role || user.role === 'OWNER') return null;
  const codes = [...new Set([primaryPositionCode(user) ?? String(user.role), ...extraPositionCodes(user)])];
  const found = await getPrisma().role.findMany({ where: { code: { in: codes } }, select: { code: true, permissions: true } });
  const byCode = new Map<string, string | null>(found.map((r: any) => [String(r.code), r.permissions || null]));
  return positionPermissionsString(user, async (code) => byCode.get(code) ?? null);
}
// Ключ строки отзыва содержит хеш сессии: пара (key, userId) в AppSetting
// уникальна, и общий ключ делал второй выход одного человека ошибкой P2002 —
// отзыв не доходил до базы и жил только в памяти процесса.
const REVOKED_PREFIX = 'auth.session.revoked';
const revocationId = (c: Claims) => `${REVOKED_PREFIX}.${crypto.createHash('sha256').update(c.sid).digest('hex')}`;
/** Запись отзыва нужна, пока жива сама сессия; запас часа на расхождение часов серверов. */
const REVOCATION_KEEP_MS = SESSION_TTL_MS + 60 * 60 * 1000;
const CLEANUP_EVERY_MS = 10 * 60 * 1000;

/** Проверка подписи остаётся синхронной для раннего шлюза тела, права сверяются отдельно. */
export function createAuthSessions(deps: SessionDeps) {
  const getUser = deps.getUser || ((id: string) => getPrisma().user.findUnique({ where: { id } }));
  // Локальный HMAC-секрет доступен владельцу компьютера. Одной его подписи
  // недостаточно для OWNER: нужен вход по Ed25519 и выданная здесь сессия.
  const ownerGrants = new Map<string, { token: string; exp: number }>();
  const localRevocations = new Map<string, number>();
  const pendingRevocations = new Map<string, Claims>();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let flushing = false;
  let databaseGeneration = 0;
  const locallyRevoked = (claims: Claims) => {
    for (const [sid, exp] of localRevocations) if (exp <= Date.now()) localRevocations.delete(sid);
    return localRevocations.has(claims.sid);
  };
  let lastCleanup = 0;
  /** Просроченные записи отзыва (в том числе прежние, с общим ключом) не копятся в общей базе. */
  const cleanupRevocations = async () => {
    const nowMs = Date.now();
    if (nowMs - lastCleanup < CLEANUP_EVERY_MS) return;
    lastCleanup = nowMs;
    try {
      await getPrisma().appSetting.deleteMany({ where: { key: { startsWith: REVOKED_PREFIX }, updatedAt: { lt: new Date(nowMs - REVOCATION_KEEP_MS) } } });
    } catch (error) { lastCleanup = 0; recordServerError('auth.revocations.cleanup', error); }
  };
  const writeRevocation = async (c: Claims) => {
    const row = await getPrisma().appSetting.upsert({ where: { id: revocationId(c) },
      create: { id: revocationId(c), key: revocationId(c), value: JSON.stringify({ until: c.exp }), userId: c.uid }, update: {} });
    void cleanupRevocations();
    return row;
  };
  const scheduleRetry = () => {
    if (retryTimer || !pendingRevocations.size) return;
    retryTimer = setTimeout(() => { retryTimer = null; void flushRevocations(); }, 10000);
    retryTimer.unref?.();
  };
  const flushRevocations = async () => {
    if (flushing) return;
    flushing = true;
    const generation = databaseGeneration;
    try {
      for (const [sid, c] of [...pendingRevocations].slice(0, 100)) {
        if (generation !== databaseGeneration) break;
        if (c.exp <= Date.now()) { pendingRevocations.delete(sid); continue; }
        try { await writeRevocation(c); if (generation === databaseGeneration) pendingRevocations.delete(sid); }
        catch (error) { recordServerError('auth.logout.retry', error); break; }
      }
    } finally { flushing = false; scheduleRetry(); }
  };
  onDatabaseSwapped(() => {
    databaseGeneration++;
    // Локальные отзывы остаются (ключ — sid, срок не больше 8 ч): сессия, выход
    // из которой не успел попасть в базу, не оживает после смены базы. Очередь
    // недописанных отзывов уходит в НОВУЮ базу.
    ownerGrants.clear();
    lastCleanup = 0;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    scheduleRetry();
  });
  const ownerConfirmed = (token: string, claims: Claims) => {
    const grant = ownerGrants.get(claims.sid);
    if (grant && grant.exp <= Date.now()) ownerGrants.delete(claims.sid);
    return !!grant && grant.exp > Date.now() && same(grant.token, token);
  };
  const issueSession = async (userId: string, owner: boolean): Promise<string> => {
    const user = await getUser(userId);
    if (!user || user.isActive === false) throw new SessionRefused('Профиль недоступен');
    if (isLegacyBootstrapAdmin(user)) throw new SessionRefused(LEGACY_BOOTSTRAP_REFUSAL);
    if ((user.role === 'OWNER') !== owner) throw new SessionRefused('Для владельца требуется вход по ключу');
    const now = Date.now();
    for (const [sid, grant] of ownerGrants) if (grant.exp <= now) ownerGrants.delete(sid);
    if (owner && ownerGrants.size >= 1000) throw new Error('Достигнут предел активных входов владельца');
    const claims: Claims = { v: 2, uid: userId, iat: now, exp: now + SESSION_TTL_MS, stamp: credentialStamp(user, await rolePermissions(user)), sid: crypto.randomBytes(16).toString('hex') };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const token = `${payload}.${signature(payload, deps.secret)}`;
    if (owner) ownerGrants.set(claims.sid, { token, exp: claims.exp });
    return token;
  };
  const issue = (userId: string) => issueSession(userId, false);
  // Передаётся только маршруту с уже проверенным одноразовым вызовом владельца.
  const issueOwner = (userId: string) => issueSession(userId, true);
  const verify = (token: string): string | null => {
    const c = sessionClaims(token, deps.secret);
    if (!c || locallyRevoked(c) || (c.uid === 'flux-owner' && !ownerConfirmed(token, c))) return null;
    return c.uid;
  };
  // Пакеты одной сессии, пришедшие пока идёт проверка, ждут её результата, а не
  // начинают свою: всплеск office:y-* давал по 3 запроса на каждый пакет.
  // Результат не переживает проверку, поэтому отзыв по-прежнему действует сразу.
  const inflight = new Map<string, Promise<any | null>>();
  const checkSession = async (token: string, c: Claims): Promise<any | null> => {
    // Не кэшируем: два сервера на одной БД должны одновременно прекратить
    // принимать сессию после смены пароля, снятия права или выхода.
    const [user, revoked] = await Promise.all([getUser(c.uid), getPrisma().appSetting.findUnique({ where: { id: revocationId(c) }, select: { id: true } })]);
    if (!user || revoked || user.isActive === false || isLegacyBootstrapAdmin(user) || (user.role !== 'OWNER' && user.validUntil && new Date(user.validUntil).getTime() < Date.now())) return null;
    if (user.role === 'OWNER' && !ownerConfirmed(token, c)) return null;
    if (!same(c.stamp, credentialStamp(user, await rolePermissions(user)))) return null;
    return user;
  };
  const validate = async (token: string): Promise<any | null> => {
    const c = sessionClaims(token, deps.secret);
    if (!c) return null;
    if (locallyRevoked(c)) return null;
    const key = `${databaseGeneration}:${token}`;
    const running = inflight.get(key);
    if (running) return running;
    const started = checkSession(token, c).finally(() => inflight.delete(key));
    inflight.set(key, started);
    return started;
  };
  const revoke = async (token: string): Promise<boolean> => {
    const c = sessionClaims(token, deps.secret);
    if (!c) return false;
    // Reject replay on this process even if durable revocation is temporarily unavailable.
    locallyRevoked(c);
    // При переполнении вытесняем самую раннюю запись, а не отказываем: отказ
    // оставлял сессию неотозванной вовсе, тогда как отзыв в базу пишется всегда.
    if (localRevocations.size >= 10000 && !localRevocations.has(c.sid)) {
      const oldest = localRevocations.keys().next().value;
      if (oldest !== undefined) localRevocations.delete(oldest);
    }
    localRevocations.set(c.sid, c.exp);
    ownerGrants.delete(c.sid);
    try { await writeRevocation(c); pendingRevocations.delete(c.sid); }
    catch (error) { pendingRevocations.set(c.sid, c); scheduleRetry(); throw error; }
    return true;
  };
  return { issue, issueOwner, verify, validate, revoke, flushRevocations };
}

/** Выход отзывает именно эту сессию, остальные окна/машины продолжают работу. */
export function registerSessionRoutes(app: Express, sessions: ReturnType<typeof createAuthSessions>, cookies?: ReturnType<typeof createCookieAuth>): void {
  app.get('/api/auth/me', async (req: any, res) => {
    if (!req.authUser?.id) return res.status(401).json({ error: 'Требуется вход' });
    const { password: _password, ...user } = req.authUser;
    user.rolePermissions = await rolePermissions(req.authUser);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ user });
  });
  app.post('/api/logout', async (req: any, res) => {
    try {
      const token = authTokenFromRequest(req);
      if (!req.authUser?.id || sessions.verify(token) !== req.authUser.id) return res.status(401).json({ error: 'Требуется вход' });
      await sessions.revoke(token);
      cookies?.clear(req, res);
      res.json({ success: true });
    } catch (error) {
      cookies?.clear(req, res);
      recordServerError('auth.logout', error);
      res.status(503).json({ error: 'Выход выполнен на этом компьютере. Общая база временно недоступна.', localLogout: true });
    }
  });
}
