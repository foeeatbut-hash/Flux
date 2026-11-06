import type { StoreListing } from '../../modules/store/model.js';
import { validCrashBatch, MODULE_CRASH_RETENTION_MS, type ModuleCrashCount } from '../../feedback/moduleCrashes.js';
import { compareVersions } from '../../shared/versionCompare.js';
import { randomUUID } from 'node:crypto';
import { openEnvelope } from '../../modules/trust/envelope.js';
import { parseReleaseClaim } from '../../modules/trust/claims.js';
import { loadTrust, MODULE_ROOT_KEY_HEX } from '../moduleStore.js';

export const CRASH_PREFIX = 'modules.crash.batch.';
/** Флаг администратора остаётся рабочей отметкой: публикацию подтверждает разработчик. */
export async function confirmedKnownProblems(db: any, rootHex = MODULE_ROOT_KEY_HEX): Promise<any[]> {
  const known = await db.feedbackReport.findMany({ where: { moduleKnown: true, moduleForwarded: false, moduleId: { not: null }, status: { notIn: ['DONE', 'REJECTED', 'DUPLICATE', 'WITHDRAWN'] } },
    select: { id: true, number: true, moduleId: true, title: true, moduleWorkaround: true }, take: 1000 });
  if (!known.length) return [];
  const [events, releases, trust] = await Promise.all([
    db.feedbackEvent.findMany({ where: { reportId: { in: known.map((r: any) => r.id) }, kind: 'module-known' }, orderBy: { revision: 'desc' }, select: { reportId: true, actorId: true, dataJson: true } }),
    db.moduleRelease.findMany({ where: { moduleId: { in: [...new Set(known.map((r: any) => r.moduleId))] } }, select: { moduleId: true, version: true, signature: true } }),
    loadTrust(db, rootHex),
  ]);
  const developers = new Map<string, Set<string>>();
  for (const release of releases) {
    const c = parseReleaseClaim(openEnvelope('release', release.signature, rootHex));
    const certificate = c && trust.certificates.get(c.author);
    if (!certificate || c.moduleId !== release.moduleId || c.version !== release.version) continue;
    if (!developers.has(c.moduleId)) developers.set(c.moduleId, new Set());
    developers.get(c.moduleId)!.add(certificate.userId);
  }
  const latest = new Map<string, any>();
  for (const event of events) if (!latest.has(event.reportId)) latest.set(event.reportId, event);
  return known.filter((r: any) => {
    const event = latest.get(r.id);
    if (!event || !developers.get(r.moduleId)?.has(event.actorId)) return false;
    try { return JSON.parse(event.dataJson).moduleKnown === true; } catch { return false; }
  });
}

export async function expireModuleCrashes(db: any, now = Date.now()): Promise<number> {
  const result = await db.appSetting.deleteMany({ where: { key: { startsWith: CRASH_PREFIX }, userId: null, updatedAt: { lt: new Date(now - MODULE_CRASH_RETENTION_MS) } } });
  return result.count;
}

export async function moduleSignals(db: any, rootHex = MODULE_ROOT_KEY_HEX, now = Date.now()) {
  const [batches, known] = await Promise.all([
    db.appSetting.findMany({ where: { key: { startsWith: CRASH_PREFIX }, userId: null, updatedAt: { gte: new Date(now - MODULE_CRASH_RETENTION_MS) } }, select: { value: true } }),
    confirmedKnownProblems(db, rootHex),
  ]);
  const counts = new Map<string, ModuleCrashCount>();
  for (const row of batches) {
    let b: unknown; try { b = JSON.parse(row.value); } catch { continue; }
    if (!validCrashBatch(b)) continue;
    for (const e of b.events) {
      const key = `${e.moduleId}@${e.version}:${e.kind}`;
      const previous = counts.get(key);
      counts.set(key, { ...e, count: e.count + (previous?.count || 0) });
    }
  }
  return { counts: [...counts.values()], known };
}

/** Наличие доступного выпуска проверяется до уведомления, как и кнопка в карточке. */
export async function queueModuleFixNotices(db: any, userId: string, listings: StoreListing[]) {
  const reports = await db.feedbackReport.findMany({ where: { authorId: userId, moduleId: { not: null }, resolvedVersion: { not: null }, status: { in: ['VERIFY', 'DONE'] } } });
  for (const report of reports) {
    const l = listings.find((x) => x.moduleId === report.moduleId && x.status === 'admitted' && !x.deprecated && compareVersions(x.version, report.resolvedVersion) >= 0);
    if (!l) continue;
    const dedupeKey = `moduleFix:${report.id}:${report.resolvedVersion}:${userId}`;
    await db.feedbackOutbox.upsert({ where: { dedupeKey }, update: {}, create: {
      id: randomUUID(), dedupeKey, reportId: report.id, recipientId: userId, publicRevision: report.revision,
      kind: 'moduleFix', payloadJson: JSON.stringify({ number: report.number, title: report.title, moduleId: l.moduleId, version: report.resolvedVersion }),
    } });
  }
}
