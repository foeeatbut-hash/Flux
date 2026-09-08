import { ENV_CONFIG } from '../config/env';

/**
 * Обращения к серверу из раздела «Почта».
 *
 * Намеренно мимо общего dataService: тот при сбое сети подставляет заглушечные
 * данные из локального набора — для справочников это удобно, а для почты
 * недопустимо. Показать выдуманное письмо хуже, чем показать ошибку.
 *
 * Токен доступа навешивается общей обёрткой над fetch (src/config/env.ts),
 * поэтому здесь его нет.
 */

export interface MailAccount {
  id: string;
  /** PERSONAL — личный ящик сотрудника; SHARED — общая почта компании */
  scope: 'PERSONAL' | 'SHARED';
  label: string;
  /** Можно ли править настройки: общий ящик правит не всякий, кто его видит */
  canEdit: boolean;
  email: string;
  displayName: string;
  imapHost: string; imapPort: number; imapSecure: boolean;
  smtpHost: string; smtpPort: number; smtpSecure: boolean;
  login: string;
  syncDays: number;
  active: boolean;
  hasSecret: boolean;
  lastSyncAt: string | null;
  lastError: string;
  syncing?: boolean;
}

export interface MailFolder {
  id: string;
  accountId: string;
  path: string;
  name: string;
  kind: string;
  unread: number;
  total: number;
  syncedAt: string | null;
}

/** Состояние переписки в общем ящике: кто взял в работу и кто ответил. */
export interface MailThreadState {
  status: 'NEW' | 'IN_PROGRESS' | 'ANSWERED' | 'CLOSED';
  claimedById: string; claimedByName: string; claimedAt: string | null;
  repliedById: string; repliedByName: string; repliedAt: string | null;
}

export interface MailActivity {
  id: string;
  threadKey: string;
  userId: string; userName: string;
  kind: 'CLAIMED' | 'RELEASED' | 'REPLIED' | 'FORWARDED' | 'STATUS' | 'NOTE';
  note: string;
  createdAt: string;
}

/**
 * Найденное в письме. У каждой находки указан проект-владелец: почта общая,
 * и в письме подрядчика вполне может стоять тег того объекта, на котором вы
 * сейчас не работаете.
 */
export interface MailMention {
  id: string;
  projectId: string | null;
  projectName: string;
}
export interface MailMentions {
  tags: Array<MailMention & { identifier: string }>;
  files: Array<MailMention & { name: string; folderId: string | null }>;
  docs: Array<MailMention & { name: string; kind?: string }>;
}

export interface MailSignature {
  id: string;
  accountId: string;
  name: string;
  html: string;
  isDefault: boolean;
}

export interface MailSignatureImage {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  width: number;
  url: string;
}

export interface MailThread {
  threadKey: string;
  count: number;
  unread: boolean;
  flagged: boolean;
  hasFiles: boolean;
  answered: boolean;
  subject: string;
  snippet: string;
  sentAt: string;
  from: Array<{ name: string; addr: string }>;
  lastId: string;
  ids: string[];
  keys?: string[];
  state?: MailThreadState | null;
}

export interface MailMessage {
  id: string;
  folderId: string;
  uid: number;
  messageId: string;
  fromName: string; fromAddr: string;
  toAddrs: string; ccAddrs: string;
  subject: string; snippet: string;
  sentAt: string;
  size: number;
  seen: boolean; flagged: boolean; answered: boolean; hasFiles: boolean;
  bodyAt: string | null;
}

export interface MailAttachment {
  id: string;
  messageId: string;
  fileName: string;
  size: number;
  mimeType: string;
  contentId: string;
  inline: boolean;
}

