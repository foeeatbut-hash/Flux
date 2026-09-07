import 'express-async-errors';
import express, { Request, Response } from 'express';
import path from 'path';
import { PrismaClient } from '@prisma/client-sqlite';
import { parseExcel, parseXML, importParsedDataToDB } from './server/excelParser.js';
import { parseEquipmentExcel, parseEquipmentXML } from './server/equipmentParser.js';
import * as XLSX from 'xlsx';
import { importEquipmentToDB } from './server/equipmentImport.js';
import { planEquipmentImport, applyEdits, filterBySelection } from './server/equipmentPlan.js';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import fs from 'fs';
import { exec, execSync } from 'child_process';
import os from 'os';
import crypto from 'crypto';
import { setPrisma, setNotifier, setBroadcaster, upsertSetting } from './server/context.js';
import { setDialect, dialectOf, ensureTables as ensureDbTables } from './server/ddl.js';
import { setupPresence, readAppVersion } from './server/presence.js';
import { registerUpdateRoutes } from './server/updates.js';
import { registerLimitRoutes } from './server/limits.js';
import { registerActionLog } from './server/actionLog.js';
import { setupDocRooms } from './server/collab.js';
import { ensureRemoteSchema } from './server/schema-sync.js';
import { computeMachineId, licenseStatus, activateLicense } from './electron/license.js';
import { registerNoteRoutes } from './server/routes/notes.js';
import { registerConstructorRoutes } from './server/routes/constructor.js';
import { registerFormulaRoutes } from './server/routes/formulas.js';
import { registerVdrRoutes } from './server/routes/vdr.js';
import { registerLogRoutes } from './server/routes/logs.js';
import { registerSettingsRoutes } from './server/routes/settings.js';
import { registerImportDictRoutes } from './server/routes/importDict.js';
import { registerEquipmentDraftRoutes, cleanTagLinks } from './server/routes/equipmentDraft.js';
import { registerExplorerRoutes } from './server/routes/explorer.js';
import { registerDesktopRoutes } from './server/routes/desktop.js';
import { registerPdfMarkupRoutes } from './server/routes/pdfMarkups.js';
import { registerMailRoutes } from './server/routes/mail.js';
import { registerMailSharedRoutes } from './server/routes/mailShared.js';
import { registerMailComposeRoutes } from './server/routes/mailCompose.js';
import { registerMailLinkRoutes } from './server/routes/mailLink.js';
import { watchAll as watchAllMail, stopAll as stopMailWatch } from './server/mail/idle.js';
import { registerInsightRoutes } from './server/routes/insight.js';
import { registerAssistantRoutes } from './server/routes/assistant.js';
import { registerTranslateRoutes } from './server/routes/translate.js';
import { registerCalendarRoutes } from './server/routes/calendar.js';
import { registerMemberRoutes, canSeeProject } from './server/routes/members.js';
import { registerEquipmentUndoRoutes } from './server/routes/equipmentUndo.js';
import { registerUserRoutes, seedRoles, backfillNameParts } from './server/routes/users.js';
import { initBackups } from './server/backup.js';
import { assertHealthySqlite, snapshotSqlite } from './server/sqliteSafety.js';
import { allowsLocalSetup, requiresAdministrator } from './server/accessPolicy.js';

// ── Пароли: хеширование (scrypt) с обратной совместимостью ────────────────────
// Формат хранения: "scrypt$<saltHex>$<hashHex>". Любое другое значение считается
// legacy-паролем в открытом виде — он проверяется как есть и перехешируется при
// первом успешном входе (см. /api/login), поэтому существующие учётки не ломаются.
const PW_PREFIX = 'scrypt$';

function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, 64);
  return `${PW_PREFIX}${salt.toString('hex')}$${hash.toString('hex')}`;
}

function isLegacyPassword(stored: string | null | undefined): boolean {
  return !!stored && !stored.startsWith(PW_PREFIX);
}

