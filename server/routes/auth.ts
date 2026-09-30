import type { Express, Request, Response } from 'express';
import crypto from 'crypto';
import { getPrisma } from '../context.js';
import { loginWait, loginFailed, loginSucceeded, LOGIN_REFUSED, waitText } from '../security.js';

// Вход, проверка сессии и начальное заполнение базы.
//
// Вынесено из server.ts. Кэши профилей и сессий, подпись токена, хеш пароля и
// «надёжное время» остались там же: ими пользуются и другие места server.ts
// (права, промежуточный слой авторизации), поэтому сюда они не копировались, а
// передаются при подключении.

interface AuthDeps {
  hashPassword: (plain: string) => string;
  verifyPassword: (plain: string, stored: string | null | undefined) => boolean;
  /** Подписанный токен сессии: его клиент шлёт в Authorization */
  issueAuthToken: (userId: string) => string;
  /** Права роли отдаются вместе с профилем при входе */
  rolePermissionsOf: (code: string) => Promise<Record<string, any>>;
  /** Полная проверка времени при входе: якорь из базы + сетевое время */
  trustedNowFull: () => Promise<{ now: number; tampered: boolean; source: string }>;
  /** Быстрая оценка надёжного времени; заодно двигает якорь вперёд */
  trustedNowSync: () => number;
  /** Признак «часы переведены назад» — переменная в server.ts, её читают и права */
  isClockTampered: () => boolean;
}

