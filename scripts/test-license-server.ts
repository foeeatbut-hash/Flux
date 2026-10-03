/** Настоящая SQLite: подписи из БД, конкурирующие активации, отзыв и middleware чтения. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setPrisma } from '../server/context';
import { configureLicenseService, licenseInstallationId, licenseForUser, activatePersonKey, activateRevocations, invalidateLicenseCache, personLicenseMiddleware } from '../server/licenseService';
import { signLicense, readLicense, publicHexOf } from '../license/node/core';
import { signRevocations } from '../license/node/revocation';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { PrismaClient } = require('@prisma/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-license-test-'));
const file = path.join(directory, 'license.sqlite');
const sqlite = new Database(file);
sqlite.exec('CREATE TABLE "AppSetting" ("id" TEXT PRIMARY KEY NOT NULL, "key" TEXT NOT NULL, "userId" TEXT, "value" TEXT NOT NULL, "updatedAt" DATETIME NOT NULL DEFAULT current_timestamp); CREATE UNIQUE INDEX "AppSetting_key_userId_key" ON "AppSetting"("key", "userId")');
sqlite.close();
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
const privateKey = crypto.createPrivateKey(fs.readFileSync(path.join(process.cwd(), 'scripts/fixtures/license-test-key.txt')));
let now = 1_900_000_000_000;
const employee = { symbol: 'Иванов', role: 'ENGINEER' };
let checks = 0;
const check = (name: string, value: unknown) => { assert.ok(value, name); checks++; console.log('✓', name); };
const key = (inst: string, symbol: string, exp: number) => signLicense({ inst, org: 'Компания', logins: [symbol], exp, iat: now - 1000 }, privateKey);

async function middlewareResult(method: string, route: string, user = employee): Promise<number> {
  let status = 200;
  const response: any = { status: (n: number) => { status = n; return response; }, json: () => response };
  const middleware = personLicenseMiddleware({ allowed: (_method, p) => p.startsWith('/api/license/'), readOnlyPost: p => p === '/api/office/read' });
  await middleware({ method, path: route, authUser: user } as any, response, () => {});
  return status;
}

(async () => {
  try {
    setPrisma(prisma);
    process.env.FLUX_TEST_LICENSE = '1';
    configureLicenseService({ trustedNow: () => now, fromSource: true });
    const [inst, secondInst] = await Promise.all([licenseInstallationId(), licenseInstallationId()]);
    check('параллельный первый старт получает один номер установки', inst === secondInst && (await prisma.appSetting.count({ where: { key: 'license.install_id' } })) === 1);
    check('сотрудник без лицензии не читает рабочие данные', await middlewareResult('GET', '/api/tags') === 402);
    check('владелец работает без лицензии сотрудника', (await licenseForUser({ role: 'OWNER' })).licensed);
    await assert.rejects(() => activatePersonKey(key('чужая-установка', employee.symbol, now + 10000)), /другой установки/);
    check('другая установка отклоняется', true);
    const one = key(inst, employee.symbol, now + 10000);
    const two = key(inst, 'Петров', now + 20000);
    await Promise.all([activatePersonKey(one), activatePersonKey(two)]);
    const row = await prisma.appSetting.findUnique({ where: { id: 'flux-person-license-keys' } });
    check('параллельная активация сохраняет оба ключа', JSON.parse(row.value).length === 2);
    check('подписанный ключ активирует нужного сотрудника', (await licenseForUser(employee)).licensed);
    await activatePersonKey(one);
    check('повторная активация не дублирует выпуск', JSON.parse((await prisma.appSetting.findUnique({ where: { id: 'flux-person-license-keys' } })).value).length === 2);
    const edited = one.split('.');
    const payload = JSON.parse(Buffer.from(edited[1], 'base64url').toString()); payload.logins.push('злоумышленник');
    edited[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
    await prisma.appSetting.update({ where: { id: 'flux-person-license-keys' }, data: { value: JSON.stringify([edited.join('.'), two]) } });
    invalidateLicenseCache();
    check('подмена логина в БД не даёт лицензию', !(await licenseForUser({ symbol: 'злоумышленник' })).licensed);
    await prisma.appSetting.update({ where: { id: 'flux-person-license-keys' }, data: { value: JSON.stringify([one, two]) } });
    invalidateLicenseCache();
    now += 11000;
    check('истечение срока проверяется при каждом запросе без истечения кэша', (await licenseForUser(employee)).readOnly);
    const ownerAfterExpiry = await licenseForUser({ role: 'OWNER' });
    check('истечение лицензии сотрудника не ограничивает владельца', ownerAfterExpiry.licensed && !ownerAfterExpiry.readOnly);
    check('просроченный сотрудник читает', await middlewareResult('GET', '/api/tags') === 200);
    check('просроченный сотрудник не пишет', await middlewareResult('PUT', '/api/tags/tag') === 402);
    check('RPC чтения разрешён явным списком', await middlewareResult('POST', '/api/office/read') === 200);
    check('произвольный POST не считается чтением', await middlewareResult('POST', '/api/tags/search') === 402);
    const renewed = key(inst, employee.symbol, now + 50000);
    await activatePersonKey(renewed);
    check('продление сразу восстанавливает запись', await middlewareResult('PUT', '/api/tags/tag') === 200);
    const id = readLicense(renewed, publicHexOf(privateKey))!.id;
    const revoke = signRevocations({ inst, ids: [id], seq: 1, iat: now }, privateKey);
    await activateRevocations(revoke);
    check('отозванная действующая лицензия больше не работает', !(await licenseForUser(employee)).licensed);
    const ownerAfterRevocation = await licenseForUser({ role: 'OWNER' });
    check('отзыв лицензии сотрудника не ограничивает владельца', ownerAfterRevocation.licensed && !ownerAfterRevocation.readOnly);
    await assert.rejects(() => activateRevocations(signRevocations({ inst, ids: [], seq: 2, iat: now }, privateKey)), /вернуть/);
    check('новый список не возвращает ранее отозванные ключи', true);
    await activateRevocations(signRevocations({ inst, ids: [id, 'другой'], seq: 2, iat: now }, privateKey));
    await assert.rejects(() => activateRevocations(revoke), /старый/);
    check('старый подписанный список не откатывает отзыв', true);
    await prisma.appSetting.delete({where:{id:'flux-license-revocations'}});
    process.env.FLUX_TEST_LICENSE_AUTO = '1';
    configureLicenseService({ trustedNow: () => now, fromSource: false, automaticTestLicense: true });
    check('переменная тестовой лицензии не действует в portable', !(await licenseForUser({ symbol: 'Петров' })).licensed);
    setPrisma(prisma);
    configureLicenseService({ trustedNow: () => now, fromSource: true });
    check('смена БД перечитывает номер установки', await licenseInstallationId() === inst);
    check('автотестовый доступ по умолчанию выключен даже в исходниках', !(await licenseForUser({symbol:'нет-лицензии'})).licensed);
    configureLicenseService({trustedNow:()=>now,fromSource:true,automaticTestLicense:true});
    check('явный исходный режим для тестов не пишет лицензию в БД', (await licenseForUser({symbol:'нет-лицензии'})).testMode === true && (await prisma.appSetting.findMany()).every((row:any)=>!row.value.includes('нет-лицензии')));
    console.log(`${checks} проверок пройдено`);
  } finally { await prisma.$disconnect(); fs.rmSync(directory, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
