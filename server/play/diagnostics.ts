/**
 * Диагностика Flux Play для администратора организации.
 *
 * Живёт ВНЕ `/api/play`, и это главное решение файла. Заслон платформы
 * отвечает нейтральным «такого нет» всем, у кого нет игровых прав, — и
 * администратор, которому платформу настраивать, упирался в тот же ответ:
 * раздела нет, кнопки нет, причины нет. Спрятать настройку за той же дверью,
 * ключ от которой она и выдаёт, — это не скрытность, а тупик.
 *
 * Поэтому здесь отдельный адрес, отдельная проверка (главный администратор) и
 * ответ, который называет причину словами: выключена платформа, не выдано
 * право, запрещено лично, истёк срок, база не поддерживает. Скрытность
 * обычного сотрудника при этом не меняется ни на шаг: без права он по-прежнему
 * не видит ни раздела, ни этого адреса.
 *
 * Чего здесь нет намеренно: безусловного «администратор может всё». Право на
 * игру выдаётся явно, как и требует ТЗ, — просто теперь видно, кем и почему
 * оно не выдано.
 */

import type { Express, Request, Response } from 'express';
import { broadcast, forgetSessionUser, getPrisma, upsertSetting } from '../context.js';
import { APP_PLAY, PLAY_ADMIN, PLAY_GAMES, gameEntitlement } from '../../play/features.js';
import { getPolicyVersion, invalidatePlatform, isTopAdminUser, platformState, subjectOf, PLAY_ENABLED_KEY } from './access.js';
import { decide } from '../../play/policy.js';
import { latestBuild, publisherKey } from './builds.js';
import { supportsPartialIndex } from '../ddl.js';
import { getDialect } from '../ddl.js';

/** Главный администратор — тот, чья роль имеет уровень 1 (как в Сотрудниках). */
const isTopAdmin = (req: Request): Promise<boolean> => isTopAdminUser((req as any).authUser);

/** Решение по одному праву — словами, с источником и сроком. */
async function verdictFor(user: any, key: string) {
  const subject = await subjectOf(user);
  const state = await platformState();
  const v = decide(subject, state, key, key === PLAY_ADMIN ? { ignoreSwitch: true } : {});
  return {
    key,
    allowed: v.allowed,
    source: v.source,
    note: v.note,
    validUntil: subject?.validUntil || null,
  };
}

