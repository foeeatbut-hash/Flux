import type { Express, Request, Response } from 'express';
import { ensureDeskFolder, ensureOfficeOnDesk } from '../systemFolders.js';
import * as XLSX from 'xlsx';
import { getPrisma, resolveProjectId, sendError, upsertSetting } from '../context.js';
import { normalizeKey, parseRuNumber } from '../normalize.js';
import { overrideKey } from '../specUtils.js';
import { registerImportFileRoute } from './constructorImport.js';

const ALIAS_SETTING_KEY = 'constructor_param_aliases';

// Алиасы параметров проекта (общие на проект): «Расход воздуха»/«Производительность»/
// «Расход, м3/ч» из разных бланков считаются одним полем. Хранятся в AppSetting,
// применяются на ЧТЕНИИ (Конструктор) — недеструктивно, без переимпорта.
async function loadProjectAliases(projectId: string): Promise<{ name: string; unit?: string; members: string[] }[]> {
  const prisma = getPrisma();
  const row = await prisma.appSetting.findFirst({ where: { key: ALIAS_SETTING_KEY, userId: null } });
  if (!row) return [];
  try {
    const all = JSON.parse(row.value) || {};
    const list = all[projectId];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

async function saveProjectAliases(projectId: string, aliases: any[]): Promise<void> {
  const prisma = getPrisma();
  const row = await prisma.appSetting.findFirst({ where: { key: ALIAS_SETTING_KEY, userId: null } });
  let all: any = {};
  if (row) { try { all = JSON.parse(row.value) || {}; } catch { all = {}; } }
  all[projectId] = aliases;
  await upsertSetting(ALIAS_SETTING_KEY, null, JSON.stringify(all));
}

// Список алиасов → карта name→alias (для resolveValue)
function aliasMap(list: { name: string; unit?: string; members: string[] }[]): Record<string, { name: string; unit?: string; members: string[] }> {
  const m: Record<string, any> = {};
  for (const a of list) if (a?.name) m[a.name] = a;
  return m;
}

// ── Конструктор: документы-таблицы, собираемые из данных проекта ──
// Дизайн: docs/constructor-design-v0.25*.md. Здесь MVP-слой:
// - CRUD документов (общие/личные, корзина, автосейв снапшота книги);
// - каталог полей проекта (стандартные поля тегов + динамические параметры
//   оборудования из specs с учётом overrides);
// - исполнитель запросов: сущность + колонки-пути + фильтры → строки.

// ── Разбор specs и overrides (та же логика, что на экране «Оборудование») ──
function normalizeSpecs(raw: any): { groups: { title: string; params: { key: string; value: string; unit?: string }[] }[] } {
  let parsed: any = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch (_) { return { groups: [] }; }
  }
  if (parsed && Array.isArray(parsed.groups)) {
    return { groups: parsed.groups.map((g: any) => ({ title: g?.title || 'Параметры', params: Array.isArray(g?.params) ? g.params : [] })) };
  }
  if (Array.isArray(parsed)) {
    return { groups: parsed.map((g: any) => ({ title: g?.title || 'Параметры', params: Array.isArray(g?.params) ? g.params : [] })) };
  }
  if (parsed && typeof parsed === 'object') {
    const params = Object.entries(parsed).map(([k, v]: [string, any]) => ({ key: k, value: String(v ?? '') }));
    return { groups: params.length ? [{ title: 'Параметры', params }] : [] };
  }
  return { groups: [] };
}

function parseJsonSafe(raw: any): any {
  if (!raw) return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// Значение параметра элемента: specs с наложенными ручными правками инженера
function elementParamValue(el: any, group: string, key: string): string {
  const overrides = parseJsonSafe(el.overrides) || {};
  const ovKey = overrideKey(group, key);
  if (ovKey in overrides) return String(overrides[ovKey] ?? '');
  const specs = normalizeSpecs(el.specs);
  for (const g of specs.groups) {
    if (g.title !== group) continue;
    for (const p of (g.params || [])) {
      if (p.key === key) return String(p.value ?? '');
    }
  }
  return '';
}

// ── Срез проекта: теги + элементы с распарсенными specs ──
async function loadProjectSlice(projectId: string) {
  const prisma = getPrisma();
  const [tags, systems] = await Promise.all([
    prisma.tag.findMany({
      where: { projectId },
      include: { componentElements: { include: { monoblock: { include: { system: true } } } } },
      orderBy: { identifier: 'asc' },
    }),
    prisma.equipmentSystem.findMany({
      where: { projectId },
      include: { monoblocks: { include: { components: { include: { tags: true } } } } },
    }),
  ]);
  const elements: any[] = [];
  for (const sys of systems) {
    for (const mono of (sys.monoblocks || [])) {
      for (const el of (mono.components || [])) {
        elements.push({ ...el, _system: sys, _monoblock: mono });
      }
    }
  }
  return { tags, elements };
}

/** Элемент по коду или имени, без учёта регистра */
export function findElement(elements: any[], code: string) {
  const c = String(code ?? '').trim().toLowerCase();
  if (!c) return null;
  return elements.find(e =>
    String(e.itemCode ?? '').toLowerCase() === c || String(e.name ?? '').toLowerCase() === c) || null;
}

/**
 * Отбор элементов для сводных функций.
 *
 * Пустое поле — берём все: «=ПАРАМ_СУММ("Аэродинамика";"Расход")» считает по
 * всему проекту. Поле указано — сравниваем значение без учёта регистра, чтобы
 * «ВЕНТИЛЯТОР» и «Вентилятор» не расходились.
 */
export function filterElements(elements: any[], field?: string, value?: string) {
  const f = String(field ?? '').trim();
  if (!f) return elements;
  const want = String(value ?? '').trim().toLowerCase();
  return elements.filter(e => String(resolveValue('element', e, f) ?? '').toLowerCase() === want);
}

// Алиас параметра: одно имя для нескольких «группа|ключ» из разных бланков
export interface ParamAlias { name: string; unit?: string; members: string[] }
export type AliasMap = Record<string, ParamAlias>; // name → alias

// ── Разрешение значения по пути поля ──
// Пути (часть II дизайна, MVP-подмножество):
//   простые поля своей сущности; param:Группа|Ключ; param:@Алиас; meta:ключ;
//   system.name / monoblock.name; tags (список тегов элемента)
export function resolveValue(entity: 'tag' | 'element', row: any, path: string, aliases?: AliasMap): string {
  if (path.startsWith('param:')) {
    const spec = path.slice(6);
    // Алиас: перебираем участников по порядку, первое непустое значение
    if (spec.startsWith('@') && aliases) {
      const alias = aliases[spec.slice(1)];
      for (const member of (alias?.members || [])) {
        const [g, k] = member.split('|');
        const v = resolveValue(entity, row, `param:${g}|${k}`, aliases);
        if (v !== '') return v;
      }
      return '';
    }
    const [group, key] = spec.split('|');
    if (entity === 'element') return elementParamValue(row, group, key);
    // тег → через связанные элементы: первое непустое значение
    for (const el of (row.componentElements || [])) {
      const v = elementParamValue(el, group, key);
      if (v !== '') return v;
    }
    return '';
  }
  if (path.startsWith('meta:')) {
    const meta = parseJsonSafe(row.metadata) || {};
    // точечный путь без выражений: meta:procurement.stage
    let cur: any = meta;
    for (const part of path.slice(5).split('.')) {
      if (cur == null || typeof cur !== 'object') return '';
      cur = cur[part];
    }
    return cur == null ? '' : (typeof cur === 'object' ? JSON.stringify(cur) : String(cur));
  }
  if (entity === 'element') {
    switch (path) {
      case 'name': return String(row.name ?? '');
      case 'itemCode': return String(row.itemCode ?? '');
      case 'equipType': return String(row.equipType ?? '');
      case 'status': return String(row.status ?? '');
      case 'system.name': return String(row._system?.name ?? '');
      case 'monoblock.name': return String(row._monoblock?.name ?? '');
      case 'tags': return (row.tags || []).map((t: any) => t.identifier).join('; ');
    }
    return '';
  }
  // entity === 'tag'
  switch (path) {
    case 'identifier': return String(row.identifier ?? '');
    case 'brand': return String(row.brand ?? '');
    case 'department': return String(row.department ?? '');
    case 'wbs': return String(row.wbs ?? '');
    case 'fluid': return String(row.fluid ?? '');
    case 'createdAt': return row.createdAt ? new Date(row.createdAt).toLocaleDateString('ru-RU') : '';
    case 'element.name': return String(row.componentElements?.[0]?.name ?? '');
    case 'element.itemCode': return String(row.componentElements?.[0]?.itemCode ?? '');
    case 'element.equipType': return String(row.componentElements?.[0]?.equipType ?? '');
    case 'system.name': return String(row.componentElements?.[0]?.monoblock?.system?.name ?? '');
    case 'monoblock.name': return String(row.componentElements?.[0]?.monoblock?.name ?? '');
  }
  return '';
}

// Число из строки в русской записи: «1 250,5 мм» → 1250.5 (для сортировки/фильтров)

function applyFilter(value: string, op: string, target: any): boolean {
  const v = String(value ?? '');
  switch (op) {
    case 'contains': return v.toLowerCase().includes(String(target ?? '').toLowerCase());
    case 'ncontains': return !v.toLowerCase().includes(String(target ?? '').toLowerCase());
    case 'eq': return v === String(target ?? '');
    case 'neq': return v !== String(target ?? '');
    case 'in': return Array.isArray(target) && target.map(String).includes(v);
    case 'empty': return v.trim() === '';
    case 'nempty': return v.trim() !== '';
    case 'gt': { const a = parseRuNumber(v), b = parseRuNumber(String(target)); return a != null && b != null && a > b; }
    case 'lt': { const a = parseRuNumber(v), b = parseRuNumber(String(target)); return a != null && b != null && a < b; }
    default: return true;
  }
}

// PostgreSQL-режим: таблица создаётся лениво при первом обращении к разделу
// (для SQLite её создаёт догоняющая миграция при старте сервера)
let pgEnsured = false;
async function ensureTableExists(): Promise<void> {
  if (pgEnsured) return;
  const prisma = getPrisma();
  try {
    await prisma.constructorDoc.count();
    pgEnsured = true;
  } catch (_) {
    try {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "ConstructorDoc" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "projectId" TEXT NOT NULL,
        "name" TEXT NOT NULL DEFAULT 'Без названия',
        "kind" TEXT NOT NULL DEFAULT 'DOC',
        "scope" TEXT NOT NULL DEFAULT 'SHARED',
        "ownerId" TEXT,
        "named" BOOLEAN NOT NULL DEFAULT false,
        "description" TEXT NOT NULL DEFAULT '',
        "workbook" TEXT NOT NULL DEFAULT '',
        "bindings" TEXT NOT NULL DEFAULT '[]',
        "settings" TEXT NOT NULL DEFAULT '{}',
        "createdById" TEXT,
        "updatedById" TEXT,
        "deletedAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "ConstructorDoc_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )`);
      await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "ConstructorDoc_projectId_kind_idx" ON "ConstructorDoc"("projectId", "kind")');
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "ConstructorDocVersion" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "docId" TEXT NOT NULL,
        "version" INTEGER NOT NULL,
        "workbook" TEXT NOT NULL DEFAULT '',
        "bindings" TEXT NOT NULL DEFAULT '[]',
        "comment" TEXT NOT NULL DEFAULT '',
        "authorId" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "ConstructorDocVersion_docId_fkey" FOREIGN KEY ("docId") REFERENCES "ConstructorDoc" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )`);
      await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "ConstructorDocVersion_docId_version_idx" ON "ConstructorDocVersion"("docId", "version")');
      pgEnsured = true;
    } catch (e) { /* нет прав на DDL — count упадёт и вернёт понятную ошибку */ }
  }
}

