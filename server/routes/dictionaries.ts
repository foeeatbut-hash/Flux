import type { Express, Request, Response } from 'express';
import { getPrisma } from '../context.js';
import { getDialect } from '../ddl.js';
import { nextFieldId, nextProjectEntityId, nextProjectId } from '../entityIds.js';

// Шаблон тегов проекта и словари (справочники значений) с их позициями.
//
// Вынесено из server.ts вместе с tags.ts: раньше всё это шло одним куском
// «Registry (Equipment & Tags)».

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

  app.put('/api/projects/:projectId/tag-template', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    const { projectId } = req.params;
    const { schemaJson } = req.body;
    const template = await prisma.tagTemplate.upsert({
      where: { projectId },
      create: { projectId, schemaJson },
      update: { schemaJson }
    });
    res.json({ template });
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
      res.json({ dictionary });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/projects/:projectId/dictionaries/:dictionaryId/items', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    const item = await prisma.$transaction(async (tx: any) => {
      const dictionary = await tx.dictionary.findUnique({ where: { id: req.params.dictionaryId }, select: { projectId: true, name: true } });
      if (!dictionary) throw new Error('Справочник не найден');
      const data = { ...req.body, dictionaryId: req.params.dictionaryId };
      const item = await tx.dictionaryItem.create({
        data: { ...data, id: await nextFieldId(tx, dictionary.projectId, dictionary.name === '__tag_creation_config__' && !data.parentId, { inTransaction: true }) },
      });
      return item;
    });
    res.json({ item });
  });

  app.put('/api/dictionaries/items/:itemId', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    class RenameConflict extends Error {}
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const item = await prisma.$transaction(async (tx: any) => {
          const before = await tx.dictionaryItem.findUnique({
            where: { id: req.params.itemId },
            include: { dictionary: { select: { name: true, projectId: true } } },
          });
          if (!before) return null;

          const renamedCategory = before.dictionary.name === '__tag_creation_config__'
            && !before.parentId
            && req.body.nameRu !== undefined
            && req.body.nameRu !== before.nameRu;
          // Снимок прежних значений защищает категорию от одновременного переименования.
          const changed = await tx.dictionaryItem.updateMany({
            where: { id: before.id, code: before.code, nameRu: before.nameRu, parentId: before.parentId },
            data: {
              code: req.body.code,
              nameRu: req.body.nameRu,
              parentId: req.body.parentId !== undefined ? req.body.parentId : undefined,
            },
          });
          if (changed.count !== 1) throw new RenameConflict('Dictionary item changed concurrently');

          if (renamedCategory) {
            const tags = await tx.tag.findMany({ where: { projectId: before.dictionary.projectId }, select: { id: true, metadata: true } });
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
              const saved = await tx.tag.updateMany({ where: { id: tag.id, metadata: tag.metadata }, data: { metadata: migrated } });
              if (saved.count !== 1) throw new RenameConflict('Tag metadata changed concurrently');
            }
          }
          return tx.dictionaryItem.findUnique({ where: { id: before.id } });
        }, getDialect() === 'sqlite' ? undefined : { isolationLevel: 'Serializable' });
        if (!item) return res.status(404).json({ error: 'Пункт справочника не найден' });
        return res.json({ item });
      } catch (error: any) {
        if (error instanceof RenameConflict) return res.status(409).json({ error: 'Данные изменились. Обновите справочник и повторите правку.' });
        if (error?.code === 'P2034' && attempt < 2) continue;
        throw error;
      }
    }
    return res.status(409).json({ error: 'Данные изменились. Обновите справочник и повторите правку.' });
  });

  app.delete('/api/dictionaries/items/:itemId', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    await prisma.dictionaryItem.delete({ where: { id: req.params.itemId } });
    res.json({ success: true });
  });
}
