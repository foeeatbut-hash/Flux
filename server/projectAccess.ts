import { can } from '../src/lib/permissions.js';

// Правила доступа к проектам и настройкам — чистая логика без базы и сервера,
// чтобы каждое решение можно было проверить подставными объектами
// (scripts/test-project-access.ts). Обработчики только достают факты из базы и
// спрашивают здесь, что с ними делать.

/** Кто спрашивает: профиль из сессии (см. промежуточный слой server.ts) */
export interface Actor {
  id?: string;
  role?: string;
  isActive?: boolean;
  validUntil?: string | Date | null;
  permissions?: string | null;
}

export const isAdminActor = (a: Actor | null | undefined): boolean => a?.role === 'ADMIN';

/** Пустая строка и «null/undefined/default» — не проект, а «проект по умолчанию» */
export function isRealProjectId(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  return !!s && s !== 'null' && s !== 'undefined' && s !== 'default';
}

/**
 * Видит ли человек проект, зная состав.
 *
 * `memberIds === null` — состав прочитать не удалось. Раньше ошибка проверки
 * читалась как «видно всем», и любой сбой базы открывал закрытый проект
 * посторонним; теперь при сбое отказ, кроме администратора.
 * Пустой состав по-прежнему значит «в проект ещё никого не звали»: включать
 * ограничение задним числом на базе, не знавшей об участниках, нельзя.
 */
export function visibleByMembers(memberIds: string[] | null, userId: string, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  if (memberIds === null) return false;
  if (memberIds.length === 0) return true;
  return !!userId && memberIds.includes(userId);
}

/** Проекты, скрытые от человека: у них есть состав, а его в нём нет */
export function hiddenProjectIds(rows: Array<{ projectId: string; userId: string }>, userId: string): string[] {
  const byProject = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!byProject.has(r.projectId)) byProject.set(r.projectId, new Set());
    byProject.get(r.projectId)!.add(r.userId);
  }
  const hidden: string[] = [];
  for (const [pid, users] of byProject) if (!users.has(userId)) hidden.push(pid);
  return hidden;
}

/**
 * Какие проекты назвал запрос: адрес `/api/projects/<id>/…`, `?projectId=` и
 * поле `projectId` в теле. Проверка доступа, повешенная на каждый маршрут по
 * отдельности, теряется на новых маршрутах; общий слой смотрит на сам запрос.
 */
export function projectIdsOfRequest(path: string, query: any, body: any): string[] {
  const ids = new Set<string>();
  const m = /^\/api\/projects\/([^/]+)\//i.exec(path);
  if (m) { try { ids.add(decodeURIComponent(m[1])); } catch (_) { ids.add(m[1]); } }
  const q = query?.projectId;
  if (typeof q === 'string') ids.add(q);
  const b = body?.projectId;
  if (typeof b === 'string') ids.add(b);
  return [...ids].filter(isRealProjectId);
}

/**
 * Есть ли у человека право по функции (по умолчанию — project.manage).
 *
 * Профиль сессии — строка пользователя без прав роли, поэтому роль
 * дочитывается отдельно; читалка передаётся, чтобы проверка не знала о базе.
 */
export async function actorMay(
  actor: Actor | null | undefined,
  roleGrants: (roleCode: string) => Promise<string | null>,
  feature = 'project.manage',
): Promise<boolean> {
  if (!actor) return false;
  if (isAdminActor(actor)) return true;
  let rolePermissions: string | null = null;
  try { rolePermissions = await roleGrants(String(actor.role || '')); } catch (_) { return false; }
  return can({ ...actor, rolePermissions }, feature);
}

export interface MembersChange {
  isAdmin: boolean;
  /** Обладатель project.manage */
  canManage: boolean;
  actorId: string;
  before: string[];
  next: string[];
}

/**
 * Можно ли так поменять состав проекта.
 *
 * Администратор и обладатель project.manage — как угодно. Остальные:
 *  - открытому проекту (никого не звали) состав не задают: первым же вызовом
 *    его закрыли бы от остальных сотрудников;
 *  - участник может только звать коллег (в состав входят все прежние);
 *    убрать человека или очистить список, а значит выкинуть коллег или
 *    открыть закрытый проект всем, — не может.
 * Владельца в модели проекта нет, поэтому «создателем» считается управляющий.
 */
export function judgeMembersChange(c: MembersChange): { ok: true } | { ok: false; reason: string } {
  if (c.isAdmin || c.canManage) return { ok: true };
  if (c.before.length === 0) {
    return { ok: false, reason: 'Состав открытого проекта задаёт администратор или обладатель права «Управление проектами».' };
  }
  if (!c.actorId || !c.before.includes(c.actorId)) {
    return { ok: false, reason: 'Менять состав может участник проекта, администратор или обладатель права «Управление проектами».' };
  }
  const next = new Set(c.next);
  const dropped = c.before.filter((id) => !next.has(id));
  if (dropped.length) {
    return { ok: false, reason: 'Убирать участников из проекта может администратор или обладатель права «Управление проектами».' };
  }
  return { ok: true };
}

