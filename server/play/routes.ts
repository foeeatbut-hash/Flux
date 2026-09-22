/**
 * Маршруты платформы. Пока их два, и оба — про саму платформу, а не про игры.
 *
 * Подключаются ПОСЛЕ заслона (`registerPlayAccess`): без него первый же
 * обработчик оказался бы открыт всем, и скрывать было бы уже нечего. Порядок
 * проверяется скриптом (`scripts/test-play-policy.ts`) — забыть его легко, а
 * заметить, что забыли, нечем.
 */

import type { Express, Request, Response } from 'express';
import { broadcast, upsertSetting } from '../context.js';
import {
  PLAY_ENABLED_KEY, allowed, invalidatePlatform, notThere, platformState, verdict,
} from './access.js';
import { PLAY_ADMIN } from '../../play/features.js';
import { registerPlayAdmin } from './admin.js';
import { registerPlayApi } from './api.js';
import { setupTestGame } from './adapters/testgame.js';
import { registerBuiltinAdapters } from './adapters/builtin.js';

export function registerPlayRoutes(app: Express): void {
  // Игры подключаются до маршрутов: матч по неподключённой игре не начнётся,
  // и человек увидит «игра не подключена», а не бесконечное «Подключение…»
  setupTestGame((m) => console.log('[Play]', m));
  // Встроенные игры подключаются все разом: доска у них считается тем же
  // сервером, и выделять им нечего
  registerBuiltinAdapters();

  /**
   * Состояние платформы словами — для Настроек.
   *
   * Включена ли, держит ли её база и почему нет, если не держит. Причина
   * нужна именно здесь: «раздел не включается» без объяснения выглядит как
   * поломка, и разбираться с ней приходит тот же человек, который её включал.
   */
  app.get('/api/play/platform', async (req: Request, res: Response) => {
    const user = (req as any).authUser;
    try {
      const state = await platformState();
      const admin = await allowed(user, PLAY_ADMIN);
      return res.json({ platform: state, canManage: admin });
    } catch (e: any) {
      return res.status(500).json({ error: 'Не удалось прочитать состояние платформы', details: e?.message });
    }
  });

  /**
   * Общий выключатель.
   *
   * Держит его только тот, кому выдано управление платформой. Должность здесь
   * снова ничего не значит — как и везде в этой оси прав.
   */
  app.put('/api/play/platform', async (req: Request, res: Response) => {
    const user = (req as any).authUser;
    try {
      const may = await verdict(user, PLAY_ADMIN);
      // Отказ молчаливый и здесь: «нельзя» рассказало бы, что есть что
      if (!may.allowed) return notThere(res);

      const want = req.body?.enabled === true;
      const state = await platformState();
      if (want && !state.supported) {
        // Включать неподдержанную базу нельзя, и это единственное место, где
        // платформа объясняется вслух: человек имеет право знать, почему
        return res.status(409).json({ error: state.note || 'База не поддерживает платформу' });
      }
      await upsertSetting(PLAY_ENABLED_KEY, null, want ? '1' : '0');
      invalidatePlatform();
      // Выключили — раздел обязан исчезнуть у всех сразу, а не после
      // перезапуска программы
      try { broadcast('capabilities:changed', { at: Date.now() }); } catch (_) {}
      return res.json({ platform: await platformState() });
    } catch (e: any) {
      return res.status(500).json({ error: 'Не удалось изменить состояние платформы', details: e?.message });
    }
  });

  // Распоряжения администратора: обслуживание, ключ издателя, сборки,
  // зависшие матчи. До общих маршрутов — у них свои адреса и своё право
  registerPlayAdmin(app);

  // Группа, приглашения, лобби, матч, билеты, результат
  registerPlayApi(app);

  // Всё остальное под /api/play отвечает так же, как выдуманный адрес:
  // «такого нет» — единственный ответ, который ничего не рассказывает
  app.use('/api/play', (_req: Request, res: Response) => notThere(res));
}
