import type { Express, Request, Response } from 'express';
import { getPrisma } from '../context.js';
import { getDialect } from '../ddl.js';
import { nextFieldId, nextProjectEntityId, nextProjectId } from '../entityIds.js';
import { emitProjectDataChanged } from '../entityChanged.js';
import {
  VersionConflict, expectedVersionOf, guardedWrite, guardedDelete, sendRecordGone, sendGuardRefusal,
} from '../versionGuard.js';
import { badVersion } from '../equipmentStale.js';
import { editChangedText, deleteChangedText, racedText } from '../../src/lib/refusalTexts.js';

// Шаблон тегов проекта и словари (справочники значений) с их позициями.
//
// Вынесено из server.ts вместе с tags.ts: раньше всё это шло одним куском
// «Registry (Equipment & Tags)».

// Справочник читают чужие окна: «Теги» строят по нему строку создания и «Подбор».
// Событие проектное и без содержимого — окно само перечитывает свой список.
const announce = (projectId: string | undefined | null, req: Request) => {
  if (projectId) emitProjectDataChanged('dictionary', projectId, { userId: String((req as any).authUser?.id || '') });
};

export function registerDictionaryRoutes(app: Express): void {
  // Registry (Equipment & Tags)
  // Маршрут «/api/equipment» убран: он отдавал оборудование ВСЕХ проектов сразу,
  // без отбора по проекту и без учёта того, кто спрашивает. Раздел «Оборудование»
  // им никогда не пользовался — он берёт системы своего проекта
  // (/api/projects/:id/systems), — так что это была не возможность, а дыра,
  // которая ждала, пока её кто-нибудь позовёт.

  // Tag Template
  app.get('/api/projects/:projectId/tag-template', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    const { projectId } = req.params;
    const template = await prisma.tagTemplate.findUnique({ where: { projectId } });
    res.json({ template });
  });

  // Шаблон тегов под версией: есть — сверка `expectedVersion` из тела и запись «сравни и
  // поменяй» (чужая версия — 409 `VERSION_CONFLICT` с `current`); нет — создание. Версия
  // пришла, а шаблона уже нет — 404 `RECORD_GONE`: правке нечего менять, создавать вслепую
  // по устаревшему виду нельзя. Ответ отдаёт `version`.
  app.put('/api/projects/:projectId/tag-template', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    const { projectId } = req.params;
    const { schemaJson } = req.body;
    try {
      const expectedVersion = expectedVersionOf(req.body?.expectedVersion);
      if (expectedVersion === null) return badVersion(res);
      for (let attempt = 0; ; attempt++) {
        const existing = await prisma.tagTemplate.findUnique({ where: { projectId } });
        if (existing) {
          const done = await guardedWrite(prisma, {
            model: 'tagTemplate', id: existing.id, expectedVersion, goneNoun: 'tagTemplate',
            staleMessage: () => editChangedText('tagTemplate'),
            build: () => ({ data: { schemaJson } }),
          });
          // Шаблон исчез между чтением и записью: с версией — отказ, без неё — повтор (создание)
          if (!done) {
            if (expectedVersion !== undefined) return sendRecordGone(res, 'tagTemplate');
            continue;
          }
          return res.json({ template: done.after });
        }
        if (expectedVersion !== undefined) return sendRecordGone(res, 'tagTemplate');
        try {
          const template = await prisma.tagTemplate.create({ data: { projectId, schemaJson } });
          return res.json({ template });
        } catch (e: any) {
          // Второе окно создало шаблон первым (projectId уникален): повторяем уже как правку
          const taken = e?.code === 'P2002' || /unique constraint|duplicate/i.test(String(e?.message || ''));
          if (!taken || attempt >= 2) throw e;
        }
      }
    } catch (err: any) {
      if (sendGuardRefusal(res, err)) return;
      res.status(500).json({ error: err.message });
    }
  });

  // Dictionaries
  app.get('/api/projects/:projectId/dictionaries', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    let { projectId } = req.params;
    try {
      if (!projectId || projectId === 'null' || projectId === 'undefined' || projectId === 'default') {
        let firstProject = await prisma.project.findFirst();
        if (!firstProject) {
          firstProject = await prisma.project.create({ data: { id: await nextProjectId(prisma), name: 'Общий Проект' } });
        }
        projectId = firstProject.id;
      }
      const dictionaries = await prisma.dictionary.findMany({
        where: { projectId },
        include: { items: true }
      });
      res.json({ dictionaries });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/projects/:projectId/dictionaries', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    let { projectId } = req.params;
    const { name, items } = req.body;
  
    try {
      if (!projectId || projectId === 'null' || projectId === 'undefined' || projectId === 'default') {
        let firstProject = await prisma.project.findFirst();
        if (!firstProject) {
          firstProject = await prisma.project.create({ data: { id: await nextProjectId(prisma), name: 'Общий Проект' } });
        }
        projectId = firstProject.id;
      }

      // Create dictionary and its items using Prisma nested writes
      const dictionary = await prisma.$transaction(async (tx: any) => {
        const dictionaryId = await nextProjectEntityId(tx, projectId, 'DICT', { inTransaction: true });
        const safeItems = (Array.isArray(items) ? items : []).map((item: any) => ({
          ...item,
          id: undefined,
        }));
        const itemData = [];
        for (const item of safeItems) {
          itemData.push({
            ...item,
            id: await nextFieldId(tx, projectId, name === '__tag_creation_config__' && !item.parentId, { inTransaction: true }),
          });
        }
        return tx.dictionary.create({
          data: { id: dictionaryId, projectId, name, items: { create: itemData } },
          include: { items: true },
        });
      });
      announce(projectId, req);
      res.json({ dictionary });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Пункт в справочник, которого уже нет (удалили вместе с проектом), — 404 `RECORD_GONE`, а не 500
  app.post('/api/projects/:projectId/dictionaries/:dictionaryId/items', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const item = await prisma.$transaction(async (tx: any) => {
        const dictionary = await tx.dictionary.findUnique({ where: { id: req.params.dictionaryId }, select: { projectId: true, name: true } });
        if (!dictionary) return null;
        const data = { ...req.body, dictionaryId: req.params.dictionaryId };
        return tx.dictionaryItem.create({
          data: { ...data, id: await nextFieldId(tx, dictionary.projectId, dictionary.name === '__tag_creation_config__' && !data.parentId, { inTransaction: true }) },
        });
      });
      if (!item) return sendRecordGone(res, 'dictionary', { inside: true });
      announce(req.params.projectId, req);
      res.json({ item });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Правка пункта под сверкой версии (`expectedVersion` в теле): чужая версия — 409
  // `VERSION_CONFLICT` с `current`, пункта нет — 404 `RECORD_GONE`. Переименование категории
  // переносит значения в тегах по её id в той же транзакции (`after`); значение тега,
  // записанное другим редактором после чтения, переносу не мешает и не затирается:
  // сравнение снимка — повтор (как при P2034 на серверных базах), а не потеря.
  class MetadataRaced extends Error {}
  app.put('/api/dictionaries/items/:itemId', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const expectedVersion = expectedVersionOf(req.body?.expectedVersion);
      if (expectedVersion === null) return badVersion(res);
      let projectOfItem: string | undefined;
      let dictionaryName = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const done = await guardedWrite(prisma, {
            model: 'dictionaryItem', id: req.params.itemId, expectedVersion, goneNoun: 'dictionaryItem',
            staleMessage: (current) => editChangedText('dictionaryItem', current?.nameRu),
            transaction: getDialect() === 'sqlite' ? undefined : { isolationLevel: 'Serializable' },
            build: async (current: any, db: any) => {
              const dictionary = await db.dictionary.findUnique({ where: { id: current.dictionaryId }, select: { name: true, projectId: true } });
              projectOfItem = dictionary?.projectId;
              dictionaryName = dictionary?.name || '';
              return {
                data: {
                  code: req.body.code,
                  nameRu: req.body.nameRu,
                  parentId: req.body.parentId !== undefined ? req.body.parentId : undefined,
                },
              };
            },
            after: async (db: any, before: any) => {
              const renamedCategory = dictionaryName === '__tag_creation_config__'
                && !before.parentId
                && req.body.nameRu !== undefined
                && req.body.nameRu !== before.nameRu;
              if (!renamedCategory || !projectOfItem) return;
              const tags = await db.tag.findMany({ where: { projectId: projectOfItem }, select: { id: true, metadata: true } });
              for (const tag of tags) {
                if (!tag.metadata) continue;
                let metadata: any;
                try { metadata = JSON.parse(tag.metadata); } catch { continue; }
                if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue;
                const fields = metadata.dynamicFields;
                if (!fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
                // ID уже содержит более новое значение — оно главнее. Старый ключ
                // намеренно оставляем: обмен и прежние клиенты могут его ещё читать.
                if (fields[before.id] !== undefined || fields[before.nameRu] === undefined) continue;
                const migrated = JSON.stringify({ ...metadata, dynamicFields: { ...fields, [before.id]: fields[before.nameRu] } });
                // Сравнение снимка защищает значение, записанное другим редактором после чтения.
                const saved = await db.tag.updateMany({ where: { id: tag.id, metadata: tag.metadata }, data: { metadata: migrated } });
                if (saved.count !== 1) throw new MetadataRaced('Tag metadata changed concurrently');
              }
            },
          });
          if (!done) return sendRecordGone(res, 'dictionaryItem');
          announce(projectOfItem, req);
          return res.json({ item: done.after });
        } catch (error: any) {
          if ((error instanceof MetadataRaced || error?.code === 'P2034') && attempt < 2) continue;
          if (error instanceof MetadataRaced || error?.code === 'P2034') {
            const fresh = await prisma.dictionaryItem.findUnique({ where: { id: req.params.itemId } }).catch(() => null);
            throw new VersionConflict(racedText(), fresh);
          }
          throw error;
        }
      }
      return res.status(500).json({ error: 'Правка пункта не выполнена' });
    } catch (err: any) {
      if (sendGuardRefusal(res, err)) return;
      res.status(500).json({ error: err.message });
    }
  });

  /** Все потомки пункта (дети, их дети…), без самого пункта. Читать — только через `db` транзакции. */
  async function descendantsOf(db: any, itemId: string): Promise<Array<{ id: string; nameRu: string }>> {
    const out: Array<{ id: string; nameRu: string }> = [];
    const seen = new Set<string>([itemId]);
    let level = [itemId];
    while (level.length && out.length < 100000) {
      const next: Array<{ id: string; nameRu: string }> = await db.dictionaryItem.findMany({ where: { parentId: { in: level } }, select: { id: true, nameRu: true } });
      level = [];
      for (const row of next) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        out.push(row);
        level.push(row.id);
      }
    }
    return out;
  }

  // Удаление пункта под сверкой версии (`?expectedVersion=`). Пункт и все его потомки не
  // должны быть открыты у коллеги (409 `RECORD_OPEN`); потомки снимаются в той же
  // транзакции, что и пункт: не снялись они — не удалился и он. Значения в тегах, записанные
  // по id пункта, остаются как есть. Повторное удаление — 200 `alreadyGone`.
  app.delete('/api/dictionaries/items/:itemId', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const expectedVersion = expectedVersionOf(req.query.expectedVersion);
      if (expectedVersion === null) return badVersion(res);
      let projectOfItem: string | undefined;
      const gone = await guardedDelete(prisma, {
        model: 'dictionaryItem', id: req.params.itemId, expectedVersion,
        staleMessage: (current) => deleteChangedText('dictionaryItem', current?.nameRu),
        openCheck: {
          userId: String((req as any).authUser?.id || ''),
          nameOf: (row: any) => String(row?.nameRu || '').trim(),
          cascade: async (db: any, current: any) => (await descendantsOf(db, current.id)).map((d) => ({ model: 'DictionaryItem', id: d.id, name: String(d.nameRu || '').trim() })),
        },
        // Потомков снимаем явно: в локальной SQLite таблицы заведены без внешних
        // ключей, и «каскад» схемы не срабатывает — варианты удалённой категории
        // оставались в базе сиротами, хотя экран обещает удалить их вместе с ней.
        before: async (db: any, current: any) => {
          const owner = await db.dictionary.findUnique({ where: { id: current.dictionaryId }, select: { projectId: true } });
          projectOfItem = owner?.projectId;
          const doomed = (await descendantsOf(db, current.id)).map((d) => d.id);
          for (let i = 0; i < doomed.length; i += 400) await db.dictionaryItem.deleteMany({ where: { id: { in: doomed.slice(i, i + 400) } } });
        },
      });
      if (!gone) return res.json({ success: true, alreadyGone: true });
      announce(projectOfItem, req);
      res.json({ success: true });
    } catch (err: any) {
      if (sendGuardRefusal(res, err)) return;
      res.status(500).json({ error: err.message });
    }
  });
}
