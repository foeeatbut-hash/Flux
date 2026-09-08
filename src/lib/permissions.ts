// Единый модуль прав доступа «по функциям» с таймером.
// Используется и на фронте (показать/скрыть/заблокировать кнопки),
// и на сервере (таблица маршрутов в server.ts), чтобы правило было одно.
//
// Право приходит из двух мест: от роли сотрудника (общее для должности) и
// лично (надбавка или, наоборот, запрет). Личная настройка сильнее роли —
// иначе нельзя было бы забрать доступ у одного человека, не трогая всю роль.

export interface PermEntry { enabled: boolean; until: string | null }
export type PermMap = Record<string, PermEntry>;

export interface FeatureDef {
  id: string;
  label: string;
  desc: string;
  group: string;
  /** Право опасное: выдавать осознанно (удаление, настройки всей компании). */
  risky?: boolean;
}

// Каталог выдаваемых функций. Админ-функции сюда НЕ входят —
// выданными правами нельзя «дорасти» до администратора.
export const FEATURES: FeatureDef[] = [
  { id: 'project.manage', group: 'Проекты', label: 'Управление проектами',
    desc: 'Создавать, переименовывать и удалять проекты' },

  { id: 'tags.manage', group: 'Теги', label: 'Создание и правка тегов',
    desc: 'Добавлять теги, менять марку, отдел, WBS, связи на холсте' },
  { id: 'tags.delete', group: 'Теги', label: 'Удаление тегов', risky: true,
    desc: 'Удалять теги из реестра вместе со связями' },
  { id: 'dictionaries.manage', group: 'Теги', label: 'Справочники и шаблоны',
    desc: 'Редактировать словари и шаблоны генерации тегов' },

  { id: 'equipment.import', group: 'Оборудование', label: 'Импорт из бланков',
    desc: 'Загружать оборудование из файлов расчёта (XLSX/XML)' },
  { id: 'equipment.manage', group: 'Оборудование', label: 'Правка характеристик',
    desc: 'Менять параметры позиций и разрешать конфликты ревизий' },

  { id: 'files.upload', group: 'Проводник', label: 'Загрузка файлов',
    desc: 'Загружать файлы и создавать папки' },
  { id: 'files.delete', group: 'Проводник', label: 'Удаление файлов и папок', risky: true,
    desc: 'Удалять файлы и папки, очищать корзину' },
  // Диск один на всю программу и виден всем. Читают его все — это его смысл;
  // а вот класть на него имеет право не каждый, иначе он зарастёт за месяц,
  // как всякая общая папка в сети
  { id: 'disk.write', group: 'Проводник', label: 'Запись на общий диск', risky: true,
    desc: 'Класть файлы и заводить папки на общем диске — он виден всем сотрудникам' },

  { id: 'procurement.manage', group: 'Менеджмент', label: 'Этапы закупки',
    desc: 'Отмечать этапы, менять поставщика, количество, примечания' },
  { id: 'procurement.setup', group: 'Менеджмент', label: 'Настройка этапов', risky: true,
    desc: 'Менять состав этапов закупки и шаблоны для всей компании' },
  { id: 'vdr.manage', group: 'Менеджмент', label: 'Реестр ВДР',
    desc: 'Вести строки реестра, ревизии, замечания и сроки' },
  { id: 'vdr.standards', group: 'Менеджмент', label: 'Стандарты документооборота', risky: true,
    desc: 'Менять коды рассмотрения, маски номеров и правила ревизий' },

  { id: 'mail.shared', group: 'Почта', label: 'Настройка общей почты', risky: true,
    desc: 'Подключать и менять общий ящик компании — он виден всем сотрудникам' },

  // Журнал показывает, кто что делал по всей программе. Это не рабочий
  // инструмент инженера, а средство разбирательства, и по умолчанию он закрыт
  // у всех: увидеть чужие действия можно только с ведома владельца
  { id: 'log.view', group: 'Журнал', label: 'Журнал действий', risky: true,
    desc: 'Видеть, кто и что делал в программе: входы, правки, выгрузки, доступы' },
];

