/**
 * Ключ паролей почты: битый файл не заменяется молча, keySource ничего не
 * создаёт, каталог данных задаёт сервер.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'node:assert/strict';
import { seal, unseal, keySource, setSecretDataDir } from '../server/mail/secret';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-mail-secret-'));
try {
  const legacy = path.join(root, 'legacy');
  process.env.VENT_APP_DATA = legacy;

  // 90: узнать источник ключа — значит ничего не записывать
  const a = path.join(root, 'a');
  setSecretDataDir(a);
  assert.equal(keySource(), 'file');
  assert(!fs.existsSync(a), 'keySource не создаёт файлов');
  const sealed = seal('пароль');
  assert(fs.existsSync(path.join(a, 'mail.key')));
  assert.equal(unseal(sealed.secret, sealed.nonce), 'пароль');
  console.log('✓ keySource ничего не создаёт; шифрование работает');

  // 88: битый ключ не заменяется
  const b = path.join(root, 'b');
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(b, 'mail.key'), 'испорчено');
  setSecretDataDir(b);
  assert.throws(() => seal('x'), /повреждён/);
  assert.equal(fs.readFileSync(path.join(b, 'mail.key'), 'utf8'), 'испорчено', 'исходный файл на месте');
  assert(fs.readdirSync(b).some(n => n.startsWith('mail.key.bad-')), 'копия рядом');
  assert.equal(unseal(sealed.secret, sealed.nonce), '', 'расшифровка не выдаёт мусор');
  console.log('✓ битый mail.key не заменяется, копия рядом, понятная ошибка');

  // 91: ключ из прежнего каталога переезжает в заданный сервером
  fs.mkdirSync(legacy);
  fs.copyFileSync(path.join(a, 'mail.key'), path.join(legacy, 'mail.key'));
  const c = path.join(root, 'c');
  setSecretDataDir(c);
  assert.equal(unseal(sealed.secret, sealed.nonce), 'пароль');
  assert(fs.existsSync(path.join(c, 'mail.key')));
  console.log('✓ прежний ключ подхватывается при переходе на каталог сервера');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
