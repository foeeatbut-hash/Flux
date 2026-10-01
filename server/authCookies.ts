import crypto from 'node:crypto';
import type { Request, Response, RequestHandler } from 'express';

export const AUTH_COOKIE = 'flux_session';
export const CSRF_COOKIE = 'flux_csrf';
const MAX_AGE = 8 * 60 * 60 * 1000;

export function requestCookie(req: { headers: any }, name: string): string {
  const raw = String(req.headers?.cookie || '');
  for (const part of raw.split(';')) {
    const at = part.indexOf('=');
    if (part.slice(0, at).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(at + 1).trim()); } catch { return ''; }
  }
  return '';
}
/** Explicit bearer takes precedence: embedded Office keeps its own transport. */
export function authTokenFromRequest(req: { headers: any }): string {
  const header = String(req.headers?.authorization || '');
  if (header) return /^Bearer\s+([^\s]+)$/i.exec(header)?.[1] || '';
  return requestCookie(req, AUTH_COOKIE);
}
function same(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function csrfSignature(nonce: string, token: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(`flux-csrf-v1\0${token}\0${nonce}`).digest('base64url');
}
export function validCsrf(value: string, token: string, secret: string): boolean {
  const parts = value.split('.');
  return parts.length === 2 && /^[a-f0-9]{48}$/.test(parts[0]) && same(parts[1], csrfSignature(parts[0], token, secret));
}
export function createCookieAuth(secret: string) {
  const options = (req: Request) => ({ path: '/', httpOnly: true, sameSite: 'lax' as const, secure: req.secure, maxAge: MAX_AGE });
  const issue = (req: Request, res: Response, token: string) => {
    const nonce = crypto.randomBytes(24).toString('hex');
    const csrf = `${nonce}.${csrfSignature(nonce, token, secret)}`;
    res.cookie(AUTH_COOKIE, token, options(req));
    res.cookie(CSRF_COOKIE, csrf, { ...options(req), httpOnly: false, sameSite: 'strict' });
    res.setHeader('Cache-Control', 'no-store');
  };
  const clear = (req: Request, res: Response) => {
    res.clearCookie(AUTH_COOKIE, { ...options(req), maxAge: undefined });
    res.clearCookie(CSRF_COOKIE, { ...options(req), maxAge: undefined, httpOnly: false, sameSite: 'strict' });
    res.setHeader('Cache-Control', 'no-store');
  };
  const middleware: RequestHandler = (req, res, next) => {
    const cookie = requestCookie(req, AUTH_COOKIE);
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (cookie && !req.headers.authorization && mutation) {
      const csrf = requestCookie(req, CSRF_COOKIE);
      const header = String(req.headers['x-flux-csrf'] || '');
      if (!csrf || !same(csrf, header) || !validCsrf(csrf, cookie, secret)) {
        res.status(403).json({ error: 'Проверка безопасности сессии не пройдена. Обновите страницу.' }); return;
      }
    }
    if (req.path === '/api/login' || req.path === '/api/owner/login') {
      const transport = String(req.headers['x-flux-auth-transport'] || '');
      if (transport === 'cookie') {
        // A custom header cannot be sent by a cross-site HTML form. Reject an
        // explicitly foreign Origin as well, even if CORS was configured broadly.
        const origin = req.headers.origin;
        if (origin && origin !== `${req.protocol}://${req.get('host')}`) {
          res.status(403).json({ error: 'Вход с другого сайта запрещён.' }); return;
        }
        const json = res.json.bind(res);
        res.json = ((body: any) => {
          if (res.statusCode < 400 && body?.success && typeof body.token === 'string') {
            issue(req, res, body.token);
            const { token: _token, ...safe } = body;
            return json(safe);
          }
          return json(body);
        }) as typeof res.json;
      }
    }
    next();
  };
  return { issue, clear, middleware };
}
