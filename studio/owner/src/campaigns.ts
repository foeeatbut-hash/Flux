/**
 * Назначение обновлений Flux компьютерам — только владелец, из Studio — Владелец.
 *
 * Раньше команду подписывал ключ компьютера администратора по разрешению владельца
 * (FLUXUPDAUTH1). Администраторов в этом больше нет: владелец сам собирает команду и
 * подписывает её одноразовым ключом, а разрешение на этот ключ выдаёт ключом издателя
 * тут же и на час. Формат конверта прежний, поэтому проверка на сервере и у клиентов
 * (electron/updateCommand.ts) не менялась: они получают то же, что получали раньше.
 */
import crypto from 'node:crypto';

const sign = (prefix: string, value: unknown, key: crypto.KeyObject) => {
  const body = `${prefix}.${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
  return `${body}.${crypto.sign(null, Buffer.from(body), key).toString('base64url')}`;
};

export interface CampaignTarget { deviceId: string; userId: string; previous: string | null }
export interface CampaignInput {
  inst: string; actor: string; action: 'schedule' | 'cancel'; minutes?: number;
  release: { version: string; generation: string; sha256: string; signature: string };
  targets: CampaignTarget[]; now?: number;
}
/** Не больше, чем принимает проверка разрешения (electron/updateCommand.ts) */
export const CAMPAIGN_MAX_TARGETS = 2000;

export function signCampaign(vault: any, input: CampaignInput) {
  const update = vault?.keys?.update;
  if (vault?.kind !== 'main' || !update?.privatePem) throw new Error('Нужно основное хранилище владельца: в запасном нет ключа издателя.');
  if (!input.targets.length || input.targets.length > CAMPAIGN_MAX_TARGETS) throw new Error(`Выберите от 1 до ${CAMPAIGN_MAX_TARGETS} устройств.`);
  const now = input.now ?? Date.now();
  const minutes = input.action === 'cancel' ? 0 : Number(input.minutes);
  if (input.action === 'schedule' && (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440)) throw new Error('Срок до обновления — от 5 минут до суток.');
  const device = crypto.generateKeyPairSync('ed25519');
  const deviceHex = device.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const delegation = { v: 1, id: crypto.randomUUID(), inst: input.inst, userId: input.actor, publicKey: deviceHex,
    issuedAt: now - 1000, expiresAt: now + 3600000, maxTargets: Math.max(1, input.targets.length), maxMinutes: 1440 };
  const command = { v: 1, id: crypto.randomUUID(), inst: input.inst, actor: input.actor, issuedAt: now, deadline: now + minutes * 60000,
    action: input.action, version: input.release.version, generation: input.release.generation, sha256: input.release.sha256, targets: input.targets };
  return {
    command: sign('FLUXUPDCMD1', command, device.privateKey),
    delegation: sign('FLUXUPDAUTH1', delegation, crypto.createPrivateKey(update.privatePem)),
    releaseSignature: input.release.signature,
  };
}
