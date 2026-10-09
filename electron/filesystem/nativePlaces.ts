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
  /** Метка тома как её показывает Проводник; у тома без метки — название по типу диска. */
  label: string;
  letter: string;
  used: number | null;
  fileSystem?: string;
}

type CimVolume = {
  path?: unknown;
  label?: unknown;
  driveType?: unknown;
  providerName?: unknown;
  size?: unknown;
  freeSpace?: unknown;
  fileSystem?: unknown;
};

export const VOLUME_SCRIPT = [
  // PowerShell 5.1 использует системную OEM-кодировку при записи в pipe;
  // без этого русские метки томов повреждаются при декодировании Node как UTF-8.
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  "$ErrorActionPreference='Stop'; $rows = Get-CimInstance -ClassName Win32_LogicalDisk | Where-Object { $_.DriveType -in @(2,3,4,5,6) } | Select-Object @{Name='path';Expression={$_.DeviceID + '\\'}},@{Name='label';Expression={$_.VolumeName}},@{Name='driveType';Expression={$_.DriveType}},@{Name='providerName';Expression={$_.ProviderName}},@{Name='size';Expression={$_.Size}},@{Name='freeSpace';Expression={$_.FreeSpace}},@{Name='fileSystem';Expression={$_.FileSystem}}",
  '$rows | ConvertTo-Json -Compress',
].join('; ');

const DRIVE_KINDS: Record<number, NativeWindowsVolumeKind> = {
  2: 'removable', 3: 'fixed', 4: 'network', 5: 'optical', 6: 'ram',
};

// Названия, которые Проводник Windows на русском показывает у тома без метки.
const DEFAULT_LABELS: Record<NativeWindowsVolumeKind, string> = {
  fixed: 'Локальный диск', removable: 'Съёмный диск', network: 'Сетевой диск', optical: 'CD-дисковод', ram: 'RAM-диск',
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
    const given = typeof row.label === 'string' ? row.label.trim() : '';
    const provider = typeof row.providerName === 'string' ? row.providerName.trim() : '';
    const share = kind === 'network' ? /^\\\\([^\\]+)\\([^\\]+)/u.exec(provider) : null;
    // Сетевой диск без метки Windows подписывает общей папкой: «projects (\\server)».
    const label = given || (share ? `${share[2]} (\\\\${share[1]})` : DEFAULT_LABELS[kind]);
    const letter = path.slice(0, 2).toLocaleUpperCase('en-US');
    const size = finiteNumber(row.size), free = finiteNumber(row.freeSpace);
    const fileSystem = typeof row.fileSystem === 'string' && /^[A-Za-z0-9 ._-]{1,16}$/u.test(row.fileSystem.trim()) ? row.fileSystem.trim() : '';
    volumes.push({
      id, path, label, letter, name: `${label} (${letter})`, kind,
      ...(share ? { networkPath: provider } : {}),
      size, free, used: size !== null && free !== null && free <= size ? size - free : null,
      ...(fileSystem ? { fileSystem } : {}),
    });
  }
  return volumes.sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }));
}

/** Paths stay in Electron main; the renderer receives labels and capacity only. */
export async function enumerateWindowsVolumes(platform = process.platform): Promise<NativeWindowsVolume[]> {
  if (platform !== 'win32') return [];
  const raw = await new Promise<string>((resolve, reject) => {
    execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', VOLUME_SCRIPT], {
      windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024, encoding: 'utf8',
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
