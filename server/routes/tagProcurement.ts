import type { Express, Request, Response } from 'express';
import { getPrisma } from '../context.js';
import { emitEntityChanged } from '../entityChanged.js';
import { writeTag, tagWriteFailure, TagBadRequest } from '../tagWrite.js';
import { TAG_SOURCE, tagChangeContext, recordTagUpdate } from '../tagHistory.js';

/**
 * «Закупки» пишут в тег только свою часть.
 *
 * Раньше экран присылал `PUT /api/tags/:id` с metadata целиком, собранной по
 * копии тега при открытии экрана, — и комментарий, который коллега добавил в
 * «Тегах» за это время, молча стирался при смене этапа. Здесь меняется один
 * ключ, `procurement`, а всё остальное в теге остаётся как есть, даже если экран
 * прислал лишнее: «Закупки» не вправе править комментарии, положение карточки и
 * связи.
 *
 * Права — те же, что у прежней записи закупки: `PATCH /api/tags/…` в таблице
 * маршрутов server.ts требует `tags.manage`, а доступ к проекту тега проверяет
 * общий страж по адресу (projectEntityAccess.ts). Отдельного права на сервере у
 * `procurement.manage` нет — оно только в каталоге; заводить его здесь значило
 * бы молча отнять запись у тех, кто пишет сегодня.
 *
 * Версия (`version` — updatedAt, как его прочитал экран) сверяется: тег
 * изменился — 409 и текущий тег, экран перечитывает и говорит человеку.
 */

/** Закупка — объект с этапами, поставщиком, количеством; массив или строка — ошибка экрана. */
function procurementOf(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TagBadRequest('procurement должен быть объектом');
  return raw as Record<string, unknown>;
}

export function registerTagProcurementRoutes(app: Express): void {
  app.patch('/api/tags/:id/procurement', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const { procurement, version } = req.body || {};
      const { before, tag, unchanged } = await writeTag(prisma, String(req.params.id), {
        metadata: { procurement: procurementOf(procurement) },
        onlyKeys: ['procurement'],
        version: version === undefined ? undefined : (version === null ? null : String(version)),
      });
      if (!unchanged) {
        await recordTagUpdate(prisma, tagChangeContext(req, tag.projectId, TAG_SOURCE.procurement), before, tag);
        emitEntityChanged('tag', tag.id, req);
      }
      res.json({ tag });
    } catch (err: any) {
      const known = tagWriteFailure(err);
      if (known) return res.status(known.status).json(known.body);
      res.status(500).json({ error: err?.message || 'Не удалось сохранить закупку' });
    }
  });
}