export interface MailPreset {
  domain: string;
  title: string;
  imapHost: string; imapPort: number;
  smtpHost: string; smtpPort: number;
  hint: string;
  help: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ENV_CONFIG.apiUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({} as any));
    throw new Error(body?.error || `Сервер ответил ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const qs = (params: Record<string, string | number | boolean | undefined>) => {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '' || v === false) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v === true ? 1 : v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
};

export const mailService = {
  /** Настройки серверов по адресу почты — чтобы человек их не искал. */
  preset: (email: string) =>
    call<{ preset: MailPreset | null; known?: boolean }>(`/mail/preset${qs({ email })}`),

  accounts: () => call<{ accounts: MailAccount[]; keyIn: 'system' | 'file'; mayShared: boolean }>('/mail/accounts'),

  addAccount: (data: Record<string, unknown>) =>
    call<{ account: MailAccount }>('/mail/accounts', { method: 'POST', body: JSON.stringify(data) }),

  updateAccount: (id: string, data: Record<string, unknown>) =>
    call<{ account: MailAccount }>(`/mail/accounts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  removeAccount: (id: string) =>
    call<{ ok: boolean }>(`/mail/accounts/${id}`, { method: 'DELETE' }),

  /**
   * Подобрать сервер по адресу: перебирает привычные имена и проверяет, какое
   * из них отвечает. Нужно там, где подсказка по домену не подошла — то есть
   * почти на всякой почте предприятия
   */
  discover: (email: string) =>
    call<{
      imap: { host: string; port: number; secure: boolean } | null;
      smtp: { host: string; port: number; secure: boolean } | null;
      why: string;
    }>(`/mail/discover${qs({ email })}`),

  verify: (id: string) =>
    call<{
      imap: { ok: boolean; error: string; folders: number };
      smtp?: { ok: boolean; error: string };
    }>(`/mail/accounts/${id}/verify`, { method: 'POST' }),

  sync: (id: string, opts: { deep?: boolean; folderId?: string } = {}) =>
    call<{ report: { folders: number; added: number; updated: number; resynced: string[]; error: string } }>(
      `/mail/accounts/${id}/sync`, { method: 'POST', body: JSON.stringify(opts) },
    ),

  folders: (accountId: string) =>
    call<{ folders: MailFolder[]; shared: boolean }>(`/mail/folders${qs({ accountId })}`),

  threads: (p: { accountId: string; folderId?: string; q?: string; unread?: boolean; flagged?: boolean; limit?: number; skip?: number }) =>
    call<{ threads: MailThread[]; total: number; shared: boolean }>(`/mail/threads${qs(p as any)}`),

  thread: (accountId: string, threadKey: string) =>
    call<{
      messages: MailMessage[]; attachments: MailAttachment[];
      shared: boolean; state: MailThreadState | null; activity: MailActivity[];
    }>(`/mail/thread${qs({ accountId, threadKey })}`),

  body: (messageId: string) =>
    call<{ text: string; html: string; error: string; attachments: MailAttachment[] }>(`/mail/messages/${messageId}/body`),

  /** Что из письма уже есть в программе: теги, файлы, книги Конструктора. */
  mentions: (messageId: string) =>
    call<MailMentions>(`/mail/messages/${messageId}/mentions`),

  flag: (ids: string[], flag: 'seen' | 'flagged', on: boolean) =>
    call<{ ok: boolean; changed: number }>('/mail/flag', { method: 'POST', body: JSON.stringify({ ids, flag, on }) }),

  move: (ids: string[], to: 'TRASH' | 'ARCHIVE' | 'INBOX') =>
    call<{ ok: boolean }>('/mail/move', { method: 'POST', body: JSON.stringify({ ids, to }) }),

  /** Ссылка на вложение — по ней же браузер его и скачивает. */
  attachmentUrl: (id: string) => `${ENV_CONFIG.apiUrl}/mail/attachments/${id}`,

  // ── Общий ящик ────────────────────────────────────────────────────────────
  claim: (accountId: string, threadKey: string, on: boolean) =>
    call<{ state: MailThreadState }>('/mail/shared/claim', {
      method: 'POST', body: JSON.stringify({ accountId, threadKey, on }),
    }),

  setStatus: (accountId: string, threadKey: string, status: MailThreadState['status']) =>
    call<{ state: MailThreadState }>('/mail/shared/status', {
      method: 'POST', body: JSON.stringify({ accountId, threadKey, status }),
    }),

  addNote: (accountId: string, threadKey: string, note: string) =>
    call<{ activity: MailActivity[] }>('/mail/shared/note', {
      method: 'POST', body: JSON.stringify({ accountId, threadKey, note }),
    }),

  sharedSummary: (accountId: string) =>
    call<{ summary: { mine: number; busy: number; answered: number; total: number } | null }>(
      `/mail/shared/summary${qs({ accountId })}`),

  // ── Подписи ───────────────────────────────────────────────────────────────
  signatures: () =>
    call<{ signatures: MailSignature[]; images: MailSignatureImage[] }>('/mail/signatures'),

  addSignature: (data: Record<string, unknown>) =>
    call<{ signature: MailSignature }>('/mail/signatures', { method: 'POST', body: JSON.stringify(data) }),

  updateSignature: (id: string, data: Record<string, unknown>) =>
    call<{ signature: MailSignature }>(`/mail/signatures/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  removeSignature: (id: string) =>
    call<{ ok: boolean }>(`/mail/signatures/${id}`, { method: 'DELETE' }),

  addSignatureImage: (data: { fileName: string; mimeType: string; data: string; width?: number }) =>
    call<{ image: MailSignatureImage }>('/mail/signatures/image', { method: 'POST', body: JSON.stringify(data) }),

  removeSignatureImage: (id: string) =>
    call<{ ok: boolean }>(`/mail/signatures/image/${id}`, { method: 'DELETE' }),

  // ── Сцепка с программой ───────────────────────────────────────────────────
  linkFolders: (projectId: string) =>
    call<{ folders: Array<{ id: string; name: string; scope: string; parentId: string | null }> }>(
      `/mail/link/folders${qs({ projectId })}`),

  toExplorer: (attachmentId: string, folderId: string) =>
    call<{ file: { id: string; name: string; folderId: string | null } }>(
      `/mail/attachments/${attachmentId}/to-explorer`, { method: 'POST', body: JSON.stringify({ folderId }) }),

  toNote: (messageId: string, data: { groupName?: string; equipmentId?: string } = {}) =>
    call<{ note: { id: string; title: string } }>(
      `/mail/messages/${messageId}/to-note`, { method: 'POST', body: JSON.stringify(data) }),

  // ── Письмо ────────────────────────────────────────────────────────────────
  prepare: (p: { accountId: string; mode: string; messageId?: string }) =>
    call<{
      draft: { to: string; cc: string; subject: string; quote: string; mode: string; inReplyToId?: string };
      signature: MailSignature | null;
    }>(`/mail/compose/prepare${qs(p as any)}`),

  send: (data: Record<string, unknown>) =>
    call<{ ok: boolean; messageId: string; appended: boolean; warning: string }>(
      '/mail/send', { method: 'POST', body: JSON.stringify(data) }),
};
