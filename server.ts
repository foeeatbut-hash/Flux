import { buildDatabaseClient } from './server/databaseClient.js';
import 'express-async-errors';
import { ensureUserProfileSchema } from './server/userProfileSchema.js';
import { traceRequest, traceDatabase, traceSockets } from './server/diagnostics.js';
import express, { Request, Response } from 'express';
import path from 'path';
import { PrismaClient } from '@prisma/client-sqlite';
import { parseEquipmentExcel, parseEquipmentXML } from './server/equipmentParser.js';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { setPrisma, setNotifier, setBroadcaster, setUserPush, upsertSetting, setSessionForget } from './server/context.js';
import { setDialect, dialectOf, ensureTables as ensureDbTables } from './server/ddl.js';
import { readAppVersion } from './server/presence.js';
import { registerSockets } from './server/sockets.js';
import { registerUpdateRoutes } from './server/updates.js';
import { registerLimitRoutes } from './server/limits.js';
import { registerFeedbackRoutes } from './server/routes/feedback.js';
import { registerPolicyRoutes } from './server/routes/policy.js';
import { registerPlayAccess } from './server/play/access.js';
import { registerPlayRoutes } from './server/play/routes.js';
import { registerPlayDiagnostics } from './server/play/diagnostics.js';
import { startPresenceSweep } from './server/play/socket.js';
import { startPlayOutbox } from './server/play/outbox.js';
import { invalidateRoleMaps } from './server/play/access.js';
import { registerFileChunkRoutes } from './server/routes/fileChunks.js';
import { registerArchiveRoutes } from './server/routes/archives.js';
import { registerOfficeFileRoutes } from './server/routes/officeFiles.js';
import { registerOfficeConvertRoutes } from './server/routes/officeConvert.js';
import { registerOfficeVersionRoutes } from './server/routes/officeVersions.js';
import { registerOfficeEnglishRoutes } from './server/routes/officeEnglish.js';
import { registerProjectDataRoutes } from './server/routes/projectData.js';
import { ensureDiskProject } from './server/systemFolders.js';
import { canWriteFile, FILE_NOT_FOUND } from './server/fileAccess.js';
import { registerActionLog } from './server/actionLog.js';
import { officeHub } from './server/officeRooms.js';
import { ensureRemoteSchema } from './server/schema-sync.js';
import { ensureSchemaColumns as ensureLocalSchema } from './server/localSchema.js';
import { registerNoteRoutes } from './server/routes/notes.js';
import { registerChatRoutes } from './server/routes/chat.js';
import { registerDictionaryRoutes } from './server/routes/dictionaries.js';
import { registerTagRoutes } from './server/routes/tags.js';
import { registerProjectRoutes } from './server/routes/projects.js';
import { registerNotificationRoutes } from './server/routes/notifications.js';
import { registerEquipmentCatalogRoutes } from './server/routes/equipmentCatalog.js';
import { registerEquipmentCoreRoutes } from './server/routes/equipmentCore.js';
import { registerFormulaRoutes } from './server/routes/formulas.js';
import { registerTableTemplateRoutes } from './server/routes/tableTemplates.js';
import { registerCatalogRoutes } from './server/routes/catalog.js';
import { entryOf } from './src/lib/permissions.js';
import { registerBuilderRoutes } from './server/routes/builder.js';
import { registerEquipmentViewRoutes } from './server/routes/equipmentViews.js';
import { registerImportJobRoutes } from './server/routes/importJobs.js';
import { startImportJobs } from './server/importJobs.js';
import { registerEquipmentEditRoutes } from './server/routes/equipmentEdit.js';
import { registerVdrRoutes } from './server/routes/vdr.js';
import { registerLogRoutes } from './server/routes/logs.js';
import { registerSettingsRoutes } from './server/routes/settings.js';
import { registerImportDictRoutes } from './server/routes/importDict.js';
import { registerEquipmentDraftRoutes } from './server/routes/equipmentDraft.js';
import { registerExplorerRoutes } from './server/routes/explorer.js';
import { registerFileSharingRoutes } from './server/routes/fileSharing.js';
import { registerDesktopRoutes } from './server/routes/desktop.js';
import { registerMailRoutes } from './server/routes/mail.js';
import { registerMailSharedRoutes } from './server/routes/mailShared.js';
import { registerMailComposeRoutes } from './server/routes/mailCompose.js';
import { registerMailLinkRoutes } from './server/routes/mailLink.js';
import { watchAll as watchAllMail } from './server/mail/idle.js';
import { registerInsightRoutes } from './server/routes/insight.js';
import { registerAssistantRoutes } from './server/routes/assistant.js';
import { registerTranslateRoutes } from './server/routes/translate.js';
import { registerCalendarRoutes } from './server/routes/calendar.js';
import { registerMemberRoutes } from './server/routes/members.js';
import { registerEquipmentUndoRoutes } from './server/routes/equipmentUndo.js';
import { registerTagPolicyRoutes } from './server/routes/tagPolicy.js';
import { registerUserRoutes, seedRoles, backfillNameParts } from './server/routes/users.js';
import { registerSystemRoutes } from './server/routes/system.js';
import { registerAuthRoutes } from './server/routes/auth.js';
import { initBackups } from './server/backup.js';
import { assertHealthySqlite } from './server/sqliteSafety.js';
import { bootstrapLocalDatabase, createEmptyLocalDatabase } from './server/databaseBootstrap.js';
import { requiresOwner, requiresAdministrator, isPrivilegedUser, administratorPermission } from './server/accessPolicy.js';
import { createAuthSessions, registerSessionRoutes } from './server/authSessions.js';
import { registerOwnerRoutes } from './server/routes/owner.js';
import { registerPersonLicenseRoutes } from './server/routes/personLicense.js';
import { configureLicenseService, licenseForUser, personLicenseMiddleware } from './server/licenseService.js';
import { registerProjectEntityGuard } from './server/projectEntityAccess.js';
import { protectSessionSockets } from './server/sessionSockets.js';
import { authTokenFromRequest, createCookieAuth } from './server/authCookies.js';
import { corsMiddleware, socketAllowRequest, blockPrivateBuildFiles, earlyBodyGate, staticUploadOptions, chatFileGate, setLinkSecret, hashLegacyPasswords, listenHost, dropRevokedSockets } from './server/security.js';

