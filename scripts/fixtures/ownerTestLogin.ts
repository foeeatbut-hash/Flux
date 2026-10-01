/** Вход проверочным ключом: только исходный сервер с FLUX_TEST_OWNER=1. */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
export async function ownerTestLogin(base: string): Promise<{ token: string; user: any }> {
  const response = await fetch(base + '/api/owner/challenge');
  const challenge = await response.json() as any;
  if (!response.ok || !challenge.message) throw new Error('Проверочный сервер должен принимать вход владельца (FLUX_TEST_OWNER=1), а не portable');
  const key = crypto.createPrivateKey(fs.readFileSync(path.join(__dirname, 'owner-test-key.txt')));
  const sig = crypto.sign(null, Buffer.from(challenge.message, 'utf8'), key).toString('base64');
  const login = await fetch(base + '/api/owner/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce: challenge.nonce, sig }) });
  const result = await login.json() as any;
  if (!login.ok || !result.token || result.user?.role !== 'OWNER') throw new Error('Проверочный вход владельца не выполнен');
  return result;
}
