#!/usr/bin/env node
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const metadataPath = path.resolve(process.env.FLUX_REMAINING_LIVE_METADATA || path.join(os.tmpdir(), 'flux-remaining-live.json'));
const stateDir = process.argv[2] ? path.resolve(process.argv[2]) : '';
const fail = (message) => { throw new Error(message); };

if (!stateDir) fail('Usage: node scripts/fixtures/remaining-collaboration/seed-mail.mjs <private-live-state-directory>');
const state = JSON.parse(readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
const fixture = JSON.parse(readFileSync(metadataPath, 'utf8'));
if (state.kind !== 'flux-remaining-live' || !/^flux_[a-z0-9_]+_fixture(?:_|$)/i.test(state.databaseName || '') || state.servers?.length !== 2) fail('Expected the private remaining-live fixture runner state.');
if (fixture.kind !== 'flux-remaining-live-fixture' || fixture.databaseName !== state.databaseName) fail('Fixture metadata does not match the private runner state.');
const admin = fixture.accounts?.find((a) => a.role === 'ADMIN');
if (!admin?.id) fail('Synthetic fixture ADMIN is missing.');

// The runner stores the dedicated disposable URL only in the private server data directory.
const config = JSON.parse(readFileSync(path.join(stateDir, 'server-1', 'config.json'), 'utf8'));
const databaseUrl = process.env.FLUX_REMAINING_LIVE_DATABASE_URL;
if (!databaseUrl) fail('Set FLUX_REMAINING_LIVE_DATABASE_URL explicitly; no database config fallback is allowed.');
const endpoint = new URL(databaseUrl);
const configuredEndpoint = new URL(config.database_url);
const endpointDb = decodeURIComponent(endpoint.pathname.slice(1));
if (!['mysql:', 'mariadb:'].includes(endpoint.protocol)) fail('Expected a MariaDB fixture URL.');
if (!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) || !endpoint.username || !endpoint.password) fail('Refusing a nonloopback database URL without fixture credentials.');
if (!/^flux_[a-z0-9_]+_fixture(?:_|$)/i.test(endpointDb) || endpointDb !== state.databaseName ||
    endpoint.hostname !== configuredEndpoint.hostname || endpoint.port !== configuredEndpoint.port ||
    endpointDb !== decodeURIComponent(configuredEndpoint.pathname.slice(1))) fail('Refusing a database URL that does not match the private runner fixture.');
const { PrismaClient } = require('@prisma/client-mysql');
const { PrismaMariaDb } = require('@prisma/adapter-mariadb');
const prisma = new PrismaClient({ adapter: new PrismaMariaDb(databaseUrl) });

async function main() {
  const version = await prisma.$queryRawUnsafe('SELECT VERSION() AS version, DATABASE() AS databaseName');
  if (!/mariadb/i.test(String(version?.[0]?.version || '')) || String(version?.[0]?.databaseName || '') !== endpointDb) fail('The explicit database URL did not reach the expected MariaDB fixture.');
  const owners = await prisma.$queryRawUnsafe('SELECT `id`, `role` FROM `User` WHERE `id` = ?', admin.id);
  if (owners.length !== 1 || owners[0].role !== 'ADMIN') fail('Synthetic ADMIN identity is not present in the disposable database.');

  const suffix = randomBytes(6).toString('hex');
  const sharedEmail = `collab-shared-${suffix}@flux.invalid`;
  const personalEmail = `collab-personal-${suffix}@flux.invalid`;
  const createAccount = async (scope, ownerId, email) => prisma.mailAccount.create({ data: {
    scope, ownerId, label: scope === 'SHARED' ? 'Проверочная общая' : 'Проверочная личная',
    email, displayName: 'Синтетическая проверка', imapHost: '127.0.0.1', smtpHost: '127.0.0.1',
    login: email, secret: 'inactive synthetic fixture credential', active: false,
  } });
  const shared = await createAccount('SHARED', '', sharedEmail);
  const personal = await createAccount('PERSONAL', admin.id, personalEmail);
  const folder = await prisma.mailFolder.create({ data: {
    accountId: shared.id, path: 'INBOX', name: 'Входящие', kind: 'INBOX',
    uidValidity: `fixture-${suffix}`, lastUid: 1, unread: 1, total: 1,
  } });
  const messageId = `<collab-${suffix}@flux.invalid>`;
  const threadKey = messageId;
  const bodyHtml = '<p>Синтетическое письмо для проверки.</p><script>window.__fluxMailFixturePwned = true</script><img src="https://fixture.invalid/pixel.png"><img src=x onerror="window.__fluxMailFixturePwned = true"><a href="javascript:window.__fluxMailFixturePwned=true">опасная ссылка</a><div style="position:fixed;inset:0;z-index:99999">опасное перекрытие</div>';
  const message = await prisma.mailMessage.create({ data: {
    accountId: shared.id, folderId: folder.id, uid: 1, messageId, threadKey,
    fromName: 'Синтетический отправитель', fromAddr: 'sender@flux.invalid',
    toAddrs: sharedEmail, subject: `Проверка общего ящика ${suffix}`,
    snippet: 'Синтетическое письмо с тестовым вложением.', sentAt: new Date('2026-10-04T10:00:00.000Z'),
    size: Buffer.byteLength(bodyHtml), seen: false, hasFiles: true,
    searchText: `проверка общего ящика ${suffix} синтетическое письмо тестовое вложение`,
    bodyText: 'Синтетическое содержимое письма.', bodyHtml, bodyAt: new Date('2026-10-04T10:00:00.000Z'),
  } });
  const storage = path.join(stateDir, 'server-1', 'mail-seed', suffix);
  mkdirSync(storage, { recursive: true, mode: 0o700 });
  chmodSync(storage, 0o700);
  const payload = Buffer.from(`Synthetic Flux collaboration attachment ${suffix}\n`, 'utf8');
  const filePath = path.join(storage, 'fixture.txt');
  writeFileSync(filePath, payload, { mode: 0o600, flag: 'wx' });
  chmodSync(filePath, 0o600);
  const attachment = await prisma.mailAttachment.create({ data: {
    messageId: message.id, partId: '2', fileName: `collaboration-fixture-${suffix}.txt`,
    filePath, size: payload.length, mimeType: 'text/plain', inline: false,
  } });

  const latestFixture = JSON.parse(readFileSync(metadataPath, 'utf8'));
  if (latestFixture.kind !== fixture.kind || latestFixture.databaseName !== state.databaseName) fail('Fixture metadata changed to a different runner while seeding.');
  latestFixture.mailFixture = {
    accountId: shared.id, personalAccountId: personal.id, folderId: folder.id,
    messageId: message.id, attachmentId: attachment.id, threadKey,
    attachmentPath: filePath, syntheticSuffix: suffix,
  };
  const metadataTemp = `${metadataPath}.${process.pid}.tmp`;
  writeFileSync(metadataTemp, JSON.stringify(latestFixture, null, 2), { mode: 0o600, flag: 'wx' });
  renameSync(metadataTemp, metadataPath);
  chmodSync(metadataPath, 0o600);
  console.log(JSON.stringify({
    result: 'seeded', database: endpointDb,
    sharedAccountId: shared.id, personalAccountId: personal.id,
    folderId: folder.id, messageId: message.id, attachmentId: attachment.id,
    attachmentBytes: payload.length, accountsInactive: true, maliciousHtmlProbeStored: true,
  }, null, 2));
}

main().catch((error) => { console.error(`Mail fixture seed failed: ${error?.message || error}`); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
