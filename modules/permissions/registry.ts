/**
 * Реестр разрешений программ: что программа может просить и как это видят люди.
 *
 * Чистый модуль без Node и React. Один вид разрешения — одна запись в таблице
 * `PERMISSION_KINDS`: проверка объявления в манифесте, строки для человека,
 * признак «заметное» (выделяется в окне установки и в разнице запроса владельца)
 * и ключ сравнения, по которому обновление понимает, что разрешение НОВОЕ и
 * его надо подтвердить заново. Окно Store, отпечаток разрешений (сверяется в
 * главном процессе), разница владельца и проверка манифеста при выпуске строятся
 * из этой таблицы, поэтому новый вид («программа», «изменять …») — это новая
 * запись здесь, а не правка пяти мест.
 *
 * Только добавление: тексты строк старых видов не меняются никогда — по ним
 * считается отпечаток уже установленных программ.
 */
import type { ModuleManifest, ModulePermission, Resource } from '../contract';
import { resources } from '../contract';
import { ACCESS_NAMES, connectionsOf, describeConnection, humanText, parseConnections } from '../connections/model';

export type PermissionLineKind = 'read' | 'open' | 'connect' | 'write' | 'run' | 'internet' | 'lan';
export interface PermissionLine {
  kind: PermissionLineKind;
  text: string;
  /** Заметное разрешение: окно выделяет его среди обычных строк (любой адрес в интернете, локальная сеть) */
  notable?: boolean;
}
/** Одно объявленное разрешение: строка для человека, ключ сравнения и короткое название для разницы владельца */
export interface PermissionItem { key: string; line: PermissionLine; label: string }

export interface PermissionKind {
  id: 'reads' | 'open' | 'connections' | 'internet' | 'lan' | 'write' | 'run';
  /** Поле манифеста, где вид объявлен (для справочных строк — нет) */
  field?: 'reads' | 'connections' | 'permissions';
  /** Требуется ли подтверждение человека: справочные строки («ничего не записывает») подтверждать нечего */
  consent: boolean;
  /** Объявление допустимо; false — манифест не принимается */
  check: (manifest: unknown) => boolean;
  /** Объявленное в манифесте, по порядку показа */
  items: (manifest: ModuleManifest) => PermissionItem[];
  /** Строка, когда ничего не объявлено: человек видит отсутствие права так же ясно, как наличие */
  none?: PermissionLine;
}

export const RESOURCE_NAMES: Record<Resource, string> = {
  project: 'данные текущего проекта', equipment: 'оборудование и его параметры', tag: 'теги',
  specification: 'ведомость (спецификацию)', catalog: 'справочник каталога',
};
export const ENTRY_NAMES: Record<string, string> = {
  start: 'из «Пуска» и панели задач', equipment: 'из карточки оборудования', tag: 'из карточки тега',
};

// ── Сеть: «любой адрес в интернете» и «локальная сеть» ─────────────────────

export const PERMISSIONS_MAX = 16;
export const NET_PERMISSION_KINDS = ['internet', 'lan'] as const;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Раздел `permissions`: любое лишнее или неверное поле — отказ целиком; `does` — текст для человека, как у подключений */
export function parseNetPermissions(raw: unknown): ModulePermission[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > PERMISSIONS_MAX) return null;
  const out: ModulePermission[] = [];
  for (const item of raw) {
    if (!isObject(item) || Object.keys(item).some(k => k !== 'kind' && k !== 'does')
      || !(NET_PERMISSION_KINDS as readonly unknown[]).includes(item.kind) || typeof item.does !== 'string' || !humanText(item.does, 12, 240, 3)) return null;
    const permission: ModulePermission = { kind: item.kind as ModulePermission['kind'], does: item.does.trim() };
    if (out.some(p => p.kind === permission.kind && p.does === permission.does)) return null;
    out.push(permission);
  }
  return out;
}
/** Объявленные в манифесте разрешения сети (в проверенном выпуске они уже прошли схему; повторный разбор — защита главного процесса) */
export const netPermissionsOf = (manifest: { permissions?: unknown } | null | undefined): ModulePermission[] => parseNetPermissions(manifest?.permissions) || [];
/** Программа вправе обращаться по полному адресу: нужное разрешение объявлено в подписанном манифесте */
export const hasNetPermission = (manifest: { permissions?: unknown } | null | undefined, kind: ModulePermission['kind']) =>
  netPermissionsOf(manifest).some(p => p.kind === kind);

