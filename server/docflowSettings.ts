/**
 * Настройки документооборота проекта: чтение, сохранение под версией, перенос
 * из проекта или шаблона с предпросмотром и отменой, шаблоны и перенос
 * прежних глобальных стандартов в проекты (docs/docflow-program.md, раздел 5).
 *
 * Запись идёт по правилам flux-data-safety: сначала план (что изменится по
 * разделам), потом запись одной транзакцией под ожидаемой версией, снимок
 * прежних значений — до записи, отмена — одним действием и только если после
 * переноса никто ничего не менял.
 */
import { planCatalogCopy, applyCatalogCopy, undoCatalogCopy } from './docflowCatalogCopy.js';
import { validateDocflowReferences } from './docflowConfigRefs.js';
import { DocflowPlanError } from './docflowPlans.js';
import { DOCFLOW_SECTIONS, diffSections, mergeSections, normalizeDocflowConfig, type DocflowConfig } from '../shared/docflow/config.js';

export class DocflowSettingsConflict extends Error {
  constructor(message: string, readonly status = 409) { super(message); this.name = 'DocflowSettingsConflict'; }
}

export interface SettingsSource { kind: 'project' | 'template' | 'standard' | 'default'; name: string; at: string }
export interface SettingsView {
  projectId: string; config: DocflowConfig; source: SettingsSource | null;
  /** Есть ли у проекта своя запись; нет — показываются настройки его стандарта или по умолчанию. */
  stored: boolean; updatedAt: string | null; canUndo: boolean; undoLabel: string;
}
interface UndoSnapshot { config: string | null; source: string; label: string; afterUpdatedAt: string; at: string; by: string; catalog?: any[] }

const parse = <T>(raw: string | null | undefined, fallback: T): T => { try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } };
const iso = (d: any) => (d ? new Date(d).toISOString() : null);
const dateRu = (d = new Date()) => d.toLocaleDateString('ru-RU');
export const MIGRATION_KEY = 'docflow.standards-to-projects.v1';

/** Стандарт, которым пользуются реестры проекта: самый частый, при равенстве — первый созданный. */
async function standardOfProject(prisma: any, projectId: string): Promise<{ id: string; name: string; config: any; registers: number; others: string[] } | null> {
  const registers: Array<{ standardId: string | null }> = await prisma.docRegister.findMany({ where: { projectId }, select: { standardId: true } });
  const standards: any[] = await prisma.docStandard.findMany({ orderBy: { createdAt: 'asc' } });
  if (!standards.length) return null;
  const counts = new Map<string, number>();
  for (const r of registers) {
    const id = r.standardId && standards.some((s) => s.id === r.standardId) ? r.standardId : standards[0].id;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || standards.findIndex((s) => s.id === a[0]) - standards.findIndex((s) => s.id === b[0]));
  const chosen = standards.find((s) => s.id === (ranked[0]?.[0] || standards[0].id))!;
  return {
    id: chosen.id, name: chosen.name, config: parse(chosen.config, {}), registers: registers.length,
    others: ranked.slice(1).map(([id]) => standards.find((s) => s.id === id)?.name || id),
  };
}

export async function readSettings(prisma: any, projectId: string): Promise<SettingsView> {
  const row = await prisma.docflowSettings.findUnique({ where: { projectId } });
  if (row) {
    const undo = parse<UndoSnapshot | null>(row.undo, null);
    return {
      projectId, config: normalizeDocflowConfig(parse(row.config, {})), source: parse(row.source, null), stored: true,
      updatedAt: iso(row.updatedAt), canUndo: !!undo && undo.afterUpdatedAt === iso(row.updatedAt), undoLabel: undo?.label || '',
    };
  }
  const std = await standardOfProject(prisma, projectId);
  return {
    projectId, config: normalizeDocflowConfig(std?.config || {}), stored: false, updatedAt: null, canUndo: false, undoLabel: '',
    source: std ? { kind: 'standard', name: std.name, at: '' } : { kind: 'default', name: 'по умолчанию', at: '' },
  };
}

