/**
 * Единственный разговор окна с сервером обращений.
 *
 * Один клиент на домен, а не запросы вразброс по компонентам: иначе конверт
 * ответа разбирают в пяти местах по-разному, и однажды где-то забывают
 * проверить код отказа. Здесь разбор один, и наружу выходит либо значение,
 * либо ошибка с кодом, по которому очередь отправки решает — повторять или
 * показать человеку.
 */

import { ENV_CONFIG } from '../config/env';
import { sha256 } from '../../feedback/sha256';
import type { SubmitFeedbackV1 } from '../../feedback/contracts';

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly details?: unknown) {
    super(message);
  }
  /** Стоит ли повторять само собой: сеть и временная недоступность — да. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 503 || this.status >= 500;
  }
  /** Нужен человек: поправить текст, разобраться с вложением, войти заново. */
  get needsPerson(): boolean {
    return this.status === 400 || this.status === 403 || this.status === 409
      || this.status === 413 || this.status === 415 || this.status === 429;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${ENV_CONFIG.apiUrl}/feedback${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error: any) {
    // Сети нет — это не отказ сервера, и повторять такое можно молча
    throw new ApiError('OFFLINE', 'Нет связи с сервером', 0);
  }
  const text = await res.text();
  let parsed: any = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch (_) { parsed = {}; }
  if (!res.ok) {
    const error = parsed?.error || {};
    throw new ApiError(String(error.code || 'UNKNOWN'), String(error.message || `Ошибка ${res.status}`), res.status, error.details);
  }
  return parsed?.data as T;
}

export interface Meta {
  deploymentId: string;
  chunkSize: number;
  rights: { create: boolean; triage: boolean; diagnostics: boolean; manage: boolean };
  limits: Record<string, any>;
  dictionary: Record<string, any>;
}

export const getMeta = () => call<Meta>('GET', '/meta');
export const getUnread = () => call<{ mine: number; queue: number; total: number }>('GET', '/unread');

export const listReports = (query = '') => call<any[]>('GET', `/reports${query ? `?${query}` : ''}`);
export const getReport = (id: string) => call<any>('GET', `/reports/${id}`);
export const getComments = (id: string) => call<any[]>('GET', `/reports/${id}/comments`);
export const getEvents = (id: string) => call<any[]>('GET', `/reports/${id}/events`);
export const getActions = (id: string) => call<any[]>('GET', `/reports/${id}/actions`);
export const findByRequest = (clientRequestId: string) => call<any>('GET', `/reports/by-request/${clientRequestId}`);

export const submitReport = (body: SubmitFeedbackV1) => call<any>('POST', '/reports', body);

export const getSummary = (days = 30) => call<any>('GET', `/summary?days=${days}`);
export const getDuplicates = (id: string) => call<any[]>('GET', `/reports/${id}/duplicates`);
export const exportReport = (id: string) => call<{ markdown: string }>('GET', `/reports/${id}/export`);

export const addComment = (id: string, body: Record<string, unknown>) =>
  call<any>('POST', `/reports/${id}/comments`, body);
export const transition = (id: string, body: Record<string, unknown>) =>
  call<any>('POST', `/reports/${id}/transition`, body);
export const assign = (id: string, body: Record<string, unknown>) =>
  call<any>('POST', `/reports/${id}/assign`, body);
export const setPriority = (id: string, body: Record<string, unknown>) =>
  call<any>('POST', `/reports/${id}/priority`, body);
export const markRead = (id: string, body: Record<string, unknown>) =>
  call<any>('POST', `/reports/${id}/read`, body);

/** Кому можно поручить разбор. Только разбирающим — сервер и так откажет. */
export const listAssignees = () => call<Array<{ id: string; name: string }>>('GET', '/assignees');

/**
 * Забрать вложение.
 *
 * Не ссылкой, а запросом: заголовок сессии подставляет обёртка `fetch`, а
 * простой переход по ссылке её минует и получит отказ. Возвращается Blob —
 * дальше вызывающий решает, показать его или сохранить.
 */
