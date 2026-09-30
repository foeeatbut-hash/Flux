#!/usr/bin/env node
/**
 * Подпись выпусков Flux ключом владельца программы.
 *
 * Запускается ТОЛЬКО на компьютере владельца. Закрытый ключ не должен попадать
 * ни в репозиторий, ни в сборку, ни в CI, ни в общую базу компании: у кого он
 * есть, тот может разослать всем свою программу под видом обновления.
 *
 *   node tools/update-sign.mjs keygen [путь-к-ключу]
 *       Один раз. Создаёт закрытый ключ (по умолчанию ~/.flux/update-key.pem,
 *       права 600) и вписывает открытый в electron/updateKey.ts. Если ключ уже
 *       есть — не перезаписывает, а только вписывает его открытую половину.
 *       После этого соберите выпуск: собранные раньше версии без ключа
 *       обновления не принимают вовсе.
 *
 *   node tools/update-sign.mjs sign <Flux-x.y.z-x64.exe> [версия] [путь-к-ключу]
 *       Для каждого выпуска. Рядом с exe появляется <exe>.flux-sig — его
 *       прикладывают в окне «Опубликовать обновление». Версия берётся из имени
 *       файла, если не указана.
 *
 * Ключ обязательно сохраните в надёжном месте (второй носитель): потерянный
 * ключ значит, что следующий выпуск придётся ставить всем вручную.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const PREFIX = 'FLUXUPD1';
const here = path.dirname(fileURLToPath(import.meta.url));
const KEY_TS = path.join(here, '..', 'electron', 'updateKey.ts');
const DEFAULT_KEY = path.join(os.homedir(), '.flux', 'update-key.pem');

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function publicHex(privateKey) {
  const der = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32).toString('hex');
}

function loadKey(file) {
  if (!fs.existsSync(file)) throw new Error(`Ключ не найден: ${file}. Сначала: node tools/update-sign.mjs keygen`);
  return crypto.createPrivateKey(fs.readFileSync(file, 'utf-8'));
}

function keygen(file = DEFAULT_KEY) {
  let key;
  if (fs.existsSync(file)) {
    key = loadKey(file);
    console.log(`Ключ уже есть, не перезаписываю: ${file}`);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const pair = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(file, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    key = pair.privateKey;
    console.log(`Создан закрытый ключ: ${file}`);
    console.log('Сохраните копию на отдельном носителе. В репозиторий и CI — никогда.');
  }
  const hex = publicHex(key);
  const src = fs.readFileSync(KEY_TS, 'utf-8');
  const next = src.replace(/export const UPDATE_PUBLIC_KEY_HEX = '[0-9a-f]*';/, `export const UPDATE_PUBLIC_KEY_HEX = '${hex}';`);
  if (next === src && !src.includes(hex)) throw new Error('Не нашёл строку UPDATE_PUBLIC_KEY_HEX в electron/updateKey.ts');
  fs.writeFileSync(KEY_TS, next);
  console.log(`Открытый ключ вписан в electron/updateKey.ts: ${hex}`);
}

function sign(exe, version, file = DEFAULT_KEY) {
  if (!exe || !fs.existsSync(exe)) throw new Error(`Нет файла выпуска: ${exe || '(не указан)'}`);
  // Из имени берутся только три числа: «Flux-1.18.0-x64.exe» — это 1.18.0, а не «1.18.0-x64»
  const v = version || (path.basename(exe).match(/(\d+\.\d+\.\d+)/) || [])[1];
  if (!v) throw new Error('Не удалось понять версию из имени файла — укажите её вторым доводом.');
  const buf = fs.readFileSync(exe);
  if (buf[0] !== 0x4d || buf[1] !== 0x5a) throw new Error('Это не exe (нет сигнатуры MZ).');
  const manifest = { version: v, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), iat: Date.now() };
  const payload = b64url(JSON.stringify(manifest));
  const signed = `${PREFIX}.${payload}`;
  const sig = b64url(crypto.sign(null, Buffer.from(signed), loadKey(file)));
  const out = `${exe}.flux-sig`;
  fs.writeFileSync(out, `${signed}.${sig}\n`);
  console.log(`Подписан выпуск ${v} (${Math.round(buf.length / 1048576)} МБ, SHA-256 ${manifest.sha256.slice(0, 16)}…)`);
  console.log(`Подпись: ${out}`);
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === 'keygen') keygen(args[0]);
  else if (cmd === 'sign') sign(args[0], args[1], args[2]);
  else {
    console.log('node tools/update-sign.mjs keygen [ключ]\nnode tools/update-sign.mjs sign <exe> [версия] [ключ]');
    process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