function verifyPassword(plain: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  if (stored.startsWith(PW_PREFIX)) {
    const [, saltHex, hashHex] = stored.split('$');
    if (!saltHex || !hashHex) return false;
    try {
      const salt = Buffer.from(saltHex, 'hex');
      const expected = Buffer.from(hashHex, 'hex');
      const actual = crypto.scryptSync(String(plain), salt, expected.length);
      return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }
  // legacy: пароль хранится открытым текстом
  return stored === String(plain);
}

// Разбор даты и ФИО переехал в server/routes/users.ts вместе с профилями

function getVentAppDataPath(): string {
  try {
    // Определяем, запущен ли сервер в продакшене/упакованной версии или в Electron
    const isElectronEnv = 
      !!(process as any).resourcesPath || 
      process.env.ELECTRON === 'true' || 
      process.env.NODE_ENV === 'production' ||
      __dirname.includes('app.asar');
    
    if (isElectronEnv) {
      const baseDir = process.env.APPDATA || 
        (process.platform === 'darwin' 
          ? path.join(os.homedir(), 'Library', 'Application Support') 
          : path.join(os.homedir(), '.config'));
      
      const targetDir = path.join(baseDir, 'pdm-app');
      // Принудительно создаем папку, если ее нет
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      return targetDir;
    } else {
      // В режиме разработки используем локальную папку проекта для удобства тестирования
      const devDir = path.join(process.cwd(), 'database');
      if (!fs.existsSync(devDir)) {
        fs.mkdirSync(devDir, { recursive: true });
      }
      return devDir;
    }
  } catch (err) {
    const fallbackDir = path.join(process.cwd(), 'database');
    try {
      if (!fs.existsSync(fallbackDir)) {
        fs.mkdirSync(fallbackDir, { recursive: true });
      }
    } catch (e) {}
    return fallbackDir;
  }
}

const ventAppDataPath = getVentAppDataPath();
const logFilePath = path.join(ventAppDataPath, 'backend-init.log');

function logInit(message: string) {
  const timestamp = new Date().toISOString();
  const msg = `[${timestamp}] ${message}\n`;
  console.log(message);
  try {
    fs.appendFileSync(logFilePath, msg, 'utf-8');
  } catch (err) {
    console.error('Failed to write to local log file:', err);
  }
}

// 1. Создаем изолированную функцию логирования старта бэкенда и пишем все чихи
logInit('«[1] Логирование запущено»');
logInit(`«[2] NODE_ENV = ${process.env.NODE_ENV}, platform = ${process.platform}, isPackaged = ${__dirname.includes('app.asar') || !!(process as any).resourcesPath}»`);

const dbPath = path.join(ventAppDataPath, 'database.sqlite');
logInit(`«[3] Путь к БД определен как ${dbPath}»`);

// Ensure the directory exists and write log point 4
try {
  if (!fs.existsSync(ventAppDataPath)) {
    fs.mkdirSync(ventAppDataPath, { recursive: true });
    logInit(`«[4] Директория проверена/создана: ${ventAppDataPath} (успешно создана с нуля)»`);
  } else {
    logInit(`«[4] Директория проверена/создана: ${ventAppDataPath} (уже существовала)»`);
  }
} catch (err: any) {
  logInit(`[Error] «Ошибка при проверке/создании директории ${ventAppDataPath}: ${err.message}»`);
}

// Keep userDataPath referencing ventAppDataPath for general safety and log/chat_files locations
let userDataPath = ventAppDataPath;

const CONFIG_FILE = path.join(ventAppDataPath, 'config.json');

function ensureSQLiteDatabaseExists(targetPath: string): boolean {
  try {
    if (fs.existsSync(targetPath)) {
      logInit(`[SQLite Copy] Target database file already exists at: ${targetPath}. Skipping template copying.`);
      return true; // Already exists
    }

    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    // Try to load the database template from extraResources/packaged folders or project folders
    const possibleTemplatePaths = [
      // Packaged app path (relative to packaged directory or resource path)
      path.join((process as any).resourcesPath || '', 'prisma', 'prisma', 'database.sqlite'),
      path.join((process as any).resourcesPath || '', 'prisma', 'database.sqlite'),
      // Development path
      path.join(__dirname, 'prisma', 'prisma', 'database.sqlite'),
      path.join(__dirname, 'prisma', 'database.sqlite'),
      path.join(__dirname, '../prisma', 'prisma', 'database.sqlite'),
      path.join(__dirname, '../prisma', 'database.sqlite'),
      path.join(__dirname, '..', 'prisma', 'prisma', 'database.sqlite'),
      path.join(process.cwd(), 'prisma', 'prisma', 'database.sqlite'),
      path.join(process.cwd(), 'prisma', 'database.sqlite')
    ];

    logInit(`[SQLite Copy] Looking for database template...`);
    for (const templatePath of possibleTemplatePaths) {
      logInit(` - Checking possible template path: ${templatePath}`);
      if (fs.existsSync(templatePath)) {
        logInit(`[SQLite Copy] Found template DB at ${templatePath}. Copying template DB to ${targetPath}`);
        fs.copyFileSync(templatePath, targetPath);
        logInit(`[SQLite Copy] Done cloning database.sqlite template.`);
        return true;
      }
    }

    // Fallback: Create empty file if absolutely nothing can be loaded, though printing a warning
    logInit('[SQLite Copy Warning] SQLite template database not found. Creating empty sqlite file fallback.');
    fs.writeFileSync(targetPath, '', 'utf-8');
    return false;
  } catch (err: any) {
    logInit(`[SQLite Copy Error] Exception copying SQLite database template: ${err.message}\nStack: ${err.stack}`);
    return false;
  }
}

// Prisma 7: рантайм-клиент больше не читает DATABASE_URL из окружения,
// подключение задается только через driver adapter.
function buildSqliteAdapter(dbUrl: string) {
  const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
  // better-sqlite3 не понимает query-параметры в URL (?connection_limit=...) — отрезаем их
  const cleanUrl = dbUrl.split('?')[0];
  return new PrismaBetterSqlite3({ url: cleanUrl, timeout: 15000 });
}

// Существующий файл никогда не заменяется шаблоном при ошибке чтения.
function ensureHealthyLocalDb(dbPath: string) {
  if (!fs.existsSync(dbPath) && !ensureSQLiteDatabaseExists(dbPath)) {
    throw new Error('Не удалось создать локальную базу из шаблона. Проверьте установку программы.');
  }
  assertHealthySqlite(dbPath);
  logInit('[DB Health] Проверка целостности локальной базы пройдена успешно.');
  ensureSchemaColumns(dbPath);
}

// Догоняющая миграция для существующих баз: добавляем недостающие колонки,
// появившиеся в новых версиях приложения (db push в продакшене не выполняется)
function ensureSchemaColumns(dbPath: string) {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    try {
      // Новая таблица раздела «Конструктор» (документы-таблицы из данных проекта)
      db.exec(`CREATE TABLE IF NOT EXISTS "ConstructorDoc" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "projectId" TEXT NOT NULL,
        "name" TEXT NOT NULL DEFAULT 'Без названия',
        "kind" TEXT NOT NULL DEFAULT 'DOC',
        "scope" TEXT NOT NULL DEFAULT 'SHARED',
        "ownerId" TEXT,
        "named" BOOLEAN NOT NULL DEFAULT false,
        "description" TEXT NOT NULL DEFAULT '',
        "workbook" TEXT NOT NULL DEFAULT '',
        "bindings" TEXT NOT NULL DEFAULT '[]',
        "settings" TEXT NOT NULL DEFAULT '{}',
        "createdById" TEXT,
        "updatedById" TEXT,
        "deletedAt" DATETIME,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "ConstructorDoc_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS "ConstructorDoc_projectId_kind_idx" ON "ConstructorDoc"("projectId", "kind")');

      // Версии документов Конструктора (автоснимки + ручные)
      db.exec(`CREATE TABLE IF NOT EXISTS "ConstructorDocVersion" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "docId" TEXT NOT NULL,
        "version" INTEGER NOT NULL,
        "workbook" TEXT NOT NULL DEFAULT '',
        "bindings" TEXT NOT NULL DEFAULT '[]',
        "comment" TEXT NOT NULL DEFAULT '',
        "authorId" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "ConstructorDocVersion_docId_fkey" FOREIGN KEY ("docId") REFERENCES "ConstructorDoc" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS "ConstructorDocVersion_docId_version_idx" ON "ConstructorDocVersion"("docId", "version")');

      // ВДР: реестр документации поставщика (docs/vdr-docflow-design.md §1)
      db.exec(`CREATE TABLE IF NOT EXISTS "DocRegister" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "projectId" TEXT NOT NULL,
        "name" TEXT NOT NULL DEFAULT 'ВДР',
        "vendor" TEXT NOT NULL DEFAULT '',
        "contractor" TEXT NOT NULL DEFAULT '',
        "owner" TEXT NOT NULL DEFAULT '',
        "poNumber" TEXT NOT NULL DEFAULT '',
        "managerId" TEXT,
        "createdById" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS "DocRegister_projectId_idx" ON "DocRegister"("projectId")');
      db.exec(`CREATE TABLE IF NOT EXISTS "DocRegisterItem" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "registerId" TEXT NOT NULL,
        "projectId" TEXT NOT NULL,
        "contractorNo" TEXT NOT NULL DEFAULT '',
        "ownerNo" TEXT NOT NULL DEFAULT '',
        "vendorNo" TEXT NOT NULL DEFAULT '',
        "titleEn" TEXT NOT NULL DEFAULT '',
        "titleRu" TEXT NOT NULL DEFAULT '',
        "vdrCode" TEXT NOT NULL DEFAULT '',
        "revision" TEXT NOT NULL DEFAULT 'A',
        "issueDate" DATETIME,
        "reasonForIssue" TEXT NOT NULL DEFAULT '',
        "language" TEXT NOT NULL DEFAULT '',
        "equipmentTags" TEXT NOT NULL DEFAULT '[]',
        "status" TEXT NOT NULL DEFAULT 'DRAFT',
        "docId" TEXT,
        "fileNodeId" TEXT,
        "assigneeId" TEXT,
        "remarks" TEXT NOT NULL DEFAULT '',
        "meta" TEXT NOT NULL DEFAULT '{}',
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "DocRegisterItem_registerId_fkey" FOREIGN KEY ("registerId") REFERENCES "DocRegister" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS "DocRegisterItem_registerId_idx" ON "DocRegisterItem"("registerId")');
      db.exec('CREATE INDEX IF NOT EXISTS "DocRegisterItem_projectId_status_idx" ON "DocRegisterItem"("projectId", "status")');

      // Стандарты документооборота (глобальные шаблоны) + история ревизий строк ВДР
      db.exec(`CREATE TABLE IF NOT EXISTS "DocStandard" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL DEFAULT 'Стандарт',
        "config" TEXT NOT NULL DEFAULT '{}',
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS "DocRegisterItemRevision" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "itemId" TEXT NOT NULL,
        "revision" TEXT NOT NULL,
        "date" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "reason" TEXT NOT NULL DEFAULT '',
        "place" TEXT NOT NULL DEFAULT '',
        "description" TEXT NOT NULL DEFAULT '',
        "authorId" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS "DocRegisterItemRevision_itemId_idx" ON "DocRegisterItemRevision"("itemId")');

      // Перевод: глоссарий, память переводов, связь русской и английской версий
      db.exec(`CREATE TABLE IF NOT EXISTS "TermEntry" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "projectId" TEXT,
        "ru" TEXT NOT NULL DEFAULT '',
        "en" TEXT NOT NULL DEFAULT '',
        "zh" TEXT NOT NULL DEFAULT '',
        "note" TEXT NOT NULL DEFAULT '',
        "source" TEXT NOT NULL DEFAULT 'hand',
        "locked" BOOLEAN NOT NULL DEFAULT false,
        "authorId" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS "TermEntry_projectId_idx" ON "TermEntry"("projectId")');
      db.exec(`CREATE TABLE IF NOT EXISTS "TmUnit" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "projectId" TEXT,
        "fromLang" TEXT NOT NULL DEFAULT 'ru',
        "toLang" TEXT NOT NULL DEFAULT 'en',
        "srcKey" TEXT NOT NULL DEFAULT '',
        "src" TEXT NOT NULL DEFAULT '',
        "dst" TEXT NOT NULL DEFAULT '',
        "origin" TEXT NOT NULL DEFAULT 'hand',
        "docId" TEXT,
        "authorId" TEXT,
        "usedCount" INTEGER NOT NULL DEFAULT 0,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS "CalEvent" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "projectId" TEXT,
        "kind" TEXT NOT NULL DEFAULT 'meeting',
        "title" TEXT NOT NULL DEFAULT '',
        "description" TEXT NOT NULL DEFAULT '',
        "startsAt" DATETIME NOT NULL,
        "endsAt" DATETIME NOT NULL,
        "allDay" BOOLEAN NOT NULL DEFAULT false,
        "rrule" TEXT NOT NULL DEFAULT '',
        "place" TEXT NOT NULL DEFAULT '',
        "joinUrl" TEXT NOT NULL DEFAULT '',
        "createdBy" TEXT NOT NULL DEFAULT '',
        "source" TEXT NOT NULL DEFAULT 'hand',
        "sourceId" TEXT NOT NULL DEFAULT '',
        "visibility" TEXT NOT NULL DEFAULT 'project',
        "remindMin" INTEGER NOT NULL DEFAULT 0,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS "CalEvent_project_start_idx" ON "CalEvent"("projectId", "startsAt")');
      db.exec('CREATE INDEX IF NOT EXISTS "CalEvent_createdBy_idx" ON "CalEvent"("createdBy")');
      db.exec(`CREATE TABLE IF NOT EXISTS "CalGuest" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "eventId" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "state" TEXT NOT NULL DEFAULT 'invited',
        CONSTRAINT "CalGuest_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "CalEvent"("id") ON DELETE CASCADE
      )`);
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS "CalGuest_event_user_key" ON "CalGuest"("eventId", "userId")');
      db.exec('CREATE INDEX IF NOT EXISTS "CalGuest_userId_idx" ON "CalGuest"("userId")');
      db.exec(`CREATE TABLE IF NOT EXISTS "ProjectMember" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "projectId" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "addedBy" TEXT NOT NULL DEFAULT '',
        "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS "ProjectMember_project_user_key" ON "ProjectMember"("projectId", "userId")');
      db.exec('CREATE INDEX IF NOT EXISTS "ProjectMember_userId_idx" ON "ProjectMember"("userId")');
      db.exec('CREATE TABLE IF NOT EXISTS "AssistantChat" ("id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "projectId" TEXT NOT NULL DEFAULT \'\', "title" TEXT NOT NULL DEFAULT \'\', "preview" TEXT NOT NULL DEFAULT \'\', "messages" TEXT NOT NULL DEFAULT \'[]\', "search" TEXT NOT NULL DEFAULT \'\', "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
      db.exec('CREATE INDEX IF NOT EXISTS "AssistantChat_owner_project_idx" ON "AssistantChat"("ownerId", "projectId")');
      // Присутствие: одна строка на человека, «в сети» — свежая отметка
      db.exec('CREATE TABLE IF NOT EXISTS "Presence" ("userId" TEXT NOT NULL PRIMARY KEY, "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
      db.exec('CREATE INDEX IF NOT EXISTS "Presence_at_idx" ON "Presence"("at")');
      // Файл обновления кусками: у сотрудников общая только база
      db.exec('CREATE TABLE IF NOT EXISTS "AppUpdateChunk" ("id" TEXT NOT NULL PRIMARY KEY, "version" TEXT NOT NULL DEFAULT \'\', "idx" INTEGER NOT NULL DEFAULT 0, "data" BLOB NOT NULL)');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS "AppUpdateChunk_version_idx_key" ON "AppUpdateChunk"("version", "idx")');
      db.exec('CREATE INDEX IF NOT EXISTS "TmUnit_lang_key_idx" ON "TmUnit"("fromLang", "toLang", "srcKey")');
      db.exec('CREATE INDEX IF NOT EXISTS "TmUnit_projectId_idx" ON "TmUnit"("projectId")');
      db.exec(`CREATE TABLE IF NOT EXISTS "TransLink" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "projectId" TEXT NOT NULL,
        "sourceDocId" TEXT NOT NULL,
        "targetDocId" TEXT NOT NULL DEFAULT '',
        "mode" TEXT NOT NULL DEFAULT 'file',
        "fingerprint" TEXT NOT NULL DEFAULT '',
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS "TransLink_sourceDocId_idx" ON "TransLink"("sourceDocId")');
      // Новые колонки существующих таблиц ВДР (для баз, созданных ранней версией)
      const regCols = db.prepare('PRAGMA table_info("DocRegister")').all() as Array<{ name: string }>;
      const regAdd: Array<[string, string]> = [
        ['standardId', 'TEXT'], ['ownerProjectNo', "TEXT NOT NULL DEFAULT ''"], ['contractorProjectNo', "TEXT NOT NULL DEFAULT ''"],
        ['materialRequisition', "TEXT NOT NULL DEFAULT ''"], ['equipmentTitle', "TEXT NOT NULL DEFAULT ''"],
        ['contractorDocNo', "TEXT NOT NULL DEFAULT ''"], ['ownerDocNo', "TEXT NOT NULL DEFAULT ''"], ['vendorDocNo', "TEXT NOT NULL DEFAULT ''"],
        ['revision', "TEXT NOT NULL DEFAULT 'A'"], ['revisions', "TEXT NOT NULL DEFAULT '[]'"],
        ['preparedBy', "TEXT NOT NULL DEFAULT ''"], ['checkedBy', "TEXT NOT NULL DEFAULT ''"], ['approvedBy', "TEXT NOT NULL DEFAULT ''"],
        ['columnsConfig', "TEXT NOT NULL DEFAULT '[]'"],
      ];
      for (const [col, type] of regAdd) {
        if (regCols.length > 0 && !regCols.find(c => c.name === col)) db.exec(`ALTER TABLE "DocRegister" ADD COLUMN "${col}" ${type}`);
      }
      const itCols = db.prepare('PRAGMA table_info("DocRegisterItem")').all() as Array<{ name: string }>;
      const itAdd: Array<[string, string]> = [
        ['reviewCode', "TEXT NOT NULL DEFAULT ''"], ['dueDate', 'DATETIME'], ['extra', "TEXT NOT NULL DEFAULT '{}'"],
      ];
      for (const [col, type] of itAdd) {
        if (itCols.length > 0 && !itCols.find(c => c.name === col)) db.exec(`ALTER TABLE "DocRegisterItem" ADD COLUMN "${col}" ${type}`);
      }

      const tagCols = db.prepare('PRAGMA table_info("Tag")').all() as Array<{ name: string }>;
      if (tagCols.length > 0 && !tagCols.find(c => c.name === 'updatedAt')) {
        db.exec('ALTER TABLE "Tag" ADD COLUMN "updatedAt" DATETIME');
        logInit('[DB Migrate] Добавлена колонка Tag.updatedAt');
      }

      // Зеркала документов Конструктора в Проводнике
      const sysFolderCols = db.prepare('PRAGMA table_info("Folder")').all() as Array<{ name: string }>;
      if (sysFolderCols.length > 0 && !sysFolderCols.find(c => c.name === 'system')) {
        db.exec('ALTER TABLE "Folder" ADD COLUMN "system" BOOLEAN NOT NULL DEFAULT false');
        logInit('[DB Migrate] Добавлена колонка Folder.system');
      }
      const fileNodeCols = db.prepare('PRAGMA table_info("FileNode")').all() as Array<{ name: string }>;
      if (fileNodeCols.length > 0 && !fileNodeCols.find(c => c.name === 'refId')) {
        db.exec('ALTER TABLE "FileNode" ADD COLUMN "refId" TEXT');
        logInit('[DB Migrate] Добавлена колонка FileNode.refId');
      }

      const cols = db.prepare('PRAGMA table_info("User")').all() as Array<{ name: string }>;
      if (cols.length > 0) {
        if (!cols.find(c => c.name === 'isActive')) {
          db.exec('ALTER TABLE "User" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true');
          logInit('[DB Migrate] Добавлена колонка User.isActive');
        }
        if (!cols.find(c => c.name === 'validUntil')) {
          db.exec('ALTER TABLE "User" ADD COLUMN "validUntil" DATETIME');
          logInit('[DB Migrate] Добавлена колонка User.validUntil');
        }
        if (!cols.find(c => c.name === 'permissions')) {
          db.exec('ALTER TABLE "User" ADD COLUMN "permissions" TEXT');
          logInit('[DB Migrate] Добавлена колонка User.permissions');
        }
        if (!cols.find(c => c.name === 'hideOnline')) {
          db.exec('ALTER TABLE "User" ADD COLUMN "hideOnline" BOOLEAN NOT NULL DEFAULT false');
          logInit('[DB Migrate] Добавлена колонка User.hideOnline');
        }
        if (!cols.find(c => c.name === 'lastLoginAt')) {
          db.exec('ALTER TABLE "User" ADD COLUMN "lastLoginAt" DATETIME');
          logInit('[DB Migrate] Добавлена колонка User.lastLoginAt');
        }
      }
      const msgCols = db.prepare('PRAGMA table_info("ChatMessage")').all() as Array<{ name: string }>;
      if (msgCols.length > 0) {
        if (!msgCols.find(c => c.name === 'replyToId')) {
          db.exec('ALTER TABLE "ChatMessage" ADD COLUMN "replyToId" TEXT');
          logInit('[DB Migrate] Добавлена колонка ChatMessage.replyToId');
        }
        if (!msgCols.find(c => c.name === 'editedAt')) {
          db.exec('ALTER TABLE "ChatMessage" ADD COLUMN "editedAt" DATETIME');
          logInit('[DB Migrate] Добавлена колонка ChatMessage.editedAt');
        }
        if (!msgCols.find(c => c.name === 'reactions')) {
          db.exec('ALTER TABLE "ChatMessage" ADD COLUMN "reactions" TEXT');
          logInit('[DB Migrate] Добавлена колонка ChatMessage.reactions');
        }
        if (!msgCols.find(c => c.name === 'pinned')) {
          db.exec('ALTER TABLE "ChatMessage" ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false');
          logInit('[DB Migrate] Добавлена колонка ChatMessage.pinned');
        }
        if (!msgCols.find(c => c.name === 'forwardedFrom')) {
          db.exec('ALTER TABLE "ChatMessage" ADD COLUMN "forwardedFrom" TEXT');
          logInit('[DB Migrate] Добавлена колонка ChatMessage.forwardedFrom');
        }
      }
      const grpCols = db.prepare('PRAGMA table_info("ChatGroup")').all() as Array<{ name: string }>;
      if (grpCols.length > 0) {
        if (!grpCols.find(c => c.name === 'description')) {
          db.exec('ALTER TABLE "ChatGroup" ADD COLUMN "description" TEXT NOT NULL DEFAULT \'\'');
          logInit('[DB Migrate] Добавлена колонка ChatGroup.description');
        }
        if (!grpCols.find(c => c.name === 'color')) {
          db.exec('ALTER TABLE "ChatGroup" ADD COLUMN "color" TEXT NOT NULL DEFAULT \'indigo\'');
          logInit('[DB Migrate] Добавлена колонка ChatGroup.color');
        }
        if (!grpCols.find(c => c.name === 'ownerId')) {
          db.exec('ALTER TABLE "ChatGroup" ADD COLUMN "ownerId" TEXT');
          logInit('[DB Migrate] Добавлена колонка ChatGroup.ownerId');
        }
      }
      const ceCols = db.prepare('PRAGMA table_info("ComponentElement")').all() as Array<{ name: string }>;
      if (ceCols.length > 0) {
        if (!ceCols.find(c => c.name === 'equipType')) {
          db.exec('ALTER TABLE "ComponentElement" ADD COLUMN "equipType" TEXT NOT NULL DEFAULT \'ПРОЧЕЕ\'');
          logInit('[DB Migrate] Добавлена колонка ComponentElement.equipType');
        }
        if (!ceCols.find(c => c.name === 'overrides')) {
          db.exec('ALTER TABLE "ComponentElement" ADD COLUMN "overrides" TEXT');
          logInit('[DB Migrate] Добавлена колонка ComponentElement.overrides');
        }
        if (!ceCols.find(c => c.name === 'paramConflicts')) {
          db.exec('ALTER TABLE "ComponentElement" ADD COLUMN "paramConflicts" TEXT');
          logInit('[DB Migrate] Добавлена колонка ComponentElement.paramConflicts');
        }
      }
      // Таблица настроек (профили видимости, режим конфликтов, категории)
      db.exec('CREATE TABLE IF NOT EXISTS "AppSetting" ("id" TEXT PRIMARY KEY NOT NULL, "key" TEXT NOT NULL, "userId" TEXT, "value" TEXT NOT NULL, "updatedAt" DATETIME NOT NULL DEFAULT current_timestamp)');
      try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS "AppSetting_key_userId_key" ON "AppSetting"("key", "userId")'); } catch (e) {}
      // Новые поля проекта (код/заказчик/подрядчик)
      const projCols = db.prepare('PRAGMA table_info("Project")').all() as Array<{ name: string }>;
      if (projCols.length > 0) {
        for (const col of ['code', 'customer', 'contractor']) {
          if (!projCols.find(c => c.name === col)) {
            db.exec(`ALTER TABLE "Project" ADD COLUMN "${col}" TEXT NOT NULL DEFAULT ''`);
            logInit(`[DB Migrate] Добавлена колонка Project.${col}`);
          }
        }
      }
      // Таблица опубликованных обновлений приложения (раздача через сервер)
      db.exec('CREATE TABLE IF NOT EXISTS "AppUpdate" ("id" TEXT PRIMARY KEY NOT NULL, "version" TEXT NOT NULL, "changelog" TEXT NOT NULL DEFAULT \'\', "fileUrl" TEXT NOT NULL DEFAULT \'\', "createdAt" DATETIME NOT NULL DEFAULT current_timestamp)');
      try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS "AppUpdate_version_key" ON "AppUpdate"("version")'); } catch (e) {}
      // Таблица личных уведомлений
      db.exec('CREATE TABLE IF NOT EXISTS "Notification" ("id" TEXT PRIMARY KEY NOT NULL, "userId" TEXT NOT NULL, "category" TEXT NOT NULL DEFAULT \'СИСТЕМА\', "title" TEXT NOT NULL, "body" TEXT NOT NULL DEFAULT \'\', "targetRoute" TEXT NOT NULL DEFAULT \'\', "isRead" BOOLEAN NOT NULL DEFAULT false, "createdAt" DATETIME NOT NULL DEFAULT current_timestamp)');
      try { db.exec('CREATE INDEX IF NOT EXISTS "Notification_userId_isRead_idx" ON "Notification"("userId", "isRead")'); } catch (e) {}
      // Разделы проводника «Общий/Личный»: область видимости папок и файлов
      const folderCols = db.prepare('PRAGMA table_info("Folder")').all() as Array<{ name: string }>;
      if (folderCols.length > 0) {
        if (!folderCols.find(c => c.name === 'scope')) {
          db.exec('ALTER TABLE "Folder" ADD COLUMN "scope" TEXT NOT NULL DEFAULT \'SHARED\'');
          logInit('[DB Migrate] Добавлена колонка Folder.scope');
        }
        if (!folderCols.find(c => c.name === 'ownerId')) {
          db.exec('ALTER TABLE "Folder" ADD COLUMN "ownerId" TEXT');
          logInit('[DB Migrate] Добавлена колонка Folder.ownerId');
        }
      }
      const fileCols = db.prepare('PRAGMA table_info("FileNode")').all() as Array<{ name: string }>;
      if (fileCols.length > 0) {
        if (!fileCols.find(c => c.name === 'scope')) {
          db.exec('ALTER TABLE "FileNode" ADD COLUMN "scope" TEXT NOT NULL DEFAULT \'SHARED\'');
          logInit('[DB Migrate] Добавлена колонка FileNode.scope');
        }
        if (!fileCols.find(c => c.name === 'ownerId')) {
          db.exec('ALTER TABLE "FileNode" ADD COLUMN "ownerId" TEXT');
          logInit('[DB Migrate] Добавлена колонка FileNode.ownerId');
        }
      }
    } finally {
      db.close();
    }
  } catch (err: any) {
    logInit(`[DB Migrate Warning] Не удалось проверить/добавить колонки: ${err.message}`);
  }
}

// Совместный режим поддерживает два сервера БД, выбор — по схеме адреса:
//   postgresql://… (или postgres://…) → PostgreSQL, mysql://… (или mariadb://…) → MariaDB
function isMariaDbUrl(dbUrl: string): boolean {
  return /^(mysql|mariadb):\/\//i.test(String(dbUrl || '').trim());
}

// Находит файл схемы Prisma для активного движка общей базы (для автомиграции).
// В упакованном приложении папка prisma лежит в resources (extraResources).
function findRemoteSchemaFile(dialect: 'postgresql' | 'mysql' | 'sqlite'): string {
  const file = dialect === 'mysql' ? 'schema.mariadb.prisma'
    : dialect === 'sqlite' ? 'schema.prisma'
    : 'schema.postgresql.prisma';
  const candidates = [
    path.join(process.cwd(), 'prisma', file),
    path.join(__dirname, 'prisma', file),
    path.join(__dirname, '..', 'prisma', file),
    path.join((process as any).resourcesPath || '', 'prisma', file),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return '';
}

// Приводит базу к схеме программы. Безопасно (только добавляет недостающее).
// Возвращает список выполненных изменений (пусто = база уже актуальна).
// Работает и для общей базы (PostgreSQL/MariaDB), и для локальной SQLite:
// база пользователя, созданная старой версией, догоняет схему сама.
async function syncRemoteSchema(client: any, dbUrl: string, forceDialect?: 'sqlite'): Promise<string[]> {
  try {
    const dialect: 'postgresql' | 'mysql' | 'sqlite' = forceDialect
      ? forceDialect
      : isMariaDbUrl(dbUrl) ? 'mysql' : 'postgresql';
    const schemaFile = findRemoteSchemaFile(dialect);
    if (!schemaFile) {
      logInit('[Schema Sync] Файл схемы не найден — автомиграция общей базы пропущена.');
      return [];
    }
    const schemaText = fs.readFileSync(schemaFile, 'utf-8');
    return await ensureRemoteSchema(client, dialect, schemaText, logInit);
  } catch (err: any) {
    logInit(`[Schema Sync] Автомиграция общей базы не выполнена: ${err.message}`);
    return [];
  }
}

function createPrismaClient(dbType: string, dbUrl: string) {
  // Движок базы запоминается здесь, а не угадывается на месте: маршруты,
  // создающие недостающие таблицы, пишут SQL под конкретный движок
  // (server/ddl.ts), и «почти правильный» SQL там бесполезен
  setDialect(dialectOf(dbType, dbUrl));
  try {
    if (dbType === 'REMOTE') {
      if (isMariaDbUrl(dbUrl)) {
        const { PrismaClient: MariaPrisma } = require('@prisma/client-mysql');
        const { PrismaMariaDb } = require('@prisma/adapter-mariadb');
        const normalized = dbUrl.replace(/^mariadb:\/\//i, 'mysql://');
        return new MariaPrisma({ adapter: new PrismaMariaDb(normalized) });
      }
      const { PrismaClient: RemotePrisma } = require('@prisma/client-pg');
      const { PrismaPg } = require('@prisma/adapter-pg');
      return new RemotePrisma({ adapter: new PrismaPg({ connectionString: dbUrl }) });
    } else {
      const { PrismaClient: LocalPrisma } = require('@prisma/client-sqlite');
      return new LocalPrisma({ adapter: buildSqliteAdapter(dbUrl) });
    }
  } catch (err: any) {
    logInit(`[Prisma Client Builder Exception] Error creating client for ${dbType}: ${err.message}\nStack: ${err.stack}`);
    const { PrismaClient: LocalPrisma } = require('@prisma/client-sqlite');
    const fallbackUrl = `file:${path.join(ventAppDataPath, 'database.sqlite')}`;
    return new LocalPrisma({ adapter: buildSqliteAdapter(fallbackUrl) });
  }
}

interface AppConfig {
  current_db_type: 'LOCAL' | 'REMOTE' | string;
  database_url: string;
  local_db_path?: string;  // Пользовательский путь к файлу SQLite (пусто = стандартный в AppData)
  crash_log_dir?: string;  // Папка для аварийных crash-логов (пусто = AppData/pdm-app/logs)
}

function loadAppConfig(): AppConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed.current_db_type === 'string') {
        return {
          current_db_type: parsed.current_db_type,
          database_url: parsed.database_url || '',
          local_db_path: parsed.local_db_path || '',
          crash_log_dir: parsed.crash_log_dir || ''
        };
      }
    }
  } catch (err: any) {
    logInit(`[AppConfig Error] Warning reading config.json: ${err.message}`);
  }

  const defaultConfig: AppConfig = {
    current_db_type: 'LOCAL',
    database_url: '',
    local_db_path: '',
    crash_log_dir: ''
  };
  saveAppConfig(defaultConfig);
  return defaultConfig;
}

// Возвращает фактический путь к локальной базе: пользовательский или стандартный в AppData
function resolveLocalDbPath(config: AppConfig): string {
  const custom = String(config.local_db_path || '').trim();
  if (custom) {
    return path.resolve(custom);
  }
  return path.join(ventAppDataPath, 'database.sqlite');
}

function saveAppConfig(config: AppConfig) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err: any) {
    logInit(`[AppConfig Error] Exception writing config.json: ${err.message}`);
  }
}

// Backward compatibility with other endpoints expecting loadDbConfig()
interface DbConfig {
  databasePath: string;
  isConfigured: boolean;
}

function loadDbConfig(): DbConfig {
  const config = loadAppConfig();
  const dbFile = path.join(ventAppDataPath, 'database.sqlite');
  return {
    databasePath: dbFile,
    isConfigured: true
  };
}

function saveDbConfig(config: DbConfig) {
  // Save into app config
  const current = loadAppConfig();
  current.current_db_type = 'LOCAL';
  saveAppConfig(current);
}

const appConfig = loadAppConfig();
let startupDbUrl = '';

if (appConfig.current_db_type === 'LOCAL') {
  const dbPath = resolveLocalDbPath(appConfig);
  logInit(`[Startup DB] Активный путь локальной базы: ${dbPath}${appConfig.local_db_path ? ' (пользовательский)' : ' (стандартный)'}`);

  // 1. Проверяем, существует ли папка базы, и создаем ее перед PrismaClient
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  startupDbUrl = `file:${dbPath}?connection_limit=1&busy_timeout=15000`;

  // При ошибке проверки останавливаем запуск, сохраняя исходные данные
  ensureHealthyLocalDb(dbPath);
} else {
  startupDbUrl = appConfig.database_url;
}

// 2. Принудительно переписываем DATABASE_URL
process.env.DATABASE_URL = startupDbUrl;
logInit(`[Startup DB] Выбран тип базы: ${appConfig.current_db_type}`);

// 3. Автоматическое развертывание таблиц (prisma db push) из кода - ИСКЛЮЧИТЕЛЬНО В РАЗРАБОТКЕ
if (appConfig.current_db_type === 'LOCAL') {
  const isProduction = 
    process.env.NODE_ENV === 'production' || 
    __dirname.includes('app.asar') || 
    !!(process as any).resourcesPath;

  if (!isProduction) {
    try {
      logInit('[Startup DB Schema Sync] Development environment detected. Running programmatic schema sync (prisma db push)...');
      
      // Находим schema.prisma в разных возможных местах
      const possibleSchemaPaths = [
        path.join(process.cwd(), 'prisma', 'schema.prisma'),
        path.join(__dirname, 'prisma', 'schema.prisma'),
        path.join(__dirname, '..', 'prisma', 'schema.prisma'),
        path.join((process as any).resourcesPath || '', 'prisma', 'schema.prisma'),
      ];
      
      let schemaPath = '';
      for (const p of possibleSchemaPaths) {
        if (fs.existsSync(p)) {
          schemaPath = p;
          break;
        }
      }
      
      if (schemaPath) {
        logInit(`[Startup DB Schema Sync] Schema found. Running npx prisma db push --schema="${schemaPath}"...`);
        const execOptions = {
          env: {
            ...process.env,
            DATABASE_URL: startupDbUrl
          }
        };
        execSync(`npx prisma db push --schema="${schemaPath}" --accept-data-loss`, execOptions);
        logInit('[Startup DB Schema Sync] SQLite database structure has been successfully pushed and updated.');
      } else {
        logInit('[Startup DB Schema Sync Warning] Prisma schema.prisma path not found. Skipping schema push.');
      }
    } catch (pushErr: any) {
      logInit(`[Startup DB Schema Sync Exception] Failed during npx prisma db push: ${pushErr.message}\nStack: ${pushErr.stack}`);
    }
  } else {
    logInit('[Startup DB Schema Sync] Production mode / Packaged app detected. Skipping executing shell command "npx prisma db push" to avoid starting slow/crashing shells.');
  }
}

// 4. Оборачиваем инициализацию PrismaClient в try/catch с подробным логированием
let prisma: any = null;
let isPrismaAvailable = false;

try {
  logInit(`[Prisma Client Init] Creating PrismaClient instance for mode: ${appConfig.current_db_type}`);
  prisma = createPrismaClient(appConfig.current_db_type, startupDbUrl);
  setPrisma(prisma);
  isPrismaAvailable = true;
  logInit(`[Prisma Client Init] PrismaClient instance constructed successfully.`);
} catch (initErr: any) {
  logInit(`[Prisma Client Init Exception] Critical error constructing PrismaClient: ${initErr.message}\nStack: ${initErr.stack}`);
  try {
    const errorLogPath = path.join(ventAppDataPath, 'database-critical-init-error.log');
    fs.appendFileSync(
      errorLogPath,
      `[${new Date().toISOString()}] CRITICAL CLIENT CONSTRUCTION ERROR:\n${initErr.message || initErr}\nStack:\n${initErr.stack}\n`,
      'utf-8'
    );
  } catch (fsErr) {}
  
  try {
    logInit('[Prisma Client Init Recovery] Attempting to construct fallback Local PrismaClient...');
    prisma = createPrismaClient('LOCAL', `file:${path.join(ventAppDataPath, 'database.sqlite')}`);
    setPrisma(prisma);
    isPrismaAvailable = true;
    logInit('[Prisma Client Init Recovery] Fallback PrismaClient constructed.');
  } catch (fallbackErr: any) {
    logInit(`[Prisma Client Init Recovery Exception] Failed to construct fallback PrismaClient: ${fallbackErr.message}\nStack: ${fallbackErr.stack}`);
    prisma = null;
    setPrisma(prisma);
    isPrismaAvailable = false;
  }
}

// Auto-seed user and structure if database is empty - securely wrapped to avoid startup crashes
(async () => {
  if (!prisma || !isPrismaAvailable) {
    logInit('[Startup DB Feed Skip] Prisma is not constructed; skipping auto-seed check.');
    return;
  }
  try {
    logInit('[Startup DB Connection Check] Executing test connection with $connect()...');
    await prisma.$connect();
    logInit('[Startup DB Connection Check] Successful connection established.');

    if (appConfig.current_db_type === 'LOCAL') {
      try {
        logInit('[Startup DB Config] Optimizing dynamic SQLite engine WAL journaling mode...');
        await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL;');
        await prisma.$queryRawUnsafe('PRAGMA synchronous=NORMAL;');
        logInit('[Startup DB Config] Local pragmas configured successfully.');
      } catch (pragmaErr: any) {
        logInit(`[Startup DB Config Warning] Skipping SQLite tuning pragmas: ${pragmaErr.message}`);
      }
    }
    
    // До первых запросов приводим схему базы к версии программы.
    // Локальную проверяем тоже: база, созданная прежней версией (или из
    // устаревшего шаблона), иначе падала на первом же запросе с
    // «столбца не существует».
    if (appConfig.current_db_type === 'REMOTE') {
      logInit('[Schema Sync] Проверка схемы общей базы при старте...');
      await syncRemoteSchema(prisma, startupDbUrl);
    } else {
      logInit('[Schema Sync] Проверка схемы локальной базы при старте...');
      const applied = await syncRemoteSchema(prisma, startupDbUrl, 'sqlite');
      if (applied.length) logInit(`[Schema Sync] Локальная база дополнена: ${applied.join('; ')}`);
    }

    logInit('[Startup DB Feed Check] Verifying records in User table...');
    const userCount = await prisma.user.count();
    logInit(`[Startup DB Feed Check] Found ${userCount} users registered.`);
    if (userCount === 0) {
      logInit('[Startup DB Feed] Seeding default administrator account...');
      await prisma.user.create({
        data: {
          name: 'Главный администратор (RaupovKhKh)',
          symbol: 'RaupovKhKh',
          password: hashPassword('1122'),
          role: 'ADMIN',
        }
      });
      await prisma.project.create({
        data: {
          name: 'Технологический проект Альфа'
        }
      });
      await prisma.equipment.create({
        data: {
          type: 'AHU',
          description: 'Air Handling Unit',
        }
      });
      logInit('[Startup DB Feed] Initial schema seeding finished.');
    }
  } catch (err: any) {
    logInit(`[Startup DB Seed Exception] Verifying / Seeding skipped or threw exception: ${err.message}\nStack: ${err.stack}`);
  }
})();

// ── Авторизация API: подписанные токены сессии ─────────────────────────────
// Без токена API доступно любому в сети — для сервера компании это недопустимо.
// Токен выдаётся при входе (POST /api/login), подписывается секретом сервера
// (HMAC-SHA256) и проверяется на каждом запросе. Секрет генерируется при первом
// запуске и хранится в папке данных — токены переживают перезапуск сервера,
// таблиц в БД не требуется.
const AUTH_SECRET_FILE = path.join(userDataPath, 'auth-secret');
let authSecret = '';
try {
  if (fs.existsSync(AUTH_SECRET_FILE)) authSecret = fs.readFileSync(AUTH_SECRET_FILE, 'utf-8').trim();
  if (!authSecret) {
    authSecret = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(AUTH_SECRET_FILE, authSecret, 'utf-8');
  }
} catch (e) {
  // Файл недоступен (readonly-диск): секрет на время процесса — токены
  // перестанут действовать после перезапуска, но авторизация работает
  authSecret = crypto.randomBytes(48).toString('hex');
}

const AUTH_TOKEN_TTL_MS = 30 * 24 * 3600 * 1000; // 30 дней
// Старые сессии могли быть выданы мастер-входом: после обновления нужен обычный вход.
const AUTH_TOKEN_VERSION = 2;

// Своя версия — из package.json, который едет вместе со сборкой
const APP_VERSION: string = readAppVersion(__dirname);

const signAuthPayload = (payload: string) =>
  crypto.createHmac('sha256', authSecret).update(payload).digest('base64url');

const issueAuthToken = (userId: string) => {
  const payload = Buffer.from(JSON.stringify({ v: AUTH_TOKEN_VERSION, uid: userId, exp: Date.now() + AUTH_TOKEN_TTL_MS })).toString('base64url');
  return `${payload}.${signAuthPayload(payload)}`;
};

const verifyAuthToken = (token: string): string | null => {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const [payload, sig] = parts;
    if (!payload || !sig) return null;
    const expected = signAuthPayload(payload);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    if (data?.v !== AUTH_TOKEN_VERSION || !data.uid || typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    return String(data.uid);
  } catch (e) {
    return null;
  }
};

// Кэш пользователей на 30 с — проверка токена не ходит в БД на каждый запрос,
// но отключение профиля администратором срабатывает в течение полуминуты
const authUserCache = new Map<string, { user: any; at: number }>();
/** Сброс кэша сессии: снятое право должно действовать сразу, а не через полминуты. */
function invalidateAuthUser(userId?: string) {
  if (userId) authUserCache.delete(userId); else authUserCache.clear();
}
const getAuthUser = async (userId: string) => {
  const hit = authUserCache.get(userId);
  if (hit && Date.now() - hit.at < 30000) return hit.user;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  authUserCache.set(userId, { user, at: Date.now() });
  return user;
};

const app = express();
const PORT = 3000;

const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "DELETE"]
  }
});

// Socket.io пускает только вошедших: клиент передаёт токен в handshake.auth —
// иначе любой в сети слушал бы трансляцию сообщений чата
io.use((socket, next) => {
  const userId = verifyAuthToken(String((socket.handshake as any)?.auth?.token || ''));
  if (!userId) return next(new Error('unauthorized'));
  (socket as any).userId = userId;
  next();
});

// ── Кто сейчас в сети ────────────────────────────────────────────────────────
// Один сотрудник — несколько вкладок и окон, поэтому считаем сокеты, а не
// людей: закрытая вкладка не должна гасить человека, у которого открыто ещё
// три. «Не в сети» объявляется, когда ушёл последний его сокет.
//
// Правило одно для всех: администратор виден так же, как остальные. Скрытое
// присутствие начальника — это не приватность, а неравенство, из-за которого
// в чате пишут в пустоту, не понимая, дошло ли.
const online = new Map<string, Set<string>>();
const lastSeen = new Map<string, number>();

const rosterOnline = () => Array.from(online.keys());

// Присутствие живёт в общей базе (server/presence.ts): в отделе база одна, а
// сервер у каждого свой — в памяти оно означало бы «все не в сети»
/**
 * Кто скрыл своё присутствие.
 *
 * Список кэшируется: он спрашивается на каждом ударе сердца у каждого
 * сотрудника, а меняется, когда администратор трогает переключатель — то есть
 * почти никогда. Перечитывает его refreshHiddenOnline().
 */
let hiddenOnline: Set<string> = new Set();
export async function refreshHiddenOnline(): Promise<void> {
  try {
    const rows = await prisma.user.findMany({ where: { hideOnline: true }, select: { id: true } });
    hiddenOnline = new Set(rows.map((r: any) => String(r.id)));
  } catch (_) {
    // Колонки может не быть — база старее программы. Скрывать некого
    hiddenOnline = new Set();
  }
}

const { markPresence, markGone, rosterFromDb, isHidden } = setupPresence({
  getPrisma: () => prisma,
  localOnline: rosterOnline,
  localSeen: () => Object.fromEntries(lastSeen),
  broadcast: (roster) => io.emit('presence:list', roster),
  hiddenIds: () => hiddenOnline,
  broadcastTo: (userId, roster) => io.to(`user:${userId}`).emit('presence:list', roster),
});

io.on('connection', (socket) => {
  console.log(`[Socket] client connected: ${socket.id}`);

  // Личная комната сокета. Без неё сообщения чата рассылались всем
  // подключённым: интерфейс чужую переписку прятал, но текст всё равно
  // приходил на каждую машину в сети
  const uid = (socket as any).userId;
  if (uid) socket.join(`user:${uid}`);

  if (uid) {
    const was = online.get(uid);
    if (was) was.add(socket.id);
    else {
      online.set(uid, new Set([socket.id]));
      // Появился — сказать всем. Себе тоже: своя точка «в сети» подтверждает,
      // что связь есть, и отличает «никто не отвечает» от «я отключён».
      // Скрывшему себя — только себе: остальным он не появлялся
      if (isHidden(uid)) socket.emit('presence:online', { userId: uid });
      else io.emit('presence:online', { userId: uid });
    }
  }

  // Пришедшему — весь список сразу: без него человек до первого чужого входа
  // видел бы всех офлайн. Список считается от его лица: себя скрывший видит
  const sendRoster = async () => socket.emit('presence:list', await rosterFromDb(uid || ''));
  void (async () => { if (uid) await markPresence(uid); await sendRoster(); })();
  socket.on('presence:list', () => { void sendRoster(); });

  socket.on('tag:linked', (data) => {
    socket.broadcast.emit('tag:linked', data);
  });

  socket.on('tag:updated', (data) => {
    socket.broadcast.emit('tag:updated', data);
  });

  socket.on('equipment:conflict', (data) => {
    socket.broadcast.emit('equipment:conflict', data);
  });

  // Комната документа: присутствие, выделения, операции движка (server/collab.ts)
  const docRooms = setupDocRooms(io, socket, async (id) => (await getAuthUser(id))?.name || '');

  socket.on('disconnect', () => {
    console.log(`[Socket] client disconnected: ${socket.id}`);
    docRooms.leaveAll();
    if (uid) {
      const set = online.get(uid);
      set?.delete(socket.id);
      if (set && set.size === 0) {
        online.delete(uid);
        const at = Date.now();
        lastSeen.set(uid, at);
        // И в общей базе тоже: иначе на чужих машинах он останется «в сети»
        // до конца срока свежести отметки
        void markGone(uid);
        // Скрытый и так числился ушедшим — событие о его уходе никому не нужно
        if (!isHidden(uid)) io.emit('presence:offline', { userId: uid, at });
      }
    }
  });
});

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/chat_files', express.static(path.join(userDataPath, 'chat_files')));
// Картинки подписей: показываются в разделе; в отправленном письме они
// уходят вложением с Content-ID, потому что снаружи этот адрес недоступен
app.use('/mail_sig', express.static(path.join(userDataPath, 'mail_sig')));

// ── Проверка входа на каждом запросе к API ──────────────────────────────────
// Открыты только вход, проверка готовности и конфиг БД для экрана входа.
// Настройка БД (/api/db/*) до входа разрешена только с самой машины сервера —
// это функция встроенного режима, по сети её дергать нельзя.
// ── Права по функциям ────────────────────────────────────────────────────────
// Право приходит от роли (общее для должности) и лично (надбавка или запрет);
// личное сильнее. Каталог функций живёт в src/lib/permissions.ts — здесь
// только сопоставление «маршрут → функция». Проверяем одной таблицей, а не в
// каждом обработчике: иначе новый эндпоинт легко забыть закрыть, и выданное
// право окажется украшением.
type PermRule = { method: RegExp; path: RegExp; perm: string; title: string };
const PERM_ROUTES: PermRule[] = [
  { method: /^(POST|PUT|DELETE|PATCH)$/, path: /^\/api\/projects\/?$|^\/api\/projects\/[^/]+$/,
    perm: 'project.manage', title: 'Управление проектами' },
  { method: /^(POST|PUT|PATCH)$/, path: /^\/api\/projects\/[^/]+\/tags/,
    perm: 'tags.manage', title: 'Создание и правка тегов' },
  { method: /^(PUT|PATCH)$/, path: /^\/api\/tags\//, perm: 'tags.manage', title: 'Создание и правка тегов' },
  { method: /^DELETE$/, path: /^\/api\/tags\//, perm: 'tags.delete', title: 'Удаление тегов' },
  { method: /^(POST|PUT|DELETE|PATCH)$/, path: /^\/api\/dictionaries|^\/api\/projects\/[^/]+\/(dictionaries|tag-template)/,
    perm: 'dictionaries.manage', title: 'Справочники и шаблоны' },
  { method: /^POST$/, path: /^\/api\/(equipment\/import|import\/)/,
    perm: 'equipment.import', title: 'Импорт из бланков' },
  { method: /^(PUT|PATCH)$/, path: /^\/api\/(components|equipment|monoblocks|systems)\//,
    perm: 'equipment.manage', title: 'Правка характеристик оборудования' },
  { method: /^POST$/, path: /^\/api\/(files|folders)/, perm: 'files.upload', title: 'Загрузка файлов' },
  { method: /^DELETE$/, path: /^\/api\/(files|folders)/, perm: 'files.delete', title: 'Удаление файлов и папок' },
  { method: /^(POST|PUT|DELETE)$/, path: /^\/api\/settings\/(procurement_stages|stage_templates)/,
    perm: 'procurement.setup', title: 'Настройка этапов закупки' },
  { method: /^(POST|PUT|DELETE|PATCH)$/, path: /^\/api\/vdr\/standards/,
    perm: 'vdr.standards', title: 'Стандарты документооборота' },
  { method: /^(POST|PUT|DELETE|PATCH)$/, path: /^\/api\/vdr\//,
    perm: 'vdr.manage', title: 'Реестр ВДР' },
];

const rolePermCache = new Map<string, { perms: any; at: number }>();
async function rolePermissionsOf(code: string): Promise<Record<string, any>> {
  const hit = rolePermCache.get(code);
  if (hit && Date.now() - hit.at < 30000) return hit.perms;
  let perms: Record<string, any> = {};
  try {
    const role = await prisma.role.findUnique({ where: { code } });
    if (role?.permissions) perms = JSON.parse(role.permissions) || {};
  } catch (_) { perms = {}; }
  rolePermCache.set(code, { perms, at: Date.now() });
  return perms;
}
function invalidateRolePerms() { rolePermCache.clear(); }

async function effectivePermsOf(user: any): Promise<Record<string, any>> {
  let personal: Record<string, any> = {};
  try { personal = user.permissions ? JSON.parse(user.permissions) || {} : {}; } catch (_) {}
  const fromRole = await rolePermissionsOf(String(user.role || ''));
  return { ...fromRole, ...personal };   // личное сильнее роли
}

function permAllows(perms: Record<string, any>, feature: string): boolean {
  const e = perms[feature] || (feature === 'project.manage' ? perms['project.create'] : null);
  if (!e || !e.enabled) return false;
  if (e.until && new Date(e.until).getTime() < Date.now()) return false;
  return true;
}

const AUTH_EXEMPT = new Set(['/api/health', '/api/login', '/api/license/status', '/api/license/activate']);
app.use(async (req: Request, res: Response, next) => {
  // Express принимает другой регистр и хвостовой слеш: защита должна видеть тот же маршрут.
  const route = req.path.toLowerCase().replace(/\/+$/, '');
  if (!route.startsWith('/api/')) return next();
  if (AUTH_EXEMPT.has(route)) return next();
  if (allowsLocalSetup(route, String(req.socket.remoteAddress || ''), req.get('origin'), req.get('host'))) return next();

  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const userId = verifyAuthToken(token);
  if (!userId) return res.status(401).json({ error: 'Требуется вход в систему' });

  try {
    const user = await getAuthUser(userId);
    if (!user || user.isActive === false) {
      return res.status(401).json({ error: 'Профиль отключен или удалён администратором' });
    }
    if (user.validUntil && new Date(user.validUntil).getTime() < Date.now()) {
      return res.status(401).json({ error: 'Срок действия профиля истек' });
    }

    if (requiresAdministrator(route) && user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Доступно только администратору' });
    }

    // Управление сотрудниками — только администратор; менять самого себя
    // (имя/пароль) может каждый, но не роль/права/срок
    const isUserRoute = /^\/api\/users\/[^/]+$/.test(route);
    if (user.role !== 'ADMIN') {
      if ((route === '/api/users' && req.method === 'POST') ||
          (isUserRoute && req.method === 'DELETE')) {
        return res.status(403).json({ error: 'Доступно только администратору' });
      }
      if (isUserRoute && req.method === 'PUT') {
        const targetId = req.path.replace(/\/+$/, '').split('/').pop();
        if (targetId !== user.id) {
          return res.status(403).json({ error: 'Доступно только администратору' });
        }
        // Своё имя, пол и день рождения человек правит сам; роль, права и
        // срок действия — нет, иначе доступ можно было бы выдать себе.
        req.body = {
          name: req.body?.name, password: req.body?.password,
          lastName: req.body?.lastName, firstName: req.body?.firstName,
          middleName: req.body?.middleName, gender: req.body?.gender,
          birthDate: req.body?.birthDate,
        };
      }
    }

    // Права по функциям: одна таблица маршрутов на всю программу.
    if (user.role !== 'ADMIN') {
      const rule = PERM_ROUTES.find(r => r.method.test(req.method) && r.path.test(route));
      if (rule) {
        const perms = await effectivePermsOf(user);
        if (!permAllows(perms, rule.perm)) {
          return res.status(403).json({
            error: `Недостаточно прав: «${rule.title}». Обратитесь к администратору.`,
            feature: rule.perm,
          });
        }
      }
    }

    (req as any).authUser = user;
    return next();
  } catch (e: any) {
    return res.status(500).json({ error: 'Не удалось проверить сессию', details: e?.message });
  }
});

// Готовность сервера: порт начинает слушать только после инициализации БД,
// так что успешный ответ = приложение полностью готово (для стартовой заставки)
// Готовность сервера и его версия: сервер компании обновляют отдельно, и
// программа должна сама заметить, что он старее её (см. server/presence.ts)
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), version: APP_VERSION });
});

// ── Лицензия ──
// Резервный путь для рендерера, когда IPC Electron недоступен (dev/браузер,
// локальный режим). В упакованном приложении основной путь — IPC главного
// процесса (он считает отпечаток именно клиентской машины). Здесь папка
// пользователя = папка встроенного сервера (на машине клиента в локальном режиме).
app.get('/api/license/status', (_req: Request, res: Response) => {
  try {
    res.json(licenseStatus(ventAppDataPath));
  } catch (e: any) {
    res.status(500).json({ error: e.message, machineId: (() => { try { return computeMachineId(); } catch { return ''; } })() });
  }
});

app.post('/api/license/activate', (req: Request, res: Response) => {
  try {
    const code = String(req.body?.code || '');
    if (!code) return res.status(400).json({ error: 'Код не указан' });
    res.json(activateLicense(ventAppDataPath, code));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Ручная проверка/обновление структуры базы (только администратор). Проходит
// обычную авторизацию (путь НЕ /api/db/, поэтому loopback-исключение не действует).
app.post('/api/admin/sync-schema', async (req: Request, res: Response) => {
  const user = (req as any).authUser;
  if (!user || user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Доступно только администратору' });
  }
  try {
    const cfg = loadAppConfig();
    if (cfg.current_db_type === 'REMOTE') {
      const applied = await syncRemoteSchema(prisma, cfg.database_url || process.env.DATABASE_URL || '');
      return res.json({
        mode: 'REMOTE',
        applied,
        message: applied.length
          ? `Структура обновлена: ${applied.join(', ')}`
          : 'Структура общей базы уже соответствует программе — изменений нет.',
      });
    }
    // Локальная база догоняет схему при каждом запуске; повторяем догон колонок
    try { ensureSchemaColumns(resolveLocalDbPath(cfg)); } catch (_) {}
    return res.json({
      mode: 'LOCAL',
      applied: [],
      message: 'Локальная база синхронизируется автоматически при каждом запуске.',
    });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

// Database Routing
app.get('/api/db/config', (req: Request, res: Response) => {
  const config = loadAppConfig();
  const dbPath = resolveLocalDbPath(config);
  res.json({
    current_db_type: config.current_db_type,
    database_url: config.database_url,
    databasePath: dbPath,
    isConfigured: true,
    displayPath: config.current_db_type === 'LOCAL' ? dbPath : config.database_url,
    defaultPath: path.join(ventAppDataPath, 'database.sqlite'),
    local_db_path: config.local_db_path || '',
    crash_log_dir: config.crash_log_dir || ''
  });
});

// Настройка папки для аварийных crash-логов
app.post('/api/config/logs', (req: Request, res: Response) => {
  const { crash_log_dir } = req.body;
  const current = loadAppConfig();
  if (typeof crash_log_dir === 'string') {
    current.crash_log_dir = crash_log_dir.trim();
  }
  saveAppConfig(current);
  res.json({ success: true, crash_log_dir: current.crash_log_dir || '' });
});

app.get('/api/db/download', async (req: Request, res: Response) => {
  const config = loadAppConfig();
  if (config.current_db_type !== 'LOCAL') return res.status(400).json({ error: 'Файловая копия доступна только для локальной базы' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-db-download-'));
  const snapshot = path.join(dir, 'database.sqlite');
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} };
  try {
    await snapshotSqlite(resolveLocalDbPath(config), snapshot);
    res.download(snapshot, 'database.sqlite', (error) => {
      cleanup();
      if (error && !res.headersSent) res.status(500).json({ error: 'Не удалось передать копию базы' });
    });
  } catch (_) {
    cleanup();
    res.status(500).json({ error: 'Не удалось создать проверенную копию базы. Исходная база сохранена.' });
  }
});

app.post('/api/db/test', async (req: Request, res: Response) => {
  const { current_db_type, database_url } = req.body;
  if (current_db_type === 'LOCAL') {
    return res.json({
      success: true,
      exists: fs.existsSync(resolveLocalDbPath(loadAppConfig())),
      message: 'Локальная база данных SQLite активна и готова к работе!'
    });
  }

  if (!database_url) {
    return res.status(400).json({ success: false, message: 'Строка подключения remote_url не указана!' });
  }

  // Test custom remote URL using a temporary client
  try {
    const tempPrisma = createPrismaClient('REMOTE', database_url);
    await tempPrisma.$queryRawUnsafe('SELECT 1;');
    await tempPrisma.$disconnect();

    res.json({
      success: true,
      exists: true,
      message: 'Удаленное подключение успешно проверено и доступно!'
    });
  } catch (err: any) {
    res.json({
      success: false,
      message: `Не удалось подключиться по указанному адресу: ${err.message}`
    });
  }
});

app.post('/api/db/switch', async (req: Request, res: Response) => {
  const { current_db_type, database_url, database_path } = req.body;
  
  const logMsg = `[${new Date().toISOString()}] POST /api/db/switch: type="${current_db_type}"\n`;
  console.log('[DB Switch Request]', logMsg.trim());
  try {
    fs.appendFileSync(path.join(ventAppDataPath, 'database-switch.log'), logMsg, 'utf-8');
  } catch (e) {}

  if (!current_db_type) {
    return res.status(400).json({ success: false, message: 'Тип базы данных не указан!' });
  }

  const oldPrisma = prisma;
  try {
    const existingConfig = loadAppConfig();
    // database_path: undefined = оставить текущий путь, '' = вернуть стандартный, иначе — новый путь
    let nextLocalPath = existingConfig.local_db_path || '';
    if (typeof database_path === 'string') {
      nextLocalPath = database_path.trim();
    }

    let targetDbUrl = '';
    if (current_db_type === 'LOCAL') {
      const dbFile = nextLocalPath ? path.resolve(nextLocalPath) : path.join(ventAppDataPath, 'database.sqlite');
      const parentDir = path.dirname(dbFile);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      targetDbUrl = `file:${dbFile}?connection_limit=1&busy_timeout=15000`;
      ensureHealthyLocalDb(dbFile);
    } else {
      if (!database_url) {
        return res.status(400).json({ success: false, message: 'Ссылка подключения REMOTE обязательна!' });
      }
      targetDbUrl = database_url;
    }

    // Disconnect old client cleanly
    try {
      if (oldPrisma) {
        await oldPrisma.$disconnect();
      }
    } catch (discErr: any) {
      console.warn('[DB Switch] Notice during client disconnect:', discErr.message);
    }

    process.env.DATABASE_URL = targetDbUrl;
    prisma = createPrismaClient(current_db_type, targetDbUrl);
    setPrisma(prisma);
    // База другая — ящики в ней тоже другие: старые наблюдения гасим, новые
    // поднимем после того, как схема встанет
    stopMailWatch();

    if (current_db_type === 'LOCAL') {
      try {
        await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL;');
        await prisma.$queryRawUnsafe('PRAGMA synchronous=NORMAL;');
      } catch (pragmaErr: any) {
        console.warn('[DB Switch] Failed setting local performance PRAGMAs:', pragmaErr.message);
      }
    }

    // Try a test query
    await prisma.$queryRawUnsafe('SELECT 1;');

    // Общая база: приводим схему к версии программы (создаёт недостающие
    // таблицы/колонки) до автозаполнения и первых запросов
    if (current_db_type === 'REMOTE') {
      await syncRemoteSchema(prisma, targetDbUrl);
    }

    // Save configuration settings
    saveAppConfig({
      ...existingConfig,
      current_db_type,
      database_url: database_url || '',
      local_db_path: nextLocalPath
    });

    // Auto-seed if newly switched DB has no users
    let seedMessage = '';
    const userCount = await prisma.user.count();
    if (userCount === 0) {
      await prisma.user.create({
        data: {
          name: 'Главный администратор (RaupovKhKh)',
          symbol: 'RaupovKhKh',
          password: hashPassword('1122'),
          role: 'ADMIN',
        }
      });
      await prisma.project.create({
        data: {
          name: 'Технологический проект Альфа'
        }
      });
      await prisma.equipment.create({
        data: {
          type: 'AHU',
          description: 'Air Handling Unit',
        }
      });
      seedMessage = ' База данных успешно инициализирована начальными учетными записями.';
    }

    // Схема на месте — поднимаем слежение за ящиками новой базы
    void watchAllMail();

    return res.json({
      success: true,
      message: `База данных успешно переключена на режим ${current_db_type === 'LOCAL' ? 'Локальный' : 'Совместный / Внешний'}!${seedMessage}`
    });

  } catch (err: any) {
    console.error('[DB Switch] switchover failure:', err);
    // Restore original state
    prisma = oldPrisma;
    setPrisma(prisma);
    return res.status(500).json({
      success: false,
      message: `Не удалось изменить подключение: ${err.message}`
    });
  }
});

// Alias POST /api/db/save to POST /api/db/switch to prevent old parts from erroring
app.post('/api/db/save', async (req: Request, res: Response) => {
  const { databasePath } = req.body;
  if (databasePath) {
    // Treat legacy call as configuring SQLite path in config.json
    try {
      const resolved = path.resolve(databasePath);
      const parentDir = path.dirname(resolved);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      
      const targetDbUrl = `file:${resolved}?connection_limit=1&busy_timeout=15000`;
      ensureHealthyLocalDb(resolved);

      if (prisma) {
        await prisma.$disconnect();
      }

      process.env.DATABASE_URL = targetDbUrl;
      prisma = createPrismaClient('LOCAL', targetDbUrl);
      setPrisma(prisma);

      try {
        await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL;');
        await prisma.$queryRawUnsafe('PRAGMA synchronous=NORMAL;');
      } catch (e) {}

      saveAppConfig({
        ...loadAppConfig(),
        current_db_type: 'LOCAL',
        database_url: '',
        local_db_path: resolved
      });

      return res.json({
        success: true,
        message: 'Локальный путь SQLite базы успешно изменён!'
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, message: err.message });
    }
  }

  // Redirect to standard switch handler
  req.url = '/api/db/switch';
  (app as any).handle(req, res);
});

// ── Надёжное время (анти-обход срока действия профиля переводом часов) ─────────
// Локальные часы легко перевести назад, поэтому срок действия профиля проверяем
// по «надёжному времени»: максимум из локальных часов, монотонного якоря
// (максимальное когда-либо замеченное время, хранится в БД и в скрытом файле)
// и сетевого времени (заголовок Date с надёжных HTTPS-серверов, когда есть сеть).
// Часы назад не переводятся: якорь только растёт.

const TIME_ANCHOR_FILE = path.join(os.homedir(), '.pdm-time-anchor');
let timeAnchorMs = 0;          // максимальное замеченное время
let timeTampered = false;      // зафиксирован откат часов
let lastAnchorPersistMs = 0;   // троттлинг записи якоря

function loadTimeAnchorFromFile(): number {
  try {
    const raw = fs.readFileSync(TIME_ANCHOR_FILE, 'utf-8').trim();
    const v = parseInt(raw, 36); // не бросается в глаза как timestamp
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

async function loadTimeAnchorFromDb(): Promise<number> {
  try {
    const s = await prisma.appSetting.findFirst({ where: { key: 'time_anchor', userId: null } });
    const v = s ? parseInt(String(s.value), 36) : 0;
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

async function persistTimeAnchor(ms: number) {
  try { fs.writeFileSync(TIME_ANCHOR_FILE, ms.toString(36), 'utf-8'); } catch (_) {}
  try { await upsertSetting('time_anchor', null, ms.toString(36)); } catch (_) {}
}

// Синхронная оценка надёжного времени (для быстрых проверок прав)
function trustedNowSync(): number {
  const now = Date.now();
  if (timeAnchorMs === 0) timeAnchorMs = loadTimeAnchorFromFile();
  if (now >= timeAnchorMs) {
    timeAnchorMs = now;
    if (now - lastAnchorPersistMs > 60_000) {
      lastAnchorPersistMs = now;
      persistTimeAnchor(now);
    }
    return now;
  }
  // Часы позади якоря. Небольшая разница (< 6 ч) — допуск на смену пояса,
  // больше — явный перевод часов назад
  if (timeAnchorMs - now > 6 * 3600_000) timeTampered = true;
  return timeAnchorMs;
}

// Сетевое время: заголовок Date от нескольких независимых HTTPS-серверов
function fetchNetworkTimeMs(timeoutMs = 2500): Promise<number | null> {
  const https = require('https');
  const hosts = ['www.google.com', 'ya.ru', 'www.cloudflare.com'];
  const tryHost = (host: string) => new Promise<number | null>((resolve) => {
    try {
      const req = https.request({ host, method: 'HEAD', path: '/', timeout: timeoutMs }, (r: any) => {
        const d = r.headers && r.headers.date ? Date.parse(r.headers.date) : NaN;
        r.resume();
        resolve(Number.isFinite(d) ? d : null);
      });
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
      req.end();
    } catch {
      resolve(null);
    }
  });
  return new Promise((resolve) => {
    let settled = false;
    let pending = hosts.length;
    const done = (v: number | null) => {
      if (v !== null && !settled) { settled = true; resolve(v); }
      else if (--pending === 0 && !settled) resolve(null);
    };
    hosts.forEach(h => tryHost(h).then(done));
    setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, timeoutMs + 500);
  });
}

// Полная проверка (используется при входе): якорь из БД + сетевое время
async function trustedNowFull(): Promise<{ now: number; tampered: boolean; source: string }> {
  const dbAnchor = await loadTimeAnchorFromDb();
  if (dbAnchor > timeAnchorMs) timeAnchorMs = dbAnchor;
  let source = 'local';
  let now = trustedNowSync();

  const netTime = await fetchNetworkTimeMs();
  if (netTime) {
    source = 'network';
    // Сетевое время авторитетно: если локальные часы отстают от него
    // больше чем на 10 минут — часы переведены назад
    if (netTime - Date.now() > 10 * 60_000) timeTampered = true;
    if (netTime > now) now = netTime;
    if (netTime > timeAnchorMs) {
      timeAnchorMs = netTime;
      lastAnchorPersistMs = Date.now();
      await persistTimeAnchor(netTime);
    }
  }
  return { now, tampered: timeTampered, source };
}

// Users
app.post('/api/login', async (req: Request, res: Response) => {
  const { symbol, password } = req.body;

  const normSymbol = String(symbol || '').trim();

  // Попытка авторизации через локальную БД, если БД вообще была создана/готова
  try {
    // Логин не чувствителен к регистру: RaupovKhkh == RaupovKhKh
    let user = await prisma.user.findUnique({
      where: { symbol: normSymbol },
    });
    if (!user) {
      const allUsers = await prisma.user.findMany();
      user = allUsers.find((u: any) => String(u.symbol).toLowerCase() === normSymbol.toLowerCase()) || null;
    }
    if (user) {
      // Проверка пароля: поддерживаются и хешированные, и legacy-пароли в открытом виде
      const isPasswordCorrect = verifyPassword(String(password), user.password);

      if (isPasswordCorrect) {
        // Миграция: старый открытый пароль перехешируем при первом успешном входе
        if (isLegacyPassword(user.password)) {
          try {
            await prisma.user.update({ where: { id: user.id }, data: { password: hashPassword(String(password)) } });
          } catch (migErr) {
            console.warn('[Login] Не удалось перехешировать legacy-пароль:', migErr);
          }
        }
        // Контроль доступа: профиль может быть отключен администратором или просрочен
        if (user.isActive === false) {
          return res.status(403).json({ success: false, message: 'Профиль отключен администратором. Обратитесь к администратору системы.' });
        }
        if (user.validUntil) {
          // Срок проверяем по надёжному времени: якорь + сеть (перевод часов не помогает)
          const { now, tampered } = await trustedNowFull();
          if (tampered && user.role !== 'ADMIN') {
            return res.status(403).json({ success: false, message: 'Обнаружен перевод системных часов назад. Вход для профилей со сроком действия заблокирован — верните корректную дату и время.' });
          }
          if (new Date(user.validUntil).getTime() < now) {
            const dt = new Date(user.validUntil).toLocaleDateString('ru-RU');
            return res.status(403).json({ success: false, message: `Срок действия профиля истек ${dt}. Обратитесь к администратору для продления доступа.` });
          }
        } else {
          // Обновляем якорь времени и для бессрочных входов
          trustedNowSync();
        }
        // Отметка входа. Нужна не для порядка: в разделе «Сотрудники»
        // администратор видит, кто когда заходил, а присутствие помнит людей
        // только неделю — по нему «не заходил с мая» отличить от «не заходил
        // никогда» нельзя
        try {
          await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
        } catch (_) { /* колонки может не быть: база старее программы */ }
        const { password: _pw, ...safeUser } = user as any;
        // Права роли отдаём вместе с профилем: интерфейс должен знать, что
        // человеку можно, не запрашивая это на каждом экране.
        (safeUser as any).rolePermissions = JSON.stringify(await rolePermissionsOf(String(user.role || '')));
        // Токен сессии: клиент шлёт его в Authorization на каждом запросе
        return res.json({ success: true, user: safeUser, token: issueAuthToken(user.id) });
      } else {
        return res.status(401).json({ success: false, message: 'Неверный пароль доступа!' });
      }
    } else {
      return res.status(401).json({ success: false, message: 'Пользователь с таким логином не зарегистрирован в системе!' });
    }
  } catch (dbErr: any) {
    console.warn('[Login Backend] Database is probably not initialized or SQLite is locked:', dbErr.message);
    return res.status(500).json({
      success: false,
      message: 'База данных еще не инициализирована или не подключена. Перезапустите приложение или настройте СУБД в настройках подключения.'
    });
  }
});

// Периодическая проверка действительности профиля во время работы:
// фронтенд опрашивает и принудительно завершает сессию, если доступ отозван
app.get('/api/auth/check', async (req: Request, res: Response) => {
  const userId = String(req.query.userId || '');
  if (!userId) {
    return res.json({ valid: false, reason: 'Не указан идентификатор пользователя.' });
  }
  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.json({ valid: false, reason: 'Профиль не найден в базе данных. Выйдите и войдите заново.' });
    }
    if (user.isActive === false) {
      return res.json({ valid: false, reason: 'Профиль отключен администратором.' });
    }
    if (user.validUntil) {
      const now = trustedNowSync();
      if (timeTampered && user.role !== 'ADMIN') {
        return res.json({ valid: false, reason: 'Обнаружен перевод системных часов назад. Верните корректную дату и время.' });
      }
      if (new Date(user.validUntil).getTime() < now) {
        return res.json({ valid: false, reason: `Срок действия профиля истек ${new Date(user.validUntil).toLocaleDateString('ru-RU')}.` });
      }
    }
    return res.json({ valid: true });
  } catch (err: any) {
    // При временной недоступности БД не выбрасываем пользователя из сессии
    return res.json({ valid: true, degraded: true });
  }
});

// Словари импорта (выученные подписи и условные обозначения) вынесены
// в server/routes/importDict.ts
registerImportDictRoutes(app);

// Сотрудники, роли и личные настройки уведомлений вынесены
// в server/routes/users.ts
registerUserRoutes(app, { hashPassword, invalidateRolePerms, invalidateAuthUser, refreshHiddenOnline });

// For dummy data generation so we can test the app
app.post('/api/seed', async (req: Request, res: Response) => {
  try {
    const admin = await prisma.user.upsert({
      where: { symbol: 'RaupovKhKh' },
      // Повторное заполнение не меняет пароль и права существующей учётной записи.
      update: {},
      create: {
        name: 'Главный администратор (RaupovKhKh)',
        symbol: 'RaupovKhKh',
        password: hashPassword('1122'),
        role: 'ADMIN',
      }
    });

    const existingProject = await prisma.project.findFirst({
      where: { name: { in: ['Проект Альфа', 'Технологический Проект Альфа'] } }
    });
    if (!existingProject) {
      await prisma.project.create({
        data: {
          name: 'Проект Альфа',
        }
      });
    }

    const existingAhu = await prisma.equipment.findFirst({
      where: { type: 'AHU' }
    });
    if (!existingAhu) {
      await prisma.equipment.create({
        data: {
          type: 'AHU',
          description: 'Air Handling Unit',
        }
      });
    }

    res.json({ success: true, user: admin });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Обновления программы: публикация, раздача и отзыв — server/updates.ts.
// Файл едет в общую базу: сервера приложения у сотрудников нет, общая только она
registerUpdateRoutes(app, {
  getPrisma: () => prisma,
  dataDir: ventAppDataPath,
  notifyAll: (category, title, body, route, by) => notifyAll(category, title, body, route, by),
  broadcast: (event, payload) => { try { io.emit(event, payload); } catch (_) {} },
});

// Насколько большой файл примет эта база — server/limits.ts. Окно спрашивает
// заранее, чтобы отказ звучал до переноса, а не после получаса ожидания
registerLimitRoutes(app, () => prisma);

// Журнал действий — server/actionLog.ts. Пишет сервер: запись, которую делает
// окно, обходится закрытием окна. Читается по праву «Журнал действий»
registerActionLog(app, { getPrisma: () => prisma, can: userCan });

// Projects
// ── Права доступа «по функциям» (зеркало src/lib/permissions.ts) ──────────────
function userCan(user: any, feature: string): boolean {
  if (!user) return false;
  if (user.role === 'ADMIN') return true;                       // админ всегда главнее
  if (user.isActive === false) return false;
  // Сроки проверяем по надёжному времени (перевод часов назад не продлевает доступ)
  const now = trustedNowSync();
  if (user.validUntil && (timeTampered || new Date(user.validUntil).getTime() < now)) return false;
  let map: any = {};
  try { map = user.permissions ? JSON.parse(user.permissions) : {}; } catch { map = {}; }
  const e = map[feature];
  if (!e || !e.enabled) return false;
  if (e.until && new Date(e.until).getTime() < now) return false;
  return true;
}

async function loadActor(req: Request): Promise<any> {
  // Кто действует: сначала владелец сессии (запрос уже прошёл проверку токена),
  // и только потом явно переданный actorId — он остался от старых вызовов.
  const fromSession = (req as any).authUser;
  if (fromSession) return fromSession;
  const id = String((req.body && req.body.actorId) || req.query.actorId || req.headers['x-actor-id'] || '');
  if (!id) return null;
  try { return await prisma.user.findUnique({ where: { id } }); } catch { return null; }
}

// Страж эндпоинта: при отсутствии прав сам отправляет 401/403 и возвращает false.
// Права считаются так же, как в общей таблице маршрутов: роль + личные поверх,
// иначе один и тот же сотрудник проходил бы одну проверку и не проходил другую.
/**
 * Есть ли у действующего право — без ответа клиенту.
 * enforce() сам пишет 401/403 и годится только там, где отказ прекращает
 * обработку. Когда право лишь меняет вид ответа («можно ли править общий
 * ящик»), нужен молчаливый вопрос.
 */
async function mayFeature(req: Request, feature: string): Promise<boolean> {
  const actor = await loadActor(req);
  if (!actor) return false;
  if (actor.role === 'ADMIN') return true;
  if (actor.isActive === false) return false;
  if (actor.validUntil && (timeTampered || new Date(actor.validUntil).getTime() < trustedNowSync())) return false;
  return permAllows(await effectivePermsOf(actor), feature);
}

async function enforce(req: Request, res: Response, feature: string): Promise<boolean> {
  const actor = await loadActor(req);
  if (!actor) { res.status(401).json({ error: 'Требуется вход в систему.' }); return false; }
  if (actor.role === 'ADMIN') return true;
  if (actor.isActive === false) { res.status(403).json({ error: 'Профиль отключён администратором.' }); return false; }
  const now = trustedNowSync();
  if (actor.validUntil && (timeTampered || new Date(actor.validUntil).getTime() < now)) {
    res.status(403).json({ error: 'Срок действия профиля истёк.' }); return false;
  }
  const perms = await effectivePermsOf(actor);
  if (!permAllows(perms, feature)) {
    res.status(403).json({ error: 'Недостаточно прав для этого действия.' }); return false;
  }
  return true;
}

app.get('/api/projects', async (req: Request, res: Response) => {
  const projects = await prisma.project.findMany();
  // Человек видит только те проекты, в которые его позвали. Проект, куда ещё
  // никого не звали, виден всем: включать ограничение задним числом на базе,
  // которая о составе не знает, — значит отобрать у отдела всё разом
  const me = (req as any).authUser || null;
  const isAdmin = me?.role === 'ADMIN';
  const mine: any[] = [];
  for (const p of projects) {
    if (await canSeeProject(me?.id || '', p.id, isAdmin)) mine.push(p);
  }
  res.json({ projects: mine });
});

app.post('/api/projects', async (req: Request, res: Response) => {
  if (!(await enforce(req, res, 'project.manage'))) return;
  const { name, code, customer, contractor, description, info } = req.body;
  const project = await prisma.project.create({
    data: {
      // Имя из одних пробелов ничем не лучше пустого: в переключателе проектов
      // такая строка выглядела пустой и выбрать её вслепую было нельзя
      name: String(name ?? '').trim() || 'Без названия',
      code: code || '',
      customer: customer || '',
      contractor: contractor || '',
      description: description || '',
      info: info || '',
      status: 'ACTIVE'
    }
  });
  // Новый проект — событие для всей команды: люди должны узнать о нём
  // из программы, а не из разговора в коридоре.
  await notifyAll('ПРОЕКТЫ', `Новый проект: ${project.name}`,
    project.customer ? `Заказчик: ${project.customer}` : '', '/projects',
    String((req as any).authUser?.id || ''));
  res.json({ project });
});

app.put('/api/projects/:id', async (req: Request, res: Response) => {
  if (!(await enforce(req, res, 'project.manage'))) return;
  try {
    const { id } = req.params;
    const { name, code, customer, contractor, description, info, status } = req.body;
    const data: any = {};
    // Переименовать проект в пробелы — то же, что стереть имя: не даём
    if (name !== undefined) data.name = String(name).trim() || 'Без названия';
    if (code !== undefined) data.code = code;
    if (customer !== undefined) data.customer = customer;
    if (contractor !== undefined) data.contractor = contractor;
    if (description !== undefined) data.description = description;
    if (info !== undefined) data.info = info;
    if (status !== undefined) data.status = status;
    const project = await prisma.project.update({ where: { id }, data });
    res.json({ project });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/projects/:id', async (req: Request, res: Response) => {
  if (!(await enforce(req, res, 'project.manage'))) return;
  try {
    const { id } = req.params;
    const doomed = await prisma.project.findUnique({ where: { id } });
    await prisma.project.delete({
      where: { id }
    });
    if (doomed) {
      await notifyAll('ПРОЕКТЫ', `Проект удалён: ${doomed.name}`,
        'Все его теги, файлы и документы удалены вместе с ним.', '/projects',
        String((req as any).authUser?.id || ''));
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Личные уведомления ───────────────────────────────────────────────────────
async function notify(userId: string, category: string, title: string, body = '', targetRoute = '') {
  try {
    if (!userId) return;
    const row = await prisma.notification.create({ data: { userId, category, title, body, targetRoute } });
    pushNotification(userId, row);
  } catch (err: any) {
    console.warn('[notify] err:', err?.message);
  }
}

/**
 * Толкнуть уведомление тому, кому оно адресовано.
 *
 * Комната `user:<id>` уже есть — в неё сокет входит при подключении. Без этого
 * толчка новое узнавалось только опросом раз в пятнадцать секунд, и на столько
 * же опаздывало всплывающее окно Windows: оно поднимается из окна программы,
 * а окно узнаёт из того же опроса. Отсюда и «сообщения приходят с огромной
 * задержкой».
 *
 * Опрос при этом остаётся — страховкой на случай, когда связи не было в самый
 * миг события.
 */
function pushNotification(userId: string, row: any) {
  try {
    if (!userId || !row) return;
    io.to(`user:${userId}`).emit('notify:new', row);
  } catch (_) { /* сокет мог ещё не подняться — опрос догонит */ }
}
setNotifier(notify); // вынесенные роуты (ВДР и др.) шлют уведомления через контекст
setBroadcaster((event, payload) => { io.emit(event, payload); });

/**
 * Оповестить всех сотрудников, кроме инициатора: события уровня компании —
 * новый проект, опубликованная версия программы. Сам инициатор и так знает,
 * что сделал, и получать об этом уведомление ему незачем.
 */
async function notifyAll(category: string, title: string, body = '', targetRoute = '', exceptUserId = '') {
  try {
    const users = await prisma.user.findMany({ where: { isActive: true }, select: { id: true } });
    const rows = (users as any[])
      .filter(u => u.id !== exceptUserId)
      .map(u => ({ userId: u.id, category, title, body, targetRoute }));
    if (!rows.length) return;
    for (const r of rows) {
      const created = await prisma.notification.create({ data: r });
      pushNotification(r.userId, created);
    }
  } catch (err: any) {
    console.warn('[notifyAll] err:', err?.message);
  }
}

app.get('/api/notifications', async (req: Request, res: Response) => {
  try {
    const userId = String(req.query.userId || '');
    if (!userId) return res.json({ notifications: [] });
    const notifications = await prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ notifications });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications/read', async (req: Request, res: Response) => {
  try {
    const { userId, id } = req.body;
    if (id) {
      await prisma.notification.update({ where: { id }, data: { isRead: true } });
    } else if (userId) {
      await prisma.notification.updateMany({ where: { userId, isRead: false }, data: { isRead: true } });
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Проводник (папки, файлы, корзина) вынесен в server/routes/explorer.ts
registerExplorerRoutes(app);
registerDesktopRoutes(app);
registerPdfMarkupRoutes(app);
registerInsightRoutes(app);
registerAssistantRoutes(app);
registerTranslateRoutes(app);
registerCalendarRoutes(app);
registerMemberRoutes(app);

registerEquipmentUndoRoutes(app);


// Registry (Equipment & Tags)
// Маршрут «/api/equipment» убран: он отдавал оборудование ВСЕХ проектов сразу,
// без отбора по проекту и без учёта того, кто спрашивает. Раздел «Оборудование»
// им никогда не пользовался — он берёт системы своего проекта
// (/api/projects/:id/systems), — так что это была не возможность, а дыра,
// которая ждала, пока её кто-нибудь позовёт.

// Tag Template
app.get('/api/projects/:projectId/tag-template', async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const template = await prisma.tagTemplate.findUnique({ where: { projectId } });
  res.json({ template });
});

app.put('/api/projects/:projectId/tag-template', async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const { schemaJson } = req.body;
  const template = await prisma.tagTemplate.upsert({
    where: { projectId },
    create: { projectId, schemaJson },
    update: { schemaJson }
  });
  res.json({ template });
});

// Dictionaries
app.get('/api/projects/:projectId/dictionaries', async (req: Request, res: Response) => {
  let { projectId } = req.params;
  try {
    if (!projectId || projectId === 'null' || projectId === 'undefined' || projectId === 'default') {
      let firstProject = await prisma.project.findFirst();
      if (!firstProject) {
        firstProject = await prisma.project.create({ data: { name: 'Общий Проект' } });
      }
      projectId = firstProject.id;
    }
    const dictionaries = await prisma.dictionary.findMany({
      where: { projectId },
      include: { items: true }
    });
    res.json({ dictionaries });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects/:projectId/dictionaries', async (req: Request, res: Response) => {
  let { projectId } = req.params;
  const { name, items } = req.body;
  
  try {
    if (!projectId || projectId === 'null' || projectId === 'undefined' || projectId === 'default') {
      let firstProject = await prisma.project.findFirst();
      if (!firstProject) {
        firstProject = await prisma.project.create({ data: { name: 'Общий Проект' } });
      }
      projectId = firstProject.id;
    }

    // Create dictionary and its items using Prisma nested writes
    const dictionary = await prisma.dictionary.create({
      data: {
        projectId,
        name,
        items: {
          create: items // expects array of { code, nameRu }
        }
      },
      include: { items: true }
    });
    res.json({ dictionary });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects/:projectId/dictionaries/:dictionaryId/items', async (req: Request, res: Response) => {
  const item = await prisma.dictionaryItem.create({
    data: { ...req.body, dictionaryId: req.params.dictionaryId }
  });
  res.json({ item });
});

app.put('/api/dictionaries/items/:itemId', async (req: Request, res: Response) => {
  const item = await prisma.dictionaryItem.update({
    where: { id: req.params.itemId },
    data: { 
      code: req.body.code, 
      nameRu: req.body.nameRu,
      parentId: req.body.parentId !== undefined ? req.body.parentId : undefined
    }
  });
  res.json({ item });
});

app.delete('/api/dictionaries/items/:itemId', async (req: Request, res: Response) => {
  await prisma.dictionaryItem.delete({ where: { id: req.params.itemId } });
  res.json({ success: true });
});

app.get('/api/projects/:projectId/tags', async (req: Request, res: Response) => {
  const { projectId } = req.params;
  try {
    // componentElements: лёгкая проекция для клиента — по ней Менеджмент
    // подбирает шаблон этапов (тип оборудования/категория установки), а экран
    // «Оборудование» показывает занятость тега (один тег = одно изделие)
    const include = {
      equipment: true,
      componentElements: {
        select: {
          id: true, name: true, itemCode: true, equipType: true,
          monoblock: { select: { system: { select: { id: true, name: true, category: true } } } },
        },
      },
    } as const;
    let tags;
    if (!projectId || projectId === 'null' || projectId === 'undefined' || projectId === 'default') {
      tags = await prisma.tag.findMany({ include });
    } else {
      tags = await prisma.tag.findMany({ where: { projectId }, include });
    }
    res.json({ tags });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create tag manually
app.post('/api/projects/:projectId/tags', async (req: Request, res: Response) => {
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
    res.json({ tag });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Разбор xlsx-файла из Проводника на листы (для мастера импорта тегов)
app.post('/api/excel/sheets', async (req: Request, res: Response) => {
  try {
    const { fileId } = req.body;
    const file = await prisma.fileNode.findUnique({ where: { id: String(fileId) } });
    if (!file || !file.content) return res.status(404).json({ error: 'Файл не найден или пуст' });
    let b64 = file.content; if (b64.includes(',')) b64 = b64.split(',')[1];
    const buf = Buffer.from(b64, 'base64');
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
  let { projectId } = req.params;
  const { rows, mode } = req.body;
  try {
    if (!projectId || ['null', 'undefined', 'default'].includes(projectId)) {
      let fp = await prisma.project.findFirst(); if (!fp) fp = await prisma.project.create({ data: { name: 'Общий Проект' } }); projectId = fp.id;
    }
    const existing = await prisma.tag.findMany({ where: { projectId } });
    const byCode = new Map<string, any>();
    const codeToId = new Map<string, string>();
    for (const t of existing) { const k = (t.identifier || '').trim(); if (k) { if (!byCode.has(k)) byCode.set(k, t); codeToId.set(k, t.id); } }
    let created = 0, updated = 0; const dupes: string[] = [];
    const parentLinks: { childCode: string; parentCode: string }[] = [];
    let col = 0;
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
        await prisma.tag.update({ where: { id: ex.id }, data: { ...baseData, metadata: JSON.stringify(merged) } });
        updated++; codeToId.set(code, ex.id);
      } else {
        if (ex) dupes.push(code);
        const meta: any = { connections: [], descriptions: [], x: 120 + (col % 6) * 360, y: 80 + Math.floor(col / 6) * 150 };
        if (r.name) meta.mainName = String(r.name);
        if (r.actuality) meta.actuality = String(r.actuality);
        const t = await prisma.tag.create({ data: { projectId, ...baseData, metadata: JSON.stringify(meta) } });
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
      await prisma.tag.update({ where: { id: parentId }, data: { metadata: JSON.stringify(pm) } });
    }
    res.json({ created, updated, duplicates: [...new Set(dupes)] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
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
  let { projectId } = req.params;
  const { rows } = req.body as {
    rows: {
      identifier: string; brand?: string; name?: string; department?: string;
      fluid?: string; wbs?: string; actuality?: string;
      action: 'create' | 'skip' | 'fill' | 'replace' | 'duplicate' | 'link';
      targetId?: string;
    }[];
  };
  try {
    if (!projectId || ['null', 'undefined', 'default'].includes(projectId)) {
      let fp = await prisma.project.findFirst();
      if (!fp) fp = await prisma.project.create({ data: { name: 'Общий Проект' } });
      projectId = fp.id;
    }
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
        await prisma.tag.update({ where: { id: target.id }, data: { ...data, metadata: JSON.stringify(meta) } });
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
      (action === 'duplicate' ? duplicated : created).push({ id: t.id, identifier: code });
    }

    res.json({ created, filled, duplicated, linked, skipped });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Update tag fields and json metadata
// Отмена захвата: удаляем созданное, возвращаем дополненному прежние значения.
//
// Прежние значения приходят с клиента — он снял их снимком до применения.
// Хранить их на сервере незачем: откат живёт ровно столько, сколько открыт
// отчёт, и нужен на случай «нажал не подумав», а не как полноценная история.
app.post('/api/projects/:projectId/tags/capture-undo', async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const { deleteIds, restore } = req.body as {
    deleteIds: string[];
    restore: { id: string; brand: string | null; department: string | null;
               fluid: string | null; wbs: string | null; metadata: string | null }[];
  };
  try {
    let deleted = 0, restored = 0;
    // Только теги этого проекта: идентификатор из чужого проекта сюда не пройдёт
    if (Array.isArray(deleteIds) && deleteIds.length) {
      const r = await prisma.tag.deleteMany({ where: { id: { in: deleteIds.slice(0, 2000) }, projectId } });
      deleted = r.count;
    }
    for (const t of (restore || []).slice(0, 2000)) {
      const own = await prisma.tag.findFirst({ where: { id: String(t.id), projectId } });
      if (!own) continue;
      await prisma.tag.update({
        where: { id: t.id },
        data: {
          brand: t.brand ?? null,
          department: t.department ?? null,
          fluid: t.fluid ?? null,
          wbs: t.wbs ?? null,
          metadata: t.metadata ?? null,
        },
      });
      restored++;
    }
    res.json({ deleted, restored });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Массовое обновление metadata тегов одним запросом (Менеджмент: этап для N позиций).
// Раньше клиент слал N последовательных PUT — на больших выборках это заметно тормозило.
// ВАЖНО: маршрут объявлен раньше '/api/tags/:id', иначе «bulk-metadata» сматчится как id.
app.put('/api/tags/bulk-metadata', async (req: Request, res: Response) => {
  const { updates } = req.body as { updates: { id: string; metadata: string }[] };
  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ error: 'updates[] required' });
  }
  const limited = updates.slice(0, 2000);
  await prisma.$transaction(
    limited.map(u => prisma.tag.update({
      where: { id: String(u.id) },
      data: { metadata: typeof u.metadata === 'string' ? u.metadata : JSON.stringify(u.metadata) },
    }))
  );
  res.json({ success: true, updated: limited.length });
});

// ── «Карточку изменил кто-то ещё» ────────────────────────────────────────────
// Двое правят одну карточку — молча побеждает последний. Полноценное слияние
// для карточек не нужно (правки точечные), но человек обязан узнать, что под
// ним поменяли данные. Событие лёгкое: что тронули и кто, без содержимого —
// экран сам решает, перечитывать ему или нет.
function emitEntityChanged(kind: 'tag' | 'element', id: string, req: Request): void {
  try {
    io.emit('entity:changed', {
      kind, id,
      by: (req as any).authUser?.name || '',
      byId: (req as any).authUser?.id || '',
      at: Date.now(),
    });
  } catch (_) {}
}

app.put('/api/tags/:id', async (req: Request, res: Response) => {
  const { identifier, department, wbs, fluid, metadata, equipmentId, brand } = req.body;
  const tag = await prisma.tag.update({
    where: { id: req.params.id },
    data: {
      identifier,
      department: department === undefined ? undefined : (department || null),
      wbs: wbs === undefined ? undefined : (wbs || null),
      fluid: fluid === undefined ? undefined : (fluid || null),
      equipmentId: equipmentId === undefined ? undefined : (equipmentId || null),
      brand: brand === undefined ? undefined : (brand || null),
      metadata: metadata === undefined ? undefined : (typeof metadata === 'string' ? metadata : JSON.stringify(metadata))
    }
  });
  emitEntityChanged('tag', tag.id, req);
  res.json({ tag });
});

// Parse and import Excel/XML
app.post('/api/projects/:projectId/excel/parse-and-import', async (req: Request, res: Response) => {
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
      io.emit('equipment:conflict', {
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
  let { projectId } = req.params;
  try {
    if (!projectId || projectId === 'null' || projectId === 'undefined' || projectId === 'default') {
      let firstProject = await prisma.project.findFirst();
      if (!firstProject) {
        firstProject = await prisma.project.create({ data: { name: 'Общий Проект' } });
      }
      projectId = firstProject.id;
    }
    const systems = await prisma.equipmentSystem.findMany({
      where: { projectId },
      include: {
        monoblocks: {
          include: {
            components: {
              include: {
                tags: true
              }
            }
          }
        }
      }
    });
    res.json({ systems });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Delete an entire equipment system ("установка")
app.delete('/api/systems/:id', async (req: Request, res: Response) => {
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
      data: {
        tags: {
          connect: { id: tagId }
        }
      },
      include: { tags: true }
    });
    res.json({ component });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Unbind a tag from a ComponentElement
app.delete('/api/components/:componentId/tags/:tagId', async (req: Request, res: Response) => {
  const { componentId, tagId } = req.params;
  try {
    const component = await prisma.componentElement.update({
      where: { id: componentId },
      data: {
        tags: {
          disconnect: { id: tagId }
        }
      },
      include: { tags: true }
    });
    res.json({ component });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Delete tag
app.delete('/api/tags/:id', async (req: Request, res: Response) => {
  await prisma.tag.delete({
    where: { id: req.params.id }
  });
  res.json({ success: true });
});

// GET component element history logs
app.get('/api/components/:componentId/history', async (req: Request, res: Response) => {
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
  
  res.json({ tag: newTag });
});


// --- USER NOTES & CHANGES LOGS API ---

// 1. Get all notes
// Заметки (/api/notes) и журнал (/api/logs) — вынесены в модули-роуты
registerNoteRoutes(app);
registerLogRoutes(app);
// Почта: ящики по IMAP/SMTP, синхронизация, чтение (server/routes/mail.ts)
registerMailRoutes(app, { userDataPath, enforce, mayFeature });
registerMailSharedRoutes(app);
registerMailComposeRoutes(app, { userDataPath });
registerMailLinkRoutes(app, { userDataPath });
registerConstructorRoutes(app);
registerFormulaRoutes(app);
registerVdrRoutes(app);

// Резервные копии: суточный «Архив» (БД + файлы Проводника в родных форматах
// + данные в Excel), страховочные копии базы при старте, API и расписание
initBackups({
  app,
  getPrisma: () => prisma,
  baseDataDir: ventAppDataPath,
  getDbPath: () => {
    const cfg = loadAppConfig();
    return cfg.current_db_type === 'LOCAL' ? resolveLocalDbPath(cfg) : '';
  },
  log: logInit,
});


// --- CORPORATE MESSENGER CHAT API ---

// 1. Get messages between two users
app.get('/api/chat/messages', async (req: Request, res: Response) => {
  try {
    const { senderId, receiverId } = req.query;
    if (!senderId || !receiverId) {
      return res.status(400).json({ error: 'senderId and receiverId are required' });
    }
    // Читать переписку может только её участник
    const me = actorId(req);
    if (me !== String(senderId) && me !== String(receiverId)) {
      return res.status(403).json({ error: 'Это чужая переписка' });
    }

    // Отдаём хвост переписки, а не всю целиком: клиент перечитывает её при
    // каждом событии сокета и раз в 12 секунд страховочным опросом, и на
    // многолетней переписке это заметная нагрузка на сервер, сеть и отрисовку.
    // Берём последние N в обратном порядке и переворачиваем — так работает
    // индекс по дате, в отличие от смещения от начала
    const limit = Math.min(2000, Math.max(20, Number(req.query.limit) || 300));
    const tail = await prisma.chatMessage.findMany({
      where: {
        OR: [
          { senderId: String(senderId), receiverId: String(receiverId) },
          { senderId: String(receiverId), receiverId: String(senderId) }
        ]
      },
      include: {
        attachments: true,
        sender: { select: { id: true, name: true, symbol: true, role: true } },
        receiver: { select: { id: true, name: true, symbol: true, role: true } },
        linkedElement: true,
        replyTo: { select: { id: true, content: true, sender: { select: { id: true, name: true } } } }
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    res.json(tail.reverse());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Send message
app.post('/api/chat/messages', async (req: Request, res: Response) => {
  try {
    const { senderId, receiverId, content, linkedElementId, linkedProjectId, attachments, replyToId } = req.body;
    if (!senderId || !receiverId) {
      return res.status(400).json({ error: 'senderId and receiverId are required' });
    }
    // Писать можно только от своего имени
    if (actorId(req) !== String(senderId)) {
      return res.status(403).json({ error: 'Сообщение можно отправить только от своего имени' });
    }

    const msg = await prisma.chatMessage.create({
      data: {
        senderId: String(senderId),
        receiverId: String(receiverId),
        content: String(content || ''),
        linkedElementId: linkedElementId ? String(linkedElementId) : null,
        linkedProjectId: linkedProjectId ? String(linkedProjectId) : null,
        replyToId: replyToId ? String(replyToId) : null,
      }
    });

    // Create attachments if provided
    if (attachments && Array.isArray(attachments)) {
      for (const att of attachments) {
        await prisma.chatAttachment.create({
          data: {
            messageId: msg.id,
            fileName: String(att.fileName),
            filePath: String(att.filePath),
            fileSize: Number(att.fileSize || 0)
          }
        });
      }
    }

    const fullMessage = await prisma.chatMessage.findUnique({
      where: { id: msg.id },
      include: {
        attachments: true,
        sender: { select: { id: true, name: true, symbol: true, role: true } },
        receiver: { select: { id: true, name: true, symbol: true, role: true } },
        linkedElement: true,
        replyTo: { select: { id: true, content: true, sender: { select: { id: true, name: true } } } }
      }
    });

    // Личное уведомление получателю (категория ЧАТ)
    await notify(String(receiverId), 'ЧАТ', `Новое сообщение от ${(fullMessage as any)?.sender?.name || 'сотрудника'}`, String(content || '').slice(0, 80), `/chat?from=${senderId}`);

    // Только участникам диалога, а не всей сети
    await emitChat('chat:message_received', fullMessage as any, fullMessage);

    res.json(fullMessage);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});


// Редактирование своего сообщения
app.put('/api/chat/messages/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { content } = req.body;
    const msg = await prisma.chatMessage.findUnique({ where: { id } });
    if (!msg) {
      return res.status(404).json({ error: 'Сообщение не найдено' });
    }
    // Автора берём из сессии: присланному userId верить нельзя
    if (msg.senderId !== actorId(req)) {
      return res.status(403).json({ error: 'Можно редактировать только свои сообщения' });
    }
    const updated = await prisma.chatMessage.update({
      where: { id },
      data: { content: String(content || ''), editedAt: new Date() },
      include: {
        attachments: true,
        sender: { select: { id: true, name: true, symbol: true, role: true } },
        receiver: { select: { id: true, name: true, symbol: true, role: true } },
        linkedElement: true,
        replyTo: { select: { id: true, content: true, sender: { select: { id: true, name: true } } } }
      }
    });
    await emitChat('chat:message_updated', updated as any, updated);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Удаление своего сообщения
app.delete('/api/chat/messages/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const msg = await prisma.chatMessage.findUnique({ where: { id } });
    if (!msg) {
      return res.status(404).json({ error: 'Сообщение не найдено' });
    }
    // Автора берём из сессии, а не из параметра запроса
    if (msg.senderId !== actorId(req)) {
      return res.status(403).json({ error: 'Можно удалять только свои сообщения' });
    }
    // Вложения в БД (пути /chat_files/{fileNodeId}/{имя}) удаляем вместе с сообщением
    try {
      const atts = await prisma.chatAttachment.findMany({ where: { messageId: id } });
      const nodeIds = atts
        .map((a: any) => (String(a.filePath || '').match(/^\/chat_files\/([^/]+)\//) || [])[1])
        .filter(Boolean);
      if (nodeIds.length) await prisma.fileNode.deleteMany({ where: { id: { in: nodeIds }, type: 'CHAT_FILE' } });
    } catch (_) {}
    await prisma.chatMessage.delete({ where: { id } });
    await emitChat('chat:message_deleted', msg as any, { id });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Upload file — вложение хранится в БД (FileNode type=CHAT_FILE), а не на
// диске: в совместном режиме файл обязан открываться у всех пользователей
app.post('/api/chat/upload', async (req: Request, res: Response) => {
  try {
    const { fileName, base64Data } = req.body;
    if (!fileName || !base64Data) {
      return res.status(400).json({ error: 'fileName and base64Data are required' });
    }

    // Санитизация имени: только базовое имя, без разделителей и «..»/«.»
    let base = path.basename(String(fileName || '')).replace(/[\/\\]/g, '').trim();
    if (!base || base === '.' || base === '..') base = `file_${Date.now()}`;

    let b64 = String(base64Data);
    if (b64.includes(',')) b64 = b64.split(',')[1]; // отрезаем data:-префикс
    const size = Math.floor(b64.length * 3 / 4);

    const node = await prisma.fileNode.create({
      data: {
        name: base,
        type: 'CHAT_FILE',
        filePath: `/chat/${base}`,
        size,
        content: b64,
        department: 'CHAT'
      }
    });

    res.json({
      success: true,
      filePath: `/chat_files/${node.id}/${encodeURIComponent(base)}`,
      fileName: base,
      fileSize: size
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Выдача вложения из БД. Статика /chat_files (выше) обслуживает старые файлы
// на диске; сюда попадают только новые пути вида /chat_files/{id}/{имя}
const CHAT_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8'
};
app.get('/chat_files/:id/:name', async (req: Request, res: Response) => {
  try {
    const node = await prisma.fileNode.findUnique({ where: { id: String(req.params.id) } });
    if (!node || node.type !== 'CHAT_FILE' || !node.content) {
      return res.status(404).json({ error: 'Файл не найден' });
    }
    const buffer = Buffer.from(node.content, 'base64');
    const ext = path.extname(node.name).toLowerCase();
    res.setHeader('Content-Type', CHAT_MIME[ext] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(node.name)}`);
    res.send(buffer);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Search ComponentElement by tag string
/**
 * Куда ведёт тег, отправленный в чат.
 *
 * Раньше искали только среди элементов оборудования — и тег, который есть в
 * реестре, но ещё не привязан к позиции, объявлялся «не зарегистрированным в
 * базе». Человек видел ошибку про несуществующий тег, глядя на тег, который
 * сам же и завёл час назад.
 *
 * Ищем в обоих местах и говорим, что нашли: элемент — открывать в
 * «Оборудовании», тег — в «Тегах». Не нашли ни там ни там — так и отвечаем,
 * не выдумывая причину.
 */
app.get('/api/chat/search-element', async (req: Request, res: Response) => {
  try {
    const { tag, projectId } = req.query;
    if (!tag) {
      return res.status(400).json({ error: 'tag is required' });
    }
    const cleanTag = String(tag);
    const element = await prisma.componentElement.findFirst({
      where: {
        OR: [
          { itemCode: cleanTag },
          { name: cleanTag },
          { id: cleanTag },
          { tags: { some: { identifier: { contains: cleanTag } } } }
        ]
      },
      include: {
        tags: true,
        monoblock: { include: { system: true } }
      }
    });

    // Тег реестра ищем и в текущем проекте, и вне его: тег из соседнего
    // проекта — это не «не найден», это другой разговор, и сказать о нём надо
    // прямо, а не отправлять человека искать самому
    const pid = projectId ? String(projectId) : '';
    const tagRow = await prisma.tag.findFirst({
      where: { identifier: cleanTag, ...(pid ? { projectId: pid } : {}) },
      select: { id: true, identifier: true, projectId: true },
    });
    const elsewhere = tagRow || !pid ? null : await prisma.tag.findFirst({
      where: { identifier: cleanTag },
      select: { id: true, identifier: true, projectId: true, project: { select: { name: true } } },
    });

    res.json({ element, tag: tagRow, elsewhere });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Autocomplete tags/components in chat
app.get('/api/chat/autocomplete-tags', async (req: Request, res: Response) => {
  try {
    const { query, projectId } = req.query;
    const cleanQuery = query ? String(query).toLowerCase() : '';
    const cleanProjId = projectId ? String(projectId) : undefined;

    const suggestions: Array<{ text: string; description: string; elementId?: string }> = [];

    // 1. Fetch tags matching cleanQuery
    const tags = await prisma.tag.findMany({
      where: {
        ...(cleanProjId ? { projectId: cleanProjId } : {}),
        identifier: { contains: cleanQuery }
      },
      take: 15
    });

    for (const t of tags) {
      suggestions.push({
        text: t.identifier,
        description: `BIM/KKS Тег: ${t.fluid || ''} (${t.department || ''})`
      });
    }

    // 2. Fetch component elements matching cleanQuery
    const elements = await prisma.componentElement.findMany({
      where: {
        ...(cleanProjId ? {
          monoblock: {
            system: {
              projectId: cleanProjId
            }
          }
        } : {}),
        OR: [
          { itemCode: { contains: cleanQuery } },
          { name: { contains: cleanQuery } }
        ]
      },
      include: {
        monoblock: {
          include: {
            system: true
          }
        }
      },
      take: 20
    });

    for (const el of elements) {
      const systemName = el.monoblock?.system?.name || '';
      const monoName = el.monoblock?.name || '';
      suggestions.push({
        text: el.itemCode || el.name,
        description: `Оборудование: ${el.name} | [${systemName} > ${monoName}]`,
        elementId: el.id
      });
    }

    // Deduplicate suggestions by text
    const seen = new Set<string>();
    const uniqueSuggestions = suggestions.filter(s => {
      const key = s.text.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    res.json(uniqueSuggestions);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});


// Helper to auto-sync Chat Group for every Project
async function ensureProjectChatGroups() {
  try {
    const projects = await prisma.project.findMany();
    const users = await prisma.user.findMany();
    // Системный канал «Ошибки» — в нём по умолчанию состоят все пользователи
    const errName = 'Ошибки';
    let errGroup = await prisma.chatGroup.findFirst({ where: { name: errName, type: 'CHANNEL' } });
    if (!errGroup) {
      await prisma.chatGroup.create({
        data: {
          name: errName,
          type: 'CHANNEL',
          color: 'rose',
          description: 'Системный канал для отправки логов и сообщений об ошибках',
          members: { connect: users.map(u => ({ id: u.id })) }
        }
      });
    } else {
      await prisma.chatGroup.update({
        where: { id: errGroup.id },
        data: { members: { connect: users.map(u => ({ id: u.id })) } }
      });
    }
    for (const p of projects) {
      const g = await prisma.chatGroup.findFirst({ where: { projectId: p.id } });
      if (!g) {
        await prisma.chatGroup.create({
          data: {
            name: `Проект: ${p.name}`,
            type: 'PROJECT',
            projectId: p.id,
            members: { connect: users.map(u => ({ id: u.id })) }
          }
        });
      } else {
        await prisma.chatGroup.update({
          where: { id: g.id },
          data: {
            name: `Проект: ${p.name}`,
            members: { connect: users.map(u => ({ id: u.id })) }
          }
        });
      }
    }
  } catch (err) {
    console.warn('[ensureProjectChatGroups] err:', err);
  }
}

// Get group list
app.get('/api/chat/groups', async (req: Request, res: Response) => {
  try {
    await ensureProjectChatGroups();
    const groups = await prisma.chatGroup.findMany({
      include: {
        members: { select: { id: true, name: true, symbol: true, role: true } },
        project: { select: { id: true, name: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json(groups);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Создание своей группы или канала
app.post('/api/chat/groups', async (req: Request, res: Response) => {
  try {
    const { name, type, memberIds, description, color, ownerId } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Укажите название' });
    }
    const safeType = (type === 'CHANNEL' || type === 'CUSTOM') ? type : 'CUSTOM';
    const ids: string[] = Array.isArray(memberIds) ? memberIds.map(String) : [];
    // владелец всегда участник
    if (ownerId && !ids.includes(String(ownerId))) ids.push(String(ownerId));
    const group = await prisma.chatGroup.create({
      data: {
        name: String(name).trim(),
        type: safeType,
        description: String(description || ''),
        color: String(color || 'indigo'),
        ownerId: ownerId ? String(ownerId) : null,
        members: { connect: ids.map(id => ({ id })) },
      },
      include: { members: { select: { id: true, name: true, symbol: true, role: true } } },
    });
    res.json({ success: true, group });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Изменение группы/канала: название, описание, цвет, участники, владелец
app.put('/api/chat/groups/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, description, color, memberIds, ownerId, userId } = req.body;
    const group = await prisma.chatGroup.findUnique({ where: { id }, include: { members: true } });
    if (!group) return res.status(404).json({ success: false, message: 'Группа не найдена' });
    if (group.type === 'PROJECT') {
      return res.status(400).json({ success: false, message: 'Системную группу проекта изменить нельзя' });
    }
    // менять может владелец или администратор
    const editor = userId ? await prisma.user.findUnique({ where: { id: String(userId) } }) : null;
    if (group.ownerId && userId && group.ownerId !== String(userId) && editor?.role !== 'ADMIN') {
      return res.status(403).json({ success: false, message: 'Изменять может только владелец или администратор' });
    }
    const data: any = {};
    if (typeof name === 'string' && name.trim()) data.name = name.trim();
    if (typeof description === 'string') data.description = description;
    if (typeof color === 'string' && color) data.color = color;
    if (ownerId) data.ownerId = String(ownerId);
    if (Array.isArray(memberIds)) {
      data.members = { set: memberIds.map((m: string) => ({ id: String(m) })) };
    }
    const updated = await prisma.chatGroup.update({
      where: { id }, data,
      include: { members: { select: { id: true, name: true, symbol: true, role: true } } },
    });
    res.json({ success: true, group: updated });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Удаление группы/канала (нельзя удалять системную группу проекта)
app.delete('/api/chat/groups/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = String(req.query.userId || '');
    const group = await prisma.chatGroup.findUnique({ where: { id } });
    if (!group) return res.status(404).json({ success: false, message: 'Группа не найдена' });
    if (group.type === 'PROJECT') {
      return res.status(400).json({ success: false, message: 'Системную группу проекта удалить нельзя' });
    }
    const editor = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;
    if (group.ownerId && userId && group.ownerId !== userId && editor?.role !== 'ADMIN') {
      return res.status(403).json({ success: false, message: 'Удалить может только владелец или администратор' });
    }
    await prisma.chatGroup.delete({ where: { id } });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Реакция на сообщение (переключение эмодзи для пользователя)
// Участник ли пользователь диалога/группы, которой принадлежит сообщение.
// Личка: отправитель или получатель. Группа: член группы (или владелец).
/**
 * Кому адресовано событие чата: участникам диалога или членам группы.
 * Возвращает имена личных комнат сокетов.
 */
async function chatRooms(msg: { senderId: string; receiverId: string | null; chatGroupId: string | null }): Promise<string[]> {
  const ids = new Set<string>();
  if (msg.senderId) ids.add(String(msg.senderId));
  if (msg.receiverId) ids.add(String(msg.receiverId));
  if (msg.chatGroupId) {
    const g = await prisma.chatGroup.findUnique({
      where: { id: msg.chatGroupId },
      select: { ownerId: true, members: { select: { id: true } } },
    });
    if (g) {
      if (g.ownerId) ids.add(String(g.ownerId));
      for (const m of g.members) ids.add(String(m.id));
    }
  }
  return [...ids].map((id) => `user:${id}`);
}

/** Событие чата — только участникам, а не всей сети */
async function emitChat(
  event: string,
  msg: { senderId: string; receiverId: string | null; chatGroupId: string | null },
  payload: any,
) {
  try {
    const rooms = await chatRooms(msg);
    if (!rooms.length) return;
    io.to(rooms).emit(event, payload);
  } catch (err) {
    console.error('[Socket] не удалось разослать событие чата:', err);
  }
}

// Кто на самом деле обращается. Личность берём из проверенного токена сессии,
// а не из тела запроса: раньше обработчики чата верили полю userId/senderId,
// присланному клиентом, и любой вошедший сотрудник мог прочитать чужую
// переписку, написать от чужого имени или удалить чужое сообщение — достаточно
// было подставить идентификатор коллеги, а он виден в списке сотрудников.
function actorId(req: Request): string {
  return String((req as any).authUser?.id || '');
}

/** Состоит ли сотрудник в группе (владелец тоже считается участником) */
async function isGroupMember(userId: string, groupId: string): Promise<boolean> {
  if (!userId || !groupId) return false;
  const g = await prisma.chatGroup.findUnique({
    where: { id: String(groupId) },
    select: { ownerId: true, members: { where: { id: userId }, select: { id: true } } },
  });
  return !!g && (g.ownerId === userId || g.members.length > 0);
}

async function isChatParticipant(userId: string, msg: { senderId: string; receiverId: string | null; chatGroupId: string | null }): Promise<boolean> {
  if (!userId) return false;
  if (msg.senderId === userId || msg.receiverId === userId) return true;
  if (msg.chatGroupId) {
    const g = await prisma.chatGroup.findUnique({
      where: { id: msg.chatGroupId },
      select: { ownerId: true, members: { where: { id: userId }, select: { id: true } } },
    });
    if (g && (g.ownerId === userId || g.members.length > 0)) return true;
  }
  return false;
}

app.post('/api/chat/messages/:id/react', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { emoji } = req.body;
    const userId = actorId(req); // кто реагирует — из сессии, а не из тела
    if (!userId || !emoji) return res.status(400).json({ error: 'нужен вход и emoji' });
    const msg = await prisma.chatMessage.findUnique({ where: { id } });
    if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
    if (!(await isChatParticipant(userId, msg))) {
      return res.status(403).json({ error: 'Реагировать можно только в своих диалогах и группах' });
    }
    let reactions: Record<string, string[]> = {};
    try { reactions = msg.reactions ? JSON.parse(msg.reactions) : {}; } catch (_) { reactions = {}; }
    const list = reactions[emoji] || [];
    const uidStr = String(userId);
    if (list.includes(uidStr)) {
      reactions[emoji] = list.filter(u => u !== uidStr);
      if (reactions[emoji].length === 0) delete reactions[emoji];
    } else {
      reactions[emoji] = [...list, uidStr];
    }
    const updated = await prisma.chatMessage.update({
      where: { id }, data: { reactions: JSON.stringify(reactions) },
    });
    await emitChat('chat:message_updated', msg as any, { id, reactions: updated.reactions });
    res.json({ success: true, reactions: updated.reactions });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Закрепление / открепление сообщения (только участником диалога/группы)
app.post('/api/chat/messages/:id/pin', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = actorId(req); // закрепляющий — из сессии
    const msg = await prisma.chatMessage.findUnique({ where: { id } });
    if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
    if (!(await isChatParticipant(userId, msg))) {
      return res.status(403).json({ error: 'Закреплять можно только в своих диалогах и группах' });
    }
    const updated = await prisma.chatMessage.update({ where: { id }, data: { pinned: !msg.pinned } });
    await emitChat('chat:message_updated', msg as any, { id, pinned: updated.pinned });
    res.json({ success: true, pinned: updated.pinned });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Пересылка сообщения в другой чат (группу или личку)
app.post('/api/chat/forward', async (req: Request, res: Response) => {
  try {
    const { messageId, senderId, toGroupId, toReceiverId } = req.body;
    if (!messageId || !senderId || (!toGroupId && !toReceiverId)) {
      return res.status(400).json({ error: 'Не указано сообщение или цель пересылки' });
    }
    const src = await prisma.chatMessage.findUnique({
      where: { id: String(messageId) },
      include: { sender: { select: { name: true } }, attachments: true },
    });
    if (!src) return res.status(404).json({ error: 'Исходное сообщение не найдено' });
    const created = await prisma.chatMessage.create({
      data: {
        senderId: String(senderId),
        chatGroupId: toGroupId ? String(toGroupId) : null,
        receiverId: toReceiverId ? String(toReceiverId) : null,
        content: src.content,
        linkedElementId: src.linkedElementId,
        linkedProjectId: src.linkedProjectId,
        forwardedFrom: src.forwardedFrom || src.sender?.name || 'Сообщение',
        // Вложения пересылаются вместе с текстом (файл на диске общий — копируем записи)
        attachments: src.attachments.length ? {
          create: src.attachments.map((a: any) => ({ fileName: a.fileName, filePath: a.filePath, fileSize: a.fileSize })),
        } : undefined,
      },
    });
    const full = await prisma.chatMessage.findUnique({
      where: { id: created.id },
      include: {
        attachments: true,
        sender: { select: { id: true, name: true, symbol: true, role: true } },
        receiver: { select: { id: true, name: true, symbol: true, role: true } },
        linkedElement: true,
        replyTo: { select: { id: true, content: true, sender: { select: { id: true, name: true } } } },
      },
    });
    await emitChat('chat:message_received', full as any, full);
    res.json({ success: true, message: full });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Очистка истории переписки (группа целиком или личный диалог)
app.delete('/api/chat/conversation', async (req: Request, res: Response) => {
  try {
    const groupId = String(req.query.groupId || '');
    const a = String(req.query.userA || '');
    const b = String(req.query.userB || '');
    if (groupId) {
      const r = await prisma.chatMessage.deleteMany({ where: { chatGroupId: groupId } });
      return res.json({ success: true, deleted: r.count });
    }
    if (a && b) {
      const r = await prisma.chatMessage.deleteMany({
        where: { OR: [{ senderId: a, receiverId: b }, { senderId: b, receiverId: a }] },
      });
      return res.json({ success: true, deleted: r.count });
    }
    res.status(400).json({ success: false, message: 'Не указан диалог для очистки' });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Get messages for group
app.get('/api/chat/group-messages', async (req: Request, res: Response) => {
  try {
    const { groupId } = req.query;
    if (!groupId) {
      return res.status(400).json({ error: 'groupId is required' });
    }
    // Переписку группы читает только тот, кто в ней состоит
    if (!(await isGroupMember(actorId(req), String(groupId)))) {
      return res.status(403).json({ error: 'Вы не состоите в этой группе' });
    }
    // Как и в личной переписке — только хвост: групповые чаты живут дольше всех
    const limit = Math.min(2000, Math.max(20, Number(req.query.limit) || 300));
    const tail = await prisma.chatMessage.findMany({
      where: { chatGroupId: String(groupId) },
      include: {
        attachments: true,
        sender: { select: { id: true, name: true, symbol: true, role: true } },
        linkedElement: true,
        replyTo: { select: { id: true, content: true, sender: { select: { id: true, name: true } } } }
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json(tail.reverse());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Send message to group
app.post('/api/chat/group-messages', async (req: Request, res: Response) => {
  try {
    const { senderId, groupId, content, linkedElementId, linkedProjectId, attachments, replyToId } = req.body;
    if (!senderId || !groupId) {
      return res.status(400).json({ error: 'senderId and groupId are required' });
    }
    // От своего имени и только в свою группу
    if (actorId(req) !== String(senderId)) {
      return res.status(403).json({ error: 'Сообщение можно отправить только от своего имени' });
    }
    if (!(await isGroupMember(String(senderId), String(groupId)))) {
      return res.status(403).json({ error: 'Вы не состоите в этой группе' });
    }

    // В каналах публиковать может только владелец или администратор
    const grp = await prisma.chatGroup.findUnique({ where: { id: String(groupId) } });
    if (grp && grp.type === 'CHANNEL') {
      const u = await prisma.user.findUnique({ where: { id: String(senderId) } });
      if (grp.ownerId && grp.ownerId !== String(senderId) && u?.role !== 'ADMIN') {
        return res.status(403).json({ error: 'В канал может писать только владелец или администратор' });
      }
    }

    const msg = await prisma.chatMessage.create({
      data: {
        senderId: String(senderId),
        chatGroupId: String(groupId),
        content: String(content || ''),
        linkedElementId: linkedElementId ? String(linkedElementId) : null,
        linkedProjectId: linkedProjectId ? String(linkedProjectId) : null,
        replyToId: replyToId ? String(replyToId) : null,
      }
    });

    if (attachments && Array.isArray(attachments)) {
      for (const att of attachments) {
        await prisma.chatAttachment.create({
          data: {
            messageId: msg.id,
            fileName: String(att.fileName),
            filePath: String(att.filePath),
            fileSize: Number(att.fileSize || 0)
          }
        });
      }
    }

    const fullMessage = await prisma.chatMessage.findUnique({
      where: { id: msg.id },
      include: {
        attachments: true,
        sender: { select: { id: true, name: true, symbol: true, role: true } },
        linkedElement: true,
        replyTo: { select: { id: true, content: true, sender: { select: { id: true, name: true } } } }
      }
    });

    // Только членам группы
    await emitChat('chat:message_received', fullMessage as any, fullMessage);

    res.json(fullMessage);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});


// --- VENTILATION EQUIPMENT API ---

// 1. Импорт расчёта в выбранную категорию (новый парсер: группы + тип + ревизии)
// Общий шаг: файл Проводника → разобранный расчёт. Кидает { status, error }
// при проблемах формата, чтобы оба роута (план и запись) отвечали одинаково.
async function readEquipmentFile(fileId: string): Promise<{ result: any; fileName: string }> {
  const fileNode = await prisma.fileNode.findUnique({ where: { id: fileId } });
  if (!fileNode) throw { status: 404, error: 'Файл не найден' };
  if (!fileNode.content) throw { status: 400, error: 'Содержимое файла пустое' };

  let base64 = fileNode.content;
  if (base64.includes(',')) base64 = base64.split(',')[1];
  const buffer = Buffer.from(base64, 'base64');
  const extension = fileNode.name.split('.').pop()?.toLowerCase();

  if (!['xlsx', 'xls', 'xml', 'csv'].includes(extension || '')) {
    throw { status: 400, error: `Файл .${extension} этим способом не импортируется. Откройте «Оборудование» → «Импорт из документов» — там поддерживаются PDF, Word, Excel и XML с распознаванием.` };
  }

  let result;
  try {
    result = (extension === 'xml') ? parseEquipmentXML(buffer.toString('utf-8')) : parseEquipmentExcel(buffer);
  } catch {
    throw { status: 400, error: 'Не удалось прочитать файл как расчёт. Для бланков и опросных листов используйте «Оборудование» → «Импорт из документов».' };
  }
  if (!result.units.length) {
    throw { status: 400, error: 'Не удалось распознать оборудование в файле. Проверьте формат расчёта.' };
  }
  return { result, fileName: fileNode.name };
}

async function resolveImportProject(reqProjectId: any): Promise<string> {
  if (reqProjectId && !['null', 'undefined', 'default'].includes(reqProjectId)) return reqProjectId;
  let first = await prisma.project.findFirst();
  if (!first) first = await prisma.project.create({ data: { name: 'Общий Проект' } });
  return first.id;
}

// Dry-run: что изменится в проекте, без записи (дерево + дифф для предпросмотра)
app.post('/api/equipment/import-plan', async (req: Request, res: Response) => {
  const { fileId, category, projectId: reqProjectId, edits } = req.body;
  if (!fileId || !category) return res.status(400).json({ error: 'Не указан файл или категория' });
  try {
    const projectId = await resolveImportProject(reqProjectId);
    const { result, fileName } = await readEquipmentFile(fileId);
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
  const { fileId, category, projectId: reqProjectId, edits, selection, tagLinks } = req.body;
  if (!fileId || !category) {
    return res.status(400).json({ error: 'Не указан файл или категория' });
  }

  try {
    const projectId = await resolveImportProject(reqProjectId);
    const { result, fileName } = await readEquipmentFile(fileId);

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

// Ввоз распознанного документа (план и запись) вынесен
// в server/routes/equipmentDraft.ts
registerEquipmentDraftRoutes(app);

// ── Настройки (глобальные/админ и персональные) ──
// Настройки приложения (/api/settings) — вынесены в server/routes/settings.ts;
// upsertSetting импортируется из server/context.ts (используется и здесь ниже).
registerSettingsRoutes(app);

// Категории оборудования (список с возможностью добавления)
const DEFAULT_CATEGORIES = [
  { id: 'AHU', label: 'Центральные кондиционеры', composite: true },
  { id: 'FAN', label: 'Радиальные вентиляторы', composite: false },
  { id: 'VALVE', label: 'Клапаны', composite: false },
  { id: 'CURTAIN', label: 'Воздушные завесы', composite: false },
];
app.get('/api/equipment/categories', async (_req: Request, res: Response) => {
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

async function startServer() {
  // Выводим полный путь к файлу БД, который пытается открыть Prisma при старте
  const defaultLocalDbPath = path.join(ventAppDataPath, 'database.sqlite');
  try {
    logInit('[SQLite Startup Diagnostic] Инициализация Prisma перед стартом сервера...');
    logInit(`[SQLite Startup Diagnostic] Полный абсолютный путь к файлу БД: ${defaultLocalDbPath}`);
  } catch (diagErr: any) {
    console.warn('[SQLite Startup Diagnostic] (ошибка логгирования)', diagErr.message);
  }

  if (!prisma || !isPrismaAvailable) {
    logInit('[startServer Warning] Prisma client is NOT constructed or not available. Skipping database self-healing checks. Moving straight to starting Express listener.');
  } else {
    // SQLite dynamic DB integrity / corruption self-healing check
    try {
      await prisma.$queryRawUnsafe('SELECT 1;');
      logInit('[SQLite] Integrity check: connection successfully verified with SELECT 1.');
    } catch (error: any) {
      const errorMsg = String(error.message || error || '');
      logInit(`[SQLite Integrity Check failed] General SQLite connect check threw: ${errorMsg}`);
      if (errorMsg.includes('malformed') || errorMsg.includes('disk image') || errorMsg.includes('SqliteError') || errorMsg.includes('database.sqlite is not stable')) {
        logInit('[SQLite] Database corruption detected! Initiating dynamic self-healing...');
        try {
          await prisma.$disconnect();
        } catch (e) {}

        const dbPath = defaultLocalDbPath;
        const shmPath = dbPath + '-shm';
        const walPath = dbPath + '-wal';

        [dbPath, shmPath, walPath].forEach(f => {
          try {
            if (fs.existsSync(f)) {
              fs.unlinkSync(f);
              logInit(`[SQLite Recovery] Deleted corrupt file: ${f}`);
            }
          } catch (delError: any) {
            logInit(`[SQLite Recovery Exception] Failed to delete file ${f}: ${delError.message}`);
          }
        });

        logInit('[SQLite Recovery] Copying fresh SQLite database template to recover from corruption...');
        ensureSQLiteDatabaseExists(dbPath);

        // Recreate client
        process.env.DATABASE_URL = `file:${dbPath}?connection_limit=1&busy_timeout=15000`;
        try {
          prisma = createPrismaClient('LOCAL', process.env.DATABASE_URL);
          setPrisma(prisma);
          isPrismaAvailable = true;
          logInit('[SQLite Recovery] Constructed fresh PrismaClient successfully.');
        } catch (recreationErr: any) {
          logInit(`[SQLite Recovery Failure] Critical error reconstructing client: ${recreationErr.message}`);
          prisma = null;
          setPrisma(prisma);
          isPrismaAvailable = false;
        }
      } else {
        logInit('[SQLite Startup Connection Error] Skipping self-healing as error is not structural corruption.');
      }
    }

    if (prisma && isPrismaAvailable) {
      // Enable Write-Ahead Logging (WAL) mode for SQLite to prevent database disk image malformed exceptions during multi-user write operations
      try {
        await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL;');
        await prisma.$queryRawUnsafe('PRAGMA synchronous=NORMAL;');
        logInit('[SQLite] WAL (Write-Ahead Logging) Mode and synchronous=NORMAL successfully enabled.');
      } catch (error: any) {
        logInit(`[SQLite WAL Setting skip] SQLite WAL mode pragma check skipped/failed: ${error.message}`);
      }

      // Ensure database is seeded with initial user and project if empty
      try {
        const userCount = await prisma.user.count();
        if (userCount === 0) {
          logInit('[Database Seeder] No users found in database. Performing automatic initial seed...');
          const admin = await prisma.user.create({
            data: {
              name: 'Главный администратор (RaupovKhKh)',
              symbol: 'RaupovKhKh',
              password: hashPassword('1122'),
              role: 'ADMIN',
            }
          });
          logInit(`[Database Seeder] Created initial admin user: ${admin.symbol}`);

          const project = await prisma.project.create({
            data: {
              name: 'Технологический проект Альфа',
            }
          });
          logInit(`[Database Seeder] Created initial project: ${project.name}`);

          await prisma.equipment.create({
            data: {
              type: 'AHU',
              description: 'Air Handling Unit',
            }
          });
        }

        // Seed dummy notes if none exist
        const notesCount = await prisma.userNote.count();
        if (notesCount === 0) {
          logInit('[Database Seeder] Seeding initial notes...');
          await prisma.userNote.createMany({
            data: [
              {
                title: 'Заметки по проекту вентиляции',
                content: '<p>Проверить производительность <strong>AHU-2</strong> согласно обновленному ТЗ.</p><p>Учесть параметры сопротивления воздушного тракта и настроить частотные преобразователи.</p>',
                color: 'bg-yellow-50 dark:bg-yellow-950/20 border-yellow-200',
                equipmentId: 'AHU-2'
              },
              {
                title: 'Согласование схем автоматики',
                content: '<p>Выполнить сверку сигналов КИПиА для щита вентиляции. Особое внимание уделить датчикам перепада давления.</p>',
                color: 'bg-emerald-50 dark:bg-emerald-950/20 border-emerald-250',
                equipmentId: 'AHU'
              }
            ]
          });
        }

        // Seed dummy logs if none exist
        const logsCount = await prisma.systemChangeLog.count();
        if (logsCount === 0) {
          logInit('[Database Seeder] Seeding initial changelogs...');
          await prisma.systemChangeLog.createMany({
            data: [
              {
                userName: 'Главный Администратор (RaupovKhKh)',
                userSymbol: 'RaupovKhKh',
                description: 'Обновлены спецификации вентилятора по тегу AHU-2',
                targetRoute: '/explorer',
              },
              {
                userName: 'Главный Администратор (RaupovKhKh)',
                userSymbol: 'RaupovKhKh',
                description: 'Добавлен новый чертеж КМД-102 в папку Проекты',
                targetRoute: '/explorer',
              },
              {
                userName: 'Главный Администратор (RaupovKhKh)',
                userSymbol: 'RaupovKhKh',
                description: 'Сформирована сводная ведомость по оборудованию Проекта Альфа',
                targetRoute: '/',
              },
              {
                userName: 'Главный Администратор (RaupovKhKh)',
                userSymbol: 'RaupovKhKh',
                description: 'Изменен статус проекта на Активный',
                targetRoute: '/',
              }
            ]
          });
        }

      } catch (e: any) {
        logInit(`[Database Seeder error] Seeding failed/skipped: ${e.message}`);
      }
    }
  }

  app.use((err: any, req: Request, res: Response, next: any) => {
    const rawMsg = String(err?.message || err || 'Internal server error');
    // Берем суть ошибки Prisma — последняя строка вместо простыни с код-фреймом
    const lines = rawMsg.split('\n').map(l => l.trim()).filter(Boolean);
    let friendly = lines[lines.length - 1] || rawMsg;
    if (rawMsg.includes('malformed') || rawMsg.includes('disk image')) {
      friendly = 'База данных повреждена (database disk image is malformed). Перезапустите приложение — база будет автоматически восстановлена из шаблона.';
    } else if (rawMsg.includes('Foreign key constraint')) {
      friendly = 'Сессия устарела: текущий пользователь отсутствует в базе данных. Выйдите из профиля и войдите заново.';
    } else if (!prisma || !isPrismaAvailable) {
      friendly = 'База данных не инициализирована: клиент Prisma не был создан при старте. Подробности в backend-init.log.';
    }
    logInit(`[API ERROR] ${req.method} ${req.originalUrl}: ${friendly}`);
    console.error('Unhandled error:', err);
    res.status(500).json({ error: friendly, message: friendly });
  });

  // Неизвестный маршрут API — честный 404 в JSON.
  //
  // Раньше такой запрос доходил до раздачи одностраничного приложения и
  // возвращал index.html со статусом 200. Клиент вызывал res.json() и получал
  // «Unexpected token '<'» — ошибку, по которой невозможно догадаться, что на
  // самом деле опечатан адрес или маршрут переехал в другой модуль.
  app.use('/api', (req: Request, res: Response) => {
    res.status(404).json({ error: `Маршрут не найден: ${req.method} /api${req.path}` });
  });

  if (process.env.NODE_ENV !== "production") {
    try {
      const viteModule = eval('require')('vite');
      const vite = await viteModule.createServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
    } catch (viteErr: any) {
      console.error('[Vite Setup] Error initializing dynamic Vite middleware in dev env:', viteErr.message || viteErr);
    }
  } else {
    const distPath = __dirname.includes('app.asar')
       ? __dirname
       : path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Роли и разбор ФИО на части — в фоне: старт сервера не должен их ждать,
  // а на старой базе таблица ролей появляется только после синхронизации схемы.
  seedRoles().then(backfillNameParts).catch(() => {});
  // Кто скрыл своё присутствие — читаем один раз при старте: дальше список
  // держится в памяти и обновляется только при смене переключателя
  void refreshHiddenOnline();

  httpServer.listen(PORT, "0.0.0.0", () => {
    logInit(`[Server listener started] Express backend server successfully running on port ${PORT}`);
    // Подключённые ящики начинают ждать письма: раздел показывает новое сам,
    // без нажатия «Проверить»
    void watchAllMail().then((n) => { if (n) logInit(`[Почта] слежение за ящиками: ${n}`); });
  });
}

startServer();
