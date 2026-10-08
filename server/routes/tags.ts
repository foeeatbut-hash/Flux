import { emitProjectEvent } from '../projectEvents.js';
import { isPrivilegedUser } from '../accessPolicy.js';
import type { Express, Request, Response } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import * as XLSX from 'xlsx';
import { enrichEquipment } from '../equipmentCatalog.js';
import { getPrisma } from '../context.js';
import { emitEntityChanged } from '../entityChanged.js';
import { parseExcel, parseXML, importParsedDataToDB } from '../excelParser.js';
import { fileBytes } from './fileChunks.js';
import { canReadFile } from '../fileAccess.js';
import { canSeeProject, hiddenProjectsOf } from './members.js';
import { withBump, bumpElementsOfTags } from '../equipmentVersion.js';
import { writeTag, writeTags, metadataPatchOf, tagWriteFailure } from '../tagWrite.js';
import {
  TAG_SOURCE, tagChangeContext, recordChangeSets, recordTagCreated, recordTagUpdate, recordTagDeleted,
  updateSet, createdSet, deletedSet, type TagChangeSet,
} from '../tagHistory.js';

// Теги проекта: список и ручное создание, массовый импорт, захват с экрана
// (применение и отмена), разбор Excel/XML, системы и привязка тегов к
// элементам компонентов.
//
// Вынесено из server.ts. Помощники, которыми пользуется и остальной server.ts,
// передаются при подключении, а не импортируются обратно — это был бы круг.

interface TagDeps {
  /** Сокет-сервер живёт в server.ts: конфликты ревизий уходят всем окнам */
  io: SocketIOServer;
  /** Уведомление всей команде (кроме `exceptUserId`); нужно и проектам, поэтому остаётся в server.ts */
  notifyAll: (category: string, title: string, body?: string, targetRoute?: string, exceptUserId?: string) => Promise<void>;
}

// Проект «по умолчанию» (адрес без названного проекта) общий страж по адресу не
// видит: он проверяет только названные проекты. Разрешённое имя проверяем здесь,
// после того как оно определилось, — иначе посторонний получал данные закрытого
// первого проекта.
async function mayUseProject(req: Request, projectId: string): Promise<boolean> {
  const me = (req as any).authUser;
  return canSeeProject(String(me?.id || ''), projectId, isPrivilegedUser(me));
}
const NO_PROJECT = { error: 'Нет доступа к проекту. Попросите добавить вас в состав.' };

