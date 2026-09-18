import type { Express, Request, Response } from 'express';
import { getPrisma, sendError } from '../context.js';

/**
 * Правка реестра оборудования вручную: удаление лишней позиции.
 *
 * Импорт бланка иногда заводит то, чего в проекте нет: строку примечания
 * приняли за изделие, лишний раз загрузили тот же файл, или человек просто
 * ошибся. До сих пор убрать можно было только узел целиком — вместе со всем
 * его оборудованием, — и ради одной лишней строки люди сносили установку и
 * импортировали её заново.
 *
 * Отдельным модулем, а не в server.ts: тот у предела размера, а правка реестра
 * будет обрастать (переименование, перенос между узлами) и должна жить там,
 * где её видно.
 */

const authUserOf = (req: Request) => (req as any).authUser || null;

export function registerEquipmentEditRoutes(app: Express): void {
  /**
   * Удалить позицию оборудования.
   *
   * Теги НЕ удаляются вместе с ней. Тег — адрес позиции в проекте, он живёт в
   * своём реестре и может быть переиспользован; удалить его вместе с изделием
   * значило бы потерять адрес, на который ссылаются документы и переписка.
   * Связь просто снимается, и тег остаётся свободным.
   *
   * Предупреждение о связях считается ДО удаления и возвращается вызывающему:
   * узнать, что позиция была привязана к трём документам, после того как её не
   * стало, — бесполезно.
   */
  app.delete('/api/equipment/component/:id', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const me = authUserOf(req);
      const found = await prisma.componentElement.findUnique({
        where: { id: req.params.id },
        include: {
          tags: { select: { id: true, identifier: true } },
          monoblock: { select: { id: true, name: true, systemId: true } },
        },
      });
      if (!found) return res.json({ ok: true, alreadyGone: true });

      const tags = (found.tags || []).map((t: any) => t.identifier);

      await prisma.$transaction(async (tx: any) => {
        // Сначала снимаем теги: иначе удаление позиции унесло бы связь молча,
        // и тег остался бы числиться занятым
        if (found.tags?.length) {
          await tx.componentElement.update({
            where: { id: found.id },
            data: { tags: { disconnect: found.tags.map((t: any) => ({ id: t.id })) } },
          });
        }
        await tx.componentElement.delete({ where: { id: found.id } });
      });

      // Удаление реестра — событие, которое должно быть видно: кто и что убрал
      try {
        await prisma.systemChangeLog.create({
          data: {
            userName: me?.name || 'Неизвестно',
            userSymbol: me?.symbol || '',
            description: `Удалена позиция «${found.name || found.itemCode}»`
              + (found.monoblock?.name ? ` из «${found.monoblock.name}»` : '')
              + (tags.length ? `; освобождены теги: ${tags.join(', ')}` : ''),
            targetRoute: found.monoblock?.systemId ? `/equipment?system=${found.monoblock.systemId}` : '/equipment',
          },
        });
      } catch (_) { /* журнал не обязан существовать, удаление уже состоялось */ }

      res.json({ ok: true, name: found.name, itemCode: found.itemCode, freedTags: tags });
    } catch (err: any) { sendError(res, err); }
  });

  /**
   * Что потянет за собой удаление — спрашивается до него.
   *
   * Отдельным запросом, потому что предупреждение показывается в диалоге
   * подтверждения: «у позиции два тега и она в трёх документах» меняет решение
   * человека, а после удаления эта же строка бесполезна.
   */
  app.get('/api/equipment/component/:id/links', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const found = await prisma.componentElement.findUnique({
        where: { id: req.params.id },
        include: { tags: { select: { identifier: true } } },
      });
      if (!found) return res.status(404).json({ error: 'Позиция не найдена' });
      res.json({
        name: found.name,
        itemCode: found.itemCode,
        tags: (found.tags || []).map((t: any) => t.identifier),
      });
    } catch (err: any) { sendError(res, err); }
  });
}
