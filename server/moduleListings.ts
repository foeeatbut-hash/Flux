/**
 * Витрина Flux Store: из выпусков, решений администратора, отзывов и
 * установок человека собирается список карточек.
 *
 * Сервер здесь только показывает: данные манифеста он читает из пакета
 * выпуска, но запускает и подтверждает разрешения Flux по тем байтам, что
 * проверил сам (electron/moduleCache.ts). Карточка может соврать — выпуск
 * из-за этого не запустится и не получит больше, чем показано, потому что
 * окно сверяет отпечаток разрешений после проверки (см. permissionsDigest).
 */
import { peekEnvelope } from '../modules/trust/envelope.js';
import { parseReleaseClaim, parseRequestClaim } from '../modules/trust/claims.js';
import { unpackBundle, bundleText } from '../modules/trust/bundle.js';
import { compareVersions } from '../shared/versionCompare.js';
import {
  permissionLines, storeInfoOf, type StoreListing, type StoreStatus, type StoreVersion,
} from '../modules/store/model.js';
import type { ModuleManifest } from '../modules/contract.js';
import { loadTrust, readBundle, MODULE_ROOT_KEY_HEX } from './moduleStore.js';
import { channelsFor, positionsOf } from './moduleChannels.js';

interface ReleaseInfo { manifest: ModuleManifest | null; changelog: string; author: string; notBefore: number }
const cache = new Map<string, ReleaseInfo>();

