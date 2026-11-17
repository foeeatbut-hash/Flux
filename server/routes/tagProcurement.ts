import type { Express, Request, Response } from 'express';
import { getPrisma } from '../context.js';
import { emitEntityChanged } from '../entityChanged.js';
import { writeTag, tagWriteFailure, TagBadRequest } from '../tagWrite.js';
import { sendGuardRefusal } from '../versionGuard.js';
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
 * Право — `procurement.manage` (server/permRoutes.ts): правило стоит выше общего правила
 * тегов, так что для записи закупки право на правку тегов не нужно, а одного права на
 * закупки достаточно. То же у `PUT /api/tags/bulk-metadata` с `source: 'Закупки'`.
 * Доступ к проекту тега проверяет общий страж по адресу (projectEntityAccess.ts).
 *
 * Версия (`version` — updatedAt, как его прочитал экран) сверяется: тег
 * изменился — 409 `VERSION_CONFLICT` и текущий тег в `current`, тега нет — 404
 * `RECORD_GONE`; экран показывает, что изменили, и перечитывает.
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
      const { tag, unchanged } = await writeTag(prisma, String(req.params.id), {
        metadata: { procurement: procurementOf(procurement) },
        onlyKeys: ['procurement'],
        version: version === undefined ? undefined : (version === null ? null : String(version)),
      }, {
        // История — в транзакции записи: не записалась она, не записалась и правка закупки
        record: async (tx, r) => { if (!r.unchanged) await recordTagUpdate(tx, tagChangeContext(req, r.tag.projectId, TAG_SOURCE.procurement), r.before, r.tag); },
      });
      if (!unchanged) emitEntityChanged('tag', tag.id, req);
      res.json({ tag });
    } catch (err: any) {
      if (sendGuardRefusal(res, err)) return;
      const known = tagWriteFailure(err);
      if (known) return res.status(known.status).json(known.body);
      res.status(500).json({ error: err?.message || 'Не удалось сохранить закупку' });
    }
  });
}
