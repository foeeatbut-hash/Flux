import { ENV_CONFIG } from '../config/env';

/** Вложение открывается через API, чтобы сработали штатные credentials сессии. */
export async function loadCatalogAsset(assetId: string): Promise<string> {
  const response = await fetch(`${ENV_CONFIG.apiUrl}/catalog/assets/${encodeURIComponent(assetId)}`);
  if (!response.ok) throw new Error('Не удалось открыть документ');
  return URL.createObjectURL(await response.blob());
}

/** Поблочная загрузка с проверяемым SHA-256. Большой PDF не проходит одним JSON запросом. */
export async function uploadCatalogAsset(file: File, family: { id: string; classId: string; manufacturerId: string }, onProgress?: (fraction: number) => void): Promise<string> {
  if (!file.size || file.size > 32 * 1024 * 1024) throw new Error('Размер исходника должен быть от 1 байта до 32 МБ');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  const call = async (method: string, path: string, body: unknown) => {
    const res = await fetch(`${ENV_CONFIG.apiUrl}/catalog/assets/${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Исходник не загружен'); return data;
  };
  const begin = await call('POST', 'begin', { filename: file.name, size: file.size, sha256, familyId: family.id, scope: family });
  if (begin.complete) { onProgress?.(1); return begin.id; }
  for (let index = 0; index < begin.chunks; index++) {
    const part = bytes.subarray(index * begin.chunkBytes, (index + 1) * begin.chunkBytes);
    let binary = ''; for (const b of part) binary += String.fromCharCode(b);
    await call('PUT', `${begin.id}/chunks/${index}`, { data: btoa(binary) }); onProgress?.((index + 1) / begin.chunks);
  }
  await call('POST', `${begin.id}/finish`, {}); return begin.id;
}