// ── Зеркало документа в Проводнике (часть III §5 дизайна) ──
// Именованный документ живёт в Проводнике как файл type="CONSTRUCTOR"
// (refId → ConstructorDoc.id) на РАБОЧЕМ СТОЛЕ своего раздела (общий/личный).
// Черновики и корзина зеркала не имеют.
//
// Раньше для них заводилась отдельная системная папка «Конструктор». Человек
// ждёт сохранённый файл там же, где ждал бы в Windows, — на своём столе: он
// сохранил документ и хочет увидеть значок, а не искать по дереву Проводника.
// Уже лежавшее перевозится один раз (server/systemFolders.ts).

// Экспортируется ради рабочего стола (server/routes/desktop.ts): документ,
// созданный на столе, обязан зеркалиться теми же правилами, что и созданный в
// Конструкторе. Своя копия этой функции однажды разошлась бы с этой.
export async function syncMirror(doc: any): Promise<void> {
  const prisma = getPrisma();
  try {
    const existing = await prisma.fileNode.findFirst({ where: { type: 'CONSTRUCTOR', refId: doc.id } });
    // Зеркалятся и таблицы (DOC), и текстовые документы (TEXT)
    const shouldExist = doc.named && !doc.deletedAt && (doc.kind === 'DOC' || doc.kind === 'TEXT' || doc.kind === 'NOTE');
    if (!shouldExist) {
      if (existing) await prisma.fileNode.delete({ where: { id: existing.id } });
      return;
    }
    const folder = await ensureDeskFolder(
      doc.projectId,
      doc.scope === 'PERSONAL' ? 'PERSONAL' : 'SHARED',
      doc.ownerId || doc.createdById || null,
    );
    const data = {
      name: doc.name,
      // Адрес зеркала помнит, ЧЕМ документ открывается: книга — «Таблицей»,
      // текст — «Документом». Без этого окно текста показывало бы значок
      // таблицы, и человек искал бы на панели задач не ту кнопку
      filePath: `${doc.kind === 'TEXT' || doc.kind === 'NOTE' ? '/doc' : '/sheet'}/${doc.id}`,
      type: 'CONSTRUCTOR',
      refId: doc.id,
      folderId: folder.id,
      scope: folder.scope,
      ownerId: folder.ownerId,
      createdById: doc.createdById || null,
      updatedById: doc.updatedById || null,
    };
    if (existing) {
      // Пользовательскую подпапку не трогаем, если раздел не менялся
      const keepFolder = existing.scope === folder.scope ? existing.folderId : folder.id;
      await prisma.fileNode.update({ where: { id: existing.id }, data: { ...data, folderId: keepFolder } });
    } else {
      await prisma.fileNode.create({ data });
    }
  } catch (e: any) {
    console.warn('[Constructor] Не удалось синхронизировать зеркало в Проводнике:', e?.message);
  }
}


