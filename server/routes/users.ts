import { migrateDocflowPermissions } from '../docflowPermissionMigration.js';
import { backfillLegacyIssues } from '../docflowIssue.js';
import type { Express, Request, Response } from 'express';
import { administratorPermission } from '../accessPolicy.js';
import { defaultPermissions } from '../../src/lib/permissions';
import { getPrisma, notifyUser } from '../context.js';
import { explainDbError } from '../dbError.js';
import { randomBytes, scrypt } from 'node:crypto';
import { ensureUserProfileSchema } from '../userProfileSchema.js';
import { ensureDepartmentSchema } from '../departmentsSchema.js';
import { DepartmentError, assertAssignable, ensureRootDepartment, listDepartments, historyRows, type BatchCreated, type BatchUser } from '../departments.js';
import { createImportDepartments, importHistory, resolveRowDepartments, undoImportDepartments } from '../usersImportDepartments.js';
import { mapEmployeeRows, employeeImportName, USER_IMPORT_FIELDS, validateEmployeeImportMatrix, type UserImportMap } from '../usersImport.js';
import { isLegacyBootstrapAdmin, legacyBootstrapMigrationError } from '../legacyIdentity.js';
import { decidePositions, hasAdminKeys, permissionsWithoutAdmin } from '../userPositions.js';
import { positionPermissionsString } from '../positionPermissions.js';
import { extraPositionCodes, isNonPositionCode, stripAdminPermissions } from '../../shared/positions.js';

// Сотрудники, роли и личные настройки уведомлений.
//
// Вынесено из server.ts. Часть вспомогательного кода осталась там (хеширование
// паролей, сброс кэшей сессии и прав) — он нужен и при входе, и при
// восстановлении базы. Чтобы не заводить круговой импорт, эти функции
// передаются один раз при подключении маршрутов.

interface UserDeps {
  hashPassword: (plain: string) => string | Promise<string>;
  /** Сверка пароля с хешем; нужна смене собственного пароля. Без неё (проверки) сравнивается хеш той же функцией */
  verifyPassword?: (plain: string, stored: string | null | undefined) => boolean | Promise<boolean>;
  /** Сбросить кэш прав роли: изменение должно действовать сразу */
  invalidateRolePerms: () => void;
  /** Сбросить кэш сессии пользователя (или всех, если без аргумента) */
  invalidateAuthUser: (userId?: string) => void;
  /** Перечитать список скрывших присутствие: он кэшируется у присутствия */
  refreshHiddenOnline?: () => Promise<void>;
}

let deps: UserDeps = {
  hashPassword: (p) => p,
  invalidateRolePerms: () => {},
  invalidateAuthUser: () => {},
};
type EmployeeImportUndoItem = { kind: 'create'; id: string; after: Record<string, unknown> } | { kind: 'update'; id: string; before: Record<string, unknown>; after: Record<string, unknown> };

function hashImportPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  return new Promise((resolve, reject) => scrypt(String(plain), salt, 64, (error, derived) => {
    if (error) reject(error);
    else resolve(`scrypt$${salt.toString('hex')}$${derived.toString('hex')}`);
  }));
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await work(items[index], index);
    }
  }));
  return results;
}

async function hasEmployeeImportDependencies(tx: any, id: string): Promise<boolean> {
  const [files, folders, markups, messages, membership, ownedGroups, notes] = await Promise.all([
    tx.fileNode.count({ where: { OR: [{ createdById: id }, { updatedById: id }, { ownerId: id }] } }),
    tx.folder.count({ where: { ownerId: id } }),
    tx.pdfMarkup.count({ where: { createdById: id } }),
    tx.chatMessage.count({ where: { OR: [{ senderId: id }, { receiverId: id }] } }),
    tx.chatGroup.findFirst({ where: { members: { some: { id } } }, select: { id: true } }),
    tx.chatGroup.findFirst({ where: { ownerId: id }, select: { id: true } }),
    tx.userNote.count({ where: { ownerId: id } }),
  ]);
  return files > 0 || folders > 0 || markups > 0 || messages > 0 || !!membership || !!ownedGroups || notes > 0;
}

const hashPassword = async (plain: string): Promise<string> => deps.hashPassword(plain);
const verifyPassword = async (plain: string, stored: string | null | undefined): Promise<boolean> =>
  deps.verifyPassword ? !!(await deps.verifyPassword(plain, stored)) : !!stored && (await deps.hashPassword(plain)) === stored;

const MIN_PASSWORD = 8;

/**
 * Логин нового или переименованного сотрудника. Вход обрезает пробелы и
 * сравнивает без регистра, поэтому и здесь: строка, без пробелов по краям,
 * непустая, без «@», не логин владельца и не дубль с точностью до регистра.
 * Раньше POST принимал что угодно (undefined превращался в 'undefined', «Ivan»
 * и «ivan» жили вместе, а логин с пробелом по краям войти уже не мог).
 */
async function checkedSymbol(prisma: any, raw: unknown, exceptId: string | null): Promise<{ ok: true; symbol: string } | { ok: false; status: number; message: string }> {
  if (typeof raw !== 'string') return { ok: false, status: 400, message: 'Укажите табельный номер (логин).' };
  const symbol = raw.trim();
  if (!symbol) return { ok: false, status: 400, message: 'Укажите табельный номер (логин).' };
  if (symbol.length > 64) return { ok: false, status: 400, message: 'Логин не длиннее 64 символов.' };
  if (symbol.includes('@')) return { ok: false, status: 400, message: 'Логин не может содержать символ @.' };
  if (symbol.toLowerCase() === 'flux.owner') return { ok: false, status: 403, message: 'Логин владельца зарезервирован' };
  const all = await prisma.user.findMany({ select: { id: true, symbol: true } });
  if (all.some((u: any) => u.id !== exceptId && String(u.symbol || '').trim().toLowerCase() === symbol.toLowerCase())) {
    return { ok: false, status: 400, message: 'Ошибка: сотрудник с таким табельным номером уже внесен в базу данных!' };
  }
  return { ok: true, symbol };
}

/** Права хранятся строкой JSON-объекта; всё остальное нечитаемо для проверки доступа и ломает экран прав. */
function permissionsError(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let parsed: unknown = value;
  if (typeof value === 'string') { try { parsed = JSON.parse(value); } catch (_) { return 'Права сотрудника заданы некорректно (ожидается JSON-объект).'; } }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? null : 'Права сотрудника заданы некорректно (ожидается JSON-объект).';
}

/** Поля, которые администратор может менять у самого себя: роль, права и срок — только владелец. */
const SELF_EDIT_FIELDS = ['name', 'password', 'currentPassword', 'lastName', 'firstName', 'middleName', 'gender', 'birthDate'] as const;
const invalidateRolePerms = () => deps.invalidateRolePerms();
const invalidateAuthUser = (userId?: string) => deps.invalidateAuthUser(userId);


function parseUserDate(value: unknown): Date | null | undefined {
  if (value === null || value === '' || value === undefined) return null;
  const d = new Date(value as any);
  return isNaN(d.getTime()) ? undefined : d;
}

