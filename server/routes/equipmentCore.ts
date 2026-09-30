import type { Express, Request, Response } from 'express';
import { getPrisma, upsertSetting } from '../context.js';
import { emitEntityChanged } from '../entityChanged.js';
import { readEquipmentFile } from '../equipmentFile.js';
import { importEquipmentToDB } from '../equipmentImport.js';
import { planEquipmentImport, applyEdits, filterBySelection } from '../equipmentPlan.js';
import { cleanTagLinks } from './equipmentDraft.js';

// Оборудование, ядро: план и запись импорта расчёта в категорию, категории,
// разрешение конфликтов параметров и ручная правка полей.
//
// Вынесено из server.ts. Ввоз распознанного документа (equipmentDraft.ts) и
// настройки (settings.ts) раньше стояли между этими маршрутами, но путей с ними
// не делят (у них точные пути и `/api/settings/:key`), поэтому порядок
// относительно них не важен.

// --- VENTILATION EQUIPMENT API ---

// 1. Импорт расчёта в выбранную категорию (новый парсер: группы + тип + ревизии)
// Общий шаг: файл Проводника → разобранный расчёт. Кидает { status, error }
// при проблемах формата, чтобы оба роута (план и запись) отвечали одинаково.

/**
 * Проект импорта — только названный в запросе.
 *
 * Прежний вариант брал первый попавшийся проект, а если проектов не было —
 * заводил «Общий Проект» прямо во время предпросмотра. Оборудование при этом
 * могло уехать в чужой проект, и заметить это было нечем.
 */
async function resolveImportProject(reqProjectId: any): Promise<string> {
  const prisma = getPrisma();
  const projectId = String(reqProjectId || '');
  if (!projectId || ['null', 'undefined', 'default'].includes(projectId)) {
    throw { status: 400, error: 'Не выбран проект. Импорт оборудования ведётся по проекту — выберите его и повторите.' };
  }
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw { status: 400, error: 'Проект не найден — выберите проект и повторите.' };
  return projectId;
}
// Категории оборудования (список с возможностью добавления)
const DEFAULT_CATEGORIES = [
  { id: 'AHU', label: 'Центральные кондиционеры', composite: true },
  { id: 'FAN', label: 'Радиальные вентиляторы', composite: false },
  { id: 'VALVE', label: 'Клапаны', composite: false },
  { id: 'CURTAIN', label: 'Воздушные завесы', composite: false },
];

