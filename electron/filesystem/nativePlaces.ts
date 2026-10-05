import { execFile } from 'node:child_process';

export type NativeWindowsVolumeKind = 'fixed' | 'removable' | 'network' | 'optical' | 'ram';
export interface NativeWindowsVolume {
  id: string;
  path: string;
  name: string;
  kind: NativeWindowsVolumeKind;
  networkPath?: string;
  size: number | null;
  free: number | null;
}

type CimVolume = {
  path?: unknown;
  label?: unknown;
  driveType?: unknown;
  providerName?: unknown;
  size?: unknown;
  freeSpace?: unknown;
};

const VOLUME_SCRIPT = [
  "$ErrorActionPreference='Stop'; $rows = Get-CimInstance -ClassName Win32_LogicalDisk | Where-Object { $_.DriveType -in @(2,3,4,5,6) } | Select-Object @{Name='path';Expression={$_.DeviceID + '\\'}},@{Name='label';Expression={$_.VolumeName}},@{Name='driveType';Expression={$_.DriveType}},@{Name='providerName';Expression={$_.ProviderName}},@{Name='size';Expression={$_.Size}},@{Name='freeSpace';Expression={$_.FreeSpace}}",
  '$rows | ConvertTo-Json -Compress',
].join('; ');

const DRIVE_KINDS: Record<number, NativeWindowsVolumeKind> = {
  2: 'removable', 3: 'fixed', 4: 'network', 5: 'optical', 6: 'ram',
};

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+$/u.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/** CIM возвращает объект для одного диска и массив для нескольких. */
export function parseWindowsLogicalDisks(raw: string): NativeWindowsVolume[] {
  if (!raw.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const volumes: NativeWindowsVolume[] = [];
  const seen = new Set<string>();
  for (const value of rows) {
    if (!value || typeof value !== 'object') continue;
    const row = value as CimVolume;
    const path = typeof row.path === 'string' ? row.path.trim() : '';
    const driveType = finiteNumber(row.driveType);
    const kind = driveType === null ? undefined : DRIVE_KINDS[driveType];
    // Не принимаем путь из CIM как capability: допустимы лишь буквы томов.
    if (!/^[A-Z]:\\$/iu.test(path) || !kind) continue;
    const id = `native:${path.slice(0, 2).toLocaleLowerCase('en-US')}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const label = typeof row.label === 'string' ? row.label.trim() : '';
    const provider = typeof row.providerName === 'string' ? row.providerName.trim() : '';
    volumes.push({
      id, path, name: label ? `${label} (${path.slice(0, 2)})` : path.slice(0, 2), kind,
      ...(kind === 'network' && /^\\\\[^\\]+\\[^\\]+/u.test(provider) ? { networkPath: provider } : {}),
      size: finiteNumber(row.size), free: finiteNumber(row.freeSpace),
    });
  }
  return volumes.sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }));
}

/** Paths stay in Electron main; the renderer receives labels and capacity only. */
export async function enumerateWindowsVolumes(platform = process.platform): Promise<NativeWindowsVolume[]> {
  if (platform !== 'win32') return [];
  const raw = await new Promise<string>((resolve, reject) => {
    execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', VOLUME_SCRIPT], {
      windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
  return parseWindowsLogicalDisks(raw);
}

/** Открывает системную корзину Windows; черновики Flux остаются отдельной корзиной. */
export async function openWindowsRecycleBin(platform = process.platform): Promise<void> {
  if (platform !== 'win32') throw new Error('Системная корзина доступна только в Windows.');
  await new Promise<void>((resolve, reject) => {
    execFile('explorer.exe', ['shell:RecycleBinFolder'], { windowsHide: true, timeout: 10_000 }, error => error ? reject(error) : resolve());
  });
}