/** Для записи и планов нужен исходный JSON, включая унаследованный стандарт. */
export async function rawSettingsConfig(prisma: any, projectId: string): Promise<any> {
  let row = await prisma.docflowSettings.findUnique({ where: { projectId } });
  if (!row) {
    const standard = await standardOfProject(prisma, projectId);
    row = standard ? await prisma.docStandard.findUnique({ where: { id: standard.id } }) : null;
  }
  if (!row) return {};
  try { return JSON.parse(row.config || '{}'); }
  catch { throw new DocflowPlanError('Исходные настройки повреждены. Исправьте их перед переносом.', 409); }
}

/** Действующие настройки проекта для сервера (сроки по кодам, типы, выгрузка). */
export async function projectConfig(prisma: any, projectId: string): Promise<DocflowConfig | null> {
  // База без таблицы (до синхронизации схемы) или клиент без модели — реестр
  // работает по стандарту, как раньше, а не падает
  try {
    const row = await prisma.docflowSettings?.findUnique({ where: { projectId } });
    return row ? normalizeDocflowConfig(parse(row.config, {})) : null;
  } catch { return null; }
}

/**
 * Запись настроек под версией. `expected` — `updatedAt`, который видел клиент
 * (null — проект ещё без своей записи). Чужая правка между чтением и записью — 409.
 */
export async function writeSettings(prisma: any, input: {
  projectId: string; config: DocflowConfig; expected: string | null | undefined; actorId: string;
  source?: SettingsSource | null; undoLabel?: string; catalogUndo?: any[]; transaction?: any;
}): Promise<SettingsView> {
  if (input.expected === undefined) throw new DocflowSettingsConflict('Не указана версия настроек: обновите окно и повторите', 400);
  await validateDocflowReferences(prisma, input.config);
  const config = JSON.stringify(normalizeDocflowConfig(input.config));
  const write = async (tx: any) => {
    if (!await tx.project.findUnique({ where: { id: input.projectId }, select: { id: true } })) throw new DocflowPlanError('Проект не найден', 404);
    await validateDocflowReferences(tx, input.config);
    const row = await tx.docflowSettings.findUnique({ where: { projectId: input.projectId } });
    if ((row ? iso(row.updatedAt) : null) !== input.expected) {
      throw new DocflowSettingsConflict(row ? 'Настройки проекта уже изменили. Данные обновлены — повторите правку.' : 'Настройки проекта уже удалили. Данные обновлены.');
    }
    // Снимок прежних значений — до записи: после неё восстанавливать нечего
    // Время записи задаём сами: отмена хранит версию, после которой она
    // применима, и любая следующая правка делает её недействительной, а не
    // тихо откатывает чужое. Обычная правка отмену закрывает
    const now = new Date(Math.max(Date.now(), row ? new Date(row.updatedAt).getTime() + 1 : 0));
    const snapshot: UndoSnapshot | null = input.undoLabel ? {
      config: row ? row.config : null, source: row ? row.source : '', label: input.undoLabel,
      afterUpdatedAt: now.toISOString(), at: now.toISOString(), by: input.actorId, ...(input.catalogUndo ? { catalog: input.catalogUndo } : {}),
    } : null;
    const data: any = { config, updatedById: input.actorId, updatedAt: now, undo: snapshot ? JSON.stringify(snapshot) : '' };
    if (input.source !== undefined) data.source = input.source ? JSON.stringify(input.source) : '';
    if (row) {
      const done = await tx.docflowSettings.updateMany({ where: { id: row.id, updatedAt: row.updatedAt }, data });
      if (done.count !== 1) throw new DocflowSettingsConflict('Настройки проекта уже изменили. Данные обновлены — повторите правку.');
    } else {
      try {
        await tx.docflowSettings.create({ data: { projectId: input.projectId, ...data, source: data.source ?? '' } });
      } catch (err: any) {
        if (err?.code === 'P2002') throw new DocflowSettingsConflict('Настройки проекта уже сохранил другой человек. Данные обновлены.');
        throw err;
      }
    }
  };
  if (input.transaction) await write(input.transaction); else await prisma.$transaction(write);
  return readSettings(input.transaction || prisma, input.projectId);
}

