// ── Резервные копии программы ────────────────────────────────────────────────
// Ежедневный «Архив»: если всё полетит (удалили базу, умер диск, кривое
// обновление) — у владельца остаётся папка с датой, из которой всё читается
// БЕЗ программы:
//   АРХИВ-ГГГГ-ММ-ДД/
//     database.sqlite            — проверенная копия базы вместе с WAL
//     Проводник/<Проект>/<папки>/<файлы в родных форматах>
//     Данные/<Проект>.xlsx       — теги + закупки + оборудование в Excel
//     manifest.json              — что и когда сохранено
// Плюс страховочные копии базы при каждом старте сервера (db-safety, 5 шт.) —
// защита от «база случайно удалилась/испортилась только что».
// Расписание: раз в сутки (проверка каждый час + при старте). Ротация: keep N.

import fs from 'fs';
import { fileBytes } from './routes/fileChunks.js';
import path from 'path';
import crypto from 'crypto';
import type { Express, Request, Response } from 'express';
import * as XLSX from 'xlsx';
import { snapshotSqlite } from './sqliteSafety.js';

interface BackupDeps {
  app: Express;
  getPrisma: () => any;
  baseDataDir: string;        // папка данных программы (ventAppDataPath)
  getDbPath: () => string;    // путь к текущему файлу SQLite ('' если PostgreSQL)
  log: (line: string) => void;
}

interface BackupSettings {
  enabled: boolean;
  dir: string;   // '' = <baseDataDir>/backups
  keep: number;  // сколько суточных архивов хранить
}

const DEFAULTS: BackupSettings = { enabled: true, dir: '', keep: 14 };
const SETTINGS_KEY = 'backup_settings';

// Имя файла/папки, безопасное для Windows
function sanitizeName(name: string, fallback: string): string {
  const clean = String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim();
  return clean || fallback;
}

function dateStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += dirSize(p);
      else { try { total += fs.statSync(p).size; } catch (_) {} }
    }
  } catch (_) {}
  return total;
}

