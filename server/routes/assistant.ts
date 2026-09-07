import type { Express, Request, Response } from 'express';
import { getPrisma } from '../context.js';
import { ensureTables as ensureDbTables } from '../ddl.js';

/**
 * Сводка проекта для встроенного помощника: одним запросом теги, плоский
 * список оборудования, этапы закупки, дубли, заметки и последние изменения.
 *
 * Вынесено из server.ts как есть: помощник — самостоятельная подсистема, и
 * держать её сборку данных посреди общих маршрутов значило растить файл,
 * который и так самый большой в программе.
 */
export function registerAssistantRoutes(app: Express): void {
  // Агрегатор данных для встроенного локального ассистента: одним запросом
  // отдаёт теги, плоский список оборудования и счётчики по активному проекту
  app.get('/api/assistant/data', async (req: Request, res: Response) => {
    try {
      let projectId = String(req.query.projectId || '');
      if (!projectId || projectId === 'null' || projectId === 'undefined' || projectId === 'default') {
        const firstProject = await getPrisma().project.findFirst();
        projectId = firstProject ? firstProject.id : '';
      }

      const [projects, tags, systems, usersCount, notesCount, foldersCount, filesCount] = await Promise.all([
        getPrisma().project.findMany({ select: { id: true, name: true, status: true } }),
        projectId ? getPrisma().tag.findMany({ where: { projectId } }) : Promise.resolve([]),
        projectId ? getPrisma().equipmentSystem.findMany({
          where: { projectId },
          include: { monoblocks: { include: { components: { include: { tags: true } } } } }
        }) : Promise.resolve([]),
        getPrisma().user.count(),
        getPrisma().userNote.count({ where: { OR: [{ ownerId: (req as any).authUser?.id || '' }, { ownerId: null }] } }),
        projectId ? getPrisma().folder.count({ where: { projectId } }) : Promise.resolve(0),
        projectId ? getPrisma().fileNode.count({ where: { folder: { projectId } } }) : Promise.resolve(0),
      ]);

      // Плоские характеристики компонента из JSON specs (для ответов «какой расход у …»).
      // Держим до 120 штук на позицию, но честно возвращаем, сколько их всего:
      // молча обрезанный список выглядел бы как «у этой позиции больше ничего
      // нет», а на настоящем бланке клапана параметров под сорок, у установки —
      // за сотню, и обрыв заметили бы не сразу.
      const SPEC_LIMIT = 120;
      const flattenSpecs = (raw: string | null): {
        list: { key: string; value: string; unit: string; group: string }[]; total: number;
      } => {
        if (!raw) return { list: [], total: 0 };
        try {
          const parsed = JSON.parse(raw);
          const groups = Array.isArray(parsed?.groups) ? parsed.groups : [];
          const out: { key: string; value: string; unit: string; group: string }[] = [];
          let total = 0;
          for (const g of groups) {
            for (const p of (g?.params || [])) {
              if (!p?.key || p?.value === undefined) continue;
              total++;
              if (out.length < SPEC_LIMIT) {
                out.push({ key: String(p.key), value: String(p.value ?? ''), unit: String(p.unit ?? ''), group: String(g.title || '') });
              }
            }
          }
          return { list: out, total };
        } catch { return { list: [], total: 0 }; }
      };

      // Плоский список компонентов оборудования с привязанными тегами
      const components: any[] = [];
      for (const sys of systems as any[]) {
        for (const mono of (sys.monoblocks || [])) {
          for (const comp of (mono.components || [])) {
            components.push({
              id: comp.id,
              name: comp.name,
              itemCode: comp.itemCode,
              systemName: sys.name,
              category: sys.category,
              monoblockName: mono.name,
              status: comp.status,
              hasConflict: comp.hasConflict,
              tags: (comp.tags || []).map((t: any) => t.identifier),
              ...(() => { const f = flattenSpecs(comp.specs); return { specs: f.list, specsTotal: f.total }; })(),
            });
          }
        }
      }

      // Настроенные этапы закупки (для ответов «на каком этапе…»)
      let stages: { id: string; label: string }[] = [
        { id: 'added', label: 'Добавлен' }, { id: 'ordered', label: 'Заказан' },
        { id: 'approved', label: 'Утверждён' }, { id: 'purchased', label: 'Куплен' },
      ];
      try {
        const stSetting = await getPrisma().appSetting.findFirst({ where: { key: 'procurement_stages', userId: null } });
        if (stSetting?.value) {
          const parsed = JSON.parse(stSetting.value);
          if (Array.isArray(parsed) && parsed.length) stages = parsed.map((s: any) => ({ id: s.id, label: s.label }));
        }
      } catch (_) {}
      const stageIds = stages.map(s => s.id);

      // Разбор metadata тега: актуальность (по descriptions) и этап закупки (procurement)
      const parseTagMeta = (t: any) => { try { return t.metadata ? JSON.parse(t.metadata) : {}; } catch { return {}; } };
      const actualityOf = (meta: any): string => {
        const d = Array.isArray(meta?.descriptions) ? meta.descriptions : [];
        if (d.length === 0) return 'draft';
        if (d.some((x: any) => x.status === 'critical')) return 'critical';
        if (d.some((x: any) => x.status === 'warning')) return 'warning';
        if (d.some((x: any) => x.status === 'info')) return 'info';
        if (d.some((x: any) => x.status === 'actual')) return 'actual';
        return 'draft';
      };

      const enrichedTags = (tags as any[]).map((t: any) => {
        const meta = parseTagMeta(t);
        const proc = meta.procurement || {};
        let stageIdx = proc.stage ? stageIds.indexOf(proc.stage) : 0;
        if (stageIdx < 0) stageIdx = 0;
        // Дата, с которой позиция стоит на текущем этапе: по ней помощник
        // отвечает на «что зависло» — это главный вопрос по закупкам.
        const curStageId = stages[stageIdx]?.id;
        const stageRec = curStageId ? (proc.stageLog || {})[curStageId] : null;
        return {
          id: t.id, identifier: t.identifier, brand: t.brand,
          department: t.department, wbs: t.wbs, fluid: t.fluid,
          mainName: meta.mainName || '',
          actuality: actualityOf(meta),
          stageId: stages[stageIdx]?.id || 'added',
          stageLabel: stages[stageIdx]?.label || 'Добавлен',
          stageSince: stageRec?.at || t.createdAt || null,
          stageIsFinal: stageIdx >= stages.length - 1,
          supplier: proc.supplier || '', qty: proc.qty || '',
        };
      });

      // Дубликаты кодов тегов
      const codeCounts: Record<string, string[]> = {};
      for (const t of enrichedTags) {
        const code = (t.identifier || '').trim();
        if (code) (codeCounts[code] = codeCounts[code] || []).push(t.id);
      }
      const duplicates = Object.entries(codeCounts)
        .filter(([, ids]) => ids.length > 1)
        .map(([code, ids]) => ({ code, count: ids.length, ids }));

      const criticalCount = enrichedTags.filter(t => t.actuality === 'critical').length;
      const warningCount = enrichedTags.filter(t => t.actuality === 'warning').length;

      // Заметки (только заголовки) и последние изменения (логи)
      const [notesList, recentLogs] = await Promise.all([
        // Только свои заметки и старые общие: помощник не должен показывать
        // заголовки чужих личных записей.
        getPrisma().userNote.findMany({
          where: { OR: [{ ownerId: (req as any).authUser?.id || '' }, { ownerId: null }] },
          select: { id: true, title: true, updatedAt: true }, orderBy: { updatedAt: 'desc' }, take: 40,
        }),
        getPrisma().systemChangeLog.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
      ]);

      res.json({
        projectId,
        projects,
        tags: enrichedTags,
        components,
        stages,
        duplicates,
        notes: (notesList as any[]).map((n: any) => ({ id: n.id, title: n.title, updatedAt: n.updatedAt })),
        recentLogs: (recentLogs as any[]).map((l: any) => ({ description: l.description, userName: l.userName, targetRoute: l.targetRoute, createdAt: l.createdAt })),
        counts: {
          tags: enrichedTags.length,
          components: components.length,
          systems: (systems as any[]).length,
          users: usersCount,
          notes: notesCount,
          folders: foldersCount,
          files: filesCount,
          projects: (projects as any[]).length,
          duplicates: duplicates.length,
          critical: criticalCount,
          warning: warningCount,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── История разговоров ───────────────────────────────────────────────────
  //
  // Разговор — личная переписка. Правило одно и без исключений: человек видит
  // только свои разговоры, и администратор тоже. Поэтому владелец не приходит
  // из тела запроса и не выбирается — он всегда берётся из входа, а каждый
  // запрос к отдельному разговору сверяет владельца ещё раз. Без второй сверки
  // достаточно было бы подставить чужой идентификатор в адрес.
  //
  // Так же сказано и в интерфейсе: без этой строчки спрашивать будут с
  // оглядкой, а помощник, которому не задают вопросов, бесполезен.

  const meIdOf = (req: Request): string => String((req as any).authUser?.id || '');

  // Таблицы для PostgreSQL и MariaDB (в SQLite их строит server.ts)
  // Подстраховка на случай, когда автомиграция не отработала. SQL — под движок
  // базы (server/ddl.ts): PostgreSQL-синтаксис на MariaDB падает всегда
  let ensured = false;
  const ensureTables = async (): Promise<void> => {
    if (ensured) return;
    const prisma = getPrisma();
    try {
      await prisma.assistantChat.count();
      ensured = true;
    } catch (_) {
      const why = await ensureDbTables(prisma, [{
        table: 'AssistantChat',
        cols: [
          { name: 'id', kind: 'text', pk: true },
          { name: 'ownerId', kind: 'text', notNull: true, def: '', indexed: true },
          { name: 'projectId', kind: 'text', notNull: true, def: '', indexed: true },
          { name: 'title', kind: 'text', notNull: true, def: '' },
          { name: 'preview', kind: 'text', notNull: true, def: '' },
          { name: 'messages', kind: 'longtext', notNull: true },
          { name: 'search', kind: 'longtext', notNull: true },
          { name: 'createdAt', kind: 'time', notNull: true, def: 'now' },
          { name: 'updatedAt', kind: 'time', notNull: true, def: 'now' },
        ],
        indexes: [{ name: 'AssistantChat_owner_project_idx', cols: ['ownerId', 'projectId'] }],
      }], (m) => console.error('[Помощник]', m));
      if (!why) ensured = true;
    }
  };


  /** Список разговоров: только свои, свежие сверху, без тел реплик */
  app.get('/api/assistant/chats', async (req: Request, res: Response) => {
    try {
      await ensureTables();
      const me = meIdOf(req);
      if (!me) return res.json({ chats: [] });
      const projectId = String(req.query.projectId || '');
      const q = String(req.query.q || '').trim().toLowerCase();
      const rows = await getPrisma().assistantChat.findMany({
        where: {
          ownerId: me,
          ...(projectId ? { projectId } : {}),
          // Поиск идёт по всем репликам: нужное слово чаще во второй, а имя
          // разговора — только первая фраза
          ...(q ? { search: { contains: q } } : {}),
        },
        orderBy: { updatedAt: 'desc' },
        take: 200,
        select: { id: true, title: true, preview: true, projectId: true, createdAt: true, updatedAt: true },
      });
      res.json({ chats: rows });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** Один разговор целиком — только свой */
  app.get('/api/assistant/chats/:id', async (req: Request, res: Response) => {
    try {
      await ensureTables();
      const me = meIdOf(req);
      const row = await getPrisma().assistantChat.findUnique({ where: { id: req.params.id } });
      if (!row || row.ownerId !== me) return res.status(404).json({ error: 'Разговор не найден' });
      res.json({ chat: row });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * Записать разговор. Один адрес и на создание, и на обновление: разговор
   * заводится в окне помощника и сохраняется по ходу дела, а не кнопкой, —
   * поэтому клиент присылает свой идентификатор и не ждёт ответа, чтобы
   * продолжить писать.
   */
  app.put('/api/assistant/chats/:id', async (req: Request, res: Response) => {
    try {
      await ensureTables();
      const me = meIdOf(req);
      if (!me) return res.status(401).json({ error: 'Нужен вход' });
      const id = String(req.params.id);
      const title = String(req.body?.title || '').slice(0, 200);
      const preview = String(req.body?.preview || '').slice(0, 200);
      const messages = String(req.body?.messages || '[]');
      const search = String(req.body?.search || '').slice(0, 8000);
      const projectId = String(req.body?.projectId || '');

      const existing = await getPrisma().assistantChat.findUnique({ where: { id } });
      if (existing && existing.ownerId !== me) return res.status(403).json({ error: 'Чужой разговор' });
      const chat = existing
        ? await getPrisma().assistantChat.update({ where: { id }, data: { title, preview, messages, search, projectId } })
        : await getPrisma().assistantChat.create({ data: { id, ownerId: me, projectId, title, preview, messages, search } });
      res.json({ chat: { id: chat.id, title: chat.title, updatedAt: chat.updatedAt } });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/assistant/chats/:id', async (req: Request, res: Response) => {
    try {
      await ensureTables();
      const me = meIdOf(req);
      const row = await getPrisma().assistantChat.findUnique({ where: { id: req.params.id } });
      if (!row || row.ownerId !== me) return res.status(404).json({ error: 'Разговор не найден' });
      await getPrisma().assistantChat.delete({ where: { id: row.id } });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

}