// ФИО сотрудника: части хранятся отдельно и в именительном падеже, единая
// строка name — производная. Пол определяем по отчеству, если его не указали:
// это надёжнее, чем заставлять выбирать вручную то, что и так однозначно.
function nameParts(src: any): {
  lastName: string; firstName: string; middleName: string;
  name: string; gender: string; birthDate: Date | null;
} {
  const pick = (v: any) => String(v ?? '').trim();
  let lastName = pick(src.lastName);
  let firstName = pick(src.firstName);
  let middleName = pick(src.middleName);
  // Старый формат: пришла одна строка «Раупов Хусрав Хусравович»
  if (!lastName && !firstName && pick(src.name)) {
    const w = pick(src.name).replace(/\s*\(.*\)\s*$/, '').split(/\s+/).filter(Boolean);
    lastName = w[0] || ''; firstName = w[1] || ''; middleName = w.slice(2).join(' ');
  }
  let gender = pick(src.gender).toUpperCase();
  if (gender !== 'M' && gender !== 'F') {
    const m = middleName.toLowerCase();
    gender = /(овна|евна|ична|инична|кызы)$/.test(m) ? 'F'
      : /(ович|евич|ич|оглы|углы|уулу)$/.test(m) ? 'M' : '';
  }
  const birth = parseUserDate(src.birthDate);
  return {
    lastName, firstName, middleName,
    name: [lastName, firstName, middleName].filter(Boolean).join(' '),
    gender,
    birthDate: birth === undefined ? null : birth,
  };
}


// ── Должности сотрудников ───────────────────────────────────────────────────
// Должности (таблица Role) ведёт владелец или администратор с правом
// «Должности: справочник», а не программист: в разных компаниях они
// называются по-разному. Уровень доступа — другое: владелец и администратор
// в справочнике не показываются (строки OWNER и ADMIN остались от старой
// модели). Встроенные должности не удаляются — их использует сама программа.
const grant = (...ids: string[]) =>
  JSON.stringify(Object.fromEntries(ids.map(id => [id, { enabled: true, until: null }])));

// Обычная инженерная работа: вести теги и оборудование, класть файлы,
// отмечать этапы закупки и вести реестр. Опасное (удаление тегов и файлов,
// настройка этапов и стандартов на всю компанию, управление проектами)
// в набор по умолчанию не входит — это выдаёт администратор осознанно.
const ENGINEER_GRANTS = grant(
  'tags.manage', 'dictionaries.manage', 'equipment.import', 'equipment.manage',
  'files.upload', 'procurement.manage', 'docflow.view', 'docflow.edit', 'docflow.issue',
);
// Разработчик подпрограмм Flux Studio: обычная инженерная работа плюс право
// присылать код владельцу. Рабочий канал (module.publish) не выдаётся —
// владелец включает его осознанно.
const DEVELOPER_GRANTS = grant(
  'tags.manage', 'dictionaries.manage', 'equipment.import', 'equipment.manage',
  'files.upload', 'procurement.manage', 'docflow.view', 'docflow.edit', 'docflow.issue', 'module.develop',
);
const MANAGER_GRANTS = grant(
  'project.manage', 'tags.manage', 'dictionaries.manage', 'equipment.import',
  'equipment.manage', 'files.upload', 'files.delete', 'procurement.manage',
  'procurement.setup', 'docflow.view', 'docflow.edit', 'docflow.issue', 'docflow.delete', 'docflow.settings',
);

export const BUILTIN_ROLES = [
  { code: 'OWNER', name: 'Владелец Flux', color: 'slate', icon: 'key-round', level: 0, sortOrder: 0, description: 'Вход только по ключу; доверие, лицензии и обновления', permissions: '{}' },
  { code: 'ADMIN',          name: 'Администратор',     color: 'rose',    icon: 'shield-check', level: 1,  sortOrder: 10, description: 'Работа компании; административные полномочия выдает владелец', permissions: '{}' },
  { code: 'MANAGER',        name: 'Менеджер проектов', color: 'amber',   icon: 'briefcase',    level: 20, sortOrder: 20, description: 'Проекты, закупки, документооборот', permissions: MANAGER_GRANTS },
  { code: 'ENGINEER_VENT',  name: 'Инженер ОВиК',      color: 'sky',     icon: 'airplay',      level: 50, sortOrder: 30, description: 'Вентиляция и кондиционирование', permissions: ENGINEER_GRANTS },
  { code: 'ENGINEER_AUTO',  name: 'Инженер КИПиА',     color: 'emerald', icon: 'cpu',          level: 50, sortOrder: 40, description: 'Автоматика и приборы', permissions: ENGINEER_GRANTS },
  { code: 'MODULE_DEVELOPER', name: 'Разработчик',      color: 'violet',  icon: 'code',         level: 50, sortOrder: 50, description: 'Пишет подпрограммы для Flux Studio; код выпускает владелец', permissions: DEVELOPER_GRANTS },
];

export async function seedRoles() {
  const prisma = getPrisma();
  try {
    for (const r of BUILTIN_ROLES) {
      const existing = await prisma.role.findUnique({ where: { code: r.code } }).catch(() => null);
      if (!existing) {
        await prisma.role.create({ data: { ...r, isSystem: true } }).catch(() => {});
        continue;
      }
      // Роль завели в предыдущей версии, когда прав у ролей ещё не было.
      // Проставляем набор по умолчанию только пустым: если администратор уже
      // настроил доступ, трогать его нельзя.
      const empty = !existing.permissions || existing.permissions === '{}' || existing.permissions === 'null';
      if (empty && r.permissions !== '{}') {
        await prisma.role.update({ where: { id: existing.id }, data: { permissions: r.permissions } }).catch(() => {});
      }
    }
    // Удаление в ВДР раньше давала сама должность MANAGER, теперь — право vdr.delete.
    // Роль менеджера в базе уже настроена и набор по умолчанию её не касается, поэтому
    // один раз выдаём ей это право, чтобы менеджеры не потеряли удаление молча.
    // Отметка нужна, чтобы снятое администратором право не возвращалось при каждом запуске.
    const marker = 'migration:vdr.delete-for-manager';
    if (!(await prisma.appSetting.findFirst({ where: { key: marker } }).catch(() => ({ id: 'x' })))) {
      const mgr = await prisma.role.findUnique({ where: { code: 'MANAGER' } }).catch(() => null);
      if (mgr) {
        let map: Record<string, any> = {};
        try { map = JSON.parse(mgr.permissions || '{}') || {}; } catch (_) { map = {}; }
        if (!map['vdr.delete']) {
          map['vdr.delete'] = { enabled: true, until: null };
          await prisma.role.update({ where: { id: mgr.id }, data: { permissions: JSON.stringify(map) } });
        }
        await prisma.appSetting.create({ data: { key: marker, value: '1' } });
      }
    }
    await migrateDocflowPermissions(prisma);
    await backfillLegacyIssues(prisma).catch(() => 0); // старые выпуски без ключа, см. server/docflowIssue.ts
    invalidateRolePerms();
  } catch (_) { /* старая база без таблицы ролей — подхватится после синхронизации схемы */ }
}

// Разбор ФИО на части у профилей, заведённых до раздельного хранения.
export async function backfillNameParts() {
  const prisma = getPrisma();
  try {
    const users = await prisma.user.findMany({ where: { lastName: '' } }).catch(() => []);
    for (const u of users as any[]) {
      const p = nameParts({ name: u.name });
      if (!p.lastName) continue;
      await prisma.user.update({
        where: { id: u.id },
        data: { lastName: p.lastName, firstName: p.firstName, middleName: p.middleName, gender: p.gender },
      }).catch(() => {});
    }
  } catch (_) {}
}

/** Уровни доступа, администраторские права и видимость «в сети» остаются у владельца. */
async function isOwnerRequest(req: Request): Promise<boolean> {
  return (req as any).authUser?.role === 'OWNER';
}

