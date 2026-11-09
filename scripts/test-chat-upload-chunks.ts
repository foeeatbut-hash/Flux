/**
 * Вложения чата кусками: предел 500 МБ, хранение в FileChunk, выдача потоком,
 * старые вложения (строка в content) открываются.
 *
 * Настоящий HTTP на одноразовой SQLite. Проверяется то, что ломается тихо:
 * дыра в кусках или расхождение размера не проходят как «успех», недогруженный
 * файл не прикрепить, чужую загрузку не дописать, а предел сверху держит сервер,
 * а не окно.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readFileSync as read } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setBroadcaster, setPrisma } from '../server/context.js';
import { registerChatRoutes } from '../server/routes/chat.js';
import { chatFileGate, setLinkSecret, signLink } from '../server/security.js';
import { CHAT_FILE_MAX_BYTES, CHAT_SINGLE_UPLOAD_MAX_BYTES, cleanOrphanChatFiles, resetSweepCursor, ORPHAN_GRACE_MS } from '../server/services/chatFiles.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');

const PIECE = 256 * 1024;

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'flux-chat-chunks-'));
  const file = join(dir, 'test.sqlite');
  const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
  let server: any;
  let passed = 0;
  const check = (name: string, condition: unknown, detail?: unknown) => { assert.ok(condition, `${name}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`); passed++; console.log(`✓ ${name}`); };
  try {
    await bootstrapLocalDatabase(file, db, readFileSync('prisma/schema.prisma', 'utf8'), () => {});
    setPrisma(db); setBroadcaster(() => {}); setLinkSecret('test-secret');
    for (const id of ['alice', 'bob', 'carol']) await db.user.create({ data: { id, symbol: id, password: 'x', name: id, role: 'ENGINEER_VENT' } });

    const app = express();
    app.use(express.json({ limit: '60mb' }));
    app.use((req: any, _res, next) => { const id = String(req.headers['x-user'] || ''); if (id) req.authUser = { id, role: 'ENGINEER_VENT' }; next(); });
    app.use('/chat_files', chatFileGate());
    registerChatRoutes(app, { io: { to: () => ({ emit: () => {} }) } as any, chunkBytes: async () => PIECE });
    server = await new Promise<any>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const raw = async (method: string, path: string, body?: any, user = 'alice', headers: Record<string, string> = {}) => {
      const res = await fetch(origin + path, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-user': user } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const buf = Buffer.from(await res.arrayBuffer());
      let json: any = null; try { json = JSON.parse(buf.toString('utf8')); } catch (_) { /* бинарный ответ */ }
      return { status: res.status, json, buf, headers: res.headers };
    };
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    /** Загрузка целиком по протоколу окна; piece можно подменить, чтобы проверить отказы */
    const uploadChunked = async (user: string, name: string, bytes: Buffer) => {
      const start = await raw('POST', '/api/chat/upload/start', { fileName: name, size: bytes.length }, user);
      if (start.status !== 200) return { start, done: null as any };
      const piece = start.json.chunkBytes;
      let idx = 0;
      for (let from = 0; from < bytes.length; from += piece) {
        const part = bytes.subarray(from, from + piece);
        const r = await raw('POST', `/api/chat/upload/${start.json.id}/chunk`, { idx, data: part.toString('base64') }, user, { 'x-chunk-sha256': sha(part) });
        if (r.status !== 200) return { start, done: r };
        idx++;
      }
      return { start, done: await raw('POST', `/api/chat/upload/${start.json.id}/done`, { count: idx }, user) };
    };

    check('предел вложения 500 МБ, а прежней одной строкой — 25 МБ', CHAT_FILE_MAX_BYTES === 500 * 1048576 && CHAT_SINGLE_UPLOAD_MAX_BYTES === 25 * 1048576);

    // ── предел и вход ────────────────────────────────────────────────────────
    check('файл ровно 500 МБ принимается к загрузке', (await raw('POST', '/api/chat/upload/start', { fileName: 'big.bin', size: CHAT_FILE_MAX_BYTES })).status === 200);
    const over = await raw('POST', '/api/chat/upload/start', { fileName: 'big.bin', size: CHAT_FILE_MAX_BYTES + 1 });
    check('на байт больше 500 МБ — 413 с понятной причиной', over.status === 413 && /500 МБ/.test(over.json.error), over.json);
    check('пустой файл и нет размера — 400', (await raw('POST', '/api/chat/upload/start', { fileName: 'z', size: 0 })).status === 400 && (await raw('POST', '/api/chat/upload/start', { fileName: 'z' })).status === 400);
    check('нечисловой и дробный размер — 400', (await raw('POST', '/api/chat/upload/start', { fileName: 'z', size: 1.5 })).status === 400 && (await raw('POST', '/api/chat/upload/start', { fileName: 'z', size: 'много' })).status === 400);
    check('старая загрузка одной строкой выше 25 МБ отвечает 413 и зовёт обновиться', await (async () => {
      const r = await raw('POST', '/api/chat/upload', { fileName: 'm.bin', base64Data: Buffer.alloc(CHAT_SINGLE_UPLOAD_MAX_BYTES + 3).toString('base64') });
      return r.status === 413 && /обновите/.test(r.json.error);
    })());

    // ── загрузка в несколько кусков, выдача потоком ──────────────────────────
    const big = randomBytes(PIECE * 5 + 12345);
    const up = await uploadChunked('alice', 'plan.bin', big);
    check('файл в шесть кусков загружен', up.done.status === 200 && up.done.json.fileSize === big.length && up.done.json.fileName === 'plan.bin', up.done.json);
    check('куски лежат в FileChunk, строки в записи нет', await db.fileChunk.count({ where: { fileId: up.start.json.id } }) === 6 && (await db.fileNode.findUnique({ where: { id: up.start.json.id } })).content === null);
    check('запись завершена: метка CHAT и размер из кусков', (await db.fileNode.findUnique({ where: { id: up.start.json.id } })).department === 'CHAT');
    const sent = await raw('POST', '/api/chat/messages', { senderId: 'alice', receiverId: 'bob', content: 'файл', attachments: [{ filePath: up.done.json.filePath }] });
    check('завершённая загрузка прикрепляется, размер берётся из узла', sent.status === 200 && sent.json.attachments[0].fileSize === big.length, sent.json);
    const link = await raw('GET', `/api/chat/file-link?path=${encodeURIComponent(up.done.json.filePath)}`, undefined, 'bob');
    const opened = await raw('GET', link.json.url, undefined, '');
    check('вложение открывается целиком, байт в байт', opened.status === 200 && opened.buf.equals(big));
    check('длина ответа названа точно', opened.headers.get('content-length') === String(big.length));
    check('имя файла в заголовке', /filename\*=UTF-8''plan\.bin/.test(opened.headers.get('content-disposition') || ''));

    // ── старые вложения открываются ──────────────────────────────────────────
    const oldBytes = Buffer.from('вложение прежних версий');
    const old = await db.fileNode.create({ data: { name: 'old.txt', type: 'CHAT_FILE', filePath: '/chat/alice/old.txt', content: oldBytes.toString('base64'), size: oldBytes.length, department: 'CHAT' } });
    await db.chatMessage.create({ data: { senderId: 'alice', receiverId: 'bob', content: 'старое', attachments: { create: [{ fileName: 'old.txt', filePath: `/chat_files/${old.id}/old.txt`, fileSize: oldBytes.length }] } } });
    const oldOpened = await raw('GET', signLink(`/chat_files/${old.id}/old.txt`), undefined, '');
    check('вложение прежнего вида (строка в записи) открывается', oldOpened.status === 200 && oldOpened.buf.equals(oldBytes));
    const viaOld = await raw('POST', '/api/chat/upload', { fileName: 'o.txt', base64Data: oldBytes.toString('base64') });
    check('старая загрузка одной строкой по-прежнему работает до 25 МБ', viaOld.status === 200 && viaOld.json.fileSize === oldBytes.length);

    // ── отказы ───────────────────────────────────────────────────────────────
    const small = randomBytes(PIECE * 2 + 5);
    const s1 = await raw('POST', '/api/chat/upload/start', { fileName: 'hole.bin', size: small.length });
    const put = (id: string, idx: number, part: Buffer, user = 'alice', sum = sha(part)) => raw('POST', `/api/chat/upload/${id}/chunk`, { idx, data: part.toString('base64') }, user, sum ? { 'x-chunk-sha256': sum } : {});
    await put(s1.json.id, 0, small.subarray(0, PIECE));
    await put(s1.json.id, 2, small.subarray(PIECE * 2));
    const hole = await raw('POST', `/api/chat/upload/${s1.json.id}/done`, { count: 3 });
    check('дыра в кусках — не «успех»', hole.status === 400 && /не полностью/.test(hole.json.error), hole.json);
    check('недогруженный файл не прикрепить', (await raw('POST', '/api/chat/messages', { senderId: 'alice', receiverId: 'bob', content: 'х', attachments: [{ filePath: `/chat_files/${s1.json.id}/hole.bin` }] })).status === 400);
    check('недогруженный файл по ссылке не отдаётся', (await raw('GET', signLink(`/chat_files/${s1.json.id}/hole.bin`), undefined, '')).status === 404);
    check('чужую загрузку дописать нельзя (404, номер не подтверждается)', (await put(s1.json.id, 1, small.subarray(PIECE, PIECE * 2), 'bob')).status === 404 && (await raw('POST', `/api/chat/upload/${s1.json.id}/done`, { count: 3 }, 'bob')).status === 404);
    check('повреждённый кусок (сумма не совпала) — 422', (await put(s1.json.id, 1, small.subarray(PIECE, PIECE * 2), 'alice', sha(Buffer.from('другое')))).status === 422);
    check('номер куска за пределом названного размера — 400', (await put(s1.json.id, 3, small.subarray(0, 10))).status === 400);
    check('кусок крупнее допустимого — 413', (await put(s1.json.id, 1, randomBytes(PIECE + 1))).status === 413);
    check('мусор вместо base64 — 400', (await raw('POST', `/api/chat/upload/${s1.json.id}/chunk`, { idx: 1, data: '@@@@' })).status === 400);
    check('после дозагрузки недостающего куска файл завершается', (await put(s1.json.id, 1, small.subarray(PIECE, PIECE * 2))).status === 200 && (await raw('POST', `/api/chat/upload/${s1.json.id}/done`, { count: 3 })).status === 200);
    check('завершённую загрузку дописывать нельзя', (await put(s1.json.id, 0, small.subarray(0, PIECE))).status === 404);

    const s2 = await raw('POST', '/api/chat/upload/start', { fileName: 'short.bin', size: PIECE + 100 });
    await put(s2.json.id, 0, small.subarray(0, PIECE));
    await put(s2.json.id, 1, small.subarray(0, 40));
    const short = await raw('POST', `/api/chat/upload/${s2.json.id}/done`, { count: 2 });
    check('размер не совпал с названным — 400, файл не завершён', short.status === 400 && /не совпал/.test(short.json.error) && (await db.fileNode.findUnique({ where: { id: s2.json.id } })).department === 'CHAT_UPLOAD', short.json);

    // ── удаление и сироты стирают и куски ────────────────────────────────────
    const nodeId = up.start.json.id;
    const del = await raw('DELETE', `/api/chat/messages/${sent.json.id}`, undefined, 'alice');
    check('удаление сообщения стирает файл вместе с кусками', del.status === 200 && !(await db.fileNode.findUnique({ where: { id: nodeId } })) && await db.fileChunk.count({ where: { fileId: nodeId } }) === 0, { status: del.status, node: !!(await db.fileNode.findUnique({ where: { id: nodeId } })), chunks: await db.fileChunk.count({ where: { fileId: nodeId } }) });
    resetSweepCursor();
    await db.fileNode.updateMany({ where: { id: { in: [s1.json.id, s2.json.id] } }, data: { createdAt: new Date(Date.now() - ORPHAN_GRACE_MS - 60_000) } });
    const cleaned = await cleanOrphanChatFiles(db, { log: () => {} });
    check('недогруженные и несвязанные файлы уборка стирает с кусками', cleaned.removed >= 2 && await db.fileChunk.count({ where: { fileId: { in: [s1.json.id, s2.json.id] } } }) === 0);

    console.log(`chat-upload-chunks: ${passed} проверок пройдено`);
  } finally {
    server?.close();
    await db.$disconnect().catch(() => {});
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
