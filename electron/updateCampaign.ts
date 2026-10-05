import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { signUpdateEnvelope, readUpdateDelegation, verifyUpdateCommand, verifiedDeviceChain, type SignedUpdateCommand } from './updateCommand';

export interface UpdateKeyEncryption { available(): boolean; encrypt(value: string): Buffer; decrypt(value: Buffer): string }
export function createUpdateCampaignRuntime(dir: string, version: () => string, encryption: UpdateKeyEncryption, keyHex?: string) {
  if (!encryption.available()) throw new Error('Защищённое хранение ключа обновлений недоступно на этом компьютере.');
  const file = path.join(dir, 'update-device.enc');
  let state: any;
  try { state = JSON.parse(encryption.decrypt(fs.readFileSync(file))); } catch (e: any) {
    if (e.code !== 'ENOENT') throw new Error('Не удалось прочитать сведения об обновлении на этом компьютере.');
    const keys = crypto.generateKeyPairSync('ed25519');
    state = { id: crypto.randomUUID(), key: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), assignments: {}, clock: Date.now() };
    fs.mkdirSync(dir, { recursive: true });
  }
  const privateKey = crypto.createPrivateKey(state.key);
  const publicKey = (crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
  let floor = Math.max(Number(state.clock) || 0, Date.now()), sampled = performance.now();
  const save = () => {
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    if (!encryption.available()) throw new Error('Ключ обновления не сохранён: защищённое хранение недоступно.');
    try {
      fs.writeFileSync(temp, encryption.encrypt(JSON.stringify(state)), { mode: 0o600 }); fs.renameSync(temp, file);
    } finally { fs.rmSync(temp, { force: true }); }
  };
  const now = () => {
    const tick = performance.now(); floor = Math.max(floor + Math.max(0, tick - sampled), Date.now()); sampled = tick;
    state.clock = Math.ceil(floor); return Math.ceil(floor);
  };
  save();
  return {
    identity: () => ({ deviceId: state.id, publicKey, version: version(), platform: process.platform, arch: process.arch }),
    heartbeat: (userId: string, status: string, commandId: string | null, code: string) => ({
      publicKey,
      proof: signUpdateEnvelope('FLUXUPDDEVICE1', { deviceId: state.id, userId, version: version(), platform: process.platform,
        arch: process.arch, status, commandId, code: String(code || '').slice(0, 80), at: now() }, privateKey),
    }),
    sign: (envelope: { delegation: string; releaseSignature: string; payload: any }) => {
      const delegation = readUpdateDelegation(envelope.delegation, keyHex), tick = now();
      if (!delegation || delegation.publicKey !== publicKey || tick > delegation.expiresAt) throw new Error('Разрешение на назначение обновлений недоступно или истекло.');
      const signed: SignedUpdateCommand = { command: signUpdateEnvelope('FLUXUPDCMD1', envelope.payload, privateKey),
        delegation: envelope.delegation, releaseSignature: envelope.releaseSignature };
      const command = verifyUpdateCommand(signed, { inst: delegation.inst, keyHex });
      if (!command || Math.abs(command.issuedAt - tick) > 120000) throw new Error('Задание не соответствует разрешению владельца.');
      return signed;
    },
    accept: (inst: string, userId: string, envelopes: SignedUpdateCommand[]) => {
      const key = `${inst}:${userId}`, previous = state.assignments[key];
      const latest = verifiedDeviceChain(envelopes, { inst, userId, deviceId: state.id, knownId: previous?.command.id, keyHex });
      if (!latest) {
        // Пустой ответ или удалённая строка не отменяет уже подписанное назначение.
        return previous ? { ...previous.command, remainingMs: Math.max(0, previous.command.deadline - now()) } : null;
      }
      if (previous?.command.id !== latest.command.id) {
        if (latest.command.issuedAt > now() + 120000) throw new Error('Срок задания не подтверждён: проверьте время компьютера.');
        state.assignments[key] = latest;
        try { save(); } catch (error) {
          if (previous) state.assignments[key] = previous;
          else delete state.assignments[key];
          throw error;
        }
      }
      save();
      return { ...latest.command, remainingMs: Math.max(0, latest.command.deadline - now()) };
    },
    assignment: (inst: string, userId: string) => state.assignments[`${inst}:${userId}`]?.command || null,
  };
}

let nativeRuntime: ReturnType<typeof createUpdateCampaignRuntime> | null = null;
export async function assertCampaignRestart(commandId: string, expectedVersion: string, getCommands: (deviceId: string) => Promise<{ inst: string; commands: SignedUpdateCommand[] }>) {
  if (!nativeRuntime) throw new Error('Назначение обновления не проверено.');
  const data = await getCommands(nativeRuntime.identity().deviceId);
  assertCampaignRestartState(nativeRuntime, commandId, expectedVersion, data);
}
export function assertCampaignRestartState(runtime: ReturnType<typeof createUpdateCampaignRuntime>, commandId: string, expectedVersion: string,
  data: { inst: string; commands: SignedUpdateCommand[] }, keyHex?: string) {
  const target = data.commands.flatMap(e => {
    const c = verifyUpdateCommand(e, { inst: data.inst, deviceId: runtime.identity().deviceId, keyHex });
    return c ? c.targets.filter(t => t.deviceId === runtime.identity().deviceId).map(t => ({ userId: t.userId, c })) : [];
  }).find(t => t.c.id === commandId);
  if (!target) throw new Error('Назначение удалено или не подтверждено. Перезапуск остановлен.');
  const chain = verifiedDeviceChain(data.commands, { inst: data.inst, deviceId: runtime.identity().deviceId,
    userId: target.userId, knownId: runtime.assignment(data.inst, target.userId)?.id, keyHex });
  if (!chain || chain.command.id !== commandId || chain.command.action !== 'schedule') throw new Error('История назначения не подтверждена. Перезапуск остановлен.');
  runtime.accept(data.inst, target.userId, data.commands);
  const current = runtime.assignment(data.inst, target.userId);
  if (current?.id !== commandId || current.action !== 'schedule' || current.version !== expectedVersion) throw new Error('Назначение отменено или заменено. Перезапуск остановлен.');
}

export function registerUpdateCampaignIpc(deps: {
  ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => void };
  dataDir: string; version: () => string; authorized: (event: any) => Promise<boolean>;
  encryption: UpdateKeyEncryption; authorizeSigning: (event: any, data: any) => Promise<boolean>;
}) {
  const get = () => nativeRuntime ||= createUpdateCampaignRuntime(deps.dataDir, deps.version, deps.encryption);
  const handle = (name: string, action: (...args: any[]) => any) => deps.ipcMain.handle(name, async (event, ...args) => {
    if (!await deps.authorized(event)) throw new Error('Войдите в Flux для обновления.');
    return action(...args);
  });
  handle('updater:device', () => get().identity());
  handle('updater:heartbeat-proof', (data) => get().heartbeat(String(data?.userId || ''), String(data?.status || ''), data?.commandId || null, String(data?.code || '')));
  deps.ipcMain.handle('updater:sign-command', async (event, data) => {
    if (!await deps.authorized(event) || !await deps.authorizeSigning(event, data)) throw new Error('Разрешение на назначение обновлений не подтверждено для текущего профиля.');
    return get().sign(data);
  });
  handle('updater:accept-commands', (data) => {
    if (!Array.isArray(data?.commands) || data.commands.length > 5000) throw new Error('История обновлений недоступна.');
    return get().accept(String(data?.inst || ''), String(data?.userId || ''), data.commands);
  });
}
