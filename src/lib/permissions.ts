// Единый модуль прав доступа «по функциям» с таймером.
// Используется и на фронте (показать/скрыть/заблокировать кнопки),
// и на сервере (таблица маршрутов в server.ts), чтобы правило было одно.
//
// Право приходит из двух мест: от роли сотрудника (общее для должности) и
// лично (надбавка или, наоборот, запрет). Личная настройка сильнее роли —
// иначе нельзя было бы забрать доступ у одного человека, не трогая всю роль.

/**
 * Запись права.
 *
 * `enabled` — рабочее право: выдано или нет, третьего не дано.
 *
 * `mode` появилось вместе с игровой платформой (см. src/lib/appPolicy.ts) и
 * значит другое: «сказано явно». Там важно различать «запрещено этому
 * человеку» и «про него ничего не сказано» — во втором случае ответ ищется
 * дальше, в правах роли. Отсутствие ключа и есть «ничего не сказано», поэтому
 * запрет приходится записывать, а не стирать.
 *
 * Старые записи поля не имеют и читаются как раньше: `enabled` → ALLOW,
 * иначе DENY. Переписывать существующие права ради нового поля не пришлось.
 */
export interface PermEntry {
  enabled: boolean;
  until: string | null;
  mode?: 'ALLOW' | 'DENY';
}
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

  // Каталог один на всю программу: его правка меняет подбор во всех проектах
  // сразу, поэтому она отдельное право, а смотреть и подбирать может каждый
  { id: 'catalog.manage', group: 'Каталог и Конструктор', label: 'Правка Каталога', risky: true,
    desc: 'Менять семейства, коды, правила и комплектующие в Каталоге оборудования — для всех проектов' },
  { id: 'blanks.manage', group: 'Каталог и Конструктор', label: 'Шаблоны бланков',
    desc: 'Создавать и менять шаблоны выходных бланков Конструктора' },
  { id: 'builder.edit', group: 'Каталог и Конструктор', label: 'Ведомости подбора',
    desc: 'Заводить ведомости, импортировать MTO, подбирать и править позиции' },
  { id: 'builder.issue', group: 'Каталог и Конструктор', label: 'Выпуск бланков',
    desc: 'Выпускать ревизию комплекта бланков и записывать её в историю' },

  { id: 'files.upload', group: 'Проводник', label: 'Загрузка файлов',
    desc: 'Загружать файлы и создавать папки' },
  { id: 'files.delete', group: 'Проводник', label: 'Удаление файлов и папок', risky: true,
    desc: 'Удалять файлы и папки, очищать корзину' },
  // Диск один на всю программу и виден всем. Читают его все — это его смысл;
  // а вот класть на него имеет право не каждый, иначе он зарастёт за месяц,
  // как всякая общая папка в сети
  { id: 'disk.write', group: 'Проводник', label: 'Запись на общий диск', risky: true,
    desc: 'Класть файлы и заводить папки на общем диске — он виден всем сотрудникам' },

  // Новый редактор Flux Office сначала получают те, кто согласился его
  // проверять: старые документы открываются старым редактором до приёмки
  // (docs/office-genoffice-plan.md, этап 7)
  { id: 'office.next', group: 'Flux Office', label: 'Проба нового офиса',
    desc: 'Открывать файлы Word из Проводника в новом редакторе Flux Office' },

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

  // Писать обращения может каждый: раздел затем и заведён, чтобы человеку было
  // куда пожаловаться. А разбирать чужие — работа отдельная, и видеть чужие
  // технические вложения тем более: в них лежит то, что автор приложил к
  // своему обращению, а не к общему обозрению
  { id: 'feedback.create', group: 'Обращения', label: 'Писать обращения',
    desc: 'Предлагать идеи и сообщать о проблемах, видеть свои обращения и ответы на них' },
  { id: 'feedback.triage', group: 'Обращения', label: 'Разбор обращений', risky: true,
    desc: 'Видеть очередь чужих обращений, отвечать авторам, менять статус и исполнителя' },
  { id: 'feedback.diagnostics', group: 'Обращения', label: 'Технические вложения', risky: true,
    desc: 'Открывать записи работы программы, приложенные к чужим обращениям' },
  { id: 'feedback.manage', group: 'Обращения', label: 'Настройка обращений', risky: true,
    desc: 'Менять сроки хранения, квоты и получателей разбора для всей компании' },
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
export const DEFAULT_DENIED = [
  'project.manage', 'log.view',
  // Разбор чужих обращений, чужие технические вложения и настройки хранения —
  // это работа одного-двух человек, а не всех. Писать обращения при этом может
  // каждый: право feedback.create в списке отказов намеренно отсутствует
  'feedback.triage', 'feedback.diagnostics', 'feedback.manage',
  // Каталог и шаблоны бланков общие для всех проектов: одна правка меняет подбор
  // и бланки у всего отдела сразу. Это работа того, кому её поручили, — решение
  // владельца; вести ведомости и выпускать бланки по-прежнему может каждый
  'catalog.manage', 'blanks.manage',
];

/**
 * Права, открытые, пока про них ничего не сказано.
 *
 * Запись прав у роли и сотрудника хранит только то, что было в каталоге на
 * момент настройки. Право, добавленное позже, в ней отсутствует — и читалось
 * как запрет: после появления Конструктора у всех, кроме администратора,
 * кнопки пропали, а сервер отвечал «Недостаточно прав» на любую запись. Для
 * этих прав отсутствие записи значит «как у нового сотрудника» — выдано.
 *
 * Запрет поэтому хранится явной записью `{enabled:false}`, а не отсутствием:
 * снятая галочка, которая просто удаляла запись, у такого права ничего не
 * запрещала (см. isExplicitDeny и cleanUserPermissions).
 */
export const OPEN_BY_DEFAULT = ['builder.edit', 'builder.issue'];

/** Запись права с учётом «открытых по умолчанию» — одна для окна и сервера */
export function entryOf(map: PermMap, feature: string): PermEntry | undefined {
  const e = map[feature];
  if (e) return e;
  if (OPEN_BY_DEFAULT.includes(feature) && !DEFAULT_DENIED.includes(feature)) return { enabled: true, until: null };
  return undefined;
}

/**
 * Что записать, когда в карточке или роли сняли галочку. У обычного права
 * достаточно убрать запись, у открытого по умолчанию — нужен явный запрет,
 * иначе право вернётся само.
 */
export function offEntry(feature: string): PermEntry | null {
  return OPEN_BY_DEFAULT.includes(feature) ? { enabled: false, until: null } : null;
}

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
  const e = entryOf(effectivePermissions(user), feature);
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
  let e = entryOf(map, feature);
  // обратная совместимость: старое право project.create = управление проектом
  if ((!e || !e.enabled) && feature === 'project.manage' && map['project.create']) e = map['project.create'];
  if (!e || !e.enabled) return false;
  if (expired(e.until)) return false;
  return true;
}