function administrativeGrants(raw: any): boolean {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return !!parsed && typeof parsed === 'object' && Object.keys(parsed).some(key => key.startsWith('admin.'));
  } catch (_) { return true; }
}

/** Куда класть новые подразделения из файла: выбранное действующее или корень */
function importParent(raw: unknown, list: Array<{ id: string; archivedAt?: unknown }>, rootId: string): string {
  const id = String(raw || '');
  return list.some((d) => d.id === id && !d.archivedAt) ? id : rootId;
}

export function registerUserRoutes(app: Express, d: UserDeps): void {
  deps = d;
  // Справочник должностей меняет владелец или администратор с правом «Должности: справочник».
  // Права admin.* в должности не хранятся, поэтому через неё доступ не выдать (см. cleanPositionPermissions)
  app.use('/api/roles', (req, res, next) => {
    if (['GET', 'HEAD'].includes(req.method) || administratorPermission((req as any).authUser, 'admin.roles.manage')) return next();
    return res.status(403).json({ message: 'Должности ведёт владелец или администратор с правом «Должности: справочник».' });
  });
  app.use('/api/users', async (_req, res, next) => {
    try { await ensureDepartmentSchema(getPrisma()); next(); }
    catch (error: any) { res.status(503).json({ message: error?.message || 'Не удалось подготовить схему профиля сотрудника' }); }
  });

  // Preview is read-only. Apply revalidates the same payload, then commits all
  // selected rows together. Passwords are never logged or persisted in plain text.
  app.post('/api/users/import/preview', async (req: Request, res: Response) => {
    try {
      const actor = (req as any).authUser;
      const mode = req.body?.mode === 'update' ? 'update' : 'create';
      if (mode === 'create' ? !administratorPermission(actor, 'admin.users.create') : !administratorPermission(actor, 'admin.users.manage')) return res.status(403).json({ message: 'Нет права выполнять это действие' });
      const rows = req.body?.rows;
      const mapping = req.body?.mapping as UserImportMap;
      if (!validateEmployeeImportMatrix(rows)) return res.status(400).json({ message: 'Файл должен содержать от 1 до 5000 строк данных и иметь допустимый размер таблицы' });
      if (typeof mapping?.symbol !== 'number' || (mode === 'create' && !(typeof mapping?.name === 'number' || (typeof mapping?.lastName === 'number' && typeof mapping?.firstName === 'number')))) return res.status(400).json({ message: mode === 'create' ? 'Назначьте колонки логина и ФИО' : 'Назначьте колонку логина' });
      const prisma = getPrisma();
      await ensureDepartmentSchema(prisma);
      const [existing, roles] = await Promise.all([prisma.user.findMany({ select: { id: true, symbol: true, role: true, name: true, lastName: true, firstName: true, middleName: true, gender: true, birthDate: true, password: true, isActive: true, validUntil: true, permissions: true, position: true, department: true, departmentId: true, email: true, positionCode: true, extraPositions: true } }), prisma.role.findMany({ select: { code: true, name: true } })]);
      // Импорт назначает только должность: уровень «администратор» владелец выдаёт в карточке
      const positionRows = (roles as any[]).filter((r) => !isNonPositionCode(r.code) && r.code !== 'SERVICE');
      const validRoles = new Set(positionRows.map((r: any) => r.code));
      const defaultRole = String(req.body?.defaultRole || 'ENGINEER_VENT').toUpperCase();
      if (!validRoles.has(defaultRole)) return res.status(400).json({ message: 'Выберите существующую должность по умолчанию' });
      const root = await ensureRootDepartment(prisma);
      const deptList = await listDepartments(prisma);
      const mapped = mapEmployeeRows(rows, mapping, existing, defaultRole, mode, actor.role, positionRows);
      // Подразделение сопоставляется со справочником; чего нет — предлагается создать галочкой
      const depts = resolveRowDepartments(mapped, deptList, importParent(req.body?.departmentParentId, deptList, root.id));
      const result = mapped.map((row) => {
        if (!row.error && row.values.role && !validRoles.has(row.values.role)) row.error = `Неизвестная должность: ${row.values.role}`;
        const { password, ...values } = row.values;
        return { ...row, values, passwordProvided: !!password, dept: depts.perRow.get(row.row) };
      });
      res.json({ rows: result, fields: USER_IMPORT_FIELDS, departmentsToCreate: depts.toCreate, rootId: root.id });
    } catch (error: any) { res.status(500).json({ message: error?.message || 'Не удалось проверить файл' }); }
  });

  app.post('/api/users/import/apply', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const actor = (req as any).authUser;
      const mode = req.body?.mode === 'update' ? 'update' : 'create';
      if (mode === 'create' ? !administratorPermission(actor, 'admin.users.create') : !administratorPermission(actor, 'admin.users.manage')) return res.status(403).json({ message: 'Нет права выполнять это действие' });
      const { rows, mapping, selected, defaultRole } = req.body || {};
      if (!Array.isArray(selected) || !selected.length || selected.length > 5000 || !validateEmployeeImportMatrix(rows)) return res.status(400).json({ message: 'Выберите корректный список строк (до 5000)' });
      await ensureDepartmentSchema(prisma);
      const [existing, roles] = await Promise.all([prisma.user.findMany({ select: { id: true, symbol: true, role: true, name: true, lastName: true, firstName: true, middleName: true, gender: true, birthDate: true, password: true, isActive: true, validUntil: true, permissions: true, position: true, department: true, departmentId: true, email: true, positionCode: true, extraPositions: true } }), prisma.role.findMany({ select: { code: true, name: true } })]);
      const positionRows = (roles as any[]).filter((r) => !isNonPositionCode(r.code) && r.code !== 'SERVICE');
      const validRoles = new Set(positionRows.map((r: any) => r.code));
      const preview = mapEmployeeRows(rows, mapping || {}, existing, String(defaultRole || 'ENGINEER_VENT').toUpperCase(), mode, actor.role, positionRows);
      const chosen = preview.filter((r) => selected.includes(r.row));
      resolveRowDepartments(chosen, await listDepartments(prisma)); // неоднозначное подразделение — ошибка строки, как в предпросмотре
      if (chosen.length !== selected.length || chosen.some((r) => r.error)) return res.status(409).json({ message: 'Список изменился или содержит ошибки. Повторите предпросмотр.' });
      for (const row of chosen) {
        if ((row.values.role && !validRoles.has(row.values.role)) || row.values.role === 'OWNER' || row.values.role === 'ADMIN') return res.status(403).json({ message: 'Импорт содержит должность, которую нельзя назначить' });
        if (row.values.symbol.trim().toLowerCase() === 'flux.owner') return res.status(403).json({ message: 'Логин владельца зарезервирован' });
      }
      const preparedPasswords = new Map<number, { plain: string; hash: string }>();
      if (mode === 'create') {
        const prepared = await mapWithConcurrency(chosen, 4, async (row) => {
          const plain = row.values.password || randomBytes(18).toString('base64url');
          return { row: row.row, plain, hash: await hashImportPassword(plain) };
        });
        for (const item of prepared) preparedPasswords.set(item.row, { plain: item.plain, hash: item.hash });
      }
      const credentialRows: Array<{ symbol: string; password: string }> = [];
      const undoItems: EmployeeImportUndoItem[] = [];
      const historyUsers: BatchUser[] = [];
      let createdDepartments: BatchCreated[] = [];
      const undoToken = randomBytes(24).toString('base64url');
      const expiresAt = Date.now() + 60 * 60 * 1000;
      await prisma.$transaction(async (tx: any) => {
        // Reload inside the write transaction: the confirmation may have been
        // open while another administrator changed the employee list.
        const currentUsers = await tx.user.findMany({ select: { id: true, symbol: true, role: true, name: true, lastName: true, firstName: true, middleName: true, gender: true, birthDate: true, password: true, isActive: true, validUntil: true, permissions: true, position: true, department: true, departmentId: true, email: true, positionCode: true, extraPositions: true } });
        const currentRoles = (await tx.role.findMany({ select: { code: true, name: true } })).filter((r: any) => !isNonPositionCode(r.code) && r.code !== 'SERVICE');
        const currentRoleCodes = new Set(currentRoles.map((r: any) => r.code));
        const currentRows = mapEmployeeRows(rows, mapping || {}, currentUsers, String(defaultRole || 'ENGINEER_VENT').toUpperCase(), mode, actor.role, currentRoles);
        const currentChosen = currentRows.filter((r) => selected.includes(r.row));
        if (currentChosen.length !== selected.length || currentChosen.some((r) => r.error || (r.values.role && !currentRoleCodes.has(r.values.role)) || r.values.role === 'OWNER' || r.values.role === 'ADMIN')) throw Object.assign(new Error('Список сотрудников или должностей изменился после предпросмотра. Повторите предпросмотр.'), { status: 409 });
        // Подразделения из файла: совпавшие берутся, отмеченные галочкой создаются тут же, в этой транзакции
        const deptRoot = await ensureRootDepartment(tx);
        const deptList = await listDepartments(tx);
        const createKeys = new Set<string>(Array.isArray(req.body?.createDepartments) ? req.body.createDepartments.map(String) : []);
        const deptPlan = await createImportDepartments(tx, currentChosen, deptList, createKeys, importParent(req.body?.departmentParentId, deptList, deptRoot.id), String(actor.id));
        createdDepartments = deptPlan.created;
        const oldBatches = await tx.appSetting.findMany({ where: { key: { startsWith: 'employee_import_batch:' } }, select: { id: true, value: true } });
        for (const old of oldBatches) {
          try { if (JSON.parse(old.value)?.expiresAt < Date.now()) await tx.appSetting.delete({ where: { id: old.id } }); } catch { /* malformed expired snapshots are safe to discard */ await tx.appSetting.delete({ where: { id: old.id } }); }
        }
        for (const row of currentChosen) {
          const v = row.values;
          const names = employeeImportName(row);
          const existingUser = currentUsers.find((u: any) => u.id === row.existingId);
          if (mode === 'create') {
            const password = preparedPasswords.get(row.row)!;
            const user = await tx.user.create({ data: {
              symbol: v.symbol, ...names, gender: '', birthDate: null,
              role: v.role, positionCode: v.role, password: password.hash, isActive: true,
              permissions: JSON.stringify(defaultPermissions()),
              position: v.position || null, department: v.department || null, email: v.email || null,
              departmentId: deptPlan.target.get(row.row) ?? null,
            }, select: { id: true, symbol: true, name: true, lastName: true, firstName: true, middleName: true, gender: true, birthDate: true, role: true, password: true, isActive: true, validUntil: true, permissions: true, position: true, department: true, departmentId: true, email: true, positionCode: true, extraPositions: true, signatureImage: true, signatureHeightMm: true, hideOnline: true, lastLoginAt: true, createdAt: true } });
            credentialRows.push({ symbol: user.symbol, password: password.plain });
            if (user.departmentId) historyUsers.push({ id: user.id, from: null, to: user.departmentId });
            const { id, ...after } = user;
            undoItems.push({ kind: 'create', id, after });
          } else if (existingUser) {
            const data: any = {};
            // Empty cells carry no instruction: existing profile values and passwords remain intact.
            if (v.symbol) data.symbol = v.symbol;
            if (names.name) Object.assign(data, names);
            if (v.role) {
              // Основная должность; администратору уровень не трогаем, он остаётся 'ADMIN'
              data.positionCode = v.role;
              if (existingUser.role !== 'ADMIN') data.role = v.role;
              const extras = extraPositionCodes(existingUser);
              if (extras.includes(v.role)) data.extraPositions = extras.length > 1 ? JSON.stringify(extras.filter((c) => c !== v.role)) : null;
            }
            if (v.position) data.position = v.position;
            if (v.department) data.department = v.department;
            if (v.email) data.email = v.email;
            const newDept = deptPlan.target.get(row.row);
            if (newDept && newDept !== (existingUser.departmentId ?? null)) {
              data.departmentId = newDept;
              historyUsers.push({ id: existingUser.id, from: existingUser.departmentId ?? null, to: newDept });
            }
            const before = Object.fromEntries(Object.keys(data).map((key) => [key, existingUser[key]]));
            const changed = await tx.user.updateMany({ where: { id: existingUser.id, ...before }, data });
            if (changed.count !== 1) throw Object.assign(new Error('Сотрудник изменился во время импорта. Повторите предпросмотр.'), { status: 409 });
            const after = Object.fromEntries(Object.keys(data).map((key) => [key, data[key]]));
            undoItems.push({ kind: 'update', id: existingUser.id, before, after });
          }
        }
        if (historyUsers.length) await tx.userDepartmentHistory.createMany({ data: importHistory(historyUsers, String(actor.id), undoToken) });
        await tx.appSetting.create({ data: { key: `employee_import_batch:${undoToken}`, userId: String(actor.id), value: JSON.stringify({ actorId: String(actor.id), expiresAt, items: undoItems, createdDepartments, undone: false }) } });
      }, { maxWait: 10000, timeout: 60000 });
      invalidateAuthUser();
      res.json({ imported: chosen.length, credentials: mode === 'create' ? credentialRows : [], undoToken, departmentsCreated: createdDepartments.length });
    } catch (error: any) {
      const conflict = error?.status === 409 || ['P2002', 'P2034', 'P2028'].includes(error?.code);
      res.status(conflict ? 409 : 500).json({ message: conflict
        ? 'Список сотрудников изменился во время импорта. Повторите предпросмотр.'
        : 'Импорт не выполнен. Изменения партии не сохранены.' });
    }
  });

  app.post('/api/users/import/undo', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const actor = (req as any).authUser;
      if (!administratorPermission(actor, 'admin.users.manage') && !administratorPermission(actor, 'admin.users.create')) return res.status(403).json({ message: 'Нет права отменять импорт' });
      const token = String(req.body?.undoToken || '');
      if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return res.status(404).json({ message: 'Партия отмены не найдена' });
      const batchRow = await prisma.appSetting.findFirst({ where: { key: `employee_import_batch:${token}`, userId: String(actor.id) } });
      if (!batchRow) return res.status(404).json({ message: 'Партия отмены не найдена' });
      const batch = JSON.parse(batchRow.value);
      if (batch.undone || batch.expiresAt < Date.now() || !Array.isArray(batch.items)) return res.status(404).json({ message: 'Срок отмены истёк или импорт уже отменён' });
      if (batch.items.some((item: EmployeeImportUndoItem) => item.kind === 'update') && !administratorPermission(actor, 'admin.users.manage')) return res.status(403).json({ message: 'Нет права отменять обновление сотрудников' });
      if (batch.items.some((item: EmployeeImportUndoItem) => item.kind === 'create') && !administratorPermission(actor, 'admin.users.create')) return res.status(403).json({ message: 'Нет права отменять создание сотрудников' });
      await prisma.$transaction(async (tx: any) => {
        for (const item of batch.items) {
          const row = await tx.user.findUnique({ where: { id: item.id } });
          if (!row) throw Object.assign(new Error('Сотрудник изменён или удалён после импорта; отмена не выполнена'), { status: 409 });
          const expected = item.after;
          for (const [key, value] of Object.entries(expected)) {
            if (JSON.stringify(row[key] ?? null) !== JSON.stringify(value ?? null)) throw Object.assign(new Error('Данные изменились после импорта; отмена не выполнена'), { status: 409 });
          }
          if (item.kind === 'create' && await hasEmployeeImportDependencies(tx, item.id)) throw Object.assign(new Error('У импортированного сотрудника появились связанные данные; отмена не затронула партию.'), { status: 409 });
        }
        const claim = await tx.appSetting.updateMany({ where: { id: batchRow.id, value: batchRow.value }, data: { value: JSON.stringify({ ...batch, undone: true }) } });
        if (claim.count !== 1) throw Object.assign(new Error('Импорт уже отменяют или его состояние изменилось'), { status: 409 });
        for (const item of [...batch.items].reverse()) {
          if (item.kind === 'create') {
            const deleted = await tx.user.deleteMany({ where: { id: item.id, ...item.after } });
            if (deleted.count !== 1) throw Object.assign(new Error('Профиль изменился во время отмены. Отмена не выполнена.'), { status: 409 });
          } else {
            const restored = await tx.user.updateMany({ where: { id: item.id, ...item.after }, data: item.before });
            if (restored.count !== 1) throw Object.assign(new Error('Профиль изменился во время отмены. Отмена не выполнена.'), { status: 409 });
          }
        }
        // Подразделения партии: история, обратные переводы и созданные в файле подразделения
        await undoImportDepartments(tx, token, String(actor.id), batch.items, batch.createdDepartments || []);
      }, { maxWait: 10000, timeout: 60000 });
      invalidateAuthUser();
      res.json({ success: true, restored: batch.items.length });
    } catch (error: any) {
      res.status(error?.status || 409).json({ message: error?.message || 'Отмена не выполнена: профиль связан с другими данными' });
    }
  });

  // ── Подпись сотрудника ────────────────────────────────────────────────────
  // Подпись — как личная печать: свою ставит человек сам, чужую трогает только
  // тот, кому доверено управление сотрудниками. Поэтому отдельный маршрут, а не
  // поле в общем обновлении профиля: там правила доступа другие.
  app.get('/api/users/:id/signature', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      // Изображение подписи — то, чем заверяют выпущенные бланки. Видеть его
      // должны владелец и тот, кто им управляет, а не любой вошедший: иначе
      // чужую подпись брали отсюда и ставили куда угодно
      const me = (req as any).authUser;
      const own = me && me.id === String(req.params.id);
      if (!own && !(me?.role === 'ADMIN' || (await isOwnerRequest(req)))) {
        return res.status(403).json({ error: 'Чужую подпись смотреть нельзя' });
      }
      const u = await prisma.user.findUnique({
        where: { id: String(req.params.id) },
        select: { signatureImage: true, signatureHeightMm: true },
      });
      if (!u) return res.status(404).json({ error: 'Сотрудник не найден' });
      res.json({ signature: u.signatureImage || null, signatureHeightMm: u.signatureHeightMm ?? 8 });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.put('/api/users/:id/signature', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const me = (req as any).authUser;
      const id = String(req.params.id);
      if (!me) return res.status(401).json({ error: 'Требуется вход' });

      const protectedUser = await prisma.user.findUnique({ where: { id }, select: { role: true } });
      if (protectedUser?.role === 'OWNER') return res.status(403).json({ error: 'Профиль владельца защищен' });
      const isSelf = me.id === id;
      const canManage = administratorPermission(me, 'admin.users.manage');
      if (!isSelf && !canManage) {
        return res.status(403).json({ error: 'Чужую подпись менять нельзя' });
      }

      const raw = req.body?.signatureImage;
      let image: string | null = null;
      if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
        const str = String(raw);
        // Принимаем только картинку, вложенную в сам запрос: ссылка на чужой
        // адрес утянула бы документ в сеть при каждой печати
        if (!/^data:image\/(png|jpeg|webp);base64,/.test(str)) {
          return res.status(400).json({ error: 'Подпись должна быть картинкой PNG, JPG или WebP' });
        }
        // 1,5 МБ хватает с большим запасом: после обрезки и уменьшения
        // подпись весит десятки килобайт
        if (str.length > 1_500_000) {
          return res.status(400).json({ error: 'Картинка подписи слишком большая' });
        }
        image = str;
      }

      const mm = Number(req.body?.signatureHeightMm);
      const heightMm = Number.isFinite(mm) ? Math.max(3, Math.min(30, Math.round(mm))) : 8;

      const updated = await prisma.user.update({
        where: { id },
        data: { signatureImage: image, signatureHeightMm: heightMm },
        select: { id: true, signatureImage: true, signatureHeightMm: true },
      });
      invalidateAuthUser(id);
      res.json({ signature: updated.signatureImage, signatureHeightMm: updated.signatureHeightMm });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });


