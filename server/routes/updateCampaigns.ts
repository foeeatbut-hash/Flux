import type { Express } from 'express';
import crypto from 'node:crypto';
import { readUpdateDelegation, readUpdateEnvelope, verifyUpdateCommand, type SignedUpdateCommand, type UpdateCommand } from '../../electron/updateCommand.js';
import { compareVersions, readUpdateSignature } from '../../electron/updateSignature.js';
import { newestFirst } from '../updateOrder.js';
import { licenseInstallationId } from '../licenseService.js';
import { notifyUser } from '../context.js';

const MAX_CHAIN = 500;
const DEVICE = 'update.device', COMMAND = 'update.command', HEAD = 'update.head';
const statuses = new Set(['idle', 'scheduled', 'delivered', 'downloading', 'verifying', 'ready', 'saving', 'restarting', 'updated', 'delayed', 'failed', 'cancelled']);
export interface UpdateCampaignDeps {
  getPrisma: () => any; updatePublicKeyHex?: string; installationId?: () => Promise<string>;
  broadcast: (event: string, payload: unknown) => void;
}
const rowId = (type: string, id: string) => `${type}:${id}`;
const valueOf = (row: any) => { try { return JSON.parse(row.value); } catch { return null; } };
/**
 * Назначение обновлений — только владелец, из Studio — Владелец (решение владельца от 9 ноября 2026:
 * у администратора доступа к обновлениям нет). Права не выводятся из должности: нужен вход владельца.
 */
const manager = (req: any, res: any, next: () => void) => {
  if (req.authUser?.role !== 'OWNER') return res.status(403).json({ error: 'Обновлениями Flux управляет только владелец.' });
  next();
};

