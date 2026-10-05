import { getServerBaseUrl } from '../config/env';

export interface UpdateDevice {
  deviceId: string; userId: string; name: string; symbol: string; isActive: boolean;
  version: string; platform: string; arch: string; lastSeen: number; offline: boolean;
  status: string; code: string; commandId: string | null; action: string | null;
  deadline: number | null; targetVersion: string | null;
  commandRelease?: { version: string; generation: string; sha256: string; releaseSignature: string } | null;
}
export interface CampaignRelease { version: string; generation: string; signature: string; sha256: string }
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
  devices: () => updateService.request<{ inst: string; devices: UpdateDevice[]; releases: CampaignRelease[] }>('devices'),
  delegation: () => updateService.request<{ inst: string; userId: string; code: string }>('delegation'),
};
