/**
 * Flux Studio: запросы на публикацию, проверка владельцем, выпуски, отзывы.
 *
 * Порядок (docs/roadmap/modules.md, «Запрос на публикацию и проверка
 * владельцем»): разработчик присылает весь пакет, подписанный своим ключом;
 * владелец возвращает на доработку, правит сам (отдельным запросом), отклоняет
 * или выпускает — выпуск подписывает ТОЛЬКО ключ владельца. Отправленный запрос
 * не меняется: новая правка — новый запрос, прежний остаётся в истории.
 *
 * Выпуск, отзыв и сертификат подписываются у владельца (Studio — Владелец на его
 * компьютере, хранилище ключей — studio/owner/src/moduleSigning.ts); сервер только
 * сверяет подпись. Закрытого ключа на сервере нет.
 */
import type { Express, Request, Response } from 'express';
import { requireOwnerMiddleware } from '../accessPolicy.js';
import { openEnvelope, peekEnvelope } from '../../modules/trust/envelope.js';
import {
  parseCertificateClaim, parseReleaseClaim, parseRequestClaim, parseRevocationClaim,
} from '../../modules/trust/claims.js';
import { unpackBundle } from '../../modules/trust/bundle.js';
import { checkChunks, verifyRequest } from '../../modules/trust/verify.js';
import { diffFiles, diffPermissions, manifestOf } from '../../modules/trust/diff.js';
import { MODULE_ROOT_KEY_HEX, loadTrust, readBlob, readBundle, signatureHash, writeBlob } from '../moduleStore.js';
import { effectiveChannel, readPromotions } from '../../modules/trust/promotion.js';
import { channelsFor, promotionsOf } from '../moduleChannels.js';
import { registerModuleChannelRoutes } from './moduleChannels.js';
import { registerModuleStoreRoutes } from './moduleStore.js';
import { closeCertRequest, registerCertRequestRoutes } from './moduleCertRequests.js';
import { registerJournalRoutes } from '../moduleJournal.js';

export interface ModulePublishingDeps {
  getPrisma: () => any;
  broadcast: (event: string, payload: unknown) => void;
  /** Право по функции — та же проверка, что у остальных разделов (module.develop, module.publish) */
  can?: (user: any, feature: string) => boolean;
  /** Только для проверок с одноразовым ключом; HTTP ключ не выбирает */
  modulePublicKeyHex?: string;
}

const isOwner = (req: Request) => (req as any).authUser?.role === 'OWNER';
const userId = (req: Request) => String((req as any).authUser?.id || '');
const fail = (res: Response, status: number, error: string) => res.status(status).json({ error });
/** Решения и замечания владельца: текст, без разметки, с пределом */
const clip = (v: unknown, max: number) => String(v ?? '').slice(0, max);

function requestView(r: any) {
  const claim = parseRequestClaim(peekEnvelope('request', r.signature));
  return {
    id: r.id, moduleId: r.moduleId, version: r.version, state: r.state, byOwner: r.byOwner, authorKey: r.authorKey,
    authorId: r.authorId, parentId: r.parentId, baseRelease: r.baseRelease, size: r.size, createdAt: r.createdAt,
    decidedBy: r.decidedBy, decidedAt: r.decidedAt, review: r.review ? JSON.parse(r.review) : null,
    meta: claim?.meta || null,
  };
}