/** Откуда переносить: другой проект или шаблон. */
export async function sourceConfig(prisma: any, from: { projectId?: string; templateId?: string }): Promise<{ config: DocflowConfig; source: SettingsSource }> {
  if (from.templateId) {
    const std = await prisma.docStandard.findUnique({ where: { id: from.templateId } });
    if (!std) throw new DocflowSettingsConflict('Шаблон не найден', 404);
    return { config: normalizeDocflowConfig(parse(std.config, {})), source: { kind: 'template', name: std.name, at: dateRu() } };
  }
  if (!from.projectId) throw new DocflowSettingsConflict('Не выбран источник', 400);
  const project = await prisma.project.findUnique({ where: { id: from.projectId }, select: { name: true } });
  if (!project) throw new DocflowSettingsConflict('Проект-источник не найден', 404);
  const view = await readSettings(prisma, from.projectId);
  return { config: view.config, source: { kind: 'project', name: project.name, at: dateRu() } };
}

export function validSections(raw: unknown, allowEmpty = false): string[] {
  const keys = DOCFLOW_SECTIONS.map((s) => s.key);
  const list = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && keys.includes(x)) : [];
  if (!list.length && !allowEmpty) throw new DocflowSettingsConflict('Не отмечено ни одного раздела', 400);
  return list;
}

/** План переноса: что станет с каждым отмеченным разделом. Ничего не пишет. */
export async function copyPlan(prisma: any, projectId: string, from: { projectId?: string; templateId?: string }, sections: string[], includeCatalog = false) {
  if (!await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } })) throw new DocflowPlanError('Проект не найден', 404);
  await validateDocflowReferences(prisma, await rawSettingsConfig(prisma, projectId));
  if (sections.some(section => ['equipmentClasses', 'kits'].includes(section))) {
    if (from.templateId) {
      const rawSource = await prisma.docStandard.findUnique({ where: { id: from.templateId } });
      if (rawSource) {
        let raw: any;
        try { raw = JSON.parse(rawSource.config || '{}'); } catch { throw new DocflowPlanError('Шаблон повреждён', 409); }
        await validateDocflowReferences(prisma, raw);
      }
    } else if (from.projectId) await validateDocflowReferences(prisma, await rawSettingsConfig(prisma, from.projectId));
  }
  const target = await readSettings(prisma, projectId);
  const src = await sourceConfig(prisma, from);
  const after = mergeSections(target.config, src.config, sections);
  await validateDocflowReferences(prisma, after);
  const catalog = includeCatalog ? await planCatalogCopy(prisma, from.projectId || '', projectId) : null;
  if (includeCatalog && from.templateId) throw new DocflowSettingsConflict('Каталог можно перенести только из проекта', 400);
  const diffs = diffSections(target.config, after, sections);
  if (catalog) diffs.push({ key: 'catalog', label: 'Каталог проекта', lines: catalog.changes.map(c => `${c.before ? 'Обновить' : 'Добавить'}: ${c.data.code}`) });
  return { source: src.source, expected: target.updatedAt, sections: diffs, after, catalogToken: catalog?.token };
}

