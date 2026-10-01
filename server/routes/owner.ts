import type { Express, Request } from 'express';
import crypto from 'crypto';
import { getPrisma, onDatabaseSwapped } from '../context.js';
import { OWNER_PUBLIC_KEY_HEX, OWNER_BACKUP_PUBLIC_KEY_HEX } from '../../license/ownerKey.js';
import { OwnerChallenges } from '../ownerAuth.js';
import { isLoopbackAddress } from '../accessPolicy.js';
import { loginWait, loginFailed, loginSucceeded, LOGIN_REFUSED } from '../security.js';

const OWNER_ID = 'flux-owner';
const OWNER_SYMBOL = 'flux.owner';
let installation: Promise<string> | null = null;
onDatabaseSwapped(() => { installation = null; });

/** Тот же идентификатор используют лицензии; фиксированный id устраняет дубли при старте. */
export async function ownerInstallationId(): Promise<string> {
  if (!installation) installation = (async () => {
    const prisma = getPrisma();
    const found = await prisma.appSetting.findFirst({ where: { key: 'license.install_id', userId: null } });
    if (found?.value) return found.value;
    const id = 'flux-license-install-id';
    const row = await prisma.appSetting.upsert({ where: { id }, update: {}, create: { id, key: 'license.install_id', userId: null, value: crypto.randomUUID() } });
    return row.value;
  })().catch(e => { installation = null; throw e; });
  return installation;
}

const originOf = (req: Request): string => {
  // HTTPS-прокси на этом же сервере передает схему; удаленным заголовкам не доверяем.
  const forwarded = req.get('x-forwarded-proto');
  const protocol = isLoopbackAddress(String(req.socket.remoteAddress || '')) && ['http', 'https'].includes(String(forwarded)) ? forwarded : req.protocol;
  return `${protocol}://${String(req.get('host') || '').toLowerCase()}`;
};

export function registerOwnerRoutes(app: Express, deps: { issueAuthToken: (id: string) => string | Promise<string>; invalidateAuthUser?: (id?: string) => void }): void {
  // Проверочный ключ доступен исключительно серверу из исходников, не server.cjs.
  const testKey = /\.ts$/.test(__filename) && process.env.FLUX_TEST_OWNER === '1'
    ? 'ff87c9c4d4120c329064237c9ac0502540d0297406dd5e1118c11bfa66fd5340' : '';
  const keys = [OWNER_PUBLIC_KEY_HEX, OWNER_BACKUP_PUBLIC_KEY_HEX, testKey];
  const challenges = new OwnerChallenges(keys);
  const challengeRequests = new Map<string, { at: number; count: number }>();
  app.get('/api/owner/challenge', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!keys.some(k => /^[a-f0-9]{64}$/i.test(k))) return res.status(503).json({ error: 'Открытые ключи владельца еще не установлены в сборке' });
    const addr = String(req.socket.remoteAddress || '');
    if (loginWait('owner', addr) > 0) return res.status(429).json({ error: 'Слишком много попыток. Повторите позже.' });
    const now = Date.now();
    for (const [ip, window] of challengeRequests) if (now - window.at >= 60_000) challengeRequests.delete(ip);
    const window = challengeRequests.get(addr) || { at: now, count: 0 };
    if (window.count >= 10 || challengeRequests.size >= 1000 && !challengeRequests.has(addr)) return res.status(429).json({ error: 'Слишком много запросов входа. Повторите через минуту.' });
    window.count++; challengeRequests.set(addr, window);
    try { res.json(challenges.issue(await ownerInstallationId(), originOf(req))); }
    catch (_) { res.status(503).json({ error: 'База временно недоступна. Вход владельца доступен после восстановления подключения.' }); }
  });
  app.post('/api/owner/login', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const addr = String(req.socket.remoteAddress || '');
    if (loginWait('owner', addr) > 0) return res.status(429).json({ error: 'Слишком много попыток. Повторите позже.' });
    try {
      if (!challenges.verify(req.body?.nonce, req.body?.sig, await ownerInstallationId(), originOf(req))) {
        loginFailed('owner', addr);
        return res.status(401).json({ success: false, message: LOGIN_REFUSED });
      }
      // Один профиль независимо от количества ключей и параллельных первых входов.
      const user = await getPrisma().user.upsert({ where: { id: OWNER_ID },
        update: { role: 'OWNER', password: '', isActive: true, validUntil: null, lastLoginAt: new Date() },
        create: { id: OWNER_ID, symbol: OWNER_SYMBOL, name: 'Владелец Flux', role: 'OWNER', password: '', isActive: true, validUntil: null, lastLoginAt: new Date() },
      });
      loginSucceeded('owner');
      deps.invalidateAuthUser?.(user.id);
      const { password: _password, ...safeUser } = user;
      const legacy = await getPrisma().user.findFirst({ where: { symbol: 'RaupovKhKh', role: 'ADMIN' }, select: { id: true, symbol: true } });
      res.json({ success: true, user: { ...safeUser, rolePermissions: '{}' }, token: await deps.issueAuthToken(user.id), legacyAdministrator: legacy });
    } catch (_) { res.status(503).json({ error: 'Не удалось подключиться к базе. Повторите вход после восстановления подключения.' }); }
  });
}
