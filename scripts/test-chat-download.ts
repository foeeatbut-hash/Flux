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
import { isChatFileUrl, isInside, saveToDownloads } from '../electron/chatDownloadCore';

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
  check('скачивается только вложение чата по http(s)', isChatFileUrl('http://127.0.0.1:3000/chat_files/abc/x.pdf?exp=1&sig=2') && isChatFileUrl('https://flux.corp/chat_files/abc/%D0%A7.pdf?sig=1'));
  check('чужие адреса и схемы отклонены', !isChatFileUrl('https://example.com/evil.exe') && !isChatFileUrl('file:///C:/Windows/system.ini') && !isChatFileUrl('http://x/chat_files/../../etc/passwd') && !isChatFileUrl('http://x/api/users') && !isChatFileUrl('') && !isChatFileUrl('мусор'));
  check('«показать в папке» только для путей внутри «Загрузок»', isInside(dir, path.join(dir, 'a.pdf')) && !isInside(dir, path.join(dir, '..', 'секрет.txt')) && !isInside(dir, 'C:\\Windows\\system.ini') && !isInside(dir, path.join(dir + '-соседняя', 'a.pdf')));

  console.log(`chat-download: ${passed} проверок пройдено`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