export function registerConstructorRoutes(app: Express): void {
  const authUserOf = (req: Request): any => (req as any).authUser || null;

  // Гарантия таблицы перед любым запросом раздела
  app.use('/api/constructor', async (_req, _res, next) => {
    await ensureTableExists();
    // Разовый перевоз старой папки «Конструктор» на рабочий стол
    await ensureOfficeOnDesk();
    next();
  });

  // Видимость документа: общие — всем, личные — только владельцу
  const visibleWhere = (projectId: string, userId: string | null) => ({
    projectId,
    OR: [
      { scope: 'SHARED' },
      ...(userId ? [{ scope: 'PERSONAL', ownerId: userId }] : []),
    ],
  });

  // ── Список документов (Библиотека): активные + корзина ──
  app.get('/api/constructor/docs', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProjectId(String(req.query.projectId || ''));
      const me = authUserOf(req);
      const docs = await getPrisma().constructorDoc.findMany({
        where: visibleWhere(projectId, me?.id || null),
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true, name: true, kind: true, scope: true, ownerId: true, named: true,
          createdById: true, updatedById: true, deletedAt: true, createdAt: true, updatedAt: true,
        },
      });
      res.json({ docs });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Создание: без вопросов, сразу рабочий документ (часть III §3.1) ──
  app.post('/api/constructor/docs', async (req: Request, res: Response) => {
    try {
      const me = authUserOf(req);
      const projectId = await resolveProjectId(String(req.body?.projectId || ''));
      const now = new Date();
      const autoName = `Без названия — ${now.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}`;
      // kind: DOC — таблица (Эксель), TEXT — документ (Ворд), TEMPLATE — шаблон
      // таблицы, TITLE — шаблон титульного листа (конструктор титула)
      const kind = ['TEMPLATE', 'TEXT', 'NOTE', 'TITLE'].includes(String(req.body?.kind || '')) ? String(req.body.kind) : 'DOC';
      const doc = await getPrisma().constructorDoc.create({
        data: {
          projectId,
          name: String(req.body?.name || autoName),
          named: !!req.body?.name,
          kind,
          // Заметки по умолчанию личные (как в Блокноте); остальное — общее
          scope: kind === 'NOTE' ? 'PERSONAL' : 'SHARED',
          ownerId: me?.id || null,
          createdById: me?.id || null,
          updatedById: me?.id || null,
          workbook: String(req.body?.workbook || ''),
          ...(req.body?.bindings ? { bindings: String(req.body.bindings) } : {}),
        },
      });
      if (doc.named) syncMirror(doc);
      res.json({ doc });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Объединение Блокнота со студией: перенос старых заметок в NOTE-документы ──
  // Заметки (UserNote) были глобальными, поэтому переносим как общие (SHARED),
  // сохраняя видимость всем. Оригиналы НЕ удаляем (безопасность). Реестр
  // перенесённых id в AppSetting — повторно не дублируем. Идемпотентно.
  const MIGRATED_KEY = 'constructor_migrated_notes';
  const htmlToText = (html: string): string => String(html || '')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();

  app.post('/api/constructor/migrate-notes', async (req: Request, res: Response) => {
    try {
      const me = authUserOf(req);
      const prisma = getPrisma();
      const projectId = await resolveProjectId(String(req.body?.projectId || ''));

      const row = await prisma.appSetting.findFirst({ where: { key: MIGRATED_KEY, userId: null } });
      let migratedIds: string[] = [];
      if (row) { try { migratedIds = JSON.parse(row.value) || []; } catch { migratedIds = []; } }
      const done = new Set(migratedIds);

      const notes = await prisma.userNote.findMany({ orderBy: { updatedAt: 'desc' } });
      let migrated = 0;
      for (const n of notes) {
        if (done.has(n.id)) continue;
        const text = htmlToText(n.content);
        const doc = await prisma.constructorDoc.create({
          data: {
            projectId,
            name: n.title || 'Заметка',
            named: true,
            kind: 'NOTE',
            scope: 'SHARED', // старые заметки были общими — сохраняем видимость
            ownerId: me?.id || null,
            createdById: me?.id || null,
            updatedById: me?.id || null,
            workbook: '',
            bindings: JSON.stringify(text ? { importText: text } : {}),
          },
        });
        syncMirror(doc);
        done.add(n.id);
        migrated++;
      }
      if (migrated > 0) {
        await upsertSetting(MIGRATED_KEY, null, JSON.stringify([...done]));
      }
      res.json({ migrated });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Лёгкие метаданные (без снапшота) — выбор редактора по kind ──
  app.get('/api/constructor/docs/:id/meta', async (req: Request, res: Response) => {
    try {
      const me = authUserOf(req);
      const doc = await getPrisma().constructorDoc.findUnique({
        where: { id: req.params.id },
        select: { id: true, name: true, kind: true, scope: true, ownerId: true, named: true, projectId: true, deletedAt: true },
      });
      if (!doc) return res.status(404).json({ error: 'Документ не найден' });
      if (doc.scope === 'PERSONAL' && doc.ownerId !== me?.id) {
        return res.status(403).json({ error: 'Личный документ другого пользователя' });
      }
      res.json({ doc });
    } catch (err: any) { sendError(res, err); }
  });

  // Открытие принесённого файла Word/Excel и «Редактировать копию» —
  // server/routes/constructorImport.ts
  registerImportFileRoute(app, { syncMirror, authUserOf });

  // ── Документ целиком (со снапшотом книги) ──
  app.get('/api/constructor/docs/:id', async (req: Request, res: Response) => {
    try {
      const me = authUserOf(req);
      const doc = await getPrisma().constructorDoc.findUnique({ where: { id: req.params.id } });
      if (!doc) return res.status(404).json({ error: 'Документ не найден' });
      if (doc.scope === 'PERSONAL' && doc.ownerId !== me?.id) {
        return res.status(403).json({ error: 'Личный документ другого пользователя' });
      }
      res.json({ doc });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Автосейв и свойства (имя, scope, корзина) ──
  app.put('/api/constructor/docs/:id', async (req: Request, res: Response) => {
    try {
      const me = authUserOf(req);
      const prisma = getPrisma();
      const doc = await prisma.constructorDoc.findUnique({ where: { id: req.params.id } });
      if (!doc) return res.status(404).json({ error: 'Документ не найден' });
      if (doc.scope === 'PERSONAL' && doc.ownerId !== me?.id) {
        return res.status(403).json({ error: 'Личный документ другого пользователя' });
      }

      /**
       * Запись поверх чужой правки не выполняется молча.
       *
       * Замка на документе нет: двое правят одновременно и видят правки друг
       * друга — Конструктор рассылает операции по сокету. Но окно, отставшее
       * от жизни (свёрнутое, пережившее перезапуск, потерявшее связь), держит
       * в памяти старую книгу и своим автосохранением кладёт её поверх свежей.
       * Ошибки при этом нет, всё «сохранено», и через неделю по ведомости
       * заказывают то, чего в ней уже не должно быть.
       *
       * Поэтому: пришло время, с которым окно читало документ, и оно не
       * совпало с текущим — отказ и разбор. Клиент без базы (старая версия)
       * пишет как раньше: остановить отделу работу обновлением нельзя.
       */
      const base = typeof req.body?.baseUpdatedAt === 'string' ? req.body.baseUpdatedAt : '';
      const touchesContent = typeof req.body?.workbook === 'string' || typeof req.body?.bindings === 'string';
      if (base && touchesContent && +new Date(base) !== +new Date(doc.updatedAt)) {
        if (req.body?.force !== true) {
          const who = doc.updatedById
            ? await prisma.user.findUnique({ where: { id: doc.updatedById }, select: { name: true } })
            : null;
          return res.status(409).json({
            conflict: true,
            error: 'Документ изменился с тех пор, как вы его открыли',
            who: who?.name || '',
            at: doc.updatedAt,
          });
        }
        // Настояли на своём — снимок чужой правки делаем ДО записи: после неё
        // восстанавливать будет нечего (см. skill flux-data-safety §6)
        const who = doc.updatedById
          ? await prisma.user.findUnique({ where: { id: doc.updatedById }, select: { name: true } })
          : null;
        await createDocVersion(doc, `перед сохранением поверх правки: ${who?.name || 'коллега'}`, doc.updatedById || null)
          .catch(() => { /* без снимка не отказываем: иначе правка не сохранится вовсе */ });
      }

      const data: any = { updatedById: me?.id || null };
      if (typeof req.body?.workbook === 'string') data.workbook = req.body.workbook;
      if (typeof req.body?.bindings === 'string') data.bindings = req.body.bindings;
      if (typeof req.body?.settings === 'string') data.settings = req.body.settings;
      if (typeof req.body?.name === 'string' && req.body.name.trim()) {
        data.name = req.body.name.trim();
        data.named = true;
      }
      // Личный/Общий переключает только автор (и админ) — часть III §3.2
      if (req.body?.scope === 'PERSONAL' || req.body?.scope === 'SHARED') {
        if (doc.createdById && doc.createdById !== me?.id && me?.role !== 'ADMIN') {
          return res.status(403).json({ error: 'Переключать «Личный/Общий» может только автор документа' });
        }
        data.scope = req.body.scope;
        data.ownerId = doc.ownerId || doc.createdById || me?.id || null;
      }
      if (req.body?.deleted === true) data.deletedAt = new Date();   // в корзину
      if (req.body?.deleted === false) data.deletedAt = null;        // восстановить

      const updated = await prisma.constructorDoc.update({ where: { id: doc.id }, data });
      // Зеркало в Проводнике догоняет имя/раздел/корзину (не блокируем ответ)
      if ('name' in data || 'scope' in data || 'deletedAt' in data) syncMirror(updated);
      res.json({ doc: updated });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Окончательное удаление (из корзины) ──
  app.delete('/api/constructor/docs/:id', async (req: Request, res: Response) => {
    try {
      const me = authUserOf(req);
      const prisma = getPrisma();
      const doc = await prisma.constructorDoc.findUnique({ where: { id: req.params.id } });
      if (!doc) return res.status(404).json({ error: 'Документ не найден' });
      const isAuthor = !doc.createdById || doc.createdById === me?.id;
      if (!isAuthor && me?.role !== 'ADMIN' && me?.role !== 'MANAGER') {
        return res.status(403).json({ error: 'Удалять может автор или руководитель' });
      }
      await prisma.constructorDoc.delete({ where: { id: doc.id } });
      // Подчистить зеркало, если документ удалили окончательно минуя корзину
      try {
        const mirror = await prisma.fileNode.findFirst({ where: { type: 'CONSTRUCTOR', refId: doc.id } });
        if (mirror) await prisma.fileNode.delete({ where: { id: mirror.id } });
      } catch (_) {}
      res.json({ success: true });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Дублирование ──
  // ── Версии документа: автоснимки и ручные, последние 20 (часть I §3) ──
  const VERSIONS_KEEP = 20;

  const createDocVersion = async (doc: any, comment: string, authorId: string | null) => {
    const prisma = getPrisma();
    const last = await prisma.constructorDocVersion.findFirst({
      where: { docId: doc.id }, orderBy: { version: 'desc' }, select: { version: true },
    });
    const created = await prisma.constructorDocVersion.create({
      data: {
        docId: doc.id,
        version: (last?.version || 0) + 1,
        workbook: doc.workbook || '',
        bindings: doc.bindings || '[]',
        comment: String(comment || '').slice(0, 200),
        authorId,
      },
    });
    // Ретеншн: последние N, старые схлопываются
    await prisma.constructorDocVersion.deleteMany({
      where: { docId: doc.id, version: { lte: created.version - VERSIONS_KEEP } },
    });
    return created;
  };

  // Доступ к документу с проверкой личного (общий код трёх роутов ниже)
  const loadDocChecked = async (req: Request, res: Response): Promise<any | null> => {
    const me = authUserOf(req);
    const doc = await getPrisma().constructorDoc.findUnique({ where: { id: req.params.id } });
    if (!doc) { res.status(404).json({ error: 'Документ не найден' }); return null; }
    if (doc.scope === 'PERSONAL' && doc.ownerId !== me?.id) {
      res.status(403).json({ error: 'Личный документ другого пользователя' });
      return null;
    }
    return doc;
  };

  app.get('/api/constructor/docs/:id/versions', async (req: Request, res: Response) => {
    try {
      const doc = await loadDocChecked(req, res);
      if (!doc) return;
      const versions = await getPrisma().constructorDocVersion.findMany({
        where: { docId: doc.id },
        orderBy: { version: 'desc' },
        select: { id: true, version: true, comment: true, authorId: true, createdAt: true },
      });
      res.json({ versions });
    } catch (err: any) { sendError(res, err); }
  });

  app.post('/api/constructor/docs/:id/versions', async (req: Request, res: Response) => {
    try {
      const me = authUserOf(req);
      const doc = await loadDocChecked(req, res);
      if (!doc) return;
      const v = await createDocVersion(doc, req.body?.comment || 'ручное сохранение', me?.id || null);
      res.json({ version: { id: v.id, version: v.version, comment: v.comment, createdAt: v.createdAt } });
    } catch (err: any) { sendError(res, err); }
  });

  // Откат: текущее состояние сначала само становится версией —
  // «откат отката» всегда возможен (часть I §12 дизайна)
  app.post('/api/constructor/docs/:id/restore/:versionId', async (req: Request, res: Response) => {
    try {
      const me = authUserOf(req);
      const doc = await loadDocChecked(req, res);
      if (!doc) return;
      const prisma = getPrisma();
      const ver = await prisma.constructorDocVersion.findUnique({ where: { id: req.params.versionId } });
      if (!ver || ver.docId !== doc.id) return res.status(404).json({ error: 'Версия не найдена' });
      await createDocVersion(doc, `перед восстановлением версии ${ver.version}`, me?.id || null);
      const updated = await prisma.constructorDoc.update({
        where: { id: doc.id },
        data: { workbook: ver.workbook, bindings: ver.bindings, updatedById: me?.id || null },
      });
      res.json({ doc: updated });
    } catch (err: any) { sendError(res, err); }
  });

  app.post('/api/constructor/docs/:id/duplicate', async (req: Request, res: Response) => {
    try {
      const me = authUserOf(req);
      const prisma = getPrisma();
      const doc = await prisma.constructorDoc.findUnique({ where: { id: req.params.id } });
      if (!doc) return res.status(404).json({ error: 'Документ не найден' });
      if (doc.scope === 'PERSONAL' && doc.ownerId !== me?.id) {
        return res.status(403).json({ error: 'Личный документ другого пользователя' });
      }
      // Переопределения для шаблонов: «Сохранить как шаблон» (kind=TEMPLATE)
      // и «Создать документ по шаблону» (kind=DOC, своё имя)
      const kindOverride = req.body?.kind === 'TEMPLATE' ? 'TEMPLATE' : req.body?.kind === 'DOC' ? 'DOC' : doc.kind;
      const nameOverride = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : `${doc.name} (копия)`;
      const copy = await prisma.constructorDoc.create({
        data: {
          projectId: doc.projectId,
          name: nameOverride,
          named: doc.named,
          kind: kindOverride,
          scope: doc.scope,
          ownerId: me?.id || null,
          createdById: me?.id || null,
          updatedById: me?.id || null,
          workbook: doc.workbook,
          bindings: doc.bindings,
          settings: doc.settings,
        },
      });
      if (copy.named) syncMirror(copy);
      res.json({ doc: copy });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Каталог полей проекта (часть II §5): что вообще можно выбрать ──
  app.get('/api/constructor/catalog', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProjectId(String(req.query.projectId || ''));
      const { tags, elements } = await loadProjectSlice(projectId);

      // Дерево параметров «группа → ключ» с заполненностью и единицами
      const paramMap = new Map<string, { group: string; key: string; unit: string; count: number; sample: string }>();
      for (const el of elements) {
        const specs = normalizeSpecs(el.specs);
        for (const g of specs.groups) {
          for (const p of (g.params || [])) {
            if (!p.key) continue;
            const id = `${g.title}|${p.key}`;
            const rec = paramMap.get(id) || { group: g.title, key: p.key, unit: p.unit || '', count: 0, sample: '' };
            rec.count++;
            if (!rec.sample && p.value) rec.sample = String(p.value).slice(0, 40);
            if (!rec.unit && p.unit) rec.unit = p.unit;
            paramMap.set(id, rec);
          }
        }
      }

      // Ключи metadata тегов (по факту встречаемости, только верхний уровень)
      const metaMap = new Map<string, number>();
      for (const t of tags) {
        const meta = parseJsonSafe(t.metadata);
        if (meta && typeof meta === 'object') {
          for (const k of Object.keys(meta)) metaMap.set(k, (metaMap.get(k) || 0) + 1);
        }
      }

      // Алиасы: объединённая заполненность (у скольких элементов есть хоть один
      // участник) + подсказка «похожие» по нормализованным основам ключей
      const aliases = await loadProjectAliases(projectId);
      const memberSet = new Set<string>();
      for (const a of aliases) for (const m of a.members) memberSet.add(m);
      const aliasFields = aliases.map(a => {
        let count = 0;
        for (const el of elements) {
          const specs = normalizeSpecs(el.specs);
          const has = a.members.some(m => {
            const [g, k] = m.split('|');
            return specs.groups.some(gr => gr.title === g && (gr.params || []).some(p => p.key === k));
          });
          if (has) count++;
        }
        return { path: `param:@${a.name}`, title: a.name, unit: a.unit || '', members: a.members, count };
      });
      // Похожие сырые параметры (по основам слов) — для предложения объединить
      const byStem = new Map<string, string[]>();
      for (const rec of paramMap.values()) {
        const st = normalizeKey(rec.key);
        if (!byStem.has(st)) byStem.set(st, []);
        byStem.get(st)!.push(`${rec.group}|${rec.key}`);
      }
      const similarGroups = [...byStem.values()].filter(ids => ids.length >= 2 && ids.some(id => !memberSet.has(id)));

      res.json({
        counts: { tags: tags.length, elements: elements.length },
        tagFields: [
          { path: 'identifier', title: 'Тег (идентификатор)' },
          { path: 'brand', title: 'Марка' },
          { path: 'department', title: 'Отдел' },
          { path: 'wbs', title: 'WBS' },
          { path: 'fluid', title: 'Среда' },
          { path: 'createdAt', title: 'Дата создания' },
          { path: 'element.name', title: 'Элемент (наименование)' },
          { path: 'element.itemCode', title: 'Элемент (код)' },
          { path: 'element.equipType', title: 'Тип оборудования' },
          { path: 'system.name', title: 'Система' },
          { path: 'monoblock.name', title: 'Моноблок' },
        ],
        elementFields: [
          { path: 'name', title: 'Наименование' },
          { path: 'itemCode', title: 'Код позиции' },
          { path: 'equipType', title: 'Тип оборудования' },
          { path: 'system.name', title: 'Система' },
          { path: 'monoblock.name', title: 'Моноблок' },
          { path: 'tags', title: 'Теги' },
          { path: 'status', title: 'Статус' },
        ],
        params: Array.from(paramMap.values()).sort((a, b) =>
          a.group.localeCompare(b.group, 'ru') || a.key.localeCompare(b.key, 'ru')),
        metaKeys: Array.from(metaMap.entries()).map(([key, count]) => ({ path: `meta:${key}`, key, count })),
        aliases: aliasFields,
        similar: similarGroups, // группы «похожих» сырых параметров — предложить объединить
      });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Алиасы параметров проекта (GET/PUT) — общие для отдела ──
  app.get('/api/constructor/aliases', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProjectId(String(req.query.projectId || ''));
      res.json({ aliases: await loadProjectAliases(projectId) });
    } catch (err: any) { sendError(res, err); }
  });

  app.put('/api/constructor/aliases', async (req: Request, res: Response) => {
    try {
      const me = authUserOf(req);
      // Править общие алиасы может админ/менеджер (влияют на всех)
      if (me && me.role !== 'ADMIN' && me.role !== 'MANAGER') {
        return res.status(403).json({ error: 'Изменять алиасы может администратор или руководитель' });
      }
      const projectId = await resolveProjectId(String(req.body?.projectId || ''));
      const input = Array.isArray(req.body?.aliases) ? req.body.aliases : [];
      // Санитизация: имя обязательно, участник в максимум одном алиасе
      const seen = new Set<string>();
      const clean = input
        .map((a: any) => ({
          name: String(a?.name || '').trim(),
          unit: String(a?.unit || '').trim() || undefined,
          members: Array.isArray(a?.members) ? a.members.map((m: any) => String(m)).filter(Boolean) : [],
        }))
        .filter((a: any) => a.name && a.members.length > 0)
        .map((a: any) => ({ ...a, members: a.members.filter((m: string) => !seen.has(m) && seen.add(m)) }))
        .filter((a: any) => a.members.length > 0);
      await saveProjectAliases(projectId, clean);
      res.json({ aliases: clean });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Свежесть данных: «отпечаток» состояния проекта по типам сущностей ──
  // Дёшево (без исполнения фильтров): блок сравнивает отпечаток на момент
  // своего обновления с текущим — расхождение = значок «данные изменились».
  // Ложноположительные срабатывания допустимы, ложноотрицательных нет.
  // ── Формульные функции листа: =ТЕГ / =ПАРАМ / =ПАРАМ_ЭЛ / =ПРОЕКТ ──
  // Батч точечных значений; ошибки — типизированными строками (видны в ячейке)
  app.post('/api/constructor/fn', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProjectId(String(req.body?.projectId || ''));
      const calls: { fn: string; args: string[] }[] = Array.isArray(req.body?.calls) ? req.body.calls : [];
      const prisma = getPrisma();

      // Срез грузим один раз на батч и только если он реально нужен
      let slice: { tags: any[]; elements: any[] } | null = null;
      const getSlice = async () => (slice ??= await loadProjectSlice(projectId));

      const asCellValue = (v: string) => {
        const n = parseRuNumber(v);
        return n != null && String(n) === v.replace(/[\s\u00A0]/g, '').replace(',', '.') ? n : v;
      };

      const results: any[] = [];
      for (const c of calls) {
        const args = (c.args || []).map(a => String(a ?? '').trim());
        try {
          if (c.fn === 'project') {
            const proj = await prisma.project.findUnique({ where: { id: projectId } });
            const allowed = ['name', 'code', 'customer', 'contractor', 'description', 'status'];
            results.push(proj && allowed.includes(args[0]) ? String((proj as any)[args[0]] ?? '') : '#НЕТ_ПОЛЯ');
            continue;
          }
          if (c.fn === 'tag' || c.fn === 'param') {
            const { tags } = await getSlice();
            const ident = args[0].toLowerCase();
            const tag = tags.find(t => String(t.identifier).toLowerCase() === ident);
            if (!tag) { results.push('#НЕТ_ТЕГА'); continue; }
            const v = c.fn === 'tag'
              ? resolveValue('tag', tag, args[1])
              : resolveValue('tag', tag, `param:${args[1]}|${args[2]}`);
            results.push(v === '' && c.fn === 'param' ? '#НЕТ_ПАРАМА' : asCellValue(v));
            continue;
          }
          if (c.fn === 'paramEl') {
            const { elements } = await getSlice();
            const code = args[0].toLowerCase();
            const el = elements.find(e => String(e.itemCode).toLowerCase() === code || String(e.name).toLowerCase() === code);
            if (!el) { results.push('#НЕТ_ЭЛЕМЕНТА'); continue; }
            const v = resolveValue('element', el, `param:${args[1]}|${args[2]}`);
            results.push(v === '' ? '#НЕТ_ПАРАМА' : asCellValue(v));
            continue;
          }
          // ── Поля элемента по коду ──
          if (c.fn === 'element') {
            const { elements } = await getSlice();
            const el = findElement(elements, args[0]);
            if (!el) { results.push('#НЕТ_ЭЛЕМЕНТА'); continue; }
            const v = resolveValue('element', el, args[1]);
            results.push(v === '' ? '#НЕТ_ПОЛЯ' : asCellValue(v));
            continue;
          }

          // ── Теги элемента списком ──
          if (c.fn === 'tagsOf') {
            const { elements } = await getSlice();
            const el = findElement(elements, args[0]);
            if (!el) { results.push('#НЕТ_ЭЛЕМЕНТА'); continue; }
            results.push((el.tags || []).map((t: any) => t.identifier).join('; '));
            continue;
          }

          // ── Состояние элемента: конфликт и ревизия ──
          // Этого нет ни в одном табличном редакторе: значение зависит от того,
          // что принёс последний импорт расчёта, а не от содержимого книги
          if (c.fn === 'conflict' || c.fn === 'revision') {
            const { elements } = await getSlice();
            const el = findElement(elements, args[0]);
            if (!el) { results.push('#НЕТ_ЭЛЕМЕНТА'); continue; }
            if (c.fn === 'revision') { results.push(Number(el.version ?? 1)); continue; }
            results.push(el.hasConflict ? String(el.conflictType || 'КОНФЛИКТ') : '');
            continue;
          }

          // ── Свод по параметру: сумма, среднее, максимум, минимум, количество ──
          // Ради этого всё и затевалось: одна ячейка даёт итог по проекту,
          // а не ссылку на диапазон, который надо сначала руками собрать
          if (['pSum', 'pAvg', 'pMax', 'pMin', 'pCount'].includes(c.fn)) {
            const { elements } = await getSlice();
            const picked = filterElements(elements, args[2], args[3]);
            const nums: number[] = [];
            for (const el of picked) {
              const raw = resolveValue('element', el, `param:${args[0]}|${args[1]}`);
              if (raw === '') continue;
              const n = parseRuNumber(raw);
              if (n != null && Number.isFinite(n)) nums.push(n);
            }
            if (c.fn === 'pCount') { results.push(nums.length); continue; }
            if (!nums.length) { results.push('#НЕТ_ДАННЫХ'); continue; }
            const sum = nums.reduce((a, b) => a + b, 0);
            results.push(
              c.fn === 'pSum' ? sum
              : c.fn === 'pAvg' ? Math.round((sum / nums.length) * 1e6) / 1e6
              : c.fn === 'pMax' ? Math.max(...nums)
              : Math.min(...nums),
            );
            continue;
          }

          // ── Сколько элементов подходит условию ──
          if (c.fn === 'countEl') {
            const { elements } = await getSlice();
            results.push(filterElements(elements, args[0], args[1]).length);
            continue;
          }

          // ── Сколько тегов подходит условию и их перечень ──
          if (c.fn === 'countTag' || c.fn === 'listTag') {
            const { tags } = await getSlice();
            const field = args[0];
            const want = String(args[1] ?? '').toLowerCase();
            const picked = !field
              ? tags
              : tags.filter(t => String(resolveValue('tag', t, field) ?? '').toLowerCase() === want);
            results.push(c.fn === 'countTag' ? picked.length
              : picked.map(t => t.identifier).join('; '));
            continue;
          }

          // ── Свод по установке: сколько моноблоков и элементов ──
          if (c.fn === 'system') {
            const { elements } = await getSlice();
            const name = String(args[0] ?? '').toLowerCase();
            const inSys = elements.filter(e => String(e._system?.name ?? '').toLowerCase() === name);
            if (!inSys.length) { results.push('#НЕТ_УСТАНОВКИ'); continue; }
            const field = (args[1] || 'elements').toLowerCase();
            if (field === 'elements' || field === 'элементы') { results.push(inSys.length); continue; }
            if (field === 'monoblocks' || field === 'моноблоки') {
              results.push(new Set(inSys.map(e => e._monoblock?.id)).size);
              continue;
            }
            if (field === 'category' || field === 'категория') {
              results.push(String(inSys[0]._system?.category ?? ''));
              continue;
            }
            results.push('#НЕТ_ПОЛЯ');
            continue;
          }

          results.push('#ОШИБКА');
        } catch (_) { results.push('#ОШИБКА'); }
      }
      res.json({ results });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Шаблоны титула: список для присвоения документу ──
  // Шаблон титула — документ kind=TEMPLATE с bindings.subtype='title'.
  app.get('/api/constructor/title/templates', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProjectId(String(req.query.projectId || ''));
      const me = authUserOf(req);
      const docs = await getPrisma().constructorDoc.findMany({
        where: { ...visibleWhere(projectId, me?.id || null), kind: 'TITLE', deletedAt: null },
        orderBy: { updatedAt: 'desc' },
        select: { id: true, name: true, updatedAt: true },
      });
      res.json({ templates: docs });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Контекст титула для конкретного документа ──
  // Значения именно этого документа + проекта + дата/автор. Формулы и поля
  // подставляются на клиенте (см. src/screens/titleTemplate.ts).
  app.get('/api/constructor/title/context', async (req: Request, res: Response) => {
    try {
      const me = authUserOf(req);
      const prisma = getPrisma();
      const doc = await prisma.constructorDoc.findUnique({ where: { id: String(req.query.docId || '') } });
      if (!doc) return res.status(404).json({ error: 'Документ не найден' });
      if (doc.scope === 'PERSONAL' && doc.ownerId !== me?.id) {
        return res.status(403).json({ error: 'Личный документ другого пользователя' });
      }
      let settings: any = {}; try { settings = JSON.parse(doc.settings || '{}'); } catch { settings = {}; }
      const dm = settings.docMeta || {};
      const project = await prisma.project.findUnique({ where: { id: doc.projectId } });
      let author = '';
      // Люди документа: автор, тот кто открыл, и все, на кого сослались
      // формулы «выбранный сотрудник». ФИО отдаём по частям — вид вывода
      // (полностью или инициалами) выбирает формула, а не сервер.
      const people: Record<string, any> = {};
      const wanted = new Set<string>();
      if (doc.createdById) wanted.add(doc.createdById);
      if (me?.id) wanted.add(me.id);
      for (const id of String(req.query.userIds || '').split(',').filter(Boolean)) wanted.add(id);

      // Подписанты реестра ВДР: документ, привязанный к строке реестра, знает
      // своих «Разработал / Проверил / Утвердил» — и подпись каждого должна
      // доехать до титула сама, без ручного выбора сотрудника (§42)
      const vdrRoles: Record<string, string> = {};
      if (dm && settings.vdrItemId) {
        try {
          const item = await prisma.docRegisterItem.findUnique({
            where: { id: String(settings.vdrItemId) },
            select: { register: { select: { preparedById: true, checkedById: true, approvedById: true } } },
          });
          const reg: any = (item as any)?.register;
          for (const [role, id] of [['prepared', reg?.preparedById], ['checked', reg?.checkedById], ['approved', reg?.approvedById]]) {
            if (id) { wanted.add(String(id)); vdrRoles[String(id)] = String(role); }
          }
        } catch (_) { /* реестра нет — титул обойдётся без его подписей */ }
      }

      const users = wanted.size
        ? await prisma.user.findMany({
            where: { id: { in: [...wanted] } },
            select: { id: true, name: true, symbol: true, lastName: true, firstName: true, middleName: true,
                      signatureImage: true, signatureHeightMm: true },
          })
        : [];
      const put = (prefix: string, u: any) => {
        if (!u) return;
        people[`${prefix}.name`] = u.name || '';
        people[`${prefix}.lastName`] = u.lastName || '';
        people[`${prefix}.firstName`] = u.firstName || '';
        people[`${prefix}.middleName`] = u.middleName || '';
        people[`${prefix}.signature`] = u.signatureImage || '';
        people[`${prefix}.signatureHeightMm`] = u.signatureHeightMm ?? 8;
      };
      for (const u of users as any[]) {
        put(`person.${u.id}`, u);
        // «Проверил» на титуле — это роль, а не конкретный человек: сменится
        // проверяющий в реестре — сменится и подпись, без правки шаблона
        if (vdrRoles[u.id]) put(`person.${vdrRoles[u.id]}`, u);
        if (u.id === doc.createdById) { put('person.author', u); author = u.name || u.symbol || ''; }
        if (me?.id && u.id === me.id) put('person.current', u);
      }
      const now = new Date();
      res.json({
        context: {
          'doc.name': doc.name || '',
          'doc.code': dm.code || '',
          'doc.revision': dm.revision || '',
          'doc.title': dm.title || doc.name || '',
          'project.code': (project as any)?.code || '',
          'project.name': project?.name || '',
          'project.customer': (project as any)?.customer || '',
          'project.contractor': (project as any)?.contractor || '',
          author,
          date: now.toLocaleDateString('ru-RU'),
          dateTime: now.toLocaleString('ru-RU'),
          year: String(now.getFullYear()),
          // page/pages подставляет печать (CSS-счётчики), тут плейсхолдеры
          page: '1', pages: '1',
          ...people,
        },
      });
    } catch (err: any) { sendError(res, err); }
  });

  app.get('/api/constructor/fingerprint', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProjectId(String(req.query.projectId || ''));
      const prisma = getPrisma();
      const [tagCount, tagMax, elCount, elMax] = await Promise.all([
        prisma.tag.count({ where: { projectId } }),
        prisma.tag.aggregate({ where: { projectId }, _max: { createdAt: true, updatedAt: true } }),
        prisma.componentElement.count({ where: { monoblock: { system: { projectId } } } }),
        prisma.componentElement.aggregate({ where: { monoblock: { system: { projectId } } }, _max: { updatedAt: true } }),
      ]);
      res.json({
        tag: `${tagCount}:${tagMax._max.createdAt?.toISOString?.() || ''}:${tagMax._max.updatedAt?.toISOString?.() || ''}`,
        element: `${elCount}:${elMax._max.updatedAt?.toISOString?.() || ''}`,
      });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Исполнитель запросов: сущность + колонки + фильтры → строки ──
  app.post('/api/constructor/query', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProjectId(String(req.body?.projectId || ''));
      const entity: 'tag' | 'element' = req.body?.entity === 'element' ? 'element' : 'tag';
      const columns: string[] = Array.isArray(req.body?.columns) ? req.body.columns.map(String) : [];
      const filters: { field: string; op: string; value?: any }[] = Array.isArray(req.body?.filters) ? req.body.filters : [];
      const sort: { field: string; dir: string } | null = req.body?.sort || null;
      const limit = Math.min(Number(req.body?.limit) || 50000, 50000);

      const slice = await loadProjectSlice(projectId);
      const aliases = aliasMap(await loadProjectAliases(projectId));
      let rows: any[] = entity === 'tag' ? slice.tags : slice.elements;

      for (const f of filters) {
        rows = rows.filter(r => applyFilter(resolveValue(entity, r, f.field, aliases), f.op, f.value));
      }

      if (sort?.field) {
        const dir = sort.dir === 'desc' ? -1 : 1;
        rows = [...rows].sort((a, b) => {
          const va = resolveValue(entity, a, sort.field, aliases);
          const vb = resolveValue(entity, b, sort.field, aliases);
          const na = parseRuNumber(va), nb = parseRuNumber(vb);
          if (na != null && nb != null) return (na - nb) * dir;
          return va.localeCompare(vb, 'ru') * dir;
        });
      }

      const total = rows.length;
      const out = rows.slice(0, limit).map(r => ({
        key: `${entity}:${r.id}`,
        cells: columns.map(c => {
          const v = resolveValue(entity, r, c, aliases);
          // Числа отдаём числами — иначе в таблице не заработает СУММ()
          const n = parseRuNumber(v);
          return n != null && String(n) === v.replace(/[\s ]/g, '').replace(',', '.') ? n : v;
        }),
        route: entity === 'tag' ? `/registry?tag=${r.id}` : `/equipment?elementId=${r.id}`,
      }));

      res.json({ rows: out, total, truncated: total > limit });
    } catch (err: any) { sendError(res, err); }
  });
}
