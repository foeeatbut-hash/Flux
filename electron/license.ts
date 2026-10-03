// Офлайн-лицензирование (криптоподпись Ed25519).
//
// Принцип защиты: приложение содержит ТОЛЬКО публичный ключ. Коды выпускает
// офлайн HTML-генератор, у которого есть приватный ключ — он остаётся у
// владельца программы и не попадает ни в exe, ни в базу, ни в репозиторий.
// Изменение данных не создаёт действительную подпись без закрытого ключа.
// Эта проверка не защищает от патча самого executable на подконтрольном
// пользователю компьютере. Публичный исходник также можно скопировать.
// Проверка выполняется в главном процессе Electron и привязана к машине.
//
// Что кладём в лицензию: отпечаток машины + срок. Проверяем: подпись, что
// отпечаток совпадает с этой машиной, что срок не истёк (по «надёжному
// времени» — перевод часов назад срок не продлевает).

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

// Публичный ключ лицензии (raw ed25519, 32 байта). Безопасно быть в открытом
// виде — это ключ ПРОВЕРКИ. Соответствующий приватный ключ подписи хранится
// только в офлайн-генераторе у владельца.
const LICENSE_PUBLIC_KEY_HEX = '034c455f3a226cfa50729e7ed45ba166f76403a738399f82b9df0c64bb3a5b2d';

const DER_PUB_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const CODE_PREFIX = 'FLUX1';

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function publicKeyObject(): crypto.KeyObject {
  const raw = Buffer.from(LICENSE_PUBLIC_KEY_HEX, 'hex');
  return crypto.createPublicKey({ key: Buffer.concat([DER_PUB_PREFIX, raw]), format: 'der', type: 'spki' });
}

