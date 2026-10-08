/**
 * Хранилище связи Flux с проектами E3 (docs/e3-integration.md, 9.1): проекты
 * E3, записи выгрузок и связи узлов. Маршруты работают с интерфейсом
 * `E3Store`, а не с Prisma напрямую: так их проверяют без базы, а в dev-режиме
 * без сгенерированного клиента подставляется память.
 */
import type { Binding } from '../e3/exportTypes.js';
import type { JournalEntry } from '../e3/exportRun.js';
import type { Col, TableSpec } from './ddl.js';

export type ExportState = 'PLANNED' | 'RUNNING' | 'DONE' | 'INTERRUPTED' | 'UNDONE';

export interface E3ProjectRow { id: string; fluxProjectId: string; key: string; name: string; path: string; e3Version: string; partsDb: string; lastSeenAt: string }
export interface E3ExportRow {
  id: string; e3ProjectId: string; sheet: string; by: string | null; at: string; updatedAt: string; state: ExportState; classifierVersion: number;
  profile: unknown; plan: any; journal: JournalEntry[]; report: any;
}
export type E3BindingRow = Binding & { e3ProjectId: string };

export interface E3Store {
  upsertProject(p: Omit<E3ProjectRow, 'id' | 'lastSeenAt'>): Promise<E3ProjectRow>;
  getProject(id: string): Promise<E3ProjectRow | null>;
  listProjects(fluxProjectId: string): Promise<E3ProjectRow[]>;
  listBindings(e3ProjectId: string): Promise<Binding[]>;
  saveBinding(e3ProjectId: string, b: Binding): Promise<void>;
  deleteBinding(e3ProjectId: string, elementId: string): Promise<void>;
  createExport(row: Omit<E3ExportRow, 'id' | 'at' | 'updatedAt'>): Promise<E3ExportRow>;
  getExport(id: string): Promise<E3ExportRow | null>;
  saveExport(id: string, patch: Partial<Omit<E3ExportRow, 'id' | 'e3ProjectId' | 'at'>>): Promise<E3ExportRow>;
  listExports(e3ProjectId: string, take: number): Promise<E3ExportRow[]>;
  runningExports(e3ProjectId: string): Promise<E3ExportRow[]>;
  /** Несколько записей одним действием: всё или ничего */
  tx<T>(fn: (s: E3Store) => Promise<T>): Promise<T>;
}

// ── Подстраховка DDL: «таблицы нет — создам» по образцу builder.ts ───────────
const txt = (name: string, extra: Partial<Col> = {}): Col => ({ name, kind: 'text', ...extra });
const long = (name: string, def = '{}'): Col => ({ name, kind: 'longtext', def });
const time = (name: string): Col => ({ name, kind: 'time', notNull: true, def: 'now' });
// Подстраховка: у DDL нет дробного типа, а миллиметры листа в сетке 5 мм целые; настоящую таблицу создаёт автомиграция по схеме Prisma (Float)
const real = (name: string): Col => ({ name, kind: 'int', notNull: true, def: 0 });

export const E3_TABLES: TableSpec[] = [
  {
    table: 'E3Project',
    cols: [txt('id', { pk: true, indexed: true }), txt('fluxProjectId', { notNull: true, indexed: true }), txt('key', { notNull: true, indexed: true }), txt('name', { notNull: true, def: '' }),
      txt('path', { notNull: true, def: '' }), txt('e3Version', { notNull: true, def: '' }), txt('partsDb', { notNull: true, def: '' }), time('lastSeenAt'), time('createdAt')],
    indexes: [{ name: 'E3Project_fluxProjectId_key_key', cols: ['fluxProjectId', 'key'], unique: true }, { name: 'E3Project_fluxProjectId_idx', cols: ['fluxProjectId'] }],
  },
  {
    table: 'E3Export',
    cols: [txt('id', { pk: true, indexed: true }), txt('e3ProjectId', { notNull: true, indexed: true }), txt('sheet', { notNull: true, def: '' }), txt('by'), time('at'), time('updatedAt'),
      txt('state', { notNull: true, def: 'PLANNED', indexed: true }), { name: 'classifierVersion', kind: 'int', notNull: true, def: 0 }, long('profileJson'), long('planJson'), long('journalJson', '[]'), long('reportJson')],
    indexes: [{ name: 'E3Export_e3ProjectId_idx', cols: ['e3ProjectId'] }],
  },
  {
    table: 'E3Binding',
    cols: [txt('id', { pk: true, indexed: true }), txt('e3ProjectId', { notNull: true, indexed: true }), txt('elementId', { notNull: true, indexed: true }), txt('solutionId', { notNull: true, def: '' }), long('answersJson'),
      { name: 'manualSolution', kind: 'bool', notNull: true, def: false }, txt('designation', { notNull: true, def: '' }), txt('sheet', { notNull: true, def: '' }), real('x'), real('y'), real('rotation'),
      txt('sentVersion', { notNull: true, def: '' }), long('sentAttrsJson'), long('overridesJson'), txt('state', { notNull: true, def: 'PLACED' }), txt('lastExportId', { notNull: true, def: '' }), time('updatedAt')],
    indexes: [{ name: 'E3Binding_e3ProjectId_elementId_key', cols: ['e3ProjectId', 'elementId'], unique: true }, { name: 'E3Binding_e3ProjectId_idx', cols: ['e3ProjectId'] }],
  },
];

