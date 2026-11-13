/**
 * Разделы разработчика в Flux Studio: сертификат, запросы на публикацию и выпуски своей программы.
 *
 * Все маршруты закрыты ЯВНЫМ правом module.develop (developerGate, а не общей userCan, которая
 * отдаёт администратору всё). Чужая программа разработчику не видна и не отправляется:
 * - список запросов, пакет запроса и выпуски отдаются только автору запроса / ключа;
 * - `studioPublishGate` подключается к приёму запросов (modulePublishing): тот же явный отказ
 *   и запрет присылать версию под идентификатором, который занят другим разработчиком.
 * Владелец видит всё своими маршрутами проверки (modulePublishing.ts), не этими.
 */
import type { Express, Request, Response } from 'express';
import { openEnvelope, peekEnvelope } from '../../modules/trust/envelope.js';
import { parsePinClaim, parseReleaseClaim, parseRequestClaim, MODULE_ID } from '../../modules/trust/claims.js';
import { MODULE_ROOT_KEY_HEX, loadTrust, readBundle } from '../moduleStore.js';
import { developerGate, refuseDeveloper, type StudioDeps } from './studio.js';

export interface StudioDeveloperDeps extends StudioDeps { modulePublicKeyHex?: string }
/** Предел списка запросов в окне: у одного разработчика их не тысячи, а ответ не должен расти без границы */
export const STUDIO_REQUEST_LIMIT = 200;

const userId = (req: Request) => String((req as any).authUser?.id || '');

/** Ключи этого человека с действующим сертификатом владельца */
async function myKeys(db: any, me: string, rootHex: string): Promise<Set<string>> {
  const trust = await loadTrust(db, rootHex);
  return new Set([...trust.certificates.values()].filter(c => c.userId === me).map(c => c.key));
}

/** Программа чужая, если её уже присылал или выпускал другой разработчик */
export async function foreignModule(db: any, moduleId: string, me: string, rootHex: string): Promise<boolean> {
  const other = await db.moduleRequest.findFirst({
    where: { moduleId, byOwner: false, authorId: { not: me }, state: { notIn: ['rejected', 'writing'] } }, select: { id: true },
  });
  if (other) return true;
  const keys = await myKeys(db, me, rootHex);
  const releases = await db.moduleRelease.findMany({ where: { moduleId }, select: { signature: true } });
  return releases.some((r: any) => {
    const claim = parseReleaseClaim(openEnvelope('release', r.signature, rootHex));
    return !!claim && !keys.has(claim.author);
  });
}

/** Крючок для приёма запросов: явное право и «чужую программу не прислать» */
export function studioPublishGate(deps: Pick<StudioDeps, 'permissionsOf'> & { modulePublicKeyHex?: string }) {
  const may = developerGate(deps);
  const rootHex = () => deps.modulePublicKeyHex ?? MODULE_ROOT_KEY_HEX;
  return {
    /** Право разработки: у владельца есть всегда, у остальных — только выданное явно (администратор без него не отправляет) */
    allowed: (req: Request) => may(req),
    /** Текст отказа или null */
    async ownership(db: any, req: Request, moduleId: string): Promise<string | null> {
      if ((req as any).authUser?.role === 'OWNER') return null;
      return await foreignModule(db, moduleId, userId(req), rootHex())
        ? `Программа «${moduleId}» принадлежит другому разработчику: выберите другой идентификатор.` : null;
    },
  };
}

