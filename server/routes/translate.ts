import type { Express, Request, Response } from 'express';
import { getPrisma, resolveProjectId, sendError } from '../context.js';
import { intParam } from '../queryParams.js';
import { normKey } from '../../src/translate/segment.js';
import { parseTmx, buildTmx } from '../../src/translate/tmx.js';

// ── Перевод: глоссарий и память переводов ──
// Дизайн: docs/translator-design.md.
//
// Память первична. Всё, что инженер подтвердил, ложится сюда посегментно и
// живёт дольше документа, из которого пришло: следующая ревизия и следующий
// заказ переводятся уже его словами, а не заново придуманными.
//
// Термины и память лежат отдельно намеренно. Термин — это решение «называем
// так», он редко меняется и его правят руками. Сегмент памяти — след прошлой
// работы, его накапливают тысячами и никогда не правят вручную.

// ── PostgreSQL/MariaDB: ленивое создание таблиц (SQLite строит server.ts) ──
let ensured = false;
async function ensureTables(): Promise<void> {
  if (ensured) return;
  const prisma = getPrisma();
  try {
    await prisma.termEntry.count();
    ensured = true;
  } catch (_) {
    try {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "TermEntry" (
        "id" TEXT NOT NULL PRIMARY KEY, "projectId" TEXT,
        "ru" TEXT NOT NULL DEFAULT '', "en" TEXT NOT NULL DEFAULT '',
        "zh" TEXT NOT NULL DEFAULT '', "note" TEXT NOT NULL DEFAULT '',
        "source" TEXT NOT NULL DEFAULT 'hand', "locked" BOOLEAN NOT NULL DEFAULT false,
        "authorId" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "TmUnit" (
        "id" TEXT NOT NULL PRIMARY KEY, "projectId" TEXT,
        "fromLang" TEXT NOT NULL DEFAULT 'ru', "toLang" TEXT NOT NULL DEFAULT 'en',
        "srcKey" TEXT NOT NULL DEFAULT '', "src" TEXT NOT NULL DEFAULT '',
        "dst" TEXT NOT NULL DEFAULT '', "origin" TEXT NOT NULL DEFAULT 'hand',
        "docId" TEXT, "authorId" TEXT, "usedCount" INTEGER NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "TransLink" (
        "id" TEXT NOT NULL PRIMARY KEY, "projectId" TEXT NOT NULL,
        "sourceDocId" TEXT NOT NULL, "targetDocId" TEXT NOT NULL DEFAULT '',
        "mode" TEXT NOT NULL DEFAULT 'file', "fingerprint" TEXT NOT NULL DEFAULT '',
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      ensured = true;
    } catch (_) { /* следующая попытка на следующем запросе */ }
  }
}

const str = (v: any) => String(v ?? '').trim();
const meOf = (req: Request) => (req as any).authUser || null;

/**
 * Глоссарий проекта отдаётся вместе с общими терминами: общий словарь программы
 * дополняется словарём проекта, а не заменяется им.
 */
async function termsFor(projectId: string) {
  const prisma = getPrisma();
  return prisma.termEntry.findMany({
    where: { OR: [{ projectId }, { projectId: null }] },
    orderBy: { updatedAt: 'desc' },
  });
}

export function registerTranslateRoutes(app: Express): void {
  // ── Глоссарий ──
  app.get('/api/translate/terms', async (req: Request, res: Response) => {
    try {
      await ensureTables();
      const projectId = await resolveProjectId(req.query.projectId as string);
      const q = normKey(str(req.query.q));
      let list = await termsFor(projectId);
      if (q) {
        list = list.filter((t: any) => [t.ru, t.en, t.zh].some((x) => normKey(x).includes(q)));
      }
      res.json({ items: list });
    } catch (err) { sendError(res, err); }
  });

  app.post('/api/translate/terms', async (req: Request, res: Response) => {
    try {
      await ensureTables();
      const prisma = getPrisma();
      const me = meOf(req);
      const b = req.body || {};
      const ru = str(b.ru); const en = str(b.en);
      if (!ru && !en) return sendError(res, new Error('Термин пуст'), 400);
      const projectId = b.shared ? null : await resolveProjectId(b.projectId);
      const data: any = {
        ru, en, zh: str(b.zh), note: str(b.note),
        source: str(b.source) || 'hand', locked: Boolean(b.locked),
        projectId, authorId: me?.id || null,
      };
      if (b.id) {
        const has = await prisma.termEntry.findUnique({ where: { id: str(b.id) } });
        if (!has) return sendError(res, new Error('Термин не найден'), 404);
        // Согласованный с заказчиком термин не меняем молча: снять замок можно
        // только тем же запросом, явно
        if (has.locked && b.locked !== false) return sendError(res, new Error('Термин закреплён'), 409);
        const item = await prisma.termEntry.update({ where: { id: has.id }, data });
        return res.json({ item });
      }
      const item = await prisma.termEntry.create({ data });
      res.json({ item });
    } catch (err) { sendError(res, err); }
  });

  app.delete('/api/translate/terms/:id', async (req: Request, res: Response) => {
    try {
      await ensureTables();
      const prisma = getPrisma();
      const has = await prisma.termEntry.findUnique({ where: { id: req.params.id } });
      if (!has) return res.json({ ok: true });
      if (has.locked) return sendError(res, new Error('Термин закреплён'), 409);
      await prisma.termEntry.delete({ where: { id: has.id } });
      res.json({ ok: true });
    } catch (err) { sendError(res, err); }
  });

  // ── Память переводов ──
  app.get('/api/translate/memory', async (req: Request, res: Response) => {
    try {
      await ensureTables();
      const prisma = getPrisma();
      const projectId = await resolveProjectId(req.query.projectId as string);
      const fromLang = str(req.query.from) || 'ru';
      const toLang = str(req.query.to) || 'en';
      const limit = intParam(req.query.limit, 5000, 1, 20000);
      const q = normKey(str(req.query.q));
      let items = await prisma.tmUnit.findMany({
        where: { fromLang, toLang, OR: [{ projectId }, { projectId: null }] },
        orderBy: { updatedAt: 'desc' },
        take: limit,
      });
      if (q) items = items.filter((u: any) => normKey(u.src).includes(q) || normKey(u.dst).includes(q));
      res.json({ items });
    } catch (err) { sendError(res, err); }
  });

  /**
   * Запомнить подтверждённые пары. Повторная пара не плодит запись, а обновляет
   * прежнюю: память должна отвечать «как переводим сейчас», а не показывать
   * три варианта одной строки и предлагать угадать.
   */
  app.post('/api/translate/memory', async (req: Request, res: Response) => {
    try {
      await ensureTables();
      const prisma = getPrisma();
      const me = meOf(req);
      const b = req.body || {};
      const projectId = b.shared ? null : await resolveProjectId(b.projectId);
      const units = Array.isArray(b.units) ? b.units : [];
      let added = 0; let updated = 0;
      for (const u of units) {
        const src = str(u.src); const dst = str(u.dst);
        if (!src || !dst) continue;
        const fromLang = str(u.from) || 'ru';
        const toLang = str(u.to) || 'en';
        const srcKey = normKey(src);
        if (!srcKey) continue;
        const has = await prisma.tmUnit.findFirst({ where: { fromLang, toLang, srcKey, projectId } });
        if (has) {
          if (has.dst !== dst) {
            await prisma.tmUnit.update({
              where: { id: has.id },
              data: { dst, src, authorId: me?.id || has.authorId, docId: str(u.docId) || has.docId },
            });
            updated++;
          }
          continue;
        }
        await prisma.tmUnit.create({
          data: {
            projectId, fromLang, toLang, srcKey, src, dst,
            origin: str(u.origin) || 'hand', docId: str(u.docId) || null, authorId: me?.id || null,
          },
        });
        added++;
      }
      res.json({ ok: true, added, updated });
    } catch (err) { sendError(res, err); }
  });

  app.delete('/api/translate/memory/:id', async (req: Request, res: Response) => {
    try {
      await ensureTables();
      const prisma = getPrisma();
      await prisma.tmUnit.deleteMany({ where: { id: req.params.id } });
      res.json({ ok: true });
    } catch (err) { sendError(res, err); }
  });

  /**
   * Засев словаря из собственных данных программы.
   *
   * Пустой глоссарий мёртв, а пары у них уже есть: каждая строка ВДР несёт
   * русское и английское название одного документа, а стандарт — названия
   * типов. Берём только те, где заполнены обе стороны, и не трогаем то, что
   * инженер уже завёл руками.
   */
  app.post('/api/translate/seed', async (req: Request, res: Response) => {
    try {
      await ensureTables();
      const prisma = getPrisma();
      const me = meOf(req);
      const projectId = await resolveProjectId((req.body || {}).projectId);
      const existing = await termsFor(projectId);
      const seen = new Set(existing.map((t: any) => normKey(t.ru)).filter(Boolean));
      const fresh: any[] = [];
      const take = (ru: string, en: string, source: string) => {
        const key = normKey(ru);
        if (!key || !str(en) || seen.has(key)) return;
        seen.add(key);
        fresh.push({ ru: str(ru), en: str(en), zh: '', note: '', source, projectId, authorId: me?.id || null });
      };

      const items = await prisma.docRegisterItem.findMany({
        where: { projectId }, select: { titleRu: true, titleEn: true },
      });
      for (const it of items) take(it.titleRu, it.titleEn, 'vdr');

      const standards = await prisma.docStandard.findMany();
      for (const st of standards) {
        let cfg: any = {};
        try { cfg = JSON.parse(st.config || '{}'); } catch (_) { cfg = {}; }
        for (const t of cfg.vdrTypes || []) take(t.titleRu, t.titleEn, 'standard');
      }

      if (fresh.length) await prisma.termEntry.createMany({ data: fresh });
      res.json({ ok: true, added: fresh.length, fromVdr: items.length });
    } catch (err) { sendError(res, err); }
  });

  // ── Обмен памятью: TMX туда и обратно ──
  app.get('/api/translate/tmx', async (req: Request, res: Response) => {
    try {
      await ensureTables();
      const prisma = getPrisma();
      const projectId = await resolveProjectId(req.query.projectId as string);
      const fromLang = str(req.query.from) || 'ru';
      const toLang = str(req.query.to) || 'en';
      const units = await prisma.tmUnit.findMany({
        where: { fromLang, toLang, OR: [{ projectId }, { projectId: null }] },
        orderBy: { createdAt: 'asc' },
      });
      const xml = buildTmx(units.map((u: any) => ({
        src: u.src, dst: u.dst, from: u.fromLang, to: u.toLang,
      })));
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.send(xml);
    } catch (err) { sendError(res, err); }
  });

  /**
   * Приём чужой памяти. Своё не перетирается: чужой файл — подсказка, а не
   * истина, и молча заменить им подтверждённый перевод значило бы потерять
   * согласованное с заказчиком.
   */
  app.post('/api/translate/import', async (req: Request, res: Response) => {
    try {
      await ensureTables();
      const prisma = getPrisma();
      const me = meOf(req);
      const b = req.body || {};
      const projectId = b.shared ? null : await resolveProjectId(b.projectId);
      const text = String(b.text || '');
      if (!text.trim()) return sendError(res, new Error('Файл пуст'), 400);
      const pairs = /<tmx/i.test(text)
        ? parseTmx(text)
        : text.split('\n').map((line) => {
          const [src, dst] = line.split('\t');
          return {
            src: str(src), dst: str(dst),
            from: (str(b.from) || 'ru') as any, to: (str(b.to) || 'en') as any,
          };
        }).filter((p) => p.src && p.dst);

      const wanted = pairs.filter((p) => p.from === (str(b.from) || 'ru') && p.to === (str(b.to) || 'en'));
      let added = 0; let skipped = 0;
      for (const p of wanted) {
        const srcKey = normKey(p.src);
        if (!srcKey) continue;
        const has = await prisma.tmUnit.findFirst({
          where: { fromLang: p.from, toLang: p.to, srcKey, projectId },
        });
        if (has) { skipped++; continue; }
        await prisma.tmUnit.create({
          data: {
            projectId, fromLang: p.from, toLang: p.to, srcKey, src: p.src, dst: p.dst,
            origin: 'pack', authorId: me?.id || null,
          },
        });
        added++;
      }
      res.json({ ok: true, added, skipped, found: pairs.length });
    } catch (err) { sendError(res, err); }
  });

  // ── Связь русской и английской версий документа ──
  app.get('/api/translate/links', async (req: Request, res: Response) => {
    try {
      await ensureTables();
      const prisma = getPrisma();
      const where: any = {};
      if (req.query.sourceDocId) where.sourceDocId = str(req.query.sourceDocId);
      if (req.query.targetDocId) where.targetDocId = str(req.query.targetDocId);
      if (!where.sourceDocId && !where.targetDocId) {
        where.projectId = await resolveProjectId(req.query.projectId as string);
      }
      const items = await prisma.transLink.findMany({ where, orderBy: { updatedAt: 'desc' } });
      res.json({ items });
    } catch (err) { sendError(res, err); }
  });

  app.post('/api/translate/links', async (req: Request, res: Response) => {
    try {
      await ensureTables();
      const prisma = getPrisma();
      const b = req.body || {};
      const sourceDocId = str(b.sourceDocId);
      if (!sourceDocId) return sendError(res, new Error('Не указан документ-источник'), 400);
      const projectId = await resolveProjectId(b.projectId);
      const data = {
        projectId, sourceDocId, targetDocId: str(b.targetDocId),
        mode: str(b.mode) || 'file', fingerprint: str(b.fingerprint),
      };
      const has = await prisma.transLink.findFirst({ where: { sourceDocId, targetDocId: data.targetDocId } });
      const item = has
        ? await prisma.transLink.update({ where: { id: has.id }, data })
        : await prisma.transLink.create({ data });
      res.json({ item });
    } catch (err) { sendError(res, err); }
  });

  // ── Сводка: сколько всего накоплено ──
  app.get('/api/translate/stats', async (req: Request, res: Response) => {
    try {
      await ensureTables();
      const prisma = getPrisma();
      const projectId = await resolveProjectId(req.query.projectId as string);
      const [terms, memory] = await Promise.all([
        prisma.termEntry.count({ where: { OR: [{ projectId }, { projectId: null }] } }),
        prisma.tmUnit.count({ where: { OR: [{ projectId }, { projectId: null }] } }),
      ]);
      res.json({ terms, memory });
    } catch (err) { sendError(res, err); }
  });
}
