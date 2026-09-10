/**
 * Сборка пакета диагностики — устойчивой фоновой задачей.
 *
 * Раньше это был вызов без ожидания: `void describeBundles(id)`. Пока сервер
 * жив, оно работало, но перезапуск в неудачный момент означал, что пакет не
 * соберётся уже никогда, — и узнать об этом было неоткуда: карточка выглядела
 * обычной, просто без сводки.
 *
 * Теперь работа лежит в базе строкой с арендой, ровно как уведомления в
 * `outbox.ts`. Перезапуск сервера её не теряет, два сервера не берут одну и ту
 * же дважды, а состояние сборки видно в карточке: собирается, готов, готов но
 * неполон, собрать не удалось.
 *
 * Что собирается: события окна и оболочки приходят вложением от клиента,
 * события сервера и базы сервер добирает у себя — по СВОИМ записям о запросах
 * этого сотрудника, а не по меткам, которые клиент прислал (`collect.ts`).
 */

import { randomUUID } from 'node:crypto';
import { getPrisma, onDatabaseSwapped } from '../context.js';
import { summarize, parseJsonl } from '../../diagnostics/summary.js';
import { technicalFingerprint } from '../../feedback/fingerprint.js';
import { sha256Hex } from '../../feedback/sha256.js';
import {
  BUNDLE_SCHEMA_VERSION, WINDOW_BEFORE_MS, WINDOW_TOTAL_MS, bundleStateOf,
  type BundleManifest, type SourceReport,
} from '../../feedback/bundleSpec.js';
import { collectServerSources } from './collect.js';

/** Больше этого не разбираем: источник ограничен при приёме. */
const MAX_BYTES = 8 * 1024 * 1024;
/** Как часто заглядываем за работой и насколько берём её себе. */
const EVERY_MS = 20_000;
const LEASE_MS = 120_000;
/** Сколько раз пробуем, прежде чем признать, что не собралось. */
const MAX_ATTEMPTS = 5;
/** Имена частей — те же, что кладёт окно (`src/feedback/collectBundle.ts`). */
const MANIFEST_NAME = 'опись.json';
const SERVER_NAME = 'диагностика-сервер.jsonl';

/**
 * Отпечаток по разобранным событиям.
 *
 * Берётся первая ошибка: она и есть то, на что человек жалуется. Кадры стека
 * лежат в полях события уже очищенными — путь установки и номера строк из них
 * убраны при записи.
 */
export function fingerprintOfEvents(events: any[], appVersion: string, sectionKey: string): string {
  const failure = events.find((e) => e?.event === 'log.error' || e?.data?.outcome === 'fail'
    || e?.fields?.outcome === 'fail');
  if (!failure) return '';
  const fields = failure.data || failure.fields || {};
  const frames = [fields.frame1, fields.frame2, fields.frame3].filter(Boolean);
  return technicalFingerprint({
    appVersion,
    sectionKey,
    errorCode: String(fields.code || fields.error || failure.event || ''),
    frames,
  });
}

/**
 * Поставить сборку в очередь.
 *
 * Зовётся сразу после создания обращения. Ничего не собирает — только
 * записывает, что собрать надо: создание карточки не должно ждать чтения
 * журналов, а перезапуск сервера не должен эту работу терять.
 */
export async function scheduleBundle(reportId: string, snapshotId = ''): Promise<void> {
  const prisma = getPrisma();
  if (!prisma || !reportId) return;
  try {
    const already = await prisma.feedbackDiagnosticBundle.findFirst({
      where: { reportId }, select: { id: true },
    });
    if (already) return;
    // `attachmentId` в модели уникален и обязателен: до появления настоящего
    // вложения кладём метку самой работы — она уникальна по построению
    await prisma.feedbackDiagnosticBundle.create({
      data: {
        reportId, attachmentId: `job:${reportId}`,
        state: 'PENDING', schemaVer: BUNDLE_SCHEMA_VERSION,
        ...(snapshotId ? { snapshotId } : {}),
        manifestJson: '{}', summaryJson: '{}',
      },
    });
    // Толчок сразу, не дожидаясь очередного круга: собранная через двадцать
    // секунд сводка — это двадцать секунд, которые разбирающий смотрит на
    // «собирается». Таймер остаётся страховкой на случай перезапуска
    void drainBundles();
  } catch (_) {
    // Не записалось — карточка всё равно создана. Сводки не будет, и в
    // карточке это видно: состояния «готов» она не получит
  }
}

