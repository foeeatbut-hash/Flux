import type { Express, Request, Response } from 'express';
import * as XLSX from 'xlsx';
import { getPrisma, resolveProjectId, sendError, notifyUser } from '../context.js';
import { createFileFromBytes, exportsHome } from '../officeStore.js';

// ── ВДР (Vendor Document Register) — реестр документации поставщика ──
// Дизайн: docs/vdr-docflow-design.md + разбор реальных файлов проекта ДГП-2
// (процедура PDH2-0000-96Z-0001, инструкция поставщику, два живых ВДР).
//
// Принципы:
//  • ВДР — ручная таблица в первую очередь; автоматика подсказывает, не пишет.
//  • Стандарт документооборота (DocStandard) — ГЛОБАЛЬНЫЙ шаблон программы:
//    коды рассмотрения с дедлайнами, причины выпуска, правила ревизий (V/S),
//    маски номеров и имён файлов, каталог типов. Применяется к любым проектам.
//  • Структура колонок реестра гибкая: ядро — жёсткие поля, остальные колонки
//    (импортированные и свои) живут в register.columnsConfig + item.extra —
//    экспорт воспроизводит файл заказчика 1:1.

// ── PostgreSQL: ленивое создание таблиц (SQLite мигрирует server.ts) ──
let pgEnsured = false;
async function ensureTables(): Promise<void> {
  if (pgEnsured) return;
  const prisma = getPrisma();
  try {
    await prisma.docStandard.count();
    pgEnsured = true;
  } catch (_) {
    try {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "DocRegister" (
        "id" TEXT NOT NULL PRIMARY KEY, "projectId" TEXT NOT NULL,
        "name" TEXT NOT NULL DEFAULT 'ВДР', "vendor" TEXT NOT NULL DEFAULT '',
        "contractor" TEXT NOT NULL DEFAULT '', "owner" TEXT NOT NULL DEFAULT '',
        "poNumber" TEXT NOT NULL DEFAULT '', "standardId" TEXT,
        "ownerProjectNo" TEXT NOT NULL DEFAULT '', "contractorProjectNo" TEXT NOT NULL DEFAULT '',
        "materialRequisition" TEXT NOT NULL DEFAULT '', "equipmentTitle" TEXT NOT NULL DEFAULT '',
        "contractorDocNo" TEXT NOT NULL DEFAULT '', "ownerDocNo" TEXT NOT NULL DEFAULT '',
        "vendorDocNo" TEXT NOT NULL DEFAULT '', "revision" TEXT NOT NULL DEFAULT 'A',
        "revisions" TEXT NOT NULL DEFAULT '[]', "preparedBy" TEXT NOT NULL DEFAULT '',
        "checkedBy" TEXT NOT NULL DEFAULT '', "approvedBy" TEXT NOT NULL DEFAULT '',
        "preparedById" TEXT, "checkedById" TEXT, "approvedById" TEXT,
        "columnsConfig" TEXT NOT NULL DEFAULT '[]', "managerId" TEXT, "createdById" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "DocRegisterItem" (
        "id" TEXT NOT NULL PRIMARY KEY, "registerId" TEXT NOT NULL, "projectId" TEXT NOT NULL,
        "contractorNo" TEXT NOT NULL DEFAULT '', "ownerNo" TEXT NOT NULL DEFAULT '',
        "vendorNo" TEXT NOT NULL DEFAULT '', "titleEn" TEXT NOT NULL DEFAULT '',
        "titleRu" TEXT NOT NULL DEFAULT '', "vdrCode" TEXT NOT NULL DEFAULT '',
        "revision" TEXT NOT NULL DEFAULT 'A', "issueDate" TIMESTAMP(3),
        "reasonForIssue" TEXT NOT NULL DEFAULT '', "language" TEXT NOT NULL DEFAULT '',
        "equipmentTags" TEXT NOT NULL DEFAULT '[]', "status" TEXT NOT NULL DEFAULT 'DRAFT',
        "docId" TEXT, "fileNodeId" TEXT, "assigneeId" TEXT, "remarks" TEXT NOT NULL DEFAULT '',
        "reviewCode" TEXT NOT NULL DEFAULT '', "dueDate" TIMESTAMP(3),
        "extra" TEXT NOT NULL DEFAULT '{}', "meta" TEXT NOT NULL DEFAULT '{}',
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "DocRegisterItem_registerId_fkey" FOREIGN KEY ("registerId") REFERENCES "DocRegister" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )`);
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "DocStandard" (
        "id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL DEFAULT 'Стандарт',
        "config" TEXT NOT NULL DEFAULT '{}',
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "DocRegisterItemRevision" (
        "id" TEXT NOT NULL PRIMARY KEY, "itemId" TEXT NOT NULL, "revision" TEXT NOT NULL,
        "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "reason" TEXT NOT NULL DEFAULT '',
        "place" TEXT NOT NULL DEFAULT '', "description" TEXT NOT NULL DEFAULT '', "authorId" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      pgEnsured = true;
    } catch (e) { /* нет прав на DDL */ }
  }
}

// ── Стандарт по умолчанию: ЗапСиб/PDH2 (из процедуры 96Z-0001 и инструкции) ──
const DEFAULT_STANDARD = {
  reviewCodes: [
    { code: 'A', label: 'Proceed (No Comments) / Без замечаний', action: 'accept', deadlineDays: 7 },
    { code: 'B', label: 'Minor Comments / Незначительные замечания', action: 'revise', deadlineDays: 7 },
    { code: 'C', label: 'Major Comments / Значительные замечания', action: 'revise', deadlineDays: 14 },
    { code: 'D', label: 'Review not required / Не требует рассмотрения', action: 'accept', deadlineDays: 7 },
    { code: 'Q', label: 'Not accepted, resubmit / Не принят, переподать', action: 'revise', deadlineDays: 7 },
  ],
  reasons: [
    { code: 'IFR', label: 'Issued for Review / Для рассмотрения', revKind: 'letter' },
    { code: 'IFI', label: 'Issued for Information / Для информации', revKind: 'letter' },
    { code: 'IFU', label: 'Issued for Use / Для использования', revKind: 'digit' },
    { code: 'CEF', label: 'Certified Final / Окончательный', revKind: 'digit' },
  ],
  specialRevisions: { void: 'V', superseded: 'S' },
  docNumberMask: '{contract}-{wbs}-{po}-{type}-{seq}',
  fileNameMask: '{docNo}_{rev}_{lang}',
  vdrTypes: [
    { code: 'A01', titleEn: 'Vendor Document Register', titleRu: 'Реестр документации поставщика' },
    { code: 'B01', titleEn: 'Fabrication/Production Schedule', titleRu: 'График изготовления' },
    { code: 'C01', titleEn: 'General Arrangements', titleRu: 'Габаритные чертежи' },
    { code: 'E02', titleEn: 'Equipment Data Sheets', titleRu: 'Опросные листы' },
    { code: 'K32', titleEn: 'Technical Passport', titleRu: 'Технический паспорт' },
  ],
};

async function ensureDefaultStandard(): Promise<void> {
  const prisma = getPrisma();
  const count = await prisma.docStandard.count().catch(() => -1);
  if (count === 0) {
    await prisma.docStandard.create({
      data: { name: 'ЗапСиб / PDH2 (процедура 96Z-0001)', config: JSON.stringify(DEFAULT_STANDARD) },
    }).catch(() => {});
  }
}

async function standardOfRegister(register: any): Promise<any> {
  const prisma = getPrisma();
  if (register?.standardId) {
    const std = await prisma.docStandard.findUnique({ where: { id: register.standardId } }).catch(() => null);
    if (std) { try { return { id: std.id, name: std.name, ...JSON.parse(std.config || '{}') }; } catch (_) {} }
  }
  return { ...DEFAULT_STANDARD };
}

// ── Ревизии ──
export function nextRevision(rev: string, certify = false): string {
  const r = String(rev || '').trim().toUpperCase();
  if (certify) return '0';
  if (/^\d+$/.test(r)) return String(Number(r) + 1);
  if (/^[A-Z]$/.test(r)) return r === 'Z' ? '0' : String.fromCharCode(r.charCodeAt(0) + 1);
  return r ? r + '+' : 'A';
}

const parseJson = (raw: any, fb: any) => { try { const v = JSON.parse(raw); return v ?? fb; } catch { return fb; } };

// ── Разбор Excel-ВДР 2.0: многострочная шапка, columnMap, extra ──
const CORE_FIELDS: { field: string; match: RegExp }[] = [
  { field: 'vendor', match: /^vendor\s*$|^поставщик/i },
  { field: 'poNumber', match: /purchase\s*order|номер\s*заказа/i },
  { field: 'contractorNo', match: /contractor\s*document|номер\s*документа\s*поставщика|подрядчик.*номер/i },
  { field: 'ownerNo', match: /owner\s*document|номер\s*документа\s*заказчика/i },
  { field: 'vendorNo', match: /vendor\s*document\s*(no|number)/i },
  { field: 'titleEn', match: /english.*title|title.*english|на\s*англ/i },
  { field: 'titleRu', match: /russian.*title|title.*russian|на\s*рус/i },
  { field: 'vdrCode', match: /doc\.?\s*type|vdr\s*code|тип\s*док/i },
  { field: 'revision', match: /^rev|ревизия/i },
  { field: 'issueDate', match: /^date|^дата\s*$/i },
  { field: 'reasonForIssue', match: /reason|причина/i },
  { field: 'language', match: /language|язык/i },
  { field: 'equipmentTags', match: /tag\s*no|таговый|тег/i },
];

function normColKey(s: string, idx: number): string {
  const base = String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return base || `col${idx}`;
}

function parseDateCell(v: any): Date | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return isNaN(d.getTime()) ? null : d;
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (m) {
    const yyyy = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = new Date(yyyy, Number(m[2]) - 1, Number(m[1]));
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

const cellStr = (v: any) => {
  if (v instanceof Date) return `${String(v.getDate()).padStart(2, '0')}.${String(v.getMonth() + 1).padStart(2, '0')}.${v.getFullYear()}`;
  if (typeof v === 'number' && v > 40000 && v < 60000 && Number.isInteger(v)) {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  }
  return String(v ?? '').trim();
};

// Ищем шапку: строка, где ≥3 колонок совпали с ядром. Возвращаем маппинг,
// вторую строку заголовков (RU) и индекс начала данных (пропустив RU и строку кодов).
function detectHeader(aoa: any[][]): null | {
  headerIdx: number; dataIdx: number;
  map: Record<number, string>;           // colIdx → core field
  columns: { idx: number; key: string; title: string; titleRu: string }[]; // ВСЕ колонки по порядку
} {
  for (let i = 0; i < Math.min(aoa.length, 15); i++) {
    const row = aoa[i] || [];
    const map: Record<number, string> = {};
    const used = new Set<string>();
    row.forEach((h, idx) => {
      const text = String(h ?? '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      for (const { field, match } of CORE_FIELDS) {
        if (!used.has(field) && match.test(text)) { map[idx] = field; used.add(field); break; }
      }
    });
    if (Object.keys(map).length < 3) continue;

    // Возможные строки-продолжения шапки: RU-названия и строка кодов (Flag|1|2|…)
    let dataIdx = i + 1;
    let ruRow: any[] = [];
    const looksLikeCodes = (r: any[]) => {
      const vals = (r || []).map(x => String(x ?? '').trim()).filter(Boolean);
      if (!vals.length) return false;
      const numeric = vals.filter(x => /^\d{1,2}$|^s\d[pa]$|^fa$|^flag$/i.test(x)).length;
      return numeric / vals.length > 0.6;
    };
    const looksLikeRu = (r: any[]) => {
      const vals = (r || []).map(x => String(x ?? '').trim()).filter(Boolean);
      if (vals.length < 3) return false;
      const cyr = vals.filter(x => /[А-Яа-я]/.test(x) && !/\d{4}/.test(x)).length;
      return cyr / vals.length > 0.6;
    };
    if (looksLikeRu(aoa[dataIdx])) { ruRow = aoa[dataIdx] || []; dataIdx++; }
    if (looksLikeCodes(aoa[dataIdx])) dataIdx++;

    const maxCols = Math.max(row.length, ruRow.length);
    const columns: { idx: number; key: string; title: string; titleRu: string }[] = [];
    for (let c = 0; c < maxCols; c++) {
      const en = String(row[c] ?? '').replace(/\s+/g, ' ').trim();
      const ru = String(ruRow[c] ?? '').replace(/\s+/g, ' ').trim();
      if (!en && !ru) continue;
      columns.push({ idx: c, key: normColKey(en || ru, c), title: en, titleRu: ru });
    }
    return { headerIdx: i, dataIdx, map, columns };
  }
  return null;
}

// Валидная строка данных (отсекает повторы шапки и мусор)
function isDataRow(row: any[], map: Record<number, string>): boolean {
  const get = (f: string) => {
    const idx = Object.entries(map).find(([, v]) => v === f)?.[0];
    return idx == null ? '' : String(row[Number(idx)] ?? '').trim();
  };
  const no = get('contractorNo');
  if (/[A-Za-z0-9]/.test(no) && no.includes('-') && /\d/.test(no)) return true;
  const title = get('titleEn') || get('titleRu');
  const rev = get('revision');
  return /[A-Za-zА-Яа-я]{2,}/.test(title) && rev.length <= 4 && !/ревизия|revision/i.test(rev);
}

const STATUSES = ['DRAFT', 'READY', 'REMARKS', 'ACCEPTED'];

export function registerVdrRoutes(app: Express, deps: { chunkBytes: () => Promise<number> }): void {
  const authUserOf = (req: Request): any => (req as any).authUser || null;

  app.use('/api/vdr', async (_req, _res, next) => {
    await ensureTables();
    await ensureDefaultStandard().catch(() => {});
    next();
  });

  // ── Стандарты документооборота (глобальные шаблоны программы) ──
  app.get('/api/vdr/standards', async (_req: Request, res: Response) => {
    try {
      const rows = await getPrisma().docStandard.findMany({ orderBy: { createdAt: 'asc' } });
      res.json({ standards: rows.map((r: any) => ({ id: r.id, name: r.name, config: parseJson(r.config, {}), updatedAt: r.updatedAt })) });
    } catch (err: any) { sendError(res, err); }
  });

  app.post('/api/vdr/standards', async (req: Request, res: Response) => {
    try {
      const std = await getPrisma().docStandard.create({
        data: {
          name: String(req.body?.name || 'Новый стандарт').trim(),
          config: JSON.stringify(req.body?.config || DEFAULT_STANDARD),
        },
      });
      res.json({ standard: { id: std.id, name: std.name, config: parseJson(std.config, {}) } });
    } catch (err: any) { sendError(res, err); }
  });

  app.put('/api/vdr/standards/:id', async (req: Request, res: Response) => {
    try {
      const data: any = {};
      if (typeof req.body?.name === 'string' && req.body.name.trim()) data.name = req.body.name.trim();
      if (req.body?.config && typeof req.body.config === 'object') data.config = JSON.stringify(req.body.config);
      const std = await getPrisma().docStandard.update({ where: { id: req.params.id }, data });
      res.json({ standard: { id: std.id, name: std.name, config: parseJson(std.config, {}) } });
    } catch (err: any) { sendError(res, err); }
  });

  app.delete('/api/vdr/standards/:id', async (req: Request, res: Response) => {
    try {
      const me = authUserOf(req);
      if (me && me.role !== 'ADMIN') return res.status(403).json({ error: 'Удалять стандарты может администратор' });
      await getPrisma().docStandard.delete({ where: { id: req.params.id } });
      res.json({ success: true });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Реестры ──
  app.get('/api/vdr/registers', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProjectId(String(req.query.projectId || ''));
      const prisma = getPrisma();
      const registers = await prisma.docRegister.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } });
      const items = await prisma.docRegisterItem.groupBy({
        by: ['registerId', 'status'], where: { projectId }, _count: { _all: true },
      }).catch(() => []);
      const counts: Record<string, Record<string, number>> = {};
      for (const g of items) (counts[g.registerId] ||= {})[g.status] = g._count._all;
      res.json({ registers: registers.map((r: any) => ({ ...r, columnsConfig: parseJson(r.columnsConfig, []), revisions: parseJson(r.revisions, []), counts: counts[r.id] || {} })) });
    } catch (err: any) { sendError(res, err); }
  });

  const REGISTER_FIELDS = ['name', 'vendor', 'contractor', 'owner', 'poNumber', 'ownerProjectNo', 'contractorProjectNo',
    'materialRequisition', 'equipmentTitle', 'contractorDocNo', 'ownerDocNo', 'vendorDocNo', 'revision',
    'preparedBy', 'checkedBy', 'approvedBy',
    // Кто именно подписывает: по ним титул документа берёт подписи (§42).
    // Имя строкой остаётся рядом — в импортированных реестрах человек указан
    // текстом, и сотрудника с таким именем в программе может не быть
    'preparedById', 'checkedById', 'approvedById'] as const;

  app.post('/api/vdr/registers', async (req: Request, res: Response) => {
    try {
      const me = authUserOf(req);
      const projectId = await resolveProjectId(String(req.body?.projectId || ''));
      const data: any = { projectId, createdById: me?.id || null };
      for (const k of REGISTER_FIELDS) if (typeof req.body?.[k] === 'string') data[k] = req.body[k];
      if (!data.name) data.name = 'ВДР';
      if (req.body?.standardId) data.standardId = String(req.body.standardId);
      if (req.body?.managerId) data.managerId = String(req.body.managerId);
      const register = await getPrisma().docRegister.create({ data });
      res.json({ register });
    } catch (err: any) { sendError(res, err); }
  });

  app.put('/api/vdr/registers/:id', async (req: Request, res: Response) => {
    try {
      const data: any = {};
      for (const k of REGISTER_FIELDS) if (typeof req.body?.[k] === 'string') data[k] = req.body[k];
      // Пустая строка в поле подписанта означает «никого», и в базе это null,
      // а не '': по пустой строке потом не отличить «не выбрали» от «стёрли»
      for (const k of ['preparedById', 'checkedById', 'approvedById']) if (data[k] === '') data[k] = null;
      if ('managerId' in (req.body || {})) data.managerId = req.body.managerId || null;
      if ('standardId' in (req.body || {})) data.standardId = req.body.standardId || null;
      if (Array.isArray(req.body?.columnsConfig)) data.columnsConfig = JSON.stringify(req.body.columnsConfig);
      if (Array.isArray(req.body?.revisions)) data.revisions = JSON.stringify(req.body.revisions);
      const register = await getPrisma().docRegister.update({ where: { id: req.params.id }, data });
      res.json({ register: { ...register, columnsConfig: parseJson(register.columnsConfig, []), revisions: parseJson(register.revisions, []) } });
    } catch (err: any) { sendError(res, err); }
  });

  // Новая ревизия самого ВДР: запись в историю (лист Accounting for revisions)
  app.post('/api/vdr/registers/:id/revision-up', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const register = await prisma.docRegister.findUnique({ where: { id: req.params.id } });
      if (!register) return res.status(404).json({ error: 'Реестр не найден' });
      const certify = !!req.body?.certify;
      const revision = nextRevision(register.revision, certify);
      const history = parseJson(register.revisions, []);
      history.push({
        rev: revision,
        date: new Date().toISOString(),
        description: String(req.body?.description || (certify || /^\d+$/.test(revision) ? 'Certified Final/ Окончательный' : 'Issued for Review/Выпущено для рассмотрения')),
      });
      const updated = await prisma.docRegister.update({
        where: { id: register.id },
        data: { revision, revisions: JSON.stringify(history) },
      });
      res.json({ register: { ...updated, revisions: history, columnsConfig: parseJson(updated.columnsConfig, []) } });
    } catch (err: any) { sendError(res, err); }
  });

  app.delete('/api/vdr/registers/:id', async (req: Request, res: Response) => {
    try {
      const me = authUserOf(req);
      if (me && me.role !== 'ADMIN' && me.role !== 'MANAGER') {
        return res.status(403).json({ error: 'Удалять реестр может администратор или руководитель' });
      }
      await getPrisma().docRegister.delete({ where: { id: req.params.id } });
      res.json({ success: true });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Строки ──
  app.get('/api/vdr/items', async (req: Request, res: Response) => {
    try {
      const registerId = String(req.query.registerId || '');
      if (!registerId) return res.json({ items: [] });
      const items = await getPrisma().docRegisterItem.findMany({
        where: { registerId }, orderBy: [{ vdrCode: 'asc' }, { contractorNo: 'asc' }],
      });
      res.json({ items: items.map((i: any) => ({ ...i, extra: parseJson(i.extra, {}) })) });
    } catch (err: any) { sendError(res, err); }
  });

  const ITEM_FIELDS = ['contractorNo', 'ownerNo', 'vendorNo', 'titleEn', 'titleRu', 'vdrCode', 'revision',
    'reasonForIssue', 'language', 'remarks', 'reviewCode'] as const;

  app.post('/api/vdr/items', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const register = await prisma.docRegister.findUnique({ where: { id: String(req.body?.registerId || '') } });
      if (!register) return res.status(404).json({ error: 'Реестр не найден' });
      const data: any = { registerId: register.id, projectId: register.projectId };
      for (const k of ITEM_FIELDS) if (typeof req.body?.[k] === 'string') data[k] = req.body[k];
      if (req.body?.assigneeId) data.assigneeId = String(req.body.assigneeId);
      if (typeof req.body?.equipmentTags === 'string') data.equipmentTags = req.body.equipmentTags;
      const item = await prisma.docRegisterItem.create({ data });
      res.json({ item: { ...item, extra: {} } });
    } catch (err: any) { sendError(res, err); }
  });

  // Правка строки. Код рассмотрения — из стандарта реестра: сам ставит статус
  // (accept→ACCEPTED, revise→REMARKS) и срок следующей ревизии (deadlineDays).
  app.put('/api/vdr/items/:id', async (req: Request, res: Response) => {
    try {
      const me = authUserOf(req);
      const prisma = getPrisma();
      const item = await prisma.docRegisterItem.findUnique({ where: { id: req.params.id } });
      if (!item) return res.status(404).json({ error: 'Строка реестра не найдена' });

      const data: any = {};
      for (const k of ITEM_FIELDS) if (typeof req.body?.[k] === 'string') data[k] = req.body[k];
      if ('assigneeId' in (req.body || {})) data.assigneeId = req.body.assigneeId || null;
      if ('docId' in (req.body || {})) data.docId = req.body.docId || null;
      if ('fileNodeId' in (req.body || {})) data.fileNodeId = req.body.fileNodeId || null;
      if (typeof req.body?.equipmentTags === 'string') data.equipmentTags = req.body.equipmentTags;
      if (req.body?.issueDate !== undefined) data.issueDate = req.body.issueDate ? new Date(req.body.issueDate) : null;
      if (req.body?.dueDate !== undefined) data.dueDate = req.body.dueDate ? new Date(req.body.dueDate) : null;
      if (req.body?.extra && typeof req.body.extra === 'object') {
        data.extra = JSON.stringify({ ...parseJson(item.extra, {}), ...req.body.extra });
      }

      const register = await prisma.docRegister.findUnique({ where: { id: item.registerId } });

      // Код рассмотрения: статус и дедлайн из стандарта (если явно не переданы)
      if (typeof data.reviewCode === 'string' && data.reviewCode && data.reviewCode !== item.reviewCode) {
        const std = await standardOfRegister(register);
        const rc = (std.reviewCodes || []).find((x: any) => x.code === data.reviewCode);
        if (rc) {
          if (!req.body?.status) data.status = rc.action === 'accept' ? 'ACCEPTED' : 'REMARKS';
          if (req.body?.dueDate === undefined && rc.deadlineDays) {
            data.dueDate = new Date(Date.now() + Number(rc.deadlineDays) * 86400000);
          }
        }
      }

      const newStatus = String(req.body?.status || '');
      if (newStatus && STATUSES.includes(newStatus) && newStatus !== item.status) data.status = newStatus;

      const updated = await prisma.docRegisterItem.update({ where: { id: item.id }, data });

      // Уведомления документооборота
      if (data.status && data.status !== item.status) {
        const docName = updated.contractorNo || updated.titleRu || updated.titleEn || 'документ';
        const route = `/management?vdr=${item.registerId}&item=${item.id}`;
        if (data.status === 'READY' && register?.managerId) {
          await notifyUser(register.managerId, 'ДОКУМЕНТЫ', `Документ готов: ${docName}`,
            `${updated.titleRu || updated.titleEn || ''} · рев. ${updated.revision}${me?.name ? ` · ${me.name}` : ''}`, route);
        }
        if (data.status === 'REMARKS' && updated.assigneeId) {
          const due = updated.dueDate ? ` · срок ${new Date(updated.dueDate).toLocaleDateString('ru-RU')}` : '';
          await notifyUser(updated.assigneeId, 'ДОКУМЕНТЫ',
            `Замечания${updated.reviewCode ? ` (код ${updated.reviewCode})` : ''}: ${docName}`,
            (updated.remarks || 'Заказчик вернул замечания') + due,
            updated.fileNodeId ? `/explorer?file=${updated.fileNodeId}` : route);
        }
        if (data.status === 'ACCEPTED' && updated.assigneeId) {
          await notifyUser(updated.assigneeId, 'ДОКУМЕНТЫ', `Принят заказчиком: ${docName}`, `Ревизия ${updated.revision}`, route);
        }
      }
      res.json({ item: { ...updated, extra: parseJson(updated.extra, {}) } });
    } catch (err: any) { sendError(res, err); }
  });

  app.delete('/api/vdr/items/:id', async (req: Request, res: Response) => {
    try {
      const me = authUserOf(req);
      if (me && me.role !== 'ADMIN' && me.role !== 'MANAGER') {
        return res.status(403).json({ error: 'Удалять строки реестра может администратор или руководитель' });
      }
      await getPrisma().docRegisterItem.delete({ where: { id: req.params.id } });
      res.json({ success: true });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Поиск строк по проекту (привязка документа/файла из других разделов) ──
  // Сводка «требует внимания» по проекту: одним запросом вместо обхода
  // всех реестров. Нужна главному экрану, чтобы показать просроченное и
  // адресованные пользователю замечания без N+1.
  app.get('/api/vdr/attention', async (req: Request, res: Response) => {
    try {
      const projectId = String(req.query.projectId || '');
      const userId = String(req.query.userId || '');
      if (!projectId) return res.json({ overdue: 0, soon: 0, remarks: 0, items: [] });

      const now = new Date();
      const soonEdge = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
      const prisma = getPrisma();

      const open = { projectId, status: { not: 'ACCEPTED' } } as any;
      const [overdueItems, soonItems, remarkItems] = await Promise.all([
        prisma.docRegisterItem.findMany({
          where: { ...open, dueDate: { lt: now } },
          orderBy: { dueDate: 'asc' }, take: 50,
        }),
        prisma.docRegisterItem.findMany({
          where: { ...open, dueDate: { gte: now, lte: soonEdge } },
          orderBy: { dueDate: 'asc' }, take: 50,
        }),
        userId
          ? prisma.docRegisterItem.findMany({
              where: { projectId, status: 'REMARKS', assigneeId: userId },
              orderBy: { updatedAt: 'desc' }, take: 50,
            })
          : Promise.resolve([] as any[]),
      ]);

      const brief = (i: any, kind: string) => ({
        id: i.id, registerId: i.registerId, kind,
        code: i.vdrCode || '', title: i.titleRu || i.titleEn || '',
        revision: i.revision || '', dueDate: i.dueDate,
      });

      res.json({
        overdue: overdueItems.length,
        soon: soonItems.length,
        remarks: remarkItems.length,
        // Один документ может попасть сразу в две выборки (например,
        // с замечаниями и с близким сроком) — в списке показываем один раз.
        items: (() => {
          const seen = new Set<string>();
          const out: any[] = [];
          for (const [list, kind] of [[overdueItems, 'overdue'], [remarkItems, 'remarks'], [soonItems, 'soon']] as const) {
            for (const i of list as any[]) {
              if (seen.has(i.id) || out.length >= 5) continue;
              seen.add(i.id);
              out.push(brief(i, kind));
            }
          }
          return out;
        })(),
      });
    } catch (err: any) { sendError(res, err); }
  });

  app.get('/api/vdr/items/search', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProjectId(String(req.query.projectId || ''));
      const q = String(req.query.q || '').trim().toLowerCase();
      const prisma = getPrisma();
      const items = await prisma.docRegisterItem.findMany({
        where: { projectId }, orderBy: [{ vdrCode: 'asc' }, { contractorNo: 'asc' }],
      });
      const registers = await prisma.docRegister.findMany({ where: { projectId }, select: { id: true, name: true } });
      const regName = new Map(registers.map((r: any) => [r.id, r.name]));
      const match = (i: any) => !q || [i.contractorNo, i.ownerNo, i.titleRu, i.titleEn, i.vdrCode]
        .some((v: any) => String(v || '').toLowerCase().includes(q));
      res.json({
        items: items.filter(match).slice(0, 25).map((i: any) => ({
          id: i.id, registerId: i.registerId, registerName: regName.get(i.registerId) || '',
          contractorNo: i.contractorNo, titleRu: i.titleRu, titleEn: i.titleEn,
          vdrCode: i.vdrCode, revision: i.revision, status: i.status, docId: i.docId,
        })),
      });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Документы по тегу: карточка тега показывает свои документы ВДР ──
  app.get('/api/vdr/items/by-tag', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProjectId(String(req.query.projectId || ''));
      const tag = String(req.query.tag || '').trim().toLowerCase();
      if (!tag) return res.json({ items: [] });
      const items = await getPrisma().docRegisterItem.findMany({
        where: { projectId }, orderBy: [{ vdrCode: 'asc' }],
      });
      const out = items.filter((i: any) => {
        const tags = parseJson(i.equipmentTags, []);
        return tags.some((t: any) => String(t).toLowerCase() === tag || String(t).toLowerCase() === 'all items');
      }).map((i: any) => ({
        id: i.id, registerId: i.registerId, contractorNo: i.contractorNo,
        titleRu: i.titleRu, titleEn: i.titleEn, vdrCode: i.vdrCode,
        revision: i.revision, status: i.status, docId: i.docId, dueDate: i.dueDate,
      }));
      res.json({ items: out });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Привязка/отвязка документа Конструктора к строке (обе стороны сразу) ──
  app.post('/api/vdr/items/:id/link-doc', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const item = await prisma.docRegisterItem.findUnique({ where: { id: req.params.id } });
      if (!item) return res.status(404).json({ error: 'Строка реестра не найдена' });
      const docId = req.body?.docId ? String(req.body.docId) : null;

      // Отвязать старый документ строки
      if (item.docId && item.docId !== docId) {
        try {
          const old = await prisma.constructorDoc.findUnique({ where: { id: item.docId } });
          if (old) {
            const st = parseJson(old.settings, {});
            delete st.vdrItemId;
            await prisma.constructorDoc.update({ where: { id: old.id }, data: { settings: JSON.stringify(st) } });
          }
        } catch (_) {}
      }

      if (docId) {
        const doc = await prisma.constructorDoc.findUnique({ where: { id: docId } });
        if (!doc) return res.status(404).json({ error: 'Документ не найден' });
        const st = parseJson(doc.settings, {});
        st.vdrItemId = item.id;
        st.docMeta = {
          ...st.docMeta,
          code: item.contractorNo || item.ownerNo,
          revision: item.revision,
          title: item.titleRu || item.titleEn || st.docMeta?.title,
        };
        await prisma.constructorDoc.update({ where: { id: doc.id }, data: { settings: JSON.stringify(st) } });
      }
      const updated = await prisma.docRegisterItem.update({ where: { id: item.id }, data: { docId } });
      res.json({ item: { ...updated, extra: parseJson(updated.extra, {}) } });
    } catch (err: any) { sendError(res, err); }
  });

  // ── История ревизий строки (лист «Учёт ревизий» документа) ──
  app.get('/api/vdr/items/:id/revisions', async (req: Request, res: Response) => {
    try {
      const revisions = await getPrisma().docRegisterItemRevision.findMany({
        where: { itemId: req.params.id }, orderBy: { createdAt: 'asc' },
      });
      res.json({ revisions });
    } catch (err: any) { sendError(res, err); }
  });

  // «Выпустить ревизию»: next | certify (→0) | void (→V) | superseded (→S).
  // Пишет историю (место/описание), сбрасывает статус, обновляет титул документа.
  app.post('/api/vdr/items/:id/issue-revision', async (req: Request, res: Response) => {
    try {
      const me = authUserOf(req);
      const prisma = getPrisma();
      const item = await prisma.docRegisterItem.findUnique({ where: { id: req.params.id } });
      if (!item) return res.status(404).json({ error: 'Строка реестра не найдена' });
      const register = await prisma.docRegister.findUnique({ where: { id: item.registerId } });
      const std = await standardOfRegister(register);

      const kind = String(req.body?.kind || 'next'); // next | certify | void | superseded
      let revision: string;
      let reason: string;
      if (kind === 'void') { revision = std.specialRevisions?.void || 'V'; reason = 'VOID'; }
      else if (kind === 'superseded') { revision = std.specialRevisions?.superseded || 'S'; reason = 'SUPERSEDED'; }
      else {
        revision = nextRevision(item.revision, kind === 'certify');
        // Причина по типу ревизии из стандарта: цифровая → первая digit-причина (CEF), буквенная → letter (IFR)
        const kindOf = /^\d+$/.test(revision) ? 'digit' : 'letter';
        reason = String(req.body?.reason || (std.reasons || []).find((r: any) => r.revKind === kindOf)?.code || (kindOf === 'digit' ? 'CEF' : 'IFR'));
      }

      await prisma.docRegisterItemRevision.create({
        data: {
          itemId: item.id,
          revision,
          reason,
          place: String(req.body?.place || ''),
          description: String(req.body?.description || (kind === 'superseded' && req.body?.supersededBy ? `Заменён на ${req.body.supersededBy}` : '')),
          authorId: me?.id || null,
        },
      });

      const updated = await prisma.docRegisterItem.update({
        where: { id: item.id },
        data: {
          revision,
          issueDate: new Date(),
          reasonForIssue: reason,
          dueDate: null,
          ...(kind === 'next' || kind === 'certify' ? { status: 'DRAFT', reviewCode: '' } : {}),
        },
      });

      // Титул привязанного документа получает новую ревизию
      if (item.docId) {
        try {
          const doc = await prisma.constructorDoc.findUnique({ where: { id: item.docId } });
          if (doc) {
            const settings = parseJson(doc.settings, {});
            settings.docMeta = { ...settings.docMeta, revision };
            await prisma.constructorDoc.update({ where: { id: doc.id }, data: { settings: JSON.stringify(settings) } });
          }
        } catch (_) {}
      }
      res.json({ item: { ...updated, extra: parseJson(updated.extra, {}) } });
    } catch (err: any) { sendError(res, err); }
  });

  // Совместимость: старая кнопка повышения ревизии
  app.post('/api/vdr/items/:id/revision-up', async (req: Request, res: Response) => {
    (req.body ||= {}).kind = req.body?.certify ? 'certify' : 'next';
    return (app._router.handle as any)
      ? res.redirect(307, `/api/vdr/items/${req.params.id}/issue-revision`)
      : res.status(400).json({ error: 'unsupported' });
  });

  // ── Формирование документа по строке ──
  app.post('/api/vdr/items/:id/create-doc', async (req: Request, res: Response) => {
    try {
      const me = authUserOf(req);
      const prisma = getPrisma();
      const item = await prisma.docRegisterItem.findUnique({ where: { id: req.params.id } });
      if (!item) return res.status(404).json({ error: 'Строка реестра не найдена' });
      if (item.docId) {
        const existing = await prisma.constructorDoc.findUnique({ where: { id: item.docId } });
        if (existing && !existing.deletedAt) return res.json({ doc: existing, existed: true });
      }
      const title = item.titleRu || item.titleEn || '';
      const name = [item.contractorNo, title].filter(Boolean).join(' — ') || 'Документ по ВДР';
      const doc = await prisma.constructorDoc.create({
        data: {
          projectId: item.projectId,
          name, named: true,
          kind: String(req.body?.kind) === 'DOC' ? 'DOC' : 'TEXT',
          scope: 'SHARED',
          ownerId: me?.id || null, createdById: me?.id || null, updatedById: me?.id || null,
          workbook: '',
          settings: JSON.stringify({
            docMeta: { code: item.contractorNo || item.ownerNo, revision: item.revision, title },
            vdrItemId: item.id,
          }),
        },
      });
      await prisma.docRegisterItem.update({ where: { id: item.id }, data: { docId: doc.id, assigneeId: item.assigneeId || me?.id || null } });
      res.json({ doc });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Импорт Excel-ВДР 2.0 ──
  // Многострочная шапка (EN + RU + строка кодов), ВСЕ колонки сохраняются:
  // ядро — в поля, остальное — в item.extra по ключам из columnsConfig.
  app.post('/api/vdr/import', async (req: Request, res: Response) => {
    try {
      const me = authUserOf(req);
      const prisma = getPrisma();
      const projectId = await resolveProjectId(String(req.body?.projectId || ''));
      let b64 = String(req.body?.content || '');
      if (b64.includes(',')) b64 = b64.split(',')[1];
      if (!b64) return res.status(400).json({ error: 'Файл не передан' });
      const wb = XLSX.read(Buffer.from(b64, 'base64'), { type: 'buffer', cellDates: true });

      // Лист реестра: лучший по числу распознанных колонок (+бонус имени листа)
      let best: { sheet: string; det: NonNullable<ReturnType<typeof detectHeader>>; rows: any[][] } | null = null;
      let bestScore = -1;
      for (const sn of wb.SheetNames) {
        const aoa = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[sn], { header: 1, blankrows: false, defval: '' }) as any[][];
        const det = detectHeader(aoa);
        if (!det) continue;
        const score = Object.keys(det.map).length + (/register|вдр|реестр/i.test(sn) ? 5 : 0);
        if (score > bestScore) { bestScore = score; best = { sheet: sn, det, rows: aoa.slice(det.dataIdx) }; }
      }
      if (!best) return res.status(400).json({ error: 'Не нашёл лист реестра (нет колонок номера/названия/ревизии)' });

      // Реестр: существующий или новый
      let register: any = null;
      if (req.body?.registerId) register = await prisma.docRegister.findUnique({ where: { id: String(req.body.registerId) } });
      if (!register) {
        register = await prisma.docRegister.create({
          data: {
            projectId,
            name: String(req.body?.name || req.body?.fileName || 'ВДР (импорт)').replace(/\.[^.]+$/, ''),
            createdById: me?.id || null,
          },
        });
      }

      // Структура колонок: импортированные колонки (с исходным порядком) +
      // уже существующие свои — не теряем при переимпорте
      const coreByIdx = best.det.map;
      const columnsConfig = best.det.columns.map(c => ({
        key: c.key, title: c.title, titleRu: c.titleRu,
        field: coreByIdx[c.idx] || undefined,   // ядро
        source: 'import',
      }));
      const prevCols = parseJson(register.columnsConfig, []);
      const customCols = prevCols.filter((c: any) => c.source === 'custom');
      const mergedCols = [...columnsConfig, ...customCols.filter((c: any) => !columnsConfig.find(x => x.key === c.key))];

      const existing = await prisma.docRegisterItem.findMany({ where: { registerId: register.id } });
      const byNo = new Map<string, any>(existing.filter((x: any) => x.contractorNo).map((x: any) => [String(x.contractorNo), x] as [string, any]));

      let created = 0, updated = 0, skipped = 0;
      const regHeader: any = {};
      for (const row of best.rows) {
        if (!isDataRow(row, coreByIdx)) { skipped++; continue; }
        const core: any = {};
        const extra: any = {};
        for (const col of best.det.columns) {
          const v = row[col.idx];
          const field = coreByIdx[col.idx];
          if (field === 'issueDate') core.issueDate = parseDateCell(v);
          else if (field === 'equipmentTags') {
            const s = cellStr(v);
            core.equipmentTags = JSON.stringify(/all\s*items|все\s*позиции/i.test(s) ? ['All items'] : s.split(/[;,]/).map(x => x.trim()).filter(Boolean));
          }
          else if (field) core[field] = cellStr(v);
          else { const s = cellStr(v); if (s) extra[col.key] = s; }
        }
        if (core.vendor && !regHeader.vendor) regHeader.vendor = core.vendor;
        if (core.poNumber && !regHeader.poNumber) regHeader.poNumber = core.poNumber;
        delete core.vendor; delete core.poNumber; // реквизиты реестра, не строки

        const itemData = {
          contractorNo: core.contractorNo || '', ownerNo: core.ownerNo || '', vendorNo: core.vendorNo || '',
          titleEn: core.titleEn || '', titleRu: core.titleRu || '', vdrCode: core.vdrCode || '',
          revision: core.revision || 'A', issueDate: core.issueDate || null,
          reasonForIssue: core.reasonForIssue || '', language: core.language || '',
          ...(core.equipmentTags ? { equipmentTags: core.equipmentTags } : {}),
          extra: JSON.stringify(extra),
        };
        const prev = itemData.contractorNo ? byNo.get(itemData.contractorNo) : null;
        if (prev) { await prisma.docRegisterItem.update({ where: { id: prev.id }, data: itemData }); updated++; }
        else { await prisma.docRegisterItem.create({ data: { ...itemData, registerId: register.id, projectId } }); created++; }
      }

      // Титульник → реквизиты; Accounting → история ревизий ВДР (если находим)
      const regData: any = { columnsConfig: JSON.stringify(mergedCols) };
      if (!register.vendor && regHeader.vendor) regData.vendor = regHeader.vendor;
      if (!register.poNumber && regHeader.poNumber) regData.poNumber = regHeader.poNumber;
      const titSheet = wb.SheetNames.find(sn => /titular|титул/i.test(sn));
      if (titSheet) {
        const aoa = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[titSheet], { header: 1, blankrows: false, defval: '' }) as any[][];
        // Ярлык в строке → первое непустое значение правее (значения не похожи на ярлыки)
        const TIT_FIELDS: { field: string; match: RegExp }[] = [
          { field: 'contractor', match: /^contractor\s*\/|^contractor\s*:|подрядчик:/i },
          { field: 'owner', match: /^owner\s*\/|^owner\s*:|заказчик:/i },
          { field: 'contractorProjectNo', match: /contractor\s*project\s*no/i },
          { field: 'ownerProjectNo', match: /owner\s*project\s*no/i },
          { field: 'vendor', match: /^vendor\s*\/|^vendor\s*:|поставщик:/i },
          { field: 'poNumber', match: /purchase\s*order/i },
          { field: 'materialRequisition', match: /material\s*requisition/i },
          { field: 'equipmentTitle', match: /equipment\s*title/i },
          { field: 'contractorDocNo', match: /contractor\s*document\s*no/i },
          { field: 'ownerDocNo', match: /owner\s*document\s*n/i },
          { field: 'vendorDocNo', match: /vendor\s*document\s*no/i },
        ];
        const found: any = {};
        for (const row of aoa.slice(0, 30)) {
          for (let c = 0; c < row.length; c++) {
            const label = String(row[c] ?? '').replace(/\s+/g, ' ').trim();
            if (!label) continue;
            for (const { field, match } of TIT_FIELDS) {
              if (found[field] || !match.test(label)) continue;
              for (let v = c + 1; v < row.length; v++) {
                const val = cellStr(row[v]);
                // значение — не следующий ярлык (у ярлыков есть « / » или двоеточие в конце)
                if (val && !TIT_FIELDS.some(t => t.match.test(val))) { found[field] = val.slice(0, 200); break; }
              }
            }
          }
        }
        for (const [k, v] of Object.entries(found)) {
          if (!(register as any)[k]) regData[k] = v;
        }
      }
      const accSheet = wb.SheetNames.find(sn => /accounting|учет|учёт/i.test(sn));
      if (accSheet) {
        const aoa = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[accSheet], { header: 1, blankrows: false, defval: '' }) as any[][];
        const hist: any[] = [];
        for (const r of aoa) {
          const rev = String(r[0] ?? '').trim();
          if (!/^[A-Z]$|^\d{1,2}$/.test(rev)) continue;
          const d = parseDateCell(r[1]);
          hist.push({ rev, date: d ? d.toISOString() : '', description: cellStr(r[2]) });
        }
        if (hist.length) {
          regData.revisions = JSON.stringify(hist);
          regData.revision = hist[hist.length - 1].rev;
        }
      }
      await prisma.docRegister.update({ where: { id: register.id }, data: regData });

      res.json({ register: { id: register.id, name: register.name }, created, updated, skipped, sheet: best.sheet, columns: mergedCols.length });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Экспорт ВДР в Excel (формат заказчика: Titular + Accounting + Register) ──
  app.post('/api/vdr/registers/:id/export', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const register = await prisma.docRegister.findUnique({ where: { id: req.params.id } });
      if (!register) return res.status(404).json({ error: 'Реестр не найден' });
      const std = await standardOfRegister(register);
      const items = await prisma.docRegisterItem.findMany({
        where: { registerId: register.id }, orderBy: [{ vdrCode: 'asc' }, { contractorNo: 'asc' }],
      });
      const cols = parseJson(register.columnsConfig, []);
      const history = parseJson(register.revisions, []);

      const wb = XLSX.utils.book_new();
      const fmtD = (d: any) => { const x = d ? new Date(d) : null; return x && !isNaN(x.getTime()) ? `${String(x.getDate()).padStart(2, '0')}.${String(x.getMonth() + 1).padStart(2, '0')}.${x.getFullYear()}` : ''; };

      // 1. Titular sheet — реквизиты
      const tit: any[][] = [
        ['CONTRACTOR / ПОДРЯДЧИК:', register.contractor, '', 'OWNER / ЗАКАЗЧИК:', register.owner],
        ['CONTRACTOR PROJECT No.:', register.contractorProjectNo, '', 'OWNER PROJECT No.:', register.ownerProjectNo],
        ['VENDOR / ПОСТАВЩИК:', register.vendor, '', 'PURCHASE ORDER No.:', register.poNumber],
        ['MATERIAL REQUISITION No.:', register.materialRequisition, '', 'EQUIPMENT TITLE:', register.equipmentTitle],
        ['CONTRACTOR DOCUMENT No.:', register.contractorDocNo],
        ['OWNER DOCUMENT No.:', register.ownerDocNo],
        ['VENDOR DOCUMENT No.:', register.vendorDocNo],
        [],
        ['TITLE OF DOCUMENT:', register.name],
        [],
        ['Rev./Рев.', 'Date/Дата', 'Reason for Issue/Причина выпуска', 'Prepared/Подготовил', 'Checked/Проверил', 'Approved/Утвердил'],
        [register.revision, fmtD(new Date()), /^\d+$/.test(register.revision) ? 'Certified Final/ Окончательный' : 'Issued for Review/Для рассмотрения', register.preparedBy, register.checkedBy, register.approvedBy],
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(tit), 'Titular sheet');

      // 2. Accounting for revisions
      const acc: any[][] = [
        ['Record of Revisions / Учет ревизий'], [],
        ['Rev. / Ред. №', 'Date / Дата', 'Description of change / Описание изменения'],
        ...history.map((h: any) => [h.rev, fmtD(h.date), h.description || '']),
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(acc), 'Accounting for revisions');

      // 3. Vendor Document Register: колонки по columnsConfig (исходный порядок)
      const useCols = cols.length ? cols : [
        { key: 'contractorNo', title: 'CONTRACTOR Document number', titleRu: 'Номер документа Поставщика', field: 'contractorNo' },
        { key: 'titleEn', title: 'English Document Title', titleRu: 'Название (англ)', field: 'titleEn' },
        { key: 'titleRu', title: 'Russian Document Title', titleRu: 'Название (рус)', field: 'titleRu' },
        { key: 'vdrCode', title: 'Doc. Type (VDR code)', titleRu: 'Тип док-та', field: 'vdrCode' },
        { key: 'revision', title: 'Revision', titleRu: 'Ревизия', field: 'revision' },
        { key: 'issueDate', title: 'Date', titleRu: 'Дата', field: 'issueDate' },
        { key: 'reasonForIssue', title: 'Reason for Issue', titleRu: 'Причина выпуска', field: 'reasonForIssue' },
      ];
      const valueOf = (it: any, col: any): string => {
        if (col.field === 'issueDate') return fmtD(it.issueDate);
        if (col.field === 'equipmentTags') return parseJson(it.equipmentTags, []).join('; ');
        if (col.field === 'vendor') return register.vendor;
        if (col.field === 'poNumber') return register.poNumber;
        if (col.field) return String(it[col.field] ?? '');
        const extra = parseJson(it.extra, {});
        return String(extra[col.key] ?? '');
      };
      const reg: any[][] = [
        useCols.map((c: any) => c.title || c.titleRu || c.key),
        useCols.map((c: any) => c.titleRu || ''),
        ...items.map((it: any) => useCols.map((c: any) => valueOf(it, c))),
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(reg), 'Vendor Document Register');

      // Имя файла по маске стандарта: {docNo}_{rev}_{lang}
      const mask = std.fileNameMask || '{docNo}_{rev}_{lang}';
      const fileName = (mask
        .replace('{docNo}', register.contractorDocNo || register.name.replace(/[^\wА-Яа-я.-]+/g, '_'))
        .replace('{rev}', register.revision || 'A')
        .replace('{lang}', 'ER') + '.xlsx').replace(/[\\/:*?"<>|]/g, '_');

      const buf: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

      // Настоящий файл во Flux вместо скачивания в браузер: ложится в «Выгрузки»
      // того, кто нажал «Выгрузить», и сразу открывается в Flux Office
      const me = authUserOf(req);
      if (!me) return res.status(401).json({ error: 'Не авторизован' });
      const home = await exportsHome(me.id, register.projectId);
      const file = await createFileFromBytes({
        name: fileName, body: buf, home, userId: me.id, chunkBytes: await deps.chunkBytes(),
      });
      res.json({ id: file.id, name: file.name });
    } catch (err: any) { sendError(res, err); }
  });
}