export function initBackups(deps: BackupDeps) {
  const { app, getPrisma, baseDataDir, getDbPath, log } = deps;
  let running = false;

  async function loadSettings(): Promise<BackupSettings> {
    try {
      const s = await getPrisma().appSetting.findFirst({ where: { key: SETTINGS_KEY, userId: null } });
      if (s?.value) return { ...DEFAULTS, ...JSON.parse(s.value) };
    } catch (_) {}
    return { ...DEFAULTS };
  }

  async function saveSettings(next: BackupSettings): Promise<void> {
    const prisma = getPrisma();
    const value = JSON.stringify(next);
    const existing = await prisma.appSetting.findFirst({ where: { key: SETTINGS_KEY, userId: null } });
    if (existing) await prisma.appSetting.update({ where: { id: existing.id }, data: { value } });
    else await prisma.appSetting.create({ data: { key: SETTINGS_KEY, userId: null, value } });
  }

  const resolveBaseDir = (s: BackupSettings) => (s.dir && s.dir.trim()) ? path.resolve(s.dir.trim()) : path.join(baseDataDir, 'backups');

  // ── Страховочная копия базы при старте (быстрая, ротация 5 шт.) ──
  async function startupSafetyCopy() {
    try {
      const dbPath = getDbPath();
      if (!dbPath || !fs.existsSync(dbPath)) return;
      const dir = path.join(baseDataDir, 'backups', 'db-safety');
      fs.mkdirSync(dir, { recursive: true });
      const p = (n: number) => String(n).padStart(2, '0');
      const d = new Date();
      const dest = path.join(dir, `database-${dateStamp(d)}-${p(d.getHours())}${p(d.getMinutes())}-${crypto.randomUUID()}.sqlite`);
      await snapshotSqlite(dbPath, dest);
      // ротация: 5 последних
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.sqlite'))
        .sort((a, b) => fs.statSync(path.join(dir, a)).mtimeMs - fs.statSync(path.join(dir, b)).mtimeMs);
      for (const f of files.slice(0, Math.max(0, files.length - 5))) {
        try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
      }
      log(`[Backup] Страховочная копия базы при старте: ${dest}`);
    } catch (e: any) {
      log(`[Backup] Страховочная копия не удалась: ${e?.message}`);
    }
  }

  // Ошибка копирования локальной базы прерывает архив, а не маскируется успехом.
  async function copyDatabase(destFile: string): Promise<boolean> {
    const dbPath = getDbPath();
    if (!dbPath) return false;
    await snapshotSqlite(dbPath, destFile);
    return true;
  }

  // ── Архив Проводника: файлы в родных форматах по папкам ──
  async function exportExplorer(destRoot: string): Promise<{ files: number; skipped: number }> {
    const prisma = getPrisma();
    const projects = await prisma.project.findMany();
    const folders = await prisma.folder.findMany();
    const files = await prisma.fileNode.findMany();

    // путь папки = цепочка родителей
    const folderById = new Map<string, any>(folders.map((f: any) => [f.id, f]));
    const folderPath = (id: string | null): string[] => {
      const parts: string[] = [];
      let cur = id ? folderById.get(id) : null;
      let guard = 0;
      while (cur && guard++ < 50) {
        parts.unshift(sanitizeName(cur.name, 'Папка'));
        cur = cur.parentId ? folderById.get(cur.parentId) : null;
      }
      return parts;
    };
    const projectName = new Map<string, string>(projects.map((p: any) => [p.id, sanitizeName(p.name, 'Проект')]));

    let written = 0, skipped = 0;
    const usedNames = new Set<string>();
    for (const f of files) {
      try {
        // Байты берём общим путём: у файла, положенного новой версией, они
        // лежат кусками, у старого — строкой. Зеркала документов Flux Office и
        // пустышки не имеют ни того, ни другого — их и пропускаем
        const bytes = await fileBytes(f);
        if (!bytes.length) { skipped++; continue; }
        const folder = f.folderId ? folderById.get(f.folderId) : null;
        const projName = folder ? (projectName.get(folder.projectId) || 'Проект') : 'Без проекта';
        const dir = path.join(destRoot, 'Проводник', projName, ...(folder ? folderPath(f.folderId) : [f.scope === 'PERSONAL' ? 'Личные' : 'Общие']));
        fs.mkdirSync(dir, { recursive: true });
        let name = sanitizeName(f.name, 'файл');
        // дубликаты имён в одной папке — нумеруем
        let full = path.join(dir, name);
        let n = 1;
        while (usedNames.has(full)) {
          const ext = path.extname(name);
          full = path.join(dir, `${path.basename(name, ext)} (${++n})${ext}`);
        }
        usedNames.add(full);
        fs.writeFileSync(full, bytes);
        written++;
      } catch (error: any) {
        throw new Error(`Не удалось сохранить файл Проводника «${f.name}»: ${error.message}`);
      }
    }
    return { files: written, skipped };
  }

  // ── Данные проекта в Excel: теги + закупки, оборудование ──
  async function exportDataXlsx(destRoot: string): Promise<number> {
    const prisma = getPrisma();
    const projects = await prisma.project.findMany();
    const dir = path.join(destRoot, 'Данные');
    fs.mkdirSync(dir, { recursive: true });
    let count = 0;

    for (const proj of projects) {
      const wb = XLSX.utils.book_new();

      // Теги (+ закупки из metadata.procurement)
      const tags = await prisma.tag.findMany({ where: { projectId: proj.id } });
      const tagRows = tags.map((t: any) => {
        let meta: any = {}; try { meta = t.metadata ? JSON.parse(t.metadata) : {}; } catch (_) {}
        const proc = meta.procurement || {};
        return {
          'Обозначение': t.identifier || '',
          'Наименование': meta.mainName || '',
          'Марка': t.brand || '',
          'Отдел': t.department || '',
          'Среда': t.fluid || '',
          'WBS': t.wbs || '',
          'Этап закупки': proc.stage || '',
          'Поставщик': proc.supplier || '',
          'Кол-во': proc.qty || '',
          'Примечание': proc.note || '',
          'Создан': t.createdAt ? new Date(t.createdAt).toLocaleDateString('ru-RU') : '',
        };
      });
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tagRows.length ? tagRows : [{ 'Обозначение': '' }]), 'Теги');

      // Оборудование: плоская таблица параметров
      const systems = await prisma.equipmentSystem.findMany({
        where: { projectId: proj.id },
        include: { monoblocks: { include: { components: { include: { tags: true } } } } },
      });
      const eqRows: any[] = [];
      for (const s of systems) for (const mb of (s.monoblocks || [])) for (const c of (mb.components || [])) {
        let specs: any = {}; try { specs = c.specs ? JSON.parse(c.specs) : {}; } catch (_) {}
        const groups = Array.isArray(specs?.groups) ? specs.groups : [];
        const tagList = (c.tags || []).map((t: any) => t.identifier).join(', ');
        if (groups.length === 0) {
          eqRows.push({ 'Установка': s.name, 'Моноблок': mb.name, 'Элемент': c.name, 'Тип': c.equipType, 'Теги': tagList, 'Группа': '', 'Параметр': '', 'Значение': '', 'Ед.': '' });
        }
        for (const g of groups) for (const p of (g.params || [])) {
          eqRows.push({
            'Установка': s.name, 'Моноблок': mb.name, 'Элемент': c.name, 'Тип': c.equipType, 'Теги': tagList,
            'Группа': g.title || '', 'Параметр': p.key || '', 'Значение': p.value || '', 'Ед.': p.unit || '',
          });
        }
      }
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(eqRows.length ? eqRows : [{ 'Установка': '' }]), 'Оборудование');

      const file = path.join(dir, `${sanitizeName(proj.name, 'Проект')}.xlsx`);
      XLSX.writeFile(wb, file);
      count++;
    }
    return count;
  }

  // ── Полный архив ──
  async function runBackup(reason: 'daily' | 'manual' | 'startup'): Promise<any> {
    if (running) throw new Error('Резервное копирование уже выполняется');
    running = true;
    const startedAt = Date.now();
    let pending = '';
    try {
      const settings = await loadSettings();
      const base = resolveBaseDir(settings);
      const stamp = dateStamp();
      let dest = path.join(base, `АРХИВ-${stamp}`);
      if (fs.existsSync(dest)) dest += `-${crypto.randomUUID()}`;
      fs.mkdirSync(base, { recursive: true });
      // Незавершённая папка не считается архивом и не блокирует повторную попытку.
      pending = fs.mkdtempSync(path.join(base, '.pending-'));

      const dbOk = await copyDatabase(path.join(pending, 'database.sqlite'));
      const explorer = await exportExplorer(pending);
      const xlsxCount = await exportDataXlsx(pending);

      const manifest = {
        when: new Date().toISOString(),
        reason,
        database: dbOk ? 'database.sqlite' : 'Внешняя база: здесь только выгрузка файлов и таблиц; полная копия создаётся средствами СУБД',
        explorerFiles: explorer.files,
        explorerSkipped: explorer.skipped,
        dataWorkbooks: xlsxCount,
        tookMs: Date.now() - startedAt,
      };
      fs.writeFileSync(path.join(pending, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
      fs.renameSync(pending, dest);

      // Ротация суточных архивов
      try {
        const entries = fs.readdirSync(base).filter(n => n.startsWith('АРХИВ-') && fs.existsSync(path.join(base, n, 'manifest.json')))
          .sort((a, b) => fs.statSync(path.join(base, a, 'manifest.json')).mtimeMs - fs.statSync(path.join(base, b, 'manifest.json')).mtimeMs);
        for (const old of entries.slice(0, Math.max(0, entries.length - Math.max(1, settings.keep)))) {
          fs.rmSync(path.join(base, old), { recursive: true, force: true });
          log(`[Backup] Ротация: удалён старый архив ${old}`);
        }
      } catch (_) {}

      log(`[Backup] Архив готов (${reason}): ${dest} — файлов Проводника: ${explorer.files}, книг данных: ${xlsxCount}, БД: ${dbOk ? 'да' : 'нет'}, ${manifest.tookMs} мс`);
      return { dest, ...manifest };
    } finally {
      // Удаляется только собственная временная папка: исходные данные и готовые архивы не затрагиваются.
      if (pending) { try { fs.rmSync(pending, { recursive: true, force: true }); } catch (_) {} }
      running = false;
    }
  }

  function listBackups(base: string) {
    try {
      return fs.readdirSync(base)
        .filter(n => n.startsWith('АРХИВ-') && fs.existsSync(path.join(base, n, 'manifest.json')))
        .sort().reverse()
        .map(name => {
          const p = path.join(base, name);
          let manifest: any = null;
          try { manifest = JSON.parse(fs.readFileSync(path.join(p, 'manifest.json'), 'utf-8')); } catch (_) {}
          return { name, path: p, size: dirSize(p), manifest };
        });
    } catch (_) { return []; }
  }

  // ── API ──
  app.get('/api/backup/status', async (_req: Request, res: Response) => {
    try {
      const settings = await loadSettings();
      const base = resolveBaseDir(settings);
      const list = listBackups(base);
      res.json({ settings, dir: base, running, backups: list });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  app.post('/api/backup/run', async (req: Request, res: Response) => {
    const u = (req as any).authUser;
    if (!u || u.role !== 'ADMIN') return res.status(403).json({ error: 'Доступно только администратору' });
    try {
      const result = await runBackup('manual');
      res.json({ success: true, ...result });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  app.post('/api/backup/settings', async (req: Request, res: Response) => {
    const u = (req as any).authUser;
    if (!u || u.role !== 'ADMIN') return res.status(403).json({ error: 'Доступно только администратору' });
    try {
      const cur = await loadSettings();
      const next: BackupSettings = {
        enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : cur.enabled,
        dir: typeof req.body?.dir === 'string' ? req.body.dir : cur.dir,
        keep: Number.isFinite(Number(req.body?.keep)) ? Math.min(90, Math.max(1, Number(req.body.keep))) : cur.keep,
      };
      await saveSettings(next);
      res.json({ success: true, settings: next });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  // ── Расписание ──
  // При старте: страховочная копия БД сразу; суточный архив — через минуту,
  // если за сегодня его ещё нет. Дальше проверка каждый час.
  const ready = startupSafetyCopy();
  const dailyCheck = async () => {
    try {
      const settings = await loadSettings();
      if (!settings.enabled) return;
      const base = resolveBaseDir(settings);
      const today = `АРХИВ-${dateStamp()}`;
      const complete = fs.existsSync(base) && fs.readdirSync(base).some(n =>
        n.startsWith(today) && fs.existsSync(path.join(base, n, 'manifest.json')));
      if (!complete) await runBackup('daily');
    } catch (e: any) {
      log(`[Backup] Суточная проверка не удалась: ${e?.message}`);
    }
  };
  const firstCheck = setTimeout(dailyCheck, 60_000);
  const schedule = setInterval(dailyCheck, 60 * 60_000);

  return { runBackup, ready, stop: () => { clearTimeout(firstCheck); clearInterval(schedule); } };
}
