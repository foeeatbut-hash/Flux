/**
 * Сохранение вложения чата в «Загрузки» (electron/chatDownloadCore.ts): имя
 * не затирает чужой файл, чужое имя не выводит из папки, недокачанное не
 * остаётся на диске, главный процесс берёт только вложения чата.
 * Без Electron: папка одноразовая, скачивание подаётся потоком.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createChatDownloadHandlers, createSavedPaths, isChatFileUrl, isInside, pathKey, saveToDownloads } from '../electron/chatDownloadCore';

let passed = 0;
const check = (name: string, condition: unknown, detail?: unknown) => { assert.ok(condition, `${name}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`); passed++; console.log(`✓ ${name}`); };

const streamOf = (bytes: Buffer, piece = 64 * 1024) => new ReadableStream<Uint8Array>({
  start(controller) { for (let i = 0; i < bytes.length; i += piece) controller.enqueue(new Uint8Array(bytes.subarray(i, i + piece))); controller.close(); },
});
const ok = (bytes: Buffer) => async () => ({ ok: true, status: 200, body: streamOf(bytes) });

async function main() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flux-dl-')), 'Загрузки');
  const bytes = randomBytes(5 * 1024 * 1024 + 17);

  const first = await saveToDownloads({ dir, name: 'Чертёж ОВ-12.pdf', open: ok(bytes) });
  check('файл сохранён в папку (её создали, раз не было) байт в байт', first.ok && first.path === path.join(dir, 'Чертёж ОВ-12.pdf') && fs.readFileSync(first.path).equals(bytes), first);
  check('размер в ответе равен размеру на диске', first.ok && first.bytes === bytes.length);

  const second = await saveToDownloads({ dir, name: 'Чертёж ОВ-12.pdf', open: ok(Buffer.from('другой')) });
  const third = await saveToDownloads({ dir, name: 'Чертёж ОВ-12.pdf', open: ok(Buffer.from('третий')) });
  check('второй файл с тем же именем получает «(2)», третий «(3)»', second.ok && second.name === 'Чертёж ОВ-12 (2).pdf' && third.ok && third.name === 'Чертёж ОВ-12 (3).pdf', [second, third]);
  check('первый файл не затёрт', fs.readFileSync(path.join(dir, 'Чертёж ОВ-12.pdf')).equals(bytes));

  // Одновременные сохранения одного имени не выбирают один путь
  const burst = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => saveToDownloads({ dir, name: 'отчёт.txt', open: ok(Buffer.from(`файл ${i}`)) })));
  const names = burst.map((r) => (r.ok ? r.name : ''));
  check('шесть одновременных сохранений одного имени дали шесть разных файлов', new Set(names).size === 6 && names.every(Boolean), names);
  check('в каждом файле — его собственное содержимое', burst.every((r, i) => r.ok && fs.readFileSync(r.path, 'utf8') === `файл ${i + 1}`));

  // Имя пришло от другого человека
  const evil = await saveToDownloads({ dir, name: '..\\..\\evil.exe', open: ok(Buffer.from('x')) });
  const evil2 = await saveToDownloads({ dir, name: '../../etc/passwd', open: ok(Buffer.from('x')) });
  check('имя с «../» остаётся внутри папки', evil.ok && isInside(dir, evil.path) && path.dirname(evil.path) === dir && evil2.ok && path.dirname(evil2.path) === dir, [evil, evil2]);
  const reserved = await saveToDownloads({ dir, name: 'CON.txt', open: ok(Buffer.from('x')) });
  check('зарезервированное имя Windows не используется как есть', reserved.ok && reserved.name !== 'CON.txt', reserved);

  // Отказы не оставляют файлов
  const before = fs.readdirSync(dir).length;
  const missing = await saveToDownloads({ dir, name: 'нет.pdf', open: async () => ({ ok: false, status: 404, body: null }) });
  check('404: понятная причина, файл не создан', !missing.ok && /не найден/.test((missing as any).error) && fs.readdirSync(dir).length === before, missing);
  const broken = await saveToDownloads({
    dir, name: 'обрыв.bin',
    open: async () => ({ ok: true, status: 200, body: new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array(1000)); },
      pull(c) { c.error(new Error('соединение разорвано')); },
    }) }),
  });
  check('обрыв на середине: сказано об ошибке, недокачанного файла на диске нет', !broken.ok && /разорвано/.test((broken as any).error) && !fs.existsSync(path.join(dir, 'обрыв.bin')), broken);
  const refused = await saveToDownloads({ dir: path.join(dir, 'Чертёж ОВ-12.pdf', 'вложенная'), name: 'a.txt', open: ok(Buffer.from('x')) });
  check('папку создать нельзя (на её месте файл): ошибка, а не падение', !refused.ok, refused);

  // Что главный процесс согласен скачивать и показывать
  const ORIGIN = 'http://localhost:3000';
  check('скачивается только вложение чата с сервера Flux', isChatFileUrl('http://localhost:3000/chat_files/abc/x.pdf?exp=1&sig=2', ORIGIN) && isChatFileUrl('https://flux.corp/chat_files/abc/%D0%A7.pdf?sig=1', 'https://flux.corp'));
  check('чужой хост, порт и схема отклонены', !isChatFileUrl('http://evil.example/chat_files/abc/x.pdf', ORIGIN) && !isChatFileUrl('http://localhost:3001/chat_files/abc/x.pdf', ORIGIN) && !isChatFileUrl('https://localhost:3000/chat_files/abc/x.pdf', ORIGIN) && !isChatFileUrl('http://localhost:3000@evil.example/chat_files/abc/x.pdf', ORIGIN));
  check('чужие пути и мусор отклонены', !isChatFileUrl('file:///C:/Windows/system.ini', ORIGIN) && !isChatFileUrl('http://localhost:3000/chat_files/../../etc/passwd', ORIGIN) && !isChatFileUrl('http://localhost:3000/api/users', ORIGIN) && !isChatFileUrl('', ORIGIN) && !isChatFileUrl('мусор', ORIGIN));
  check('«внутри папки» не принимает соседнюю и выход вверх', isInside(dir, path.join(dir, 'a.pdf')) && !isInside(dir, path.join(dir, '..', 'секрет.txt')) && !isInside(dir, path.join(dir + '-соседняя', 'a.pdf')));
  check('на Windows регистр в пути не различается, на других системах различается', pathKey('C:\\Users\\Ivan\\Downloads\\A.pdf', 'win32') === pathKey('c:\\users\\ivan\\downloads\\a.PDF', 'win32') && pathKey('/tmp/A', 'linux') !== pathKey('/tmp/a', 'linux'));
  const winSaved = createSavedPaths('win32');
  winSaved.remember('/tmp/Downloads/Файл.pdf');
  check('выданный путь узнаётся без учёта регистра (Windows), чужой — нет', winSaved.has('/tmp/downloads/ФАЙЛ.PDF') && !winSaved.has('/tmp/Downloads/другой.pdf'));

  // Каналы: отправитель, адрес, выданные пути
  const shown: string[] = [];
  const fetched: string[] = [];
  const main = { id: 'main' }; const stranger = { id: 'frame' };
  const handlers = createChatDownloadHandlers<{ id: string }>({
    trusted: (e) => e === main, serverOrigin: ORIGIN, downloadsDir: () => dir,
    fetch: async (url) => { fetched.push(url); return { ok: true, status: 200, body: streamOf(Buffer.from('данные')) }; },
    showItem: (t) => { shown.push(t); },
  });
  const url = 'http://localhost:3000/chat_files/n1/x.pdf?sig=1';
  const foreign = await handlers.save(stranger, url, 'вложение.pdf');
  check('сохранение для чужого отправителя отказано, сеть не тронута, файла нет', !foreign.ok && fetched.length === 0 && !fs.existsSync(path.join(dir, 'вложение.pdf')), foreign);
  const badHost = await handlers.save(main, 'http://evil.example/chat_files/n1/x.pdf', 'вложение.pdf');
  check('сохранение с чужого хоста отказано, сеть не тронута', !badHost.ok && fetched.length === 0, badHost);
  const good = await handlers.save(main, url, 'вложение.pdf');
  check('основное окно и адрес сервера: файл сохранён', good.ok && fetched.length === 1 && fs.readFileSync(path.join(dir, 'вложение.pdf'), 'utf8') === 'данные', good);
  check('«показать» для чужого отправителя отказано', !handlers.reveal(stranger, good.ok ? good.path : '').ok && shown.length === 0);
  check('«показать» чужой файл из «Загрузок» (не выданный при сохранении) отказано', !handlers.reveal(main, path.join(dir, 'Чертёж ОВ-12.pdf')).ok && !handlers.reveal(main, dir).ok && shown.length === 0);
  check('«показать» выданный при сохранении путь — можно', handlers.reveal(main, good.ok ? good.path : '').ok && shown.length === 1);

  console.log(`chat-download: ${passed} проверок пройдено`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