// ── Отпечаток машины ──
// Берём максимально стабильный идентификатор ОС (GUID реестра / machine-id) и
// дополняем первым «железным» MAC. Хэшируем — наружу отдаём короткую форму.
function rawMachineSignals(): string {
  const parts: string[] = [];
  try {
    if (process.platform === 'win32') {
      const out = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', { encoding: 'utf-8', timeout: 4000 });
      const m = out.match(/MachineGuid\s+REG_SZ\s+([\w-]+)/i);
      if (m) parts.push('guid:' + m[1]);
    } else if (process.platform === 'linux') {
      for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try { const v = fs.readFileSync(p, 'utf-8').trim(); if (v) { parts.push('mid:' + v); break; } } catch (_) {}
      }
    } else if (process.platform === 'darwin') {
      const out = execSync('ioreg -rd1 -c IOPlatformExpertDevice', { encoding: 'utf-8', timeout: 4000 });
      const m = out.match(/IOPlatformUUID"\s*=\s*"([\w-]+)"/);
      if (m) parts.push('uuid:' + m[1]);
    }
  } catch (_) { /* fallthrough к MAC/hostname */ }

  try {
    const ifaces = os.networkInterfaces();
    const macs: string[] = [];
    for (const name of Object.keys(ifaces)) {
      for (const ni of ifaces[name] || []) {
        if (!ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') macs.push(ni.mac.toLowerCase());
      }
    }
    macs.sort();
    if (macs.length) parts.push('mac:' + macs[0]); // только первый — устойчивее к VPN/доп. адаптерам
  } catch (_) {}

  if (!parts.length) parts.push('host:' + os.hostname());
  return parts.join('|');
}

// Публичный короткий отпечаток машины (его пользователь отправляет владельцу)
export function computeMachineId(): string {
  const h = crypto.createHash('sha256').update(rawMachineSignals()).digest('hex').toUpperCase();
  // 16 hex → группы по 4: A1B2-C3D4-E5F6-7890
  return h.slice(0, 16).match(/.{4}/g)!.join('-');
}

// ── Надёжное время (анти-откат часов) ──
function anchorFiles(userDataDir: string): string[] {
  return [path.join(userDataDir, '.flux-time-anchor'), path.join(os.homedir(), '.flux-la')];
}

function readAnchor(userDataDir: string): number {
  let max = 0;
  for (const f of anchorFiles(userDataDir)) {
    try { const v = parseInt(fs.readFileSync(f, 'utf-8').trim(), 36); if (Number.isFinite(v) && v > max) max = v; } catch (_) {}
  }
  return max;
}

function writeAnchor(userDataDir: string, ms: number): void {
  for (const f of anchorFiles(userDataDir)) {
    try { fs.writeFileSync(f, Math.floor(ms).toString(36), 'utf-8'); } catch (_) {}
  }
}

// Надёжное «сейчас»: максимум из локальных часов и монотонного якоря. Перевод
// часов назад не помогает — якорь только растёт и время не уходит в прошлое.
function trustedNow(userDataDir: string): number {
  const local = Date.now();
  const anchor = readAnchor(userDataDir);
  const now = Math.max(local, anchor);
  if (now > anchor) writeAnchor(userDataDir, now);
  return now;
}

// ── Проверка кода ──
export interface LicensePayload { m: string; exp: number; iat: number; id: string; }

function verifyCodeSignature(code: string): LicensePayload | null {
  try {
    const parts = String(code || '').trim().split('.');
    if (parts.length !== 3 || parts[0] !== CODE_PREFIX) return null;
    const payloadB64 = parts[1];
    const sig = b64urlDecode(parts[2]);
    const ok = crypto.verify(null, Buffer.from(payloadB64), publicKeyObject(), sig);
    if (!ok) return null;
    const payload = JSON.parse(b64urlDecode(payloadB64).toString('utf-8'));
    if (!payload || typeof payload.m !== 'string' || typeof payload.exp !== 'number') return null;
    return payload as LicensePayload;
  } catch (_) {
    return null;
  }
}

const stateFile = (userDataDir: string) => path.join(userDataDir, '.flux-license');

export interface LicenseStatus {
  licensed: boolean;
  machineId: string;
  expiresAt: number | null;  // unix ms
  daysLeft: number | null;
  reason: '' | 'none' | 'invalid' | 'wrong_machine' | 'expired';
}

// Текущий статус лицензии на этой машине
export function licenseStatus(userDataDir: string): LicenseStatus {
  const machineId = computeMachineId();
  let code = '';
  try { code = fs.readFileSync(stateFile(userDataDir), 'utf-8').trim(); } catch (_) {}
  if (!code) return { licensed: false, machineId, expiresAt: null, daysLeft: null, reason: 'none' };

  const payload = verifyCodeSignature(code);
  if (!payload) return { licensed: false, machineId, expiresAt: null, daysLeft: null, reason: 'invalid' };
  if (payload.m !== machineId) return { licensed: false, machineId, expiresAt: null, daysLeft: null, reason: 'wrong_machine' };

  const now = trustedNow(userDataDir);
  const expMs = payload.exp * 1000;
  if (expMs <= now) return { licensed: false, machineId, expiresAt: expMs, daysLeft: 0, reason: 'expired' };

  const daysLeft = Math.ceil((expMs - now) / 86400000);
  return { licensed: true, machineId, expiresAt: expMs, daysLeft, reason: '' };
}

// Активация введённого кода. Возвращает статус (licensed=true при успехе).
export function activateLicense(userDataDir: string, code: string): LicenseStatus {
  const machineId = computeMachineId();
  const payload = verifyCodeSignature(code);
  if (!payload) return { licensed: false, machineId, expiresAt: null, daysLeft: null, reason: 'invalid' };
  if (payload.m !== machineId) return { licensed: false, machineId, expiresAt: null, daysLeft: null, reason: 'wrong_machine' };
  const now = trustedNow(userDataDir);
  const expMs = payload.exp * 1000;
  if (expMs <= now) return { licensed: false, machineId, expiresAt: expMs, daysLeft: 0, reason: 'expired' };

  try { fs.writeFileSync(stateFile(userDataDir), String(code).trim(), 'utf-8'); } catch (_) {}
  writeAnchor(userDataDir, now);
  const daysLeft = Math.ceil((expMs - now) / 86400000);
  return { licensed: true, machineId, expiresAt: expMs, daysLeft, reason: '' };
}
