/**
 * Вложения к обращениям: приём кусками и проверка целого.
 *
 * Почему в базу, а не на диск. У каждого сотрудника свой встроенный сервер,
 * общая у них только база. Файл, оставшийся на диске автора, для обработчика
 * не существует — он увидит карточку со вложением, которое не открывается.
 *
 * Почему кусками и двоичным телом. Целый файл одним запросом не проходит:
 * MariaDB на слишком большой пакет не отвечает ошибкой, а разрывает
 * соединение. Base64 здесь не нужен — он раздувает передачу на треть, а
 * двоичное тело сервер принимает как есть.
 *
 * Повтор куска — обычное дело, а не ошибка: связь рвётся, и клиент досылает
 * недостающее. Тот же кусок с тем же отпечатком принимается молча, с другим —
 * отвергается: значит, клиент шлёт не тот файл, и склеивать их нельзя.
 */

import express, { type Express, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { getPrisma } from '../context.js';
import { ensureFeedbackTables } from './tables.js';
import { actorOf, fail, ok, settings } from './policy.js';
import { ERRORS, LIMITS, isUuid, refusedByName, extensionOf } from '../../feedback/contracts.js';

const HEX64 = /^[0-9a-f]{64}$/i;
/** Незакреплённая загрузка живёт сутки: дальше её убирает сборщик. */
const LIFETIME_MS = 24 * 3600 * 1000;
/** Виды вложений и их пределы. */
const KINDS = ['IMAGE', 'FILE', 'DIAGNOSTICS'] as const;

const limitFor = (kind: string): number =>
  kind === 'IMAGE' ? LIMITS.imageBytes : kind === 'DIAGNOSTICS' ? LIMITS.bundleBytes : LIMITS.fileBytes;

/**
 * Настоящий вид файла — по первым байтам, а не по расширению.
 *
 * Расширение ставит человек, и «схема.png» с разметкой HTML внутри открывается
 * браузером как страница. Поэтому имя проверяется первым и самым дешёвым
 * рубежом, а решает содержимое.
 */
export function sniffMime(head: Buffer): string {
  const b = head;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.length >= 5 && b.slice(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  // Office — это zip; какой именно, решает расширение, но zip обязан быть zip
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7)) return 'application/zip';
  // Разметка страницы под видом картинки — самый частый способ подсунуть чужое
  const text = b.slice(0, 512).toString('utf8').trimStart().toLowerCase();
  if (text.startsWith('<!doctype html') || text.startsWith('<html') || text.startsWith('<svg')) return 'text/html';
  return 'application/octet-stream';
}

/** Совпадает ли содержимое с тем, чем файл назвали. */
export function mimeAllowed(kind: string, mime: string, name: string): string {
  if (mime === 'text/html') return 'Разметка страницы вложением не принимается';
  const ext = extensionOf(name);
  if (kind === 'IMAGE') {
    return ['image/png', 'image/jpeg', 'image/webp'].includes(mime) ? '' : 'Это не картинка';
  }
  if (kind === 'DIAGNOSTICS') return '';
  if (mime === 'application/zip') {
    return ['docx', 'xlsx'].includes(ext) ? '' : 'Архивы вложением не принимаются';
  }
  if (mime === 'application/pdf' || mime === 'application/octet-stream') return '';
  return '';
}

export interface UploadDeps {
  /** Размер куска под эту базу; ноль означает «базу надо настроить». */
  feedbackChunkBytes: () => Promise<number>;
}

