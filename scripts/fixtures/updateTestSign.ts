/**
 * Подпись выпуска ПРОВЕРОЧНЫМ ключом — только для наборов проверок.
 *
 * Ключ в update-test-key.txt открыт всем и настоящим не является: собранная
 * программа его не знает и такой выпуск не поставит никогда. Сервер,
 * запущенный из исходников (tsx server.ts), принимает его при публикации,
 * чтобы наборы могли пройти путь «загрузил — опубликовал — скачал».
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function testSignature(file: Buffer, version: string): string {
  const key = crypto.createPrivateKey(fs.readFileSync(path.join(__dirname, 'update-test-key.txt'), 'utf-8'));
  const manifest = { version, size: file.length, sha256: crypto.createHash('sha256').update(file).digest('hex'), iat: Date.now() };
  const signed = `FLUXUPD1.${b64url(JSON.stringify(manifest))}`;
  return `${signed}.${b64url(crypto.sign(null, Buffer.from(signed), key))}`;
}
