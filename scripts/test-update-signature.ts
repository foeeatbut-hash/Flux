/**
 * Подпись обновлений: запускается только выпуск владельца, и только новее.
 * Ключи здесь одноразовые, создаются в самом наборе.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { readUpdateSignature, updateRefusal, compareVersions } from '../electron/updateSignature';

let ok = 0, fail = 0;
const eq = (name: string, got: any, want: any) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (pass) ok++; else { fail++; console.log(`✗ ${name}\n   получено: ${JSON.stringify(got)}\n   ожидалось: ${JSON.stringify(want)}`); }
};

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const pair = () => {
  const p = crypto.generateKeyPairSync('ed25519');
  const der = p.publicKey.export({ format: 'der', type: 'spki' });
  return { priv: p.privateKey, hex: der.subarray(der.length - 32).toString('hex') };
};
const signWith = (priv: crypto.KeyObject, m: any) => {
  const signed = `FLUXUPD1.${b64url(JSON.stringify(m))}`;
  return `${signed}.${b64url(crypto.sign(null, Buffer.from(signed), priv))}`;
};

const owner = pair();
const stranger = pair();
const file = { size: 150_000_000, sha256: 'a'.repeat(64) };
const good = signWith(owner.priv, { version: '1.18.0', ...file });
const base = { signature: good, version: '1.18.0', current: '1.17.2', ...file, keyHex: owner.hex };

eq('подписанный владельцем и более новый выпуск ставится', updateRefusal(base), '');
eq('без ключа в сборке не ставится ничего', !!updateRefusal({ ...base, keyHex: '' }), true);
eq('выпуск без подписи не ставится', !!updateRefusal({ ...base, signature: '' }), true);
eq('подпись чужим ключом не принимается', !!updateRefusal({ ...base, signature: signWith(stranger.priv, { version: '1.18.0', ...file }) }), true);
eq('подменённый файл под настоящей подписью не ставится', !!updateRefusal({ ...base, sha256: 'b'.repeat(64) }), true);
eq('другой размер файла не ставится', !!updateRefusal({ ...base, size: file.size + 1 }), true);
eq('подпись другой версии не подходит', !!updateRefusal({ ...base, version: '1.19.0' }), true);
eq('откат на старую подписанную версию запрещён', !!updateRefusal({ ...base, current: '1.18.0' }), true);
eq('откат ниже текущей запрещён', !!updateRefusal({ ...base, current: '2.0.0' }), true);

// Правка описания после подписи
const parts = good.split('.');
const forged = `${parts[0]}.${b64url(JSON.stringify({ version: '1.18.0', size: 1, sha256: 'c'.repeat(64) }))}.${parts[2]}`;
eq('исправленное описание при старой подписи не проходит', readUpdateSignature(forged, owner.hex), null);
eq('мусор вместо подписи не проходит', readUpdateSignature('FLUXUPD1.abc.def', owner.hex), null);
eq('сравнение версий: 1.10.0 новее 1.9.9', compareVersions('1.10.0', '1.9.9'), 1);
eq('сравнение версий: равные', compareVersions('1.2.3', '1.2.3'), 0);

// Инструмент владельца подписывает так, как проверяет программа
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-sign-'));
const key = path.join(dir, 'k.pem');
fs.writeFileSync(key, owner.priv.export({ format: 'pem', type: 'pkcs8' }));
const exe = path.join(dir, 'Flux-1.18.0-x64.exe');
fs.writeFileSync(exe, Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(4096)]));
execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'update-sign.mjs'), 'sign', exe, '', key], { stdio: 'pipe' });
const toolSig = fs.readFileSync(`${exe}.flux-sig`, 'utf-8').trim();
const buf = fs.readFileSync(exe);
eq('подпись из tools/update-sign.mjs принимается программой', updateRefusal({
  signature: toolSig, version: '1.18.0', current: '1.17.2', size: buf.length,
  sha256: crypto.createHash('sha256').update(buf).digest('hex'), keyHex: owner.hex,
}), '');
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