app.get('/api/users', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
    });
    // Сервисные учётные записи (Flux Guide) — не сотрудники: в реестр людей
    // и список собеседников они не попадают (F-ACL-09)
    const visible = (users as any[]).filter((u) => u.role !== 'SERVICE');
    const roles = await prisma.role.findMany().catch(() => [] as any[]);
    const byCode: Record<string, string> = {};
    for (const r of roles as any[]) byCode[r.code] = r.permissions || '{}';
    const positionGrants = new Map<string, string | null>();
    for (const u of visible) positionGrants.set(u.id, await positionPermissionsString(u, async (code) => byCode[code] ?? null));
    // Не отдаём хеши паролей наружу; права роли прикладываем, чтобы в карточке
    // было видно, что человеку дано должностью, а что лично.
    //
    // Картинку подписи в списке не отдаём: список тянут и чат, и выбор
    // исполнителя, и карточки — при трёх десятках сотрудников это лишний
    // мегабайт на каждый запрос. Отдаём только признак «подпись есть»,
    // а саму картинку — отдельным запросом, когда её собрались смотреть.
    // Скрывший присутствие не должен просвечивать через этот список: ни сам
    // признак скрытности (иначе «скрыт» становится видимым состоянием), ни
    // время последнего входа — оно отвечает на тот же вопрос, что и зелёная
    // точка. Себе человек виден полностью.
    const meId = String((req as any).authUser?.id || '');
    const ownerView = (req as any).authUser?.role === 'OWNER';
    res.setHeader('Cache-Control', 'no-store');
    res.json(visible.map(({ password, signatureImage, hideOnline, ...u }) => ({
      ...u,
      ...(ownerView && isLegacyBootstrapAdmin(u) ? { legacyBootstrap: true } : {}),
      lastLoginAt: hideOnline && u.id !== meId ? null : u.lastLoginAt,
      rolePermissions: positionGrants.get(u.id) || '{}',
      hasSignature: !!signatureImage,
    })));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/users', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  try {
    const actor = (req as any).authUser;
    if (!administratorPermission(actor, 'admin.users.create')) return res.status(403).json({ message: 'Нет права создавать сотрудников' });
    const { password } = req.body;
    // Нечитаемые права отвергаются первыми: иначе проверка «не выдаёт ли он права администратора» отвечала бы 403 на мусор
    const unreadablePermissions = permissionsError(req.body.permissions);
    if (unreadablePermissions) return res.status(400).json({ message: unreadablePermissions });
    if (String(req.body.symbol || '').trim().toLowerCase() === 'flux.owner') return res.status(403).json({ message: 'Логин владельца зарезервирован' });
    if (String(req.body.role || '').trim().toUpperCase() === 'OWNER') return res.status(403).json({ message: 'Профиль владельца создается только при входе по ключу' });
    if (actor.role !== 'OWNER' && administrativeGrants(req.body.permissions)) return res.status(403).json({ message: 'Администратора и его права назначает только владелец' });
    // Должность обязательна; уровень «администратор» назначает только владелец
    const decision = await decidePositions(prisma, req.body, null, actor.role === 'OWNER');
    if (decision.ok === false) return res.status(decision.status).json({ message: decision.message });
    if ('unchanged' in decision) return res.status(400).json({ message: 'Укажите основную должность сотрудника.' });
    // ФИО приходит по частям; единая строка name остаётся производной —
    // её показывают старые экраны и печатают документы.
    const parts = nameParts(req.body);
    const name = parts.name || String(req.body.name || '').trim();
    if (!name) {
      return res.status(400).json({ message: 'Укажите фамилию и имя сотрудника.' });
    }
    const login = await checkedSymbol(prisma, req.body.symbol, null);
    if (login.ok === false) {
      return res.status(login.status).json({ ...(login.status === 400 && /уже внесен/.test(login.message) ? { code: 'P2002' } : {}), message: login.message });
    }
    const symbol = login.symbol;

    const { validUntil, isActive, permissions } = req.body;
    // Срок и права разбираются до записи: мусор — явная ошибка, а не Invalid Date из Prisma
    const createdUntil = parseUserDate(validUntil);
    if (createdUntil === undefined) return res.status(400).json({ message: 'Некорректная дата срока действия профиля.' });
    if (typeof password === 'string' && password && password.length < MIN_PASSWORD) return res.status(400).json({ message: `Пароль не короче ${MIN_PASSWORD} символов.` });
    // Подразделение: одно, из справочника; без него человек остаётся «без подразделения»
    const departmentId = req.body.departmentId ? String(req.body.departmentId) : null;
    if (departmentId) await assertAssignable(prisma, departmentId);
    const passwordHash = await hashPassword(String(password || randomBytes(18).toString('base64url')));
    // Профиль и первая запись истории подразделения — одним действием: иначе сбой
    // между ними оставлял человека в подразделении без истории
    const created = await prisma.$transaction(async (tx: any) => { const newUser = await tx.user.create({
      data: {
        departmentId,
        symbol,
        name,
        lastName: parts.lastName,
        firstName: parts.firstName,
        middleName: parts.middleName,
        gender: parts.gender,
        birthDate: parts.birthDate,
        role: decision.role,
        positionCode: decision.positionCode,
        extraPositions: decision.extraPositions,
        password: passwordHash,
        isActive: typeof isActive === 'boolean' ? isActive : true,
        validUntil: createdUntil,
        // По умолчанию сотруднику доступно всё, кроме управления проектами
        // (src/lib/permissions.ts): начинать с нуля значило, что новый человек
        // первый день не может ничего и ходит к администратору за каждой
        // галочкой
        // Полномочия admin.* у сотрудника не хранятся — они есть только у администратора
        permissions: permissions
          ? (decision.level === 'ADMIN' ? (typeof permissions === 'string' ? permissions : JSON.stringify(permissions)) : permissionsWithoutAdmin(permissions))
          : JSON.stringify(defaultPermissions()),
      }
    });
    if (departmentId) await tx.userDepartmentHistory.create({ data: { userId: newUser.id, fromId: null, toId: departmentId, by: String(actor.id), reason: 'Создание сотрудника' } });
    return newUser; });
    const { password: _pw, ...safeNewUser } = created as any;
    res.json(safeNewUser);
  } catch (error: any) {
    if (error instanceof DepartmentError) return res.status(error.status).json({ message: error.message, error: error.message });
    // Два одновременных создания с одним логином: проверка дубля прошла у обоих, уникальный индекс — у одного
    if (error?.code === 'P2002') return res.status(400).json({ code: 'P2002', message: 'Ошибка: сотрудник с таким табельным номером уже внесен в базу данных!' });
    res.status(500).json({ error: error.message });
  }
});

