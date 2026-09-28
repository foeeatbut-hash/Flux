/**
 * Данные проекта для документов: каталог полей, алиасы параметров, точечные
 * значения, исполнитель запросов — и то, чем ими пользуются файлы Flux Office:
 * поиск для панели «Данные проекта», значения полей по ключам, подписи,
 * умные блоки, «Обновить поля» закрытого файла.
 *
 * Маршруты данных жили в Конструкторе (/api/constructor/…). Они переехали
 * сюда под /api/project-data/… с теми же ответами; старые пути зовут эти же
 * функции (server/routes/constructor.ts), пока Конструктор не удалён.
 *
 * Запись в файл идёт только через writeOfficeFile: право, держатель правки,
 * сверка версии и откат — прежнее содержимое ложится в FileVersion до записи.
 * Открытый в редакторе файл сервер не трогает вовсе: его поля обновляет само
 * окно редактора, иначе запись сервера спорила бы с тем, что человек видит.
 */
import type { Express, Request, Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { ensureTables as ensureDbTables } from '../ddl.js';
import { getPrisma, resolveProjectId, sendError } from '../context.js';
import { normalizeKey, parseRuNumber } from '../normalize.js';
import { fileBytes } from './fileChunks.js';
import { writeOfficeFile } from './officeFiles.js';
import { officeRooms } from '../officeRooms.js';
import { BLOCK_RE, SIGN_ROLES, type SignRole } from '../../office/fieldKeys.js';
import {
  filterElements, findElement, loadProjectAliases, loadProjectSlice, normalizeSpecs, parseJsonSafe,
  blockFingerprint, cleanQuery, projectFingerprint, resolveValue, runQuery, saveProjectAliases, type ProjectQuery,
} from '../projectSlice.js';
import { projectOfFile, resolveKeys, searchProject, signersOf, setSigner } from '../projectFields.js';
import { listDocxFields, listXlsxAnchors, updateDocxFields, updateXlsxFields, writeXlsxBlock, type FieldValue } from '../officeFields.js';

export interface ProjectDataDeps {
  /** Можно ли этому человеку писать в файл: '' — да, иначе — почему нет */
  mayWrite: (req: any, fileId: string) => Promise<string>;
}

// ── Каталог полей проекта (часть II §5 дизайна Конструктора): что вообще можно выбрать ──
async function catalog(req: Request, res: Response): Promise<any> {
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
        // Состав: ради этих полей всё и затевалось — «теги двигателей,
        // дальше их данные и тег родителя» это три столбца, а не программа
        { path: 'tag', title: 'Тег' },
        { path: 'role', title: 'Роль' },
        { path: 'parentTag', title: 'Тег родителя' },
        { path: 'unitTag', title: 'Тег установки' },
        { path: 'parent.name', title: 'Владелец' },
        { path: 'instanceNo', title: 'Экземпляр' },
        { path: 'origin', title: 'Откуда' },
        { path: 'classTitle', title: 'Тип' },
        { path: 'kind', title: 'Вид' },
        { path: 'model', title: 'Модель' },
      ],
      params: Array.from(paramMap.values()).sort((a, b) =>
        a.group.localeCompare(b.group, 'ru') || a.key.localeCompare(b.key, 'ru')),
      metaKeys: Array.from(metaMap.entries()).map(([key, count]) => ({ path: `meta:${key}`, key, count })),
      aliases: aliasFields,
      similar: similarGroups, // группы «похожих» сырых параметров — предложить объединить
    });
  } catch (err: any) { sendError(res, err); }
}

async function aliasesGet(req: Request, res: Response): Promise<any> {
  try {
    const projectId = await resolveProjectId(String(req.query.projectId || ''));
    res.json({ aliases: await loadProjectAliases(projectId) });
  } catch (err: any) { sendError(res, err); }
}

