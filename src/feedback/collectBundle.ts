/**
 * Пакет диагностики к обращению — то, что окно может собрать само.
 *
 * До этого «подробный пакет» был хвостом одного окна на пятьсот записей.
 * Разбирающий видел, что нажимал человек, и не видел ничего о том, что при
 * этом делали оболочка, сервер и база, — то есть ровно того, где обычно и
 * лежит причина. Здесь собираются два источника, до которых окно дотягивается
 * своими силами; сервер и база добавляются на сервере, где они и живут.
 *
 * Главное в пакете — не строки, а опись. Она говорит, чего в пакете НЕТ и
 * почему: без этого сводка без ошибок читается как «ошибок не было», хотя на
 * самом деле их просто не записали.
 */

import {
  BUNDLE_SCHEMA_VERSION, SOURCE_BYTES, bundleStateOf,
  type BundleManifest, type SourceReport,
} from '../../feedback/bundleSpec';
import { freezeSnapshot, rendererSource, shellSource } from '../lib/diagnostics';

export interface CollectedBundle {
  /** Опись — отдельным файлом: её читают, не разбирая события. */
  manifest: BundleManifest;
  manifestBlob: Blob;
  /** События обоих источников одним JSONL. У каждого события есть `source`. */
  eventsBlob: Blob;
}

/** Имена частей. Один раз здесь — их ищет и сервер, и проверки. */
export const MANIFEST_NAME = 'опись.json';
export const EVENTS_NAME = 'диагностика.jsonl';

/**
 * Снять снимок вокруг происшествия.
 *
 * Зовётся при открытии формы, а не при отправке: пока человек пишет, что
 * сломалось, программа продолжает работать, и события про поломку вытеснялись
 * бы его же набором текста. С этой секунды они закреплены.
 */
export function startSnapshot(snapshotId: string, incidentAt?: number) {
  return freezeSnapshot(snapshotId, incidentAt);
}

/**
 * Собрать пакет.
 *
 * Ошибка сбора одного источника не отменяет отправку: обращение важнее
 * полноты пакета, а неполнота записывается в опись и видна разбирающему.
 */
export async function collectBundle(input: {
  snapshotId: string;
  from: number;
  to: number;
  session: string;
  timeOrigin: number;
  clientRequestId: string;
  deploymentId: string;
  appVersion: string;
  sectionKey?: string;
  crashId?: string;
}): Promise<CollectedBundle> {
  const sources: SourceReport[] = [];
  const parts: string[] = [];

  const own = rendererSource(input.snapshotId, SOURCE_BYTES);
  sources.push(own.report);
  if (own.text) parts.push(own.text);

  const shell = await shellSource(input.from, input.to);
  sources.push(shell.report);
  if (shell.text) parts.push(shell.text);

  const manifest: BundleManifest = {
    bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
    snapshotId: input.snapshotId,
    clientRequestId: input.clientRequestId,
    deploymentId: input.deploymentId,
    appVersion: input.appVersion,
    incidentSessionId: input.session,
    ...(input.crashId ? { crashId: input.crashId } : {}),
    ...(input.sectionKey ? { sectionKey: input.sectionKey } : {}),
    requestedFrom: new Date(input.from).toISOString(),
    requestedTo: new Date(input.to).toISOString(),
    timeOrigin: input.timeOrigin,
    sources,
    // Сервер и база сюда добавятся при сборке на сервере — там они и живут.
    // Пока их нет, состояние честно говорит «собирается»
    state: 'PENDING',
  };

  return {
    manifest,
    manifestBlob: new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }),
    eventsBlob: new Blob(parts, { type: 'application/x-ndjson' }),
  };
}

/** Полон ли пакет по тому, что собрало окно. Сервер пересчитает со своим. */
export const clientBundleState = (manifest: BundleManifest) => bundleStateOf(manifest.sources);
