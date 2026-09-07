import type { Express, Request, Response } from 'express';
import { getPrisma } from '../context.js';
import { importEquipmentToDB } from '../equipmentImport.js';
import { planEquipmentImport, applyEdits, filterBySelection, type EditMap } from '../equipmentPlan.js';
import type { TagLink } from '../equipmentTags.js';

// ── Ввоз распознанного документа (PDF / Word / скан / буфер) ────────────────
// Мастер распознавания присылает уже разобранный документ, а не файл. Раньше
// этот путь писал в базу сразу: без плана, без предпросмотра и без отмены —
// качество ввоза зависело от того, каким файлом принесли бланк. Теперь оба
// пути идут одинаково: разбор → ПЛАН → предпросмотр (решает человек) → запись,
// поэтому здесь два эндпоинта на одной санитизации.

/** Управляющие и бинарные символы вырезаем: «кракозябры» в названия не попадают */
const clean = (s: any, max = 200) => String(s ?? '')
  // управляющие (C0/C1), область частного использования, замещающий символ
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uE000-\uF8FF\uFFFD]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

const cleanGroups = (groups: any): any[] => (Array.isArray(groups) ? groups : []).slice(0, 40).map((g: any) => ({
  title: clean(g?.title, 80) || 'Характеристики',
  params: (Array.isArray(g?.params) ? g.params : []).slice(0, 200).map((p: any) => ({
    key: clean(p?.key, 120), value: clean(p?.value, 300), unit: clean(p?.unit, 40),
  })).filter((p: any) => p.key && p.value),
})).filter((g: any) => g.params.length);

/** Теги позиции: список коротких кодов */
const cleanTags = (tags: any): string[] | undefined => {
  if (!Array.isArray(tags)) return undefined;
  const out = tags.slice(0, 50).map((t: any) => clean(t, 40)).filter(Boolean);
  return out.length ? out : undefined;
};

/** Присланное дерево → та же модель, что даёт разбор файла на сервере */
export function sanitizeDraftUnits(units: any[]): any {
  return {
    units: units.slice(0, 100).map((u: any) => ({
      name: clean(u?.name, 120) || 'Импорт',
      title: clean(u?.title, 200) || 'Импортированное оборудование',
      tags: cleanTags(u?.tags),
      groups: cleanGroups(u?.groups),
      monoblocks: (Array.isArray(u?.monoblocks) ? u.monoblocks : []).slice(0, 50).map((mb: any) => ({
        name: clean(mb?.name, 120) || 'M1',
        title: clean(mb?.title, 200) || '',
        blocks: (Array.isArray(mb?.blocks) ? mb.blocks : []).slice(0, 200).map((b: any) => ({
          name: clean(b?.name, 120) || 'Позиция',
          title: clean(b?.title, 200) || '',
          equipType: clean(b?.equipType, 60) || 'component',
          tags: cleanTags(b?.tags),
          groups: cleanGroups(b?.groups),
        })),
      })),
    })),
  };
}

/** Решения инженера по тегам: проверяем форму, личность сверяется в базе */
export function cleanTagLinks(raw: any): TagLink[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.slice(0, 2000).map((l: any) => ({
    blockKey: String(l?.blockKey ?? '').slice(0, 300),
    identifier: String(l?.identifier ?? '').trim().slice(0, 40),
    action: (l?.action === 'create' || l?.action === 'skip') ? l.action : 'link',
    existingTagId: l?.existingTagId ? String(l.existingTagId).slice(0, 64) : undefined,
  })).filter((l: any) => l.blockKey && l.identifier) as TagLink[];
  return out.length ? out : undefined;
}

async function resolveProject(reqProjectId: any): Promise<string> {
  const prisma = getPrisma();
  let projectId = reqProjectId;
  if (!projectId || projectId === 'null' || projectId === 'undefined' || projectId === 'default') {
    let first = await prisma.project.findFirst();
    if (!first) first = await prisma.project.create({ data: { name: 'Общий Проект' } });
    projectId = first.id;
  }
  return projectId;
}

export function registerEquipmentDraftRoutes(app: Express): void {
  // План по распознанному документу: тот же дифф, те же теги, что у файла.
  // Ничего не пишет — предпросмотр обязан быть безопасным.
  app.post('/api/equipment/import-draft-plan', async (req: Request, res: Response) => {
    const { units, category, projectId: reqProjectId, edits } = req.body;
    if (!Array.isArray(units) || units.length === 0) {
      return res.status(400).json({ error: 'Пустой результат распознавания' });
    }
    if (!category) return res.status(400).json({ error: 'Не указана категория оборудования' });
    try {
      const projectId = await resolveProject(reqProjectId);
      const result = applyEdits(sanitizeDraftUnits(units), edits as EditMap | undefined);
      const plan = await planEquipmentImport(getPrisma(), projectId, category, result);
      res.json({ plan });
    } catch (error: any) {
      console.error('Error in import-draft-plan:', error);
      res.status(500).json({ error: error.message || 'Не удалось построить план' });
    }
  });

  // Запись подтверждённого предпросмотра
  app.post('/api/equipment/import-draft', async (req: Request, res: Response) => {
    const { units, category, fileName, projectId: reqProjectId, tagLinks, edits, selection } = req.body;
    if (!Array.isArray(units) || units.length === 0) {
      return res.status(400).json({ error: 'Пустой результат распознавания' });
    }
    if (!category) return res.status(400).json({ error: 'Не указана категория оборудования' });
    try {
      const prisma = getPrisma();
      const projectId = await resolveProject(reqProjectId);
      // Правки предпросмотра и выбор области — до записи, как у ввоза файла
      const edited = applyEdits(sanitizeDraftUnits(units), edits as EditMap | undefined);
      const sel = Array.isArray(selection) ? new Set<string>(selection) : null;
      const result = filterBySelection(edited, sel);
      if (!result.units.length) {
        return res.status(400).json({ error: 'Не выбрано ни одного блока для импорта' });
      }

      const modeSetting = await prisma.appSetting.findFirst({ where: { key: 'equip_conflict_mode', userId: null } });
      const conflictMode: 'immediate' | 'wait' = (modeSetting && modeSetting.value === 'immediate') ? 'immediate' : 'wait';

      const summary = await importEquipmentToDB(
        prisma, projectId, category,
        clean(fileName, 200) || 'Распознанный документ',
        result, conflictMode, cleanTagLinks(tagLinks),
      );
      res.json({ success: true, ...summary, conflictMode });
    } catch (error: any) {
      console.error('Error in import-draft:', error);
      res.status(500).json({ error: error.message || 'Не удалось импортировать распознанные данные' });
    }
  });
}