export async function applyCopy(prisma: any, input: { projectId: string; from: { projectId?: string; templateId?: string }; sections: string[]; expected: string | null | undefined; actorId: string; includeCatalog?: boolean; catalogToken?: string }) {
  if (!input.includeCatalog) {
    const plan = await copyPlan(prisma, input.projectId, input.from, input.sections);
    const what = input.from.templateId ? `шаблона «${plan.source.name}»` : `проекта «${plan.source.name}»`;
    return writeSettings(prisma, { projectId: input.projectId, config: plan.after, expected: input.expected, actorId: input.actorId, source: plan.source, undoLabel: `перенос из ${what}` });
  }
  if (!input.catalogToken) throw new DocflowSettingsConflict('Сначала покажите различия каталога', 400);
  await prisma.$transaction(async (tx: any) => {
    const plan = await copyPlan(tx, input.projectId, input.from, input.sections, true);
    if (plan.catalogToken !== input.catalogToken) throw new DocflowSettingsConflict('Каталог изменился после предпросмотра');
    const catalog = await planCatalogCopy(tx, input.from.projectId || '', input.projectId);
    const catalogUndo = await applyCatalogCopy(tx, catalog, input.actorId);
    await writeSettings(tx, { projectId: input.projectId, config: plan.after, expected: input.expected, actorId: input.actorId, source: plan.source, undoLabel: `перенос из проекта «${plan.source.name}»`, catalogUndo, transaction: tx });
  }, { timeout: 120000, isolationLevel: 'Serializable' });
  return readSettings(prisma, input.projectId);
}

export async function undoNeedsCatalog(prisma: any, projectId: string): Promise<boolean> {
  const row = await prisma.docflowSettings.findUnique({ where: { projectId } });
  return Array.isArray(parse<UndoSnapshot | null>(row?.undo, null)?.catalog);
}

/** Отмена последнего переноса — только пока после него ничего не меняли. */
export async function undoLast(prisma: any, projectId: string, actorId: string, mayUndoCatalog = false): Promise<SettingsView> {
  await prisma.$transaction(async (tx: any) => {
    const row = await tx.docflowSettings.findUnique({ where: { projectId } });
    const undo = row ? parse<UndoSnapshot | null>(row.undo, null) : null;
    if (!row || !undo) throw new DocflowSettingsConflict('Отменять нечего', 404);
    if (undo.afterUpdatedAt !== iso(row.updatedAt)) throw new DocflowSettingsConflict('После переноса настройки уже меняли — отмена закрыта, чтобы не затереть эти правки');
    if (undo.catalog) {
      if (!mayUndoCatalog) throw new DocflowSettingsConflict('Нет права на каталог проекта', 403);
      if (Date.now() - new Date(undo.at).getTime() > 30 * 86400000) throw new DocflowSettingsConflict('Срок отмены переноса истёк');
      await undoCatalogCopy(tx, projectId, undo.catalog);
    }
    if (undo.config === null) {
      const gone = await tx.docflowSettings.deleteMany({ where: { id: row.id, updatedAt: row.updatedAt } });
      if (gone.count !== 1) throw new DocflowSettingsConflict('Настройки проекта уже изменили');
    } else {
      await validateDocflowReferences(tx, parse(undo.config, {}));
      const now = new Date(Math.max(Date.now(), new Date(row.updatedAt).getTime() + 1));
      const done = await tx.docflowSettings.updateMany({ where: { id: row.id, updatedAt: row.updatedAt }, data: { config: undo.config, source: undo.source, undo: '', updatedById: actorId, updatedAt: now } });
      if (done.count !== 1) throw new DocflowSettingsConflict('Настройки проекта уже изменили');
    }
  });
  return readSettings(prisma, projectId);
}

// ── Шаблоны: прежние глобальные стандарты ──

export async function listTemplates(prisma: any) {
  const rows = await prisma.docStandard.findMany({ orderBy: { createdAt: 'asc' } });
  return rows.map((r: any) => ({ id: r.id, name: r.name, updatedAt: iso(r.updatedAt), types: normalizeDocflowConfig(parse(r.config, {})).vdrTypes.length }));
}

export async function saveTemplate(prisma: any, name: string, config: DocflowConfig) {
  const title = String(name || '').trim().slice(0, 200);
  if (!title) throw new DocflowSettingsConflict('Укажите название шаблона', 400);
  await validateDocflowReferences(prisma, config);
  const row = await prisma.docStandard.create({ data: { name: title, config: JSON.stringify(normalizeDocflowConfig(config)) } });
  return { id: row.id, name: row.name };
}

