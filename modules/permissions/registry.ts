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
import { PROGRAM_ID } from '../programs/model';
import { ACCESS_NAMES, connectionsOf, describeConnection, humanText, parseConnections } from '../connections/model';

export type PermissionLineKind = 'read' | 'open' | 'connect' | 'write' | 'run' | 'internet' | 'lan' | 'program' | 'attach';
export interface PermissionLine {
  kind: PermissionLineKind;
  text: string;
  /** Заметное разрешение: окно выделяет его среди обычных строк (любой адрес в интернете, локальная сеть, обращение к программе) */
  notable?: boolean;
  /**
   * Текст для отпечатка, если он должен отличаться от показанного: строка с названием другой программы зависит от каталога,
   * а отпечаток обязан считаться одинаково по одному манифесту — в окне, на сервере и в главном процессе
   */
  stable?: string;
}
/** Название программы по идентификатору для строк «Обращается к программе «…»»; нет названия — показывается идентификатор */
export type ProgramNames = (programId: string) => string | undefined;
/** Одно объявленное разрешение: строка для человека, ключ сравнения и короткое название для разницы владельца */
export interface PermissionItem { key: string; line: PermissionLine; label: string }

export interface PermissionKind {
  id: 'reads' | 'open' | 'connections' | 'internet' | 'lan' | 'program' | 'attach' | 'write' | 'run';
  /** Поле манифеста, где вид объявлен (для справочных строк — нет) */
  field?: 'reads' | 'connections' | 'permissions';
  /** Требуется ли подтверждение человека: справочные строки («ничего не записывает») подтверждать нечего */
  consent: boolean;
  /** Объявление допустимо; false — манифест не принимается */
  check: (manifest: unknown) => boolean;
  /** Объявленное в манифесте, по порядку показа */
  items: (manifest: ModuleManifest, names?: ProgramNames) => PermissionItem[];
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

// ── Сеть и другие программы: раздел `permissions` ──────────────────────────

export const PERMISSIONS_MAX = 16;
export const NET_PERMISSION_KINDS = ['internet', 'lan'] as const;
export type NetPermissionKind = typeof NET_PERMISSION_KINDS[number];
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Раздел `permissions`: любое лишнее или неверное поле — отказ целиком; `does` — текст для человека, как у подключений */
export function parsePermissions(raw: unknown): ModulePermission[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > PERMISSIONS_MAX) return null;
  const out: ModulePermission[] = [];
  for (const item of raw) {
    if (!isObject(item) || typeof item.does !== 'string' || !humanText(item.does, 12, 240, 3)) return null;
    let permission: ModulePermission;
    if ((NET_PERMISSION_KINDS as readonly unknown[]).includes(item.kind)) {
      if (Object.keys(item).some(k => k !== 'kind' && k !== 'does')) return null;
      permission = { kind: item.kind as NetPermissionKind, does: item.does.trim() };
    } else if (item.kind === 'program') {
      if (Object.keys(item).some(k => k !== 'kind' && k !== 'does' && k !== 'program') || typeof item.program !== 'string' || !PROGRAM_ID.test(item.program)) return null;
      permission = { kind: 'program', program: item.program, does: item.does.trim() };
    } else if (item.kind === 'attach') {
      if (Object.keys(item).some(k => k !== 'kind' && k !== 'does')) return null;
      permission = { kind: 'attach', does: item.does.trim() };
    } else return null;
    if (out.some(p => p.kind === permission.kind && p.does === permission.does && (p as { program?: string }).program === (permission as { program?: string }).program)) return null;
    out.push(permission);
  }
  return out;
}
/** Объявленные в манифесте разрешения (в проверенном выпуске они уже прошли схему; повторный разбор — защита главного процесса) */
export const permissionsOf = (manifest: { permissions?: unknown } | null | undefined): ModulePermission[] => parsePermissions(manifest?.permissions) || [];
/** Программа вправе обращаться по полному адресу: нужное разрешение объявлено в подписанном манифесте */
export const hasNetPermission = (manifest: { permissions?: unknown } | null | undefined, kind: NetPermissionKind) =>
  permissionsOf(manifest).some(p => p.kind === kind);
/** Программа вправе вызывать методы другой программы: разрешение `program` на этот идентификатор объявлено в подписанном манифесте */
export const hasProgramPermission = (manifest: { permissions?: unknown } | null | undefined, programId: string) =>
  permissionsOf(manifest).some(p => p.kind === 'program' && p.program === programId);
/**
 * Программа заявила, что прикрепляет результаты к проектам (`flux.attach`). Пока это только заявление: записи во Flux нет нигде,
 * мост отвечает UNAVAILABLE даже при разрешении (modules/bridge.ts) — но разрешение уже подтверждается человеком и входит в отпечаток
 */
export const hasAttachPermission = (manifest: { permissions?: unknown } | null | undefined) =>
  permissionsOf(manifest).some(p => p.kind === 'attach');
