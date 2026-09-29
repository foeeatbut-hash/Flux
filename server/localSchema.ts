/**
 * Догоняющая миграция локальной базы SQLite: таблицы, колонки и ключи,
 * появившиеся в новых версиях программы.
 *
 * Вынесено из server.ts целиком: это 360 строк DDL, которые читаются только
 * при правке схемы, а в server.ts мешали читать всё остальное. Журнал
 * передаётся параметром — у сервера он свой (backend-init.log).
 */

// Догоняющая миграция для существующих баз: добавляем недостающие колонки,
// появившиеся в новых версиях приложения (db push в продакшене не выполняется)
export function ensureSchemaColumns(dbPath: string, logInit: (message: string) => void): void {
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
