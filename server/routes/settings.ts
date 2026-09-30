import type { Express, Request, Response } from 'express';
import { getPrisma, upsertSetting } from '../context.js';
import {
  isAdminActor, isServerKey, isTrustKey, validSettingKey, settingScope, globalWriteRule,
  bookmarksProjectOf, actorMay, MAX_SETTING_BYTES,
} from '../projectAccess.js';
import { canSeeProject, roleGrantsOf } from './members.js';

// Настройки приложения: глобальные (userId=null) и персональные.
//
// Общий маршрут когда-то принимал любые key/userId/value от любого вошедшего.
// Через него можно было переписать чужие настройки, глобальные переключатели и
// даже ключи, на которых держится доверие (ключ издателя игр, якорь времени).
// Теперь: личная запись — только своя (userId берётся из сессии), общая —
// администратор либо явно разрешённый ключ, а доверенные и служебные ключи
// здесь не пишутся вовсе: у них есть штатный путь со своей проверкой прав.
export function registerSettingsRoutes(app: Express): void {
  // Чтение: возвращает глобальное значение и значение пользователя
  app.get('/api/settings/:key', async (req: Request, res: Response) => {
    try {
      const me = (req as any).authUser;
      if (!me?.id) return res.status(401).json({ error: 'Требуется вход' });
      const { key } = req.params;
      if (!validSettingKey(key)) return res.status(400).json({ error: 'Некорректный ключ настройки' });
      const admin = isAdminActor(me);
      // Ключи доверия постороннему не показываем: по ним видно, чем защищена программа
      if (isTrustKey(key) && !admin) return res.status(403).json({ error: 'Недостаточно прав' });
      // Чужие личные настройки не читаются: userId из запроса имеет вес только у администратора
      const asked = String(req.query.userId || '');
      const userId = admin && asked ? asked : String(me.id);
      const prisma = getPrisma();
      const global = await prisma.appSetting.findFirst({ where: { key, userId: null } });
      const user = await prisma.appSetting.findFirst({ where: { key, userId } });
      res.json({ global: global ? global.value : null, user: user ? user.value : null });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Запись: личная (userId в теле, но только свой) или глобальная
  app.post('/api/settings/:key', async (req: Request, res: Response) => {
    try {
      const me = (req as any).authUser;
      if (!me?.id) return res.status(401).json({ success: false, message: 'Требуется вход' });
      const { key } = req.params;
      if (!validSettingKey(key)) return res.status(400).json({ success: false, message: 'Некорректный ключ настройки' });
      // Доверенные и служебные ключи через общий маршрут не пишутся никем, и администратором тоже
      if (isServerKey(key)) return res.status(403).json({ success: false, message: 'Эта настройка меняется только штатным способом' });

      const value = req.body?.value;
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      if (text === undefined) return res.status(400).json({ success: false, message: 'Не передано значение' });
      if (Buffer.byteLength(text, 'utf8') > MAX_SETTING_BYTES) {
        return res.status(413).json({ success: false, message: 'Значение слишком большое' });
      }

      const admin = isAdminActor(me);
      const scope = settingScope(String(me.id), admin, req.body?.userId);
      if (scope.kind === 'global' && !admin) {
        const rule = globalWriteRule(key);
        let allowed = false;
        if (rule) {
          allowed = true;
          if (rule.perm) allowed = await actorMay(me, roleGrantsOf, rule.perm);
          // Закладки общие на проект: чужой закрытый проект своими не трогаем
          if (allowed && rule.project) {
            const pid = bookmarksProjectOf(key);
            if (pid) allowed = await canSeeProject(String(me.id), pid, false);
          }
        }
        if (!allowed) return res.status(403).json({ success: false, message: 'Общие настройки меняет администратор' });
      }
      const setting = await upsertSetting(key, scope.kind === 'personal' ? scope.userId : null, text);
      res.json({ success: true, setting });
    } catch (err: any) { res.status(500).json({ success: false, message: err.message }); }
  });
}