// ── Перенос прежних стандартов в проекты ──

/**
 * План: каким проектам и из какого стандарта достанется своя копия. Проекты,
 * у которых настройки уже есть, не трогаются. Ничего не пишет.
 */
export async function migrationPlan(prisma: any) {
  const projects: any[] = await prisma.project.findMany({ where: { system: false }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  const existing = new Set((await prisma.docflowSettings.findMany({ select: { projectId: true } })).map((r: any) => r.projectId));
  const standards = await prisma.docStandard.count();
  const rows: Array<{ projectId: string; projectName: string; standardId: string | null; standardName: string; registers: number; note: string }> = [];
  for (const p of projects) {
    if (existing.has(p.id)) continue;
    const std = await standardOfProject(prisma, p.id);
    if (!std?.registers) continue;
    rows.push({
      projectId: p.id, projectName: p.name, standardId: std.id, standardName: std.name, registers: std.registers,
      note: std.others.length ? `реестры проекта пользуются и стандартами: ${std.others.join(', ')} — взят самый частый` : '',
    });
  }
  const record = await prisma.appSetting.findFirst({ where: { key: MIGRATION_KEY, userId: null } });
  return { projects: rows, templates: standards, applied: parse<any>(record?.value, null) };
}

export async function applyMigration(prisma: any, projectIds: string[], actorId: string) {
  const plan = await migrationPlan(prisma);
  const chosen = plan.projects.filter((p) => projectIds.includes(p.projectId));
  if (!chosen.length) throw new DocflowSettingsConflict('В плане нет выбранных проектов', 400);
  const at = new Date().toISOString();
  await prisma.$transaction(async (tx: any) => {
    const created: Array<{ projectId: string; updatedAt: string }> = [];
    for (const p of chosen) {
      const std = await tx.docStandard.findUnique({ where: { id: p.standardId } });
      try {
        const row = await tx.docflowSettings.create({ data: {
          projectId: p.projectId, config: JSON.stringify(normalizeDocflowConfig(parse(std?.config, {}))), updatedById: actorId,
          source: JSON.stringify({ kind: 'standard', name: std?.name || p.standardName, at: dateRu() }),
        } });
        created.push({ projectId: p.projectId, updatedAt: iso(row.updatedAt)! });
      } catch (err: any) {
        if (err?.code === 'P2002') throw new DocflowSettingsConflict(`У проекта «${p.projectName}» настройки уже появились. Обновите план.`);
        throw err;
      }
    }
    const prev = await tx.appSetting.findFirst({ where: { key: MIGRATION_KEY, userId: null } });
    const value = JSON.stringify({ at, by: actorId, created });
    if (prev) await tx.appSetting.update({ where: { id: prev.id }, data: { value } });
    else await tx.appSetting.create({ data: { key: MIGRATION_KEY, value } });
  });
  return migrationPlan(prisma);
}

/** Отмена переноса: убираются только копии, которые после него никто не правил. */
export async function undoMigration(prisma: any) {
  const kept: string[] = [];
  await prisma.$transaction(async (tx: any) => {
    const record = await tx.appSetting.findFirst({ where: { key: MIGRATION_KEY, userId: null } });
    const applied = parse<any>(record?.value, null);
    if (!record || !applied?.created?.length) throw new DocflowSettingsConflict('Отменять нечего', 404);
    for (const c of applied.created) {
      const gone = await tx.docflowSettings.deleteMany({ where: { projectId: c.projectId, updatedAt: new Date(c.updatedAt) } });
      if (gone.count !== 1) kept.push(c.projectId);
    }
    await tx.appSetting.delete({ where: { id: record.id } });
  });
  return { kept, plan: await migrationPlan(prisma) };
}