// Обновление профиля сотрудника: роль, пароль, активность, срок действия
app.put('/api/users/:id', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  try {
    const { id } = req.params;
    const actor = (req as any).authUser;
    // Администратор правит у себя только имя, пол, дату рождения и пароль. Раньше
    // он упирался в «администратора меняет только владелец» даже на собственном
    // профиле, а срез тела делался лишь для не-администраторов (server.ts).
    // Срез здесь, а не только в шлюзе: правило должно держаться без него.
    const selfAdmin = actor?.role === 'ADMIN' && actor.id === id;
    if (selfAdmin) req.body = Object.fromEntries(SELF_EDIT_FIELDS.map((key) => [key, req.body?.[key]]).filter(([, value]) => value !== undefined));
    const { name, role, password, isActive, validUntil, symbol, permissions } = req.body;

    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) {
      return res.status(404).json({ success: false, message: 'Сотрудник не найден в базе данных.' });
    }

    if (permissions !== undefined) {
      const unreadable = permissionsError(permissions);
      if (unreadable) return res.status(400).json({ success: false, message: unreadable });
    }
    const legacyBootstrap = isLegacyBootstrapAdmin(target);
    if (legacyBootstrap) {
      // Explicit owner-authorized migration keeps the row id and all related
      // records intact while replacing the blocked login credentials.
      const migrationError = legacyBootstrapMigrationError(actor?.role, target.symbol, symbol, password);
      if (migrationError) return res.status(actor?.role === 'OWNER' ? 400 : 403).json({ message: migrationError });
      const migrated = await checkedSymbol(prisma, symbol, id);
      if (migrated.ok === false) return res.status(migrated.status).json({ message: migrated.status === 400 && /уже внесен/.test(migrated.message) ? 'Такой логин уже занят другим профилем' : migrated.message });
    }
    if (target.role === 'OWNER') return res.status(403).json({ message: 'Профиль владельца защищен; обычный маршрут его не изменяет' });
    if (String(role ?? '').trim().toUpperCase() === 'OWNER') return res.status(403).json({ message: 'Роль владельца не назначается через сотрудников' });
    if (actor?.role !== 'OWNER' && !selfAdmin && (target.role === 'ADMIN' || String(role ?? '').trim().toUpperCase() === 'ADMIN' || req.body.accessLevel === 'ADMIN' || administrativeGrants(permissions))) return res.status(403).json({ message: 'Администратора и его права меняет только владелец' });
    if (actor?.id !== id && !administratorPermission(actor, 'admin.users.manage')) return res.status(403).json({ message: 'Нет права управлять сотрудниками' });
    if (actor?.role !== 'OWNER' && actor?.role !== 'ADMIN' && (role !== undefined || permissions !== undefined || isActive !== undefined || validUntil !== undefined || symbol !== undefined)) return res.status(403).json({ message: 'Сотрудник не меняет собственные права доступа' });
    // Должности и уровень доступа: обязательная основная должность, дополнительные без дублей;
    // «администратор» — уровень, его назначает и снимает только владелец
    const decision = await decidePositions(prisma, req.body, target, actor?.role === 'OWNER');
    if (decision.ok === false) return res.status(decision.status).json({ success: false, message: decision.message });

    if (typeof symbol === 'string' && symbol.trim().toLowerCase() === 'flux.owner') return res.status(403).json({ message: 'Логин владельца зарезервирован' });

    // Смена логина (табельного номера) — те же правила, что при создании, и уникальность без учёта регистра
    let nextSymbol: string | null = null;
    if (typeof symbol === 'string' && symbol.trim() && symbol.trim() !== target.symbol) {
      const checked = await checkedSymbol(prisma, symbol, id);
      if (checked.ok === false) {
        return res.status(checked.status).json({ success: false, message: checked.status === 400 && /уже внесен/.test(checked.message) ? 'Такой табельный номер (логин) уже занят другим сотрудником.' : checked.message });
      }
      nextSymbol = checked.symbol;
    }
    // Свой пароль меняют, зная текущий: украденная сессия не должна давать вечный вход.
    // Чужой пароль администратор задаёт без старого (сброс забытого). Хеш считается
    // раньше, чем что-либо пишется.
    let nextPasswordHash: string | null = null;
    if (typeof password === 'string' && password) {
      if (actor?.id === id) {
        if (password.length < MIN_PASSWORD) return res.status(400).json({ success: false, message: `Пароль не короче ${MIN_PASSWORD} символов.` });
        const current = req.body.currentPassword;
        if (typeof current !== 'string' || !current || !(await verifyPassword(current, target.password))) {
          return res.status(403).json({ success: false, message: 'Для смены своего пароля введите текущий пароль.' });
        }
      }
      else if (password.length < MIN_PASSWORD) return res.status(400).json({ success: false, message: `Пароль не короче ${MIN_PASSWORD} символов.` });
      nextPasswordHash = await hashPassword(password);
    }

    // Разбор срока действия: null/'' — снять срок, отсутствие поля — не трогать,
    // мусор — явная ошибка (иначе Invalid Date уронил бы prisma.update)
    let parsedValidUntil: Date | null = null;
    if (validUntil !== undefined) {
      const p = parseUserDate(validUntil);
      if (p === undefined) {
        return res.status(400).json({ success: false, message: 'Некорректная дата срока действия профиля.' });
      }
      parsedValidUntil = p;
    }

    // Защита от самоблокировки: нельзя отключить/ограничить последнего активного администратора
    const willDeactivate = isActive === false || (parsedValidUntil !== null && parsedValidUntil.getTime() < Date.now());
    if (target.role === 'ADMIN' && willDeactivate) {
      const activeAdmins = await prisma.user.count({
        where: { role: { in: ['ADMIN', 'OWNER'] }, isActive: true, id: { not: id } }
      });
      if (activeAdmins === 0) {
        return res.status(400).json({ success: false, message: 'Нельзя отключить последнего активного администратора — иначе никто не сможет управлять системой.' });
      }
    }

    const data: any = {};
    // ФИО: если пришли части — пересобираем и единую строку, чтобы два
    // представления одного имени не разъезжались.
    if (req.body.lastName !== undefined || req.body.firstName !== undefined || req.body.middleName !== undefined) {
      const p = nameParts({ ...target, ...req.body });
      data.lastName = p.lastName; data.firstName = p.firstName; data.middleName = p.middleName;
      if (p.name) data.name = p.name;
      data.gender = p.gender;
    } else if (typeof name === 'string' && name.trim()) {
      data.name = name.trim();
    }
    if (req.body.gender !== undefined) data.gender = req.body.gender === 'F' ? 'F' : req.body.gender === 'M' ? 'M' : '';
    if (req.body.birthDate !== undefined) {
      const b = parseUserDate(req.body.birthDate);
      if (b === undefined) return res.status(400).json({ success: false, message: 'Некорректная дата рождения.' });
      data.birthDate = b;
    }
    if (nextSymbol) data.symbol = nextSymbol;
    if (!('unchanged' in decision)) {
      data.role = decision.role; data.positionCode = decision.positionCode; data.extraPositions = decision.extraPositions;
    }
    if (nextPasswordHash) data.password = nextPasswordHash;
    if (typeof isActive === 'boolean') data.isActive = isActive;
    if (validUntil !== undefined) data.validUntil = parsedValidUntil;
    if (permissions !== undefined) {
      data.permissions = permissions === null ? null
        : (typeof permissions === 'string' ? permissions : JSON.stringify(permissions));
    }
    // Полномочия admin.* есть только у администратора: сотрудник, в том числе снятый с этого уровня, их не сохраняет
    if (decision.level !== 'ADMIN') {
      const current = data.permissions !== undefined ? data.permissions : target.permissions;
      if (hasAdminKeys(current)) data.permissions = permissionsWithoutAdmin(current);
    }

    // Подразделение меняет только тот, кто управляет сотрудниками; перевод пишется в историю вместе с правкой
    let deptChange: BatchUser | null = null;
    if (req.body.departmentId !== undefined) {
      if (!administratorPermission(actor, 'admin.users.manage')) return res.status(403).json({ message: 'Нет права переводить сотрудников между подразделениями' });
      const next = req.body.departmentId ? String(req.body.departmentId) : null;
      if (next !== (target.departmentId ?? null)) {
        if (next) await assertAssignable(prisma, next);
        data.departmentId = next;
        deptChange = { id, from: target.departmentId ?? null, to: next };
      }
    }
    const permsChanged = permissions !== undefined && (data.permissions || null) !== (target.permissions || null);
    const updated = deptChange
      ? await prisma.$transaction(async (tx: any) => {
          const row = await tx.user.update({ where: { id }, data });
          await tx.userDepartmentHistory.createMany({ data: historyRows([deptChange!], String(actor.id), '', 'Правка карточки сотрудника') });
          return row;
        })
      : await prisma.user.update({ where: { id }, data });
    invalidateAuthUser(id);   // права и роль применяются немедленно
    // Личное уведомление сотруднику об изменении его прав доступа
    if (permsChanged) {
      await notifyUser(id, 'ДОСТУП', 'Изменены ваши права доступа', 'Администратор обновил доступные вам функции.', '/');
    }
    const { password: _pw, ...safeUpdated } = updated as any;
    res.json({ success: true, user: safeUpdated });
  } catch (error: any) {
    if (error instanceof DepartmentError) return res.status(error.status).json({ success: false, message: error.message });
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/api/users/:id', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  try {
    const { id } = req.params;
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) {
      return res.status(404).json({ success: false, message: 'Сотрудник не найден.' });
    }
    const actor = (req as any).authUser;
    if (target.role === 'OWNER') return res.status(403).json({ message: 'Профиль владельца нельзя удалить' });
    if (!administratorPermission(actor, 'admin.users.manage') || (target.role === 'ADMIN' && actor?.role !== 'OWNER')) return res.status(403).json({ message: 'Нет права удалять этот профиль' });
    if (target.role === 'ADMIN') {
      const otherAdmins = await prisma.user.count({ where: { role: { in: ['ADMIN', 'OWNER'] }, isActive: true, id: { not: id } } });
      if (otherAdmins === 0) {
        return res.status(400).json({ success: false, message: 'Нельзя удалить последнего администратора.' });
      }
    }
    await prisma.user.delete({ where: { id } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

  // ── Видимость «В сети» ──────────────────────────────────────────────────────
  // Право скрыть своё присутствие есть только у администратора. Это не
  // придирка к правам, а решение владельца: у обычного сотрудника невидимость
  // означала бы, что «кто сейчас в программе» перестал отвечать на свой
  // вопрос, а весь смысл раздела в том, что ответ там честный.
  app.get('/api/presence/visibility', async (req: Request, res: Response) => {
    const me = (req as any).authUser;
    if (!me) return res.status(401).json({ message: 'Нужен вход.' });
    res.json({ hidden: !!me.hideOnline, allowed: await isOwnerRequest(req) });
  });

  app.put('/api/presence/visibility', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const me = (req as any).authUser;
      if (!me) return res.status(401).json({ message: 'Нужен вход.' });
      if (!(await isOwnerRequest(req))) {
        return res.status(403).json({ message: 'Скрывать своё присутствие может только главный администратор.' });
      }
      // Только своё: скрыть чужого — это подделать ответ на вопрос «кто в
      // программе» за другого человека
      const hidden = !!req.body?.hidden;
      await prisma.user.update({ where: { id: me.id }, data: { hideOnline: hidden } });
      invalidateAuthUser(me.id);
      await deps.refreshHiddenOnline?.();
      res.json({ success: true, hidden });
    } catch (error: any) {
      console.error('[Присутствие] Смена видимости не удалась:', error?.message || error);
      res.status(500).json({ message: explainDbError(error, 'Настройка') });
    }
  });

