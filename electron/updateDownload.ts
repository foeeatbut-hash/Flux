/** Main-process transport: only pinned, signed database releases become launchable files. */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sameServer, badPackage, downloadError } from './updates';
import { readUpdateSignature, sha256File, updateRefusal } from './updateSignature';

export interface VerifiedDownload {
  version: string; signature: string; current: string; server: string; token?: string; keyHex?: string;
  onProgress?: (percent: number) => void;
}
function updateUrl(url: string, p: VerifiedDownload): URL {
  const u = new URL(url);
  if (!sameServer(url, p.server) || !['http:', 'https:'].includes(u.protocol) || u.username || u.password
    || u.pathname !== `/api/updates/download/${p.version}` || u.search || u.hash) throw new Error('Обновление скачивается только с выбранного сервера Flux');
  return u;
}
function get(url: URL, token = ''): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).get(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} }, resolve);
    req.once('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('Сервер обновлений не отвечает')));
  });
}
export async function downloadVerifiedUpdate(url: string, dest: string, p: VerifiedDownload): Promise<void> {
  const u = updateUrl(url, p), signed = readUpdateSignature(p.signature, p.keyHex);
  if (!signed) throw new Error('Подпись выпуска не подтверждена');
  const before = updateRefusal({ ...p, size: signed.size, sha256: signed.sha256 });
  if (before) throw new Error(before);
  const part = `${dest}.part-${crypto.randomUUID()}`;
  let response: http.IncomingMessage | undefined;
  try {
    response = await get(u, p.token);
    if (response.statusCode !== 200) { response.destroy(); throw new Error(downloadError(response.statusCode || 0, '', u.origin)); }
    const length = response.headers['content-length'];
    if (length !== undefined && Number(length) !== signed.size) throw new Error('Размер ответа сервера не совпадает с подписью');
    let size = 0; const head: number[] = [];
    const verify = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      for (let i = 0; head.length < 2 && i < chunk.length; i++) head.push(chunk[i]);
      if (size > signed.size) return callback(new Error('Сервер передал больше байт, чем подписано'));
      p.onProgress?.(Math.round(size * 100 / signed.size)); callback(null, chunk);
    } });
    await pipeline(response, verify, fs.createWriteStream(part, { flags: 'wx', mode: 0o600 }));
    const bad = badPackage(head, size); if (bad) throw new Error(bad);
    const refusal = updateRefusal({ ...p, size, sha256: await sha256File(part) });
    if (refusal) throw new Error(refusal);
    fs.renameSync(part, dest);
  } catch (e) { response?.destroy(); try { fs.unlinkSync(part); } catch (_) {} throw e; }
}
/** Called immediately before launch; stale UI signatures cannot bypass server withdrawal. */
export async function assertUpdatePublished(p: VerifiedDownload): Promise<void> {
  const url = updateUrl(`${p.server.replace(/\/+$/, '')}/api/updates/download/${p.version}`, p);
  url.pathname = `/api/updates/check/${p.version}`;
  const response = await get(url, p.token);
  if (response.statusCode !== 200) { response.destroy(); throw new Error('Не удалось подтвердить опубликованный выпуск'); }
  let text = '';
  for await (const chunk of response) {
    text += chunk.toString('utf8');
    if (text.length > 8192) { response.destroy(); throw new Error('Некорректный ответ проверки обновления'); }
  }
  let result: any; try { result = JSON.parse(text); } catch (_) { throw new Error('Некорректный ответ проверки обновления'); }
  if (result?.ok !== true || result.version !== p.version || result.signature !== p.signature) throw new Error('Выпуск отозван или изменён: скачайте действующее обновление');
}