/** Прочитать вложение целиком. Пакеты небольшие — собираем в памяти. */
async function readAttachment(prisma: any, uploadId: string): Promise<string> {
  const parts = await prisma.feedbackUploadChunk.findMany({
    where: { uploadId }, orderBy: { index: 'asc' }, select: { bytes: true },
  });
  if (!parts.length) return '';
  return Buffer.concat(parts.map((p: any) => Buffer.from(p.bytes))).toString('utf8');
}

/**
 * Положить собранное сервером отдельным вложением.
 *
 * Через ту же машинерию, что и файлы человека: тогда его читает тот же
 * маршрут, на него распространяется та же уборка и те же права.
 */
async function storeServerPart(
  prisma: any, report: any, name: string, text: string,
): Promise<string> {
  const bytes = Buffer.from(text, 'utf8');
  const sha = sha256Hex(bytes);
  const upload = await prisma.feedbackUpload.create({
    data: {
      ownerId: report.authorId,
      clientRequestId: randomUUID(),
      draftId: '',
      kind: 'DIAGNOSTICS',
      originalName: name,
      verifiedMime: 'application/x-ndjson',
      declaredBytes: bytes.length,
      sha256: sha,
      chunkSize: bytes.length,
      chunkCount: 1,
      status: 'ATTACHED',
      reportId: report.id,
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    },
  });
  await prisma.feedbackUploadChunk.create({
    data: { uploadId: upload.id, index: 0, sha256: sha, bytes, byteLength: bytes.length },
  });
  const attachment = await prisma.feedbackAttachment.create({
    data: {
      reportId: report.id, uploadId: upload.id, kind: 'DIAGNOSTICS',
      displayName: name, mime: 'application/x-ndjson',
      byteLength: bytes.length, sha256: sha,
    },
  });
  return attachment.id;
}

/**
 * Собрать один пакет.
 *
 * Порядок такой: взять то, что приложило окно, добрать своё, слить описи,
 * посчитать сводку и отпечаток. Неполнота на любом шаге — не отказ: она
 * записывается в опись, и разбирающий видит, чего именно не хватает.
 */