export function registerUpdateCampaignRoutes(app: Express, deps: UpdateCampaignDeps) {
  const inst = deps.installationId || licenseInstallationId;
  const setting = async (db: any, key: string, id: string, value: any) => db.appSetting.upsert({ where: { id: rowId(key, id) },
    create: { id: rowId(key, id), key, userId: null, value: JSON.stringify(value) }, update: { value: JSON.stringify(value) } });
  // Цепочка назначений устройства читается от головы назад: голова лежит в своей
  // строке (она меняется в той же транзакции, что и запись команды), а каждая
  // команда называет предыдущую. Раньше каждые десять секунд каждое устройство
  // читало ВСЕ команды компании, а за пять тысяч команд все получали отказ.
  const commandOf = async (db: any, id: string) => valueOf(await db.appSetting.findUnique({ where: { id: rowId(COMMAND, id) } }));
  const deviceChain = async (db: any, scope: string, deviceId: string, userId: string) => {
    const head = await db.appSetting.findUnique({ where: { id: rowId(HEAD, `${deviceId}:${userId}`) } });
    const ordered: { envelope: SignedUpdateCommand; command: UpdateCommand }[] = [], seen = new Set<string>();
    let id: string | null = head?.value || null;
    while (id) {
      if (seen.has(id)) throw new Error('В истории назначений найден повтор.');
      if (seen.size >= MAX_CHAIN) throw new Error('История назначений устройства требует обслуживания.');
      seen.add(id);
      const envelope = await commandOf(db, id) as SignedUpdateCommand | null;
      const command = envelope ? verifyUpdateCommand(envelope, { inst: scope, keyHex: deps.updatePublicKeyHex }) : null;
      const target = command?.targets.find(t => t.deviceId === deviceId && t.userId === userId);
      // Голова указывает на команду, которой нет: её подменили между чтением и записью
      if (!envelope || !command || !target) throw new Error(ordered.length ? 'История назначений устройства повреждена.' : 'CONFLICT');
      ordered.push({ envelope, command }); id = target.previous;
    }
    return ordered.reverse();
  };
  /** Только текущее назначение каждого устройства: списку устройств вся цепочка не нужна */
  const currentCommands = async (db: any, scope: string) => {
    const heads = await db.appSetting.findMany({ where: { key: HEAD, userId: null }, take: 10001 });
    const byId = new Map<string, { envelope: SignedUpdateCommand; command: UpdateCommand }>();
    const ids = [...new Set<string>(heads.map((h: any) => String(h.value)))];
    for (let i = 0; i < ids.length; i += 200) {
      const rows = await db.appSetting.findMany({ where: { id: { in: ids.slice(i, i + 200).map(x => rowId(COMMAND, x)) } } });
      for (const row of rows) {
        const envelope = valueOf(row) as SignedUpdateCommand | null, command = envelope ? verifyUpdateCommand(envelope, { inst: scope, keyHex: deps.updatePublicKeyHex }) : null;
        if (envelope && command) byId.set(command.id, { envelope, command });
      }
    }
    return new Map<string, { envelope: SignedUpdateCommand; command: UpdateCommand } | undefined>(heads.map((h: any) => [String(h.id).slice(HEAD.length + 1), byId.get(String(h.value))]));
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
      const chain = await deviceChain(db, scope, proof.deviceId, actor);
      res.json({ inst: scope, commands: chain.map(x => x.envelope) });
    } catch { res.status(503).json({ error: 'Не удалось подтвердить состояние обновления.' }); }
  });

  app.get('/api/updates/devices/:deviceId/commands', async (req: any, res) => {
    try {
      if (!req.authUser?.id) return res.status(401).json({ error: 'Войдите в программу.' });
      const scope = await inst();
      res.json({ inst: scope, commands: (await deviceChain(deps.getPrisma(), scope, req.params.deviceId, req.authUser.id)).map(x => x.envelope) });
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
      const db = deps.getPrisma(), scope = await inst(), heads = await currentCommands(db, scope);
      const users = await db.user.findMany({ select: { id: true, name: true, symbol: true, isActive: true } });
      const devices = (await deviceRows(db)).filter((d: any) => d.inst === scope).map((d: any) => {
        const currentItem = heads.get(`${d.deviceId}:${d.userId}`), current = currentItem?.command;
        const person = users.find((u: any) => u.id === d.userId);
        return { deviceId: d.deviceId, userId: d.userId, name: person?.name || 'Профиль удалён', symbol: person?.symbol || '',
          isActive: person?.isActive !== false && !!person, version: d.version || '', platform: d.platform, arch: d.arch,
          lastSeen: d.lastSeen, offline: Date.now() - d.lastSeen > 180000,
          status: current?.action === 'cancel' ? 'cancelled' : current && d.commandId !== current.id ? 'scheduled' : d.status, code: d.code || '',
          commandId: current?.id || null, action: current?.action || null, deadline: current?.deadline || null, targetVersion: current?.version || null,
          commandRelease: current ? { version: current.version, generation: current.generation, sha256: current.sha256, releaseSignature: currentItem!.envelope.releaseSignature } : null };
      });
      // Свежие по номеру версии, а не по дате публикации: хотфикс старой ветки не вытесняет новую
      const releases = newestFirst(await db.appUpdate.findMany({ where: { state: 'published' } })).slice(0, 30).filter((r: any) => readUpdateSignature(r.signature, deps.updatePublicKeyHex)).map((r: any) => ({ version: r.version, generation: r.generation, signature: r.signature, sha256: r.sha256 }));
      res.json({ inst: scope, devices, releases });
    } catch { res.status(503).json({ error: 'Состояния устройств недоступны. Повторите позже.' }); }
  });

  app.post('/api/updates/campaigns', manager, async (req: any, res) => {
    try {
      const scope = await inst(), envelope = req.body as SignedUpdateCommand, c = verifyUpdateCommand(envelope, { inst: scope, keyHex: deps.updatePublicKeyHex });
      const grant = readUpdateDelegation(envelope?.delegation, deps.updatePublicKeyHex);
      if (!c || !grant || grant.expiresAt <= Date.now() || c.actor !== req.authUser.id || Math.abs(c.issuedAt - Date.now()) > 120000) return res.status(400).json({ error: 'Назначение не подтверждено разрешением владельца.' });
      const db = deps.getPrisma(), r = c.action === 'schedule' ? await release(db, c.version) : null;
      if (r && (r.generation !== c.generation || r.sha256 !== c.sha256 || r.signature !== envelope.releaseSignature)) return res.status(409).json({ error: 'Выпуск изменился. Обновите список.' });
      const devices = await deviceRows(db);
      const existing = await db.appSetting.findUnique({ where: { id: rowId(COMMAND, c.id) } });
      if (existing) return existing.value === JSON.stringify(envelope) ? res.json({ success: true, id: c.id }) : res.status(409).json({ error: 'Номер задания уже занят.' });
      for (const t of c.targets) {
        const d = devices.find((d: any) => d.deviceId === t.deviceId && d.userId === t.userId && d.inst === scope);
        if (!d) return res.status(409).json({ error: 'Устройство или его профиль изменились. Обновите список.' });
        if (c.action === 'schedule' && compareVersions(c.version, d.version) <= 0) return res.status(409).json({ error: 'Выбрано устройство с актуальной или более новой версией.' });
        const head = (await deviceChain(db, scope, t.deviceId, t.userId)).at(-1)?.command;
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
