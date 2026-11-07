import { openEnvelope } from '../../modules/trust/envelope.js';
import { parseReleaseClaim } from '../../modules/trust/claims.js';
import { loadTrust, MODULE_ROOT_KEY_HEX } from '../moduleStore.js';
import { safeModuleDiagnostics } from '../../feedback/moduleContext.js';
import { buildListings } from '../moduleListings.js';
import { compareVersions } from '../../shared/versionCompare.js';

export interface ModuleFeedbackDeps { modulePublicKeyHex?: string }
export const feedbackRoot = (deps: ModuleFeedbackDeps) => deps.modulePublicKeyHex ?? MODULE_ROOT_KEY_HEX;

/** Сертификат удостоверяет ключ; право на конкретную подпрограмму — её выпуск владельца. */
export async function developerModules(db: any, userId: string, rootHex = MODULE_ROOT_KEY_HEX): Promise<string[]> {
  const trust = await loadTrust(db, rootHex);
  const keys = new Set([...trust.certificates.values()].filter((c) => c.userId === userId).map((c) => c.key));
  if (!keys.size) return [];
  const rows = await db.moduleRelease.findMany({ select: { signature: true, moduleId: true, version: true } });
  return [...new Set<string>(rows.map((r: any) => {
    const c = parseReleaseClaim(openEnvelope('release', r.signature, rootHex));
    return c && c.moduleId === r.moduleId && c.version === r.version && keys.has(c.author) ? c.moduleId : '';
  }).filter(Boolean))];
}

export async function moduleHandler(db: any, userId: string, report: any, rootHex = MODULE_ROOT_KEY_HEX): Promise<boolean> {
  return !!report?.moduleId && !report.moduleForwarded && (await developerModules(db, userId, rootHex)).includes(report.moduleId);
}

/** Для разработчика пакет строится заново по разрешённым полям, а не вырезается из полного архива. */
export function developerPackage(report: any) {
  return {
    moduleId: report.moduleId, moduleVersion: report.moduleVersion, moduleChannel: report.moduleChannel,
    moduleApiVersion: report.moduleApiVersion, appVersion: report.appVersion,
    title: report.title, description: report.description,
    diagnostics: safeModuleDiagnostics(parseJson(report.moduleDiagnosticsJson)),
  };
}
export function parseJson(text: string): any { try { return JSON.parse(text || '{}'); } catch { return {}; } }

export async function moduleRecipients(db: any, moduleId: string, rootHex = MODULE_ROOT_KEY_HEX): Promise<string[]> {
  const trust = await loadTrust(db, rootHex);
  const rows = await db.moduleRelease.findMany({ where: { moduleId }, select: { signature: true } });
  const authors = new Set(rows.map((r: any) => parseReleaseClaim(openEnvelope('release', r.signature, rootHex))?.author).filter(Boolean));
  return [...new Set([...trust.certificates.values()].filter((c) => authors.has(c.key)).map((c) => c.userId))];
}

/** Только доступный этому человеку выпуск Store даёт обещание «Обновить». */
export async function moduleFix(db: any, user: any, report: any, rootHex = MODULE_ROOT_KEY_HEX) {
  if (!report.moduleId || !report.resolvedVersion || !['VERIFY', 'DONE'].includes(report.status)) return {};
  const { listings } = await buildListings(db, user, rootHex);
  const listing = listings.find((l) => l.moduleId === report.moduleId);
  const available = !!listing && listing.status === 'admitted' && !listing.deprecated
    && compareVersions(listing.version, report.resolvedVersion) >= 0;
  return { moduleFixAvailable: available, ...(available ? { moduleFixVersion: listing!.version } : {}) };
}
