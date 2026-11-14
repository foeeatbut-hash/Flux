/**
 * Хранилище самостоятельной программы (modules/storage): признак «самостоятельная», метка «без связи», путь, конверт файла, предел,
 * атомарная запись, битый файл, удаление. Диск настоящий (временная папка), иногда с подставленным отказом.
 *
 * Данные человека на диске — правила flux-data-safety, поэтому каждая защита проверена мутацией: копия исходника с одной
 * выключенной проверкой прогоняется через ту же батарею, и батарея обязана упасть. Мутант, который «проходит», означает,
 * что проверка ничего не ловит.
 *
 * Запуск: npx tsx scripts/test-modules-storage.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModuleManifest } from '../modules/contract';
import * as modelReal from '../modules/storage/model';
import * as diskReal from '../modules/storage/disk';
import type { StorageFs, StorageTarget } from '../modules/storage/disk';

let passed = 0;
const failures: string[] = [];
/** Проверка батареи: падение не обрывает батарею (мутант должен упасть хотя бы на одной) */
const check = (name: string, value: unknown) => { if (value) { passed++; console.log(`  ✓ ${name}`); } else { failures.push(name); console.log(`  ✗ ${name}`); } };

const manifest = (patch: Partial<ModuleManifest> = {}): ModuleManifest => ({
  id: 'notes', name: 'Заметки', version: '1.0.0', author: 'dev', contractVersion: 3, entries: ['start'], reads: [], logic: 'logic/main.ts', ...patch,
});

type Model = typeof modelReal;
type Disk = typeof diskReal;
type Battery = { passed: string[]; failed: string[] };

const real = fs.promises as unknown as StorageFs;
/** Диск с подставленными отказами: вызов `name` с путём, подходящим под `when`, падает */
function flaky(over: Partial<Record<keyof StorageFs, (...a: any[]) => Promise<any>>>): StorageFs {
  return { ...real, ...over } as StorageFs;
}
const fail = (code: string) => Object.assign(new Error(code), { code });