export function registerAuthRoutes(app: Express, deps: AuthDeps): void {
  const {
    hashPassword, verifyPassword, issueAuthToken, rolePermissionsOf,
    trustedNowFull, trustedNowSync, isClockTampered,
  } = deps;

  // Хеш-приманка для входа несуществующим логином: считается ради времени ответа
  const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

  // Users
  app.post('/api/login', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    const { symbol, password } = req.body;

    const normSymbol = String(symbol || '').trim();
    const addr = String(req.socket.remoteAddress || '');

    // Перебор пароля: после нескольких промахов подряд ответ приходит только
    // через паузу, и пауза растёт (server/security.ts)
    const wait = loginWait(normSymbol, addr);
    if (wait > 0) {
      res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
      return res.status(429).json({ success: false, message: waitText(wait) });
    }

    // Попытка авторизации через локальную БД, если БД вообще была создана/готова
    try {
      // Логин не чувствителен к регистру: RaupovKhkh == RaupovKhKh
      let user = await prisma.user.findUnique({
        where: { symbol: normSymbol },
      });
      if (!user) {
        const allUsers = await prisma.user.findMany();
        user = allUsers.find((u: any) => String(u.symbol).toLowerCase() === normSymbol.toLowerCase()) || null;
      }
      if (user) {
        // Принимается только хеш: открытые записи переведены при старте сервера
        const isPasswordCorrect = verifyPassword(String(password), user.password);

        if (isPasswordCorrect) {
          loginSucceeded(normSymbol);
          // Контроль доступа: профиль может быть отключен администратором или просрочен
          if (user.isActive === false) {
            return res.status(403).json({ success: false, message: 'Профиль отключен администратором. Обратитесь к администратору системы.' });
          }
          if (user.validUntil) {
            // Срок проверяем по надёжному времени: якорь + сеть (перевод часов не помогает)
            const { now, tampered } = await trustedNowFull();
            if (tampered && user.role !== 'ADMIN') {
              return res.status(403).json({ success: false, message: 'Обнаружен перевод системных часов назад. Вход для профилей со сроком действия заблокирован — верните корректную дату и время.' });
            }
            if (new Date(user.validUntil).getTime() < now) {
              const dt = new Date(user.validUntil).toLocaleDateString('ru-RU');
              return res.status(403).json({ success: false, message: `Срок действия профиля истек ${dt}. Обратитесь к администратору для продления доступа.` });
            }
          } else {
            // Обновляем якорь времени и для бессрочных входов
            trustedNowSync();
          }
          // Отметка входа. Нужна не для порядка: в разделе «Сотрудники»
          // администратор видит, кто когда заходил, а присутствие помнит людей
          // только неделю — по нему «не заходил с мая» отличить от «не заходил
          // никогда» нельзя
          try {
            await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
          } catch (_) { /* колонки может не быть: база старее программы */ }
          const { password: _pw, ...safeUser } = user as any;
          // Права роли отдаём вместе с профилем: интерфейс должен знать, что
          // человеку можно, не запрашивая это на каждом экране.
          (safeUser as any).rolePermissions = JSON.stringify(await rolePermissionsOf(String(user.role || '')));
          // Токен сессии: клиент шлёт его в Authorization на каждом запросе
          return res.json({ success: true, user: safeUser, token: issueAuthToken(user.id) });
        } else {
          loginFailed(normSymbol, addr);
          return res.status(401).json({ success: false, message: LOGIN_REFUSED });
        }
      } else {
        // Хеш считается и здесь: без него «нет такого логина» отвечал заметно
        // быстрее, чем «не тот пароль», и время ответа выдавало то же самое
        verifyPassword(String(password), DUMMY_HASH);
        // Тот же ответ, что и на неверный пароль: разные ответы выдавали,
        // какие логины в программе есть, — половину подбора
        loginFailed(normSymbol, addr);
        return res.status(401).json({ success: false, message: LOGIN_REFUSED });
      }
    } catch (dbErr: any) {
      console.warn('[Login Backend] Database is probably not initialized or SQLite is locked:', dbErr.message);
      return res.status(500).json({
        success: false,
        message: 'База данных еще не инициализирована или не подключена. Перезапустите приложение или настройте СУБД в настройках подключения.'
      });
    }
  });

  // Периодическая проверка действительности профиля во время работы:
  // фронтенд опрашивает и принудительно завершает сессию, если доступ отозван
  app.get('/api/auth/check', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    // Проверяется профиль вошедшего, а не названный в запросе: иначе по номеру
    // можно было выяснять состояние чужой учётной записи (отключена, срок вышел)
    const userId = String((req as any).authUser?.id || '');
    if (!userId) {
      return res.json({ valid: false, reason: 'Не указан идентификатор пользователя.' });
    }
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        return res.json({ valid: false, reason: 'Профиль не найден в базе данных. Выйдите и войдите заново.' });
      }
      if (user.isActive === false) {
        return res.json({ valid: false, reason: 'Профиль отключен администратором.' });
      }
      if (user.validUntil) {
        const now = trustedNowSync();
        if (isClockTampered() && user.role !== 'ADMIN') {
          return res.json({ valid: false, reason: 'Обнаружен перевод системных часов назад. Верните корректную дату и время.' });
        }
        if (new Date(user.validUntil).getTime() < now) {
          return res.json({ valid: false, reason: `Срок действия профиля истек ${new Date(user.validUntil).toLocaleDateString('ru-RU')}.` });
        }
      }
      return res.json({ valid: true });
    } catch (err: any) {
      // При временной недоступности БД не выбрасываем пользователя из сессии
      return res.json({ valid: true, degraded: true });
    }
  });

  // For dummy data generation so we can test the app
  app.post('/api/seed', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const admin = await prisma.user.upsert({
        where: { symbol: 'RaupovKhKh' },
        // Повторное заполнение не меняет пароль и права существующей учётной записи.
        update: {},
        create: {
          name: 'Главный администратор (RaupovKhKh)',
          symbol: 'RaupovKhKh',
          password: hashPassword('1122'),
          role: 'ADMIN',
        }
      });

      const existingProject = await prisma.project.findFirst({
        where: { name: { in: ['Проект Альфа', 'Технологический Проект Альфа'] } }
      });
      if (!existingProject) {
        await prisma.project.create({
          data: {
            name: 'Проект Альфа',
          }
        });
      }

      const existingAhu = await prisma.equipment.findFirst({
        where: { type: 'AHU' }
      });
      if (!existingAhu) {
        await prisma.equipment.create({
          data: {
            type: 'AHU',
            description: 'Air Handling Unit',
          }
        });
      }

      res.json({ success: true, user: admin });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}
