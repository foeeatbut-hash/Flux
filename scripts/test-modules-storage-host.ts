/**
 * Хранилище самостоятельной программы во Flux: главный процесс (electron/moduleStorage.ts), мост окна (modules/bridge.ts, состояние
 * страницы) и сторона окна (src/services/moduleStateStorage.ts). Диск настоящий (временная папка), журнал настоящий.
 *
 * Сам файл, предел и битый файл проверяет test-modules-storage; здесь проверено то, что вокруг: кому вообще положен диск (только
 * самостоятельной программе, по проверенному манифесту), чьи это папки (человек и область), порядок записей из разных окон,
 * отказ LIMIT/FAILED до программы и в журнал, и 1 МиБ состояния, проходящий через мост (сообщение больше 1 МиБ мост молча
 * отбрасывает, поэтому для `state-keep` у него есть запас). Каждая защита проверена мутацией.
 *
 * Запуск: npx tsx scripts/test-modules-storage-host.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { themeKeys, type ModuleManifest } from '../modules/contract';
import { createModuleBridge } from '../modules/bridge';
import { storagePath, type StorageFs } from '../modules/storage/disk';
import type { StorageScope } from '../modules/storage/model';
import { ModuleStorage } from '../electron/moduleStorage';
import { ModuleJournal } from '../electron/moduleJournal';
import { createProgramStateStore } from '../src/services/moduleStateStorage';
import { pageState } from '../src/lib/pageStateMemory';

let passed = 0;
const failures: string[] = [];
const check = (name: string, value: unknown) => { if (value) { passed++; console.log(`  ✓ ${name}`); } else { failures.push(name); console.log(`  ✗ ${name}`); } };
type Battery = { passed: string[]; failed: string[] };
type Parts = { ModuleStorage: typeof ModuleStorage; createModuleBridge: typeof createModuleBridge; createProgramStateStore: typeof createProgramStateStore };
const MIB = 1024 * 1024;
const manifestOf = (patch: Partial<ModuleManifest> = {}): ModuleManifest => ({
  id: 'notes', name: 'Заметки', version: '1.0.0', author: 'dev', contractVersion: 3, entries: ['start'], reads: [], logic: 'logic/main.ts', ui: 'page', ...patch,
});
const real = fs.promises as unknown as StorageFs;
const flaky = (over: Partial<Record<keyof StorageFs, (...a: any[]) => Promise<any>>>): StorageFs => ({ ...real, ...over }) as StorageFs;
const big = (bytes: number) => ({ t: 'a'.repeat(bytes - '{"t":""}'.length) });

async function battery(parts: Parts): Promise<Battery> {
  const result: Battery = { passed: [], failed: [] };
  const ok = (name: string, value: unknown) => { (value ? result.passed : result.failed).push(name); };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-storage-host-'));
  const root = path.join(tmp, 'program-data');
  try {
    // ── 1. Главный процесс ────────────────────────────────────────────────────
    const journal = new ModuleJournal(path.join(tmp, 'journal.json'));
    let user = 'user-1';
    const catalog = new Map<string, { manifest: ModuleManifest; scope: StorageScope }>([
      ['notes', { manifest: manifestOf(), scope: 'released' }],
      ['reader', { manifest: manifestOf({ id: 'reader', reads: ['project'] }), scope: 'released' }],
      ['launcher', { manifest: manifestOf({ id: 'launcher', entries: ['start', 'equipment'] }), scope: 'released' }],
    ]);
    let disk: StorageFs = real;
    let writtenBy = '1.2.3';
    const storage = new parts.ModuleStorage({
      root, userId: () => user, journal, writtenBy: () => writtenBy, fs: new Proxy({} as StorageFs, { get: (_t, key) => (disk as any)[key] }),
      locate: async (id, version) => { const hit = catalog.get(id); return hit && version === hit.manifest.version ? { manifest: hit.manifest, version, scope: hit.scope } : null; },
    });
    const fileOf = (id: string, scope: StorageScope, who = user) => path.join(storagePath(root, who, id, scope), 'state.json');
    const entries = () => journal.recent(50);

    ok('самостоятельная: сохранение идёт на диск', (await storage.keep('notes', '1.0.0', { a: 1 })) .ok && fs.existsSync(fileOf('notes', 'released')));
    const loaded = await storage.load('notes', '1.0.0');
    ok('и читается оттуда', loaded.ok && (loaded as any).disk === true && (loaded as any).state.a === 1);
    ok('версия Flux записана в файл для диагностики', JSON.parse(fs.readFileSync(fileOf('notes', 'released'), 'utf8')).writtenBy === '1.2.3');
    const readerKeep = await storage.keep('reader', '1.0.0', { secret: 'данные проекта' });
    ok('программа, читающая данные Flux: диска нет, сохранять некуда', readerKeep.ok && (readerKeep as any).disk === false);
    ok('и чтение ей отвечает «хранилища нет»', (await storage.load('reader', '1.0.0') as any).disk === false);
    ok('в карточке оборудования открываемая программа — не самостоятельная, диска нет', (await storage.keep('launcher', '1.0.0', { x: 1 }) as any).disk === false);
    ok('на диск ничего от них не попало', !fs.existsSync(path.join(root, require('../modules/storage/disk').userDirName(user), 'reader')) && !fs.existsSync(path.join(root, require('../modules/storage/disk').userDirName(user), 'launcher')));
    ok('неизвестная программа и чужая версия — диска нет, ничего не записано', (await storage.keep('ghost', '1.0.0', { x: 1 }) as any).disk === false && (await storage.keep('notes', '9.9.9', { x: 1 }) as any).disk === false && (await storage.load('notes', '9.9.9') as any).disk === false);
    ok('чужое состояние не подменено запросом с чужой версией', (await storage.load('notes', '1.0.0') as any).state.a === 1);

    user = 'user-2';
    ok('другой человек на этом компьютере состояния не видит', Object.keys((await storage.load('notes', '1.0.0') as any).state).length === 0);
    await storage.keep('notes', '1.0.0', { a: 2 });
    user = 'user-1';
    ok('и не затирает чужое', (await storage.load('notes', '1.0.0') as any).state.a === 1);

    catalog.set('notes', { manifest: manifestOf(), scope: 'dev' });
    ok('сборка из разработки — своя область: прежнего состояния не видит', Object.keys((await storage.load('notes', '1.0.0') as any).state).length === 0);
    await storage.keep('notes', '1.0.0', { a: 'dev' });
    ok('и пишет в свою папку', fs.existsSync(fileOf('notes', 'dev')) && JSON.parse(fs.readFileSync(fileOf('notes', 'released'), 'utf8')).state.a === 1);
    catalog.set('notes', { manifest: manifestOf(), scope: 'released' });
    ok('выпуск после сборки из разработки видит своё прежнее (смена канала область не меняет)', (await storage.load('notes', '1.0.0') as any).state.a === 1);

    user = '';
    ok('нет вошедшего человека — отказ FAILED, а не общая папка', (await storage.keep('notes', '1.0.0', { a: 3 }) as any).code === 'FAILED' && (await storage.load('notes', '1.0.0') as any).code === 'FAILED');
    user = 'user-1';

    // Предел: LIMIT с текстом, прежнее цело, журнал знает
    const atLimit = await storage.keep('notes', '1.0.0', big(MIB));
    ok('ровно 1 МиБ сохраняется', atLimit.ok && (atLimit as any).bytes === MIB);
    const over = await storage.keep('notes', '1.0.0', big(MIB + 120 * 1024)) as any;
    ok('больше 1 МиБ — LIMIT с текстом для человека', over.ok === false && over.code === 'LIMIT' && over.text === 'Хранилище программы заполнено: 1,1 МиБ из 1 МиБ');
    ok('после отказа прежнее состояние цело', (await storage.load('notes', '1.0.0') as any).bytes === MIB);
    ok('отказ записан в журнал программ тем же текстом и без содержимого', entries().some(e => e.moduleId === 'notes' && e.event === 'storage-full' && e.outcome === 'limit' && e.detail === over.text && e.userId === 'user-1'));

    // Сбой диска
    await storage.keep('notes', '1.0.0', { a: 'до сбоя' });
    disk = flaky({ rename: async () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); } });
    const failedKeep = await storage.keep('notes', '1.0.0', { a: 'при сбое' }) as any;
    ok('сбой диска — FAILED', failedKeep.ok === false && failedKeep.code === 'FAILED');
    ok('сбой записан в журнал с кодом ошибки диска, но без путей', entries().some(e => e.event === 'storage-failed' && e.outcome === 'failed' && e.detail === 'Хранилище программы не записано (EBUSY)') && !entries().some(e => e.detail.includes(tmp)));
    disk = flaky({ lstat: async () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } });
    ok('диск не отвечает на чтении — FAILED, не «пусто»', (await storage.load('notes', '1.0.0') as any).code === 'FAILED');
    disk = real;
    ok('после сбоя прежнее состояние цело', (await storage.load('notes', '1.0.0') as any).state.a === 'до сбоя');

    // Битый файл
    fs.writeFileSync(fileOf('notes', 'released'), '{"format":1,"program"');
    const afterBroken = await storage.load('notes', '1.0.0') as any;
    ok('битый файл: программа получает пустое состояние', afterBroken.ok && Object.keys(afterBroken.state).length === 0);
    ok('в журнале строка о повреждённом файле с именем отложенного', entries().some(e => e.event === 'storage-broken' && /state\.broken-/.test(e.detail)));
    ok('сам файл отложен рядом, а не удалён', fs.readdirSync(path.dirname(fileOf('notes', 'released'))).some(n => n.startsWith('state.broken-')));

    // Порядок записей: окна пишут одновременно, побеждает последнее обращение
    disk = flaky({ writeFile: async (p: string, data: string, o: any) => { const n = Number(/"i":(\d+)/.exec(data)?.[1] ?? 0); await new Promise(r => setTimeout(r, (20 - n) * 4)); return fs.promises.writeFile(p, data, o); } });
    await Promise.all(Array.from({ length: 20 }, (_, i) => storage.keep('notes', '1.0.0', { i })));
    disk = real;
    ok('20 одновременных сохранений из разных окон: остаётся последнее', (await storage.load('notes', '1.0.0') as any).state.i === 19);

    // Очистка и объём
    ok('объём области — байты состояния', (await storage.usage('notes', 'released')) === Buffer.byteLength(JSON.stringify({ i: 19 })));
    catalog.set('notes', { manifest: manifestOf(), scope: 'dev' });
    await storage.keep('notes', '1.0.0', { d: 1 });
    catalog.set('notes', { manifest: manifestOf(), scope: 'released' });
    const cleared = await storage.clear('notes', 'dev');
    ok('очистка dev: удалено', cleared.ok && (cleared as any).removed && !fs.existsSync(path.dirname(fileOf('notes', 'dev'))));
    ok('очистка dev не трогает released', (await storage.load('notes', '1.0.0') as any).state.i === 19);
    ok('очистка dev у другого человека ничего не трогает', (await (async () => { user = 'user-2'; const r = await storage.clear('notes', 'released'); user = 'user-1'; return r; })()).ok && (await storage.load('notes', '1.0.0') as any).state.i === 19);
    ok('очистка по негодному идентификатору — FAILED', (await storage.clear('../notes', 'released') as any).ok === false && (await storage.clear('', 'dev') as any).ok === false);
    ok('очистка released: папка выпуска удалена', (await storage.clear('notes', 'released') as any).removed === true && !fs.existsSync(path.dirname(fileOf('notes', 'released'))));
    ok('программа того же человека, не названная в очистке, цела', fs.existsSync(path.join(root, require('../modules/storage/disk').userDirName('user-2'))));
    ok('без вошедшего очистка и объём отказывают', await (async () => { user = ''; const r = await storage.clear('notes', 'released'); const u = await storage.usage('notes', 'released'); user = 'user-1'; return r.ok === false && u === null; })());

    // ── 2. Мост: состояние страницы ───────────────────────────────────────────
    const sent: any[] = [];
    const frame = { postMessage: (m: unknown) => sent.push(m) } as unknown as Window;
    const theme = Object.fromEntries(themeKeys.map(k => [k, '#000'])) as never;
    const env = { flux: 'module', v: 1, session: 's' };
    let reached = 0;
    const open = async (page: any, manifest: ModuleManifest = manifestOf()) => {
      const bridge = parts.createModuleBridge({ frame: () => frame, session: 's', manifest, context: () => ({ projectId: 'p', entry: 'start', entityId: null }), theme: () => theme, read: (async () => null) as never,
        page: { offerFile: async () => 'saved' as const, onBeat: () => undefined, openWindow: () => true, params: () => ({}), broadcast: () => undefined, ...page } });
      await bridge.handle({ source: frame as never, origin: 'null', data: { ...env, type: 'ready' } });
      return bridge;
    };
    const ask = async (bridge: Awaited<ReturnType<typeof open>>, data: Record<string, unknown>) => {
      sent.length = 0;
      await bridge.handle({ source: frame as never, origin: 'null', data: { ...env, id: 'q', type: 'page', ...data } });
      return sent.length ? sent[0] : null;
    };
    const keeper = (limit: number | undefined, answer: () => any = () => undefined) => open({ loadState: async () => ({ a: 1 }), keepState: async () => { reached++; return answer(); }, stateLimit: limit });
    let b = await keeper(MIB);
    ok('state-load ждёт асинхронное чтение и отдаёт данные', (await ask(b, { op: 'state-load' }))?.data?.a === 1);
    reached = 0;
    ok('состояние 1 МиБ проходит мост (сообщение чуть больше 1 МиБ не отбрасывается)', (await ask(b, { op: 'state-keep', state: big(MIB) }))?.type === 'page-result' && reached === 1);
    ok('на байт больше предела — LIMIT, до хранилища не доходит', (await (async () => { reached = 0; const r = await ask(b, { op: 'state-keep', state: big(MIB + 1) }); return r?.code === 'LIMIT' && reached === 0; })()));
    b = await keeper(256 * 1024);
    reached = 0;
    ok('у остальных программ прежний предел 256 КиБ: на байт больше — LIMIT', (await ask(b, { op: 'state-keep', state: big(256 * 1024 + 1) }))?.code === 'LIMIT' && reached === 0);
    ok('и ровно 256 КиБ проходит', (await ask(b, { op: 'state-keep', state: big(256 * 1024) }))?.type === 'page-result' && reached === 1);
    b = await open({ loadState: () => ({}), keepState: () => { reached++; } });
    reached = 0;
    ok('без поля предела — прежние 256 КиБ', (await ask(b, { op: 'state-keep', state: big(256 * 1024 + 1) }))?.code === 'LIMIT' && reached === 0);
    b = await keeper(MIB, () => ({ code: 'LIMIT' }));
    ok('отказ хранилища LIMIT доходит до программы', (await ask(b, { op: 'state-keep', state: { a: 1 } }))?.code === 'LIMIT');
    b = await keeper(MIB, () => ({ code: 'FAILED' }));
    ok('ошибка диска FAILED доходит до программы', (await ask(b, { op: 'state-keep', state: { a: 1 } }))?.code === 'FAILED');
    b = await open({ loadState: () => ({}), keepState: async () => { throw new Error('диск'); }, stateLimit: MIB });
    ok('исключение при сохранении — FAILED, а не молчание', (await ask(b, { op: 'state-keep', state: { a: 1 } }))?.code === 'FAILED');
    b = await open({ loadState: async () => { throw new Error('диск'); }, keepState: () => undefined, stateLimit: MIB });
    ok('исключение при чтении — FAILED, а не молчание', (await ask(b, { op: 'state-load' }))?.code === 'FAILED');
    b = await keeper(MIB);
    sent.length = 0;
    await b.handle({ source: frame as never, origin: 'null', data: { ...env, id: 'c', type: 'page', op: 'channel-send', data: { t: 'a'.repeat(MIB + 100) } } });
    ok('другие сообщения больше 1 МиБ мост по-прежнему отбрасывает (запас только у state-keep)', sent.length === 0);

    // ── 3. Сторона окна ───────────────────────────────────────────────────────
    const calls: Array<{ channel: string; data: any }> = [];
    let reply: any = { ok: true, disk: false };
    const g = globalThis as any;
    g.window = { electron: { ipcRenderer: { invoke: async (channel: string, data: any) => { calls.push({ channel, data }); if (reply instanceof Error) throw reply; return reply; } } } };
    pageState.clear();
    const program = { moduleId: 'notes', version: '1.0.0', userId: 'user-1', channel: 'production' };
    const store = parts.createProgramStateStore(program);
    reply = { ok: true, disk: true, state: { fromDisk: 1 }, bytes: 20 };
    ok('диск у главного процесса: окно отдаёт то, что он прочитал', (await store.load()).fromDisk === 1 && calls[0].channel === 'modules:state-load' && calls[0].data.moduleId === 'notes' && calls[0].data.version === '1.0.0');
    ok('окно не называет человека и область: решает главный процесс', !('userId' in calls[0].data) && !('scope' in calls[0].data));
    ok('сохранение на диск: ничего не уходит в память окна', (await (async () => { reply = { ok: true, disk: true, bytes: 5 }; const r = await store.keep({ x: 1 }); return r === undefined; })()) && !Object.keys(pageState.load('user-1\u0000notes\u0000production')).length);
    reply = { ok: true, disk: false };
    await store.keep({ m: 1 });
    ok('главный процесс сказал «диска нет»: состояние в памяти окна', (await store.load()).m === 1);
    ok('и память общая для окон одной программы', (await parts.createProgramStateStore(program).load()).m === 1);
    ok('«диска нет» и состояние больше 256 КиБ — LIMIT, память не тронута', (await store.keep(big(256 * 1024 + 1)))?.code === 'LIMIT' && (await store.load()).m === 1);
    reply = { ok: false, code: 'LIMIT', text: 'x', bytes: MIB + 1 };
    ok('отказ LIMIT главного процесса передаётся программе', (await store.keep({ x: 1 }))?.code === 'LIMIT');
    reply = { ok: false, code: 'FAILED' };
    ok('ошибка диска FAILED передаётся программе', (await store.keep({ x: 1 }))?.code === 'FAILED');
    reply = new Error('канал закрыт');
    ok('канал оборвался — FAILED, не «сохранено»', (await store.keep({ x: 1 }))?.code === 'FAILED');
    reply = { ok: false, code: 'FAILED' };
    ok('главный процесс не прочитал — чтение падает, а не отдаёт пустое', await store.load().then(() => false, () => true));
    g.window = {};
    pageState.clear();
    const offline = parts.createProgramStateStore(program);
    const before = calls.length;
    await offline.keep({ web: 1 });
    ok('без главного процесса (браузер): память, как раньше, главный процесс не зовётся', (await offline.load()).web === 1 && calls.length === before);
    pageState.clear();
    ok('выход из профиля очищает память', !Object.keys(await offline.load()).length);
  } finally { delete (globalThis as any).window; fs.rmSync(tmp, { recursive: true, force: true }); }
  return result;
}

async function main() {
  console.log('1. Настоящий код');
  const base = await battery({ ModuleStorage, createModuleBridge, createProgramStateStore });
  for (const name of base.passed) { passed++; console.log(`  ✓ ${name}`); }
  for (const name of base.failed) { failures.push(name); console.log(`  ✗ ${name}`); }
  assert.deepEqual(base.failed, [], `проверки на настоящем коде упали: ${base.failed.join('; ')}`);

  console.log('2. Мутации: каждая защита выключается по одной, батарея обязана заметить');
  type File = 'electron/moduleStorage.ts' | 'modules/bridge.ts' | 'src/services/moduleStateStorage.ts';
  const mutants: Array<{ name: string; file: File; from: string; to: string; all?: boolean }> = [
    { name: 'главный процесс: диск и читающей данные Flux программе (чтение)', file: 'electron/moduleStorage.ts', from: "if (!found || !isStandalone(found.manifest)) return { ok: true, disk: false };\n    if (!userId) return { ok: false, code: 'FAILED' };\n    const target = this.target(userId, found.manifest.id, found.scope);\n    const result = await readEnvelope", to: "if (!found) return { ok: true, disk: false };\n    if (!userId) return { ok: false, code: 'FAILED' };\n    const target = this.target(userId, found.manifest.id, found.scope);\n    const result = await readEnvelope" },
    { name: 'главный процесс: диск и читающей данные Flux программе (запись)', file: 'electron/moduleStorage.ts', from: "if (!found || !isStandalone(found.manifest)) return { ok: true, disk: false };\n    if (!userId) return { ok: false, code: 'FAILED' };\n    const target = this.target(userId, found.manifest.id, found.scope);\n    const result = await writeEnvelope", to: "if (!found) return { ok: true, disk: false };\n    if (!userId) return { ok: false, code: 'FAILED' };\n    const target = this.target(userId, found.manifest.id, found.scope);\n    const result = await writeEnvelope" },
    { name: 'главный процесс: область всегда released', file: 'electron/moduleStorage.ts', from: 'found.scope', to: "'released'", all: true },
    { name: 'главный процесс: все люди в одной папке', file: 'electron/moduleStorage.ts', from: 'this.target(userId,', to: "this.target('shared',", all: true },
    { name: 'главный процесс: отказ LIMIT не попадает в журнал', file: 'electron/moduleStorage.ts', from: "this.note(found.manifest.id, found.version, 'warn', 'storage-full', text, 'limit');", to: '' },
    { name: 'главный процесс: текст LIMIT без размера', file: 'electron/moduleStorage.ts', from: 'const text = storageFullText(result.bytes ?? 0);', to: "const text = 'Хранилище заполнено';" },
    { name: 'главный процесс: сбой записи не в журнале', file: 'electron/moduleStorage.ts', from: "this.note(found.manifest.id, found.version, 'warn', 'storage-failed', `Хранилище программы не записано${code ? ` (${code})` : ''}`, 'failed');\n    return", to: 'return' },
    { name: 'главный процесс: сбой записи выдан за успех', file: 'electron/moduleStorage.ts', from: "this.note(found.manifest.id, found.version, 'warn', 'storage-failed', `Хранилище программы не записано${code ? ` (${code})` : ''}`, 'failed');\n    return { ok: false, code: 'FAILED' };", to: "return { ok: true, disk: true };" },
    { name: 'главный процесс: ошибка чтения выдана за пустое состояние', file: 'electron/moduleStorage.ts', from: "if (!result.ok) { this.note(found.manifest.id, found.version, 'warn', 'storage-failed', 'Хранилище программы не прочитано', 'failed'); return { ok: false, code: 'FAILED' }; }", to: "if (!result.ok) return { ok: true, disk: true, state: {}, bytes: 0 };" },
    { name: 'главный процесс: битый файл не в журнале', file: 'electron/moduleStorage.ts', from: "    if (result.broken) this.note(found.manifest.id, found.version, 'warn', 'storage-broken', `Файл хранилища повреждён и отложен: ${result.broken.kept}`, 'broken');\n    return { ok: true, disk: true, state", to: '    return { ok: true, disk: true, state' },
    { name: 'главный процесс: нет человека — общая папка', file: 'electron/moduleStorage.ts', from: "if (!userId) return { ok: false, code: 'FAILED' };", to: '', all: true },
    { name: 'главный процесс: очистка всегда в released', file: 'electron/moduleStorage.ts', from: 'const target = this.target(userId, moduleId, scope);', to: "const target = this.target(userId, moduleId, 'released');", all: true },
    { name: 'мост: нет запаса для состояния в 1 МиБ', file: 'modules/bridge.ts', from: '(options.page?.stateLimit ?? 0) + 1024', to: '0' },
    { name: 'мост: предел состояния не берётся из окна', file: 'modules/bridge.ts', from: '(page.stateLimit ?? PAGE_LIMITS.stateBytes)', to: 'PAGE_LIMITS.stateBytes' },
    { name: 'мост: предел состояния не проверяется', file: 'modules/bridge.ts', from: "if (messageBytes(message.state) > (page.stateLimit ?? PAGE_LIMITS.stateBytes)) { answer({ code: 'LIMIT' }); return; }", to: '' },
    { name: 'мост: отказ хранилища не доходит до программы', file: 'modules/bridge.ts', from: "answer(refusal && (refusal.code === 'LIMIT' || refusal.code === 'FAILED') ? { code: refusal.code } : { data: null });", to: 'answer({ data: null });' },
    { name: 'мост: исключение сохранения — молчание', file: 'modules/bridge.ts', from: "} catch { answer({ code: 'FAILED' }); }\n      return;\n    }\n    if (message.op === 'file-pick')", to: "} catch { /* нет ответа */ }\n      return;\n    }\n    if (message.op === 'file-pick')" },
    { name: 'мост: исключение чтения — молчание', file: 'modules/bridge.ts', from: "try { answer({ data: await page.loadState() }); } catch { answer({ code: 'FAILED' }); }", to: "try { answer({ data: await page.loadState() }); } catch { /* нет ответа */ }" },
    { name: 'мост: чтение не ждёт ответа', file: 'modules/bridge.ts', from: 'answer({ data: await page.loadState() })', to: 'answer({ data: page.loadState() })' },
    { name: 'мост: предел сообщения снят', file: 'modules/bridge.ts', from: 'Math.max(1024 * 1024, room)', to: 'Math.max(64 * 1024 * 1024, room)' },
    { name: 'мост: запас есть у всех сообщений', file: 'modules/bridge.ts', from: "message.type === 'page' && message.op === 'state-keep' ? (options.page?.stateLimit ?? 0) + 1024 : 0", to: '(options.page?.stateLimit ?? 0) + 1024' },
    { name: 'окно: «диска нет» без предела памяти', file: 'src/services/moduleStateStorage.ts', from: 'if ((stateBytes(state) ?? Infinity) > MEMORY_LIMIT_BYTES) return { code: \'LIMIT\' };', to: '' },
    { name: 'окно: LIMIT превращается в FAILED', file: 'src/services/moduleStateStorage.ts', from: "reply?.code === 'LIMIT' ? 'LIMIT' : 'FAILED'", to: "'FAILED'" },
    { name: 'окно: обрыв канала выдан за успех', file: 'src/services/moduleStateStorage.ts', from: "catch { return { code: 'FAILED' }; }", to: 'catch { return; }' },
    { name: 'окно: прочитанное с диска игнорируется', file: 'src/services/moduleStateStorage.ts', from: 'return reply.disk ? (reply.state as Record<string, unknown>) : pageState.load(memoryKey);', to: 'return pageState.load(memoryKey);' },
    { name: 'окно: ошибка чтения выдана за пустое', file: 'src/services/moduleStateStorage.ts', from: "if (!reply?.ok) throw new Error('Хранилище программы не прочитано');", to: '' },
    { name: 'окно: на диск и в память одновременно', file: 'src/services/moduleStateStorage.ts', from: 'if (reply?.ok && reply.disk) return;', to: 'if (reply?.ok && reply.disk) { pageState.keep(memoryKey, state); return; }' },
  ];
  // Мутант, не ждущий ответа, оставляет отвергнутое обещание без обработчика: это и есть замеченная поломка, а не повод падать
  process.on('unhandledRejection', () => undefined);
  const stamp = `__mutant_${process.pid}`;
  let n = 0;
  for (const mutant of mutants) {
    const source = fs.readFileSync(mutant.file, 'utf8');
    assert.ok(source.includes(mutant.from), `мутант «${mutant.name}»: фрагмент не найден в ${mutant.file}`);
    const target = path.join(path.dirname(mutant.file), `${stamp}_${++n}.ts`);
    fs.writeFileSync(target, mutant.all ? source.split(mutant.from).join(mutant.to) : source.replace(mutant.from, () => mutant.to));
    const silent = console.log; console.log = () => undefined;
    try {
      let loaded: any = null;
      try { loaded = require(path.resolve(target)); } catch { /* не собирается — мутант замечен */ }
      const parts: Parts = {
        ModuleStorage: mutant.file === 'electron/moduleStorage.ts' ? loaded?.ModuleStorage : ModuleStorage,
        createModuleBridge: mutant.file === 'modules/bridge.ts' ? loaded?.createModuleBridge : createModuleBridge,
        createProgramStateStore: mutant.file === 'src/services/moduleStateStorage.ts' ? loaded?.createProgramStateStore : createProgramStateStore,
      };
      const result = loaded ? await battery(parts).catch(() => ({ passed: [], failed: ['упало'] })) : { passed: [], failed: ['не загрузился'] };
      console.log = silent;
      check(`мутация «${mutant.name}» замечена (${result.failed.length} проверок упало)`, result.failed.length > 0);
    } finally { console.log = silent; fs.rmSync(target, { force: true }); }
  }

  console.log(`\nПроверок прошло: ${passed}`);
  if (failures.length) { console.log(`ПРОВАЛ: ${failures.join('; ')}`); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
