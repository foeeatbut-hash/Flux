import type { Express } from 'express';
import crypto from 'node:crypto';
import { administratorPermission } from '../accessPolicy.js';
import { readUpdateDelegation, readUpdateEnvelope, verifyUpdateCommand, type SignedUpdateCommand, type UpdateCommand } from '../../electron/updateCommand.js';
import { compareVersions, readUpdateSignature } from '../../electron/updateSignature.js';
import { licenseInstallationId } from '../licenseService.js';
import { notifyUser } from '../context.js';

const DEVICE = 'update.device', COMMAND = 'update.command', HEAD = 'update.head', DELEGATION = 'update.delegation';
const statuses = new Set(['idle', 'scheduled', 'delivered', 'downloading', 'verifying', 'ready', 'saving', 'restarting', 'updated', 'delayed', 'failed', 'cancelled']);
export interface UpdateCampaignDeps {
  getPrisma: () => any; updatePublicKeyHex?: string; installationId?: () => Promise<string>;
  broadcast: (event: string, payload: unknown) => void;
}
const rowId = (type: string, id: string) => `${type}:${id}`;
const valueOf = (row: any) => { try { return JSON.parse(row.value); } catch { return null; } };
const manager = (req: any, res: any, next: () => void) => {
  if (!administratorPermission(req.authUser, 'admin.users.manage')) return res.status(403).json({ error: 'Нет доступа к назначению обновлений.' });
  next();
};

