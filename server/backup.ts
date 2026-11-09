import { administratorPermission, requireOwnerMiddleware } from './accessPolicy.js';
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
const fsp = fs.promises;
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

// Имена, которые Windows не даёт создать как файл или папку (с любым расширением)
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

// Имя файла/папки, безопасное для Windows. Длину режем: полный путь в Windows
// ограничен, а один слишком длинный файл раньше обрывал весь архив
export function sanitizeName(name: string, fallback: string): string {
  let clean = String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim();
  if (WINDOWS_RESERVED.test(clean)) clean = `_${clean}`;
  if (clean.length > 120) {
    const ext = path.extname(clean);
    clean = clean.slice(0, 120 - Math.min(ext.length, 20)) + (ext.length <= 20 ? ext : '');
  }
  return clean || fallback;
}

// Ввод «сколько хранить»: только целое число. Пусто, null и мусор раньше
// превращались в 0, а затем в 1, и ротация стирала все прежние архивы
export function parseKeep(raw: unknown): number | null {
  if (typeof raw === 'string' && raw.trim() !== '') raw = Number(raw);
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return Math.min(90, Math.max(1, Math.round(raw)));
}

function dateStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  try {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += await dirSize(p);
      else { try { total += (await fsp.stat(p)).size; } catch (_) {} }
    }
  } catch (_) {}
  return total;
}

// Уникальные имена проектов без учёта регистра: два «Цех» не должны затирать
// друг друга ни в папке Проводника, ни в книге Excel
export function uniqueProjectNames(projects: any[]): Map<string, string> {
  const result = new Map<string, string>();
  const taken = new Set<string>();
  for (const p of projects) {
    const base = sanitizeName(p.name, 'Проект');
    let name = base;
    if (taken.has(name.toLowerCase())) name = `${base} (${String(p.id).slice(0, 8)})`;
    let n = 1;
    while (taken.has(name.toLowerCase())) name = `${base} (${String(p.id).slice(0, 8)}-${++n})`;
    taken.add(name.toLowerCase());
    result.set(p.id, name);
  }
  return result;
}

