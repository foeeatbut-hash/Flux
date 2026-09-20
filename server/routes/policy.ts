/**
 * «Что мне сейчас можно» — один лёгкий запрос профиля.
 *
 * Раньше доступ приезжал единственный раз, в ответе на вход, и снятое право
 * продолжало действовать до перезапуска программы. Для рабочих прав это
 * переживаемо (сервер всё равно откажет), для встроенных программ нет: их
 * доступ выдают и отбирают точечно, и отобранный обязан пропасть с экрана
 * сразу, а не завтра.
 *
 * Запрос отдаёт ТОЛЬКО свой доступ: ни списка сотрудников, ни чужих прав.
 * И отдаёт его уже очищенным — у сотрудника без платформы из карты вырезаны
 * сами ключи её прав, потому что ключ «game.fluxstrike.play» называет игру
 * ничуть не хуже, чем список игр.
 */

import type { Express, Request, Response } from 'express';
import {
  hiddenPlatform, getPolicyVersion, platformState, stripPlayKeys, subjectOf, allowed,
} from '../play/access.js';
import { APP_PLAY } from '../../play/features.js';

export function registerPolicyRoutes(app: Express): void {
  app.get('/api/me/bootstrap', async (req: Request, res: Response) => {
    // Личность — из сессии, а не из запроса: иначе достаточно подставить чужой
    // идентификатор, чтобы узнать чужой доступ
    const user = (req as any).authUser;
    if (!user) return res.status(401).json({ error: 'Требуется вход в систему' });

    try {
      const subject = await subjectOf(user);
      const hasPlay = await allowed(user, APP_PLAY);
      const personal = subject?.personal || {};
      const fromRole = subject?.fromRole || {};
      return res.json({
        // Платформы нет — значит, нет и её состояния: сотруднику без доступа
        // не сообщается даже то, что она где-то включена
        platform: hasPlay ? await platformState() : hiddenPlatform(),
        permissions: hasPlay ? personal : stripPlayKeys(personal),
        rolePermissions: hasPlay ? fromRole : stripPlayKeys(fromRole),
        policyVersion: getPolicyVersion(),
      });
    } catch (e: any) {
      return res.status(500).json({ error: 'Не удалось прочитать доступ', details: e?.message });
    }
  });
}