/**
 * Что сотрудник может по умолчанию.
 *
 * Решение владельца, и оно про то, как в отделе действительно работают: люди
 * не воруют друг у друга ведомости, и доступ нужен ровно для двух вещей —
 * чтобы посторонний не сломал структуру проектов и чтобы доступы раздавал
 * один человек. Всё остальное — работа, и мешать ей не надо.
 *
 * Поэтому новому сотруднику выдаётся всё, кроме двух вещей: управление
 * проектами (создание, переименование и удаление остаётся за руководителем) и
 * Журнал действий — он показывает, кто что делал по всей программе, и это
 * средство разбирательства, а не работы.
 * Тридцать галочек, которые раньше приходилось расставлять руками, начинали
 * с нуля — и новый человек первый день не мог ничего.
 */
export const DEFAULT_DENIED = ['project.manage', 'log.view'];

export function defaultPermissions(): PermMap {
  const map: PermMap = {};
  for (const f of FEATURES) {
    if (DEFAULT_DENIED.includes(f.id)) continue;
    map[f.id] = { enabled: true, until: null };
  }
  return map;
}

export const FEATURE_GROUPS = Array.from(new Set(FEATURES.map((f) => f.group)));
export const featureById = (id: string) => FEATURES.find((f) => f.id === id) || null;

export interface PermUser {
  role?: string;
  isActive?: boolean;
  validUntil?: string | Date | null;
  permissions?: string | PermMap | null;
  /** Права роли, присланные сервером вместе с профилем. */
  rolePermissions?: string | PermMap | null;
}

export function parsePermissions(raw: string | PermMap | null | undefined): PermMap {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as PermMap;
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

/** Права роли + личные поверх них. Личное всегда сильнее. */
export function mergePermissions(
  rolePerms: string | PermMap | null | undefined,
  personal: string | PermMap | null | undefined,
): PermMap {
  return { ...parsePermissions(rolePerms), ...parsePermissions(personal) };
}

const expired = (until: string | null | undefined): boolean =>
  !!until && new Date(until).getTime() < Date.now();

/** Итоговый набор прав сотрудника (роль ADMIN проверяется отдельно — она может всё). */
export function effectivePermissions(user: PermUser | null | undefined): PermMap {
  if (!user) return {};
  return mergePermissions(user.rolePermissions, user.permissions);
}

/** Запись права для отображения статуса в UI. */
export function permEntry(user: PermUser | null | undefined, feature: string): PermEntry {
  const e = effectivePermissions(user)[feature];
  return { enabled: !!e?.enabled, until: e?.until ?? null };
}

/** Откуда пришло право — чтобы в карточке сотрудника это было видно. */
export function permSource(user: PermUser | null | undefined, feature: string): 'role' | 'personal' | 'none' {
  const personal = parsePermissions(user?.permissions)[feature];
  if (personal) return 'personal';
  const fromRole = parsePermissions(user?.rolePermissions)[feature];
  return fromRole?.enabled ? 'role' : 'none';
}

/** Главная проверка доступа. Администратор — всегда всё. */
export function can(user: PermUser | null | undefined, feature: string): boolean {
  if (!user) return false;
  if (user.role === 'ADMIN') return true;            // админ всегда главнее
  if (user.isActive === false) return false;          // профиль отключён
  if (expired(typeof user.validUntil === 'string' ? user.validUntil
      : user.validUntil instanceof Date ? user.validUntil.toISOString() : null)) return false;
  const map = effectivePermissions(user);
  let e = map[feature];
  // обратная совместимость: старое право project.create = управление проектом
  if ((!e || !e.enabled) && feature === 'project.manage' && map['project.create']) e = map['project.create'];
  if (!e || !e.enabled) return false;
  if (expired(e.until)) return false;
  return true;
}