// Права должности: полномочия администратора (admin.*) в ней не хранятся — их
// выдаёт лично владелец карточкой сотрудника. Иначе администратор с правом на
// справочник выписал бы их себе через должность.
function cleanPositionPermissions(raw: unknown): string {
  if (typeof raw === 'string') return JSON.stringify(stripAdminPermissions(raw));
  return JSON.stringify(stripAdminPermissions(raw || {}));
}

/** Сколько людей на должности: основной и дополнительной */
async function positionUsage(prisma: any, code: string): Promise<{ primary: number; extra: number }> {
  const [primary, extra] = await Promise.all([
    prisma.user.count({ where: { OR: [{ positionCode: code }, { positionCode: null, role: code }] } }),
    // Код — латиница, цифры и «_»: в JSON-массиве он всегда в кавычках, чужой код целиком не совпадёт
    prisma.user.count({ where: { extraPositions: { contains: JSON.stringify(code) } } }),
  ]);
  return { primary, extra };
}

// Уровни доступа OWNER и ADMIN — не должности: в справочнике их нет, и менять их строки нельзя
app.get('/api/roles', async (_req: Request, res: Response) => {
  const prisma = getPrisma();
  try {
    const roles = await prisma.role.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
    res.json({ roles: (roles as any[]).filter((r) => !isNonPositionCode(r.code) && r.code !== 'SERVICE') });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/roles', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ message: 'Укажите название должности.' });
    // Код должности — латиницей: он попадает в данные и не должен зависеть от раскладки
    let code = String(req.body.code || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
    if (isNonPositionCode(code)) return res.status(403).json({ message: 'Системный код зарезервирован' });
    if (!code) code = 'ROLE_' + Date.now().toString(36).toUpperCase();
    const dup = await prisma.role.findUnique({ where: { code } });
    if (dup) return res.status(400).json({ message: 'Должность с таким кодом уже есть.' });
    const role = await prisma.role.create({
      data: {
        code, name,
        description: String(req.body.description || ''),
        color: String(req.body.color || 'slate'),
        icon: String(req.body.icon || 'user'),
        level: Math.max(2, Number(req.body.level) || 50),
        permissions: cleanPositionPermissions(req.body.permissions),
        sortOrder: Number(req.body.sortOrder) || 100,
        isSystem: false,
      },
    });
    invalidateRolePerms();   // права новой должности должны действовать сразу
    res.json({ success: true, role });
  } catch (error: any) {
    console.error('[Должности] Создание не удалось:', error?.message || error);
    res.status(500).json({ message: explainDbError(error, 'Должность') });
  }
});

app.put('/api/roles/:id', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  try {
    const role = await prisma.role.findUnique({ where: { id: req.params.id } });
    if (!role) return res.status(404).json({ message: 'Должность не найдена.' });
    if (isNonPositionCode(role.code)) return res.status(403).json({ message: 'Уровни доступа не меняются как должности' });
    const data: any = {};
    if (req.body.name !== undefined) data.name = String(req.body.name).trim() || role.name;
    if (req.body.description !== undefined) data.description = String(req.body.description);
    if (req.body.color !== undefined) data.color = String(req.body.color);
    if (req.body.icon !== undefined) data.icon = String(req.body.icon);
    if (req.body.sortOrder !== undefined) data.sortOrder = Number(req.body.sortOrder) || role.sortOrder;
    if (req.body.permissions !== undefined) data.permissions = cleanPositionPermissions(req.body.permissions);
    if (req.body.level !== undefined && !role.isSystem) data.level = Math.max(2, Number(req.body.level) || 50);
    const updated = await prisma.role.update({ where: { id: role.id }, data });
    invalidateRolePerms();
    invalidateAuthUser();     // должность касается сразу нескольких сотрудников
    res.json({ success: true, role: updated });
  } catch (error: any) {
    console.error('[Должности] Изменение не удалось:', error?.message || error);
    res.status(500).json({ message: explainDbError(error, 'Должность') });
  }
});

