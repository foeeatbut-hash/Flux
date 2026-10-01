/** Настройка до входа нужна встроенному серверу, выгрузка всех данных — нет. */
const LOCAL_SETUP = new Set(['/api/db/config', '/api/db/test', '/api/db/switch', '/api/db/save']);

export const isLoopbackAddress = (ip: string): boolean =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);

export function allowsLocalSetup(route: string, ip: string, origin?: string, host?: string): boolean {
  if (!LOCAL_SETUP.has(route) || !isLoopbackAddress(ip)) return false;
  // Одного адреса соединения мало: чужой домен может указывать на loopback (DNS rebinding).
  try {
    if (!host || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(`http://${host}`).hostname)) return false;
  } catch (_) { return false; }
  // Чужая страница в браузере не должна перенастраивать локальную программу.
  if (!origin) return true;
  try { return new URL(origin).host === host; } catch (_) { return false; }
}

export function requiresAdministrator(route: string): boolean {
  return /^\/api\/(db(?:\/|$)|backup(?:\/|$)|seed\/?$|config\/logs\/?$)/i.test(route);
}

/** Эти операции меняют доверие ко всей установке, а не рабочие данные. */
export function requiresOwner(route: string, method = 'GET'): boolean {
  const path = route.toLowerCase().replace(/\/+$/, '');
  return /^\/api\/db(?:\/|$)/.test(path)
    || /^\/api\/(seed|admin\/sync-schema|config\/logs|backup\/settings)$/.test(path)
    || (path.startsWith('/api/updates') && !['GET', 'HEAD'].includes(method.toUpperCase()))
    || (path.startsWith('/api/roles') && !['GET', 'HEAD'].includes(method.toUpperCase()));
}

export function isPrivilegedUser(user: { role?: string } | null | undefined): boolean {
  return user?.role === 'OWNER' || user?.role === 'ADMIN';
}

/** Права администратора выдает лично владелец, роль и неизвестное право их не расширяют. */
export function administratorPermission(user: any, feature: string, now = Date.now()): boolean {
  if (user?.role === 'OWNER') return true;
  if (user?.role !== 'ADMIN' || user.isActive === false || (user.validUntil && !(new Date(user.validUntil).getTime() >= now))) return false;
  try {
    const map = typeof user.permissions === 'string' ? JSON.parse(user.permissions) : user.permissions;
    const e = map?.[feature];
    return e?.enabled === true && e.mode !== 'DENY' && (!e.until || new Date(e.until).getTime() >= now);
  } catch (_) { return false; }
}

/** Дополнительный локальный предохранитель: маршруты защищены и без общего middleware. */
export const requireOwnerMiddleware = (req: any, res: any, next: () => void): any => {
  if (req.authUser?.role !== 'OWNER') return res.status(403).json({ error: 'Доступно только владельцу программы' });
  next();
};