// ── Настройки приложения ─────────────────────────────────────────────────────

/**
 * Ключи, от которых зависит доверие и защита: издатель игр, якорь времени,
 * лицензия, безопасность, резервные копии, политика обращений. Общий маршрут
 * настроек их не читает (у посторонних) и не пишет ни у кого: у каждого есть
 * штатный путь с проверкой прав (play/admin, время в server.ts, security.ts).
 */
const TRUST_KEYS: RegExp[] = [
  /^security[._:]/i, /^play[._:]/i, /^license/i, /anchor/i, /^time[._:]/i,
  /^backup_settings$/i, /^feedback\.settings/i,
];

/**
 * Служебные ключи разделов, у которых свои маршруты и свои проверки права:
 * подписанты документов, справочник импорта, карта видов, категории
 * оборудования и т. п. Писать их через общий маршрут — значит обойти эти проверки.
 */
const SERVER_OWNED: RegExp[] = [
  /^office_/i, /^constructor_param_aliases$/, /^veza_kind_map$/, /^import_(dictionary|symbols)$/,
  /^equip_categories$/, /^insight_muted$/,
];

export const isTrustKey = (key: string): boolean => TRUST_KEYS.some((re) => re.test(key));
export const isServerKey = (key: string): boolean => isTrustKey(key) || SERVER_OWNED.some((re) => re.test(key));

export const validSettingKey = (key: unknown): key is string =>
  typeof key === 'string' && key.length > 0 && key.length <= 120 && /^[\w.:\-]+$/.test(key);

/** Потолок значения: настройки — это флажки и короткие списки, не хранилище файлов */
export const MAX_SETTING_BYTES = 2 * 1024 * 1024;

/**
 * Общие (глобальные) настройки, которые вправе писать не администратор.
 * Остальные общие ключи меняет только администратор: они переключают
 * поведение программы у всех сразу.
 */
export type GlobalWriteRule = { perm?: string; project?: boolean } | null;
export function globalWriteRule(key: string): GlobalWriteRule {
  // Этапы и шаблоны закупки — право procurement.setup. В таблице маршрутов
  // server.ts шаблоны названы иначе, чем их пишет экран, и остались без стража
  if (key === 'procurement_stages' || key === 'procurement_templates' || key === 'stage_templates') {
    return { perm: 'procurement.setup' };
  }
  // Закладки браузера общие на проект: их ведёт каждый участник проекта
  if (/^browser_bookmarks_/.test(key)) return { project: true };
  return null;
}

/** Проект, на который указывает ключ закладок (`browser_bookmarks_<id>`) */
export const bookmarksProjectOf = (key: string): string => {
  const id = key.replace(/^browser_bookmarks_/, '');
  return isRealProjectId(id) ? id : '';
};

export type SettingScope =
  | { kind: 'personal'; userId: string }
  | { kind: 'global' };

/**
 * Чья это запись.
 *
 * Личная — только сессии: присланный userId игнорируется, иначе можно писать
 * чужие настройки. Администратор может явно назвать другого человека.
 */
export function settingScope(actorId: string, isAdmin: boolean, bodyUserId: unknown): SettingScope {
  const asked = bodyUserId == null ? '' : String(bodyUserId);
  if (!asked) return { kind: 'global' };
  if (isAdmin && asked !== actorId) return { kind: 'personal', userId: asked };
  return { kind: 'personal', userId: actorId };
}

// ── Группы чата ──────────────────────────────────────────────────────────────

/**
 * Можно ли менять или удалять группу чата (в том числе передавать владение).
 *
 * Раньше проверка владельца пропускалась, если клиент не прислал userId, и
 * чужую группу можно было переименовать, забрать себе (ownerId) или удалить.
 * Группа без владельца (служебный канал) — только администратору.
 */
export function mayEditGroup(actorId: string, isAdmin: boolean, groupOwnerId: string | null | undefined): boolean {
  if (isAdmin) return true;
  return !!actorId && !!groupOwnerId && String(groupOwnerId) === actorId;
}

/** Владелец новой группы: сам создающий; назвать другого может только администратор */
export function ownerForNewGroup(actorId: string, isAdmin: boolean, askedOwnerId: unknown): string {
  const asked = askedOwnerId ? String(askedOwnerId) : '';
  return isAdmin && asked ? asked : actorId;
}