export function registerPlayDiagnostics(app: Express): void {
  /**
   * Почему раздела не видно — одним ответом.
   *
   * Отвечает только главному администратору: обычному сотруднику этот адрес
   * рассказал бы о существовании того, что от него скрыто.
   */
  app.get('/api/admin/play-diagnostics', async (req: Request, res: Response) => {
    if (!(await isTopAdmin(req))) return res.status(404).json({ error: 'Страница не найдена' });
    try {
      const user = (req as any).authUser;
      const platform = await platformState();
      const dialect = getDialect();

      const games = await Promise.all(PLAY_GAMES.map(async (g) => {
        const access = await verdictFor(user, gameEntitlement(g.id));
        const build = platform.supported ? await latestBuild(g.id).catch(() => null) : null;
        return {
          id: g.id,
          title: g.title,
          installable: g.installable,
          allowed: access.allowed,
          why: access.note,
          published: build?.version || '',
        };
      }));

      return res.json({
        platform: {
          enabled: platform.enabled,
          supported: platform.supported,
          maintenance: platform.maintenance,
          note: platform.note,
          policyVersion: getPolicyVersion(),
        },
        database: {
          dialect,
          partialIndexes: supportsPartialIndex(dialect),
          note: supportsPartialIndex(dialect)
            ? 'База держит правила платформы частичными индексами'
            : 'Эта база не умеет частичных индексов, на которых держатся правила платформы',
        },
        me: {
          id: String(user?.id || ''),
          role: String(user?.role || ''),
          active: user?.isActive !== false,
          app: await verdictFor(user, APP_PLAY),
          admin: await verdictFor(user, PLAY_ADMIN),
        },
        games,
        publisherKey: await publisherKey().catch(() => ''),
      });
    } catch (e: any) {
      return res.status(500).json({ error: 'Не удалось собрать диагностику', details: e?.message });
    }
  });

  /**
   * «Включить Flux Play» — одной кнопкой, главному администратору.
   *
   * Раньше для этого нужно было знать порядок: выдать себе управление в
   * диагностике, найти выключатель, включить, затем выдать себе же доступ в
   * карточке сотрудника. Никто этого порядка не знал, и платформы не было ни у
   * кого. Теперь это одно действие — и каждое его звено остаётся явной записью
   * с автором и временем: управление, выключатель, а по галочке «открыть и
   * мне» — доступ к разделу и играм. Явный личный запрет не снимается молча.
   */
  app.post('/api/admin/play-diagnostics/enable', async (req: Request, res: Response) => {
    if (!(await isTopAdmin(req))) return res.status(404).json({ error: 'Страница не найдена' });
    try {
      const state = await platformState();
      if (!state.supported) {
        return res.status(409).json({ error: state.note || 'Эта база не поддерживает платформу' });
      }
      const prisma = getPrisma();
      const user = (req as any).authUser;
      const row = await prisma.user.findUnique({ where: { id: String(user?.id || '') } });
      if (!row) return res.status(404).json({ error: 'Профиль не найден' });

      let perms: Record<string, any> = {};
      try { perms = row.permissions ? JSON.parse(row.permissions) : {}; } catch (_) { perms = {}; }
      const denied: string[] = [];
      const granted: string[] = [];
      const give = (key: string) => {
        const was = perms[key];
        if (was && typeof was === 'object' && was.mode === 'DENY') { denied.push(key); return; }
        if (was && (was === true || was.mode === 'ALLOW' || was.enabled === true)) return;
        perms[key] = { enabled: true, until: null, mode: 'ALLOW' };
        granted.push(key);
      };
      give(PLAY_ADMIN);
      if (req.body?.openForMe === true) {
        give(APP_PLAY);
        for (const g of PLAY_GAMES) give(gameEntitlement(g.id));
      }
      if (denied.includes(PLAY_ADMIN)) {
        return res.status(409).json({
          error: 'Управление платформой запрещено вам лично. Снимите запрет в карточке сотрудника — '
            + 'молча переписывать чужое решение программа не будет.',
        });
      }
      if (granted.length) {
        await prisma.user.update({ where: { id: row.id }, data: { permissions: JSON.stringify(perms) } });
        forgetSessionUser(row.id);
      }
      await upsertSetting(PLAY_ENABLED_KEY, null, '1');
      invalidatePlatform();
      try { broadcast('capabilities:changed', { at: Date.now() }); } catch (_) { /* догонит опрос */ }
      console.log(`[Play] Платформу включил ${row.symbol || row.id}; выдано: ${granted.join(', ') || 'ничего'}`);
      return res.json({ enabled: true, granted, denied, platform: await platformState() });
    } catch (e: any) {
      return res.status(500).json({ error: 'Не удалось включить платформу', details: e?.message });
    }
  });

  /**
   * Выдать себе управление платформой.
   *
   * Это не «администратор может всё»: право появляется явной записью, с
   * автором и временем, и видно в карточке сотрудника наравне с остальными.
   * Доступ к самим играм при этом не выдаётся — их по-прежнему выдают отдельно.
   *
   * Явный личный запрет не снимается молча: если он стоит, ответ говорит об
   * этом прямо, а снимает его человек в карточке сотрудника.
   */
  app.post('/api/admin/play-diagnostics/bootstrap', async (req: Request, res: Response) => {
    if (!(await isTopAdmin(req))) return res.status(404).json({ error: 'Страница не найдена' });
    try {
      const prisma = getPrisma();
      const user = (req as any).authUser;
      const row = await prisma.user.findUnique({ where: { id: String(user?.id || '') } });
      if (!row) return res.status(404).json({ error: 'Профиль не найден' });

      let perms: Record<string, any> = {};
      try { perms = row.permissions ? JSON.parse(row.permissions) : {}; } catch (_) { perms = {}; }
      const was = perms[PLAY_ADMIN];
      if (was && was.mode === 'DENY') {
        return res.status(409).json({
          error: 'Управление платформой запрещено вам лично. Снимите запрет в карточке сотрудника — '
            + 'молча переписывать чужое решение программа не будет.',
        });
      }

      perms[PLAY_ADMIN] = { enabled: true, until: null, mode: 'ALLOW' };
      await prisma.user.update({
        where: { id: row.id },
        data: { permissions: JSON.stringify(perms) },
      });
      forgetSessionUser(row.id);
      console.log(`[Play] Управление платформой выдано ${row.symbol || row.id} по кнопке диагностики`);
      return res.json({ granted: true });
    } catch (e: any) {
      return res.status(500).json({ error: 'Не удалось выдать право', details: e?.message });
    }
  });
}