const NET_TEXT: Record<ModulePermission['kind'], { prefix: string; label: string }> = {
  internet: { prefix: 'Обращается к любому адресу в интернете', label: 'любой адрес в интернете' },
  lan: { prefix: 'Обращается к устройствам в локальной сети', label: 'локальная сеть' },
};
const netKind = (kind: ModulePermission['kind']): PermissionKind => ({
  id: kind, field: 'permissions', consent: true,
  check: manifest => parseNetPermissions((manifest as { permissions?: unknown } | null)?.permissions) !== null,
  items: manifest => netPermissionsOf(manifest).filter(p => p.kind === kind).map(p => {
    const text = `${NET_TEXT[kind].prefix}: ${p.does}`;
    return { key: text, label: `${NET_TEXT[kind].label} — ${p.does}`, line: { kind, text, notable: true } };
  }),
});

// ── Таблица видов ───────────────────────────────────────────────────────────

/** Порядок таблицы — порядок строк в окне установки */
export const PERMISSION_KINDS: readonly PermissionKind[] = [
  {
    id: 'reads', field: 'reads', consent: true,
    check: manifest => { const reads = (manifest as { reads?: unknown } | null)?.reads; return Array.isArray(reads) && reads.every(r => (resources as readonly unknown[]).includes(r)); },
    items: manifest => (manifest.reads || []).map(r => {
      const text = `Читает во Flux: ${RESOURCE_NAMES[r] || r}`;
      return { key: text, label: `чтение: ${RESOURCE_NAMES[r] || r}`, line: { kind: 'read', text } };
    }),
    none: { kind: 'read', text: 'Не читает данные Flux' },
  },
  {
    id: 'open', consent: false, check: () => true,
    items: manifest => {
      const text = `Открывается ${(manifest.entries || []).map(e => ENTRY_NAMES[e] || e).join(', ') || 'нигде'}`;
      return [{ key: text, label: text, line: { kind: 'open', text } }];
    },
  },
  {
    id: 'connections', field: 'connections', consent: true,
    check: manifest => parseConnections((manifest as { connections?: unknown } | null)?.connections) !== null,
    items: manifest => connectionsOf(manifest).map(c => {
      // Человеку — имя программы, вид доступа и что будет делать; адрес мелко, в скобках: он же отличает «новый адрес» при обновлении
      const text = `Подключается к «${c.app}»: ${ACCESS_NAMES[c.access]}. ${c.does} (${describeConnection(c)})`;
      return { key: text, label: `подключение: ${text}`, line: { kind: 'connect', text } };
    }),
  },
  netKind('internet'),
  netKind('lan'),
  // Запись и запуск программ договор не даёт — строки остаются, чтобы отсутствие права было видно
  { id: 'write', consent: false, check: () => true, items: () => [{ key: 'write', label: 'запись', line: { kind: 'write', text: 'Ничего не записывает во Flux' } }] },
  { id: 'run', consent: false, check: () => true, items: () => [{ key: 'run', label: 'запуск', line: { kind: 'run', text: 'Не запускает программы на компьютере' } }] },
];

/** Все объявления манифеста допустимы (его проверяет выпуск); неизвестное и лишнее схема отвергает раньше */
export const permissionsValid = (manifest: unknown): boolean => PERMISSION_KINDS.every(kind => kind.check(manifest));

/** Строки для окна установки: порядок таблицы, у видов без объявлений — строка «не …», если она есть */
export function permissionLines(manifest: ModuleManifest): PermissionLine[] {
  return PERMISSION_KINDS.flatMap(kind => {
    const items = kind.items(manifest);
    return items.length ? items.map(i => i.line) : kind.none ? [kind.none] : [];
  });
}

/** Объявленные разрешения, которые подтверждает человек: ключ для сравнения версий и строка */
export function grantItems(manifest: ModuleManifest | null): PermissionItem[] {
  return manifest ? PERMISSION_KINDS.filter(k => k.consent).flatMap(k => k.items(manifest)) : [];
}

/** Что новая версия просит сверх прошлой — человек подтверждает это при обновлении (тексты строк) */
export function addedPermissions(before: ModuleManifest | null, after: ModuleManifest): string[] {
  const had = new Set(grantItems(before).map(i => i.key));
  return grantItems(after).filter(i => !had.has(i.key)).map(i => i.line.text);
}

/** Короткий отпечаток разрешений: окно сверяет то, что показало, с тем, что проверил главный процесс */
export function permissionsDigest(manifest: ModuleManifest): string {
  return permissionLines(manifest).map(l => `${l.kind}:${l.text}`).sort().join('|');
}
