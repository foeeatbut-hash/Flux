/**
 * Пакет и запрос на публикацию: что Studio отправляет владельцу.
 *
 * Пакет — все файлы проекта плюс `build/runtime.js`, собранный из них (studio/shared/runtime.ts),
 * чтобы владелец проверял исходники, из которых получен именно этот runtime. Запрос подписан
 * ключом разработчика (keyring.ts); сервер сверяет подпись с сертификатом владельца.
 * Подписанный запрос не меняется: правка — новый запрос с `parentRequest`.
 */
import { packBundle } from '../../modules/trust/bundle';
import { describeBundle } from '../../modules/trust/verify';
import { MODULE_BUNDLE_MAX, parseRequestClaim, type ModuleChannel, type RequestClaim } from '../../modules/trust/claims';
import { CONTRACT_VERSION } from '../../modules/contract';
import type { DeveloperKeyring } from './keyring';
import { reportForRequest, type CheckReport } from './checks';
import type { ProjectFiles } from './templates';

export interface PublishInput {
  moduleId: string; version: string;
  files: ProjectFiles; runtime: string;
  baseRelease: string | null; parentRequest: string | null;
  channel: ModuleChannel; changelog: string; comment: string;
  report: CheckReport; studioVersion: string;
}

export class PublishRefused extends Error {}

/** Пакет запроса: файлы проекта и собранный runtime; `build/` из проекта не берётся — его собирает только Studio */
export function buildPackage(files: ProjectFiles, runtime: string): Uint8Array {
  const entries: Record<string, Uint8Array | string> = {};
  for (const [name, bytes] of Object.entries(files)) if (!name.startsWith('build/')) entries[name] = bytes;
  // У страницы (договор v2) runtime.js нет: пакет — это ui/ как есть, и проверка выпуска требует его отсутствия
  if (runtime) entries['build/runtime.js'] = runtime;
  const bundle = packBundle(entries);
  if (bundle.length > MODULE_BUNDLE_MAX) throw new PublishRefused('Пакет программы больше 32 МиБ.');
  return bundle;
}

export function buildRequest(keyring: DeveloperKeyring, input: PublishInput): { signature: string; bundle: Uint8Array; claim: RequestClaim } {
  // Отчёт — условие отправки: «не прошло» здесь не обходится ни окном, ни повтором
  if (!input.report.ok) throw new PublishRefused('Проверка перед отправкой не пройдена: отправка недоступна.');
  if (!input.changelog.trim()) throw new PublishRefused('Заполните «что нового».');
  const info = keyring.info();
  if (!info.exists) throw new PublishRefused('Сначала создайте ключ разработчика.');
  const bundle = buildPackage(input.files, input.runtime);
  // Версия договора в запросе обязана совпасть с manifest.json: форма — v1, страница — v2
  let contractVersion: number = CONTRACT_VERSION;
  try { contractVersion = JSON.parse(Buffer.from(input.files['manifest.json']).toString('utf8')).contractVersion; } catch { /* manifest проверит сервер */ }
  const claim = parseRequestClaim({
    v: 1, moduleId: input.moduleId, version: input.version, baseRelease: input.baseRelease, parentRequest: input.parentRequest,
    author: info.publicKey, iat: Date.now(),
    meta: {
      changelog: input.changelog.trim().slice(0, 4000), comment: input.comment.trim().slice(0, 4000), channel: input.channel,
      checks: reportForRequest(input.report), fluxVersion: input.studioVersion.slice(0, 40), contractVersion,
    },
    ...describeBundle(bundle),
  });
  if (!claim) throw new PublishRefused('Описание запроса не прошло проверку: проверьте версию и идентификатор.');
  return { signature: keyring.sign('request', claim), bundle, claim };
}