const parse = <T>(s: string | null | undefined, fallback: T): T => { try { return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; } };
const iso = (d: any): string => (d instanceof Date ? d.toISOString() : String(d || ''));
const exportOf = (r: any): E3ExportRow => ({
  id: r.id, e3ProjectId: r.e3ProjectId, sheet: r.sheet, by: r.by ?? null, at: iso(r.at), updatedAt: iso(r.updatedAt), state: r.state, classifierVersion: r.classifierVersion,
  profile: parse(r.profileJson, {}), plan: parse(r.planJson, {}), journal: parse(r.journalJson, []), report: parse(r.reportJson, {}),
});
const bindingOf = (r: any): Binding => ({
  elementId: r.elementId, solutionId: r.solutionId, designation: r.designation, sheet: r.sheet, x: r.x, y: r.y, rotation: r.rotation, sentVersion: r.sentVersion,
  sentAttrs: parse(r.sentAttrsJson, {}), overrides: parse(r.overridesJson, {}), state: r.state, lastExportId: r.lastExportId,
});
const projectOf = (r: any): E3ProjectRow => ({ id: r.id, fluxProjectId: r.fluxProjectId, key: r.key, name: r.name, path: r.path, e3Version: r.e3Version, partsDb: r.partsDb, lastSeenAt: iso(r.lastSeenAt) });

/** Хранилище на Prisma. Клиент или транзакция — любой объект с делегатами e3Project, e3Export, e3Binding */
export function prismaStore(db: any): E3Store {
  const store: E3Store = {
    async upsertProject(p) {
      const found = await db.e3Project.findFirst({ where: { fluxProjectId: p.fluxProjectId, key: p.key } });
      if (found) return projectOf(await db.e3Project.update({ where: { id: found.id }, data: { name: p.name, path: p.path, e3Version: p.e3Version, partsDb: p.partsDb, lastSeenAt: new Date() } }));
      return projectOf(await db.e3Project.create({ data: p }));
    },
    async getProject(id) { const r = await db.e3Project.findUnique({ where: { id } }); return r ? projectOf(r) : null; },
    async listProjects(fluxProjectId) { return (await db.e3Project.findMany({ where: { fluxProjectId }, orderBy: { lastSeenAt: 'desc' } })).map(projectOf); },
    async listBindings(e3ProjectId) { return (await db.e3Binding.findMany({ where: { e3ProjectId } })).map(bindingOf); },
    async saveBinding(e3ProjectId, b) {
      const data = {
        solutionId: b.solutionId, designation: b.designation, sheet: b.sheet, x: b.x, y: b.y, rotation: b.rotation, sentVersion: b.sentVersion,
        sentAttrsJson: JSON.stringify(b.sentAttrs || {}), overridesJson: JSON.stringify(b.overrides || {}), state: b.state, lastExportId: b.lastExportId, updatedAt: new Date(),
      };
      const found = await db.e3Binding.findFirst({ where: { e3ProjectId, elementId: b.elementId } });
      if (found) await db.e3Binding.update({ where: { id: found.id }, data });
      else await db.e3Binding.create({ data: { e3ProjectId, elementId: b.elementId, ...data } });
    },
    async deleteBinding(e3ProjectId, elementId) { await db.e3Binding.deleteMany({ where: { e3ProjectId, elementId } }); },
    async createExport(row) {
      return exportOf(await db.e3Export.create({ data: {
        e3ProjectId: row.e3ProjectId, sheet: row.sheet, by: row.by, state: row.state, classifierVersion: row.classifierVersion,
        profileJson: JSON.stringify(row.profile ?? {}), planJson: JSON.stringify(row.plan ?? {}), journalJson: JSON.stringify(row.journal ?? []), reportJson: JSON.stringify(row.report ?? {}),
      } }));
    },
    async getExport(id) { const r = await db.e3Export.findUnique({ where: { id } }); return r ? exportOf(r) : null; },
    async saveExport(id, patch) {
      const data: any = { updatedAt: new Date() };
      if (patch.state) data.state = patch.state;
      if (patch.sheet !== undefined) data.sheet = patch.sheet;
      if (patch.journal) data.journalJson = JSON.stringify(patch.journal);
      if (patch.report) data.reportJson = JSON.stringify(patch.report);
      if (patch.plan) data.planJson = JSON.stringify(patch.plan);
      return exportOf(await db.e3Export.update({ where: { id }, data }));
    },
    async listExports(e3ProjectId, take) { return (await db.e3Export.findMany({ where: { e3ProjectId }, orderBy: { at: 'desc' }, take })).map(exportOf); },
    async runningExports(e3ProjectId) { return (await db.e3Export.findMany({ where: { e3ProjectId, state: 'RUNNING' } })).map(exportOf); },
    async tx(fn) { return typeof db.$transaction === 'function' ? db.$transaction((t: any) => fn(prismaStore(t))) : fn(store); },
  };
  return store;
}