export function registerEquipmentCoreRoutes(app: Express): void {

  // Dry-run: что изменится в проекте, без записи (дерево + дифф для предпросмотра)
  app.post('/api/equipment/import-plan', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    const { fileId, category, projectId: reqProjectId, edits } = req.body;
    if (!fileId || !category) return res.status(400).json({ error: 'Не указан файл или категория' });
    try {
      const projectId = await resolveImportProject(reqProjectId);
      const { result, fileName } = await readEquipmentFile(fileId, projectId, (req as any).authUser);
      const edited = applyEdits(result, edits);
      const plan = await planEquipmentImport(prisma, projectId, category, edited);
      res.json({ success: true, fileName, plan });
    } catch (err: any) {
      if (err && err.status) return res.status(err.status).json({ error: err.error });
      console.error('Error in import-plan:', err);
      res.status(500).json({ error: err.message || 'Не удалось построить план импорта' });
    }
  });

  app.post('/api/equipment/import-to-category', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    const { fileId, category, projectId: reqProjectId, edits, selection, tagLinks } = req.body;
    if (!fileId || !category) {
      return res.status(400).json({ error: 'Не указан файл или категория' });
    }

    try {
      const projectId = await resolveImportProject(reqProjectId);
      const { result, fileName } = await readEquipmentFile(fileId, projectId, (req as any).authUser);

      // Правки предпросмотра и выбор области применяются до записи
      const edited = applyEdits(result, edits);
      const sel = Array.isArray(selection) ? new Set<string>(selection) : null;
      const finalResult = filterBySelection(edited, sel);
      if (!finalResult.units.length) {
        return res.status(400).json({ error: 'Не выбрано ни одного блока для импорта' });
      }

      // Режим разрешения конфликтов из глобальных настроек
      const modeSetting = await prisma.appSetting.findFirst({ where: { key: 'equip_conflict_mode', userId: null } });
      const conflictMode: 'immediate' | 'wait' = (modeSetting && modeSetting.value === 'immediate') ? 'immediate' : 'wait';

      const summary = await importEquipmentToDB(prisma, projectId, category, fileName, finalResult, conflictMode, cleanTagLinks(tagLinks));

      res.json({
        success: true,
        conflictsCount: summary.conflictsCount,
        newBlocks: summary.newBlocks,
        updatedBlocks: summary.updatedBlocks,
        systems: summary.systems,
        batchId: summary.batchId,
        tagsLinked: summary.tagsLinked,
        tagsCreated: summary.tagsCreated,
        tagConflicts: summary.tagConflicts,
        conflictMode,
      });
    } catch (error: any) {
      if (error && error.status) return res.status(error.status).json({ error: error.error });
      console.error('Error in import-to-category:', error);
      res.status(500).json({ error: error.message || 'Не удалось импортировать файл' });
    }
  });
  app.get('/api/equipment/categories', async (_req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const s = await prisma.appSetting.findFirst({ where: { key: 'equip_categories', userId: null } });
      let cats: any = DEFAULT_CATEGORIES;
      if (s) { try { cats = JSON.parse(s.value); } catch (_) {} }
      res.json({ categories: cats });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/equipment/categories', async (req: Request, res: Response) => {
    try {
      const { categories } = req.body;
      if (!Array.isArray(categories)) return res.status(400).json({ error: 'categories[] required' });
      await upsertSetting('equip_categories', null, JSON.stringify(categories));
      res.json({ success: true });
    } catch (err: any) { res.status(500).json({ success: false, message: err.message }); }
  });

  // Разрешение конфликта по параметру: принять расчёт (accept) или ручное значение (manual)
  app.post('/api/equipment/component/:id/resolve', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const { id } = req.params;
      const { group, key, action, value } = req.body;
      const comp = await prisma.componentElement.findUnique({ where: { id } });
      if (!comp) return res.status(404).json({ error: 'Элемент не найден' });

      const conflicts = comp.paramConflicts ? JSON.parse(comp.paramConflicts) : [];
      const conflict = conflicts.find((c: any) => c.group === group && c.key === key);
      const specsObj = comp.specs ? JSON.parse(comp.specs) : { groups: [] };
      const overrides = comp.overrides ? JSON.parse(comp.overrides) : {};

      const applyValue = action === 'manual' ? String(value ?? '') : (conflict ? conflict.newValue : undefined);
      if (applyValue !== undefined) {
        let grp = (specsObj.groups || []).find((g: any) => g.title === group);
        if (!grp) { grp = { title: group, params: [] }; specsObj.groups = [...(specsObj.groups || []), grp]; }
        let p = grp.params.find((x: any) => x.key === key);
        if (!p) { p = { key, value: '', unit: conflict?.unit || '' }; grp.params.push(p); }
        p.value = applyValue;
        if (action === 'manual') overrides[`${group}||${key}`] = applyValue;
      }

      const remaining = conflicts.filter((c: any) => !(c.group === group && c.key === key));
      const updated = await prisma.componentElement.update({
        where: { id },
        data: {
          specs: JSON.stringify(specsObj),
          overrides: JSON.stringify(overrides),
          paramConflicts: remaining.length ? JSON.stringify(remaining) : null,
          hasConflict: remaining.length > 0,
          status: remaining.length > 0 ? 'CONFLICT' : 'OK',
        },
      });
      emitEntityChanged('element', updated.id, req);
      res.json({ success: true, component: updated });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Ручное изменение любого параметра
  app.post('/api/equipment/component/:id/override', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const { id } = req.params;
      const { group, key, value } = req.body;
      const comp = await prisma.componentElement.findUnique({ where: { id } });
      if (!comp) return res.status(404).json({ error: 'Элемент не найден' });
      const specsObj = comp.specs ? JSON.parse(comp.specs) : { groups: [] };
      const overrides = comp.overrides ? JSON.parse(comp.overrides) : {};
      let grp = (specsObj.groups || []).find((g: any) => g.title === group);
      if (!grp) { grp = { title: group, params: [] }; specsObj.groups = [...(specsObj.groups || []), grp]; }
      let p = grp.params.find((x: any) => x.key === key);
      if (!p) { p = { key, value: '', unit: '' }; grp.params.push(p); }
      p.value = String(value ?? '');
      overrides[`${group}||${key}`] = p.value;
      const updated = await prisma.componentElement.update({
        where: { id }, data: { specs: JSON.stringify(specsObj), overrides: JSON.stringify(overrides) },
      });
      emitEntityChanged('element', updated.id, req);
      res.json({ success: true, component: updated });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // 2. Accept a field discrepancy from conflict
  app.post('/api/components/:id/accept-field', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    const { id } = req.params;
    const { fieldName } = req.body;
    if (!fieldName) {
      return res.status(400).json({ error: 'fieldName is required' });
    }

    try {
      const component = await prisma.componentElement.findUnique({
        where: { id }
      });
      if (!component) {
        return res.status(404).json({ error: 'Элемент не найден' });
      }

      const specsObj = component.specs ? JSON.parse(component.specs) : {};
      const conflictLogObj = component.conflictLog ? JSON.parse(component.conflictLog) : {};

      if (!conflictLogObj[fieldName]) {
        return res.status(400).json({ error: 'Конфликт по данному полю не найден' });
      }

      const newVal = conflictLogObj[fieldName].new;
      specsObj[fieldName] = newVal;
      delete conflictLogObj[fieldName];

      const hasRemainingConflicts = Object.keys(conflictLogObj).length > 0;

      const updated = await prisma.componentElement.update({
        where: { id },
        data: {
          specs: JSON.stringify(specsObj),
          conflictLog: hasRemainingConflicts ? JSON.stringify(conflictLogObj) : null,
          hasConflict: hasRemainingConflicts,
          status: hasRemainingConflicts ? 'CONFLICT' : 'OK'
        }
      });

      emitEntityChanged('element', updated.id, req);
      res.json({ success: true, component: updated });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // 3. Manually edit a field and resolve its conflict
  app.post('/api/components/:id/manual-edit-field', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    const { id } = req.params;
    const { fieldName, newValue } = req.body;
    if (!fieldName) {
      return res.status(400).json({ error: 'fieldName is required' });
    }

    try {
      const component = await prisma.componentElement.findUnique({
        where: { id }
      });
      if (!component) {
        return res.status(404).json({ error: 'Элемент не найден' });
      }

      const specsObj = component.specs ? JSON.parse(component.specs) : {};
      const conflictLogObj = component.conflictLog ? JSON.parse(component.conflictLog) : {};

      specsObj[fieldName] = newValue;
      if (conflictLogObj[fieldName]) {
        delete conflictLogObj[fieldName];
      }

      const hasRemainingConflicts = Object.keys(conflictLogObj).length > 0;

      const updated = await prisma.componentElement.update({
        where: { id },
        data: {
          specs: JSON.stringify(specsObj),
          conflictLog: hasRemainingConflicts ? JSON.stringify(conflictLogObj) : null,
          hasConflict: hasRemainingConflicts,
          status: hasRemainingConflicts ? 'CONFLICT' : 'OK'
        }
      });

      emitEntityChanged('element', updated.id, req);
      res.json({ success: true, component: updated });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
}
