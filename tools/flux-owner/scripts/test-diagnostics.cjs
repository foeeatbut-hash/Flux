'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDiagnostics } = require('../src/diagnostics.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-owner-diagnostics-'));
let clock = 1700000000000;
let id = 0;
const diagnostics = createDiagnostics({ logDirectory: root, appVersion: 'test-version', platform: 'fixture-os', release: 'fixture-release', arch: 'fixture-arch', homeDirectory: '/home/fixture-user', maxFileBytes: 700, maxFiles: 3, now: () => clock, randomUUID: () => `fixture-id-${++id}` });

try {
  assert.throws(() => createDiagnostics({ logDirectory: root, maxFiles: 0 }), /maxFiles/);
  assert.throws(() => createDiagnostics({ logDirectory: root, maxFileBytes: 255 }), /maxFileBytes/);
  const longPem = `prefix\n-----BEGIN PRIVATE KEY-----\n${'private-bytes-'.repeat(1000)}\n-----END PRIVATE KEY-----\nsuffix`;
  const partialPem = `prefix -----BEGIN RSA PRIVATE KEY-----\n${'private-tail-'.repeat(1000)}`;
  assert.equal(diagnostics.redact({ text: longPem }).text, 'prefix\n[закрытый ключ скрыт]\nsuffix');
  assert.equal(diagnostics.redact({ text: partialPem }).text, 'prefix [закрытый ключ скрыт]');
  const consoleObject = { message: 'database error', response: { token: 'nested-token', error: new Error('Bearer embedded-token') }, query: 'SELECT secret user data', body: Buffer.from('file bytes'), safe: 'keep this' };
  consoleObject.loop = consoleObject;
  const cleanConsoleObject = diagnostics.redact(consoleObject);
  const cleanConsoleText = JSON.stringify(cleanConsoleObject);
  for (const secret of ['nested-token', 'embedded-token', 'SELECT secret user data', 'file bytes']) assert.equal(cleanConsoleText.includes(secret), false);
  assert.equal(cleanConsoleObject.safe, 'keep this');
  assert.equal(cleanConsoleObject.loop, '[цикл]');

  const error = new Error('connection failed: mysql://root:dbPassword@db.example/private?ssl=secret');
  error.code = 'ECONNREFUSED';
  error.cause = new Error("SQL error: ALTER USER admin IDENTIFIED BY 'anotherPassword'");
  const safe = diagnostics.redact({ url: 'mysql://owner:uriPass@127.0.0.1/db', headers: { Authorization: 'Bearer secret-token-456', 'X-Trace': 'safe' }, password: 'known-passphrase', pem: '-----BEGIN PRIVATE KEY-----\nprivate bytes\n-----END PRIVATE KEY-----', sql: "SET PASSWORD='sql-pass'", body: 'a'.repeat(500), error });
  const safeText = JSON.stringify(safe);
  for (const secret of ['uriPass', 'dbPassword', 'secret-token-456', 'known-passphrase', 'private bytes', 'sql-pass', 'anotherPassword', 'root:']) assert.equal(safeText.includes(secret), false, `redaction leaked ${secret}`);
  assert.equal(safe.body, '[содержимое не записано]');
  assert.match(safe.error.stack, /connection failed/);
  assert.equal(safe.headers['X-Trace'], 'safe');

  const operation = diagnostics.beginOperation('database.connect', { address: 'mysql://user:password@db.example/private' });
  operation.stage('challenge.request');
  clock += 17;
  operation.fail(error);
  const chronologicalFiles = ['diagnostics.jsonl.2', 'diagnostics.jsonl.1', 'diagnostics.jsonl'].map(file => path.join(root, file)).filter(file => fs.existsSync(file));
  const lines = chronologicalFiles.flatMap(file => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  const operationRows = lines.filter(line => line.operationId === operation.id);
  assert.deepEqual(operationRows.map(line => line.event), ['operation.start', 'operation.stage', 'operation.failure']);
  assert.equal(operationRows[0].operationId, operationRows[1].operationId);
  assert.equal(operationRows[1].operationId, operationRows[2].operationId);
  assert.equal(operationRows[2].durationMs, 17);
  assert.equal(operationRows[2].error.code, 'ECONNREFUSED');
  assert.equal(JSON.stringify(lines).includes('dbPassword'), false);

  for (let i = 0; i < 20; i++) diagnostics.record('fixture.event', { index: i, note: 'bounded log rotation' });
  const files = fs.readdirSync(root).filter(file => file.startsWith('diagnostics.jsonl'));
  assert.ok(files.length <= 3, 'rotation retains no more than the configured number of files');
  for (const file of files) assert.ok(fs.statSync(path.join(root, file)).size <= 700, `${file} exceeds file size bound`);
  const exportedPath = path.join(root, 'export.jsonl');
  const exported = diagnostics.exportLogs(exportedPath);
  const exportedText = fs.readFileSync(exportedPath, 'utf8');
  assert.ok(exported.bytes > 0);
  assert.match(exportedText, /"platform":"fixture-os"/);
  assert.match(exportedText, /"appVersion":"test-version"/);
  assert.equal(exportedText.includes('dbPassword'), false);
  assert.equal(exportedText.includes('private bytes'), false);

  const processEvents = new Map();
  const fakeProcess = { on: (name, handler) => processEvents.set(name, handler), removeListener: (name, handler) => { if (processEvents.get(name) === handler) processEvents.delete(name); } };
  const uninstall = diagnostics.installProcessHandlers(fakeProcess);
  assert.ok(processEvents.has('uncaughtExceptionMonitor'), 'fatal process exceptions are observed without replacing Node crash handling');
  assert.ok(processEvents.has('unhandledRejection'));
  assert.throws(() => processEvents.get('unhandledRejection')(new Error('rejected Bearer secret-token-value')), /rejected/);
  uninstall();
  assert.equal(processEvents.size, 0);
  const retainedLogs = fs.readdirSync(root).filter(file => file.startsWith('diagnostics.jsonl')).map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  assert.equal(retainedLogs.includes('Bearer secret-token-value'), false);

  diagnostics.record('huge', { message: 'x'.repeat(2000) });
  const currentLines = fs.readFileSync(diagnostics.currentFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(currentLines.some(line => line.event === 'huge' && line.diagnostic?.includes('truncated')));

  fs.appendFileSync(diagnostics.currentFile, `${JSON.stringify({ event: 'legacy.console', message: 'mysql://root:oldPassword@db.example/legacy', output: 'Bearer old-token' })}\n`);
  const legacyExportPath = path.join(root, 'legacy-export.jsonl');
  diagnostics.exportLogs(legacyExportPath);
  const legacyExport = fs.readFileSync(legacyExportPath, 'utf8');
  assert.equal(legacyExport.includes('oldPassword'), false);
  assert.equal(legacyExport.includes('Bearer old-token'), false);

  const singleFileDirectory = path.join(root, 'single-file');
  const singleFile = createDiagnostics({ logDirectory: singleFileDirectory, maxFileBytes: 256, maxFiles: 1 });
  for (let i = 0; i < 30; i++) singleFile.record('single.rotation', { index: i, note: 'x'.repeat(300) });
  const singleFiles = fs.readdirSync(singleFileDirectory);
  assert.deepEqual(singleFiles, ['diagnostics.jsonl']);
  assert.ok(fs.statSync(singleFile.currentFile).size <= 256);
  console.log('FluxOwner diagnostics: redaction, operation correlation, rotation and export passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
