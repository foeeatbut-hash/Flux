import type { Express } from 'express';
import { getPrisma } from '../context.js';
import { makeRequest } from '../../license/node/core.js';
import { licenseForUser, licenseInstallationId, activatePersonKey, activateRevocations, installedLicenses, canActivateLicense } from '../licenseService.js';

const canActivate = canActivateLicense;

export function registerPersonLicenseRoutes(app: Express): void {
  app.get('/api/license/me', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const user = (req as any).authUser;
    if (!user) return res.status(401).json({ error: 'Требуется вход.' });
    try { res.json({ ...await licenseForUser(user), canActivate: canActivate(user) }); }
    catch (_) { res.status(503).json({ error: 'Не удалось проверить лицензию в базе компании.' }); }
  });

  app.get('/api/license/request', async (req, res) => {
    const user = (req as any).authUser;
    if (!canActivate(user)) return res.status(403).json({ error: 'Составить запрос может администратор с правом активации лицензий.' });
    res.setHeader('Cache-Control', 'no-store');
    try {
      const prisma = getPrisma();
      const people = await prisma.user.findMany({ where: { isActive: true, role: { not: 'OWNER' } }, select: { id: true, symbol: true, name: true }, orderBy: { symbol: 'asc' } });
      const requested = typeof req.query.people === 'string' ? new Set(req.query.people.split(',').slice(0, 10000)) : null;
      const eligible = requested ? people.filter((p: any) => requested.has(p.id)) : people;
      const org = String(req.query.organization || '').slice(0, 200);
      const selected = [];
      for (const p of eligible) {
        const status = await licenseForUser(p);
        // При продлении включаем и тех, кому осталось две недели.
        if (!status.licensed || status.warn || requested) selected.push({ login: p.symbol, name: p.name });
      }
      const inst = await licenseInstallationId();
      res.json({ code: makeRequest({ inst, org, people: selected, at: Date.now() }), installationId: inst, count: selected.length, people: selected });
    } catch (_) { res.status(503).json({ error: 'Не удалось составить запрос лицензии.' }); }
  });

  app.post('/api/license/activate-key', async (req, res) => {
    const user = (req as any).authUser;
    if (!canActivate(user)) return res.status(403).json({ error: 'Нет права активации лицензии компании.' });
    try {
      const payload = await activatePersonKey(typeof req.body?.code === 'string' ? req.body.code : '');
      res.json({ ...await licenseForUser(user), canActivate: true, activated: { id: payload.id, employees: payload.logins.length, expiresAt: payload.exp } });
    } catch (e: any) { res.status(400).json({ error: e.message || 'Ключ не принят.' }); }
  });

  app.get('/api/license/overview', async (req, res) => {
    const user = (req as any).authUser;
    if (!canActivate(user)) return res.status(403).json({ error: 'Нет права просмотра лицензий компании.' });
    res.setHeader('Cache-Control', 'no-store');
    try {
      const [snapshot, people] = await Promise.all([installedLicenses(), getPrisma().user.findMany({ where: { role: { not: 'OWNER' } }, select: { id: true, symbol: true, name: true, isActive: true }, orderBy: { symbol: 'asc' } })]);
      const statuses = await Promise.all(people.map(async (p: any) => ({ ...p, ...await licenseForUser(p) })));
      res.json({ installationId: snapshot.inst, people: statuses, revocationSequence: snapshot.revoked?.seq || 0, revokedCount: snapshot.revoked?.ids.length || 0 });
    } catch (_) { res.status(503).json({ error: 'Не удалось получить состояние лицензий.' }); }
  });

  app.post('/api/license/revocations', async (req, res) => {
    if ((req as any).authUser?.role !== 'OWNER') return res.status(403).json({ error: 'Отозвать лицензии может только владелец Flux.' });
    try { const p = await activateRevocations(req.body?.code); res.json({ sequence: p.seq, revoked: p.ids.length }); }
    catch (e: any) { res.status(400).json({ error: e.message || 'Список отзыва не принят.' }); }
  });
}