export function registerTagRoutes(app: Express, deps: TagDeps): void {
  const { io, notifyAll } = deps;
  app.get('/api/projects/:projectId/tags', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    const { projectId } = req.params;
    try {
      // componentElements: лёгкая проекция для клиента — по ней Менеджмент
      // подбирает шаблон этапов (тип оборудования/категория установки), а экран
      // «Оборудование» показывает занятость тега (один тег = одно изделие)
      const include = {
        equipment: true,
        componentElements: {
          select: {
            id: true, name: true, itemCode: true, equipType: true, status: true,
            monoblock: { select: { system: { select: { id: true, name: true, category: true } } } },
          },
        },
      } as const;
      let tags;
      if (!projectId || projectId === 'null' || projectId === 'undefined' || projectId === 'default') {
        // «Все теги» без проекта раньше отдавали и закрытые проекты: скрытые от
        // человека проекты исключаем
        const me = (req as any).authUser;
        const hidden = await hiddenProjectsOf(String(me?.id || ''), isPrivilegedUser(me));
        tags = await prisma.tag.findMany({ where: hidden.length ? { projectId: { notIn: hidden } } : undefined, include });
      } else {
        if (!(await mayUseProject(req, projectId))) return res.status(403).json(NO_PROJECT);
        tags = await prisma.tag.findMany({ where: { projectId }, include });
      }
      res.json({ tags });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create tag manually
  app.post('/api/projects/:projectId/tags', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    let { projectId } = req.params;
    const { identifier, department, wbs, fluid, metadata, brand } = req.body;
    try {
      if (!projectId || projectId === 'null' || projectId === 'undefined' || projectId === 'default') {
        let firstProject = await prisma.project.findFirst();
        if (!firstProject) {
          firstProject = await prisma.project.create({ data: { name: 'Общий Проект' } });
        }
        projectId = firstProject.id;
      }
      if (!(await mayUseProject(req, projectId))) return res.status(403).json(NO_PROJECT);
      const tag = await prisma.tag.create({
        data: {
          projectId,
          identifier,
          department: department || null,
          wbs: wbs || null,
          fluid: fluid || null,
          brand: brand || null,
          metadata: metadata ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null
        }
      });
      // Автор создания — из сессии, для любого пути создания (в metadata.createdBy
      // он был только у быстрой строки, и то именем, а не идентификатором)
      await recordTagCreated(prisma, tagChangeContext(req, projectId, TAG_SOURCE.tags), tag);
      res.json({ tag });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Разбор xlsx-файла из Проводника на листы (для мастера импорта тегов)
  app.post('/api/excel/sheets', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const { fileId } = req.body;
      const file = await prisma.fileNode.findUnique({ where: { id: String(fileId) } });
      // Разбор по номеру файла отдаёт его ячейки — правило чтения то же, что у
      // Проводника; чужой личный файл неотличим от несуществующего
      if (!file || !(await canReadFile(prisma, (req as any).authUser, file))) return res.status(404).json({ error: 'Файл не найден' });
      // Байты общим путём: содержимое лежит кусками, а у старых файлов — строкой
      const buf = await fileBytes(file);
      if (!buf.length) return res.status(404).json({ error: 'У файла нет содержимого' });
      const wb = XLSX.read(buf, { type: 'buffer' });
      const sheets = wb.SheetNames.map(name => {
        const rows = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[name], { header: 1, blankrows: false, defval: '' });
        const trimmed = rows.slice(0, 500).map(r => (r || []).map((c: any) => (c === null || c === undefined) ? '' : String(c)));
        return { name, rows: trimmed, totalRows: rows.length };
      });
      res.json({ sheets, fileName: file.name });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Массовый импорт тегов из размеченной таблицы
  // rows: [{identifier, brand, name, department, fluid, wbs, parent, actuality}], mode: 'add'|'update'
  app.post('/api/projects/:projectId/tags/bulk-import', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    let { projectId } = req.params;
    const { rows, mode } = req.body;
    // Объявлено до try: при сбое посреди импорта уже сделанное всё равно попадает в историю
    const history: Array<TagChangeSet | null> = [];
    try {
      if (!projectId || ['null', 'undefined', 'default'].includes(projectId)) {
        let fp = await prisma.project.findFirst(); if (!fp) fp = await prisma.project.create({ data: { name: 'Общий Проект' } }); projectId = fp.id;
      }
      if (!(await mayUseProject(req, projectId))) return res.status(403).json(NO_PROJECT);
      const existing = await prisma.tag.findMany({ where: { projectId } });
      const byCode = new Map<string, any>();
      const codeToId = new Map<string, string>();
      for (const t of existing) { const k = (t.identifier || '').trim(); if (k) { if (!byCode.has(k)) byCode.set(k, t); codeToId.set(k, t.id); } }
      let created = 0, updated = 0; const dupes: string[] = [];
      const parentLinks: { childCode: string; parentCode: string }[] = [];
      let col = 0;
      // Новые карточки — рядами ниже уже стоящих. Сетка от угла холста клала
      // второй ввоз ровно поверх первого: П5 на П1, П6 на П3, и щелчок по
      // ссылке на тег показывал соседа, лежащего сверху
      let topY = 80;
      for (const t of existing) {
        try { const y = Number(JSON.parse(t.metadata || '{}').y); if (Number.isFinite(y)) topY = Math.max(topY, y + 150); } catch { /* без координат — не мешает */ }
      }
      for (const r of (rows || [])) {
        const code = String(r.identifier || '').trim();
        if (!code) continue;
        const baseData = {
          identifier: code,
          brand: r.brand ? String(r.brand) : null,
          department: r.department ? String(r.department) : null,
          fluid: r.fluid ? String(r.fluid) : null,
          wbs: r.wbs ? String(r.wbs) : null,
        };
        const ex = byCode.get(code);
        if (ex && mode === 'update') {
          let exMeta: any = {}; try { exMeta = ex.metadata ? JSON.parse(ex.metadata) : {}; } catch {}
          const merged = { ...exMeta, ...(r.name ? { mainName: String(r.name) } : {}), ...(r.actuality ? { actuality: String(r.actuality) } : {}) };
          if (!Array.isArray(merged.connections)) merged.connections = [];
          const after = await prisma.tag.update({ where: { id: ex.id }, data: { ...baseData, metadata: JSON.stringify(merged) } });
          history.push(updateSet(ex, after));
          // Следующая строка с тем же кодом сравнивается уже с записанным, а не с исходным
          byCode.set(code, after);
          updated++; codeToId.set(code, ex.id);
        } else {
          if (ex) dupes.push(code);
          const meta: any = { connections: [], descriptions: [], x: 120 + (col % 6) * 360, y: topY + Math.floor(col / 6) * 150 };
          if (r.name) meta.mainName = String(r.name);
          if (r.actuality) meta.actuality = String(r.actuality);
          const t = await prisma.tag.create({ data: { projectId, ...baseData, metadata: JSON.stringify(meta) } });
          history.push(createdSet(t));
          created++; codeToId.set(code, t.id); col++;
        }
        if (r.parent) parentLinks.push({ childCode: code, parentCode: String(r.parent).trim() });
      }
      const byParent: Record<string, string[]> = {};
      for (const { childCode, parentCode } of parentLinks) {
        const childId = codeToId.get(childCode); const parentId = codeToId.get(parentCode);
        if (childId && parentId && childId !== parentId) (byParent[parentId] ||= []).push(childId);
      }
      for (const [parentId, childIds] of Object.entries(byParent)) {
        const p = await prisma.tag.findUnique({ where: { id: parentId } });
        let pm: any = {}; try { pm = p?.metadata ? JSON.parse(p.metadata) : {}; } catch {}
        pm.connections = [...new Set([...(Array.isArray(pm.connections) ? pm.connections : []), ...childIds])];
        const after = await prisma.tag.update({ where: { id: parentId }, data: { metadata: JSON.stringify(pm) } });
        if (p) history.push(updateSet(p, after));
      }
      await recordChangeSets(prisma, tagChangeContext(req, projectId, TAG_SOURCE.tagImport), history);
      res.json({ created, updated, duplicates: [...new Set(dupes)] });
    } catch (err: any) {
      await recordChangeSets(prisma, tagChangeContext(req, String(projectId), TAG_SOURCE.tagImport), history);
      res.status(500).json({ error: err.message });
    }
  });

  // Применение плана захвата с экрана.
  //
  // Отличие от bulk-import: там режим один на весь список ('add' | 'update'),
  // а здесь решение своё у каждой строки — их девять классов конфликтов
  // (см. docs/screen-capture-design.md). Возвращаем идентификаторы созданного
  // и дополненного: по ним клиент подсвечивает добавленное в Реестре.
  //
  // Удалений тут нет и быть не может: захват — фрагмент, а не документ.
  app.post('/api/projects/:projectId/tags/capture-apply', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    let { projectId } = req.params;
    const { rows } = req.body as {
      rows: {
        identifier: string; brand?: string; name?: string; department?: string;
        fluid?: string; wbs?: string; actuality?: string;
        action: 'create' | 'skip' | 'fill' | 'replace' | 'duplicate' | 'link';
        targetId?: string;
      }[];
    };
    const history: Array<TagChangeSet | null> = [];
    try {
      if (!projectId || ['null', 'undefined', 'default'].includes(projectId)) {
        let fp = await prisma.project.findFirst();
        if (!fp) fp = await prisma.project.create({ data: { name: 'Общий Проект' } });
        projectId = fp.id;
      }
      if (!(await mayUseProject(req, projectId))) return res.status(403).json(NO_PROJECT);
      const existing = await prisma.tag.findMany({ where: { projectId } });
      const byId = new Map(existing.map((t: any) => [t.id, t]));

      // Новые карточки кладём под уже занятыми, а не в одну точку холста
      let maxY = 0;
      for (const t of existing as any[]) {
        try { const m = t.metadata ? JSON.parse(t.metadata) : null; if (m && typeof m.y === 'number') maxY = Math.max(maxY, m.y); } catch {}
      }
      let col = 0;
      const nextPos = () => {
        const p = { x: 120 + (col % 6) * 360, y: maxY + 200 + Math.floor(col / 6) * 150 };
        col++;
        return p;
      };

      const created: { id: string; identifier: string }[] = [];
      const filled: { id: string; identifier: string }[] = [];
      const duplicated: { id: string; identifier: string }[] = [];
      const linked: { id: string; identifier: string }[] = [];
      const skipped: string[] = [];

      for (const r of (rows || [])) {
        const code = String(r.identifier || '').trim();
        if (!code) continue;
        const action = r.action;
        if (action === 'skip') { skipped.push(code); continue; }

        const target: any = r.targetId ? byId.get(r.targetId) : null;

        if (action === 'link') {
          if (target) linked.push({ id: target.id, identifier: target.identifier });
          else skipped.push(code);
          continue;
        }

        if ((action === 'fill' || action === 'replace') && target) {
          const data: any = {};
          for (const f of ['brand', 'department', 'fluid', 'wbs'] as const) {
            const incoming = r[f] ? String(r[f]).trim() : '';
            if (!incoming) continue;
            const mine = String(target[f] || '').trim();
            // «Дополнить» трогает только пустое — в этом вся его безопасность
            if (action === 'fill' && mine) continue;
            data[f] = incoming;
          }
          let meta: any = {};
          try { meta = target.metadata ? JSON.parse(target.metadata) : {}; } catch {}
          if (r.name && (action === 'replace' || !meta.mainName)) meta.mainName = String(r.name);
          if (r.actuality && (action === 'replace' || !meta.actuality)) meta.actuality = String(r.actuality);
          if (!Array.isArray(meta.connections)) meta.connections = [];
          const after = await prisma.tag.update({ where: { id: target.id }, data: { ...data, metadata: JSON.stringify(meta) } });
          history.push(updateSet(target, after));
          byId.set(target.id, after);
          filled.push({ id: target.id, identifier: target.identifier });
          continue;
        }

        // create и duplicate пишутся одинаково; разными их делает только то,
        // что duplicate выбран осознанно при уже существующем коде
        const pos = nextPos();
        const meta: any = { connections: [], descriptions: [], x: pos.x, y: pos.y };
        if (r.name) meta.mainName = String(r.name);
        if (r.actuality) meta.actuality = String(r.actuality);
        const t = await prisma.tag.create({
          data: {
            projectId,
            identifier: code,
            brand: r.brand ? String(r.brand) : null,
            department: r.department ? String(r.department) : null,
            fluid: r.fluid ? String(r.fluid) : null,
            wbs: r.wbs ? String(r.wbs) : null,
            metadata: JSON.stringify(meta),
          },
        });
        history.push(createdSet(t));
        (action === 'duplicate' ? duplicated : created).push({ id: t.id, identifier: code });
      }

      await recordChangeSets(prisma, tagChangeContext(req, projectId, TAG_SOURCE.capture), history);
      res.json({ created, filled, duplicated, linked, skipped });
    } catch (err: any) {
      await recordChangeSets(prisma, tagChangeContext(req, String(projectId), TAG_SOURCE.capture), history);
      res.status(500).json({ error: err.message });
    }
  });

  // Update tag fields and json metadata
  // Отмена захвата: удаляем созданное, возвращаем дополненному прежние значения.
  //
  // Прежние значения приходят с клиента — он снял их снимком до применения.
  // Хранить их на сервере незачем: откат живёт ровно столько, сколько открыт
  // отчёт, и нужен на случай «нажал не подумав», а не как полноценная история.
  app.post('/api/projects/:projectId/tags/capture-undo', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    const { projectId } = req.params;
    const { deleteIds, restore } = req.body as {
      deleteIds: string[];
      restore: { id: string; brand: string | null; department: string | null;
                 fluid: string | null; wbs: string | null; metadata: string | null }[];
    };
    const history: Array<TagChangeSet | null> = [];
    try {
      let deleted = 0, restored = 0;
      // Только теги этого проекта: идентификатор из чужого проекта сюда не пройдёт
      if (Array.isArray(deleteIds) && deleteIds.length) {
        const ids = deleteIds.slice(0, 2000);
        // Коды читаем до удаления: после него записать в историю, что именно
        // удалено, было бы нечем
        const going = await prisma.tag.findMany({ where: { id: { in: ids }, projectId }, select: { id: true, identifier: true } });
        await bumpElementsOfTags(prisma, going.map((g: any) => g.id));
        const r = await prisma.tag.deleteMany({ where: { id: { in: ids }, projectId } });
        deleted = r.count;
        for (const g of going) history.push(deletedSet(g));
      }
      for (const t of (restore || []).slice(0, 2000)) {
        const own = await prisma.tag.findFirst({ where: { id: String(t.id), projectId } });
        if (!own) continue;
        const after = await prisma.tag.update({
          where: { id: t.id },
          data: {
            brand: t.brand ?? null,
            department: t.department ?? null,
            fluid: t.fluid ?? null,
            wbs: t.wbs ?? null,
            metadata: t.metadata ?? null,
          },
        });
        history.push(updateSet(own, after));
        restored++;
      }
      await recordChangeSets(prisma, tagChangeContext(req, projectId, TAG_SOURCE.restore), history);
      res.json({ deleted, restored });
    } catch (err: any) {
      await recordChangeSets(prisma, tagChangeContext(req, projectId, TAG_SOURCE.restore), history);
      res.status(500).json({ error: err.message });
    }
  });

  // Массовое обновление metadata тегов одним запросом (Менеджмент: этап для N позиций).
  // Раньше клиент слал N последовательных PUT — на больших выборках это заметно тормозило.
  // ВАЖНО: маршрут объявлен раньше '/api/tags/:id', иначе «bulk-metadata» сматчится как id.
  //
  // Как и одиночная запись, сливает присланные верхние ключи с текущими
  // (server/tagWrite.ts): раньше экран «Закупки» присылал metadata целиком, и
  // каждая смена этапа у N позиций заодно стирала чужие комментарии.
  // `source: 'Закупки'` сужает запрос до ключа procurement — остальное он не тронет.
  app.put('/api/tags/bulk-metadata', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    const { updates, source } = req.body as { updates: { id: string; metadata: unknown }[]; source?: string };
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'updates[] required' });
    }
    const limited = updates.slice(0, 2000);
    const procurement = source === TAG_SOURCE.procurement;
    try {
      const { results, missing } = await writeTags(prisma, limited.map(u => ({
        id: String(u.id),
        input: { metadata: metadataPatchOf(u.metadata), onlyKeys: procurement ? ['procurement'] : undefined },
      })));
      // Раскладка карточек сюда тоже приходит, но координаты правкой не считаются
      await recordChangeSets(prisma, tagChangeContext(req, '', procurement ? TAG_SOURCE.procurement : TAG_SOURCE.tags),
        results.filter(r => !r.unchanged).map(r => updateSet(r.before, r.tag)));
      // Новые версии — чтобы экран не держал устаревшую после собственной записи
      res.json({ success: true, updated: results.length, missing, versions: results.map(r => ({ id: r.tag.id, updatedAt: r.tag.updatedAt })) });
    } catch (err: any) {
      const known = tagWriteFailure(err);
      if (known) return res.status(known.status).json(known.body);
      res.status(500).json({ error: err.message });
    }
  });

  // Правка тега. metadata СЛИВАЕТСЯ с текущей по верхним ключам (null удаляет ключ),
  // а `version` (updatedAt, как его прочитал экран) защищает от затирания чужой правки:
  // тег изменился — ответ 409 с текущим тегом. Подробности — server/tagWrite.ts.
  app.put('/api/tags/:id', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    const { identifier, department, wbs, fluid, metadata, equipmentId, brand, version } = req.body;
    try {
      const { before, tag, unchanged } = await writeTag(prisma, req.params.id, {
        fields: { identifier, department, wbs, fluid, equipmentId, brand },
        metadata: metadataPatchOf(metadata),
        version: version === undefined ? undefined : (version === null ? null : String(version)),
      });
      if (!unchanged) {
        await recordTagUpdate(prisma, tagChangeContext(req, tag.projectId, TAG_SOURCE.tags), before, tag);
        emitEntityChanged('tag', tag.id, req);
      }
      res.json({ tag });
    } catch (err: any) {
      const known = tagWriteFailure(err);
      if (known) return res.status(known.status).json(known.body);
      res.status(500).json({ error: err.message });
    }
  });

  // Parse and import Excel/XML
  app.post('/api/projects/:projectId/excel/parse-and-import', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    let { projectId } = req.params;
    const { fileContent, fileName } = req.body;
    if (!fileContent || !fileName) {
      return res.status(400).json({ error: 'Missing fileContent or fileName' });
    }

    try {
      if (!projectId || projectId === 'null' || projectId === 'undefined' || projectId === 'default') {
        let firstProject = await prisma.project.findFirst();
        if (!firstProject) {
          firstProject = await prisma.project.create({ data: { name: 'Общий Проект' } });
        }
        projectId = firstProject.id;
      }
      if (!(await mayUseProject(req, projectId))) return res.status(403).json(NO_PROJECT);

      const buffer = Buffer.from(fileContent, 'base64');
      const extension = fileName.split('.').pop()?.toLowerCase();
    
      let result;
      if (extension === 'xml') {
        const fileText = buffer.toString('utf-8');
        result = parseXML(fileText);
      } else {
        result = parseExcel(buffer);
      }

      const importedData = await importParsedDataToDB(projectId, result, prisma, fileName);
      const conflictsCount = await prisma.componentElement.count({
        where: {
          monoblock: {
            system: {
              projectId
            }
          },
          hasConflict: true
        }
      });

      // Extract elements that became conflicts to notify client in real-time
      const conflictComponents = await prisma.componentElement.findMany({
        where: {
          monoblock: {
            system: {
              projectId
            }
          },
          status: 'CONFLICT',
          hasConflict: true
        },
        include: {
          monoblock: {
            include: {
              system: true
            }
          }
        }
      });

      for (const comp of conflictComponents) {
        const msg = `Найден конфликт в установке "${comp.monoblock.system.name}" на элементе "${comp.name}"`;
        await emitProjectEvent(io, comp.monoblock.system.projectId, 'equipment:conflict', {
          componentId: comp.id,
          systemId: comp.monoblock.system.id,
          message: msg,
          changeDetails: comp.conflictLog || 'Параметры изменены в ревизии файла'
        });
      }

      // Конфликты ревизий — повод уведомить команду: их разбирает не всегда
      // тот, кто импортировал, и до сих пор о них узнавали только случайно.
      if (conflictsCount > 0) {
        await notifyAll('ОБОРУДОВАНИЕ',
          `Конфликты ревизий: ${conflictsCount}`,
          `После импорта «${fileName}» характеристики позиций разошлись — нужна сверка.`,
          '/equipment', String((req as any).authUser?.id || ''));
      }

      res.json({ success: true, systems: importedData, conflictsCount });
    } catch (error: any) {
      console.error('Error in parse-and-import:', error);
      res.status(500).json({ error: error.message || 'Failed to parse file' });
    }
  });

  // Fetch systems with nested structure for project
  app.get('/api/projects/:projectId/systems', async (req: Request, res: Response) => {
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
      if (!(await mayUseProject(req, projectId))) return res.status(403).json(NO_PROJECT);
      // Снятые позиции (`REMOVED`) отдаются только тому, кто просит: у остальных
      // потребителей установка — это действующее оборудование. Дерево
      // «Оборудования» просит их за переключателем «показать снятые»
      const withRemoved = req.query.removed === '1';
      const systems = await prisma.equipmentSystem.findMany({
        where: { projectId },
        include: {
          monoblocks: {
            include: {
              components: {
                ...(withRemoved ? {} : { where: { status: { not: 'REMOVED' } } }),
                include: {
                  tags: true
                }
              }
            }
          }
        }
      });
      await enrichEquipment(systems);
      res.json({ systems });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Delete an entire equipment system ("установка")
  app.delete('/api/systems/:id', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    const { id } = req.params;
    try {
      await prisma.equipmentSystem.delete({
        where: { id }
      });
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Bind a tag to a ComponentElement
  app.post('/api/components/:componentId/tags/:tagId', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    const { componentId, tagId } = req.params;
    try {
      // Один тег — одно изделие: тег, уже привязанный к другому элементу,
      // повторно привязать нельзя (иначе одно обозначение висело бы на двух узлах)
      const existing = await prisma.tag.findUnique({
        where: { id: tagId },
        include: { componentElements: { select: { id: true, name: true, itemCode: true } } },
      });
      if (!existing) return res.status(404).json({ error: 'Тег не найден' });
      const takenBy = (existing.componentElements || []).find((c: any) => c.id !== componentId);
      if (takenBy) {
        return res.status(409).json({
          error: `Тег «${existing.identifier}» уже привязан к «${takenBy.name || takenBy.itemCode}». Один тег — одно изделие: сначала отвяжите его там.`,
        });
      }
      const component = await prisma.componentElement.update({
        where: { id: componentId },
        data: withBump({
          tags: {
            connect: { id: tagId }
          }
        }),
        include: { tags: true }
      });
      res.json({ component });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Unbind a tag from a ComponentElement
  app.delete('/api/components/:componentId/tags/:tagId', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    const { componentId, tagId } = req.params;
    try {
      const component = await prisma.componentElement.update({
        where: { id: componentId },
        data: withBump({
          tags: {
            disconnect: { id: tagId }
          }
        }),
        include: { tags: true }
      });
      res.json({ component });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Delete tag
  app.delete('/api/tags/:id', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const gone = await prisma.tag.findUnique({ where: { id: req.params.id } });
      if (!gone) return res.status(404).json({ error: 'Тег не найден' });
      await bumpElementsOfTags(prisma, [gone.id]);
      await prisma.tag.delete({ where: { id: req.params.id } });
      // История удалённого тега остаётся: таблица с тегом не связана
      await recordTagDeleted(prisma, tagChangeContext(req, gone.projectId, TAG_SOURCE.tags), gone);
      res.json({ success: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // GET component element history logs
  app.get('/api/components/:componentId/history', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    const { componentId } = req.params;
    try {
      const history = await prisma.equipmentHistory.findMany({
        where: { elementId: componentId },
        orderBy: { changedAt: 'desc' }
      });
      res.json({ history });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST to resolve a conflict manually
  app.post('/api/components/:componentId/resolve-conflict', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    const { componentId } = req.params;
    try {
      const component = await prisma.componentElement.update({
        where: { id: componentId },
        data: {
          hasConflict: false,
          conflictType: null
        },
        include: {
          tags: true
        }
      });
      res.json({ component });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Create tag based on prefix generator
  app.post('/api/tags/generate', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    const { projectId, prefix, suffix, metadata } = req.body;
  
    // Find all tags in project that start with prefix
    const existingTags = await prisma.tag.findMany({
      where: {
        projectId,
        identifier: { startsWith: prefix }
      },
      select: { identifier: true }
    });
  
    let maxSeq = 0;
    let sequenceLength = 3; // default
  
    // Assume identifier is prefix + sequence + suffix
    // Note: this is a simple naive parser, depending on complexity of sequence padding
    for (const tag of existingTags) {
      const ident = tag.identifier;
      // Extract sequence part based on prefix and suffix
      let seqStr = ident.slice(prefix.length);
      if (suffix && seqStr.endsWith(suffix)) {
        seqStr = seqStr.slice(0, -suffix.length);
      }
      // Учитываем только чисто числовые последовательности: parseInt("001_V2") вернул бы 1,
      // а длина 6 испортила бы автоопределение паддинга
      if (!/^\d+$/.test(seqStr)) continue;
      const seqNum = parseInt(seqStr, 10);
      if (!isNaN(seqNum)) {
        maxSeq = Math.max(maxSeq, seqNum);
        if (seqStr.length > sequenceLength) sequenceLength = seqStr.length; // auto detect padding if necessary
      }
    }
  
    const nextSeq = maxSeq + 1;
    const paddedSeq = nextSeq.toString().padStart(sequenceLength, '0');
  
    const finalIdentifier = `${prefix}${paddedSeq}${suffix || ''}`;
  
    const newTag = await prisma.tag.create({
      data: {
        projectId,
        identifier: finalIdentifier,
        metadata: metadata ? JSON.stringify(metadata) : null
      },
      include: { equipment: true } // we just keep the include to match existing response
    });
    await recordTagCreated(prisma, tagChangeContext(req, projectId, TAG_SOURCE.tags), newTag);

    res.json({ tag: newTag });
  });
}