const parseJsonList = (text: unknown): string[] => {
  try { const v = JSON.parse(String(text || '[]')); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
};

/** Манифест и «что нового» выпуска; считается один раз на выпуск — пакеты не меняются */
async function infoOf(db: any, release: any): Promise<ReleaseInfo> {
  const key = `${release.id}:${release.sha256}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let manifest: ModuleManifest | null = null;
  try {
    const files = unpackBundle(await readBundle(db, release.blobId, release.chunkCount));
    manifest = JSON.parse(bundleText(files, 'manifest.json') || 'null');
  } catch { /* битый пакет в витрине не показываем подробностями */ }
  const request = await db.moduleRequest.findUnique({ where: { id: release.requestId } }).catch(() => null);
  const asked = request ? parseRequestClaim(peekEnvelope('request', request.signature)) : null;
  const claim = parseReleaseClaim(peekEnvelope('release', release.signature));
  const info = { manifest, changelog: asked?.meta.changelog || '', author: claim?.author || '', notBefore: claim?.notBefore || 0 };
  if (cache.size > 2000) cache.clear();
  cache.set(key, info);
  return info;
}

export async function entryOf(db: any, moduleId: string) {
  return (await db.moduleStoreEntry.findUnique({ where: { moduleId } }).catch(() => null))
    || { moduleId, status: 'pending', deprecated: false, pinVersion: '', pinRoles: '[]', requiredRoles: '[]', requiredVersion: '', note: '' };
}

export const appliesTo = (roles: string[], user: any) => roles.length === 0 || positionsOf(user).some((p) => roles.includes(p));

export interface Built { listings: StoreListing[]; autoUpdate: boolean }

export async function buildListings(db: any, user: any, rootHex = MODULE_ROOT_KEY_HEX, now = Date.now()): Promise<Built> {
  const admin = user?.role === 'OWNER' || user?.role === 'ADMIN';
  const channels = await channelsFor(db, user);
  const [releases, entries, installs, reviews, trust, autoRow] = await Promise.all([
    db.moduleRelease.findMany({ orderBy: { createdAt: 'desc' }, take: 3000 }),
    db.moduleStoreEntry.findMany({ take: 2000 }),
    db.moduleInstall.findMany({ select: { userId: true, moduleId: true, version: true, source: true, autoUpdate: true, installedAt: true }, take: 100000 }),
    db.moduleReview.findMany({ where: { hidden: false }, select: { moduleId: true, rating: true }, take: 100000 }),
    loadTrust(db, rootHex),
    db.appSetting.findFirst({ where: { key: 'modules.autoupdate', userId: String(user?.id || '') } }).catch(() => null),
  ]);
  const entryBy = new Map<string, any>(entries.map((e: any) => [e.moduleId, e]));
  const byModule = new Map<string, any[]>();
  for (const r of releases) {
    if (!channels.includes(r.channel)) continue;
    (byModule.get(r.moduleId) || byModule.set(r.moduleId, []).get(r.moduleId)!).push(r);
  }
  const listings: StoreListing[] = [];
  for (const [moduleId, rows] of byModule) {
    rows.sort((a, b) => compareVersions(b.version, a.version));
    const entry = entryBy.get(moduleId) || { status: 'pending', deprecated: false, pinVersion: '', pinRoles: '[]', requiredRoles: '[]', requiredVersion: '' };
    const mineRow = installs.find((i: any) => i.userId === user?.id && i.moduleId === moduleId) || null;
    // Запрещённую не показывает никому, кроме администратора; снятую и ждущую допуска — только тем, у кого она уже стоит
    const status = entry.status as StoreStatus;
    if (!admin && (status === 'banned' || (status !== 'admitted' && !mineRow))) continue;
    const infos = await Promise.all(rows.map((r) => infoOf(db, r)));
    const versions: StoreVersion[] = rows.map((r, i) => ({ version: r.version, channel: r.channel, revoked: r.state === 'revoked', createdAt: new Date(r.createdAt).toISOString(),
      changelog: infos[i].changelog, size: r.size, releaseId: r.id }));
    const live = rows.map((r, i) => ({ r, i })).filter(({ r, i }) => r.state !== 'revoked' && infos[i].notBefore <= now);
    if (!live.length) continue;
    const pinRoles = parseJsonList(entry.pinRoles);
    const pinned = entry.pinVersion && appliesTo(pinRoles, user) ? entry.pinVersion : null;
    // Новейшая версия для человека не выше закрепления администратора
    const top = live.find(({ r }) => !pinned || compareVersions(r.version, pinned) <= 0) || live[live.length - 1];
    const manifest = infos[top.i].manifest;
    if (!manifest) continue;
    const info = storeInfoOf(manifest);
    const stars = [0, 0, 0, 0, 0];
    let sum = 0, count = 0;
    for (const v of reviews) if (v.moduleId === moduleId) { stars[5 - v.rating]++; sum += v.rating; count++; }
    const required = parseJsonList(entry.requiredRoles);
    const developer = trust.certificates.get(infos[top.i].author)?.name || manifest.author;
    listings.push({
      moduleId, name: manifest.name, developer, category: info.category, summary: info.summary, description: info.description, color: info.color,
      requires: info.requires, dependsOn: info.dependsOn, roles: info.roles, manifest, permissions: permissionLines(manifest),
      version: top.r.version, channel: top.r.channel, updatedAt: new Date(top.r.createdAt).toISOString(), changelog: infos[top.i].changelog,
      size: top.r.size, releaseId: top.r.id,
      screenshots: info.screenshots.map((p) => `/api/modules/releases/${top.r.id}/file?path=${encodeURIComponent(p)}`),
      versions, status, deprecated: !!entry.deprecated, testing: top.r.channel === 'test', rating: { avg: count ? sum / count : 0, count, stars },
      installs: installs.filter((i: any) => i.moduleId === moduleId).length, pinned,
      required: required.length > 0 && entry.requiredVersion && positionsOf(user).some((p) => required.includes(p)) ? entry.requiredVersion : null,
      mine: mineRow ? { version: mineRow.version, auto: mineRow.autoUpdate || '', source: mineRow.source, installedAt: new Date(mineRow.installedAt).toISOString() } : null,
      forMyRole: info.roles.length === 0 || appliesTo(info.roles, user), known: [], crashes: null,
    });
  }
  return { listings, autoUpdate: autoRow?.value === '1' };
}