app.delete('/api/roles/:id', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  try {
    const role = await prisma.role.findUnique({ where: { id: req.params.id } });
    if (!role) return res.status(404).json({ message: 'Должность не найдена.' });
    if (isNonPositionCode(role.code)) return res.status(403).json({ message: 'Уровни доступа не удаляются как должности' });
    if (role.isSystem) return res.status(400).json({ message: 'Встроенную должность удалить нельзя — её использует сама программа.' });
    // Хоть как дополнительная: иначе у человека осталась бы должность, которой нет в справочнике
    const { primary, extra } = await positionUsage(prisma, role.code);
    if (primary + extra > 0) {
      const parts = [primary ? `основной у ${primary}` : '', extra ? `дополнительной у ${extra}` : ''].filter(Boolean).join(', ');
      return res.status(400).json({ message: `Должность назначена: ${parts}. Сначала переведите этих сотрудников на другую.` });
    }
    await prisma.role.delete({ where: { id: role.id } });
    invalidateRolePerms();
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

// ── Настройки уведомлений сотрудника ────────────────────────────────────────
// Хранятся на сервере, чтобы ехали за человеком на любой компьютер.
app.get('/api/notif-prefs', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  try {
    const me = (req as any).authUser;
    if (!me) return res.status(401).json({ error: 'Требуется вход в систему' });
    const row = await prisma.appSetting.findFirst({ where: { key: 'notif_prefs', userId: me.id } });
    res.json({ prefs: row?.value ? JSON.parse(row.value) : null });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/notif-prefs', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  try {
    const me = (req as any).authUser;
    if (!me) return res.status(401).json({ error: 'Требуется вход в систему' });
    const value = JSON.stringify(req.body?.prefs || {});
    const existing = await prisma.appSetting.findFirst({ where: { key: 'notif_prefs', userId: me.id } });
    if (existing) await prisma.appSetting.update({ where: { id: existing.id }, data: { value } });
    else await prisma.appSetting.create({ data: { key: 'notif_prefs', userId: me.id, value } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
}
