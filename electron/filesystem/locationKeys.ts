import { createHash } from 'node:crypto';
import type { PortableFolderLocator, WindowsFileRef } from '../../filesystem/contracts';
import { WindowsFilesError, relativeSegments } from './paths';

/**
 * «Ключ места» папки для общих привязок к проекту.
 *
 * Буква диска и rootId у каждого компьютера свои (Z: на одном, P: на другом),
 * а сетевой путь `\\сервер\ресурс\папка` один. Ключ — sha256 от этого пути,
 * приведённого к единому виду (регистр, разделители, концевые слэши). Сам путь
 * из main не выходит: странице уходят только хеши (контракт filesystem/contracts.ts).
 *
 * Локальные папки ключа не получают: привязка, которая работает лишь на одном
 * компьютере, выглядела бы общей и вводила бы в заблуждение. Они отвечают null.
 *
 * Ключи считаются строками, без обращений к диску: открытие корня с сотнями
 * папок не порождает сотен stat по SMB. Единственный внешний вызов — перевод
 * буквы сетевого диска в UNC, он один на букву и кэшируется.
 */
const SALT = 'flux-location-v1\0';
export const MAX_LOCATION_REFS = 500;
const DRIVE_TTL_MS = 60_000;

/** Хеш нормализованного пути. */
export const hashLocation = (normalized: string): string => createHash('sha256').update(SALT + normalized).digest('hex');

/**
 * Единый вид пути Windows: прямые слэши, нижний регистр (NTFS не различает регистр),
 * Unicode NFC, без `.`, пустых частей и концевых слэшей; префиксы `\\?\` и `\\?\UNC\` сняты.
 * Сетевой путь: `//сервер/ресурс[/…]`, дисковый: `z:[/…]`. Остальное и `..` — null.
 */
