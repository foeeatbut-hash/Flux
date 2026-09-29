import type { Express, Request, Response } from 'express';
import { getPrisma } from '../context.js';

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
          firstProject = await prisma.project.create({ data: { name: 'Общий Проект' } });
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
          firstProject = await prisma.project.create({ data: { name: 'Общий Проект' } });
        }
        projectId = firstProject.id;
      }

      // Create dictionary and its items using Prisma nested writes
      const dictionary = await prisma.dictionary.create({
        data: {
          projectId,
          name,
          items: {
            create: items // expects array of { code, nameRu }
          }
        },
        include: { items: true }
      });
      res.json({ dictionary });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/projects/:projectId/dictionaries/:dictionaryId/items', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    const item = await prisma.dictionaryItem.create({
      data: { ...req.body, dictionaryId: req.params.dictionaryId }
    });
    res.json({ item });
  });

  app.put('/api/dictionaries/items/:itemId', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    const item = await prisma.dictionaryItem.update({
      where: { id: req.params.itemId },
      data: { 
        code: req.body.code, 
        nameRu: req.body.nameRu,
        parentId: req.body.parentId !== undefined ? req.body.parentId : undefined
      }
    });
    res.json({ item });
  });

  app.delete('/api/dictionaries/items/:itemId', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    await prisma.dictionaryItem.delete({ where: { id: req.params.itemId } });
    res.json({ success: true });
  });
}