export function registerModulePublishingRoutes(app: Express, deps: ModulePublishingDeps): void {
  const rootHex = () => deps.modulePublicKeyHex ?? MODULE_ROOT_KEY_HEX;
  const findRequest = async (db: any, req: Request, res: Response) => {
    const row = await db.moduleRequest.findUnique({ where: { id: String(req.params.id) } });
    if (!row || (!isOwner(req) && row.authorId !== userId(req))) { fail(res, 404, 'Запрос не найден'); return null; }
    return row;
  };
  const releaseBundle = async (db: any, ref: string | null) => {
    if (!ref) return null;
    const [moduleId, version] = ref.split('@');
    const release = await db.moduleRelease.findUnique({ where: { moduleId_version: { moduleId, version } } });
    return release ? unpackBundle(await readBundle(db, release.blobId, release.chunkCount)) : null;
  };

  const can = (req: Request, feature: string) => isOwner(req) || (deps.can ? deps.can((req as any).authUser, feature) : false);

  app.post('/api/modules/requests', async (req: Request, res: Response) => {
    // Права проверяет сервер: окно разработчика может быть любым
    if (!can(req, 'module.develop')) return fail(res, 403, 'Присылать подпрограммы на публикацию могут только разработчики: нужно право «Разработка подпрограмм»');
    const db = deps.getPrisma(), signature = String(req.body?.signature || '').trim();
    let bundle: Uint8Array;
    try { bundle = new Uint8Array(Buffer.from(String(req.body?.bundle || ''), 'base64')); } catch { return fail(res, 400, 'Пакет не прочитан'); }
    try {
      const existing = await db.moduleRequest.findUnique({ where: { signatureHash: signatureHash(signature) } });
      if (existing) return res.json({ id: existing.id, duplicate: true });
      const trust = await loadTrust(db, rootHex());
      const checked = verifyRequest({ signature, bundle, rootHex: rootHex(), certificates: trust.certificates });
      if (!checked.ok) return fail(res, 400, checked.why);
      const { claim, byOwner } = checked;
      // Сертификат выдан человеку: чужим ключом присылать от своего имени нельзя
      if (byOwner ? !isOwner(req) : trust.certificates.get(claim.author)?.userId !== userId(req)) {
        return fail(res, 403, byOwner ? 'Изменения владельца присылает только владелец' : 'Ключ разработчика выдан другому профилю');
      }
      // «Что нового» обязательно: без него пользователь в Store не поймёт, зачем обновляться
      if (!claim.meta.changelog.trim()) return fail(res, 400, 'Заполните «что нового»: без него выложить нельзя');
      if (!byOwner && claim.meta.channel === 'production' && !can(req, 'module.publish')) {
        return fail(res, 403, 'Просить рабочий канал сразу можно с правом «Просить рабочий канал»: отправьте запрос в тестовый');
      }
      if (await db.moduleRelease.findUnique({ where: { moduleId_version: { moduleId: claim.moduleId, version: claim.version } } })) {
        return fail(res, 409, `Версия ${claim.version} уже выпущена: повысьте номер версии`);
      }
      if (claim.baseRelease) {
        const [moduleId] = claim.baseRelease.split('@');
        if (moduleId !== claim.moduleId || !(await releaseBundle(db, claim.baseRelease))) return fail(res, 400, 'Выпуск, от которого считается разница, не найден');
      }
      const parent = claim.parentRequest ? await db.moduleRequest.findUnique({ where: { id: claim.parentRequest } }) : null;
      if (claim.parentRequest && (!parent || parent.moduleId !== claim.moduleId)) return fail(res, 400, 'Предыдущий запрос не найден');
      const row = await db.moduleRequest.create({ data: {
        moduleId: claim.moduleId, version: claim.version, signature, signatureHash: signatureHash(signature), authorKey: claim.author,
        authorId: userId(req), byOwner, parentId: parent?.id || null, baseRelease: claim.baseRelease, size: claim.size, sha256: claim.sha256,
        chunkCount: claim.chunks.length, state: 'writing',
      } });
      try { await writeBlob(db, row.id, bundle); }
      catch (e) { await db.moduleRequest.delete({ where: { id: row.id } }).catch(() => {}); throw e; }
      await db.moduleRequest.update({ where: { id: row.id }, data: { state: 'pending' } });
      // Прежний запрос остаётся в истории как есть; меняется только его отметка
      if (parent && ['pending', 'returned'].includes(parent.state)) {
        await db.moduleRequest.updateMany({ where: { id: parent.id, state: parent.state }, data: { state: byOwner ? 'edited' : 'superseded' } });
      }
      deps.broadcast('modules:requests', { id: row.id });
      res.json({ id: row.id });
    } catch (e: any) {
      if (e?.code === 'P2002') return fail(res, 409, 'Этот запрос уже отправлен');
      fail(res, 503, e?.message || 'Запрос не записан');
    }
  });

  app.get('/api/modules/requests', async (req: Request, res: Response) => {
    const db = deps.getPrisma();
    const rows = await db.moduleRequest.findMany({ where: isOwner(req) ? { state: { not: 'writing' } } : { authorId: userId(req), state: { not: 'writing' } }, orderBy: { createdAt: 'desc' }, take: 500 });
    res.json({ requests: rows.map(requestView) });
  });

  app.get('/api/modules/requests/:id', async (req: Request, res: Response) => {
    const row = await findRequest(deps.getPrisma(), req, res);
    if (row) res.json({ request: requestView(row), signature: row.signature });
  });

  /** Пакет как есть: окно владельца показывает файлы из тех же байт, которые потом подписывает */
  app.get('/api/modules/requests/:id/bundle', async (req: Request, res: Response) => {
    const db = deps.getPrisma(), row = await findRequest(db, req, res);
    if (!row) return;
    try { res.type('application/octet-stream').send(Buffer.from(await readBundle(db, row.id, row.chunkCount))); }
    catch (e: any) { fail(res, 409, e.message); }
  });

  /** Разница с прошлым выпуском (или с запросом, который правил владелец) и разница в разрешениях */
  app.get('/api/modules/requests/:id/diff', async (req: Request, res: Response) => {
    const db = deps.getPrisma(), row = await findRequest(db, req, res);
    if (!row) return;
    try {
      const files = unpackBundle(await readBundle(db, row.id, row.chunkCount));
      const parent = row.byOwner && row.parentId ? await db.moduleRequest.findUnique({ where: { id: row.parentId } }) : null;
      const base = parent ? unpackBundle(await readBundle(db, parent.id, parent.chunkCount)) : await releaseBundle(db, row.baseRelease);
      res.json({ against: parent ? { request: parent.id } : row.baseRelease ? { release: row.baseRelease } : null,
        files: diffFiles(base, files), permissions: diffPermissions(manifestOf(base), manifestOf(files)!) });
    } catch (e: any) { fail(res, 409, e.message); }
  });

  const decide = (state: 'returned' | 'rejected') => async (req: Request, res: Response) => {
    const db = deps.getPrisma();
    const note = clip(state === 'rejected' ? req.body?.reason : req.body?.note, 8000);
    if (state === 'rejected' && !note.trim()) return fail(res, 400, 'Укажите причину отказа');
    const comments = Array.isArray(req.body?.comments) ? req.body.comments.slice(0, 500).map((c: any) => ({
      path: clip(c?.path, 240), line: Number.isSafeInteger(c?.line) ? c.line : null, text: clip(c?.text, 4000),
    })).filter((c: any) => c.text.trim()) : [];
    const changed = await db.moduleRequest.updateMany({ where: { id: String(req.params.id), state: 'pending' }, data: {
      state, review: JSON.stringify({ note, comments }), decidedBy: userId(req), decidedAt: new Date(),
    } });
    if (changed.count !== 1) return fail(res, 409, 'Запрос уже решён или заменён новым');
    deps.broadcast('modules:requests', { id: req.params.id });
    res.json({ ok: true });
  };
  app.post('/api/modules/requests/:id/return', requireOwnerMiddleware, decide('returned'));
  app.post('/api/modules/requests/:id/reject', requireOwnerMiddleware, decide('rejected'));

  app.post('/api/modules/requests/:id/release', requireOwnerMiddleware, async (req: Request, res: Response) => {
    const db = deps.getPrisma(), signature = String(req.body?.signature || '').trim();
    const claim = parseReleaseClaim(openEnvelope('release', signature, rootHex()));
    if (!claim) return fail(res, 400, 'Нужна подпись выпуска ключом владельца');
    const row = await db.moduleRequest.findUnique({ where: { id: String(req.params.id) } });
    if (!row || claim.request !== row.id) return fail(res, 404, 'Запрос не найден');
    if (claim.moduleId !== row.moduleId || claim.version !== row.version || claim.sha256 !== row.sha256 || claim.size !== row.size
      || claim.chunks.length !== row.chunkCount || claim.author !== row.authorKey) return fail(res, 400, 'Подпись выпуска не подходит к этому запросу');
    // Повтор того же выпуска (двойное нажатие, второй сервер) возвращает уже сделанный
    const existing = await db.moduleRelease.findUnique({ where: { moduleId_version: { moduleId: claim.moduleId, version: claim.version } } });
    if (existing) return existing.signature === signature ? res.json({ release: existing, duplicate: true }) : fail(res, 409, 'Эта версия уже выпущена');
    if (row.state !== 'pending') return fail(res, 409, 'Выпустить можно только запрос, ожидающий решения');
    const trust = await loadTrust(db, rootHex());
    if (trust.revoked.keys.has(claim.author)) return fail(res, 409, 'Сертификат разработчика отозван');
    try {
      const chunks = await readBlob(db, row.id, row.chunkCount);
      const why = checkChunks(claim, chunks);
      if (why) return fail(res, 409, why);
      const release = await db.moduleRelease.create({ data: {
        moduleId: claim.moduleId, version: claim.version, channel: claim.channel, signature, requestId: row.id, blobId: row.id,
        size: claim.size, sha256: claim.sha256, chunkCount: claim.chunks.length,
      } });
      await db.moduleRequest.update({ where: { id: row.id }, data: { state: 'released', decidedBy: userId(req), decidedAt: new Date() } });
      deps.broadcast('modules:released', { moduleId: claim.moduleId, version: claim.version });
      res.json({ release });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        const again = await db.moduleRelease.findUnique({ where: { moduleId_version: { moduleId: claim.moduleId, version: claim.version } } });
        return again?.signature === signature ? res.json({ release: again, duplicate: true }) : fail(res, 409, 'Эта версия уже выпущена');
      }
      fail(res, 503, e?.message || 'Выпуск не записан');
    }
  });

  app.get('/api/modules/releases', async (req: Request, res: Response) => {
    const db = deps.getPrisma(), channels = await channelsFor(db, (req as any).authUser);
    const promotions = readPromotions(await promotionsOf(db), rootHex()).claims;
    const rows = (await db.moduleRelease.findMany({ orderBy: { createdAt: 'desc' }, take: 1000 })).flatMap((r: any) => {
      const claim = parseReleaseClaim(openEnvelope('release', r.signature, rootHex()));
      // Непроверенная строка остаётся видна кэшу как отказ: только главный
      // процесс решает, можно ли запускать байты, и сообщает причину человеку.
      const channel = claim && claim.moduleId === r.moduleId && claim.version === r.version
        ? effectiveChannel(claim, r.signature, promotions) : r.channel;
      return channels.includes(channel) ? [{ ...r, channel }] : [];
    });
    res.json({ releases: rows.map((r: any) => ({ id: r.id, moduleId: r.moduleId, version: r.version, channel: r.channel,
      state: r.state, signature: r.signature, size: r.size, chunkCount: r.chunkCount, createdAt: r.createdAt })) });
  });

  /** Куски как есть, без проверки: проверяет каждый Flux сам, сервер ему не порука */
  app.get('/api/modules/releases/:id/chunks', async (req: Request, res: Response) => {
    const db = deps.getPrisma();
    const row = await db.moduleRelease.findUnique({ where: { id: String(req.params.id) } });
    const claim = row && parseReleaseClaim(openEnvelope('release', row.signature, rootHex()));
    const promotions = readPromotions(await promotionsOf(db), rootHex()).claims;
    if (!claim || claim.moduleId !== row.moduleId || claim.version !== row.version || !(await channelsFor(db, (req as any).authUser)).includes(effectiveChannel(claim, row.signature, promotions))) return fail(res, 404, 'Выпуск не найден');
    const rows = await db.moduleChunk.findMany({ where: { blobId: row.blobId }, orderBy: { idx: 'asc' }, select: { data: true } });
    res.json({ chunks: rows.map((r: any) => Buffer.from(r.data).toString('base64')) });
  });

  app.get('/api/modules/revocations', async (_req: Request, res: Response) => {
    const rows = await deps.getPrisma().moduleRevocation.findMany({ orderBy: { createdAt: 'asc' }, select: { signature: true } });
    res.json({ revocations: rows.map((r: any) => r.signature) });
  });

  app.post('/api/modules/revocations', requireOwnerMiddleware, async (req: Request, res: Response) => {
    const db = deps.getPrisma(), signature = String(req.body?.signature || '').trim();
    const claim = parseRevocationClaim(openEnvelope('revocation', signature, rootHex()));
    if (!claim) return fail(res, 400, 'Нужна подпись отзыва ключом владельца');
    try {
      await db.moduleRevocation.create({ data: { kind: claim.kind, target: claim.target, reason: claim.reason, signature, signatureHash: signatureHash(signature) } });
    } catch (e: any) { if (e?.code !== 'P2002') return fail(res, 503, e?.message || 'Отзыв не записан'); }
    if (claim.kind === 'release') {
      const [moduleId, version] = claim.target.split('@');
      await db.moduleRelease.updateMany({ where: { moduleId, version }, data: { state: 'revoked' } });
    }
    deps.broadcast('modules:revoked', { kind: claim.kind, target: claim.target });
    res.json({ ok: true });
  });

  app.get('/api/modules/certificates', async (req: Request, res: Response) => {
    const rows = await deps.getPrisma().moduleCertificate.findMany({ where: isOwner(req) ? {} : { userId: userId(req) }, orderBy: { createdAt: 'desc' } });
    res.json({ certificates: rows.map((r: any) => ({ keyHex: r.keyHex, userId: r.userId, name: r.name, signature: r.signature, createdAt: r.createdAt })) });
  });

  app.post('/api/modules/certificates', requireOwnerMiddleware, async (req: Request, res: Response) => {
    const db = deps.getPrisma(), signature = String(req.body?.signature || '').trim();
    const claim = parseCertificateClaim(openEnvelope('certificate', signature, rootHex()));
    if (!claim) return fail(res, 400, 'Нужна подпись сертификата ключом владельца');
    const data = { userId: claim.userId, name: claim.name, signature };
    await db.moduleCertificate.upsert({ where: { keyHex: claim.key }, create: { keyHex: claim.key, ...data }, update: data });
    await closeCertRequest(db, claim.key);
    res.json({ ok: true });
  });

  registerCertRequestRoutes(app, { getPrisma: deps.getPrisma, broadcast: deps.broadcast, can: deps.can });
  registerModuleChannelRoutes(app, { getPrisma: deps.getPrisma, broadcast: deps.broadcast, rootHex, can: deps.can });
  registerModuleStoreRoutes(app, { getPrisma: deps.getPrisma, broadcast: deps.broadcast, rootHex });
  registerJournalRoutes(app, { getPrisma: deps.getPrisma, can: deps.can, rootHex });
}