async function battery(label: string, model: Model, disk: Disk): Promise<Battery> {
  const result: Battery = { passed: [], failed: [] };
  const ok = (name: string, value: unknown) => { (value ? result.passed : result.failed).push(name); };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-storage-'));
  const root = path.join(tmp, 'program-data');
  const target = (patch: Partial<StorageTarget> = {}): StorageTarget => ({ root, userId: 'user-1', programId: 'notes', scope: 'released', ...patch });
  const file = (t: StorageTarget) => path.join(disk.storagePath(t.root, t.userId, t.programId, t.scope), 'state.json');
  const ls = (dir: string) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };
  const throws = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };
  const big = (bytes: number) => ({ text: 'a'.repeat(bytes - '{"text":""}'.length) });
  try {
    // ── 1. Признак и метка ───────────────────────────────────────────────────
    ok('самостоятельная: ничего не читает, открывается из «Пуска»', model.isStandalone(manifest()));
    ok('читающая данные Flux — не самостоятельная', !model.isStandalone(manifest({ reads: ['project'] })));
    ok('открывающаяся из карточки оборудования — не самостоятельная', !model.isStandalone(manifest({ entries: ['start', 'equipment'] })));
    ok('открывающаяся из карточки тега — не самостоятельная', !model.isStandalone(manifest({ entries: ['tag'] })));
    ok('без мест запуска — не самостоятельная', !model.isStandalone(manifest({ entries: [] })));
    ok('пустое и испорченное не падает', !model.isStandalone(null) && !model.isStandalone(undefined) && !model.isStandalone({ reads: 'x', entries: 'y' } as any));
    ok('метка «без связи»: самостоятельная без разрешений', model.worksOffline(manifest()));
    ok('интернет снимает метку', !model.worksOffline(manifest({ permissions: [{ kind: 'internet', does: 'Загружает справочник курсов валют' }] })));
    ok('локальная сеть снимает метку', !model.worksOffline(manifest({ permissions: [{ kind: 'lan', does: 'Опрашивает контроллеры в сети цеха' }] })));
    ok('обращение к программе снимает метку', !model.worksOffline(manifest({ permissions: [{ kind: 'program', program: 'rates', does: 'Берёт курс валюты у программы курсов' }] })));
    ok('подключение к программе на компьютере метку не снимает', model.worksOffline(manifest({ connections: [{ app: 'E3.series', access: 'read', does: 'Читает список листов открытого проекта', transport: 'com' }] as any })));
    ok('читающая данные Flux метку не получает', !model.worksOffline(manifest({ reads: ['project'] })));
    ok('предел состояния: диск 1 МиБ у самостоятельной, память 256 КиБ у остальных', model.stateLimitFor(manifest()) === 1024 * 1024 && model.stateLimitFor(manifest({ reads: ['tag'] })) === 256 * 1024);
    ok('размер состояния — байты UTF-8, а не знаки', model.stateBytes({ t: 'я' }) === model.stateBytes({ t: 'a' })! + 1 && model.stateBytes({ n: 1n }) === null);
    ok('текст отказа называет размер и предел', model.storageFullText(1.3 * 1024 * 1024) === 'Хранилище программы заполнено: 1,3 МиБ из 1 МиБ' && model.storageUsageText(12 * 1024) === 'Хранилище: 12 КиБ из 1 МиБ' && model.sizeText(3 * 1024) === '3 КиБ');
    ok('меньше килобайта — в байтах, пустое — «0 Б» (не «0 КиБ» при сохранённых данных)', model.sizeText(0) === '0 Б' && model.sizeText(312) === '312 Б' && model.sizeText(1023) === '1023 Б' && model.sizeText(1024) === '1 КиБ' && model.storageUsageText(312) === 'Хранилище: 312 Б из 1 МиБ');

    // ── 2. Путь ──────────────────────────────────────────────────────────────
    const dir = disk.storagePath(root, 'user-1', 'notes', 'released');
    const rel = path.relative(root, dir).split(path.sep);
    ok('путь: <человек>/<программа>/<область> внутри корня', rel.length === 3 && rel[1] === 'notes' && rel[2] === 'released' && !rel[0].startsWith('..'));
    ok('папка человека — 32 знака sha256, самого идентификатора в пути нет', /^[0-9a-f]{32}$/.test(rel[0]) && !dir.includes('user-1'));
    ok('у разных людей разные папки', disk.storagePath(root, 'user-2', 'notes', 'released') !== dir);
    ok('области развёдены: released, dev, studio', new Set(['released', 'dev', 'studio'].map(s => disk.storagePath(root, 'user-1', 'notes', s as any))).size === 3);
    for (const bad of ['', '..', '../x', 'a/b', 'a\\b', 'A', 'Notes', '-x', 'x'.repeat(65), 'a b', 'x\u0000y', '.', 'a/../b']) ok(`идентификатор программы «${bad.replace(/\u0000/g, '\\0')}» отвергнут`, throws(() => disk.storagePath(root, 'user-1', bad, 'released')));
    ok('неизвестная область и пустой человек отвергнуты', throws(() => disk.storagePath(root, 'user-1', 'notes', 'all' as any)) && throws(() => disk.storagePath(root, '', 'notes', 'released')) && throws(() => disk.storagePath('', 'u', 'notes', 'released')));

    // ── 3. Запись и чтение ───────────────────────────────────────────────────
    const t = target();
    const empty = await disk.readEnvelope(real, t);
    ok('чтение без файла — пустое состояние, ничего не создано', empty.ok && Object.keys(empty.state).length === 0 && !fs.existsSync(root));
    const w1 = await disk.writeEnvelope(real, t, { writtenBy: '1.2.3', state: { text: 'Привет', n: [1, 2] }, now: new Date('2026-11-14T10:00:00.000Z') });
    ok('запись проходит', w1.ok);
    const saved = JSON.parse(fs.readFileSync(file(t), 'utf8'));
    ok('конверт: format 1, программа, версия записавшего, время, состояние', saved.format === 1 && saved.program === 'notes' && saved.writtenBy === '1.2.3' && saved.savedAt === '2026-11-14T10:00:00.000Z' && saved.state.text === 'Привет');
    ok('после записи рядом нет временных файлов', ls(path.dirname(file(t))).join() === 'state.json');
    const r1 = await disk.readEnvelope(real, t);
    ok('чтение возвращает записанное', r1.ok && (r1.state as any).text === 'Привет' && r1.bytes === model.stateBytes(saved.state));
    ok('другая область пуста', ((await disk.readEnvelope(real, target({ scope: 'dev' }))) as any).bytes === 0);
    ok('другой человек не видит состояния', Object.keys(((await disk.readEnvelope(real, target({ userId: 'user-2' }))) as any).state).length === 0);
    ok('другая программа не видит состояния', Object.keys(((await disk.readEnvelope(real, target({ programId: 'other' }))) as any).state).length === 0);
    ok('использование хранилища равно размеру состояния', await disk.storageUsage(real, t) === model.stateBytes({ text: 'Привет', n: [1, 2] }));
    ok('запись не-объекта (массив, null, строка) — отказ FAILED', (await disk.writeEnvelope(real, t, { writtenBy: '1', state: [1] as any })).ok === false && (await disk.writeEnvelope(real, t, { writtenBy: '1', state: null })).ok === false && (await disk.writeEnvelope(real, t, { writtenBy: '1', state: 'x' })).ok === false);
    ok('состояние, которое не превращается в JSON, — отказ FAILED, прежнее цело', (await disk.writeEnvelope(real, t, { writtenBy: '1', state: { n: 1n } })).ok === false && (await disk.readEnvelope(real, t) as any).state.text === 'Привет');

    // ── 4. Предел 1 МиБ: проверяет сам слой диска ────────────────────────────
    const limitTarget = target({ programId: 'limits' });
    const atLimit = await disk.writeEnvelope(real, limitTarget, { writtenBy: '1', state: big(1024 * 1024) });
    ok('ровно 1 МиБ записывается', atLimit.ok && atLimit.bytes === 1024 * 1024);
    const over = await disk.writeEnvelope(real, limitTarget, { writtenBy: '1', state: big(1024 * 1024 + 1) });
    ok('на байт больше — LIMIT с размером', over.ok === false && over.code === 'LIMIT' && over.bytes === 1024 * 1024 + 1);
    const afterOver = await disk.readEnvelope(real, limitTarget);
    ok('после отказа прежнее состояние цело', afterOver.ok && afterOver.bytes === 1024 * 1024 && (afterOver.state as any).text.length === 1024 * 1024 - 11);
    ok('после отказа нет временных файлов', ls(path.dirname(file(limitTarget))).join() === 'state.json');
    const cyr = { text: 'я'.repeat(600 * 1024) };
    const cyrWrite = await disk.writeEnvelope(real, target({ programId: 'cyr' }), { writtenBy: '1', state: cyr });
    ok('предел считается в байтах: 600 тысяч «я» (1,2 МиБ в UTF-8) — LIMIT', cyrWrite.ok === false && cyrWrite.code === 'LIMIT');

    // ── 5. Сбой диска посреди записи: прежнее состояние цело ─────────────────
    const diskT = target({ programId: 'disk' });
    await disk.writeEnvelope(real, diskT, { writtenBy: '1', state: { v: 'старое' } });
    const noRename = await disk.writeEnvelope(flaky({ rename: async () => { throw fail('EBUSY'); } }), diskT, { writtenBy: '1', state: { v: 'новое' } });
    ok('сбой переименования — FAILED', noRename.ok === false && noRename.code === 'FAILED');
    ok('при сбое переименования прежнее состояние цело', ((await disk.readEnvelope(real, diskT)) as any).state.v === 'старое');
    ok('при сбое переименования временный файл убран', ls(path.dirname(file(diskT))).join() === 'state.json');
    const halfWrite = await disk.writeEnvelope(flaky({ writeFile: async (p: string, data: string) => { fs.writeFileSync(p, data.slice(0, 10)); throw fail('ENOSPC'); } }), diskT, { writtenBy: '1', state: { v: 'новое' } });
    ok('диск заполнился посреди записи — FAILED', halfWrite.ok === false && halfWrite.code === 'FAILED');
    ok('при недописанном файле прежнее состояние цело, обрубок убран', ((await disk.readEnvelope(real, diskT)) as any).state.v === 'старое' && ls(path.dirname(file(diskT))).join() === 'state.json');
    const noDir = await disk.writeEnvelope(flaky({ mkdir: async () => { throw fail('EACCES'); } }), target({ programId: 'nodir' }), { writtenBy: '1', state: { v: 1 } });
    ok('нет доступа к папке — FAILED', noDir.ok === false && noDir.code === 'FAILED');
    const noRead = await disk.readEnvelope(flaky({ lstat: async () => { throw fail('EACCES'); } }), diskT);
    ok('диск не отвечает на чтении — FAILED, а не «пусто» (иначе следующая запись затёрла бы файл)', noRead.ok === false && noRead.code === 'FAILED');
    const noReadFile = await disk.readEnvelope(flaky({ readFile: async () => { throw fail('EIO'); } }), diskT);
    ok('ошибка чтения файла — FAILED, файл не отложен', !noReadFile.ok && ls(path.dirname(file(diskT))).join() === 'state.json');
    const failWriteOnError = await disk.writeEnvelope(flaky({ lstat: async () => { throw fail('EIO'); } }), diskT, { writtenBy: '1', state: { v: 'новое' } });
    ok('диск не отвечает перед записью — FAILED, прежнее цело', !failWriteOnError.ok && ((await disk.readEnvelope(real, diskT)) as any).state.v === 'старое');

    // ── 6. Параллельные записи ───────────────────────────────────────────────
    const parT = target({ programId: 'parallel' });
    const writes = await Promise.all(Array.from({ length: 25 }, (_, i) => disk.writeEnvelope(real, parT, { writtenBy: '1', state: { i } })));
    const firstFail = writes.find(w => !w.ok) as { reason?: string } | undefined;
    // Код и текст первой ошибки — в названии проверки: на чужой ОС (Windows в CI) иначе остаётся гадать
    ok(`25 одновременных записей проходят${firstFail ? ` — первая ошибка: ${firstFail.reason}` : ''}`, writes.every(w => w.ok));
    const parRead = await disk.readEnvelope(real, parT);
    ok('итог — одно целое состояние, временных файлов нет', parRead.ok && typeof (parRead.state as any).i === 'number' && ls(path.dirname(file(parT))).join() === 'state.json');

    // Windows: переименование поверх файла, в который уже идёт другое переименование, отказывает (EPERM). Подставной диск
    // воспроизводит это на любой ОС: запись поверх занятого файла падает, пока в него переименовывают
    const winT = target({ programId: 'winlike' });
    const inRename = new Set<string>();
    const winLike = flaky({ rename: async (a: string, b: string) => {
      if (inRename.has(b)) throw fail('EPERM');
      inRename.add(b);
      try { await new Promise(r => setTimeout(r, 5)); return await fs.promises.rename(a, b); } finally { inRename.delete(b); }
    } });
    const winWrites = await Promise.all(Array.from({ length: 25 }, (_, i) => disk.writeEnvelope(winLike, winT, { writtenBy: '1', state: { i } })));
    ok(`диск, где одновременное переименование в один файл отказывает (Windows): 25 записей проходят${winWrites.find(w => !w.ok) ? ` — первая ошибка: ${(winWrites.find(w => !w.ok) as any).reason}` : ''}`, winWrites.every(w => w.ok));
    ok('последняя запись из очереди — итог', ((await disk.readEnvelope(real, winT)) as any).state.i === 24 && ls(path.dirname(file(winT))).join() === 'state.json');
    // Файл ненадолго занят антивирусом или индексатором: переименование повторяется
    const busyT = target({ programId: 'busy' });
    let busyLeft = 3;
    const busyFs = flaky({ rename: async (a: string, b: string) => { if (busyLeft-- > 0) throw fail('EBUSY'); return fs.promises.rename(a, b); } });
    const busyWrite = await disk.writeEnvelope(busyFs, busyT, { writtenBy: '1', state: { v: 1 } });
    ok(`файл занят три попытки подряд — запись проходит с повтором${busyWrite.ok ? '' : ` — ${(busyWrite as any).reason}`}`, busyWrite.ok && ((await disk.readEnvelope(real, busyT)) as any).state.v === 1);
    const stuckBusy = await disk.writeEnvelope(flaky({ rename: async () => { throw fail('EBUSY'); } }), target({ programId: 'busy2' }), { writtenBy: '1', state: { v: 1 } });
    ok('файл занят насовсем — FAILED с кодом ошибки, временный файл убран', stuckBusy.ok === false && /^EBUSY/.test((stuckBusy as any).reason) && ls(path.dirname(file(target({ programId: 'busy2' })))).length === 0);
    const enoentOnce = (() => { let n = 1; return flaky({ rename: async (a: string, b: string) => { if (n-- > 0) throw fail('ENOENT'); return fs.promises.rename(a, b); } }); })();
    const enoent = await disk.writeEnvelope(enoentOnce, target({ programId: 'noent' }), { writtenBy: '1', state: { v: 1 } });
    ok('другие ошибки (не EPERM/EBUSY/EACCES) не повторяются', enoent.ok === false && /^ENOENT/.test((enoent as any).reason));

    // ── 7. Битый файл не затирается ──────────────────────────────────────────
    const brokenCases: Array<[string, (p: string, id: string) => void]> = [
      ['не JSON', (p, id) => fs.writeFileSync(p, '{"format":1,"program":"x","state":{"t":')],
      ['неизвестный format 2', (p, id) => fs.writeFileSync(p, JSON.stringify({ format: 2, program: id, writtenBy: '9', savedAt: 'x', state: { t: 1 } }))],
      ['без format', (p, id) => fs.writeFileSync(p, JSON.stringify({ program: id, writtenBy: '1', savedAt: 'x', state: { t: 1 } }))],
      ['чужая программа', (p, id) => fs.writeFileSync(p, JSON.stringify({ format: 1, program: 'other', writtenBy: '1', savedAt: 'x', state: { t: 1 } }))],
      ['состояние — массив', (p, id) => fs.writeFileSync(p, JSON.stringify({ format: 1, program: id, writtenBy: '1', savedAt: 'x', state: [1] }))],
      ['состояние больше предела', (p, id) => fs.writeFileSync(p, JSON.stringify({ format: 1, program: id, writtenBy: '1', savedAt: 'x', state: big(1024 * 1024 + 100) }))],
      ['пустой файл', (p, id) => fs.writeFileSync(p, '')],
    ];
    let bn = 0;
    for (const [name, make] of brokenCases) {
      const bt = target({ programId: `broken${++bn}` });
      const bdir = path.dirname(file(bt));
      fs.mkdirSync(bdir, { recursive: true });
      make(file(bt), bt.programId);
      const original = fs.readFileSync(file(bt));
      const read = await disk.readEnvelope(real, bt, { now: new Date('2026-11-14T10:11:12.345Z') });
      const kept = ls(bdir);
      ok(`«${name}»: читается как пустое состояние с пометкой, что файл отложен`, read.ok && Object.keys(read.state).length === 0 && !!read.broken && read.broken.kept === 'state.broken-20261114T101112-345.json');
      ok(`«${name}»: файл отложен целиком, байт в байт`, kept.join() === 'state.broken-20261114T101112-345.json' && fs.readFileSync(path.join(bdir, kept[0])).equals(original));
      const after = await disk.writeEnvelope(real, bt, { writtenBy: '1', state: { t: 'новое' } });
      ok(`«${name}»: после записи есть и новое состояние, и отложенный файл`, after.ok && ls(bdir).length === 2 && ((await disk.readEnvelope(real, bt)) as any).state.t === 'новое');
    }
    // Запись без предварительного чтения (программа не звала state-load) тоже не затирает чужой файл
    const bw = target({ programId: 'brokenwrite' });
    fs.mkdirSync(path.dirname(file(bw)), { recursive: true });
    fs.writeFileSync(file(bw), 'мусор');
    const bwr = await disk.writeEnvelope(real, bw, { writtenBy: '1', state: { t: 1 }, now: new Date('2026-11-14T10:11:12.345Z') });
    ok('запись поверх битого файла откладывает его и сообщает', bwr.ok && !!bwr.broken && fs.readFileSync(path.join(path.dirname(file(bw)), bwr.broken.kept), 'utf8') === 'мусор');
    // Два отложенных в одну миллисекунду не перезаписывают друг друга
    const twice = target({ programId: 'twice' });
    const tdir = path.dirname(file(twice));
    fs.mkdirSync(tdir, { recursive: true });
    const same = new Date('2026-11-14T10:11:12.345Z');
    fs.writeFileSync(file(twice), 'первый'); await disk.readEnvelope(real, twice, { now: same });
    fs.writeFileSync(file(twice), 'второй'); await disk.readEnvelope(real, twice, { now: same });
    ok('два отложенных файла в одну миллисекунду — оба целы', ls(tdir).length === 2 && ls(tdir).map(n => fs.readFileSync(path.join(tdir, n), 'utf8')).sort().join() === 'второй,первый');
    // Отложить не удалось — состояние не отдаётся, файл на месте, запись отказывает
    const stuck = target({ programId: 'stuck' });
    fs.mkdirSync(path.dirname(file(stuck)), { recursive: true });
    fs.writeFileSync(file(stuck), 'мусор');
    // Отказывает только откладыванию: замена временного файла работала бы, и без защиты битый файл был бы затёрт
    const noMove = flaky({ rename: async (a: string, b: string) => { if (b.includes('state.broken-')) throw fail('EPERM'); return fs.promises.rename(a, b); } });
    const stuckRead = await disk.readEnvelope(noMove, stuck);
    ok('не удалось отложить — чтение FAILED, файл на месте', !stuckRead.ok && fs.readFileSync(file(stuck), 'utf8') === 'мусор');
    const stuckWrite = await disk.writeEnvelope(noMove, stuck, { writtenBy: '1', state: { t: 1 } });
    ok('не удалось отложить — запись FAILED, файл не затёрт', !stuckWrite.ok && fs.readFileSync(file(stuck), 'utf8') === 'мусор');
    // Ссылка и огромный файл на месте state.json
    const link = target({ programId: 'linked' });
    fs.mkdirSync(path.dirname(file(link)), { recursive: true });
    const outside = path.join(tmp, 'outside.json');
    fs.writeFileSync(outside, JSON.stringify({ format: 1, program: 'linked', writtenBy: '1', savedAt: 'x', state: { secret: 1 } }));
    let linkOk = true;
    try { fs.symlinkSync(outside, file(link)); } catch { linkOk = false; }
    if (linkOk) {
      const lr = await disk.readEnvelope(real, link);
      ok('ссылка на месте state.json не читается, а откладывается', lr.ok && Object.keys(lr.state).length === 0 && !!lr.broken && fs.readFileSync(outside, 'utf8').includes('secret'));
    }
    const hugeT = target({ programId: 'huge' });
    fs.mkdirSync(path.dirname(file(hugeT)), { recursive: true });
    fs.writeFileSync(file(hugeT), 'x'.repeat(3 * 1024 * 1024));
    let reads = 0;
    const hr = await disk.readEnvelope(flaky({ readFile: async (p: string, e: string) => { reads++; return fs.promises.readFile(p, e as 'utf8'); } }), hugeT);
    ok('файл в несколько МиБ откладывается, не читаясь целиком', hr.ok && !!hr.broken && reads === 0);
    const dirT = target({ programId: 'folder' });
    fs.mkdirSync(file(dirT), { recursive: true });
    const dr = await disk.readEnvelope(real, dirT);
    ok('папка на месте state.json откладывается', dr.ok && !!dr.broken);

    // ── 8. Удаление: только своя область ────────────────────────────────────
    const delRoot = path.join(tmp, 'delete-data');
    const d = (patch: Partial<StorageTarget> = {}): StorageTarget => ({ root: delRoot, userId: 'user-1', programId: 'notes', scope: 'released', ...patch });
    for (const patch of [{}, { scope: 'dev' as const }, { scope: 'studio' as const }, { programId: 'other' }, { userId: 'user-2' }, { userId: 'user-2', scope: 'dev' as const }]) {
      await disk.writeEnvelope(real, d(patch), { writtenBy: '1', state: { x: JSON.stringify(patch) } });
    }
    const brokenInside = path.join(path.dirname(file(d())), 'state.broken-1.json');
    fs.writeFileSync(brokenInside, 'x');
    const cleared = await disk.clearStorage(real, d());
    ok('удаление released: папки нет', cleared.ok && cleared.removed && !fs.existsSync(path.dirname(file(d()))));
    ok('удалены и отложенные файлы этой области', !fs.existsSync(brokenInside));
    ok('dev и studio той же программы целы', fs.existsSync(file(d({ scope: 'dev' }))) && fs.existsSync(file(d({ scope: 'studio' }))));
    ok('другая программа того же человека цела', fs.existsSync(file(d({ programId: 'other' }))));
    ok('другой человек цел во всех областях', fs.existsSync(file(d({ userId: 'user-2' }))) && fs.existsSync(file(d({ userId: 'user-2', scope: 'dev' }))));
    ok('папка программы осталась, пока в ней есть другая область', fs.existsSync(path.join(delRoot, disk.userDirName('user-1'), 'notes')));
    await disk.clearStorage(real, d({ scope: 'dev' })); await disk.clearStorage(real, d({ scope: 'studio' }));
    ok('когда областей не осталось, пустая папка программы убрана', !fs.existsSync(path.join(delRoot, disk.userDirName('user-1'), 'notes')) && fs.existsSync(path.join(delRoot, disk.userDirName('user-1'), 'other')));
    ok('удалять нечего — не ошибка', (await disk.clearStorage(real, d())).ok && !((await disk.clearStorage(real, d())) as any).removed);
    for (const bad of ['..', '../other', 'a/b', '', 'Notes']) {
      ok(`удаление по негодному идентификатору «${bad}» не выполняется`, await disk.clearStorage(real, d({ programId: bad })).then(() => false, () => true));
    }
    ok('после попыток с негодными идентификаторами всё остальное цело', fs.existsSync(file(d({ programId: 'other' }))) && fs.existsSync(file(d({ userId: 'user-2' }))));
    // Ссылка на месте папки области: снимается ссылка, то, куда она ведёт, нетронуто
    if (linkOk) {
      const lt = d({ programId: 'linkdir' });
      const victim = path.join(tmp, 'victim');
      fs.mkdirSync(victim, { recursive: true }); fs.writeFileSync(path.join(victim, 'keep.txt'), 'важное');
      const parent = path.dirname(disk.storagePath(lt.root, lt.userId, lt.programId, lt.scope));
      fs.mkdirSync(parent, { recursive: true });
      fs.symlinkSync(victim, disk.storagePath(lt.root, lt.userId, lt.programId, lt.scope), 'dir');
      const lc = await disk.clearStorage(real, lt);
      ok('ссылка на месте папки снята, цель не тронута', lc.ok && fs.readFileSync(path.join(victim, 'keep.txt'), 'utf8') === 'важное');
    }
    const failClear = await disk.clearStorage(flaky({ rm: async () => { throw fail('EBUSY'); } }), d({ userId: 'user-2' }));
    ok('сбой удаления — FAILED, данные на месте', !failClear.ok && fs.existsSync(file(d({ userId: 'user-2' }))));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  void label;
  return result;
}

