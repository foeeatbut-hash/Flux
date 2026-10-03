import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'node:assert/strict';
import { assertHealthySqlite, snapshotSqlite, sqliteSignatureMatches } from '../server/sqliteSafety';
import { initBackups } from '../server/backup';
import { allowsLocalSetup, requiresAdministrator } from '../server/accessPolicy';

const Database = require('better-sqlite3');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-safety-test-'));
  let writer: any;
  let backups: ReturnType<typeof initBackups> | undefined;
  try {
    const broken = path.join(dir, 'broken.sqlite');
    fs.writeFileSync(broken, 'важные исходные данные');
    assert.equal(sqliteSignatureMatches(broken), false);
    assert.throws(() => assertHealthySqlite(broken), /Исходная база сохранена/);
    assert.equal(fs.readFileSync(broken, 'utf8'), 'важные исходные данные');
    const empty = path.join(dir, 'empty.sqlite');
    fs.writeFileSync(empty, '');
    assert.throws(() => assertHealthySqlite(empty), /сигнатура SQLite/);
    assert.equal(fs.statSync(empty).size, 0);
    const missing = path.join(dir, 'missing.sqlite');
    assert.throws(() => assertHealthySqlite(missing));
    assert.equal(fs.existsSync(missing), false);
    console.log('✓ повреждённые, пустые и отсутствующие базы не заменяются');

    const source = path.join(dir, 'source.sqlite');
    writer = new Database(source);
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    writer.exec("CREATE TABLE important (value TEXT); INSERT INTO important VALUES ('из журнала WAL');");
    assert(fs.statSync(source + '-wal').size > 0);
    const copy = path.join(dir, 'copy.sqlite');
    await snapshotSqlite(source, copy);
    const reader = new Database(copy, { readonly: true });
    try { assert.equal(reader.prepare('SELECT value FROM important').get().value, 'из журнала WAL'); }
    finally { reader.close(); }
    const saved = fs.readFileSync(copy);
    await assert.rejects(snapshotSqlite(source, copy));
    assert.deepEqual(fs.readFileSync(copy), saved);
    await assert.rejects(snapshotSqlite(broken, path.join(dir, 'bad-copy.sqlite')));
    assert.equal(fs.existsSync(path.join(dir, 'bad-copy.sqlite')), false);
    console.log('✓ копия включает WAL, не затирает предыдущую и проверяет целостность');

    let failExport = false;
    let backupSource = source;
    const prisma = {
      appSetting: { findFirst: async () => ({ value: JSON.stringify({ enabled: true, keep: 1 }) }) },
      project: { findMany: async () => { if (failExport) throw new Error('сбой выгрузки'); return []; } },
      folder: { findMany: async () => [] },
      fileNode: { findMany: async () => [] },
    };
    backups = initBackups({
      app: { get() {}, post() {} } as any, getPrisma: () => prisma,
      baseDataDir: dir, getDbPath: () => backupSource, log: () => {},
    });
    await backups.ready;
    const first = await backups.runBackup('manual');
    assert(fs.existsSync(path.join(first.dest, 'manifest.json')));
    failExport = true;
    await assert.rejects(backups.runBackup('manual'), /сбой выгрузки/);
    assert(fs.existsSync(path.join(first.dest, 'manifest.json')));
    failExport = false;
    assert(!fs.readdirSync(path.join(dir, 'backups')).some(n => n.startsWith('.pending-')));
    backupSource = broken;
    await assert.rejects(backups.runBackup('manual'));
    assert(fs.existsSync(path.join(first.dest, 'manifest.json')));
    backupSource = source;
    const retry = await backups.runBackup('manual');
    assert.notEqual(retry.dest, first.dest);
    assert(fs.existsSync(path.join(retry.dest, 'manifest.json')));
    console.log('✓ неудачный архив не удаляет прежний; повторная попытка завершается');

    assert(allowsLocalSetup('/api/db/config', '127.0.0.1', 'http://localhost:3000', 'localhost:3000'));
    assert(!allowsLocalSetup('/api/db/download', '127.0.0.1'));
    assert(!allowsLocalSetup('/api/db/switch', '192.168.1.2'));
    assert(!allowsLocalSetup('/api/db/switch', '127.0.0.1', 'https://foreign.example', 'localhost:3000'));
    assert(!allowsLocalSetup('/api/db/config', '127.0.0.1', 'http://foreign.example:3000', 'foreign.example:3000'));
    for (const route of ['/api/db/download', '/api/db/config', '/api/seed', '/api/backup/status']) {
      assert(requiresAdministrator(route));
    }
    console.log('✓ настройка до входа ограничена; выгрузка и служебные действия требуют администратора');
  } finally {
    backups?.stop();
    writer?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