export function registerUpdateCampaignRoutes(app: Express, deps: UpdateCampaignDeps) {
  const inst = deps.installationId || licenseInstallationId;
  const setting = async (db: any, key: string, id: string, value: any) => db.appSetting.upsert({ where: { id: rowId(key, id) },
    create: { id: rowId(key, id), key, userId: null, value: JSON.stringify(value) }, update: { value: JSON.stringify(value) } });
  const history = async (db: any, scope: string) => {
    const rows = await db.appSetting.findMany({ where: { key: COMMAND, userId: null }, take: 5001 });
    if (rows.length > 5000) throw new Error('История заданий требует обслуживания. Новое назначение остановлено.');
    return rows.map(valueOf).filter(Boolean).map((envelope: SignedUpdateCommand) => ({ envelope,
      command: verifyUpdateCommand(envelope, { inst: scope, keyHex: deps.updatePublicKeyHex }) })).filter((x: any) => x.command) as { envelope: SignedUpdateCommand; command: UpdateCommand }[];
  };
  const deviceChain = (list: Awaited<ReturnType<typeof history>>, deviceId: string, userId: string) => {
    const relevant = list.filter(x => x.command.targets.some(t => t.deviceId === deviceId && t.userId === userId));
    const ordered: typeof relevant = []; let head: string | null = null;
    while (ordered.length < relevant.length) {
      const next = relevant.filter(x => x.command.targets.find(t => t.deviceId === deviceId && t.userId === userId)!.previous === head);
      if (next.length !== 1) throw new Error('История назначений устройства повреждена.');
      if (ordered.some(x => x.command.id === next[0].command.id)) throw new Error('В истории назначений найден повтор.');
      ordered.push(next[0]); head = next[0].command.id;
    }
    return ordered;
  };
  const deviceRows = async (db: any) => {
    const rows = await db.appSetting.findMany({ where: { key: DEVICE, userId: null }, take: 10001 });
    if (rows.length > 10000) throw new Error('Список устройств требует обслуживания.');
    return rows.map(valueOf).filter(Boolean).map((row: any) => {
      const proof = readUpdateEnvelope(row.proof, 'FLUXUPDDEVICE1', row.publicKey || '');
      return proof ? { ...proof, inst: row.inst, publicKey: row.publicKey, lastSeen: row.lastSeen } : null;
    }).filter(Boolean);
  };
  const release = async (db: any, version: string) => {
    const r = await db.appUpdate.findUnique({ where: { version } });
    const signed = readUpdateSignature(r?.signature || '', deps.updatePublicKeyHex);
    if (!r || r.state !== 'published' || !signed || signed.version !== version || signed.sha256 !== r.sha256 || signed.size !== r.size) throw new Error('Выпуск недоступен или отозван.');
    return r;
  };

  app.post('/api/updates/devices/heartbeat', async (req: any, res) => {
    const proof = readUpdateEnvelope(req.body?.proof, 'FLUXUPDDEVICE1', req.body?.publicKey || '');
    const actor = req.authUser?.id;
    if (!actor || !proof || proof.userId !== actor || typeof proof.deviceId !== 'string' || !/^[a-f0-9-]{36}$/.test(proof.deviceId)
      || typeof req.body.proof !== 'string' || req.body.proof.length > 8192
      || typeof proof.version !== 'string' || proof.version.length > 40 || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/.test(proof.version) || !statuses.has(proof.status)
      || !['win32', 'linux', 'darwin'].includes(proof.platform) || !['x64', 'arm64', 'ia32'].includes(proof.arch)
      || typeof proof.code !== 'string' || !/^[A-Z0-9_]{0,80}$/.test(proof.code)
      || (proof.commandId !== null && (typeof proof.commandId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(proof.commandId)))
      || !Number.isSafeInteger(proof.at) || Math.abs(proof.at - Date.now()) > 300000) return res.status(400).json({ error: 'Сведения об устройстве не подтверждены.' });
    try {
      const db = deps.getPrisma(), scope = await inst();
      const previous = valueOf(await db.appSetting.findUnique({ where: { id: rowId(DEVICE, proof.deviceId) } }) || {});
      if (previous && previous.publicKey !== req.body.publicKey) return res.status(409).json({ error: 'Устройство уже зарегистрировано с другим ключом.' });
      if (!previous && (await deviceRows(db)).length >= 10000) return res.status(409).json({ error: 'Достигнут предел зарегистрированных устройств.' });
      await setting(db, DEVICE, proof.deviceId, { ...proof, proof: req.body.proof, publicKey: req.body.publicKey, lastSeen: Date.now(), inst: scope });
      // Не удаляем прежние назначения при выходе: они связаны с устройством и авторизованным профилем.
      const list = await history(db, scope), chain = deviceChain(list, proof.deviceId, actor);
      res.json({ inst: scope, commands: chain.map(x => x.envelope) });
    } catch { res.status(503).json({ error: 'Не удалось подтвердить состояние обновления.' }); }
  });

  app.get('/api/updates/devices/:deviceId/commands', async (req: any, res) => {
    try {
      if (!req.authUser?.id) return res.status(401).json({ error: 'Войдите в программу.' });
      const scope = await inst(), list = await history(deps.getPrisma(), scope);
      res.json({ inst: scope, commands: deviceChain(list, req.params.deviceId, req.authUser.id).map(x => x.envelope) });
    } catch { res.status(503).json({ error: 'Не удалось проверить назначение обновления.' }); }
  });

  app.post('/api/updates/reminder', async (req: any, res) => {
    if (!req.authUser?.id) return res.status(401).json({ error: 'Войдите в программу.' });
    try {
      const db = deps.getPrisma(), now = Date.now(), actor = req.authUser.id;
      await release(db, String(req.body?.version || ''));
      const id = rowId('update.reminder', actor);
      await db.appSetting.upsert({ where: { id }, create: { id, key: 'update.reminder', userId: null, value: '0' }, update: {} });
      const row = await db.appSetting.findUnique({ where: { id } }), previous = Number(row?.value || 0);
      if (now - previous < 600000) return res.json({ reminded: false, shownAt: previous });
      const changed = await db.appSetting.updateMany({ where: { id, value: row.value }, data: { value: String(now) } });
      if (changed.count !== 1) return res.json({ reminded: false, shownAt: now });
      await notifyUser(actor, 'СИСТЕМА', `Доступна версия ${req.body.version}`, 'Посмотрите изменения и обновите программу.', '/updates');
      res.json({ reminded: true, shownAt: now });
    } catch { res.status(503).json({ error: 'Напоминание об обновлении сейчас недоступно.' }); }
  });

  app.get('/api/updates/devices', manager, async (_req, res) => {
    try {
      const db = deps.getPrisma(), scope = await inst(), list = await history(db, scope);
      const users = await db.user.findMany({ select: { id: true, name: true, symbol: true, isActive: true } });
      const devices = (await deviceRows(db)).filter((d: any) => d.inst === scope).map((d: any) => {
        const chain = deviceChain(list, d.deviceId, d.userId), currentItem = chain.at(-1), current = currentItem?.command;
        const person = users.find((u: any) => u.id === d.userId);
        return { deviceId: d.deviceId, userId: d.userId, name: person?.name || 'Профиль удалён', symbol: person?.symbol || '',
          isActive: person?.isActive !== false && !!person, version: d.version || '', platform: d.platform, arch: d.arch,
          lastSeen: d.lastSeen, offline: Date.now() - d.lastSeen > 180000,
          status: current?.action === 'cancel' ? 'cancelled' : current && d.commandId !== current.id ? 'scheduled' : d.status, code: d.code || '',
          commandId: current?.id || null, action: current?.action || null, deadline: current?.deadline || null, targetVersion: current?.version || null,
          commandRelease: current ? { version: current.version, generation: current.generation, sha256: current.sha256, releaseSignature: currentItem!.envelope.releaseSignature } : null };
      });
      const releases = (await db.appUpdate.findMany({ where: { state: 'published' }, orderBy: { createdAt: 'desc' }, take: 30 })).filter((r: any) => readUpdateSignature(r.signature, deps.updatePublicKeyHex)).map((r: any) => ({ version: r.version, generation: r.generation, signature: r.signature, sha256: r.sha256 }));
      res.json({ inst: scope, devices, releases });
    } catch { res.status(503).json({ error: 'Состояния устройств недоступны. Повторите позже.' }); }
  });

  app.get('/api/updates/delegation', manager, async (req: any, res) => {
    try {
      const row = await deps.getPrisma().appSetting.findUnique({ where: { id: rowId(DELEGATION, req.authUser.id) } });
      const code = valueOf(row || {})?.code || '', grant = readUpdateDelegation(code, deps.updatePublicKeyHex);
      res.json({ inst: await inst(), userId: req.authUser.id, code, grant });
    } catch { res.status(503).json({ error: 'Разрешение на обновления недоступно.' }); }
  });
  app.post('/api/updates/delegation', manager, async (req: any, res) => {
    const code = req.body?.code, d = readUpdateDelegation(code, deps.updatePublicKeyHex);
    try {
      if (!d || d.inst !== await inst() || d.userId !== req.authUser.id || d.expiresAt <= Date.now()) return res.status(400).json({ error: 'Разрешение не подходит этому профилю или истекло.' });
      await setting(deps.getPrisma(), DELEGATION, d.userId, { code }); res.json({ success: true });
    } catch { res.status(503).json({ error: 'Разрешение не сохранено.' }); }
  });

  app.post('/api/updates/campaigns', manager, async (req: any, res) => {
    try {
      const scope = await inst(), envelope = req.body as SignedUpdateCommand, c = verifyUpdateCommand(envelope, { inst: scope, keyHex: deps.updatePublicKeyHex });
      const grant = readUpdateDelegation(envelope?.delegation, deps.updatePublicKeyHex);
      if (!c || !grant || grant.expiresAt <= Date.now() || c.actor !== req.authUser.id || Math.abs(c.issuedAt - Date.now()) > 120000) return res.status(400).json({ error: 'Назначение не подтверждено разрешением владельца.' });
      const db = deps.getPrisma(), r = c.action === 'schedule' ? await release(db, c.version) : null;
      if (r && (r.generation !== c.generation || r.sha256 !== c.sha256 || r.signature !== envelope.releaseSignature)) return res.status(409).json({ error: 'Выпуск изменился. Обновите список.' });
      const devices = await deviceRows(db), list = await history(db, scope);
      const existing = await db.appSetting.findUnique({ where: { id: rowId(COMMAND, c.id) } });
      if (existing) return existing.value === JSON.stringify(envelope) ? res.json({ success: true, id: c.id }) : res.status(409).json({ error: 'Номер задания уже занят.' });
      for (const t of c.targets) {
        const d = devices.find((d: any) => d.deviceId === t.deviceId && d.userId === t.userId && d.inst === scope);
        if (!d) return res.status(409).json({ error: 'Устройство или его профиль изменились. Обновите список.' });
        if (c.action === 'schedule' && compareVersions(c.version, d.version) <= 0) return res.status(409).json({ error: 'Выбрано устройство с актуальной или более новой версией.' });
        const head = deviceChain(list, t.deviceId, t.userId).at(-1)?.command;
        if ((head?.id || null) !== t.previous || (c.action === 'cancel' && (!head || head.action !== 'schedule' || head.version !== c.version || head.sha256 !== c.sha256 || head.generation !== c.generation))) return res.status(409).json({ error: 'Назначение уже изменилось. Обновите список и подтвердите снова.' });
      }
      await db.$transaction(async (tx: any) => {
        for (const t of c.targets) {
          const id = rowId(HEAD, `${t.deviceId}:${t.userId}`);
          if (t.previous === null) await tx.appSetting.create({ data: { id, key: HEAD, userId: null, value: c.id } });
          else {
            const changed = await tx.appSetting.updateMany({ where: { id, value: t.previous }, data: { value: c.id } });
            if (changed.count !== 1) throw new Error('CONFLICT');
          }
        }
        await tx.appSetting.create({ data: { id: rowId(COMMAND, c.id), key: COMMAND, userId: null, value: JSON.stringify(envelope) } });
      });
      deps.broadcast('app:update-assigned', { id: c.id }); res.json({ success: true, id: c.id });
    } catch (e: any) { res.status(e?.code === 'P2002' || e?.message === 'CONFLICT' ? 409 : 503).json({ error: 'Задание не сохранено. Обновите список перед повтором.' }); }
  });
}