async function aliasesPut(req: Request, res: Response): Promise<any> {
  try {
    const me = (req as any).authUser || null;
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
}

async function fn(req: Request, res: Response): Promise<any> {
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
}


async function fingerprint(req: Request, res: Response): Promise<any> {
  try {
    const projectId = await resolveProjectId(String(req.query.projectId || ''));
    res.json(await projectFingerprint(projectId));
  } catch (err: any) { sendError(res, err); }
}

// ── Исполнитель запросов: сущность + колонки + фильтры → строки ──
async function query(req: Request, res: Response): Promise<any> {
  try {
    const projectId = await resolveProjectId(String(req.body?.projectId || ''));
    res.json(await runQuery(projectId, cleanQuery(req.body)));
  } catch (err: any) { sendError(res, err); }
}

/** Те же функции для старых путей Конструктора — ответы одни и те же */
export const projectDataHandlers = { catalog, aliasesGet, aliasesPut, fn, fingerprint, query };

// ── Умные блоки: таблица в базе ──

let blocksReady = '';
let blocksChecked = false;
/**
 * Подстраховка на случай, когда автомиграция по схеме не отработала (как у
 * календаря): таблица создаётся под движок базы, беда возвращается наверх
 */
async function ensureBlocks(): Promise<string> {
  if (blocksChecked) return blocksReady;
  const prisma = getPrisma();
  try {
    await prisma.officeBlock.count();
    blocksChecked = true;
    blocksReady = '';
  } catch (_) {
    blocksReady = await ensureDbTables(prisma, [{
      table: 'OfficeBlock',
      cols: [
        { name: 'id', kind: 'text', pk: true },
        { name: 'fileId', kind: 'text', notNull: true, def: '', indexed: true },
        { name: 'name', kind: 'text', notNull: true, def: '' },
        { name: 'query', kind: 'longtext', notNull: true, def: '{}' },
        { name: 'layout', kind: 'longtext', notNull: true, def: '{}' },
        { name: 'fingerprint', kind: 'text', notNull: true, def: '' },
        { name: 'createdAt', kind: 'time', notNull: true, def: 'now' },
        { name: 'updatedAt', kind: 'time', notNull: true, def: 'now' },
      ],
      indexes: [{ name: 'OfficeBlock_fileId_idx', cols: ['fileId'] }],
    }]);
    blocksChecked = !blocksReady;
  }
  return blocksReady;
}

interface BlockLayout { titles: string[] }

const parseQuery = (raw: string): ProjectQuery => cleanQuery(parseJsonSafe(raw) || {});
function parseLayout(raw: string, q: ProjectQuery): BlockLayout {
  const l = parseJsonSafe(raw) || {};
  const titles = Array.isArray(l.titles) ? l.titles.map(String) : [];
  return { titles: q.columns.map((c, i) => titles[i] || c) };
}

/** Строки блока: шапка из подписей колонок и данные запроса */
async function blockRows(projectId: string, q: ProjectQuery, layout: BlockLayout): Promise<FieldValue[][]> {
  const r = await runQuery(projectId, q);
  return [layout.titles, ...r.rows.map((x) => x.cells as FieldValue[])];
}

const blockView = async (b: any, projectId: string) => {
  const q = parseQuery(b.query);
  const layout = parseLayout(b.layout, q);
  const now = await blockFingerprint(projectId, q, layout);
  return { id: b.id, fileId: b.fileId, name: b.name, query: q, layout, fingerprint: b.fingerprint, updatedAt: b.updatedAt, stale: b.fingerprint !== now };
};

/** Видит ли человек файл: личный чужой — нет */
async function seesFile(req: Request, fileId: string): Promise<boolean> {
  if (!fileId) return true;
  const me = (req as any).authUser;
  const f = await getPrisma().fileNode.findUnique({ where: { id: fileId }, select: { scope: true, ownerId: true } });
  if (!f) return false;
  return me?.role === 'ADMIN' || f.scope !== 'PERSONAL' || !f.ownerId || f.ownerId === me?.id;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export function registerProjectDataRoutes(app: Express, deps: ProjectDataDeps): void {
  app.get('/api/project-data/catalog', catalog);
  app.get('/api/project-data/aliases', aliasesGet);
  app.put('/api/project-data/aliases', aliasesPut);
  app.post('/api/project-data/fn', fn);
  app.get('/api/project-data/fingerprint', fingerprint);
  app.post('/api/project-data/query', query);

  /** Проект, в котором разрешать поля: у файла — его проект */
  const ctxOf = async (src: any) => {
    const fileId = String(src?.fileId || '');
    return { fileId, projectId: await projectOfFile(fileId, String(src?.projectId || '')) };
  };

  // ── Поиск для панели «Данные проекта» ──
  app.get('/api/project-data/search', async (req: Request, res: Response) => {
    try {
      const ctx = await ctxOf(req.query);
      if (!(await seesFile(req, ctx.fileId))) return res.status(404).json({ error: 'Файл не найден' });
      res.json({ projectId: ctx.projectId, groups: await searchProject(String(req.query.q || ''), ctx) });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Значения полей по ключам ──
  app.post('/api/project-data/resolve', async (req: Request, res: Response) => {
    try {
      const ctx = await ctxOf(req.body);
      if (!(await seesFile(req, ctx.fileId))) return res.status(404).json({ error: 'Файл не найден' });
      const keys: string[] = Array.isArray(req.body?.keys) ? req.body.keys.map(String).slice(0, 2000) : [];
      res.json({ values: await resolveKeys(keys, ctx) });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Подписи файла: «Разработал / Проверил / Утвердил» ──
  app.get('/api/project-data/signers', async (req: Request, res: Response) => {
    try {
      const fileId = String(req.query.fileId || '');
      if (!fileId || !(await seesFile(req, fileId))) return res.status(404).json({ error: 'Файл не найден' });
      res.json({ signers: await signersOf(fileId) });
    } catch (err: any) { sendError(res, err); }
  });
  app.put('/api/project-data/signers', async (req: Request, res: Response) => {
    try {
      const fileId = String(req.body?.fileId || '');
      const role = String(req.body?.role || '') as SignRole;
      if (!fileId || !SIGN_ROLES.includes(role)) return res.status(400).json({ error: 'Нужны файл и роль подписи' });
      // Кто подписывает документ — часть документа: выбирает тот, кому можно его править
      const denied = await deps.mayWrite(req, fileId);
      if (denied) return res.status(403).json({ error: denied });
      const userId = req.body?.userId ? String(req.body.userId) : null;
      if (userId && !(await getPrisma().user.findUnique({ where: { id: userId }, select: { id: true } }))) {
        return res.status(400).json({ error: 'Такого сотрудника нет' });
      }
      await setSigner(fileId, role, userId);
      res.json({ signers: await signersOf(fileId) });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Умные блоки ──
  app.get('/api/project-data/blocks', async (req: Request, res: Response) => {
    try {
      const why = await ensureBlocks();
      if (why) return res.status(500).json({ error: `Таблица блоков не готова: ${why}` });
      const ctx = await ctxOf(req.query);
      if (!ctx.fileId || !(await seesFile(req, ctx.fileId))) return res.status(404).json({ error: 'Файл не найден' });
      const rows = await getPrisma().officeBlock.findMany({ where: { fileId: ctx.fileId }, orderBy: { createdAt: 'asc' } });
      res.json({ blocks: await Promise.all(rows.map((b: any) => blockView(b, ctx.projectId))) });
    } catch (err: any) { sendError(res, err); }
  });

  /**
   * Новый блок: запись в базе и строки для окна. Имя — следующий номер у
   * этого файла; строки блоков, убранных из книги, не удаляются (правило
   * данных), поэтому номер не повторяется
   */
  app.post('/api/project-data/blocks', async (req: Request, res: Response) => {
    try {
      const why = await ensureBlocks();
      if (why) return res.status(500).json({ error: `Таблица блоков не готова: ${why}` });
      const ctx = await ctxOf(req.body);
      if (!ctx.fileId) return res.status(400).json({ error: 'Не указан файл' });
      const denied = await deps.mayWrite(req, ctx.fileId);
      if (denied) return res.status(403).json({ error: denied });
      const q = cleanQuery(req.body?.query);
      if (!q.columns.length) return res.status(400).json({ error: 'В блоке нет ни одной колонки' });
      const layout = parseLayout(JSON.stringify(req.body?.layout || {}), q);
      const prisma = getPrisma();
      const have = await prisma.officeBlock.findMany({ where: { fileId: ctx.fileId }, select: { name: true } });
      const n = 1 + Math.max(0, ...have.map((b: any) => Number(BLOCK_RE.exec(b.name)?.[1] || 0)));
      const rows = await blockRows(ctx.projectId, q, layout);
      const block = await prisma.officeBlock.create({
        data: {
          id: randomUUID(), fileId: ctx.fileId, name: `FLUX_BLOCK_${n}`,
          query: JSON.stringify({ entity: q.entity, columns: q.columns, filters: q.filters, sort: q.sort }),
          layout: JSON.stringify(layout), fingerprint: '',
        },
      });
      res.json({ block: await blockView(block, ctx.projectId), rows, fingerprint: await blockFingerprint(ctx.projectId, q, layout) });
    } catch (err: any) { sendError(res, err); }
  });

  /** Собрать строки блока заново — окно запишет их в книгу через редактор */
  app.post('/api/project-data/blocks/:id/build', async (req: Request, res: Response) => {
    try {
      const b = await getPrisma().officeBlock.findUnique({ where: { id: req.params.id } });
      if (!b || !(await seesFile(req, b.fileId))) return res.status(404).json({ error: 'Блок не найден' });
      const projectId = await projectOfFile(b.fileId, String(req.body?.projectId || ''));
      const q = parseQuery(b.query);
      const layout = parseLayout(b.layout, q);
      res.json({ rows: await blockRows(projectId, q, layout), fingerprint: await blockFingerprint(projectId, q, layout), name: b.name });
    } catch (err: any) { sendError(res, err); }
  });

  /**
   * Строки легли в книгу — запомнить, по какому состоянию проекта. Отдельным
   * шагом: запомни сервер отпечаток при сборке, а запись в книгу сорвись, —
   * блок значился бы «актуальным» со старыми строками
   */
  app.post('/api/project-data/blocks/:id/built', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const b = await prisma.officeBlock.findUnique({ where: { id: req.params.id } });
      if (!b) return res.status(404).json({ error: 'Блок не найден' });
      const denied = await deps.mayWrite(req, b.fileId);
      if (denied) return res.status(403).json({ error: denied });
      const fp = String(req.body?.fingerprint || '').slice(0, 64);
      const next = await prisma.officeBlock.update({ where: { id: b.id }, data: { fingerprint: fp } });
      res.json({ block: await blockView(next, await projectOfFile(b.fileId, String(req.body?.projectId || ''))) });
    } catch (err: any) { sendError(res, err); }
  });

  /**
   * «Обновить поля» закрытого файла: поля и блоки — сервером, запись — общим
   * ядром с откатом. Открытый файл не трогается: его обновляет окно
   * редактора, а запись в обход окна спорила бы с держателем правки
   */
  app.post('/api/project-data/files/:id/update', async (req: Request, res: Response) => {
    try {
      const fileId = req.params.id;
      const prisma = getPrisma();
      const file = await prisma.fileNode.findUnique({ where: { id: fileId } });
      if (!file || !(await seesFile(req, fileId))) return res.status(404).json({ error: 'Файл не найден' });
      if (officeRooms.roster(fileId).peers.length) {
        return res.status(423).json({ error: 'Файл открыт в редакторе — обновите поля в его окне: «Данные проекта» → «Обновить поля»' });
      }
      const denied = await deps.mayWrite(req, fileId);
      if (denied) return res.status(403).json({ error: denied });
      const kind = /\.docx$/i.test(file.name) ? 'docx' : /\.xlsx$/i.test(file.name) ? 'xlsx' : '';
      if (!kind) return res.status(400).json({ error: 'Поля обновляются в документах .docx и книгах .xlsx' });
      const projectId = await projectOfFile(fileId, String(req.body?.projectId || ''));
      const before = await fileBytes(file);
      let bytes = before;
      const report: { changed: any[]; skipped: any[]; blocks: string[] } = { changed: [], skipped: [], blocks: [] };
      const built: { id: string; fingerprint: string }[] = [];
      if (kind === 'docx') {
        const keys = (await listDocxFields(bytes)).map((f) => f.key);
        const r = await updateDocxFields(bytes, await resolveKeys(keys, { projectId, fileId }));
        bytes = r.bytes; report.changed.push(...r.changed); report.skipped.push(...r.skipped);
      } else {
        const anchors = await listXlsxAnchors(bytes);
        const r = await updateXlsxFields(bytes, await resolveKeys(anchors.fields.map((f) => f.key), { projectId, fileId }));
        bytes = r.bytes; report.changed.push(...r.changed); report.skipped.push(...r.skipped);
        if (anchors.blocks.length && !(await ensureBlocks())) {
          const rows = await prisma.officeBlock.findMany({ where: { fileId } });
          for (const a of anchors.blocks) {
            const b = rows.find((x: any) => x.name === a.name);
            if (!b) { report.skipped.push({ key: a.name, why: 'блок без записи в базе', where: a.name }); continue; }
            const q = parseQuery(b.query);
            const layout = parseLayout(b.layout, q);
            const w = await writeXlsxBlock(bytes, a.name, await blockRows(projectId, q, layout));
            if (!w.bytes.equals(bytes)) report.blocks.push(a.name);
            bytes = w.bytes;
            built.push({ id: b.id, fingerprint: await blockFingerprint(projectId, q, layout) });
          }
        }
      }
      let sha = sha256(before);
      if (!bytes.equals(before)) {
        const w = await writeOfficeFile({ fileId, body: bytes, baseSha: sha, user: (req as any).authUser });
        if (w.status !== 200) return res.status(w.status).json(w.json);
        sha = w.json.sha256;
      }
      for (const b of built) await prisma.officeBlock.update({ where: { id: b.id }, data: { fingerprint: b.fingerprint } });
      res.json({ ...report, unchanged: bytes.equals(before), sha256: sha });
    } catch (err: any) { sendError(res, err); }
  });
}
