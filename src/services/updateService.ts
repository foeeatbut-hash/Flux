import { getServerBaseUrl } from '../config/env';

export const updateService = {
  async request<T>(route: string, body?: unknown): Promise<T> {
    const res = await fetch(`${getServerBaseUrl()}/api/updates/${route}`, {
      signal: AbortSignal.timeout(15000),
      ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Не удалось получить сведения об обновлении.');
    return data;
  },
};