/** Хранилище в памяти: для проверок и для dev-режима без сгенерированного клиента Prisma */
export function memoryStore(): E3Store {
  const projects: E3ProjectRow[] = []; const exports: E3ExportRow[] = []; const bindings = new Map<string, Binding>();
  let n = 0; let clock = 0;
  const now = () => new Date(Date.now() + clock++).toISOString();
  const store: E3Store = {
    async upsertProject(p) {
      const found = projects.find((x) => x.fluxProjectId === p.fluxProjectId && x.key === p.key);
      if (found) { Object.assign(found, p, { lastSeenAt: now() }); return { ...found }; }
      const row = { ...p, id: `p${++n}`, lastSeenAt: now() }; projects.push(row); return { ...row };
    },
    async getProject(id) { const r = projects.find((x) => x.id === id); return r ? { ...r } : null; },
    async listProjects(fluxProjectId) { return projects.filter((x) => x.fluxProjectId === fluxProjectId).map((x) => ({ ...x })); },
    async listBindings(e3ProjectId) { return [...bindings.entries()].filter(([k]) => k.startsWith(`${e3ProjectId}|`)).map(([, b]) => structuredClone(b)); },
    async saveBinding(e3ProjectId, b) { bindings.set(`${e3ProjectId}|${b.elementId}`, structuredClone(b)); },
    async deleteBinding(e3ProjectId, elementId) { bindings.delete(`${e3ProjectId}|${elementId}`); },
    async createExport(row) { const r: E3ExportRow = { ...structuredClone(row), id: `x${++n}`, at: now(), updatedAt: now() }; exports.push(r); return structuredClone(r); },
    async getExport(id) { const r = exports.find((x) => x.id === id); return r ? structuredClone(r) : null; },
    async saveExport(id, patch) { const r = exports.find((x) => x.id === id)!; Object.assign(r, structuredClone(patch), { updatedAt: now() }); return structuredClone(r); },
    async listExports(e3ProjectId, take) { return exports.filter((x) => x.e3ProjectId === e3ProjectId).sort((a, b) => b.at.localeCompare(a.at)).slice(0, take).map((x) => structuredClone(x)); },
    async runningExports(e3ProjectId) { return exports.filter((x) => x.e3ProjectId === e3ProjectId && x.state === 'RUNNING').map((x) => structuredClone(x)); },
    async tx(fn) {
      // Откат памяти: снимок до, возврат при ошибке
      const snap = { p: structuredClone(projects), x: structuredClone(exports), b: new Map([...bindings].map(([k, v]) => [k, structuredClone(v)])) };
      try { return await fn(store); } catch (e) { projects.splice(0, projects.length, ...snap.p); exports.splice(0, exports.length, ...snap.x); bindings.clear(); snap.b.forEach((v, k) => bindings.set(k, v)); throw e; }
    },
  };
  return store;
}
