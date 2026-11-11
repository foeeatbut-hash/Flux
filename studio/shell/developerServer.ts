/**
 * Что Studio спрашивает у сервера для разделов разработчика: сертификат, запросы, выпуски, ошибки.
 *
 * Каждый ответ сервера приводится к короткому виду с пределами длины: в окно уходит только перечисленное,
 * а не то, что сервер когда-нибудь добавит в ответ.
 */
import { randomUUID } from 'node:crypto';
import { compareVersions } from '../../shared/versionCompare';
import { MODULE_VERSION } from '../../modules/trust/claims';
import { ownModules, studioBinary, studioRequest, StudioFailure } from './api';

export interface Session { origin: string; token: string }
const clip = (value: unknown, max: number) => String(value ?? '').slice(0, max);

export interface CertificateStatus { status: 'none' | 'issued' | 'revoked' | 'foreign'; name: string }
export async function certificateStatus(s: Session, key: string): Promise<CertificateStatus> {
  const reply = await studioRequest<{ status?: string; name?: string }>(s.origin, 'certificate', { token: s.token, query: { key } });
  const status = ['none', 'issued', 'revoked', 'foreign'].includes(String(reply.status)) ? reply.status as CertificateStatus['status'] : 'none';
  return { status, name: clip(reply.name, 160) };
}

export interface RequestRow {
  id: string; moduleId: string; version: string; state: string; parentId: string | null; changelog: string; channel: string;
  createdAt: string; decidedAt: string | null; review: { note: string; comments: Array<{ path: string; line: number | null; text: string }> } | null;
}
export async function ownRequests(s: Session): Promise<RequestRow[]> {
  const reply = await studioRequest<{ requests?: any[] }>(s.origin, 'requests', { token: s.token });
  return (Array.isArray(reply.requests) ? reply.requests : []).slice(0, 200).map((r: any) => ({
    id: clip(r.id, 64), moduleId: clip(r.moduleId, 64), version: clip(r.version, 40), state: clip(r.state, 24), parentId: r.parentId ? clip(r.parentId, 64) : null,
    changelog: clip(r.changelog, 4000), channel: clip(r.channel, 12), createdAt: clip(r.createdAt, 40), decidedAt: r.decidedAt ? clip(r.decidedAt, 40) : null,
    review: r.review ? {
      note: clip(r.review.note, 8000),
      comments: (Array.isArray(r.review.comments) ? r.review.comments : []).slice(0, 200).map((c: any) => ({
        path: clip(c.path, 240), line: Number.isSafeInteger(c.line) ? c.line : null, text: clip(c.text, 4000),
      })),
    } : null,
  }));
}

export const ownBundle = (s: Session, id: string) => studioBinary(s.origin, 'requestBundle', { token: s.token, params: { id } });

/** Последний выпуск подпрограммы автора: от него владелец видит разницу; null — подпрограмма новая */
export async function lastRelease(s: Session, moduleId: string): Promise<{ version: string; state: string } | null> {
  const reply = await studioRequest<{ releases?: any[] }>(s.origin, 'releases', { token: s.token, query: { moduleId } });
  const live = (Array.isArray(reply.releases) ? reply.releases : []).filter(r => r.state !== 'revoked' && MODULE_VERSION.test(String(r.version)));
  live.sort((a, b) => compareVersions(String(b.version), String(a.version)));
  return live[0] ? { version: String(live[0].version), state: clip(live[0].state, 20) } : null;
}

/** Предупреждение «обновите Studio»: договор мог измениться, если Flux в общей базе новее */
export async function versionWarning(origin: string, studio: string): Promise<string> {
  try {
    const health = await studioRequest<{ version?: string }>(origin, 'health', { timeoutMs: 5000 });
    const flux = clip(health.version, 40);
    if (flux && compareVersions(studio, flux) < 0) {
      return `Studio ${studio} старее Flux ${flux} в общей базе: договор подпрограмм мог измениться. Обновите Studio перед отправкой.`;
    }
  } catch { /* версия не определилась — предупреждать не о чем */ }
  return '';
}

export interface ErrorsView {
  reports: Array<{ id: string; number: number; title: string; moduleId: string; moduleVersion: string; status: string; impact: string; priority: string;
    revision: number; resolvedVersion: string | null; createdAt: string; known: boolean }>;
  crashes: Array<{ moduleId: string; version: string; kind: string; count: number }>;
}
export async function ownErrors(s: Session, owner = false): Promise<ErrorsView> {
  const [reports, crashes, modules] = await Promise.all([
    studioRequest<{ data?: any[] }>(s.origin, 'reports', { token: s.token, query: { scope: 'modules', modules: '1', limit: 100 } }),
    studioRequest<{ data?: any[] }>(s.origin, 'crashes', { token: s.token }),
    ownModules(s.origin, s.token),
  ]);
  // Сервер отдаёт счётчики администратору по всем подпрограммам; в Studio каждый видит только свои, владелец — все
  const mine = new Set(modules.map(m => m.moduleId));
  return {
    reports: (Array.isArray(reports.data) ? reports.data : []).slice(0, 100).map((r: any) => ({
      id: clip(r.id, 64), number: Number(r.number) || 0, title: clip(r.title, 200), moduleId: clip(r.moduleId, 64), moduleVersion: clip(r.moduleVersion, 40),
      status: clip(r.status, 20), impact: clip(r.impact, 12), priority: clip(r.priority, 4), revision: Number(r.revision) || 1,
      resolvedVersion: r.resolvedVersion ? clip(r.resolvedVersion, 40) : null, createdAt: clip(r.createdAt, 40), known: r.moduleKnown === true,
    })),
    crashes: (Array.isArray(crashes.data) ? crashes.data : []).filter((c: any) => owner || mine.has(String(c.moduleId))).slice(0, 500).map((c: any) => ({
      moduleId: clip(c.moduleId, 64), version: clip(c.version, 40), kind: clip(c.kind, 20), count: Number(c.count) || 0,
    })),
  };
}

/** «Исправлено в версии»: обращение уходит на проверку автору, ему приходит «Обновить» */
export async function markFixed(s: Session, p: { reportId: string; version: string; revision: number }): Promise<void> {
  if (!/^[0-9a-f-]{36}$/.test(p.reportId) || !MODULE_VERSION.test(p.version) || !Number.isSafeInteger(p.revision) || p.revision < 1) {
    throw new StudioFailure('Укажите обращение и версию вида 1.2.3.');
  }
  await studioRequest(s.origin, 'transition', {
    token: s.token, params: { id: p.reportId },
    body: { to: 'VERIFY', resolvedVersion: p.version, reason: `Исправлено в версии ${p.version}`, clientRequestId: randomUUID(), expectedRevision: p.revision },
  });
}
