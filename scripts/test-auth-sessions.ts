/** Сессии проверяются с изолированными таблицами пользователя, роли и отзыва. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setPrisma } from '../server/context';
import { createAuthSessions, sessionClaims, credentialStamp, SESSION_TTL_MS } from '../server/authSessions';

let checks = 0;
const check = (name: string, value: unknown) => { assert.ok(value, name); checks++; console.log('✓', name); };

const users = new Map<string, any>([['u1', { id: 'u1', password: 'hash-1', role: 'ENGINEER', isActive: true, validUntil: null, permissions: null }]]);
const roles = new Map<string, string | null>([['ENGINEER', '{"project.manage":{"enabled":true}}']]);
const settings = new Map<string, any>();
setPrisma({
  role: { findUnique: async ({ where }: any) => roles.has(where.code) ? { permissions: roles.get(where.code) } : null },
  appSetting: {
    findUnique: async ({ where }: any) => settings.get(where.id) || null,
    upsert: async ({ where, create }: any) => { if (!settings.has(where.id)) settings.set(where.id, create); return settings.get(where.id); },
  },
});

const sessions = createAuthSessions({ secret: 'test-only-session-secret', getUser: async id => users.get(id) || null });

(async () => {
  const token = await sessions.issue('u1');
  check('подписанная сессия проходит раннюю проверку', sessions.verify(token) === 'u1');
  check('подписанная сессия возвращает текущий профиль', (await sessions.validate(token))?.id === 'u1');
  check('изменённая подпись отвергается', sessions.verify(`${token.slice(0, -1)}x`) === null);
  check('слишком длинный токен отвергается', sessionClaims(`${'x'.repeat(2049)}`, 'test-only-session-secret') === null);

  users.set('u1', { ...users.get('u1'), name: 'Новое имя', avatar: 'новый аватар', lastLoginAt: new Date() });
  check('изменение имени, аватара и входа не отзывает сессию', !!(await sessions.validate(token)));

  roles.set('ENGINEER', '{"project.manage":{"enabled":false}}');
  check('изменение прав роли отзывает сессию', (await sessions.validate(token)) === null);
  roles.set('ENGINEER', '{"project.manage":{"enabled":true}}');
  const second = await sessions.issue('u1');
  users.set('u1', { ...users.get('u1'), password: 'hash-2' });
  check('смена пароля отзывает сессию', (await sessions.validate(second)) === null);

  users.set('u1', { ...users.get('u1'), password: 'hash-3' });
  const third = await sessions.issue('u1');
  check('выход отзывает только выбранную сессию', await sessions.revoke(third) && (await sessions.validate(third)) === null);
  check('отзыв сессии не блокирует другую сессию того же пользователя', !!(await sessions.validate(await sessions.issue('u1'))));

  users.set('u1', { ...users.get('u1'), isActive: false });
  await assert.rejects(() => sessions.issue('u1'), /Профиль недоступен/);
  check('деактивированному профилю нельзя выдать сессию', true);
  const owner = { id: 'flux-owner', password: '', role: 'OWNER', isActive: true, validUntil: null };
  users.set(owner.id, owner);
  await assert.rejects(() => sessions.issue(owner.id), /вход по ключу/);
  check('обычная выдача сессии не авторизует владельца', true);
  const forge = (claims: any) => {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${payload}.${crypto.createHmac('sha256', 'test-only-session-secret').update(payload).digest('base64url')}`;
  };
  const now = Date.now();
  const forged = forge({ v: 2, uid: owner.id, iat: now, exp: now + SESSION_TTL_MS, stamp: credentialStamp(owner), sid: 'a'.repeat(32) });
  check('знание локального HMAC-секрета не создаёт OWNER сессию', sessions.verify(forged) === null && await sessions.validate(forged) === null);
  const ownerToken = await sessions.issueOwner(owner.id);
  check('вход по проверенному ключу выдаёт рабочую сессию владельца', sessions.verify(ownerToken) === owner.id && (await sessions.validate(ownerToken))?.role === 'OWNER');
  const ownerClaims = sessionClaims(ownerToken, 'test-only-session-secret')!;
  const altered = forge({ ...ownerClaims, iat: ownerClaims.iat + 1, exp: ownerClaims.exp + 1 });
  check('подпись HMAC с известным SID не меняет выданный OWNER токен', sessions.verify(altered) === null && await sessions.validate(altered) === null);
  const restarted = createAuthSessions({ secret: 'test-only-session-secret', getUser: async id => users.get(id) || null });
  check('новый локальный процесс требует повторного входа владельца по ключу', await restarted.validate(ownerToken) === null);
  await sessions.revoke(ownerToken);
  settings.clear();
  check('удаление отзыва из БД не восстанавливает отозванный OWNER токен', await sessions.validate(ownerToken) === null);
  const activeOwner = await sessions.issueOwner(owner.id);
  setPrisma({ role: { findUnique: async () => null }, appSetting: { findUnique: async () => null } });
  check('смена базы сбрасывает подтверждение входа владельца', await sessions.validate(activeOwner) === null);
  console.log(`${checks} проверок пройдено`);
})().catch(err => { console.error(err); process.exitCode = 1; });
