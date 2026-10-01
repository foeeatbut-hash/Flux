/** Проверка проводится главным процессом; renderer не задаёт сервер, токен или лицензию. */
export function createLocalFileAccess(deps: {
  server: () => string; token: (origin: string) => string;
  fetch: typeof globalThis.fetch;
}) {
  let cached: { token: string; origin: string; until: number; read: boolean; write: boolean } | null = null;
  const check = async (write: boolean): Promise<boolean> => {
    try {
      const origin = new URL(deps.server() || 'http://localhost:3000').origin;
      if (!/^https?:/.test(origin)) return false;
      const token = deps.token(origin);
      if (!token) { cached = null; return false; }
      if (!write && cached?.origin === origin && cached.token === token && cached.until > Date.now()) return cached.read;
      const get = async (path: string) => {
        const response = await deps.fetch(origin + path, { headers: { Authorization: `Bearer ${token}` },
          redirect: 'error', signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error('Недоступна сессия Flux.');
        return response.json();
      };
      const [identity, license] = await Promise.all([get('/api/auth/me'), get('/api/license/me')]);
      const active = !!identity.user?.id && identity.user?.isActive !== false;
      const result = { token, origin, until: Date.now() + 2000,
        read: active && (license.licensed === true || license.readOnly === true),
        write: active && license.licensed === true };
      cached = result;
      return write ? result.write : result.read;
    } catch { cached = null; return false; }
  };
  return { mayRead: () => check(false), mayWrite: () => check(true) };
}
