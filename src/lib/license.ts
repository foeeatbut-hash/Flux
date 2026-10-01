import { ENV_CONFIG } from '../config/env';
import { create } from 'zustand';

export interface LicenseStatus {
  licensed: boolean;
  installationId: string;
  expiresAt: number | null;
  daysLeft: number | null;
  warn: boolean;
  readOnly: boolean;
  canActivate: boolean;
  reason: '' | 'none' | 'invalid' | 'wrong_machine' | 'expired' | 'other_install' | 'revoked';
  error?: string;
  testMode?: boolean;
}

export const usePersonLicenseStore = create<{ status: LicenseStatus | null; setStatus: (s: LicenseStatus | null) => void }>(set => ({ status: null, setStatus: status => set({ status }) }));

export async function licenseRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${ENV_CONFIG.apiUrl}/license/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.error || `Сервер ответил ${response.status}`);
  return data;
}

/** Решение принимает сервер компании по вошедшему сотруднику, включая отдельные окна. */
export async function fetchLicenseStatus(): Promise<LicenseStatus> {
  return licenseRequest<LicenseStatus>('me');
}
export async function activateLicense(code: string): Promise<LicenseStatus> {
  const status = await licenseRequest<LicenseStatus>('activate-key', { code });
  usePersonLicenseStore.getState().setStatus(status);
  window.dispatchEvent(new Event('flux:license-changed'));
  return status;
}
