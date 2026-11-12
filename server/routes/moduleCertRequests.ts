/**
 * Запросы разработчиков на сертификат: «вот мой открытый ключ, выдайте сертификат».
 *
 * Разработчик из Studio присылает ключ (и как себя назвать); профиль сервер берёт из входа,
 * а не из тела запроса. Владелец видит очередь в Studio — Владелец, выдаёт сертификат
 * (подпись ставит он, `POST /api/modules/certificates`) или отклоняет запрос. Запрос ничего
 * не разрешает сам по себе: до подписи владельца у ключа нет сертификата.
 */
import type { Express, Request, Response } from 'express';
import { requireOwnerMiddleware } from '../accessPolicy.js';

const KEY = /^[0-9a-f]{64}$/;
const ROW = 'module.certRequest';
const MAX_PENDING = 500;
/** Ожидающих запросов от одного профиля: один разработчик не должен занять всю очередь */
const MAX_PER_PROFILE = 3;
const rowId = (key: string) => `${ROW}:${key}`;
const valueOf = (row: any) => { try { return JSON.parse(row.value); } catch { return null; } };

export interface CertRequestDeps {
  getPrisma: () => any;
  broadcast: (event: string, payload: unknown) => void;
  can?: (user: any, feature: string) => boolean;
}

/** Запрос закрыт: сертификат выдан (вызывается из выдачи) */
export async function closeCertRequest(db: any, key: string): Promise<void> {
  await db.appSetting.deleteMany({ where: { id: rowId(key) } });
}

export function registerCertRequestRoutes(app: Express, deps: CertRequestDeps): void {
  app.post('/api/modules/certificate-requests', async (req: Request, res: Response) => {
    const user = (req as any).authUser;
    if (!user?.id || !(user.role === 'OWNER' || (deps.can && deps.can(user, 'module.develop')))) {
      return res.status(403).json({ error: 'Просить сертификат могут только разработчики: нужно право «Разработка программ».' });
    }
    const key = String(req.body?.key || '').trim().toLowerCase();
    if (!KEY.test(key)) return res.status(400).json({ error: 'Укажите открытый ключ разработчика (64 знака hex).' });
    const db = deps.getPrisma();
    if (await db.moduleCertificate.findUnique({ where: { keyHex: key } })) return res.status(409).json({ error: 'Для этого ключа сертификат уже выдан.' });
    const pending = await db.appSetting.findMany({ where: { key: ROW, userId: null }, take: MAX_PENDING + 1 });
    const existing = pending.find((row: any) => row.id === rowId(key));
    // Чужую ожидающую запись не перезаписываем: зная открытый ключ, подставить в неё свой профиль нельзя
    if (existing && valueOf(existing)?.userId !== String(user.id)) return res.status(409).json({ error: 'Запрос с этим ключом уже отправлен другим профилем.' });
    if (!existing) {
      const mine = pending.filter((row: any) => valueOf(row)?.userId === String(user.id)).length;
      if (mine >= MAX_PER_PROFILE) return res.status(429).json({ error: `У вас уже ${MAX_PER_PROFILE} ожидающих запроса на сертификат. Дождитесь решения владельца по ним: новый запрос можно отправить после выдачи или отказа.` });
      if (pending.length >= MAX_PENDING) return res.status(503).json({ error: 'Очередь запросов на сертификат у владельца переполнена. Попробуйте позже или напишите владельцу.' });
    }
    const value = JSON.stringify({ key, userId: String(user.id), name: String(req.body?.name || user.name || '').slice(0, 200), at: Date.now() });
    await db.appSetting.upsert({ where: { id: rowId(key) }, create: { id: rowId(key), key: ROW, userId: null, value }, update: { value } });
    deps.broadcast('modules:certificate-requests', { key });
    res.json({ ok: true });
  });

  app.get('/api/modules/certificate-requests', requireOwnerMiddleware, async (_req: Request, res: Response) => {
    const db = deps.getPrisma();
    const rows = (await db.appSetting.findMany({ where: { key: ROW, userId: null }, take: MAX_PENDING })).map(valueOf).filter(Boolean);
    const issued = new Set((await db.moduleCertificate.findMany({ select: { keyHex: true } })).map((c: any) => c.keyHex));
    res.json({ requests: rows.filter((r: any) => !issued.has(r.key)).sort((a: any, b: any) => b.at - a.at) });
  });

  app.post('/api/modules/certificate-requests/decline', requireOwnerMiddleware, async (req: Request, res: Response) => {
    const key = String(req.body?.key || '').trim().toLowerCase();
    if (!KEY.test(key)) return res.status(400).json({ error: 'Некорректный ключ.' });
    await closeCertRequest(deps.getPrisma(), key);
    res.json({ ok: true });
  });
}