export function normalizeLocationPath(input: string): string | null {
  if (typeof input !== 'string' || !input || input.length > 4096 || input.includes('\0')) return null;
  let text = input.normalize('NFC').replace(/\\/gu, '/');
  if (/^\/\/[?.]\/unc\//iu.test(text)) text = `//${text.slice(8)}`;
  else if (/^\/\/[?.]\//u.test(text)) text = text.slice(4);
  const unc = text.startsWith('//');
  const parts: string[] = [];
  for (const part of text.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  if (unc) return parts.length >= 2 ? `//${parts.join('/').toLowerCase()}` : null;
  return /^[a-z]:$/iu.test(parts[0] || '') ? parts.join('/').toLowerCase() : null;
}

/** Цепочка сетевого пути от него самого до корня ресурса: `//s/r/a/b` → [`//s/r/a/b`, `//s/r/a`, `//s/r`]. */
export function uncChain(normalized: string): string[] {
  if (!normalized.startsWith('//')) return [];
  const parts = normalized.slice(2).split('/');
  const chain: string[] = [];
  for (let length = parts.length; length >= 2; length--) chain.push(`//${parts.slice(0, length).join('/')}`);
  return chain;
}

/** Вывод `Get-CimInstance Win32_LogicalDisk … ProviderName`: одна строка `\\сервер\ресурс`. */
export function parseProviderName(stdout: string): string | null {
  for (const line of String(stdout).split(/\r?\n/u)) {
    const text = line.trim();
    if (/^\\\\[^\\]+\\.+/u.test(text)) return text;
  }
  return null;
}

/**
 * Вывод `net use Z:`. Подписи зависят от языка Windows («Remote name» / «Имя удаленного ресурса»),
 * поэтому подпись не разбирается: берётся хвост строки, начинающийся с `\\сервер\ресурс`.
 * Имя ресурса может содержать пробелы, поэтому берётся вся строка до конца.
 */
export function parseNetUse(stdout: string): string | null {
  for (const line of String(stdout).split(/\r?\n/u)) {
    const match = /^[^\\]*?(\\\\[^\\\s]+\\\S.*)$/u.exec(line);
    if (match) return match[1].trim();
  }
  return null;
}

export interface LocationKeyDeps {
  /** Путь корня Проводника на этом компьютере (бросает, если корень не подключён). */
  rootPath: (rootId: string) => string;
  /** `Z:\` → `\\сервер\ресурс` для сетевого диска; null для локального или неподключённого. */
  uncOfDrive: (driveRoot: string) => Promise<string | null>;
  now?: () => number;
}

export interface LocationKeysResult {
  /** Уникальные ключи; цепочки ссылаются на них по номеру, чтобы общие предки не повторялись. */
  keys: string[];
  /** Для каждой ссылки: номера ключей [сама папка, родитель, …, корень ресурса] или null (не сетевая, черновик, ошибка). */
  chains: Array<number[] | null>;
}

export class LocationKeys {
  private bases = new Map<string, { at: number; value: Promise<string | null> }>();
  constructor(private deps: LocationKeyDeps) {}

  /** Сетевая основа корня (`//сервер/ресурс/папка`), рассчитанная один раз на корень. */
  private base(rootId: string): Promise<string | null> {
    const now = (this.deps.now || Date.now)();
    const hit = this.bases.get(rootId);
    if (hit && now - hit.at < DRIVE_TTL_MS) return hit.value;
    const value = (async () => {
      const root = this.deps.rootPath(rootId);
      const normalized = normalizeLocationPath(root);
      if (!normalized) return null;
      if (normalized.startsWith('//')) return normalized;
      const unc = await this.deps.uncOfDrive(`${root.slice(0, 2).toUpperCase()}\\`).catch(() => null);
      const share = unc ? normalizeLocationPath(unc) : null;
      if (!share?.startsWith('//')) return null;
      const rest = normalized.split('/').slice(1);
      return rest.length ? `${share}/${rest.join('/')}` : share;
    })().catch(() => null);
    this.bases.set(rootId, { at: now, value });
    if (this.bases.size > 64) this.bases.delete(this.bases.keys().next().value!);
    return value;
  }

  async resolve(refs: WindowsFileRef[]): Promise<LocationKeysResult> {
    if (!Array.isArray(refs) || !refs.length || refs.length > MAX_LOCATION_REFS) throw new WindowsFilesError('INVALID_REQUEST', `Укажите от 1 до ${MAX_LOCATION_REFS} объектов.`);
    const index = new Map<string, number>();
    const keys: string[] = [];
    const idOf = (normalized: string) => {
      let id = index.get(normalized);
      if (id === undefined) { id = keys.length; keys.push(hashLocation(normalized)); index.set(normalized, id); }
      return id;
    };
    const chains: Array<number[] | null> = [];
    for (const ref of refs) {
      try {
        if (!ref || typeof ref !== 'object' || typeof ref.rootId !== 'string' || typeof ref.relativePath !== 'string' || ref.draftId) { chains.push(null); continue; }
        const segments = relativeSegments(ref.relativePath);
        const base = await this.base(ref.rootId);
        const full = base && normalizeLocationPath([base, ...segments].join('/'));
        chains.push(full ? uncChain(full).map(idOf) : null);
      } catch { chains.push(null); }
    }
    return { keys, chains };
  }

  /** Выдаёт переносимые якоря UNC, не раскрывая сам сетевой адрес странице. */
  async portable(ref: WindowsFileRef): Promise<PortableFolderLocator | null> {
    try {
      if (!ref || ref.draftId || typeof ref.rootId !== 'string' || typeof ref.relativePath !== 'string') return null;
      const segments = relativeSegments(ref.relativePath);
      const base = await this.base(ref.rootId);
      const full = base && normalizeLocationPath([base, ...segments].join('/'));
      if (!full?.startsWith('//')) return null;
      const chain = uncChain(full);
      const fullParts = full.slice(2).split('/');
      const anchors = chain.map((ancestor, index) => {
        const ancestorParts = ancestor.slice(2).split('/');
        return { key: hashLocation(ancestor), relativePath: fullParts.slice(ancestorParts.length).join('/') };
      });
      return { folderKey: hashLocation(full), anchors };
    } catch { return null; }
  }
}

/** Ищет только внутри уже подключённых корней: переносимая ссылка не запускает обход диска. */
export async function resolvePortableFolder(
  locator: PortableFolderLocator,
  roots: Array<{ id: string; available: boolean }>,
  locations: LocationKeys,
  entry: (ref: WindowsFileRef) => Promise<{ kind: string }>,
): Promise<WindowsFileRef | null> {
  if (!locator || !/^[a-f0-9]{64}$/u.test(locator.folderKey) || !Array.isArray(locator.anchors) || locator.anchors.length > 64) return null;
  for (const anchor of locator.anchors) if (!/^[a-f0-9]{64}$/u.test(anchor.key) || typeof anchor.relativePath !== 'string' || anchor.relativePath.length > 4096 || anchor.relativePath.includes('\\') || anchor.relativePath.split('/').some(part => part === '..' || part === '.')) return null;
  for (const root of roots) {
    if (!root.available) continue;
    const baseRef = { rootId: root.id, relativePath: '' };
    const rootLocator = await locations.portable(baseRef);
    if (!rootLocator) continue;
    for (const targetAnchor of locator.anchors) {
      const rootAnchor = rootLocator.anchors.find(item => item.key === targetAnchor.key);
      if (!rootAnchor) continue;
      const prefix = rootAnchor.relativePath;
      const targetSuffix = targetAnchor.relativePath;
      if (prefix && targetSuffix !== prefix && !targetSuffix.startsWith(`${prefix}/`)) continue;
      const relativePath = prefix ? targetSuffix.slice(prefix.length).replace(/^\//u, '') : targetSuffix;
      const candidate = { rootId: root.id, relativePath };
      try {
        if ((await entry(candidate)).kind !== 'directory') continue;
        const verified = await locations.portable(candidate);
        if (verified?.folderKey === locator.folderKey) return candidate;
      } catch { /* отключённый том или недоступная папка — следующий подключённый корень */ }
    }
  }
  return null;
}
