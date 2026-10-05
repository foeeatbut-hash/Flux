'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REDACTED = '[скрыто]';
const MAX_TEXT = 6000;
const SECRET_KEYS = /(?:password|passwd|passphrase|private(?:pem|key)?|secret|token|authorization|credential|authheader|vault|signature|\bsig\b|requestcode|licensecode|issuedcode)/i;
const MYSQL_URI = /\b(?:mysql|mariadb):\/\/[^\s"'<>]+/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const AUTH_HEADER = /((?:proxy-)?authorization\s*[:=]\s*)[^\s,;]+/gi;
const SQL_PASSWORD = /((?:identified\s+by|password)\s+)(?:'[^']*'|"[^"]*"|[^\s;,]+)/gi;
const KEY_BLOCK = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const NAMED_SECRET = /\b(password|passwd|passphrase|token|secret|api[_-]?key)\s*([=:])\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;

function createDiagnostics({ logDirectory, appVersion = 'unknown', platform = process.platform, release = require('node:os').release(), arch = process.arch, homeDirectory = require('node:os').homedir(), maxFileBytes = 512 * 1024, maxFiles = 3, now = Date.now, randomUUID = crypto.randomUUID } = {}) {
  if (!logDirectory) throw new TypeError('logDirectory is required');
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 256) throw new RangeError('maxFileBytes must be an integer of at least 256');
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new RangeError('maxFiles must be a positive integer');
  const sessionId = randomUUID();
  let sequence = 0;
  const active = new Map();
  const currentFile = path.join(logDirectory, 'diagnostics.jsonl');
  const safeString = value => {
    let text = String(value ?? '');
    text = text.replace(MYSQL_URI, '[скрытый адрес базы данных]')
      .replace(KEY_BLOCK, '[закрытый ключ скрыт]')
      .replace(BEARER, 'Bearer [скрыто]')
      .replace(AUTH_HEADER, `$1${REDACTED}`)
      .replace(SQL_PASSWORD, `$1${REDACTED}`)
      .replace(JWT, REDACTED)
      .replace(NAMED_SECRET, `$1$2${REDACTED}`);
    if (homeDirectory) text = text.split(homeDirectory).join('[папка пользователя]');
    return text.slice(0, MAX_TEXT);
  };
  const clean = (value, key = '', seen = new WeakSet(), depth = 0) => {
    if (SECRET_KEYS.test(key)) return REDACTED;
    if (depth > 8) return '[вложенность скрыта]';
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return safeString(value);
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'function') return '[функция]';
    if (typeof value !== 'object') return String(value);
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[содержимое не записано]';
    if (seen.has(value)) return '[цикл]';
    seen.add(value);
    if (value instanceof Error) {
      const result = { name: safeString(value.name || 'Error'), message: safeString(value.message || ''), stack: safeString(value.stack || '') };
      for (const field of ['code', 'errno', 'syscall', 'stage', 'cause']) if (value[field] !== undefined) result[field] = clean(value[field], field, seen, depth + 1);
      if (value.errors && Array.isArray(value.errors)) result.errors = value.errors.map(error => clean(error, 'error', seen, depth + 1));
      return result;
    }
    if (Array.isArray(value)) return value.slice(0, 100).map(item => clean(item, '', seen, depth + 1));
    const result = {};
    try {
      for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value)).slice(0, 100)) {
        if (!Object.hasOwn(descriptor, 'value')) { result[safeString(name)] = '[свойство скрыто]'; continue; }
        const item = descriptor.value;
        if (/^(?:contents?|body|buffer|bytes|data|sql|query)$/i.test(name)) { result[safeString(name)] = '[содержимое не записано]'; continue; }
        result[safeString(name)] = clean(item, name, seen, depth + 1);
      }
    } catch {
      return '[объект недоступен]';
    }
    return result;
  };
  const rotate = incomingBytes => {
    fs.mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
    let size = 0;
    try { size = fs.statSync(currentFile).size; } catch {}
    if (size + incomingBytes <= maxFileBytes) return;
    if (maxFiles === 1) { try { fs.rmSync(currentFile, { force: true }); } catch {} return; }
    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = i === 1 ? currentFile : `${currentFile}.${i - 1}`;
      const to = `${currentFile}.${i}`;
      try { if (i === maxFiles - 1) fs.rmSync(to, { force: true }); fs.renameSync(from, to); } catch {}
    }
  };
  const record = (event, details = {}, level = 'info') => {
    const safeDetails = clean(details);
    const entry = { ...(safeDetails && typeof safeDetails === 'object' && !Array.isArray(safeDetails) ? safeDetails : { details: safeDetails }), timestamp: new Date(now()).toISOString(), level, event: safeString(event), sessionId, sequence: ++sequence };
    let line = `${JSON.stringify(entry)}\n`;
    if (Buffer.byteLength(line) > maxFileBytes) {
      const compact = { timestamp: entry.timestamp, level, event: entry.event, sessionId, sequence: entry.sequence, diagnostic: 'record exceeded size limit and was truncated' };
      for (const key of ['operationId', 'operation', 'stage', 'elapsedMs', 'durationMs']) if (entry[key] !== undefined) compact[key] = entry[key];
      if (entry.error) compact.error = { name: safeString(entry.error.name || 'Error').slice(0, 80), message: safeString(entry.error.message || '').slice(0, 180), ...(entry.error.code ? { code: safeString(entry.error.code).slice(0, 80) } : {}) };
      line = `${JSON.stringify(compact)}\n`;
    }
    try { rotate(Buffer.byteLength(line)); fs.appendFileSync(currentFile, line, { mode: 0o600 }); } catch {}
    return entry;
  };
  const beginOperation = (name, details = {}) => {
    const operationId = randomUUID();
    const startedAt = now();
    const operation = { operationId, name: safeString(name), startedAt, stage: 'started' };
    active.set(operationId, operation);
    record('operation.start', { operationId, operation: operation.name, details });
    const stage = (stageName, metadata = {}) => {
      operation.stage = safeString(stageName);
      record('operation.stage', { operationId, operation: operation.name, stage: operation.stage, elapsedMs: Math.max(0, now() - startedAt), metadata });
    };
    const finish = (error = null, metadata = {}) => {
      if (!active.has(operationId)) return;
      active.delete(operationId);
      record(error ? 'operation.failure' : 'operation.complete', { operationId, operation: operation.name, stage: operation.stage, durationMs: Math.max(0, now() - startedAt), ...(error ? { error } : {}), metadata }, error ? 'error' : 'info');
    };
    return { id: operationId, stage, finish, fail: error => finish(error || new Error('Operation failed')) };
  };
  const diagnosticsContext = () => ({ appVersion, os: { platform, release, arch }, logFiles: maxFiles, maxFileBytes });
  const exportLogs = destination => {
    fs.mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
    const files = [];
    for (let i = maxFiles - 1; i >= 1; i--) { const file = `${currentFile}.${i}`; if (fs.existsSync(file)) files.push(file); }
    if (fs.existsSync(currentFile)) files.push(currentFile);
    const header = JSON.stringify({ exportedAt: new Date(now()).toISOString(), diagnostics: diagnosticsContext() });
    const safeLines = files.flatMap(file => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
      try { return JSON.stringify(clean(JSON.parse(line))); } catch { return JSON.stringify({ diagnostic: 'malformed log record omitted' }); }
    }));
    const content = `${header}\n${safeLines.join('\n')}\n`;
    const output = destination || path.join(logDirectory, `flux-owner-diagnostics-${new Date(now()).toISOString().replace(/[:.]/g, '-')}.jsonl`);
    fs.writeFileSync(output, content, { mode: 0o600 });
    return { filePath: output, bytes: Buffer.byteLength(content), entries: Math.max(0, content.split('\n').length - 2) };
  };
  const handlers = {
    uncaughtException: error => record('process.uncaughtException', { error }, 'error'),
    unhandledRejection: reason => { record('process.unhandledRejection', { error: reason instanceof Error ? reason : new Error(safeString(reason)) }, 'error'); throw reason instanceof Error ? reason : new Error(safeString(reason)); },
  };
  const installProcessHandlers = processObject => {
    // Monitor events observe the crash without consuming Node's fatal exception behavior.
    processObject.on('uncaughtExceptionMonitor', handlers.uncaughtException);
    processObject.on('unhandledRejection', handlers.unhandledRejection);
    return () => { processObject.removeListener('uncaughtExceptionMonitor', handlers.uncaughtException); processObject.removeListener('unhandledRejection', handlers.unhandledRejection); };
  };
  return { sessionId, record, beginOperation, exportLogs, diagnosticsContext, redact: clean, installProcessHandlers, currentFile };
}

module.exports = { createDiagnostics };
