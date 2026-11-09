/**
 * Резервные копии: ввод keep, отбор файлов, устойчивость к плохому файлу,
 * одинаковые названия проектов, остатки .pending-*, чтение настроек.
 * База подменена объектом: проверяется только логика архива.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'node:assert/strict';
import { setPrisma } from '../server/context';
import { initBackups, parseKeep, sanitizeName, uniqueProjectNames } from '../server/backup';

const Database = require('better-sqlite3');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-backup-fixes-'));
  let backups: ReturnType<typeof initBackups> | undefined;
  try {
    // 68: пусто, null и мусор — не значение 1
    assert.equal(parseKeep(null), null);
    assert.equal(parseKeep(''), null);
    assert.equal(parseKeep('  '), null);
    assert.equal(parseKeep(undefined), null);
    assert.equal(parseKeep('abc'), null);
    assert.equal(parseKeep(NaN), null);
    assert.equal(parseKeep(7), 7);
    assert.equal(parseKeep('5'), 5);
    assert.equal(parseKeep(500), 90);
    assert.equal(parseKeep(0), 1);
    console.log('✓ keep: пусто и null не превращаются в 1');

    // 71: зарезервированные имена Windows и длинные имена
    assert.equal(sanitizeName('CON', 'x'), '_CON');
    assert.equal(sanitizeName('nul.txt', 'x'), '_nul.txt');
    assert(sanitizeName('а'.repeat(400) + '.pdf', 'x').length <= 120);
    assert(sanitizeName('а'.repeat(400) + '.pdf', 'x').endsWith('.pdf'));
    // 70: одинаковые названия проектов
    const names = uniqueProjectNames([{ id: 'aaaaaaaa-1', name: 'Цех' }, { id: 'bbbbbbbb-2', name: 'цех' }, { id: 'cccccccc-3', name: 'Цех' }]);
    assert.equal(new Set([...names.values()].map(v => v.toLowerCase())).size, 3);
    console.log('✓ имена: зарезервированные и длинные, одинаковые проекты различимы');

    const source = path.join(dir, 'source.sqlite');
    const w = new Database(source); w.exec('CREATE TABLE t (a)'); w.close();
    const b64 = (t: string) => Buffer.from(t).toString('base64');
    const files: any[] = [
      { id: 'f1', name: 'a.txt', folderId: 'fo1', scope: 'SHARED', ownerId: null, content: b64('A') },
      { id: 'f2', name: 'A.txt', folderId: 'fo1', scope: 'SHARED', ownerId: null, content: b64('B') },
      { id: 'f3', name: 'CON', folderId: 'fo1', scope: 'SHARED', ownerId: null, content: b64('C') },
      { id: 'f4', name: 'deleted.txt', folderId: 'fo1', scope: 'SHARED', ownerId: null, content: b64('D'), deletedAt: new Date() },
      { id: 'f5', name: 'chat.txt', folderId: null, scope: 'SHARED', ownerId: null, content: b64('E'), type: 'CHAT_FILE' },
      { id: 'f6', name: 'моё.txt', folderId: null, scope: 'PERSONAL', ownerId: 'u1', content: b64('F') },
      { id: 'f7', name: 'чужое.txt', folderId: null, scope: 'PERSONAL', ownerId: 'u2', content: b64('G') },
      { id: 'f8', name: 'a'.repeat(100) + '.txt', folderId: 'fo1', scope: 'SHARED', ownerId: null, content: b64('H') },
    ];
    let settingsError = false;
    let keepStored: any = 14;
    let contentSelectedForAll = false;
    const prisma = {
      appSetting: { findFirst: async () => { if (settingsError) throw new Error('база недоступна'); return { value: JSON.stringify({ enabled: true, keep: keepStored }) }; } },
      project: { findMany: async () => [{ id: 'p1', name: 'Цех' }, { id: 'p2', name: 'цех' }] },
      folder: { findMany: async () => [{ id: 'fo1', name: 'Док', parentId: null, projectId: 'p1' }] },
      user: { findMany: async () => [{ id: 'u1', name: 'Иван' }, { id: 'u2', name: 'Пётр' }] },
      fileChunk: { findMany: async () => [] },
      tag: { findMany: async () => [] },
      equipmentSystem: { findMany: async () => [] },
      fileNode: {
        findMany: async (q: any) => {
          if (q?.select?.content) contentSelectedForAll = true;
          return files.filter(f => !f.deletedAt && f.type !== 'CHAT_FILE').map(({ content, ...rest }) => rest);
        },
        findUnique: async (q: any) => ({ content: files.find(f => f.id === q.where.id)?.content ?? null }),
      },
    };
    setPrisma(prisma);
    const logs: string[] = [];
    backups = initBackups({
      app: { get() {}, post() {} } as any, getPrisma: () => prisma,
      baseDataDir: dir, getDbPath: () => source, log: l => logs.push(l),
    });
    await backups.ready;
    const base = path.join(dir, 'backups');

    // остатки прерванного запуска убираются при следующем
    fs.mkdirSync(path.join(base, '.pending-old'), { recursive: true });
    fs.writeFileSync(path.join(base, '.pending-old', 'x'), '1');
    const r = await backups.runBackup('manual');
    assert(!fs.existsSync(path.join(base, '.pending-old')), '.pending-* убирается');
    const m = JSON.parse(fs.readFileSync(path.join(r.dest, 'manifest.json'), 'utf8'));
    assert.equal(m.dbIncluded, true);
    assert.equal(contentSelectedForAll, false, 'content не грузится разом');
    assert(m.sizeBytes > 0);
    console.log('✓ .pending-* убираются, размер в манифесте, content не грузится разом');

    const all: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : all.push(path.relative(r.dest, p).split(path.sep).join('/')); } };
    walk(path.join(r.dest, 'Проводник'));
    const joined = all.join('\n');
    assert(!joined.includes('deleted'), 'удалённые не попадают');
    assert(!joined.includes('chat'), 'чат-файлы не попадают');
    assert(joined.includes('Личные/Иван/моё.txt') && joined.includes('Личные/Пётр/чужое.txt'), 'личные по владельцам');
    // a.txt и A.txt — разные файлы даже без учёта регистра; CON переименован, не пропущен
    assert.equal(all.filter(x => /\/Док\/(a|A)( \(2\))?\.txt$/.test(x)).length, 2);
    assert(all.some(x => x.endsWith('/_CON')));
    assert.equal(m.explorerFailed.length, 0);
    // два проекта «Цех» — две книги
    assert.equal(fs.readdirSync(path.join(r.dest, 'Данные')).length, 2);
    console.log('✓ удалённые и чат-файлы не в архиве, личные по владельцам, имена без потерь');

    // 71: файл, который нельзя записать, пропускается и попадает в отчёт
    files.push({ id: 'f9', name: 'x.txt', folderId: 'fo1', scope: 'SHARED', ownerId: null, content: b64('Z') });
    const origWrite = fs.promises.writeFile;
    (fs.promises as any).writeFile = async (p: any, ...rest: any[]) => {
      if (String(p).endsWith('x.txt')) throw new Error('ENAMETOOLONG');
      return (origWrite as any)(p, ...rest);
    };
    let r2: any;
    try { r2 = await backups.runBackup('manual'); } finally { (fs.promises as any).writeFile = origWrite; }
    assert.equal(r2.explorerFailed.length, 1);
    assert.equal(r2.explorerFailed[0].name, 'x.txt');
    assert(fs.existsSync(path.join(r2.dest, 'manifest.json')));
    console.log('✓ один плохой файл не обрывает архив, попадает в отчёт');

    // 68 + ротация: пустой keep в сохранённых настройках не стирает архивы
    const before = fs.readdirSync(base).filter(n => n.startsWith('АРХИВ-')).length;
    keepStored = null;
    await backups.runBackup('manual');
    const after = fs.readdirSync(base).filter(n => n.startsWith('АРХИВ-')).length;
    assert.equal(after, before + 1, 'архивы не потеряны');
    console.log('✓ сохранённый пустой keep не запускает удаление архивов');

    // 75: при недоступной базе настроек архив не создаётся по умолчанию
    settingsError = true;
    await assert.rejects(backups.runBackup('manual'), /база недоступна/);
    settingsError = false;
    console.log('✓ сбой чтения настроек останавливает архив');
  } finally {
    backups?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