export function initBackups(deps: BackupDeps) {
  const { app, getPrisma, baseDataDir, getDbPath, log } = deps;
  let running = false;

  async function loadSettings(): Promise<BackupSettings> {
    // Ошибку чтения базы не прячем: иначе при её недоступности архив шёл бы по
    // умолчаниям (включён, своя папка), а не по настройкам владельца
    const s = await getPrisma().appSetting.findFirst({ where: { key: SETTINGS_KEY, userId: null } });
    if (s?.value) {
      try {
        const parsed = JSON.parse(s.value);
        const keep = parseKeep(parsed?.keep);
        return { ...DEFAULTS, ...parsed, keep: keep ?? DEFAULTS.keep };
      } catch (_) { /* испорченное значение настройки — берём умолчания */ }
    }
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
  // Один плохой файл (имя CON, слишком длинный путь, сбой записи) не обрывает
  // архив: он пропускается и попадает в отчёт, иначе при вечной ошибке
  // часовая проверка не создавала бы архивов вообще
  async function exportExplorer(destRoot: string, projectName: Map<string, string>): Promise<{ files: number; skipped: number; failed: { name: string; error: string }[] }> {
    const prisma = getPrisma();
    const folders = await prisma.folder.findMany();
    // content (base64 старых файлов) не тянем разом для всех: читаем точечно
    const files = await prisma.fileNode.findMany({
      where: { deletedAt: null, type: { not: 'CHAT_FILE' } },
      select: { id: true, name: true, folderId: true, scope: true, ownerId: true },
    });
    const owners = new Map<string, string>(
      (await prisma.user.findMany({ select: { id: true, name: true } })).map((u: any) => [u.id, sanitizeName(u.name, 'Сотрудник')]),
    );

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

    let written = 0, skipped = 0;
    const failed: { name: string; error: string }[] = [];
    const usedNames = new Set<string>();
    for (const f of files) {
      try {
        // Байты берём общим путём: у файла, положенного новой версией, они
        // лежат кусками, у старого — строкой. Зеркала документов Flux Office и
        // пустышки не имеют ни того, ни другого — их и пропускаем
        let bytes = await fileBytes(f);
        if (!bytes.length) {
          const row = await prisma.fileNode.findUnique({ where: { id: f.id }, select: { content: true } });
          bytes = await fileBytes({ id: f.id, content: row?.content });
        }
        if (!bytes.length) { skipped++; continue; }
        const folder = f.folderId ? folderById.get(f.folderId) : null;
        const projName = folder ? (projectName.get(folder.projectId) || 'Проект') : 'Без проекта';
        // Личные файлы корня раздела кладём по владельцам: чужие личные не
        // должны смешиваться в одну папку «Личные»
        const rootDir = f.scope === 'PERSONAL' ? ['Личные', (f.ownerId && owners.get(f.ownerId)) || 'Без владельца'] : ['Общие'];
        const dir = path.join(destRoot, 'Проводник', projName, ...(folder ? folderPath(f.folderId) : rootDir));
        await fsp.mkdir(dir, { recursive: true });
        const name = sanitizeName(f.name, 'файл');
        // дубликаты имён в одной папке — нумеруем; регистр не различаем (Windows)
        let full = path.join(dir, name);
        let n = 1;
        while (usedNames.has(full.toLowerCase())) {
          const ext = path.extname(name);
          full = path.join(dir, `${path.basename(name, ext)} (${++n})${ext}`);
        }
        usedNames.add(full.toLowerCase());
        await fsp.writeFile(full, bytes);
        written++;
      } catch (error: any) {
        failed.push({ name: String(f.name), error: String(error?.message || error) });
        log(`[Backup] Файл Проводника «${f.name}» пропущен: ${error?.message}`);
      }
    }
    return { files: written, skipped, failed };
  }

  // ── Данные проекта в Excel: теги + закупки, оборудование ──
  async function exportDataXlsx(destRoot: string, projects: any[], projectName: Map<string, string>): Promise<{ count: number; failed: { name: string; error: string }[] }> {
    const prisma = getPrisma();
    const dir = path.join(destRoot, 'Данные');
    await fsp.mkdir(dir, { recursive: true });
    let count = 0;
    const failed: { name: string; error: string }[] = [];

    for (const proj of projects) {
     try {
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

      const file = path.join(dir, `${projectName.get(proj.id) || sanitizeName(proj.name, 'Проект')}.xlsx`);
      XLSX.writeFile(wb, file);
      count++;
     } catch (error: any) {
      failed.push({ name: String(proj.name), error: String(error?.message || error) });
      log(`[Backup] Книга проекта «${proj.name}» пропущена: ${error?.message}`);
     }
    }
    return { count, failed };
  }

  // Каталоги .pending-* — только временные папки незавершённых архивов
  async function cleanPending(base: string) {
    try {
      for (const n of await fsp.readdir(base)) {
        if (n.startsWith('.pending-')) await fsp.rm(path.join(base, n), { recursive: true, force: true });
      }
    } catch (_) {}
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
      await fsp.mkdir(base, { recursive: true });
      // Остатки прерванных запусков (процесс убит посреди архива) не копим
      await cleanPending(base);
      // Незавершённая папка не считается архивом и не блокирует повторную попытку.
      pending = await fsp.mkdtemp(path.join(base, '.pending-'));

      const dbOk = await copyDatabase(path.join(pending, 'database.sqlite'));
      const projects = await getPrisma().project.findMany();
      const projectName = uniqueProjectNames(projects);
      const explorer = await exportExplorer(pending, projectName);
      const xlsx = await exportDataXlsx(pending, projects, projectName);
      const xlsxCount = xlsx.count;

      const manifest = {
        when: new Date().toISOString(),
        reason,
        database: dbOk ? 'database.sqlite' : 'Внешняя база: здесь только выгрузка файлов и таблиц; полная копия создаётся средствами СУБД',
        explorerFiles: explorer.files,
        explorerSkipped: explorer.skipped,
        // Что не удалось сохранить: архив считается готовым, но владелец это увидит
        // В манифест — не больше 200 записей, полное число отдельно (иначе при тысячах сбоев он раздувается)
        explorerFailed: explorer.failed.slice(0, 200),
        explorerFailedCount: explorer.failed.length,
        dataFailed: xlsx.failed.slice(0, 200),
        dataFailedCount: xlsx.failed.length,
        dbIncluded: dbOk,
        dataWorkbooks: xlsxCount,
        sizeBytes: 0,
        tookMs: Date.now() - startedAt,
      };
      manifest.sizeBytes = await dirSize(pending);
      await fsp.writeFile(path.join(pending, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
      await fsp.rename(pending, dest);

      // Ротация суточных архивов
      try {
        const entries = fs.readdirSync(base).filter(n => n.startsWith('АРХИВ-') && fs.existsSync(path.join(base, n, 'manifest.json')))
          .sort((a, b) => fs.statSync(path.join(base, a, 'manifest.json')).mtimeMs - fs.statSync(path.join(base, b, 'manifest.json')).mtimeMs);
        for (const old of entries.slice(0, Math.max(0, entries.length - Math.max(1, settings.keep)))) {
          await fsp.rm(path.join(base, old), { recursive: true, force: true });
          log(`[Backup] Ротация: удалён старый архив ${old}`);
        }
      } catch (_) {}

      log(`[Backup] Архив готов (${reason}): ${dest} — файлов Проводника: ${explorer.files} (пропущено с ошибкой: ${explorer.failed.length}), книг данных: ${xlsxCount}, БД: ${dbOk ? 'да' : 'нет'}, ${manifest.tookMs} мс`);
      return { dest, ...manifest };
    } finally {
      // Удаляется только собственная временная папка: исходные данные и готовые архивы не затрагиваются.
      if (pending) { try { fs.rmSync(pending, { recursive: true, force: true }); } catch (_) {} }
      running = false;
    }
  }

  // Размер берём из манифеста (записан при создании); обход папок — только для старых архивов
  async function listBackups(base: string) {
    try {
      const names = fs.readdirSync(base)
        .filter(n => n.startsWith('АРХИВ-') && fs.existsSync(path.join(base, n, 'manifest.json')))
        .sort().reverse();
      const out = [];
      for (const name of names) {
        const p = path.join(base, name);
        let manifest: any = null;
        try { manifest = JSON.parse(await fsp.readFile(path.join(p, 'manifest.json'), 'utf-8')); } catch (_) {}
        const size = typeof manifest?.sizeBytes === 'number' && manifest.sizeBytes > 0 ? manifest.sizeBytes : await dirSize(p);
        out.push({ name, path: p, size, manifest });
      }
      return out;
    } catch (_) { return []; }
  }

  // ── API ──
  app.get('/api/backup/status', async (_req: Request, res: Response) => {
    try {
      const settings = await loadSettings();
      const base = resolveBaseDir(settings);
      const list = await listBackups(base);
      res.json({ settings, dir: base, running, backups: list });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  app.post('/api/backup/run', async (req: Request, res: Response) => {
    const u = (req as any).authUser;
    if (!administratorPermission(u, 'admin.backup.run')) return res.status(403).json({ error: 'Нет права запускать резервное копирование' });
    try {
      const result = await runBackup('manual');
      res.json({ success: true, ...result });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  app.post('/api/backup/settings', requireOwnerMiddleware, async (req: Request, res: Response) => {
    const u = (req as any).authUser;
    if (!u || u.role !== 'OWNER') return res.status(403).json({ error: 'Доступно только владельцу' });
    try {
      const cur = await loadSettings();
      const next: BackupSettings = {
        enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : cur.enabled,
        dir: typeof req.body?.dir === 'string' ? req.body.dir : cur.dir,
        keep: parseKeep(req.body?.keep) ?? cur.keep,
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
      // Если настройки прочитать не удалось, архив не запускаем (исключение уйдёт в журнал)
      const settings = await loadSettings();
      if (!running) await cleanPending(resolveBaseDir(settings));
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