export async function fetchAttachment(id: string): Promise<Blob> {
  const res = await fetch(`${ENV_CONFIG.apiUrl}/feedback/attachments/${id}`);
  if (!res.ok) {
    throw new ApiError('UNKNOWN', res.status === 404 ? 'Вложение не найдено' : `Не удалось открыть (${res.status})`, res.status);
  }
  return res.blob();
}

/** Показать или сохранить вложение — по тому, что это за файл. */
export async function openAttachment(id: string, name: string, inline: boolean): Promise<void> {
  const blob = await fetchAttachment(id);
  const url = URL.createObjectURL(blob);
  if (inline) {
    window.open(url, '_blank', 'noopener');
  } else {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name || 'вложение';
    anchor.click();
  }
  // Ссылку освобождаем не сразу: окно и сохранение читают её уже после вызова
  setTimeout(() => URL.revokeObjectURL(url), 20000);
}

// ── Вложения ────────────────────────────────────────────────────────────────

export interface UploadHandle {
  uploadId: string;
  chunkSize: number;
  chunkCount: number;
  status: string;
}

export const startUpload = (body: Record<string, unknown>) => call<UploadHandle>('POST', '/uploads', body);
export const uploadState = (id: string) =>
  call<{ status: string; received: Array<{ index: number; sha256: string }> }>('GET', `/uploads/${id}`);
export const finishUpload = (id: string) => call<any>('POST', `/uploads/${id}/complete`, {});
export const cancelUpload = (id: string) => call<any>('DELETE', `/uploads/${id}`);

/**
 * Отправить файл кусками.
 *
 * Уже доехавшие куски не шлются заново: после обрыва связи спрашиваем сервер,
 * что у него есть, и досылаем недостающее. Ход показывается по подтверждённым
 * байтам, а не по одному разу на файл, — иначе на сорока мегабайтах человек
 * полминуты смотрит на неподвижную полоску и решает, что программа зависла.
 */
export async function sendFile(
  file: Blob,
  name: string,
  kind: 'IMAGE' | 'FILE' | 'DIAGNOSTICS',
  clientRequestId: string,
  draftId: string,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const whole = await sha256(bytes);
  const handle = await startUpload({
    clientRequestId, draftId, kind, name, size: bytes.length, sha256: whole,
  });
  if (handle.status === 'READY' || handle.status === 'ATTACHED') return handle.uploadId;

  const already = new Set<number>();
  try {
    const state = await uploadState(handle.uploadId);
    for (const part of state.received || []) already.add(part.index);
  } catch (_) { /* не спросилось — пошлём всё */ }

  let done = already.size * handle.chunkSize;
  for (let index = 0; index < handle.chunkCount; index++) {
    if (signal?.aborted) throw new ApiError('CANCELLED', 'Отправка отменена', 0);
    if (already.has(index)) continue;
    const from = index * handle.chunkSize;
    const piece = bytes.slice(from, Math.min(from + handle.chunkSize, bytes.length));
    const pieceHash = await sha256(piece);
    let res: Response;
    try {
      res = await fetch(`${ENV_CONFIG.apiUrl}/feedback/uploads/${handle.uploadId}/chunks/${index}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-SHA256': pieceHash },
        body: piece as any,
        signal,
      });
    } catch (_) {
      throw new ApiError('OFFLINE', 'Связь оборвалась при отправке файла', 0);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let parsed: any = {};
      try { parsed = text ? JSON.parse(text) : {}; } catch (__) { /* тела нет */ }
      throw new ApiError(String(parsed?.error?.code || 'UNKNOWN'),
        String(parsed?.error?.message || `Кусок не принят (${res.status})`), res.status);
    }
    done += piece.length;
    onProgress?.(Math.min(done, bytes.length), bytes.length);
  }
  await finishUpload(handle.uploadId);
  onProgress?.(bytes.length, bytes.length);
  return handle.uploadId;
}