export function registerStudioDeveloperRoutes(app: Express, deps: StudioDeveloperDeps): void {
  const may = developerGate(deps);
  const rootHex = () => deps.modulePublicKeyHex ?? MODULE_ROOT_KEY_HEX;
  const guard = (handler: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
    if (!await may(req)) return refuseDeveloper(res);
    res.setHeader('Cache-Control', 'no-store');
    try { await handler(req, res); } catch (e: any) { res.status(503).json({ error: e?.message || 'База временно недоступна' }); }
  };

  /** Состояние сертификата ключа: нет / выдан / отозван. Чужие ключи и сертификаты не видны */
  app.get('/api/studio/certificate', guard(async (req, res) => {
    const db = deps.getPrisma(), key = String(req.query.key || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(key)) return res.status(400).json({ error: 'Нужен открытый ключ разработчика (64 шестнадцатеричных знака).' });
    const trust = await loadTrust(db, rootHex());
    const issued = trust.certificates.get(key);
    // Чужой ключ отвечает так же, как неизвестный: по ответу не узнать, кому он выдан
    if (issued) {
      if (issued.userId !== userId(req)) return res.json({ status: 'none', name: '' });
      // Конверт сертификата Studio кладёт рядом с пакетом разработки («Запустить во Flux»): Flux проверяет его по корню владельца сам
      const row = await db.moduleCertificate.findUnique({ where: { keyHex: key }, select: { signature: true } });
      return res.json({ status: 'issued', name: issued.name, certificate: row?.signature || '' });
    }
    // Строка есть, а действующего сертификата нет — значит подпись не сошлась или ключ отозван
    const row = await db.moduleCertificate.findUnique({ where: { keyHex: key }, select: { userId: true } });
    res.json({ status: row && row.userId === userId(req) ? 'revoked' : 'none', name: '' });
  }));

  /** Свои запросы на публикацию: состояние, замечания владельца, «что нового» */
  app.get('/api/studio/requests', guard(async (req, res) => {
    const rows = await deps.getPrisma().moduleRequest.findMany({
      where: { authorId: userId(req), state: { not: 'writing' } }, orderBy: { createdAt: 'desc' }, take: STUDIO_REQUEST_LIMIT,
      select: { id: true, moduleId: true, version: true, state: true, parentId: true, baseRelease: true, signature: true, review: true, decidedAt: true, createdAt: true },
    });
    res.json({ requests: rows.map((r: any) => {
      const claim = parseRequestClaim(peekEnvelope('request', r.signature));
      let review: any = null;
      try { review = r.review ? JSON.parse(r.review) : null; } catch { review = null; }
      return {
        id: r.id, moduleId: r.moduleId, version: r.version, state: r.state, parentId: r.parentId, baseRelease: r.baseRelease,
        decidedAt: r.decidedAt, createdAt: r.createdAt, changelog: claim?.meta.changelog || '', channel: claim?.meta.channel || 'test',
        review: review ? { note: String(review.note || ''), comments: Array.isArray(review.comments) ? review.comments.slice(0, 500) : [] } : null,
      };
    }) });
  }));

  /** Пакет своего запроса — чтобы исправить и отправить заново. Чужой запрос отвечает «не найден» */
  app.get('/api/studio/requests/:id/bundle', guard(async (req, res) => {
    const db = deps.getPrisma();
    const row = await db.moduleRequest.findUnique({ where: { id: String(req.params.id) } });
    if (!row || row.authorId !== userId(req) || row.state === 'writing') return res.status(404).json({ error: 'Запрос не найден' });
    res.type('application/octet-stream').send(Buffer.from(await readBundle(db, row.id, row.chunkCount)));
  }));

  /** Выпуски своей программы: от них считается «разница с прошлой версией» и повышается номер */
  app.get('/api/studio/releases', guard(async (req, res) => {
    const db = deps.getPrisma(), moduleId = String(req.query.moduleId || '');
    if (!MODULE_ID.test(moduleId)) return res.status(400).json({ error: 'Нужен идентификатор программы.' });
    const keys = await myKeys(db, userId(req), rootHex());
    const rows = await db.moduleRelease.findMany({ where: { moduleId }, orderBy: { createdAt: 'desc' }, take: 100 });
    res.json({ releases: rows.flatMap((r: any) => {
      const claim = parseReleaseClaim(openEnvelope('release', r.signature, rootHex()));
      return claim && claim.moduleId === r.moduleId && claim.version === r.version && keys.has(claim.author)
        ? [{ version: r.version, channel: claim.channel, state: r.state, createdAt: r.createdAt }] : [];
    }) });
  }));

  /**
   * Откат владельца по своей программе: действующее назначение канала («не выше версии X»), по одному на канал.
   * Назначения подписаны владельцем и лежат в общей таблице; разработчику отдаются только записи программы, выпуск которой
   * подписан его ключом, — по чужой программе ответ пустой, как у выпусков.
   */
  app.get('/api/studio/pins', guard(async (req, res) => {
    const db = deps.getPrisma(), moduleId = String(req.query.moduleId || '');
    if (!MODULE_ID.test(moduleId)) return res.status(400).json({ error: 'Нужен идентификатор программы.' });
    const keys = await myKeys(db, userId(req), rootHex());
    const releases = await db.moduleRelease.findMany({ where: { moduleId }, select: { signature: true }, take: 100 });
    const mine = releases.some((r: any) => { const claim = parseReleaseClaim(openEnvelope('release', r.signature, rootHex())); return !!claim && keys.has(claim.author); });
    if (!mine) return res.json({ pins: [] });
    const rows = await db.moduleChannelPin.findMany({ where: { moduleId }, orderBy: { createdAt: 'asc' }, select: { signature: true }, take: 500 });
    const latest = new Map<string, { channel: string; version: string | null; reason: string; iat: number }>();
    for (const row of rows) {
      const claim = parsePinClaim(openEnvelope('pin', row.signature, rootHex()));
      if (!claim || claim.moduleId !== moduleId) continue;
      const known = latest.get(claim.channel);
      if (!known || claim.iat > known.iat) latest.set(claim.channel, { channel: claim.channel, version: claim.version, reason: String(claim.reason).slice(0, 300), iat: claim.iat });
    }
    res.json({ pins: [...latest.values()] });
  }));
}
