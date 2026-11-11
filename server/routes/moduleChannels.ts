/**
 * Каналы и откат модулей: кому виден тестовый канал, свои возможности
 * человека, подписанные владельцем назначения каналов (откат).
 *
 * Откат подписывает владелец (studio/owner/src/moduleSigning.ts): сервер только
 * сверяет подпись и раздаёт, а проверяет каждый Flux сам.
 */
import type { Express, Request, Response } from 'express';
import { requireOwnerMiddleware } from '../accessPolicy.js';
import { openEnvelope } from '../../modules/trust/envelope.js';
import { parsePinClaim, parseReleaseClaim, releaseKey } from '../../modules/trust/claims.js';
import { channelsFor, promotionsOf, saveTesters, testersOf } from '../moduleChannels.js';
import { parsePromotionClaim, readPromotions } from '../../modules/trust/promotion.js';
import { loadTrust, signatureHash } from '../moduleStore.js';

export interface ModuleChannelDeps {
  getPrisma: () => any;
  broadcast: (event: string, payload: unknown) => void;
  rootHex: () => string;
  can?: (user: any, feature: string) => boolean;
}

export function registerModuleChannelRoutes(app: Express, deps: ModuleChannelDeps): void {
  /** Что человеку можно: каналы, разработка, просьба о рабочем канале */
  app.get('/api/modules/me', async (req: Request, res: Response) => {
    const user = (req as any).authUser, owner = user?.role === 'OWNER';
    const can = (feature: string) => owner || (deps.can ? deps.can(user, feature) : false);
    res.json({ owner, channels: await channelsFor(deps.getPrisma(), user), develop: can('module.develop'), publish: can('module.publish') });
  });

  app.get('/api/modules/testers', requireOwnerMiddleware, async (_req: Request, res: Response) => {
    const db = deps.getPrisma();
    const users = await db.user.findMany({ where: { isActive: true }, select: { id: true, name: true, role: true }, orderBy: { name: 'asc' }, take: 2000 });
    res.json({ testers: await testersOf(db), users });
  });

  app.put('/api/modules/testers', requireOwnerMiddleware, async (req: Request, res: Response) => {
    const ids = Array.isArray(req.body?.testers) ? req.body.testers : null;
    if (!ids) return res.status(400).json({ error: 'Ожидался список тестировщиков' });
    // Только существующие профили: иначе в списке тестового канала накапливаются чужие и выдуманные идентификаторы
    if (ids.length > 5000 || ids.some((v: unknown) => typeof v !== 'string' || v.length > 80)) return res.status(400).json({ error: 'Список тестировщиков содержит неверные значения' });
    const known = new Set((await deps.getPrisma().user.findMany({ where: { id: { in: ids.filter(Boolean) } }, select: { id: true } })).map((u: any) => u.id));
    const unknown = ids.filter((id: string) => id && !known.has(id));
    if (unknown.length) return res.status(400).json({ error: `Неизвестные профили: ${unknown.slice(0, 5).join(', ')}` });
    const saved = await saveTesters(deps.getPrisma(), ids);
    deps.broadcast('modules:channels', {});
    res.json({ testers: saved });
  });

  app.get('/api/modules/promotions', async (_req: Request, res: Response) => {
    res.json({ promotions: readPromotions(await promotionsOf(deps.getPrisma()), deps.rootHex()).valid });
  });

  app.post('/api/modules/promotions', requireOwnerMiddleware, async (req: Request, res: Response) => {
    const db = deps.getPrisma(), signature = String(req.body?.signature || '').trim();
    const claim = parsePromotionClaim(openEnvelope('promotion', signature, deps.rootHex()));
    if (!claim) return res.status(400).json({ error: 'Нужна подпись назначения ключом владельца' });
    const release = await db.moduleRelease.findUnique({ where: { moduleId_version: { moduleId: claim.moduleId, version: claim.version } } });
    const signed = release && parseReleaseClaim(openEnvelope('release', release.signature, deps.rootHex()));
    if (!signed || signed.channel !== 'test' || signed.moduleId !== claim.moduleId || signed.version !== claim.version
      || signatureHash(release.signature) !== claim.releaseSignatureHash) return res.status(400).json({ error: 'Назначение не совпадает с подписанным выпуском' });
    const trust = await loadTrust(db, deps.rootHex());
    if (trust.revoked.releases.has(releaseKey(signed.moduleId, signed.version)) || trust.revoked.keys.has(signed.author))
      return res.status(409).json({ error: 'Выпуск или ключ его автора отозван' });
    try {
      await db.appSetting.create({ data: { id: `module-promotion-${signatureHash(signature)}`, key: 'modules.promotions', userId: null, value: signature } });
    } catch (e: any) {
      if (e?.code !== 'P2002') return res.status(503).json({ error: e?.message || 'Назначение не записано' });
    }
    deps.broadcast('modules:released', { moduleId: claim.moduleId, version: claim.version });
    res.json({ ok: true });
  });

  app.get('/api/modules/pins', async (_req: Request, res: Response) => {
    const rows = await deps.getPrisma().moduleChannelPin.findMany({ orderBy: { createdAt: 'asc' }, select: { signature: true }, take: 5000 });
    res.json({ pins: rows.map((r: any) => r.signature) });
  });

  app.post('/api/modules/pins', requireOwnerMiddleware, async (req: Request, res: Response) => {
    const db = deps.getPrisma(), signature = String(req.body?.signature || '').trim();
    const claim = parsePinClaim(openEnvelope('pin', signature, deps.rootHex()));
    if (!claim) return res.status(400).json({ error: 'Нужна подпись назначения канала ключом владельца' });
    try {
      await db.moduleChannelPin.create({ data: { moduleId: claim.moduleId, channel: claim.channel, version: claim.version || '', reason: claim.reason,
        signature, signatureHash: signatureHash(signature) } });
    } catch (e: any) { if (e?.code !== 'P2002') return res.status(503).json({ error: e?.message || 'Назначение не записано' }); }
    deps.broadcast('modules:revoked', { kind: 'pin', target: `${claim.moduleId}:${claim.channel}` });
    res.json({ ok: true });
  });
}
