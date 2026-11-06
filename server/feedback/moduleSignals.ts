import type { StoreListing } from '../../modules/store/model.js';
import { validCrashBatch, type ModuleCrashCount } from '../../feedback/moduleCrashes.js';
import { compareVersions } from '../../shared/versionCompare.js';
import { randomUUID } from 'node:crypto';

export const CRASH_PREFIX = 'modules.crash.batch.';
export async function moduleSignals(db: any) {
  const [batches, known] = await Promise.all([
    db.appSetting.findMany({ where: { key: { startsWith: CRASH_PREFIX }, userId: null }, select: { value: true } }),
    db.feedbackReport.findMany({ where: { moduleKnown: true, moduleForwarded: false, status: { notIn: ['DONE', 'REJECTED', 'DUPLICATE', 'WITHDRAWN'] } },
      select: { id: true, number: true, moduleId: true, title: true, moduleWorkaround: true }, take: 1000 }),
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
