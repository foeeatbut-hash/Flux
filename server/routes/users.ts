import type { Express, Request, Response } from 'express';
import { defaultPermissions } from '../../src/lib/permissions';
import { getPrisma, notifyUser } from '../context.js';
import { explainDbError } from '../dbError.js';

// Сотрудники, роли и личные настройки уведомлений.
//
// Вынесено из server.ts. Часть вспомогательного кода осталась там (хеширование
// паролей, сброс кэшей сессии и прав) — он нужен и при входе, и при
// восстановлении базы. Чтобы не заводить круговой импорт, эти функции
// передаются один раз при подключении маршрутов.

interface UserDeps {
  hashPassword: (plain: string) => string;
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

const hashPassword = (plain: string) => deps.hashPassword(plain);
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


// ── Роли сотрудников ────────────────────────────────────────────────────────
// Роли заводит администратор, а не программист: в разных компаниях они
// называются по-разному. level = 1 — главный администратор, единственный,
// кто управляет ролями и выдаёт доступ. Встроенные роли не удаляются,
// иначе можно остаться без администратора.
const grant = (...ids: string[]) =>
  JSON.stringify(Object.fromEntries(ids.map(id => [id, { enabled: true, until: null }])));

// Обычная инженерная работа: вести теги и оборудование, класть файлы,
// отмечать этапы закупки и вести реестр. Опасное (удаление тегов и файлов,
// настройка этапов и стандартов на всю компанию, управление проектами)
// в набор по умолчанию не входит — это выдаёт администратор осознанно.
const ENGINEER_GRANTS = grant(
  'tags.manage', 'dictionaries.manage', 'equipment.import', 'equipment.manage',
  'files.upload', 'procurement.manage', 'vdr.manage',
);
const MANAGER_GRANTS = grant(
  'project.manage', 'tags.manage', 'dictionaries.manage', 'equipment.import',
  'equipment.manage', 'files.upload', 'files.delete', 'procurement.manage',
  'procurement.setup', 'vdr.manage', 'vdr.standards',
);

const BUILTIN_ROLES = [
  { code: 'ADMIN',          name: 'Администратор',     color: 'rose',    icon: 'shield-check', level: 1,  sortOrder: 10, description: 'Полный доступ, управление сотрудниками и ролями', permissions: '{}' },
  { code: 'MANAGER',        name: 'Менеджер проектов', color: 'amber',   icon: 'briefcase',    level: 20, sortOrder: 20, description: 'Проекты, закупки, документооборот', permissions: MANAGER_GRANTS },
  { code: 'ENGINEER_VENT',  name: 'Инженер ОВиК',      color: 'sky',     icon: 'airplay',      level: 50, sortOrder: 30, description: 'Вентиляция и кондиционирование', permissions: ENGINEER_GRANTS },
  { code: 'ENGINEER_AUTO',  name: 'Инженер КИПиА',     color: 'emerald', icon: 'cpu',          level: 50, sortOrder: 40, description: 'Автоматика и приборы', permissions: ENGINEER_GRANTS },
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

/** Главный администратор — тот, чья роль имеет уровень 1. */
async function isTopAdmin(req: Request): Promise<boolean> {
  const prisma = getPrisma();
  const u = (req as any).authUser;
  if (!u) return false;
  if (u.role === 'ADMIN') return true;
  const role = await prisma.role.findUnique({ where: { code: u.role } }).catch(() => null);
  return !!role && role.level <= 1;
}

export function registerUserRoutes(app: Express, d: UserDeps): void {
  deps = d;

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
      if (!own && !(me?.role === 'ADMIN' || (await isTopAdmin(req)))) {
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

      const isSelf = me.id === id;
      const canManage = me.role === 'ADMIN' || (await isTopAdmin(req));
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
    const roles = await prisma.role.findMany().catch(() => [] as any[]);
    const byCode: Record<string, string> = {};
    for (const r of roles as any[]) byCode[r.code] = r.permissions || '{}';
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
    res.json((users as any[]).map(({ password, signatureImage, hideOnline, ...u }) => ({
      ...u,
      lastLoginAt: hideOnline && u.id !== meId ? null : u.lastLoginAt,
      rolePermissions: byCode[u.role] || '{}',
      hasSignature: !!signatureImage,
    })));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/users', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  try {
    const { symbol, role, password } = req.body;
    // ФИО приходит по частям; единая строка name остаётся производной —
    // её показывают старые экраны и печатают документы.
    const parts = nameParts(req.body);
    const name = parts.name || String(req.body.name || '').trim();
    if (!name) {
      return res.status(400).json({ message: 'Укажите фамилию и имя сотрудника.' });
    }
    const existing = await prisma.user.findUnique({
      where: { symbol: String(symbol) }
    });
    if (existing) {
      return res.status(400).json({ 
        code: 'P2002', 
        message: 'Ошибка: сотрудник с таким табельным номером уже внесен в базу данных!' 
      });
    }

    const { validUntil, isActive, permissions } = req.body;
    const newUser = await prisma.user.create({
      data: {
        symbol: String(symbol),
        name,
        lastName: parts.lastName,
        firstName: parts.firstName,
        middleName: parts.middleName,
        gender: parts.gender,
        birthDate: parts.birthDate,
        role: role || 'ENGINEER_VENT',
        password: hashPassword(String(password || 'password')),
        isActive: typeof isActive === 'boolean' ? isActive : true,
        validUntil: validUntil ? new Date(validUntil) : null,
        // По умолчанию сотруднику доступно всё, кроме управления проектами
        // (src/lib/permissions.ts): начинать с нуля значило, что новый человек
        // первый день не может ничего и ходит к администратору за каждой
        // галочкой
        permissions: permissions
          ? (typeof permissions === 'string' ? permissions : JSON.stringify(permissions))
          : JSON.stringify(defaultPermissions()),
      }
    });
    const { password: _pw, ...safeNewUser } = newUser as any;
    res.json(safeNewUser);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Обновление профиля сотрудника: роль, пароль, активность, срок действия
app.put('/api/users/:id', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  try {
    const { id } = req.params;
    const { name, role, password, isActive, validUntil, symbol, permissions } = req.body;

    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) {
      return res.status(404).json({ success: false, message: 'Сотрудник не найден в базе данных.' });
    }

    // Смена логина (табельного номера) — проверяем уникальность
    if (typeof symbol === 'string' && symbol.trim() && symbol.trim() !== target.symbol) {
      if (symbol.includes('@')) {
        return res.status(400).json({ success: false, message: 'Логин не может содержать символ @.' });
      }
      const dup = await prisma.user.findUnique({ where: { symbol: symbol.trim() } });
      if (dup && dup.id !== id) {
        return res.status(400).json({ success: false, message: 'Такой табельный номер (логин) уже занят другим сотрудником.' });
      }
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
        where: { role: 'ADMIN', isActive: true, id: { not: id } }
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
    if (typeof symbol === 'string' && symbol.trim()) data.symbol = symbol.trim();
    if (typeof role === 'string' && role) data.role = role;
    if (typeof password === 'string' && password) data.password = hashPassword(password);
    if (typeof isActive === 'boolean') data.isActive = isActive;
    if (validUntil !== undefined) data.validUntil = parsedValidUntil;
    if (permissions !== undefined) {
      data.permissions = permissions === null ? null
        : (typeof permissions === 'string' ? permissions : JSON.stringify(permissions));
    }

    const permsChanged = permissions !== undefined && (data.permissions || null) !== (target.permissions || null);
    const updated = await prisma.user.update({ where: { id }, data });
    invalidateAuthUser(id);   // права и роль применяются немедленно
    // Личное уведомление сотруднику об изменении его прав доступа
    if (permsChanged) {
      await notifyUser(id, 'ДОСТУП', 'Изменены ваши права доступа', 'Администратор обновил доступные вам функции.', '/');
    }
    const { password: _pw, ...safeUpdated } = updated as any;
    res.json({ success: true, user: safeUpdated });
  } catch (error: any) {
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
    if (target.role === 'ADMIN') {
      const otherAdmins = await prisma.user.count({ where: { role: 'ADMIN', isActive: true, id: { not: id } } });
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
    res.json({ hidden: !!me.hideOnline, allowed: await isTopAdmin(req) });
  });

  app.put('/api/presence/visibility', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const me = (req as any).authUser;
      if (!me) return res.status(401).json({ message: 'Нужен вход.' });
      if (!(await isTopAdmin(req))) {
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

app.get('/api/roles', async (_req: Request, res: Response) => {
  const prisma = getPrisma();
  try {
    const roles = await prisma.role.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
    res.json({ roles });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/roles', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  try {
    if (!(await isTopAdmin(req))) {
      return res.status(403).json({ message: 'Роли создаёт только главный администратор.' });
    }
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ message: 'Укажите название роли.' });
    // Код роли — латиницей: он попадает в данные и не должен зависеть от раскладки
    let code = String(req.body.code || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
    if (!code) code = 'ROLE_' + Date.now().toString(36).toUpperCase();
    const dup = await prisma.role.findUnique({ where: { code } });
    if (dup) return res.status(400).json({ message: 'Роль с таким кодом уже есть.' });
    const role = await prisma.role.create({
      data: {
        code, name,
        description: String(req.body.description || ''),
        color: String(req.body.color || 'slate'),
        icon: String(req.body.icon || 'user'),
        // Уровень 1 занят главным администратором: новую роль туда не пускаем,
        // иначе управление доступом можно раздать себе же.
        level: Math.max(2, Number(req.body.level) || 50),
        permissions: typeof req.body.permissions === 'string' ? req.body.permissions : JSON.stringify(req.body.permissions || {}),
        sortOrder: Number(req.body.sortOrder) || 100,
        isSystem: false,
      },
    });
    invalidateRolePerms();   // права новой роли должны действовать сразу
    res.json({ success: true, role });
  } catch (error: any) {
    console.error('[Роли] Создание роли не удалось:', error?.message || error);
    res.status(500).json({ message: explainDbError(error, 'Роль') });
  }
});

app.put('/api/roles/:id', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  try {
    if (!(await isTopAdmin(req))) {
      return res.status(403).json({ message: 'Роли меняет только главный администратор.' });
    }
    const role = await prisma.role.findUnique({ where: { id: req.params.id } });
    if (!role) return res.status(404).json({ message: 'Роль не найдена.' });
    const data: any = {};
    if (req.body.name !== undefined) data.name = String(req.body.name).trim() || role.name;
    if (req.body.description !== undefined) data.description = String(req.body.description);
    if (req.body.color !== undefined) data.color = String(req.body.color);
    if (req.body.icon !== undefined) data.icon = String(req.body.icon);
    if (req.body.sortOrder !== undefined) data.sortOrder = Number(req.body.sortOrder) || role.sortOrder;
    if (req.body.permissions !== undefined) {
      data.permissions = typeof req.body.permissions === 'string' ? req.body.permissions : JSON.stringify(req.body.permissions || {});
    }
    // Уровень встроенной роли не трогаем: он определяет, кто главный админ
    if (req.body.level !== undefined && !role.isSystem) data.level = Math.max(2, Number(req.body.level) || 50);
    const updated = await prisma.role.update({ where: { id: role.id }, data });
    invalidateRolePerms();
    invalidateAuthUser();     // роль касается сразу нескольких сотрудников
    res.json({ success: true, role: updated });
  } catch (error: any) {
    console.error('[Роли] Изменение роли не удалось:', error?.message || error);
    res.status(500).json({ message: explainDbError(error, 'Роль') });
  }
});

app.delete('/api/roles/:id', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  try {
    if (!(await isTopAdmin(req))) {
      return res.status(403).json({ message: 'Роли удаляет только главный администратор.' });
    }
    const role = await prisma.role.findUnique({ where: { id: req.params.id } });
    if (!role) return res.status(404).json({ message: 'Роль не найдена.' });
    if (role.isSystem) return res.status(400).json({ message: 'Встроенную роль удалить нельзя — её использует сама программа.' });
    const inUse = await prisma.user.count({ where: { role: role.code } });
    if (inUse > 0) {
      return res.status(400).json({ message: `Роль назначена ${inUse} сотрудник(ам). Сначала переведите их на другую роль.` });
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