async function main() {
  console.log('1. Настоящий код');
  const base = await battery('настоящий', modelReal, diskReal);
  for (const name of base.passed) { passed++; console.log(`  ✓ ${name}`); }
  for (const name of base.failed) { failures.push(name); console.log(`  ✗ ${name}`); }
  assert.deepEqual(base.failed, [], `проверки на настоящем коде упали: ${base.failed.join('; ')}`);

  console.log('2. Мутации: каждая защита выключается по одной, батарея обязана заметить');
  const mutants: Array<{ name: string; file: 'model' | 'disk'; from: string; to: string }> = [
    { name: 'предел в записи не проверяется', file: 'disk', from: "if (bytes > STORAGE_LIMIT_BYTES) return { ok: false, code: 'LIMIT', bytes };", to: '' },
    { name: 'малое состояние показывается как «0 КиБ»', file: 'model', from: 'if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} Б`;', to: '' },
    { name: 'размер считается знаками, а не байтами', file: 'model', from: 'return json === undefined ? null : new TextEncoder().encode(json).length;', to: 'return json === undefined ? null : json.length;' },
    { name: 'предел записи на 4 КиБ мягче', file: 'model', from: 'export const STORAGE_LIMIT_BYTES = 1024 * 1024;', to: 'export const STORAGE_LIMIT_BYTES = 1024 * 1024 + 4096;' },
    { name: 'запись не атомарная: старый файл удаляется до замены', file: 'disk', from: 'await renameWithRetry(fs, tmp, file);', to: 'await fs.rm(file, { recursive: true, force: true }); await renameWithRetry(fs, tmp, file);' },
    { name: 'временный файл остаётся после сбоя', file: 'disk', from: 'await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);', to: '' },
    { name: 'битый файл на месте не откладывается при записи', file: 'disk', from: "if (found.kind === 'broken') {", to: "if (false as boolean) {" },
    { name: 'чтение не откладывает битый файл', file: 'disk', from: 'const kept = await setAside(fs, dir, options.now ?? new Date());', to: "const kept = 'state.broken-20261114T101112-345.json';" },
    { name: 'неизвестный формат принимается', file: 'disk', from: 'parsed.format !== STORAGE_FORMAT ||', to: '' },
    { name: 'файл чужой программы принимается', file: 'disk', from: 'parsed.program !== programId', to: 'false' },
    { name: 'состояние не-объект принимается', file: 'disk', from: '|| !isPlainObject(parsed.state)) return { kind: \'broken\' };', to: ') return { kind: \'broken\' };' },
    { name: 'состояние сверх предела принимается при чтении', file: 'disk', from: 'if (bytes === null || bytes > STORAGE_LIMIT_BYTES) return { kind: \'broken\' };', to: 'if (bytes === null) return { kind: \'broken\' };' },
    { name: 'ссылка и папка на месте файла читаются', file: 'disk', from: 'if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) return { kind: \'broken\' };', to: 'if (info.size > MAX_FILE_BYTES) return { kind: \'broken\' };' },
    { name: 'огромный файл читается целиком', file: 'disk', from: ' || info.size > MAX_FILE_BYTES) return', to: ') return' },
    { name: 'отказ диска на чтении считается «файла нет»', file: 'disk', from: "try { info = await fs.lstat(file); } catch (e) { return isMissing(e) ? { kind: 'missing' } : { kind: 'error' }; }", to: "try { info = await fs.lstat(file); } catch (e) { return { kind: 'missing' }; }" },
    { name: 'не удалось отложить — всё равно отдаём пустое', file: 'disk', from: "return kept ? { ok: true, state: {}, bytes: 0, savedAt: null, broken: { kept } } : { ok: false, code: 'FAILED' };", to: "return { ok: true, state: {}, bytes: 0, savedAt: null, broken: { kept: kept ?? '' } };" },
    { name: 'не удалось отложить — запись всё равно идёт', file: 'disk', from: "if (!kept) return { ok: false, code: 'FAILED', reason: 'повреждённый файл не удалось отложить' };\n      broken = { kept };", to: "broken = { kept: kept ?? '' };" },
    { name: 'отложенный файл перезаписывает прежний отложенный', file: 'disk', from: 'try { await fs.lstat(target); continue; } catch (e) { if (!isMissing(e)) return null; }', to: '' },
    { name: 'идентификатор программы в пути не проверяется', file: 'disk', from: "|| !PROGRAM_ID.test(programId)", to: '' },
    { name: 'идентификатор человека кладётся в путь как есть', file: 'disk', from: 'return path.join(root, userDirName(userId), programId, scope);', to: 'return path.join(root, userId, programId, scope);' },
    { name: 'папка человека — не 32 знака', file: 'disk', from: 'const USER_DIR_LENGTH = 32;', to: 'const USER_DIR_LENGTH = 16;' },
    { name: 'область не входит в путь', file: 'disk', from: 'return path.join(root, userDirName(userId), programId, scope);', to: 'return path.join(root, userDirName(userId), programId);' },
    { name: 'область не проверяется', file: 'disk', from: "if (!STORAGE_SCOPES.includes(scope)) throw new Error('storage: неверная область');", to: '' },
    { name: 'удаление сносит все области программы', file: 'disk', from: 'await fs.rm(dir, { recursive: true, force: true });\n    await fs.rmdir', to: 'await fs.rm(path.dirname(dir), { recursive: true, force: true });\n    await fs.rmdir' },
    { name: 'удаление сносит все программы человека', file: 'disk', from: 'await fs.rm(dir, { recursive: true, force: true });\n    await fs.rmdir', to: 'await fs.rm(path.dirname(path.dirname(dir)), { recursive: true, force: true });\n    await fs.rmdir' },
    { name: 'пустая папка программы рекурсивно сносится вместе с другими областями', file: 'disk', from: 'await fs.rmdir(path.dirname(dir)).catch(() => undefined);', to: 'await fs.rm(path.dirname(dir), { recursive: true, force: true });' },
    { name: 'записи в один файл идут без очереди (на Windows одновременное переименование отказывает)', file: 'disk', from: 'const run = (locks.get(key) ?? Promise.resolve()).then(job, job);', to: 'const run = job();' },
    { name: 'переименование не повторяется при занятом файле', file: 'disk', from: 'if (attempt >= 5 || !RENAME_RETRY.includes(', to: 'if (attempt >= 0 || !RENAME_RETRY.includes(' },
    { name: 'повторяется любая ошибка переименования', file: 'disk', from: "const RENAME_RETRY = ['EPERM', 'EBUSY', 'EACCES'];", to: "const RENAME_RETRY = ['EPERM', 'EBUSY', 'EACCES', 'ENOENT'];" },
    { name: 'отказ записи без кода ошибки', file: 'disk', from: "return { ok: false, code: 'FAILED', reason: reasonOf(e) };", to: "return { ok: false, code: 'FAILED' };" },
    { name: 'сбой удаления выдаётся за успех', file: 'disk', from: "} catch { return { ok: false, code: 'FAILED' }; }\n}", to: '} catch { return { ok: true, removed: true }; }\n}' },
    { name: 'метка «без связи» не учитывает интернет', file: 'model', from: "p.kind === 'internet' || ", to: '' },
    { name: 'метка «без связи» не учитывает локальную сеть', file: 'model', from: "|| p.kind === 'lan'", to: '' },
    { name: 'метка «без связи» не учитывает обращение к программам', file: 'model', from: " || p.kind === 'program'", to: '' },
    { name: 'метка «без связи» без проверки самостоятельности', file: 'model', from: 'if (!isStandalone(manifest)) return false;', to: '' },
    { name: 'самостоятельная читает данные Flux', file: 'model', from: 'manifest.reads.length === 0 && ', to: '' },
    { name: 'самостоятельная открывается откуда угодно', file: 'model', from: "&& manifest.entries.every(e => e === 'start')", to: '' },
    { name: 'самостоятельная без мест запуска', file: 'model', from: 'manifest.entries.length > 0 && ', to: '' },
    { name: 'предел окна для самостоятельной — прежний 256 КиБ', file: 'model', from: 'isStandalone(manifest) ? STORAGE_LIMIT_BYTES : MEMORY_LIMIT_BYTES', to: 'MEMORY_LIMIT_BYTES' },
  ];
  const stamp = `__mutant_${process.pid}`;
  const dirOfModule = 'modules/storage';
  let n = 0;
  for (const mutant of mutants) {
    const source = fs.readFileSync(`${dirOfModule}/${mutant.file}.ts`, 'utf8').replace(/\r\n/g, '\n'); // CRLF Windows: многострочные фрагменты мутантов записаны с LF
    assert.ok(source.includes(mutant.from), `мутант «${mutant.name}»: фрагмент не найден в ${mutant.file}.ts`);
    ++n;
    // Мутант кладётся в ту же папку под своим именем: относительные импорты (./model) продолжают работать.
    // Мутант disk.ts ссылается на настоящий model.ts, мутант model.ts — на настоящий disk через подмену ниже.
    const targetFile = path.join(dirOfModule, `${stamp}_${n}_${mutant.file}.ts`);
    fs.writeFileSync(targetFile, source.replace(mutant.from, mutant.to));
    const silent = console.log; console.log = () => undefined;
    try {
      let loaded: any;
      try { loaded = require(path.resolve(targetFile)); } catch { loaded = null; }
      // Мутанту model.ts настоящий disk.ts подсовывает свой model: батарея получает мутировавшие функции моделей и диск, собранный над настоящим model
      const result = loaded
        ? await battery(mutant.name, mutant.file === 'model' ? loaded : modelReal, mutant.file === 'disk' ? loaded : diskReal).catch(() => ({ passed: [], failed: ['упало'] }))
        : { passed: [], failed: ['не загрузился'] };
      console.log = silent;
      check(`мутация «${mutant.name}» замечена (${result.failed.length} проверок упало)`, result.failed.length > 0);
    } finally { console.log = silent; fs.rmSync(targetFile, { force: true }); }
  }

  console.log(`\nПроверок прошло: ${passed}`);
  if (failures.length) { console.log(`ПРОВАЛ: ${failures.join('; ')}`); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