export function registerUploadRoutes(app: Express, deps: UploadDeps): void {
  const raw = express.raw({ type: 'application/octet-stream', limit: '2mb' });

  /** Общее начало: сессия, таблицы и сама загрузка с проверкой хозяина. */
  async function mine(req: Request, res: Response): Promise<any | null> {
    const actor = actorOf(req);
    if (!actor) { fail(res, ERRORS.FORBIDDEN, 'Нужно войти в программу'); return null; }
    const prisma = getPrisma();
    const failure = await ensureFeedbackTables(prisma);
    if (failure) { fail(res, ERRORS.UNAVAILABLE, failure); return null; }
    const id = String(req.params.id || '');
    if (!isUuid(id)) { fail(res, ERRORS.NOT_FOUND, 'Загрузка не найдена'); return null; }
    const upload = await prisma.feedbackUpload.findUnique({ where: { id } });
    // Чужая загрузка отвечает «не найдено», а не «нельзя»: иначе по ответу
    // можно перебрать, какие идентификаторы существуют
    if (!upload || upload.ownerId !== actor.id) { fail(res, ERRORS.NOT_FOUND, 'Загрузка не найдена'); return null; }
    return { actor, prisma, upload };
  }

  // ── Завести загрузку ──────────────────────────────────────────────────────
  app.post('/api/feedback/uploads', async (req: Request, res: Response) => {
    const actor = actorOf(req);
    if (!actor) return fail(res, ERRORS.FORBIDDEN, 'Нужно войти в программу');
    const prisma = getPrisma();
    const failure = await ensureFeedbackTables(prisma);
    if (failure) return fail(res, ERRORS.UNAVAILABLE, failure);

    const body = (req.body || {}) as Record<string, unknown>;
    const clientRequestId = String(body.clientRequestId || '');
    if (!isUuid(clientRequestId)) return fail(res, ERRORS.VALIDATION, 'clientRequestId: ожидался UUID');
    const kind = String(body.kind || 'FILE');
    if (!(KINDS as readonly string[]).includes(kind)) return fail(res, ERRORS.VALIDATION, 'Неизвестный вид вложения');
    const name = String(body.name || '').slice(0, 200);
    if (!name) return fail(res, ERRORS.VALIDATION, 'Нужно имя файла');
    if (refusedByName(name)) return fail(res, ERRORS.UNSUPPORTED_TYPE, `Файлы «${extensionOf(name)}» вложением не принимаются`);
    const size = Number(body.size || 0);
    if (!Number.isFinite(size) || size <= 0) return fail(res, ERRORS.VALIDATION, 'Нужен размер файла');
    if (size > limitFor(kind)) {
      return fail(res, ERRORS.TOO_LARGE, `Файл больше ${Math.round(limitFor(kind) / 1048576)} МБ не принимается`);
    }
    const sha256 = String(body.sha256 || '').toLowerCase();
    if (!HEX64.test(sha256)) return fail(res, ERRORS.VALIDATION, 'Нужен отпечаток файла');

    // Повтор того же ключа — та же загрузка: обрыв связи не должен заводить
    // вторую и удваивать место
    const already = await prisma.feedbackUpload.findFirst({ where: { ownerId: actor.id, clientRequestId } });
    if (already) {
      return ok(res, {
        uploadId: already.id, chunkSize: already.chunkSize, chunkCount: already.chunkCount,
        expiresAt: already.expiresAt, status: already.status,
      });
    }

    const chunkSize = await deps.feedbackChunkBytes();
    if (!chunkSize) {
      return fail(res, ERRORS.UNAVAILABLE,
        'База настроена так, что вложения через неё не проедут: увеличьте max_allowed_packet');
    }

    const conf = await settings();
    const held = await prisma.feedbackUpload.aggregate({
      _sum: { declaredBytes: true },
      where: { ownerId: actor.id, status: { in: ['OPEN', 'VERIFYING', 'READY'] } },
    });
    // Считаем и зарезервированное, а не только готовое: иначе десять начатых
    // загрузок по сто мегабайт пройдут мимо квоты
    if ((held._sum.declaredBytes || 0) + size > conf.perUserBytes) {
      return fail(res, ERRORS.TOO_LARGE, 'Слишком много незавершённых загрузок: отправьте или отмените начатые');
    }

    const created = await prisma.feedbackUpload.create({
      data: {
        ownerId: actor.id, clientRequestId, draftId: String(body.draftId || '').slice(0, 64),
        kind, originalName: name, declaredBytes: Math.round(size), sha256,
        chunkSize, chunkCount: Math.ceil(size / chunkSize), status: 'OPEN',
        expiresAt: new Date(Date.now() + LIFETIME_MS),
      },
    });
    res.status(201);
    ok(res, {
      uploadId: created.id, chunkSize: created.chunkSize, chunkCount: created.chunkCount,
      expiresAt: created.expiresAt, status: created.status,
    });
  });

  // ── Что уже доехало ───────────────────────────────────────────────────────
  app.get('/api/feedback/uploads/:id', async (req: Request, res: Response) => {
    const found = await mine(req, res);
    if (!found) return;
    const { prisma, upload } = found;
    // Только номера и отпечатки: байты отсюда не отдаются никогда
    const parts = await prisma.feedbackUploadChunk.findMany({
      where: { uploadId: upload.id }, select: { index: true, sha256: true, byteLength: true },
      orderBy: { index: 'asc' },
    });
    ok(res, {
      uploadId: upload.id, status: upload.status, chunkSize: upload.chunkSize,
      chunkCount: upload.chunkCount, received: parts, expiresAt: upload.expiresAt,
      verifiedMime: upload.verifiedMime,
    });
  });

  // ── Один кусок ────────────────────────────────────────────────────────────
  app.put('/api/feedback/uploads/:id/chunks/:index', raw, async (req: Request, res: Response) => {
    const found = await mine(req, res);
    if (!found) return;
    const { prisma, upload } = found;
    if (upload.status !== 'OPEN') return fail(res, ERRORS.UPLOAD_EXPIRED, 'Эта загрузка уже закрыта');
    if (new Date(upload.expiresAt).getTime() < Date.now()) {
      return fail(res, ERRORS.UPLOAD_EXPIRED, 'Срок загрузки истёк, начните заново');
    }

    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0 || index >= upload.chunkCount) {
      return fail(res, ERRORS.VALIDATION, 'Номер куска вне объявленного');
    }
    const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!body.length) return fail(res, ERRORS.VALIDATION, 'Пустой кусок');
    if (body.length > upload.chunkSize) return fail(res, ERRORS.TOO_LARGE, 'Кусок больше согласованного');

    const declared = String(req.get('X-Chunk-SHA256') || '').toLowerCase();
    const real = createHash('sha256').update(body).digest('hex');
    if (declared && declared !== real) return fail(res, ERRORS.VALIDATION, 'Отпечаток куска не сошёлся');

    const before = await prisma.feedbackUploadChunk.findFirst({ where: { uploadId: upload.id, index } });
    if (before) {
      // Тот же кусок прислали ещё раз — обычное дело при обрыве связи
      if (before.sha256 === real) return res.status(204).end();
      // А вот другой кусок под тем же номером означает, что шлют другой файл
      return fail(res, ERRORS.CHUNK_CONFLICT, 'Под этим номером уже лежит другой кусок');
    }
    await prisma.feedbackUploadChunk.create({
      data: { uploadId: upload.id, index, sha256: real, bytes: body, byteLength: body.length },
    });
    res.status(204).end();
  });

  // ── Файл целиком ──────────────────────────────────────────────────────────
  app.post('/api/feedback/uploads/:id/complete', async (req: Request, res: Response) => {
    const found = await mine(req, res);
    if (!found) return;
    const { prisma, upload } = found;
    if (upload.status === 'READY' || upload.status === 'ATTACHED') {
      return ok(res, { uploadId: upload.id, status: upload.status, verifiedMime: upload.verifiedMime });
    }
    if (upload.status !== 'OPEN') return fail(res, ERRORS.UPLOAD_EXPIRED, 'Эта загрузка уже закрыта');

    const parts = await prisma.feedbackUploadChunk.findMany({
      where: { uploadId: upload.id }, orderBy: { index: 'asc' },
    });
    if (parts.length !== upload.chunkCount) {
      return fail(res, ERRORS.VALIDATION, `Доехало ${parts.length} кусков из ${upload.chunkCount}`);
    }

    // Отпечаток считается по кускам подряд, без сборки файла в памяти: иначе
    // проверка стоила бы столько же места, сколько сам файл
    const digest = createHash('sha256');
    let total = 0;
    let head = Buffer.alloc(0);
    for (const part of parts) {
      const bytes = Buffer.from(part.bytes);
      if (head.length < 512) head = Buffer.concat([head, bytes.slice(0, 512 - head.length)]);
      digest.update(bytes);
      total += bytes.length;
    }
    const real = digest.digest('hex');
    if (real !== upload.sha256) {
      await prisma.feedbackUpload.update({ where: { id: upload.id }, data: { status: 'REJECTED' } });
      return fail(res, ERRORS.VALIDATION, 'Файл собрался не тем: отпечаток не сошёлся');
    }
    if (total !== upload.declaredBytes) {
      await prisma.feedbackUpload.update({ where: { id: upload.id }, data: { status: 'REJECTED' } });
      return fail(res, ERRORS.VALIDATION, 'Размер собранного файла не совпал с объявленным');
    }

    const mime = sniffMime(head);
    const refusal = mimeAllowed(upload.kind, mime, upload.originalName);
    if (refusal) {
      await prisma.feedbackUpload.update({ where: { id: upload.id }, data: { status: 'REJECTED', verifiedMime: mime } });
      return fail(res, ERRORS.UNSUPPORTED_TYPE, refusal);
    }

    const done = await prisma.feedbackUpload.update({
      where: { id: upload.id },
      data: { status: 'READY', verifiedMime: mime, revision: { increment: 1 } },
    });
    ok(res, { uploadId: done.id, status: done.status, verifiedMime: done.verifiedMime, byteLength: total });
  });

  // ── Отменить свою загрузку ────────────────────────────────────────────────
  app.delete('/api/feedback/uploads/:id', async (req: Request, res: Response) => {
    const found = await mine(req, res);
    if (!found) return;
    const { prisma, upload } = found;
    if (upload.status === 'ATTACHED') {
      return fail(res, ERRORS.FORBIDDEN, 'Это вложение уже приложено к обращению');
    }
    // Помечаем, а не стираем: байты уберёт сборщик, перепроверив состояние —
    // загрузка могла стать вложением между выбором и удалением
    await prisma.feedbackUpload.update({
      where: { id: upload.id }, data: { status: 'EXPIRED', expiresAt: new Date() },
    });
    ok(res, { uploadId: upload.id, status: 'EXPIRED' });
  });
}
