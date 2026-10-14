import { mergeOfficeTranslationPackage, readOfficeTranslationPackage, type OfficeTranslationDelta } from '../../../office/translationPackage';
import { base64ToBytes } from '../../lib/windowsFiles';
import {
  createTranslationGate, type OfficeTranslationEditorLink, type OfficeTranslationGate, type OfficeTranslationState,
} from './useOfficeTranslation';

/**
 * Что нужно трём окнам Flux для переводчика и не зависит от React: разговор с
 * редактором по протоколу translation-bridge.ts, чтение журнала файла и
 * «слот» — одна подготовленная запись, которую подхватывает сохранение окна.
 */

/**
 * Каналы и таймауты протокола. Копия tools/genoffice/inject/translation-bridge.ts: тот файл едет в
 * редактор и вправе тянуть за собой его модули, окну Flux они не нужны. Совпадение сторожит
 * scripts/test-office-translation-hook.ts.
 */
export const TRANSLATION_CHANNELS = {
  docs: {
    read: { event: 'fluxTranslationRead', answer: 'flux:translation-read' },
    apply: { event: 'fluxTranslationApply', answer: 'flux:translation-applied' },
    rollback: { event: 'fluxTranslationRollback', answer: 'flux:translation-rolled-back' },
  },
  sheets: {
    read: { event: 'flux:translation-read-request', answer: 'flux:translation-read' },
    apply: { event: 'flux:translation-apply-request', answer: 'flux:translation-applied' },
    rollback: { event: 'flux:translation-rollback-request', answer: 'flux:translation-rolled-back' },
  },
} as const;
export const TRANSLATION_TIMEOUT = { read: 30_000, apply: 120_000, rollback: 15_000 } as const;

/** Документ: события окна (askFrame), ответ приходит сообщением с именем канала-ответа. */
export function docsTranslationEditor(ask: <T>(event: string, answer: string, ms: number, payload?: unknown) => Promise<T | null>): OfficeTranslationEditorLink {
  const c = TRANSLATION_CHANNELS.docs;
  return {
    read: (request) => ask(c.read.event, c.read.answer, TRANSLATION_TIMEOUT.read, request),
    apply: (request) => ask(c.apply.event, c.apply.answer, TRANSLATION_TIMEOUT.apply, request),
    rollback: (stepId) => ask(c.rollback.event, c.rollback.answer, TRANSLATION_TIMEOUT.rollback, { stepId }),
  };
}

/** Таблица: каналы ipc, у каждого запроса свой канал-ответ. */
export function sheetsTranslationEditor(call: (channel: string, payload: unknown, responseChannel: string, timeout?: number) => Promise<any>): OfficeTranslationEditorLink {
  const c = TRANSLATION_CHANNELS.sheets;
  return {
    read: (request) => call(c.read.event, request, c.read.answer, TRANSLATION_TIMEOUT.read),
    apply: (request) => call(c.apply.event, request, c.apply.answer, TRANSLATION_TIMEOUT.apply),
    rollback: (stepId) => call(c.rollback.event, { stepId }, c.rollback.answer, TRANSLATION_TIMEOUT.rollback),
  };
}

/** Что окно записывает вместе с ближайшим сохранением редактора. */
export interface ArmedTranslation {
  delta: OfficeTranslationDelta;
  /** Проект: токен подготовленной записи (X-Flux-Translation-Token / translationToken). Проводник: пусто. */
  token?: string;
  /** Запись идёт копией («Новая книга»): сохранение окна создаёт новый файл. */
  copy?: boolean;
}

/**
 * Слот и ворота окна. Ворота ждут обычное сохранение, пока идёт постановка;
 * сохранения, которые делает сам перевод (запись правок перед чтением, запись
 * с переводом), помечены `own` и ворота не ждут — иначе постановка дождалась бы себя.
 */
export interface TranslationSlot {
  gate: OfficeTranslationGate;
  /** Обычное сохранение зовёт перед записью. */
  beforeSave(): Promise<void>;
  own<T>(work: () => Promise<T>): Promise<T>;
  arm(item: ArmedTranslation): void;
  armed(): ArmedTranslation | null;
  /** Сохранение окна сообщает, чем закончилась запись с переводом. */
  settle(ok: boolean, error?: string): void;
  lastError(): string;
  disarm(): void;
}

export function createTranslationSlot(gate: OfficeTranslationGate = createTranslationGate()): TranslationSlot {
  let owned = 0;
  let item: ArmedTranslation | null = null;
  let error = '';
  return {
    gate,
    beforeSave: () => (owned > 0 ? Promise.resolve() : gate.wait()),
    own: async (work) => { owned++; try { return await work(); } finally { owned--; } },
    arm: (next) => { item = next; error = ''; },
    armed: () => item,
    settle: (ok, why) => { error = ok ? '' : why || 'Файл не записан.'; },
    lastError: () => error,
    disarm: () => { item = null; },
  };
}

const jsonHeaders = { 'Content-Type': 'application/json' };

/** Журнал переводов файла проекта: GET /api/office/files/:id/translations. */
export async function projectTranslationState(fileId: string): Promise<OfficeTranslationState> {
  const response = await fetch(`/api/office/files/${encodeURIComponent(fileId)}/translations`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(data?.error || `Журнал переводов не прочитан: сервер ответил ${response.status}`));
  return { baseHash: String(data.baseHash || ''), records: Array.isArray(data.translations) ? data.translations : [], displayLabels: data.displayLabels || {}, schema: data.headerSchema };
}

/** Подготовленная запись: сервер проверит пакет сейчас и выдаст одноразовый токен для сохранения. */
export async function stageProjectTranslation(fileId: string, baseHash: string, delta: OfficeTranslationDelta): Promise<string> {
  const response = await fetch(`/api/office/files/${encodeURIComponent(fileId)}/translations/stage`, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ baseHash, delta }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.token) throw new Error(String(data?.error || `Перевод не подготовлен: сервер ответил ${response.status}`));
  return String(data.token);
}

/** Журнал переводов файла Проводника: из байтов, которые хост только что записал или прочитал. */
export async function localTranslationState(content: { base64: string; sha256: string }): Promise<OfficeTranslationState> {
  const meta = await readOfficeTranslationPackage(base64ToBytes(content.base64), content.sha256);
  return { baseHash: meta.baseHash, records: meta.records, displayLabels: meta.displayLabels, schema: meta.headerSchema };
}

/** Журнал перевода уходит в метаданные копии: оригинал остаётся без него. */
export async function withJournal(bytes: ArrayBuffer | Uint8Array, records: OfficeTranslationDelta['records']): Promise<Uint8Array> {
  const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return records?.length ? mergeOfficeTranslationPackage(raw, { records }) : raw;
}

export const backupName = (name: string): string => name.replace(/(\.[^.]+)$/, ' (до перевода)$1');