// ── Пароли: хеширование (scrypt) с обратной совместимостью ────────────────────
// Формат хранения: "scrypt$<saltHex>$<hashHex>". Открытые записи прежних версий
// переводятся в хеш один раз на базу (server/security.ts) и при входе не принимаются.
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
  // Открытый текст не принимается: его мог вписать любой, у кого есть база
  return false;
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

const ventAppDataPath = process.env.VENT_APP_DATA || getVentAppDataPath();
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

type StartupDatabaseFailure = { code: 'LOCAL_DATABASE_UNAVAILABLE' | 'REMOTE_DATABASE_UNAVAILABLE'; message: string };
let startupDatabaseFailure: StartupDatabaseFailure | null = null;
let startupDatabaseReady: Promise<void> = Promise.resolve();
const freshLocalDatabasePaths = new Set<string>();

function ensureSQLiteDatabaseExists(targetPath: string): boolean {
  try {
    const created = createEmptyLocalDatabase(targetPath);
    if (created) {
      freshLocalDatabasePaths.add(path.resolve(targetPath));
      logInit('[SQLite Bootstrap] Создана новая пустая база; таблицы будут созданы из схемы Flux.');
    }
    return true;
  } catch (err: any) {
    logInit(`[SQLite Bootstrap Error] Не удалось создать пустой SQLite-файл: ${err.message}`);
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

// Существующая база никогда не заменяется автоматически при ошибке чтения.
function ensureHealthyLocalDb(dbPath: string, schemaReady = false) {
  if (!fs.existsSync(dbPath) && !ensureSQLiteDatabaseExists(dbPath)) {
    throw new Error('Не удалось создать новую локальную базу SQLite. Проверьте доступ к выбранной папке.');
  }
  if (freshLocalDatabasePaths.has(path.resolve(dbPath)) && !schemaReady) {
    return;
  }
  if (schemaReady) freshLocalDatabasePaths.delete(path.resolve(dbPath));
  assertHealthySqlite(dbPath);
  logInit('[DB Health] Проверка целостности локальной базы пройдена успешно.');
  ensureSchemaColumns(dbPath);
}

// Догоняющая миграция для существующих баз: добавляем недостающие колонки,
// появившиеся в новых версиях приложения (db push в продакшене не выполняется)
function ensureSchemaColumns(dbPath: string) {
  ensureLocalSchema(dbPath, logInit);
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

// Клиент базы отдаётся под наблюдением: операции связываются с запросом,
// который их вызвал. Обёртка не меняет ни результата, ни ошибки
function createPrismaClient(dbType: string, dbUrl: string) {
  return traceDatabase(buildPrismaClient(dbType, dbUrl));
}

function buildPrismaClient(dbType: string, dbUrl: string) {
  return buildDatabaseClient(dbType, dbUrl, {
    load: require, sqliteAdapter: buildSqliteAdapter, selectDialect: setDialect,
  });
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

  // Новый файл будет инициализирован схемой ниже. Любой существующий файл
  // проходит проверку и сохраняется при отказе.
  try { ensureHealthyLocalDb(dbPath); }
  catch (error: any) {
    startupDatabaseFailure = { code: 'LOCAL_DATABASE_UNAVAILABLE', message: 'Локальная база недоступна. Исходный файл и журналы SQLite сохранены.' };
    logInit(`[SQLite Startup Refusal] ${error?.message || 'Проверка локальной базы не пройдена.'}`);
  }
} else {
  startupDbUrl = appConfig.database_url;
}

// 2. Принудительно переписываем DATABASE_URL
process.env.DATABASE_URL = startupDbUrl;
logInit(`[Startup DB] Выбран тип базы: ${appConfig.current_db_type}`);

// 3. Создание клиента без shell-команд или неявной потери данных.
let prisma: any = null;
let isPrismaAvailable = false;

if (startupDatabaseFailure) {
  setPrisma(null);
  logInit('[Prisma Client Init] Клиент не создан: локальная база отказала при проверке.');
} else try {
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
  
  startupDatabaseFailure = {
    code: appConfig.current_db_type === 'LOCAL' ? 'LOCAL_DATABASE_UNAVAILABLE' : 'REMOTE_DATABASE_UNAVAILABLE',
    message: appConfig.current_db_type === 'LOCAL'
      ? 'Локальную базу не удалось открыть. Исходные файлы SQLite сохранены.'
      : 'Не удалось подключиться к общей базе данных.',
  };
  prisma = null;
  setPrisma(null);
  isPrismaAvailable = false;

}

// Auto-seed user and structure if database is empty - securely wrapped to avoid startup crashes
startupDatabaseReady = (async () => {
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
    // Для нового локального файла создаём пустую структуру из схемы; для
    // существующего сначала проверяем целостность и сохраняем его данные.
    if (appConfig.current_db_type === 'REMOTE') {
      logInit('[Schema Sync] Проверка схемы общей базы при старте...');
      await syncRemoteSchema(prisma, startupDbUrl);
    } else {
      logInit('[Schema Sync] Проверка схемы локальной базы при старте...');
      const dbPath = resolveLocalDbPath(appConfig);
      const schemaPath = findRemoteSchemaFile('sqlite');
      if (!schemaPath) throw new Error('Файл локальной схемы Prisma не найден.');
      const result = await bootstrapLocalDatabase(
        dbPath,
        prisma,
        fs.readFileSync(schemaPath, 'utf8'),
        logInit,
        { alreadyCreatedEmpty: freshLocalDatabasePaths.has(path.resolve(dbPath)) },
      );
      freshLocalDatabasePaths.delete(path.resolve(dbPath));
      const applied = result.applied;
      if (applied.length) logInit(`[Schema Sync] Локальная база дополнена: ${applied.join('; ')}`);
    }

    logInit('[Startup DB Feed Check] Verifying records in User table...');
    const userCount = await prisma.user.count();
    logInit(`[Startup DB Feed Check] Found ${userCount} users registered.`);
    try { const n = await hashLegacyPasswords(prisma, hashPassword, isLegacyPassword); if (n) logInit(`[Security] Открытых паролей переведено в хеш: ${n}`); } catch (e: any) { logInit(`[Security] Перевод открытых паролей не выполнен: ${e?.message}`); }
    if (userCount === 0) logInit('[Setup] Пустая база: первый вход выполняет владелец с подписанным ключом.');
  } catch (err: any) {
    startupDatabaseFailure = {
      code: appConfig.current_db_type === 'LOCAL' ? 'LOCAL_DATABASE_UNAVAILABLE' : 'REMOTE_DATABASE_UNAVAILABLE',
      message: appConfig.current_db_type === 'LOCAL'
        ? 'Не удалось подготовить локальную базу. Исходные файлы SQLite сохранены.'
        : 'Не удалось подключиться к общей базе данных.',
    };
    logInit(`[Startup DB Seed Exception] Verifying / Seeding skipped or threw exception: ${err.message}\nStack: ${err.stack}`);
    try { await prisma?.$disconnect(); } catch (_) {}
    prisma = null;
    isPrismaAvailable = false;
    setPrisma(null);
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
    fs.writeFileSync(AUTH_SECRET_FILE, authSecret, { encoding: 'utf-8', mode: 0o600 });
  }
} catch (e) {
  // Файл недоступен (readonly-диск): секрет на время процесса — токены
  // перестанут действовать после перезапуска, но авторизация работает
  authSecret = crypto.randomBytes(48).toString('hex');
}
setLinkSecret(authSecret); // им же подписываются ссылки на вложения

const APP_VERSION: string = readAppVersion(__dirname);
const authSessions = createAuthSessions({ secret: authSecret });
const issueAuthToken = authSessions.issue;
const verifyAuthToken = authSessions.verify;

// Кэш пользователей на 30 с — проверка токена не ходит в БД на каждый запрос,
// но отключение профиля администратором срабатывает в течение полуминуты
const authUserCache = new Map<string, { user: any; at: number }>();
/** Сброс кэша сессии: снятое право должно действовать сразу, а не через полминуты. */
function invalidateAuthUser(userId?: string) {
  if (userId) authUserCache.delete(userId); else authUserCache.clear();
  /**
   * Права поменяли — окно обязано узнать об этом сейчас, а не при следующем
   * входе. Толчок несёт только «перечитай»: сами права окно спрашивает само
   * (`GET /api/me/bootstrap`), и присланному в событии верить не приходится.
   */
  if (userId) void dropRevokedSockets(io, userId, getAuthUser);
  try {
    if (userId) io.to(`user:${userId}`).emit('capabilities:changed', { at: Date.now() });
    else io.emit('capabilities:changed', { at: Date.now() });
  } catch (_) { /* сокета может не быть — окно перечитает при подключении */ }
}
setSessionForget(invalidateAuthUser);
const getAuthUser = async (userId: string) => {
  const hit = authUserCache.get(userId);
  if (hit && Date.now() - hit.at < 30000) return hit.user;
  await ensureUserProfileSchema(prisma);
  const user = await prisma.user.findUnique({ where: { id: userId } });
  authUserCache.set(userId, { user, at: Date.now() });
  return user;
};

const app = express();
// HTTPS завершается на локальном прокси; заголовкам удалённых клиентов не доверяем.
app.set('trust proxy', 'loopback');
const cookieAuth = createCookieAuth(authSecret);
app.use(cookieAuth.middleware);
app.use(traceRequest);
// Порт из окружения, но по умолчанию тот же: программа и её оболочка ждут
// именно 3000. Настройка нужна затем, чтобы поднять второй сервер на той же
// базе — так проверяется работа отдела, где у каждого свой встроенный сервер,
// а база одна на всех
const PORT = Number(process.env.PORT) || 3000;

const httpServer = createServer(app);
// Кого пускать, решает то же правило, что и для HTTP (server/security.ts)
const io = new SocketIOServer(httpServer, { cors: { origin: true, methods: ['GET', 'POST', 'DELETE'] }, allowRequest: socketAllowRequest });

traceSockets(io);
// Socket.io пускает только вошедших и годных профилей (server/security.ts)
protectSessionSockets(io, authSessions);

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

registerSockets(io, {
  getPrisma: () => prisma,
  getAuthUser,
  mayWriteFile,
  hiddenIds: () => hiddenOnline,
});

// Чужие сайты, большие тела без входа, файлы сборки — server/security.ts
app.use(corsMiddleware, blockPrivateBuildFiles, earlyBodyGate(r => AUTH_EXEMPT.has(r), t => !!verifyAuthToken(t)));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/chat_files', chatFileGate(), express.static(path.join(userDataPath, 'chat_files'), staticUploadOptions));
// Картинки подписей: показываются в разделе; в отправленном письме они
// уходят вложением с Content-ID, потому что снаружи этот адрес недоступен
app.use('/mail_sig', express.static(path.join(userDataPath, 'mail_sig'), staticUploadOptions));

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
  // Писать обращения и прикладывать к ним файлы — одно право: вложение без
  // обращения никому не нужно, а обращение без вложения бывает часто
  { method: /^(POST|PUT|DELETE)$/, path: /^\/api\/feedback\/(reports|uploads|drafts)/,
    perm: 'feedback.create', title: 'Писать обращения' },
  { method: /^DELETE$/, path: /^\/api\/(files|folders)/, perm: 'files.delete', title: 'Удаление файлов и папок' },
  { method: /^(POST|PUT|DELETE)$/, path: /^\/api\/settings\/(procurement_stages|procurement_templates|stage_templates)/,
    perm: 'procurement.setup', title: 'Настройка этапов закупки' },
  { method: /^(POST|PUT|DELETE|PATCH)$/, path: /^\/api\/vdr\/standards/,
    perm: 'vdr.standards', title: 'Стандарты документооборота' },
  { method: /^(POST|PUT|DELETE|PATCH)$/, path: /^\/api\/vdr\//,
    perm: 'vdr.manage', title: 'Реестр ВДР' },
  // Каталог правят немногие, а учится он у всех: запомненный выбор подбора —
  // побочный продукт работы в Конструкторе, а не правка справочника
  { method: /^(POST|PUT|DELETE)$/, path: /^\/api\/catalog\/(?!learn)/, perm: 'catalog.manage', title: 'Правка Каталога' },
  { method: /^(POST|PUT|DELETE)$/, path: /^\/api\/blank-templates/, perm: 'blanks.manage', title: 'Шаблоны бланков' },
  { method: /^POST$/, path: /^\/api\/builder\/lists\/[^/]+\/issues/, perm: 'builder.issue', title: 'Выпуск бланков' },
  // Связь с тегами проекта заводит теги — это право на теги, а не на ведомость
  { method: /^POST$/, path: /^\/api\/builder\/lists\/[^/]+\/tag-apply/, perm: 'tags.manage', title: 'Создание и правка тегов' },
  { method: /^(POST|PUT|DELETE)$/, path: /^\/api\/builder\//, perm: 'builder.edit', title: 'Ведомости Конструктора' },
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
function invalidateRolePerms() {
  rolePermCache.clear();
  // У платформы свой кэш прав роли и своя версия политики: без этого снятое
  // право платформы продолжало бы действовать до перезапуска сервера
  invalidateRoleMaps();
  try { io.emit('capabilities:changed', { at: Date.now() }); } catch (_) {}
}

async function effectivePermsOf(user: any): Promise<Record<string, any>> {
  let personal: Record<string, any> = {};
  try { personal = user.permissions ? JSON.parse(user.permissions) || {} : {}; } catch (_) {}
  const fromRole = await rolePermissionsOf(String(user.role || ''));
  return { ...fromRole, ...personal };   // личное сильнее роли
}

function permAllows(perms: Record<string, any>, feature: string): boolean {
  const e = entryOf(perms, feature) || (feature === 'project.manage' ? perms['project.create'] : null);
  if (!e || !e.enabled) return false;
  if (e.until && new Date(e.until).getTime() < Date.now()) return false;
  return true;
}

const AUTH_EXEMPT = new Set(['/api/health', '/api/login', '/api/owner/challenge', '/api/owner/login']);
app.use('/api', (_req: Request, res: Response, next) => {
  if (!startupDatabaseFailure) return next();
  return res.status(503).json({
    ok: false,
    code: startupDatabaseFailure.code,
    error: startupDatabaseFailure.message,
  });
});
app.use(async (req: Request, res: Response, next) => {
  // Express принимает другой регистр и хвостовой слеш: защита должна видеть тот же маршрут.
  const route = req.path.toLowerCase().replace(/\/+$/, '');
  if (!route.startsWith('/api/')) return next();
  if (AUTH_EXEMPT.has(route)) return next();

  const token = authTokenFromRequest(req);
  const userId = verifyAuthToken(token);
  if (!userId) return res.status(401).json({ error: 'Требуется вход в систему' });

  try {
    const user = await authSessions.validate(token);
    if (!user || user.isActive === false) {
      return res.status(401).json({ error: 'Профиль отключен или удалён администратором' });
    }
    if (user.role !== 'OWNER' && user.validUntil && new Date(user.validUntil).getTime() < trustedNowSync()) {
      return res.status(401).json({ error: 'Срок действия профиля истек' });
    }

    if (requiresOwner(route, req.method) && user.role !== 'OWNER') return res.status(403).json({ error: 'Доступно только владельцу Flux' });
    if (requiresAdministrator(route) && !isPrivilegedUser(user)) {
      return res.status(403).json({ error: 'Доступно только администратору' });
    }

    // Управление сотрудниками — только администратор; менять самого себя
    // (имя/пароль) может каждый, но не роль/права/срок
    const isUserRoute = /^\/api\/users\/[^/]+$/.test(route);
    if (!isPrivilegedUser(user)) {
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
    if (!isPrivilegedUser(user)) {
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

// Проверяются и адрес проекта, и фактические связи каждой записи — до ранних Office API.
registerProjectEntityGuard(app);
configureLicenseService({ trustedNow: trustedNowSync, fromSource: /\.tsx?$/.test(process.argv[1] || ''), automaticTestLicense: true });
app.use(personLicenseMiddleware({
  allowed: (method, route) => {
    const p = route.toLowerCase().replace(/\/+$/, '');
    return AUTH_EXEMPT.has(p) || p.startsWith('/api/license/') || p === '/api/logout'
      || (['GET', 'HEAD'].includes(method) && (p.startsWith('/api/updates') || p === '/api/me/bootstrap' || p === '/api/auth/check' || p === '/api/auth/me'));
  },
  readOnlyPost: p => /^\/api\/archives\/[^/]+\/(list|test|extract-preview|edit-preview)\/?$/i.test(p),
}));
registerPersonLicenseRoutes(app);

// Журнал действий — server/actionLog.ts. Пишет сервер: запись, которую делает
// окно, обходится закрытием окна. Стоит ДО всех маршрутов: ответ, законченный
// раньше подключённым обработчиком, до позднего журнала не доходил, и вход,
// сотрудники, обновления и файлы в него не попадали
registerActionLog(app, { getPrisma: () => prisma, can: userCan });

registerSystemRoutes(app, {
  appVersion: APP_VERSION,
  appDataPath: ventAppDataPath,
  loadAppConfig, saveAppConfig, resolveLocalDbPath, createPrismaClient,
  ensureHealthyLocalDb, ensureSchemaColumns, syncRemoteSchema, hashPassword,
  // Переключение базы подменяет клиента: и здесь, и в общем контексте вынесенных маршрутов
  replaceClient: (client) => { prisma = client; setPrisma(client); },
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

// Вход, проверка сессии и заполнение базы вынесены в server/routes/auth.ts
registerAuthRoutes(app, {
  hashPassword, verifyPassword, issueAuthToken, rolePermissionsOf,
  trustedNowFull, trustedNowSync,
  isClockTampered: () => timeTampered,
});

registerOwnerRoutes(app, { issueOwnerAuthToken: authSessions.issueOwner, invalidateAuthUser });
registerSessionRoutes(app, authSessions, cookieAuth);

// Словари импорта (выученные подписи и условные обозначения) вынесены
// в server/routes/importDict.ts
registerImportDictRoutes(app);

// Сотрудники, роли и личные настройки уведомлений вынесены
// в server/routes/users.ts
registerUserRoutes(app, { hashPassword, invalidateRolePerms, invalidateAuthUser, refreshHiddenOnline });

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
const limits = registerLimitRoutes(app, () => prisma);
registerFileSharingRoutes(app, { chunkBytes: limits.chunkBytes });
/**
 * Доступ к встроенным программам: свой запрос и свой заслон.
 *
 * Заслон стоит на префиксе `/api/play` целиком и отвечает нейтральным 404:
 * запрещающий ответ сообщил бы ровно то, что скрывается. Подключается он до
 * самих маршрутов платформы — иначе первый же забытый обработчик открыл бы её
 */
registerPolicyRoutes(app);
registerPlayAccess(app);
// Диагностика платформы для администратора — ВНЕ заслона /api/play:
// иначе настройка пряталась бы за дверью, ключ от которой она и выдаёт
registerPlayDiagnostics(app);

registerPlayRoutes(app);
// Очередь доставки и уборка протухших аренд присутствия: и то и другое
// переживает перезапуск сервера, потому что живёт в базе, а не в памяти
startPlayOutbox();
startPresenceSweep();
registerFeedbackRoutes(app, { can: userCan, feedbackChunkBytes: limits.feedbackChunkBytes, appVersion: () => APP_VERSION });
// Содержимое файла едет кусками: предела на размер больше нет. Право записи на
// общий диск считается тем же способом, что и для остальных действий с файлами
// Право записи файла — одно для кусков Проводника и для сохранения из Flux
// Office: иначе два пути записи одного файла разошлись бы в правилах
async function mayWriteFile(req: any, fileId: string): Promise<string> {
  const user = (req as any).authUser;
  const license = await licenseForUser(user);
  if (!license.licensed) return 'Сохранение недоступно: продлите лицензию сотрудника у владельца Flux.';
  // Единое правило видимости (server/fileAccess.ts). Раньше любой ADMIN обходил проверку
  // и писал в чужие личные файлы, хотя видит их лишь Главный Администратор; отказ — как «нет файла»
  if (!(await canWriteFile(prisma, user, fileId))) return FILE_NOT_FOUND;
  const file = await prisma.fileNode.findUnique({ where: { id: fileId }, select: { folderId: true } });
  if (!file?.folderId) return '';
  const folder = await prisma.folder.findUnique({ where: { id: file.folderId }, select: { projectId: true } });
  if (folder?.projectId !== (await ensureDiskProject())) return '';
  return userCan(user, 'disk.write') ? ''
    : 'Общий диск открыт всем на чтение, а класть и удалять на нём — по праву «Общий диск». Его выдаёт администратор в разделе «Сотрудники».';
}
registerFileChunkRoutes(app, { chunkBytes: limits.chunkBytes, mayWrite: mayWriteFile });
registerArchiveRoutes(app, { can: userCan, chunkBytes: limits.chunkBytes });
// Сохранение из редакторов Flux Office — целиком, со сверкой версии и откатом
registerOfficeFileRoutes(app, {
  chunkBytes: limits.chunkBytes, mayWrite: mayWriteFile, can: userCan,
  holderOf: (fileId) => officeHub.holderOf(fileId),
});
registerProjectDataRoutes(app, { mayWrite: mayWriteFile }); // поля, подписи и блоки файлов Flux Office
registerOfficeConvertRoutes(app, { chunkBytes: limits.chunkBytes, mayWrite: mayWriteFile }); // .xls/.csv → копия .xlsx
registerOfficeVersionRoutes(app, { holderOf: (fileId) => officeHub.holderOf(fileId) }); // откат файла
registerOfficeEnglishRoutes(app, { chunkBytes: limits.chunkBytes, mayWrite: mayWriteFile, holderOf: (fileId) => officeHub.holderOf(fileId) }); // английская версия


// Projects
// ── Права доступа «по функциям» (зеркало src/lib/permissions.ts) ──────────────
function userCan(user: any, feature: string): boolean {
  if (!user) return false;
  if (user.role === 'OWNER') return true;
  if (user.role === 'ADMIN') return feature.startsWith('admin.') ? administratorPermission(user, feature, trustedNowSync()) : true;
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
  return (req as any).authUser || null;
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
  if (actor.role === 'OWNER') return true;
  if (actor.role === 'ADMIN') return feature.startsWith('admin.') ? administratorPermission(actor, feature, trustedNowSync()) : true;
  if (actor.isActive === false) return false;
  if (actor.validUntil && (timeTampered || new Date(actor.validUntil).getTime() < trustedNowSync())) return false;
  return permAllows(await effectivePermsOf(actor), feature);
}

async function enforce(req: Request, res: Response, feature: string): Promise<boolean> {
  const actor = await loadActor(req);
  if (!actor) { res.status(401).json({ error: 'Требуется вход в систему.' }); return false; }
  if (actor.role === 'OWNER') return true;
  if (actor.role === 'ADMIN') return feature.startsWith('admin.') ? administratorPermission(actor, feature, trustedNowSync()) : true;
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

registerProjectRoutes(app, { enforce, notifyAll });

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
// Событие одному человеку: очередь обращений сама пишет в базу, а сюда отдаёт
// только «посмотри, там изменилось» — чтобы не ждать следующего опроса
setUserPush((userId, event, payload) => { try { io.to(`user:${userId}`).emit(event, payload); } catch (_) {} });

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

registerNotificationRoutes(app);

// Проводник (папки, файлы, корзина) вынесен в server/routes/explorer.ts
registerExplorerRoutes(app, { can: userCan });
registerDesktopRoutes(app);
registerInsightRoutes(app);
registerAssistantRoutes(app);
registerTranslateRoutes(app);
registerCalendarRoutes(app);
registerMemberRoutes(app);

registerEquipmentUndoRoutes(app);

// Правила тегов проекта: чтение, изменение и проверка на примере
registerTagPolicyRoutes(app);

registerDictionaryRoutes(app);
registerTagRoutes(app, { io, notifyAll });

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
registerFormulaRoutes(app);
registerTableTemplateRoutes(app);
registerCatalogRoutes(app);
registerBuilderRoutes(app);
registerEquipmentViewRoutes(app);
registerImportJobRoutes(app);
// Фоновый ввоз расчётов: очередь живёт в базе и переживает закрытое окно
startImportJobs();
registerEquipmentEditRoutes(app);
registerVdrRoutes(app, { chunkBytes: limits.chunkBytes });

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


registerChatRoutes(app, { io });



registerEquipmentCoreRoutes(app);
registerEquipmentCatalogRoutes(app);


// Ввоз распознанного документа (план и запись) вынесен
// в server/routes/equipmentDraft.ts
registerEquipmentDraftRoutes(app);

// ── Настройки (глобальные/админ и персональные) ──
// Настройки приложения (/api/settings) — вынесены в server/routes/settings.ts;
// upsertSetting импортируется из server/context.ts (используется и здесь ниже).
registerSettingsRoutes(app);


async function startServer() {
  await startupDatabaseReady;
  // Выводим полный путь к файлу БД, который пытается открыть Prisma при старте
  const defaultLocalDbPath = path.join(ventAppDataPath, 'database.sqlite');
  try {
    logInit('[SQLite Startup Diagnostic] Инициализация Prisma перед стартом сервера...');
    logInit(`[SQLite Startup Diagnostic] Полный абсолютный путь к файлу БД: ${defaultLocalDbPath}`);
  } catch (diagErr: any) {
    console.warn('[SQLite Startup Diagnostic] (ошибка логгирования)', diagErr.message);
  }

  if (!prisma || !isPrismaAvailable || startupDatabaseFailure) {
    logInit('[startServer Warning] Prisma client is unavailable or database startup was refused. Starting the listener in recovery mode.');
  } else {
    // Any failed final connection check enters recovery mode without replacing data.
    try {
      await prisma.$queryRawUnsafe('SELECT 1;');
      logInit('[SQLite] Integrity check: connection successfully verified with SELECT 1.');
    } catch (error: any) {
      const errorMsg = String(error.message || error || '');
      logInit(`[Startup Connection Error] Проверка соединения отказала: ${errorMsg}`);
      startupDatabaseFailure = {
        code: appConfig.current_db_type === 'LOCAL' ? 'LOCAL_DATABASE_UNAVAILABLE' : 'REMOTE_DATABASE_UNAVAILABLE',
        message: appConfig.current_db_type === 'LOCAL'
          ? 'Локальная база повреждена или недоступна. Исходный файл и журналы SQLite сохранены.'
          : 'Соединение с общей базой данных недоступно.',
      };
      try { await prisma.$disconnect(); } catch (_) {}
      prisma = null;
      setPrisma(null);
      isPrismaAvailable = false;
    }

    if (prisma && isPrismaAvailable && appConfig.current_db_type === 'LOCAL') {
      // Enable Write-Ahead Logging (WAL) mode for SQLite to prevent database disk image malformed exceptions during multi-user write operations
      try {
        await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL;');
        await prisma.$queryRawUnsafe('PRAGMA synchronous=NORMAL;');
        logInit('[SQLite] WAL (Write-Ahead Logging) Mode and synchronous=NORMAL successfully enabled.');
      } catch (error: any) {
        logInit(`[SQLite WAL Setting skip] SQLite WAL mode pragma check skipped/failed: ${error.message}`);
      }


    }
  }

  app.use((err: any, req: Request, res: Response, next: any) => {
    const rawMsg = String(err?.message || err || 'Internal server error');
    // Берем суть ошибки Prisma — последняя строка вместо простыни с код-фреймом
    const lines = rawMsg.split('\n').map(l => l.trim()).filter(Boolean);
    let friendly = lines[lines.length - 1] || rawMsg;
    if (rawMsg.includes('malformed') || rawMsg.includes('disk image')) {
      friendly = 'База данных повреждена (database disk image is malformed). Flux сохранил исходную базу и журналы SQLite.';
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
      // HMR идёт по тому же порту, что и сервер. Отдельный порт по умолчанию
      // (24678) один на машину: второй сервер разработки (проверки на двух
      // серверах, рабочие копии субагентов) его не получал, и страница сыпала
      // в консоль «failed to connect to websocket» — проверки «в консоли
      // пусто» падали не по своей вине.
      const vite = await viteModule.createServer({
        server: { middlewareMode: true, hmr: process.env.DISABLE_HMR === 'true' ? false : { server: httpServer } },
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

  httpServer.listen(PORT, listenHost(), () => {
    logInit(`[Server listener started] Express backend server successfully running on port ${PORT}`);
    // Подключённые ящики начинают ждать письма: раздел показывает новое сам,
    // без нажатия «Проверить»
    void watchAllMail().then((n) => { if (n) logInit(`[Почта] слежение за ящиками: ${n}`); });
  });
}

startServer();
