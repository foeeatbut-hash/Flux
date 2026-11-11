/**
 * Тестовая база Studio: SQLite с образцами для запуска подпрограммы без рабочей базы.
 *
 * Лежит в каталоге данных Studio и создаётся/сбрасывается кнопкой. Рабочей базы здесь нет
 * вовсе: из Studio в рабочую базу уходит только запрос на публикацию (studio/shell/api.ts),
 * а подпрограмма, которая запущена на тестовых данных, читает только этот файл.
 *
 * Образцы: проекты, теги с иерархией, системы и установки, оборудование с параметрами и
 * составом, файлы Проводника, спецификации, ВДР и каталог. Договор v1 отдаёт подпрограмме
 * проект, оборудование, тег, спецификацию и каталог (modules/contract.ts); файлы
 * Проводника, системы и ВДР лежат в базе для следующих версий договора и показываются
 * разработчику счётчиками.
 *
 * SQLite — встроенный `node:sqlite` (в Electron и Node 22+): отдельного нативного модуля
 * в сборке разработчика нет.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EquipmentData, LaunchContext, ReadData, Resource, TagData } from '../../modules/contract';

export const TEST_BASE_FILE = 'test-base.sqlite';
const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE Meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL);
CREATE TABLE Tag (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, identifier TEXT NOT NULL, name TEXT NOT NULL, parentId TEXT);
CREATE TABLE System (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL);
CREATE TABLE Installation (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, systemId TEXT NOT NULL, name TEXT NOT NULL);
CREATE TABLE Equipment (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL, itemCode TEXT NOT NULL, equipType TEXT NOT NULL,
  version INTEGER NOT NULL, installationId TEXT);
CREATE TABLE EquipmentTag (equipmentId TEXT NOT NULL, tagId TEXT NOT NULL, PRIMARY KEY (equipmentId, tagId));
CREATE TABLE EquipmentParam (equipmentId TEXT NOT NULL, ord INTEGER NOT NULL, grp TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, unit TEXT NOT NULL);
CREATE TABLE EquipmentPart (id TEXT PRIMARY KEY, equipmentId TEXT NOT NULL, name TEXT NOT NULL, itemCode TEXT NOT NULL, parentId TEXT);
CREATE TABLE ExplorerFile (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, kind TEXT NOT NULL);
CREATE TABLE Specification (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL);
CREATE TABLE SpecificationRow (specificationId TEXT NOT NULL, tagId TEXT NOT NULL, PRIMARY KEY (specificationId, tagId));
CREATE TABLE Vdr (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE CatalogFamily (id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL, classId TEXT NOT NULL);
`;

type Row = Record<string, any>;

function seed(db: DatabaseSync): void {
  const run = (sql: string, ...params: any[]) => { db.prepare(sql).run(...params); };
  run('INSERT INTO Meta VALUES (?, ?)', 'schema', String(SCHEMA_VERSION));
  const projects = [['p1', 'Бизнес-центр «Река»', 'BC-01'], ['p2', 'Склад «Север»', 'WH-02']];
  for (const [id, name, code] of projects) run('INSERT INTO Project VALUES (?, ?, ?)', id, name, code);
  for (const project of ['p1', 'p2']) {
    // Иерархия тегов: система → установка → позиция, как в проектах Flux
    const tags: Array<[string, string, string, string | null]> = [
      [`${project}-t-sys`, 'V1', 'Приточная система', null],
      [`${project}-t-unit`, 'V1.01', 'Приточная установка', `${project}-t-sys`],
      [`${project}-t-fan`, 'V1.01.M1', 'Вентилятор притока', `${project}-t-unit`],
      [`${project}-t-heat`, 'V1.01.H1', 'Калорифер', `${project}-t-unit`],
      [`${project}-t-flt`, 'V1.01.F1', 'Фильтр', `${project}-t-unit`],
    ];
    for (const [id, identifier, name, parent] of tags) run('INSERT INTO Tag VALUES (?, ?, ?, ?, ?)', id, project, identifier, name, parent);
    run('INSERT INTO System VALUES (?, ?, ?, ?)', `${project}-s1`, project, 'V1', 'Приточная вентиляция');
    run('INSERT INTO Installation VALUES (?, ?, ?, ?)', `${project}-i1`, project, `${project}-s1`, 'Приточная установка П1');
    const equipment: Array<[string, string, string, string, string]> = [
      [`${project}-e-fan`, 'Вентилятор радиальный', 'ВР-80-75', 'ВЕНТИЛЯТОР', `${project}-t-fan`],
      [`${project}-e-heat`, 'Водяной калорифер', 'КСк-3', 'КАЛОРИФЕР', `${project}-t-heat`],
      [`${project}-e-flt`, 'Карманный фильтр', 'ФК-600', 'ФИЛЬТР', `${project}-t-flt`],
    ];
    for (const [id, name, code, type, tag] of equipment) {
      run('INSERT INTO Equipment VALUES (?, ?, ?, ?, ?, ?, ?)', id, project, name, code, type, 1, `${project}-i1`);
      run('INSERT INTO EquipmentTag VALUES (?, ?)', id, tag);
      const params: Array<[string, string, string, string]> = type === 'ВЕНТИЛЯТОР'
        ? [['Основные', 'Расход воздуха', '5200', 'м³/ч'], ['Основные', 'Давление', '450', 'Па'], ['Электрика', 'Мощность', '1.5', 'кВт'], ['Электрика', 'Напряжение', '380', 'В'], ['Основные', 'Исполнение', 'Y1', '']]
        : type === 'КАЛОРИФЕР'
          ? [['Основные', 'Мощность', '42.5', 'кВт'], ['Основные', 'Температура на входе', '-26', '°C'], ['Основные', 'Температура на выходе', '20', '°C']]
          : [['Основные', 'Класс фильтрации', 'F7', ''], ['Основные', 'Площадь', '8.4', 'м²']];
      params.forEach(([group, key, value, unit], ord) => run('INSERT INTO EquipmentParam VALUES (?, ?, ?, ?, ?, ?)', id, ord, group, key, value, unit));
      run('INSERT INTO EquipmentPart VALUES (?, ?, ?, ?, ?)', `${id}-m`, id, 'Электродвигатель', 'АИР-80', null);
      run('INSERT INTO EquipmentPart VALUES (?, ?, ?, ?, ?)', `${id}-b`, id, 'Подшипник', 'ПШ-6204', `${id}-m`);
    }
    for (const [i, file] of [['Паспорта/ВР-80-75.pdf', 842_000, 'pdf'], ['Схемы/П1.dwg', 2_300_000, 'dwg'], ['Расчёты/воздухообмен.xlsx', 96_000, 'xlsx']].entries()) {
      run('INSERT INTO ExplorerFile VALUES (?, ?, ?, ?, ?)', `${project}-f${i}`, project, file[0], file[1], file[2]);
    }
    run('INSERT INTO Specification VALUES (?, ?, ?)', `${project}-sp1`, project, 'Спецификация П1');
    for (const tag of ['fan', 'heat', 'flt']) run('INSERT INTO SpecificationRow VALUES (?, ?)', `${project}-sp1`, `${project}-t-${tag}`);
    run('INSERT INTO Vdr VALUES (?, ?, ?, ?)', `${project}-v1`, project, 'ВДР воздуховодов', 'draft');
    run('INSERT INTO Vdr VALUES (?, ?, ?, ?)', `${project}-v2`, project, 'ВДР оборудования', 'issued');
  }
  for (const [id, name, code, cls] of [['c1', 'Вентиляторы радиальные', 'ВР', 'fan'], ['c2', 'Калориферы водяные', 'КСк', 'heater'], ['c3', 'Фильтры карманные', 'ФК', 'filter']]) {
    run('INSERT INTO CatalogFamily VALUES (?, ?, ?, ?)', id, name, code, cls);
  }
}

export interface TestBaseCounts { projects: number; tags: number; systems: number; installations: number; equipment: number; files: number; specifications: number; vdr: number; families: number }

export class TestBase {
  readonly file: string;
  constructor(dir: string) { this.file = path.join(dir, TEST_BASE_FILE); }

  private open(): DatabaseSync { return new DatabaseSync(this.file); }

  exists(): boolean { return fs.existsSync(this.file); }

  /** Создаёт базу с образцами, если её нет или она чужой версии. Возвращает, пересоздана ли */
  ensure(): boolean {
    if (this.exists()) {
      try {
        const db = this.open();
        try { if ((db.prepare("SELECT value FROM Meta WHERE key = 'schema'").get() as Row | undefined)?.value === String(SCHEMA_VERSION)) return false; }
        finally { db.close(); }
      } catch { /* повреждённый файл — пересоздаём ниже */ }
    }
    this.reset();
    return true;
  }

  /** Сброс: файл удаляется целиком и заполняется образцами заново — правки разработчика в нём не сохраняются */
  reset(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(this.file + suffix, { force: true });
    const db = this.open();
    try { db.exec(SCHEMA); db.exec('BEGIN'); seed(db); db.exec('COMMIT'); }
    finally { db.close(); }
  }

  private with<T>(fn: (db: DatabaseSync) => T): T {
    this.ensure();
    const db = this.open();
    try { return fn(db); } finally { db.close(); }
  }

  counts(): TestBaseCounts {
    return this.with(db => {
      const n = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row).n);
      return { projects: n('Project'), tags: n('Tag'), systems: n('System'), installations: n('Installation'), equipment: n('Equipment'),
        files: n('ExplorerFile'), specifications: n('Specification'), vdr: n('Vdr'), families: n('CatalogFamily') };
    });
  }

  /** Проекты и позиции для выбора контекста запуска */
  context(): Array<{ id: string; name: string; equipment: Array<{ id: string; name: string }>; tags: Array<{ id: string; name: string }> }> {
    return this.with(db => (db.prepare('SELECT id, name FROM Project ORDER BY id').all() as Row[]).map(project => ({
      id: project.id, name: project.name,
      equipment: (db.prepare('SELECT id, name FROM Equipment WHERE projectId = ? ORDER BY id').all(project.id) as Row[]).map(r => ({ id: r.id, name: r.name })),
      tags: (db.prepare('SELECT id, identifier, name FROM Tag WHERE projectId = ? ORDER BY id').all(project.id) as Row[]).map(r => ({ id: r.id, name: `${r.identifier} ${r.name}` })),
    })));
  }

  /** Чтение по договору v1: то же, что подпрограмма получила бы во Flux, только из тестовых данных */
  read<R extends Resource>(resource: R, context: LaunchContext, entityId?: string): ReadData[R] {
    return this.with(db => {
      const id = entityId || context.entityId || '';
      const tag = (row: Row): TagData => ({ id: row.id, identifier: row.identifier, name: row.name, parentId: row.parentId ?? null });
      if (resource === 'project') {
        const row = context.projectId ? db.prepare('SELECT id, name, code FROM Project WHERE id = ?').get(context.projectId) as Row | undefined : undefined;
        return (row ? { id: row.id, name: row.name, code: row.code } : null) as ReadData[R];
      }
      if (resource === 'tag') {
        const row = id && context.projectId ? db.prepare('SELECT * FROM Tag WHERE id = ? AND projectId = ?').get(id, context.projectId) as Row | undefined : undefined;
        return (row ? tag(row) : null) as ReadData[R];
      }
      if (resource === 'specification') {
        const rows = context.projectId ? db.prepare(`SELECT DISTINCT t.* FROM Tag t JOIN SpecificationRow r ON r.tagId = t.id JOIN Specification s ON s.id = r.specificationId
          WHERE s.projectId = ? ORDER BY t.identifier`).all(context.projectId) as Row[] : [];
        return { rows: rows.map(tag) } as ReadData[R];
      }
      if (resource === 'catalog') {
        const rows = db.prepare('SELECT * FROM CatalogFamily ORDER BY code').all() as Row[];
        return { families: rows.map(r => ({ id: r.id, name: r.name, code: r.code, classId: r.classId })) } as ReadData[R];
      }
      const row = id && context.projectId ? db.prepare('SELECT * FROM Equipment WHERE id = ? AND projectId = ?').get(id, context.projectId) as Row | undefined : undefined;
      if (!row) return null as ReadData[R];
      const equipment: EquipmentData = {
        id: row.id, name: row.name, itemCode: row.itemCode, equipType: row.equipType, version: row.version,
        params: (db.prepare('SELECT grp, key, value, unit FROM EquipmentParam WHERE equipmentId = ? ORDER BY ord').all(row.id) as Row[])
          .map(p => ({ group: p.grp, key: p.key, value: p.value, unit: p.unit })),
        tags: (db.prepare('SELECT t.* FROM Tag t JOIN EquipmentTag e ON e.tagId = t.id WHERE e.equipmentId = ? ORDER BY t.identifier').all(row.id) as Row[]).map(tag),
        composition: (db.prepare('SELECT id, name, itemCode, parentId FROM EquipmentPart WHERE equipmentId = ? ORDER BY id').all(row.id) as Row[])
          .map(p => ({ id: p.id, name: p.name, itemCode: p.itemCode, parentId: p.parentId ?? null })),
      };
      return equipment as ReadData[R];
    });
  }
}