async function assemble(prisma: any, row: any): Promise<void> {
  const report = await prisma.feedbackReport.findUnique({
    where: { id: row.reportId },
    select: {
      id: true, authorId: true, appVersion: true, sectionKey: true,
      incidentAt: true, snapshotId: true, buildId: true,
    },
  });
  if (!report) {
    await prisma.feedbackDiagnosticBundle.update({
      where: { id: row.id },
      data: { state: 'FAILED', leaseUntil: null, leaseOwner: null, manifestJson: JSON.stringify({ error: 'Карточка исчезла' }) },
    });
    return;
  }

  const attachments = await prisma.feedbackAttachment.findMany({
    where: { reportId: report.id, kind: 'DIAGNOSTICS' },
    select: { id: true, uploadId: true, byteLength: true, displayName: true },
  });

  // Опись от окна: в ней сказано, что окно смогло собрать и чего не смогло
  let clientManifest: Partial<BundleManifest> = {};
  const manifestPart = attachments.find((a: any) => a.displayName === MANIFEST_NAME);
  if (manifestPart && manifestPart.byteLength <= MAX_BYTES) {
    try {
      clientManifest = JSON.parse(await readAttachment(prisma, manifestPart.uploadId)) || {};
    } catch (_) { /* опись битая — соберём свою */ }
  }

  // События окна и оболочки
  let clientText = '';
  for (const one of attachments) {
    if (one.displayName === MANIFEST_NAME || one.displayName === SERVER_NAME) continue;
    if (one.byteLength > MAX_BYTES) continue;
    clientText += await readAttachment(prisma, one.uploadId);
  }

  const incident = report.incidentAt ? new Date(report.incidentAt).getTime() : Date.now();
  const from = incident - WINDOW_BEFORE_MS;
  const to = incident + (WINDOW_TOTAL_MS - WINDOW_BEFORE_MS);

  const own = await collectServerSources({ from, to, actorId: report.authorId });
  let serverAttachmentId = '';
  const serverText = own.serverText + own.databaseText;
  if (serverText) {
    serverAttachmentId = await storeServerPart(prisma, report, SERVER_NAME, serverText);
  }

  const sources: SourceReport[] = [
    ...((clientManifest.sources || []) as SourceReport[]),
    ...own.reports,
  ];

  const { events, broken } = parseJsonl(clientText + serverText);
  const summary = summarize(events);
  const fingerprint = fingerprintOfEvents(events, report.appVersion || '', report.sectionKey || '');

  const manifest: BundleManifest = {
    bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
    snapshotId: String(clientManifest.snapshotId || row.snapshotId || report.snapshotId || ''),
    reportId: report.id,
    appVersion: report.appVersion || undefined,
    buildId: report.buildId || undefined,
    incidentSessionId: clientManifest.incidentSessionId,
    sectionKey: report.sectionKey || undefined,
    requestedFrom: new Date(from).toISOString(),
    requestedTo: new Date(to).toISOString(),
    timeOrigin: clientManifest.timeOrigin,
    sources,
    state: bundleStateOf(sources),
    builtAt: new Date().toISOString(),
  };
  // Битые строки — тоже неполнота, и молчать о них нельзя
  if (broken > 0 && manifest.state === 'READY') manifest.state = 'PARTIAL';

  await prisma.feedbackDiagnosticBundle.update({
    where: { id: row.id },
    data: {
      state: manifest.state,
      manifestJson: JSON.stringify({ ...manifest, broken, lines: events.length }),
      summaryJson: JSON.stringify(summary),
      ...(fingerprint ? { fingerprint } : {}),
      ...(serverAttachmentId ? { attachmentId: serverAttachmentId } : {}),
      ...(manifest.snapshotId ? { snapshotId: manifest.snapshotId } : {}),
      ...(clientManifest.incidentSessionId ? { sessionId: clientManifest.incidentSessionId } : {}),
      leaseUntil: null, leaseOwner: null,
    },
  });
}

/**
 * Один проход сборщика.
 *
 * Захват — тем же приёмом, что в очереди уведомлений: сначала `updateMany`
 * ставит аренду, потом читаем по своему владельцу. Иначе два сервера возьмут
 * одну работу и сделают два вложения на одну карточку.
 */
export async function drainBundles(): Promise<number> {
  const prisma = getPrisma();
  if (!prisma) return 0;
  const token = randomUUID();
  const now = new Date();
  let done = 0;

  try {
    await prisma.feedbackDiagnosticBundle.updateMany({
      where: {
        state: 'PENDING',
        availableAt: { lte: now },
        attempt: { lt: MAX_ATTEMPTS },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      data: {
        leaseOwner: token,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
        attempt: { increment: 1 },
      },
    });
    const mine = await prisma.feedbackDiagnosticBundle.findMany({
      where: { leaseOwner: token }, take: 5,
    });

    for (const row of mine) {
      try {
        await assemble(prisma, row);
        done++;
      } catch (failed: any) {
        // Ещё попытка — но не бесконечно: пятая объявляет неудачу словами
        const last = row.attempt + 1 >= MAX_ATTEMPTS;
        await prisma.feedbackDiagnosticBundle.update({
          where: { id: row.id },
          data: {
            state: last ? 'FAILED' : 'PENDING',
            availableAt: new Date(Date.now() + 60_000 * (row.attempt + 1)),
            leaseUntil: null, leaseOwner: null,
            ...(last ? {
              manifestJson: JSON.stringify({
                error: `Собрать не удалось за ${MAX_ATTEMPTS} попыток: ${String(failed?.message || failed).slice(0, 200)}`,
              }),
            } : {}),
          },
        }).catch(() => { /* база могла смениться на ходу */ });
      }
    }
  } catch (_) { /* проход не удался — попробуем на следующем */ }
  return done;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startBundles(): void {
  if (timer) return;
  timer = setInterval(() => { void drainBundles(); }, EVERY_MS);
  // Ожидание не держит процесс: иначе программа не закрывалась бы
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopBundles(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

// База может смениться на ходу (вход в другой контур) — сборщик переучреждаем
onDatabaseSwapped(() => { stopBundles(); startBundles(); });
