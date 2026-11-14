/**
 * Хранилище самостоятельной программы в запуске Studio (studio/shell/runStorage.ts, область `studio`): диск только у программы,
 * которая ничего не читает во Flux; остальные остаются в памяти окна. Предел, запись, битый файл, очистка — главный процесс.
 *
 * Запуск: npx tsx scripts/test-studio-run-storage.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModuleManifest } from '../modules/contract';
import { STORAGE_IN_MEMORY_TEXT, STORAGE_LIMIT_BYTES, storageFullText } from '../modules/storage/model';
import { userDirName } from '../modules/storage/disk';
import { RunStorage } from '../studio/shell/runStorage';
import { keepRow } from '../studio/renderer/sections/run/storageRow';
import { ALL_ACTIONS } from '../studio/shell/actions';

let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };

const base = { id: 'notes', name: 'Заметки', version: '1.0.0', author: 'A', contractVersion: 2, logic: 'logic/main.ts', ui: 'page' };
const standalone = { ...base, reads: [], entries: ['start'] } as unknown as ModuleManifest;
const reading = { ...base, id: 'reader', reads: ['project'], entries: ['start', 'equipment'] } as unknown as ModuleManifest;

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-studio-run-storage-'));
  try {
    let run: { id: string; manifest: ModuleManifest } | null = null;
    const make = () => new RunStorage({ dir, version: '9.9.9', current: () => run });
    const storage = make();
    const folder = (id: string, scope = 'studio') => path.join(dir, 'program-data', userDirName('studio'), id, scope);

    console.log('Без запуска');
    ok('нет запущенной программы — отказ словами', await storage.info().then(() => false, e => /не запущена/.test(e.message)));
    ok('действия объявлены в списке окна', ['runStorageInfo', 'runStorageLoad', 'runStorageKeep', 'runStorageClear'].every(a => ALL_ACTIONS.includes(a)));

    console.log('Программа, читающая данные Flux: только память');
    run = { id: 'r1', manifest: reading };
    ok('строка «в памяти — программа читает данные Flux», кнопки нет', (await storage.info()).text === STORAGE_IN_MEMORY_TEXT && !(await storage.info()).standalone);
    ok('запись ничего не пишет на диск', (await storage.keep({ a: 1 })) .ok && !fs.existsSync(path.join(dir, 'program-data')));
    ok('загрузка пустая, очистка ничего не удаляет', Object.keys((await storage.load()).state).length === 0 && (await storage.clear()).removed === false);

    console.log('Самостоятельная программа: диск области studio');
    run = { id: 'r2', manifest: standalone };
    ok('пока пусто: «Хранилище: 0 КиБ из 1 МиБ»', (await storage.info()).text === 'Хранилище: 0 КиБ из 1 МиБ' && (await storage.info()).standalone);
    const kept = await storage.keep({ notes: ['первая', 'вторая'] });
    ok('запись прошла, файл лежит в <данные>/program-data/<человек>/<программа>/studio/state.json', 'stored' in kept && kept.stored === true && fs.existsSync(path.join(folder('notes'), 'state.json')));
    const envelope = JSON.parse(fs.readFileSync(path.join(folder('notes'), 'state.json'), 'utf8'));
    ok('формат файла: format 1, программа, версия записавшего, состояние', envelope.format === 1 && envelope.program === 'notes' && envelope.writtenBy === '9.9.9' && envelope.state.notes.length === 2);
    ok('другие области Flux (released, dev) не созданы', !fs.existsSync(folder('notes', 'released')) && !fs.existsSync(folder('notes', 'dev')));
    ok('переживает перезапуск службы: новая служба читает то же', JSON.stringify((await make().load()).state) === JSON.stringify({ notes: ['первая', 'вторая'] }));
    ok('строка показывает занятое', /^Хранилище: \d+(,\d)? КиБ из 1 МиБ$/.test((await storage.info()).text) && (await storage.info()).bytes! > 0);

    console.log('Предел 1 МиБ проверяет главный процесс');
    const before = fs.readFileSync(path.join(folder('notes'), 'state.json'), 'utf8');
    const big = await storage.keep({ blob: 'x'.repeat(STORAGE_LIMIT_BYTES) });
    ok('больше предела — LIMIT тем же текстом, что у человека', 'code' in big && big.code === 'LIMIT' && big.line.startsWith('Хранилище программы заполнено: ') && big.line.endsWith('из 1 МиБ') && big.line === storageFullText(STORAGE_LIMIT_BYTES + 'x'.repeat(0).length + JSON.stringify({ blob: '' }).length));
    ok('прежнее сохранённое состояние цело', fs.readFileSync(path.join(folder('notes'), 'state.json'), 'utf8') === before);
    ok('журнал запуска: строка об отказе с кодом LIMIT и тем же текстом', keepRow(big)!.level === 'error' && keepRow(big)!.text.startsWith('LIMIT: Хранилище программы заполнено: ') && keepRow(big)!.kind === 'хранилище');
    ok('успешная запись журнал не засоряет', keepRow(kept) === null);
    ok('ровно в пределе — проходит', (await storage.keep({ blob: 'x'.repeat(STORAGE_LIMIT_BYTES - JSON.stringify({ blob: '' }).length) })).ok);

    console.log('Битый файл не затирается');
    fs.writeFileSync(path.join(folder('notes'), 'state.json'), '{ не json');
    const loaded = await storage.load();
    ok('программа получает пустое состояние, строка журнала называет отложенный файл', Object.keys(loaded.state).length === 0 && /отложен: state\.broken-.*\.json/.test(loaded.line || ''));
    ok('битый файл лежит рядом, а не пропал', fs.readdirSync(folder('notes')).some(f => /^state\.broken-.*\.json$/.test(f)));

    console.log('Очистка');
    await storage.keep({ x: 1 });
    ok('«Очистить» удаляет папку области studio', (await storage.clear()).removed === true && !fs.existsSync(folder('notes')));
    ok('повторная очистка — «уже пусто»', (await storage.clear()).removed === false);
    ok('после очистки загрузка пустая', Object.keys((await storage.load()).state).length === 0);
    // Решение «копии данных проектов вне базы не попадают на диск»: хватает одного ресурса в reads, чтобы диска не было
    run = { id: 'r3', manifest: { ...standalone, reads: ['project'] } as ModuleManifest };
    await storage.keep({ copy: 'данные проекта' });
    ok('программа с одним ресурсом в reads на диск не пишет: файла нет', !fs.existsSync(folder('notes')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log(`\nВСЕ ТЕСТЫ ПРОЙДЕНЫ (${passed})`);
}
main().catch(e => { console.error(e); process.exit(1); });
