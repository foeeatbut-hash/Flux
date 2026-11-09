import type { Express, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { getPrisma } from '../context.js';
import { requireOwnerMiddleware } from '../accessPolicy.js';
import { maskDbUrl, unmaskDbUrl } from '../security.js';
import { getDialect, setDialect } from '../ddl.js';
import { snapshotSqlite } from '../sqliteSafety.js';
import { watchAll as watchAllMail, stopAll as stopMailWatch } from '../mail/idle.js';

// Служебные маршруты: готовность, лицензия, синхронизация схемы и выбор базы.
//
// Вынесено из server.ts. Клиент базы здесь по-прежнему пересоздаётся при
// переключении (/api/db/switch, /api/db/save), но переменная с ним остаётся в
// server.ts: модуль читает её через getPrisma() и подменяет через
// replaceClient(), которая обновляет и server.ts, и server/context.ts разом.
// Состояние (конфиг, путь к данным) сюда не копируется — только функции доступа.

/** Настройка подключения к базе, как её хранит server.ts в config.json */
interface AppConfigLike {
  current_db_type: 'LOCAL' | 'REMOTE' | string;
  database_url: string;
  local_db_path?: string;
  crash_log_dir?: string;
}

interface SystemDeps {
  /** Версия программы: /api/health отдаёт её, чтобы клиент заметил старый сервер */
  appVersion: string;
  /** Папка данных программы (там config.json, журнал переключения и база по умолчанию) */
  appDataPath: string;
  loadAppConfig: () => AppConfigLike;
  saveAppConfig: (config: AppConfigLike) => void;
  resolveLocalDbPath: (config: AppConfigLike) => string;
  createPrismaClient: (dbType: string, dbUrl: string) => any;
  ensureHealthyLocalDb: (dbFile: string, schemaReady?: boolean) => void;
  ensureSchemaColumns: (dbFile: string) => void;
  syncRemoteSchema: (client: any, dbUrl: string, forceDialect?: 'sqlite') => Promise<string[]>;
  hashPassword: (plain: string) => string;
  /** Подменить клиента базы: server.ts обновляет свою переменную и вызывает setPrisma() */
  replaceClient: (client: any) => void;
}

export function registerSystemRoutes(app: Express, deps: SystemDeps): void {
  const {
    appVersion, appDataPath, loadAppConfig, saveAppConfig, resolveLocalDbPath, createPrismaClient,
    ensureHealthyLocalDb, ensureSchemaColumns, syncRemoteSchema, hashPassword, replaceClient,
  } = deps;

  app.use(['/api/db', '/api/admin/sync-schema', '/api/config/logs'], requireOwnerMiddleware);

  // Готовность сервера: порт начинает слушать только после инициализации БД,
  // так что успешный ответ = приложение полностью готово (для стартовой заставки)
  // Готовность сервера и его версия: сервер компании обновляют отдельно, и
  // программа должна сама заметить, что он старее её (см. server/presence.ts)
  app.get('/api/health', async (_req: Request, res: Response) => {
    const databaseMode = loadAppConfig().current_db_type;
    const dialect = getDialect();
    try {
      // Время одного запроса к базе отдельно от дороги до сервера: индикатор
      // связи в трее отличает «медленная сеть» от «медленная база»
      const started = performance.now();
      const needsSetup = await getPrisma().user.count() === 0;
      const dbMs = Math.round((performance.now() - started) * 10) / 10;
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, uptime: Math.round(process.uptime()), version: appVersion, needsSetup, databaseMode, dialect, dbMs });
    } catch (_) { res.status(503).json({ ok: false, version: appVersion, needsSetup: null, databaseMode, dialect, error: 'База временно недоступна' }); }
  });

  // Ручная проверка/обновление структуры базы (только администратор). Проходит
  // обычную авторизацию (путь НЕ /api/db/, поэтому loopback-исключение не действует).
  app.post('/api/admin/sync-schema', async (req: Request, res: Response) => {
    const user = (req as any).authUser;
    if (!user || user.role !== 'OWNER') {
      return res.status(403).json({ error: 'Доступно только владельцу программы' });
    }
    try {
      const cfg = loadAppConfig();
      if (cfg.current_db_type === 'REMOTE') {
        const prisma = getPrisma();
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
      // Пароль базы наружу не уходит (server/security.ts)
      database_url: maskDbUrl(config.database_url),
      databasePath: dbPath,
      isConfigured: true,
      displayPath: config.current_db_type === 'LOCAL' ? dbPath : maskDbUrl(config.database_url),
      defaultPath: path.join(appDataPath, 'database.sqlite'),
      local_db_path: config.local_db_path || '',
      crash_log_dir: config.crash_log_dir || ''
    });
  });

  // Настройка папки для аварийных crash-логов
  app.post('/api/config/logs', (req: Request, res: Response) => {
    const { crash_log_dir } = req.body;
    const current = loadAppConfig();
    if (typeof crash_log_dir === 'string') {
      const dir = crash_log_dir.trim();
      // Папку создаёт программа при аварии: относительный путь означал бы «где окажется» запуск
      if (dir && !path.isAbsolute(dir)) return res.status(400).json({ error: 'Путь к папке журналов должен быть полным.' });
      current.crash_log_dir = dir;
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
    const { current_db_type } = req.body || {};
    const database_url = unmaskDbUrl(req.body?.database_url, loadAppConfig().database_url);
    if (current_db_type !== 'LOCAL' && current_db_type !== 'REMOTE') {
      return res.status(400).json({ success: false, message: 'Тип базы данных должен быть LOCAL или REMOTE.' });
    }
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
    // Создание клиента запоминает движок базы для всего сервера (server/ddl.ts).
    // Проверка чужой базы не должна его менять: после неудачной проверки
    // MySQL работающий на SQLite сервер начинал писать SQL для MySQL
    const dialectWas = getDialect();
    let tempPrisma: any = null;
    try {
      tempPrisma = createPrismaClient('REMOTE', database_url);
      setDialect(dialectWas);
      await tempPrisma.$queryRawUnsafe('SELECT 1;');

      res.json({
        success: true,
        exists: true,
        message: 'Удаленное подключение успешно проверено и доступно!'
      });
    } catch (err: any) {
      setDialect(dialectWas);
      res.json({
        success: false,
        message: `Не удалось подключиться по указанному адресу: ${err.message}`
      });
    } finally {
      // Временное соединение закрываем и при неудачной проверке
      if (tempPrisma) { try { await tempPrisma.$disconnect(); } catch (_) {} }
    }
  });

  // Смена базы идёт по одной: второй запрос посреди первой пересекался бы на
  // отключении и подмене клиента и мог оставить сервер без рабочей базы
  let switching = false;

  interface SwitchTarget {
    type: 'LOCAL' | 'REMOTE';
    /** REMOTE: строка подключения */
    url?: string;
    /** LOCAL: путь к файлу SQLite ('' — стандартный) */
    localPath?: string;
  }

  /**
   * Переключить базу так, чтобы неудача возвращала ВСЁ как было: клиента,
   * движок SQL (dialect), DATABASE_URL, слежение за почтой. Новый клиент
   * строится и проверяется, пока старый ещё работает; подмена — только после
   * успеха, и старый отключается последним.
   */
  async function switchDatabase(target: SwitchTarget): Promise<{ needsSetup: boolean }> {
    const existingConfig = loadAppConfig();
    const oldPrisma = getPrisma();
    const dialectWas = getDialect();
    const urlWas = process.env.DATABASE_URL;
    let fresh: any = null;
    let replaced = false;
    try {
      let targetDbUrl = '';
      let dbFile = '';
      const nextLocalPath = target.type === 'LOCAL' ? (target.localPath ?? existingConfig.local_db_path ?? '') : (existingConfig.local_db_path || '');
      if (target.type === 'LOCAL') {
        dbFile = nextLocalPath ? path.resolve(nextLocalPath) : path.join(appDataPath, 'database.sqlite');
        const parentDir = path.dirname(dbFile);
        if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
        targetDbUrl = `file:${dbFile}?connection_limit=1&busy_timeout=15000`;
        ensureHealthyLocalDb(dbFile);
      } else {
        targetDbUrl = target.url || '';
      }

      // База другая — ящики в ней тоже другие: старые наблюдения гасим, новые
      // поднимем после того, как схема встанет
      stopMailWatch();

      fresh = createPrismaClient(target.type, targetDbUrl);
      if (target.type === 'LOCAL') {
        try {
          await fresh.$queryRawUnsafe('PRAGMA journal_mode=WAL;');
          await fresh.$queryRawUnsafe('PRAGMA synchronous=NORMAL;');
        } catch (pragmaErr: any) {
          console.warn('[DB Switch] Failed setting local performance PRAGMAs:', pragmaErr.message);
        }
      }
      await fresh.$queryRawUnsafe('SELECT 1;');

      // Приводим схему к версии программы до автозаполнения и первых запросов
      if (target.type === 'REMOTE') await syncRemoteSchema(fresh, targetDbUrl);
      else {
        await syncRemoteSchema(fresh, targetDbUrl, 'sqlite');
        ensureHealthyLocalDb(dbFile, true);
      }

      process.env.DATABASE_URL = targetDbUrl;
      replaceClient(fresh);
      replaced = true;

      // Адрес общей базы при переходе на локальную не стирается: к ней можно вернуться
      saveAppConfig({
        ...existingConfig,
        current_db_type: target.type,
        database_url: target.type === 'REMOTE' ? (target.url || '') : (existingConfig.database_url || ''),
        local_db_path: nextLocalPath,
      });

      const needsSetup = await fresh.user.count() === 0;
      try { await oldPrisma?.$disconnect(); } catch (discErr: any) {
        console.warn('[DB Switch] Notice during client disconnect:', discErr.message);
      }
      // Схема на месте — поднимаем слежение за ящиками новой базы
      void watchAllMail();
      return { needsSetup };
    } catch (err) {
      setDialect(dialectWas);
      if (urlWas === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = urlWas;
      if (replaced) replaceClient(oldPrisma);
      if (fresh) { try { await fresh.$disconnect(); } catch (_) {} }
      void watchAllMail();
      throw err;
    }
  }

  app.post('/api/db/switch', async (req: Request, res: Response) => {
    const { current_db_type, database_path } = req.body || {};
    const database_url = unmaskDbUrl(req.body?.database_url, loadAppConfig().database_url);

    const logMsg = `[${new Date().toISOString()}] POST /api/db/switch: type="${current_db_type}"\n`;
    console.log('[DB Switch Request]', logMsg.trim());
    try {
      fs.appendFileSync(path.join(appDataPath, 'database-switch.log'), logMsg, 'utf-8');
    } catch (e) {}

    if (!current_db_type) {
      return res.status(400).json({ success: false, message: 'Тип базы данных не указан!' });
    }
    if (current_db_type !== 'LOCAL' && current_db_type !== 'REMOTE') {
      return res.status(400).json({ success: false, message: 'Тип базы данных должен быть LOCAL или REMOTE.' });
    }
    if (current_db_type === 'REMOTE' && !database_url) {
      return res.status(400).json({ success: false, message: 'Ссылка подключения REMOTE обязательна!' });
    }
    // database_path: undefined = оставить текущий путь, '' = вернуть стандартный, иначе — новый путь
    let localPath: string | undefined;
    if (typeof database_path === 'string') {
      localPath = database_path.trim();
      if (localPath && !path.isAbsolute(localPath)) {
        return res.status(400).json({ success: false, message: 'Путь к базе должен быть полным (например, D:\\Flux\\database.sqlite).' });
      }
    }
    if (switching) return res.status(409).json({ success: false, message: 'Переключение базы уже выполняется. Дождитесь его окончания.' });
    switching = true;
    try {
      const { needsSetup } = await switchDatabase({ type: current_db_type, url: database_url, localPath });
      const seedMessage = needsSetup ? ' База пуста: войдите по ключу владельца и создайте администратора.' : '';
      return res.json({
        success: true,
        message: `База данных успешно переключена на режим ${current_db_type === 'LOCAL' ? 'Локальный' : 'Совместный / Внешний'}!${seedMessage}`
      });
    } catch (err: any) {
      console.error('[DB Switch] switchover failure:', err);
      return res.status(500).json({
        success: false,
        message: `Не удалось изменить подключение: ${err.message}`
      });
    } finally {
      switching = false;
    }
  });

  // Старый вызов: путь к файлу SQLite. Делает то же, что переключение на локальную базу
  app.post('/api/db/save', async (req: Request, res: Response) => {
    const { databasePath } = req.body || {};
    if (databasePath) {
      if (typeof databasePath !== 'string' || !path.isAbsolute(databasePath.trim())) {
        return res.status(400).json({ success: false, message: 'Путь к базе должен быть полным.' });
      }
      if (switching) return res.status(409).json({ success: false, message: 'Переключение базы уже выполняется. Дождитесь его окончания.' });
      switching = true;
      try {
        await switchDatabase({ type: 'LOCAL', localPath: path.resolve(databasePath.trim()) });
        return res.json({
          success: true,
          message: 'Локальный путь SQLite базы успешно изменён!'
        });
      } catch (err: any) {
        return res.status(500).json({ success: false, message: err.message });
      } finally {
        switching = false;
      }
    }

    // Redirect to standard switch handler
    req.url = '/api/db/switch';
    (app as any).handle(req, res);
  });
}