/** Вызываемые программы, на которые у манифеста есть разрешение */
export const programTargetsOf = (manifest: { permissions?: unknown } | null | undefined): string[] =>
  [...new Set(permissionsOf(manifest).flatMap(p => p.kind === 'program' ? [p.program] : []))];

const NET_TEXT: Record<NetPermissionKind, { prefix: string; label: string }> = {
  internet: { prefix: 'Обращается к любому адресу в интернете', label: 'любой адрес в интернете' },
  lan: { prefix: 'Обращается к устройствам в локальной сети', label: 'локальная сеть' },
};
/** Разрешения проверяются все вместе: разбор целиком, а не по видам, поэтому запись одного вида проверяет и соседей */
const permissionsCheck = (manifest: unknown) => {
  const m = manifest as { id?: unknown; permissions?: unknown } | null;
  const parsed = parsePermissions(m?.permissions);
  // Обращение к самой себе смысла не имеет и открыло бы вложенный вызов: объявить его нельзя
  return parsed !== null && !parsed.some(p => p.kind === 'program' && p.program === m?.id);
};
const netKind = (kind: NetPermissionKind): PermissionKind => ({
  id: kind, field: 'permissions', consent: true, check: permissionsCheck,
  items: manifest => permissionsOf(manifest).filter(p => p.kind === kind).map(p => {
    const text = `${NET_TEXT[kind].prefix}: ${p.does}`;
    return { key: text, label: `${NET_TEXT[kind].label} — ${p.does}`, line: { kind, text, notable: true } };
  }),
});
/** Обращение к программе: строка называет её по имени из каталога; сравнение версий и отпечаток — по идентификатору, он не меняется */
const programKind: PermissionKind = {
  id: 'program', field: 'permissions', consent: true, check: permissionsCheck,
  items: (manifest, names) => permissionsOf(manifest).flatMap(p => p.kind === 'program' ? [p] : []).map(p => {
    const text = `Обращается к программе «${names?.(p.program) || p.program}»: ${p.does}`;
    const key = `Обращается к программе «${p.program}»: ${p.does}`;
    return { key, label: `программа «${p.program}» — ${p.does}`, line: { kind: 'program', text, notable: true, stable: key } };
  }),
};

/** Прикрепление результатов к проектам: заметная строка, как у сети; запись пока не работает (см. hasAttachPermission) */
const attachKind: PermissionKind = {
  id: 'attach', field: 'permissions', consent: true, check: permissionsCheck,
  items: manifest => permissionsOf(manifest).flatMap(p => p.kind === 'attach' ? [p] : []).map(p => {
    const text = `Прикрепляет результаты к проектам: ${p.does}`;
    return { key: text, label: `прикрепление к проектам — ${p.does}`, line: { kind: 'attach', text, notable: true } };
  }),
};

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
  programKind,
  attachKind,
  // Запись в данные Flux и запуск программ договор не даёт (разрешение `attach` пока только заявление: записи нет) — строки остаются, чтобы отсутствие права было видно
  { id: 'write', consent: false, check: () => true, items: () => [{ key: 'write', label: 'запись', line: { kind: 'write', text: 'Ничего не записывает во Flux' } }] },
  { id: 'run', consent: false, check: () => true, items: () => [{ key: 'run', label: 'запуск', line: { kind: 'run', text: 'Не запускает программы на компьютере' } }] },
];

/** Все объявления манифеста допустимы (его проверяет выпуск); неизвестное и лишнее схема отвергает раньше */
export const permissionsValid = (manifest: unknown): boolean => PERMISSION_KINDS.every(kind => kind.check(manifest));

/** Строки для окна установки: порядок таблицы, у видов без объявлений — строка «не …», если она есть */
export function permissionLines(manifest: ModuleManifest, names?: ProgramNames): PermissionLine[] {
  return PERMISSION_KINDS.flatMap(kind => {
    const items = kind.items(manifest, names);
    return items.length ? items.map(i => i.line) : kind.none ? [kind.none] : [];
  });
}

/** Объявленные разрешения, которые подтверждает человек: ключ для сравнения версий и строка */
export function grantItems(manifest: ModuleManifest | null, names?: ProgramNames): PermissionItem[] {
  return manifest ? PERMISSION_KINDS.filter(k => k.consent).flatMap(k => k.items(manifest, names)) : [];
}

/** Что новая версия просит сверх прошлой — человек подтверждает это при обновлении (тексты строк) */
export function addedPermissions(before: ModuleManifest | null, after: ModuleManifest, names?: ProgramNames): string[] {
  const had = new Set(grantItems(before).map(i => i.key));
  return grantItems(after, names).filter(i => !had.has(i.key)).map(i => i.line.text);
}

/** Короткий отпечаток разрешений: окно сверяет то, что показало, с тем, что проверил главный процесс */
export function permissionsDigest(manifest: ModuleManifest): string {
  return permissionLines(manifest).map(l => `${l.kind}:${l.stable ?? l.text}`).sort().join('|');
}
