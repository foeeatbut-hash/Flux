import { app, BrowserWindow, ipcMain, Menu, Notification, nativeImage, utilityProcess } from 'electron';
import path from 'path';
import { licenseStatus, activateLicense } from './license';
import { setupCapture } from './capture';
import { setupBrowser, disposeBrowserFor } from './browser';
import { setupLogs, appendLog, appendLogNow, logsDir } from './logs';
import { setupDiagnostics } from './diagnostics';
import { TRAY_ICON_PNG } from './trayIcon';
// Правила скачивания: кому показывать токен, годен ли файл, как назвать отказ
import { sameServer, badPackage, downloadError, applyArgs, parseApplyArgs } from './updates';
import { applyUpdate } from './applyUpdate';

/**
 * Запуск с доводом подмены — это не запуск программы, а её установка.
 *
 * Разбирается ПЕРВЫМ делом и мимо замка одиночного запуска: старая версия в
 * этот миг ещё работает, и замок закрыл бы помощника прежде, чем тот успел бы
 * что-нибудь сделать. Окна помощник тоже не создаёт — ему нечего показывать.
 */
const APPLY = parseApplyArgs(process.argv);

const additionalData = { myKey: 'pdm-system' };
if (!APPLY) {
  const gotTheLock = app.requestSingleInstanceLock(additionalData);
  if (!gotTheLock) {
    app.quit();
  } else {
    app.on('second-instance', (event, commandLine, workingDirectory, additionalData) => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
  }
}

let mainWindow: BrowserWindow | null = null;

// Prisma 7: клиент создается только через driver adapter, DATABASE_URL из env не читается
function createDbClient(dbType: string, dbUrl: string) {
  if (dbType === 'REMOTE') {
    const { PrismaClient } = require('@prisma/client-pg');
    const { PrismaPg } = require('@prisma/adapter-pg');
    return new PrismaClient({ adapter: new PrismaPg({ connectionString: dbUrl }) });
  }
  const { PrismaClient } = require('@prisma/client-sqlite');
  const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
  // better-sqlite3 не понимает query-параметры в URL — отрезаем их
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: dbUrl.split('?')[0], timeout: 15000 }) });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: 'hidden',
    // Показываем окно только когда страница готова к первой отрисовке —
    // тогда пользователь сразу видит стартовую заставку приложения (BootSplash),
    // а не пустой экран. Отдельного окна-заставки нет — интро одно.
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:3000');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // Запуск из автозагрузки со свёрнутым окном: программа поднимается вместе с
  // системой затем, чтобы уведомления приходили с утра, — а не затем, чтобы
  // окно лезло поверх всего, пока человек ещё наливает чай
  const startMinimized = process.argv.includes('--minimized');

  let shown = false;
  const revealMainWindow = () => {
    if (shown || !mainWindow) return;
    shown = true;
    if (startMinimized) { mainWindow.showInactive(); mainWindow.minimize(); return; }
    mainWindow.show();
  };
  mainWindow.once('ready-to-show', revealMainWindow);
  // Страховка: если ready-to-show не пришёл (страница зависла/упала) — всё равно показываем
  setTimeout(revealMainWindow, 10000);

  // Окно ушло — уносим его вкладки браузера: иначе страницы останутся жить
  // процессами, которых уже никто не видит
  mainWindow.on('closed', () => { try { disposeBrowserFor(mainWindow!.id); } catch (_) {} });

  // Сообщаем рендереру об изменении состояния разворота окна
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized-changed', true));
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized-changed', false));
}

app.whenReady().then(() => {
  // Помощник подмены: ни меню, ни сервера, ни окна — только заменить файл и уйти
  if (APPLY) { void applyUpdate(APPLY); return; }

  // Убираем стандартное меню File/Edit/View/Window
  Menu.setApplicationMenu(null);

  // Подробная запись поднимается раньше остальных модулей: она подменяет
  // регистрацию обработчиков моста, и всё, что зарегистрируется позже,
  // попадает под замер само. Поставить её после setupBrowser значило бы
  // не измерять браузер вовсе
  setupDiagnostics(logsDir());

  // Браузер внутри программы: вкладки страницами того же движка
  setupBrowser();

  // Журналы: папка на рабочем столе, файл на день, уборка старше месяца
  setupLogs();

  const fs = require('fs');
  const path = require('path');

  let ventAppDataPath = '';
  try {
    const baseDir = process.env.APPDATA || 
      (process.platform === 'darwin' 
        ? path.join(require('os').homedir(), 'Library', 'Application Support') 
        : path.join(require('os').homedir(), '.config'));
    
    ventAppDataPath = path.join(baseDir, 'pdm-app');
  } catch (e) {
    try {
      ventAppDataPath = app.getPath('userData');
    } catch (err) {
      ventAppDataPath = path.join(require('os').homedir(), 'pdm-app');
    }
  }

  // Ensure directory exists
  try {
    if (!fs.existsSync(ventAppDataPath)) {
      fs.mkdirSync(ventAppDataPath, { recursive: true });
    }
  } catch (e) {}

  // Главное окно покажется, когда будет готово к отрисовке — сразу со стартовой
  // заставкой из index.html. Встроенный Express-сервер поднимается ниже,
  // как только будет вычислен DATABASE_URL.
  createWindow();

  // Захват с экрана: трей, горячая клавиша, пульт (см. electron/capture.ts)
  setupCapture(() => mainWindow);

  const CONFIG_FILE = path.join(ventAppDataPath, 'config.json');

  // Читает config.json: тип БД, удаленный URL, пользовательский путь SQLite,
  // папку crash-логов и адрес сервера компании (пусто = встроенный сервер)
  const readAppConfig = () => {
    const result = { currentDbType: 'LOCAL', databaseUrlSetting: '', localDbPath: '', crashLogDir: '', remoteServerUrl: '' };
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
        if (parsed && typeof parsed === 'object') {
          if (typeof parsed.current_db_type === 'string') {
            result.currentDbType = parsed.current_db_type;
            result.databaseUrlSetting = parsed.database_url || '';
            result.localDbPath = parsed.local_db_path || '';
            result.crashLogDir = parsed.crash_log_dir || '';
          }
          result.remoteServerUrl = String(parsed.remote_server_url || '').trim();
        }
      }
    } catch (e) {}
    return result;
  };

  // Смена адреса сервера из интерфейса (экран входа): пусто = встроенный.
  // Пишем в config.json, не трогая остальные ключи; применяется при
  // следующем запуске (рендерер сам перезагружается и читает localStorage)
  ipcMain.handle('app:set-server-url', (_event, url: string) => {
    try {
      let parsed: any = {};
      try {
        if (fs.existsSync(CONFIG_FILE)) parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) || {};
      } catch (e) { parsed = {}; }
      parsed.remote_server_url = String(url || '').trim();
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(parsed, null, 2), 'utf-8');
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  });
  ipcMain.handle('app:get-server-url', () => readAppConfig().remoteServerUrl);

  // Лицензия: авторитетная проверка в главном процессе (отпечаток именно этой
  // машины). Папка пользователя — стандартная userData этого приложения.
  ipcMain.handle('license:status', () => {
    try { return licenseStatus(app.getPath('userData')); }
    catch (e: any) { return { licensed: false, machineId: '', expiresAt: null, daysLeft: null, reason: 'none', error: e?.message }; }
  });
  ipcMain.handle('license:activate', (_event, code: string) => {
    try { return activateLicense(app.getPath('userData'), String(code || '')); }
    catch (e: any) { return { licensed: false, machineId: '', expiresAt: null, daysLeft: null, reason: 'invalid', error: e?.message }; }
  });

  const resolveLocalDbPath = (localDbPathSetting: string) => {
    const custom = String(localDbPathSetting || '').trim();
    return custom ? path.resolve(custom) : path.join(ventAppDataPath, 'database.sqlite');
  };

  const startupConfig = readAppConfig();
  const currentDbType = startupConfig.currentDbType;
  const databaseUrlSetting = startupConfig.databaseUrlSetting;

  let finalDbUrl = '';
  if (currentDbType === 'LOCAL') {
    const localDbPath = resolveLocalDbPath(startupConfig.localDbPath);
    finalDbUrl = `file:${localDbPath}?connection_limit=1&busy_timeout=15000`;
  } else {
    finalDbUrl = databaseUrlSetting || "postgresql://postgres:gfhjkm1212@11.22.33.44:5432/pdm_system?schema=public";
  }

  process.env.DATABASE_URL = finalDbUrl;

  if (app.isPackaged && startupConfig.remoteServerUrl) {
    // Настроен сервер компании: встроенный Express не нужен — клиент ходит
    // на удалённый адрес (fetch-прокси и socket.io в рендерере), старт мгновенный
    console.log('[Electron Main] Режим сервера компании:', startupConfig.remoteServerUrl, '— встроенный сервер не запускается.');
  } else if (app.isPackaged) {
    // Встроенный Express поднимаем СРАЗУ и в ОТДЕЛЬНОМ процессе (utilityProcess):
    // - сервер грузится параллельно с отрисовкой окна — интро короче;
    // - главный процесс не блокируется на секунды (раньше синхронный require
    //   подвешивал окно: его нельзя было двигать, показ мог задержаться и
    //   пользователь видел пустой синий фон вместо заставки).
    const startupLogPath = path.join(ventAppDataPath, 'server-startup.log');
    const logStartup = (line: string) => {
      try { fs.appendFileSync(startupLogPath, `[${new Date().toISOString()}] ${line}\n`, 'utf-8'); } catch (e) {}
    };
    try {
      fs.writeFileSync(startupLogPath, `[${new Date().toISOString()}] Инициализация встроенного Express-сервера...\n`, 'utf-8');
    } catch (e) {}

    const serverPath = path.join(__dirname, '../dist/server.cjs');
    const serverStartedAt = Date.now();

    // Аварийный фоллбэк: если отдельный процесс не запустился/сразу упал —
    // поднимаем сервер в главном процессе, как раньше (пусть медленно, но работает)
    let fallbackDone = false;
    const requireServerInMain = (reason: string) => {
      if (fallbackDone) return;
      fallbackDone = true;
      logStartup(`Фоллбэк на запуск в главном процессе: ${reason}`);
      try {
        require(serverPath);
        logStartup('Модуль сервера успешно подключен через require() (fallback).');
      } catch (err: any) {
        console.error('[Electron Main] Сбой при автоматическом запуске встроенного Express-сервера:', err);
        logStartup(`СБОЙ ЗАПУСКА: ${err.message}\nStack:\n${err.stack}`);
      }
    };

    try {
      const serverProc = utilityProcess.fork(serverPath, [], {
        env: { ...process.env },
        stdio: 'pipe',
        serviceName: 'flux-embedded-server',
      });
      serverProc.stdout?.on('data', (d: any) => logStartup(`[server] ${String(d).trimEnd()}`));
      serverProc.stderr?.on('data', (d: any) => logStartup(`[server:err] ${String(d).trimEnd()}`));
      serverProc.on('spawn', () => logStartup('Серверный процесс запущен (utilityProcess).'));
      serverProc.once('exit', (code: number) => {
        logStartup(`Серверный процесс завершился с кодом ${code}.`);
        // Ненулевой выход в первые секунды = сервер не поднялся — пробуем по-старому
        if (code !== 0 && Date.now() - serverStartedAt < 20000) {
          requireServerInMain(`utilityProcess завершился с кодом ${code}`);
        }
      });
      app.on('will-quit', () => { try { serverProc.kill(); } catch (e) {} });
    } catch (err: any) {
      requireServerInMain(`utilityProcess.fork недоступен: ${err?.message || err}`);
    }
  }

  try {
    const localPrisma = createDbClient(currentDbType, finalDbUrl);
    
    // PostgreSQL database connection check & safe Auto-Seed
    (async () => {
      try {
        if (currentDbType === 'LOCAL') {
          console.log('[Electron Main] Portable SQLite mode: Startup connection check skipped in Main process.');
          return;
        }
        console.log('[Electron Main] Connecting to PostgreSQL and checking users...');
        const count = await localPrisma.user.count();
        if (count === 0) {
          await localPrisma.user.create({
            data: {
              name: 'Главный Администратор (RaupovKhKh)',
              symbol: 'RaupovKhKh',
              password: '1122',
              role: 'ADMIN',
            }
          });
          console.log('[Electron Main] Auto-seeded initial ADMIN user (RaupovKhKh).');
        } else {
          console.log('[Electron Main] Database count check complete. Seeding not required.');
        }
      } catch (err: any) {
        console.warn('[Electron Main] Connection/seeding skipped or failed:', err);
      } finally {
        try {
          await localPrisma.$disconnect();
        } catch (disErr) {}
      }
    })();
  } catch (dbErr) {
    console.warn('[Electron Main] Prisma client module loading skipped inside Electron main process context:', dbErr);
  }

  // --- DATABASE FILE DIALOG HANDLER ---
  // Управление окном (кастомный заголовок, frame:false). Кнопки заголовка
  // действуют на то окно, откуда пришли (главное или вынесенное) — поэтому
  // берём окно отправителя, а не единственный mainWindow.
  const senderWin = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) =>
    BrowserWindow.fromWebContents(event.sender) || mainWindow;
  ipcMain.on('window:minimize', (event) => { senderWin(event)?.minimize(); });
  ipcMain.on('window:maximize', (event) => {
    const w = senderWin(event);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
  });
  ipcMain.on('window:close', (event) => { senderWin(event)?.close(); });
  ipcMain.handle('window:is-maximized', (event) => !!senderWin(event)?.isMaximized());

  /**
   * Автозапуск вместе с Windows.
   *
   * Состояние всегда спрашиваем у системы, а не помним своё: автозапуск могли
   * снять снаружи — диспетчером задач или уборкой автозагрузки, — и галочка,
   * рассказывающая о своём прошлом решении, хуже отсутствующей.
   *
   * Свёрнутый запуск — отдельным доводом: программа затем и стартует с
   * системой, чтобы уведомления приходили с утра, а не с первого открытия
   * окна.
   */
  /**
   * Уведомление на рабочий стол Windows.
   *
   * Показывается только тогда, когда об этом просит окно: решение «сейчас
   * человек смотрит не сюда» принимает рендерер (src/lib/systemNotify.ts) —
   * он один знает и про тихий режим, и про настройки категорий.
   *
   * Нажатие возвращает окно и открывает то самое место: уведомление, после
   * которого приходится искать, о чём оно было, только отнимает время.
   */
  ipcMain.handle('notify:system', (_event, payload: { title: string; body: string; route?: string }) => {
    try {
      if (!Notification.isSupported()) return false;
      const n = new Notification({
        title: String(payload?.title || 'Flux'),
        body: String(payload?.body || ''),
        icon: nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_PNG}`),
        silent: false,
      });
      n.on('click', () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
        if (payload?.route) mainWindow.webContents.send('notify:open', payload.route);
      });
      n.show();
      return true;
    } catch (_) { return false; }
  });

  /** Столько же, сколько в трее самой программы: два разных числа хуже одного */
  ipcMain.handle('notify:badge', (_event, count: number) => {
    try {
      const n = Math.max(0, Math.floor(Number(count) || 0));
      app.setBadgeCount(n);
      mainWindow?.setOverlayIcon?.(null, n ? `${n} непрочитанных` : '');
      return true;
    } catch (_) { return false; }
  });

  /** Свёрнуто ли окно и в фокусе ли оно — по этому рендерер и решает */
  ipcMain.handle('notify:window-state', () => ({
    minimized: !!mainWindow?.isMinimized(),
    focused: !!mainWindow?.isFocused(),
  }));

  /**
   * Какой файл прописывать в автозапуск.
   *
   * У портативной программы process.execPath — не тот файл, который человек
   * запускал: portable-сборка распаковывает себя во временную папку вида
   * …\Temp\3IWzySU76g5tkaPVRvtQi9B5Ged\Flux.exe, и папка эта исчезает при
   * выходе, а в следующий раз называется иначе. Автозапуск, прописанный на
   * такой путь, просто ничего не запускает: Windows молча пропускает запись,
   * ведущую в никуда. Ошибки при этом нет нигде — галочка стоит, а программа
   * не стартует. Именно так автозапуск и «не работал».
   *
   * PORTABLE_EXECUTABLE_FILE ставит сам запускающий модуль portable-сборки, и
   * это ровно тот exe, который лежит у человека на рабочем столе.
   */
  const startupExe = (): string => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;

  /** Настройки автозапуска спрашиваем про тот же файл, что и прописываем */
  const loginItemFor = (args: string[]) => ({ path: startupExe(), args });

  ipcMain.handle('startup:get', () => {
    try {
      const s = app.getLoginItemSettings(loginItemFor([]));
      const sMin = app.getLoginItemSettings(loginItemFor(['--minimized']));
      return {
        enabled: !!(s.openAtLogin || sMin.openAtLogin),
        minimized: !!sMin.openAtLogin,
        path: startupExe(),
      };
    } catch (_) { return { enabled: false, minimized: false, path: '' }; }
  });

  ipcMain.handle('startup:set', (_event, opts: { enabled: boolean; minimized?: boolean }) => {
    try {
      const args = opts?.minimized ? ['--minimized'] : [];
      // Снимаем обе возможные записи и ставим одну нужную: иначе смена
      // «свёрнуто/развёрнуто» оставляла бы в автозапуске две строки, и
      // программа поднималась бы дважды
      app.setLoginItemSettings({ ...loginItemFor([]), openAtLogin: false });
      app.setLoginItemSettings({ ...loginItemFor(['--minimized']), openAtLogin: false });
      if (opts?.enabled) {
        app.setLoginItemSettings({ ...loginItemFor(args), openAtLogin: true });
      }
      const s = app.getLoginItemSettings(loginItemFor(args));
      return { enabled: !!s.openAtLogin, minimized: !!opts?.minimized, path: startupExe() };
    } catch (_) { return { enabled: false, minimized: false, path: '' }; }
  });

  // Вынести раздел в отдельное окно (мультимонитор): полноценное главное окно,
  // открытое на нужном разделе. Своё меню, свои панели, тоже делится на панели.
  ipcMain.on('window:open-main', (_event, route: string) => {
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 960,
      minHeight: 620,
      backgroundColor: '#0f172a',
      autoHideMenuBar: true,
      frame: false,
      titleBarStyle: 'hidden',
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
      },
    });
    const hash = `#${route && route.startsWith('/') ? route : '/' + (route || '')}`;
    if (app.isPackaged) {
      win.loadURL(`file://${path.join(__dirname, '../dist/index.html')}${hash}`);
    } else {
      win.loadURL(`http://localhost:3000/${hash}`);
    }
    win.once('ready-to-show', () => win.show());
    setTimeout(() => { try { win.show(); } catch (_) {} }, 10000);
    win.on('maximize', () => win.webContents.send('window:maximized-changed', true));
    win.on('unmaximize', () => win.webContents.send('window:maximized-changed', false));
  });

  ipcMain.handle('database:select-file', async () => {
    const { dialog } = require('electron');
    try {
      const result = await dialog.showOpenDialog({
        title: 'Укажите файл локальной базы данных SQLite',
        buttonLabel: 'Выбрать БД',
        properties: ['openFile', 'createDirectory', 'promptToCreate'],
        filters: [
          { name: 'Локальная база данных SQLite (*.sqlite; *.db)', extensions: ['sqlite', 'db'] },
          { name: 'Все файлы (*.*)', extensions: ['*'] }
        ]
      });
      if (result && !result.canceled && result.filePaths.length > 0) {
        return result.filePaths[0];
      }
    } catch (err) {
      console.error('Error opening native file dialog:', err);
    }
    return null;
  });

  // Открытие диалогового окна выбора директории
  ipcMain.handle('dialog:openDirectory', async () => {
    const { dialog } = require('electron');
    try {
      const result = await dialog.showOpenDialog({
        title: 'Выберите директорию для новой базы данных SQLite',
        buttonLabel: 'Выбрать папку',
        properties: ['openDirectory', 'createDirectory']
      });
      if (result && !result.canceled && result.filePaths.length > 0) {
        return result.filePaths[0];
      }
    } catch (err) {
      console.error('Error opening native directory dialog:', err);
    }
    return null;
  });

  // Открытие диалогового окна выбора существующего файла базы данных SQLite (.sqlite)
  ipcMain.handle('dialog:openFile', async () => {
    const { dialog } = require('electron');
    try {
      const result = await dialog.showOpenDialog({
        title: 'Выберите существующий файл базы данных SQLite',
        buttonLabel: 'Выбрать файл',
        properties: ['openFile'],
        filters: [
          { name: 'Локальная база данных SQLite (*.sqlite; *.db)', extensions: ['sqlite', 'db'] },
          { name: 'Все файлы (*.*)', extensions: ['*'] }
        ]
      });
      if (result && !result.canceled && result.filePaths.length > 0) {
        return result.filePaths[0];
      }
    } catch (err) {
      console.error('Error opening native file dialog:', err);
    }
    return null;
  });

  // --- LOGGING SYSTEM IPC HANDLERS ---
  // Метка времени для имен файлов логов: дата + часы-минуты-секунды
  const buildLogTimestamp = () => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  };

  /**
   * Сохранить файл на диск Windows обычным окном сохранения.
   *
   * Один обработчик на всю программу, а не кнопка в каждом разделе: выгрузка
   * книги, документа Word и журнала — одно и то же действие с точки зрения
   * человека, и вести себя оно должно одинаково.
   *
   * `dir` — папка, из которой файл когда-то принесли: программа предлагает
   * вернуть его туда же, чтобы файл, который ходит туда-сюда, ходил по одной
   * тропинке, а не расползался копиями по всему диску.
   */
  ipcMain.handle('files:save-as', async (_event, p: { name: string; base64: string; dir?: string }) => {
    const { dialog } = require('electron');
    const fs = require('fs');
    const path = require('path');
    try {
      const name = String(p?.name || 'Документ');
      const ext = (name.split('.').pop() || '').toLowerCase();
      const suggested = p?.dir ? path.join(String(p.dir), name) : name;
      const result = await dialog.showSaveDialog({
        title: 'Сохранить в Windows',
        defaultPath: suggested,
        filters: [
          ...(ext ? [{ name: `Файл ${ext.toUpperCase()} (*.${ext})`, extensions: [ext] }] : []),
          { name: 'Все файлы (*.*)', extensions: ['*'] },
        ],
      });
      if (!result || result.canceled || !result.filePath) return { success: false, canceled: true };
      fs.writeFileSync(result.filePath, Buffer.from(String(p?.base64 || ''), 'base64'));
      return { success: true, filePath: result.filePath };
    } catch (err: any) {
      return { success: false, error: String(err?.message || err) };
    }
  });

  /**
   * Открыть файл тем, чем его открывает Windows.
   *
   * Для чертежей САПР, архивов, моделей — всего, для чего своей программы у
   * нас нет и не будет. Раньше такой файл упирался в значок с подписью «Файл»:
   * человек видел его в Проводнике и ничего не мог с ним сделать.
   *
   * Файл кладётся во ВРЕМЕННУЮ папку программы и открывается оттуда. Своим
   * файлом он при этом не становится: правки в нём в Flux не вернутся, и об
   * этом сказано прямо — иначе человек правил бы копию, считая, что правит
   * оригинал.
   *
   * `shell.openPath` зовётся только на путь внутри этой папки: имя приходит из
   * записи файла, а имя может быть каким угодно — включая «..\..\что-нибудь».
   */
  ipcMain.handle('files:open-external', async (_event, p: { name: string; base64: string }) => {
    const { shell, app: electronApp } = require('electron');
    const fs = require('fs');
    const path = require('path');
    try {
      const dir = path.join(electronApp.getPath('temp'), 'flux-open');
      fs.mkdirSync(dir, { recursive: true });
      const safe = String(p?.name || 'файл').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'файл';
      const full = path.join(dir, safe);
      // Путь обязан лежать внутри временной папки: имя пришло из базы, а туда
      // его когда-то записал человек
      if (!path.resolve(full).startsWith(path.resolve(dir) + path.sep)) {
        return { success: false, error: 'Недопустимое имя файла' };
      }
      fs.writeFileSync(full, Buffer.from(String(p?.base64 || ''), 'base64'));
      const why = await shell.openPath(full);
      if (why) return { success: false, error: String(why) };
      return { success: true, filePath: full };
    } catch (err: any) {
      return { success: false, error: String(err?.message || err) };
    }
  });

  ipcMain.handle('log:save-dialog', async (event, text: string) => {
    const { dialog } = require('electron');
    const fs = require('fs');
    try {
      const result = await dialog.showSaveDialog({
        title: 'Экспорт журнала логов',
        defaultPath: `pdm_action_log_${buildLogTimestamp()}.txt`,
        filters: [
          { name: 'Текстовый файл (*.txt)', extensions: ['txt'] },
          { name: 'Все файлы (*.*)', extensions: ['*'] }
        ]
      });
      if (result && !result.canceled && result.filePath) {
        fs.writeFileSync(result.filePath, text, 'utf-8');
        return { success: true, filePath: result.filePath };
      }
    } catch (err) {
      console.error('Error saving log file via electron main:', err);
      return { success: false, error: String(err) };
    }
    return { success: false };
  });

  ipcMain.on('log:emergency-save', (event, text: string) => {
    try {
      const fileName = `pdm-crash-log-${buildLogTimestamp()}.txt`;

      // Папка из настроек (config.json -> crash_log_dir); по умолчанию AppData/pdm-app/logs,
      // чтобы не засорять рабочий стол
      const cfg = readAppConfig();
      let targetDir = String(cfg.crashLogDir || '').trim();
      if (!targetDir) {
        targetDir = path.join(ventAppDataPath, 'logs');
      }
      try {
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }
      } catch (mkErr) {
        targetDir = path.join(ventAppDataPath, 'logs');
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }
      }

      const targetPath = path.join(targetDir, fileName);
      fs.writeFileSync(targetPath, text, 'utf-8');
      console.log(`[Emergency Log Saved] Saved crash log to: ${targetPath}`);
    } catch (err) {
      console.error('Failed to write emergency log inside electron main:', err);
    }
  });

  // --- ЛОКАЛЬНЫЕ IPC-ВОЗМОЖНОСТИ ---
  // Чат полностью переведён на сервер (HTTP + socket.io): обработчики с прямым
  // доступом к БД из главного процесса удалены — они шли мимо сервера (события
  // не рассылались, вложения писались на диск отправителя). Здесь остались
  // только по-настоящему локальные возможности Electron.

  // Легаси: открытие СТАРЫХ вложений чата, сохранённых прежними версиями
  // на диск этой машины (новые вложения живут на сервере и открываются по URL)
  ipcMain.handle('chat:open-file', async (event, filePath) => {
    const { shell } = require('electron');
    try {
      // Открываем только вложения чата (каталог chat_files), а не произвольный путь
      const chatDir = path.resolve(path.join(app.getPath('userData'), 'chat_files'));
      const resolved = path.resolve(String(filePath || ''));
      if (resolved !== chatDir && !resolved.startsWith(chatDir + path.sep)) {
        return { success: false, error: 'Недопустимый путь к файлу.' };
      }
      if (fs.existsSync(resolved)) {
        await shell.openPath(resolved);
        return { success: true };
      }
      return { success: false, error: 'Файл не найден на системном диске.' };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('shell:open-external', async (event, url) => {
    const { shell } = require('electron');
    try {
      let raw = String(url || '').trim();
      // Ссылка без схемы трактуется как http(s)
      if (raw && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) raw = 'https://' + raw;
      const parsed = new URL(raw);
      // Разрешаем только безопасные протоколы (не file:, не пользовательские схемы)
      if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
        return { success: false, error: 'Недопустимый протокол ссылки.' };
      }
      await shell.openExternal(raw);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // PDF из готового HTML (печатный вид Конструктора): скрытое окно →
  // printToPDF → диалог сохранения. Векторный PDF без внешних зависимостей.
  // headerTemplate/footerTemplate — колонтитулы Chromium: спаны с классами
  // pageNumber/totalPages дают настоящую нумерацию страниц («Стр. 3 из 12»).
  ipcMain.handle('print:to-pdf', async (_event, { html, title, landscape, headerTemplate, footerTemplate }: {
    html: string; title?: string; landscape?: boolean; headerTemplate?: string; footerTemplate?: string;
  }) => {
    const { dialog } = require('electron');
    const pdfWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    try {
      await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(String(html || '')));
      const hasHf = !!(headerTemplate || footerTemplate);
      const pdf = await pdfWin.webContents.printToPDF({
        landscape: !!landscape,
        printBackground: true,
        ...(hasHf ? {
          displayHeaderFooter: true,
          headerTemplate: String(headerTemplate || '<span></span>'),
          footerTemplate: String(footerTemplate || '<span></span>'),
          // Поля, чтобы колонтитулы не наезжали на текст
          margins: { top: 0.6, bottom: 0.6, left: 0.4, right: 0.4 },
        } : {}),
      });
      const result = await dialog.showSaveDialog({
        title: 'Сохранить PDF',
        defaultPath: `${String(title || 'Документ').replace(/[\\/:*?"<>|]/g, '_')}.pdf`,
        filters: [{ name: 'PDF (*.pdf)', extensions: ['pdf'] }],
      });
      if (result.canceled || !result.filePath) return { success: false, canceled: true };
      fs.writeFileSync(result.filePath, pdf);
      return { success: true, filePath: result.filePath };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    } finally {
      try { pdfWin.destroy(); } catch (e) {}
    }
  });

  // Выгрузка документа в Ворд: диалог «Сохранить как», как у самого Ворда.
  // Через браузерное скачивание не делаем — Chromium теряет кириллицу в имени
  // файла, если у системы не задана локаль, и файл приходит как «download».
  ipcMain.handle('doc:save-word', async (_event, { html, title }: { html: string; title?: string }) => {
    const { dialog } = require('electron');
    try {
      const safe = String(title || 'Документ').replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 80) || 'Документ';
      const result = await dialog.showSaveDialog({
        title: 'Сохранить документ Word',
        defaultPath: `${safe}.doc`,
        filters: [{ name: 'Документ Word (*.doc)', extensions: ['doc'] }],
      });
      if (result.canceled || !result.filePath) return { success: false, canceled: true };
      // BOM: по нему Ворд понимает кодировку и не показывает кракозябры
      fs.writeFileSync(result.filePath, '﻿' + String(html || ''), 'utf-8');
      return { success: true, filePath: result.filePath };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  });

  // Захват экрана (вставка скриншота в чат)
  ipcMain.handle('desktop:capture', async () => {
    const { desktopCapturer } = require('electron');
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 1280, height: 720 } });
    if (sources.length > 0) {
      return sources[0].thumbnail.toDataURL();
    }
    throw new Error('Источники видеозахвата не найдены.');
  });

  // ── Автообновления через сервер ──
  // Проверка и публикация релизов идут через HTTP API сервера (см. UpdaterWidget):
  // рендерер сам знает адрес сервера и токен сессии. Главному процессу остаются
  // две вещи, которые из рендерера не сделать: скачать большой exe на диск и
  // подменить работающий портативный exe новым.
  let latestCachedUpdate: { version: string; installerPath: string } | null = null;

  /** Отказ — словами, а не кодом: человек читает это в окне и в журнале */
  const errorText = (err: any, from = ''): string => {
    const status = Number(err?.statusCode || 0);
    if (status) return downloadError(status, String(err?.message || ''), from);
    return String(err?.message || err || 'Неизвестная ошибка');
  };

  function downloadUpdate(
    url: string, dest: string, onProgress: (percent: number) => void, headers?: Record<string, string>,
  ): Promise<void> {
    const fs = require('fs');
    const https = require('https');
    const http = require('http');

    return new Promise((resolve, reject) => {
      let redirectCount = 0;

      function startGet(requestUrl: string) {
        let parsed: URL;
        try {
          parsed = new URL(requestUrl);
        } catch (_) {
          reject(new Error(`Адрес обновления не разобрать: ${requestUrl}`));
          return;
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          reject(new Error(`Обновление можно скачать только по http или https, а адрес такой: ${requestUrl}`));
          return;
        }

        const protocol = parsed.protocol === 'https:' ? https : http;
        const req = protocol.get(requestUrl, { headers: headers || {} }, (res: any) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (redirectCount > 5) { reject(new Error('Сервер уводит запрос по кругу.')); return; }
            redirectCount++;
            const next = new URL(res.headers.location, requestUrl).toString();
            res.resume();
            startGet(next);
            return;
          }

          if (res.statusCode !== 200) {
            /**
             * Тело отказа читаем и передаём наверх. Сервер Flux объясняет
             * причину словами («Файл этой версии не найден»), и потерять это
             * объяснение ради «status code 404» — значит оставить человека
             * гадать, что делать.
             */
            let said = '';
            res.setEncoding('utf8');
            res.on('data', (c: string) => { if (said.length < 400) said += c; });
            res.on('end', () => {
              let text = said;
              try { text = JSON.parse(said)?.error || said; } catch (_) { /* не JSON — как есть */ }
              const err: any = new Error(text);
              err.statusCode = res.statusCode;
              reject(err);
            });
            return;
          }

          const total = parseInt(res.headers['content-length'] || '0', 10);
          let got = 0;
          const fileStream = fs.createWriteStream(dest);
          res.on('data', (chunk: any) => {
            got += chunk.length;
            if (total > 0) onProgress(Math.min(100, Math.round((got / total) * 100)));
          });
          res.pipe(fileStream);
          fileStream.on('finish', () => { fileStream.close(); resolve(); });
          fileStream.on('error', (err: any) => { fs.unlink(dest, () => {}); reject(err); });
        });

        req.on('error', (err: any) => reject(err));
        // Сервер, который принял соединение и замолчал, иначе держал бы окно
        // «Скачиваю… 0 %» бесконечно
        req.setTimeout(120000, () => { req.destroy(new Error('Сервер обновлений не отвечает.')); });
      }

      startGet(url);
    });
  }

  /** Первые два байта файла: у любой программы Windows это «MZ» */
  function headBytes(file: string, n = 2): number[] {
    const fs = require('fs');
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, 0);
      fs.closeSync(fd);
      return Array.from(buf);
    } catch (_) { return []; }
  }

  /**
   * Скачивание файла обновления на диск.
   *
   * Проверок здесь две, и обе появились не от осторожности. Первая: заголовок
   * с токеном уходит ТОЛЬКО на свой сервер — чужой хост отвечал на него
   * отказом, и обновление по прямой ссылке не скачивалось вовсе (а токен
   * сотрудника уезжал наружу). Вторая: скачанное проверяется на то, что это
   * действительно программа, — страница с ошибкой приходит с кодом 200 и без
   * проверки легла бы на место работающего exe.
   */
  ipcMain.handle('updater:start-download', async (_event, payload: {
    url: string; version: string; token?: string; server?: string;
  }) => {
    const path = require('path');
    const fs = require('fs');

    const url = String(payload?.url || '');
    const version = String(payload?.version || '').replace(/[^0-9a-zA-Z.\-]/g, '');
    if (!url || !version) throw new Error('Не переданы адрес или версия обновления.');

    const installerPath = path.join(app.getPath('temp'), `Flux-${version}.exe`);
    appendLog('INFO', 'Обновление', `Скачиваю ${version}: ${url}`);
    mainWindow?.webContents.send('updater:status', 'downloading', { percent: 0 });

    const headers: Record<string, string> = {};
    if (payload?.token && sameServer(url, String(payload?.server || ''))) {
      headers['Authorization'] = `Bearer ${payload.token}`;
    }

    try {
      let lastPercent = -1;
      await downloadUpdate(url, installerPath, (percent) => {
        if (percent !== lastPercent) {
          lastPercent = percent;
          mainWindow?.webContents.send('updater:status', 'downloading', { percent });
        }
      }, headers);

      mainWindow?.webContents.send('updater:status', 'verifying', {});
      const size = fs.existsSync(installerPath) ? fs.statSync(installerPath).size : 0;
      const bad = badPackage(headBytes(installerPath), size);
      if (bad) {
        try { fs.unlinkSync(installerPath); } catch (_) { /* уже нет */ }
        throw new Error(bad);
      }

      latestCachedUpdate = { version, installerPath };
      appendLog('INFO', 'Обновление', `Скачано ${version}, ${Math.round(size / 1048576)} МБ`);
      mainWindow?.webContents.send('updater:status', 'downloaded', { version });
      return { success: true };
    } catch (err: any) {
      // Называем сервер, у которого спрашивали: без этого «файла нет» не
      // отличить от «загрузили не на тот сервер»
      let host = '';
      try { host = new URL(url).origin; } catch (_) { host = url; }
      const text = errorText(err, host);
      appendLog('ERROR', 'Обновление', `Не скачалось ${version} с ${host}: ${text}`);
      mainWindow?.webContents.send('updater:error', text);
      throw new Error(text);
    }
  });

  /**
   * Установка скачанного с перезапуском.
   *
   * Портативный exe не может переписать сам себя, пока работает. Раньше подмену
   * делал временный cmd-файл, и человек видел окно командной строки, которое не
   * закрывалось само: `detached` и `windowsHide` на Windows несовместимы — при
   * `DETACHED_PROCESS` консоль появляется, о чём ни проси. А если `move` не
   * удавался (файл ещё занят уходящей программой), повтора не было вовсе:
   * человек оставался на старой версии, считая, что обновился.
   *
   * Теперь подмену делает САМА новая версия: скачанный exe запускается с
   * доводом `--flux-apply-update`, ждёт ухода этой программы, кладёт себя на её
   * место и запускает. Это графическая программа — консоли у неё не бывает
   * никогда, а повторы и внятный отказ живут в electron/applyUpdate.ts.
   */
  ipcMain.handle('updater:quitAndInstall', () => {
    const fs = require('fs');
    const { spawn } = require('child_process');

    if (!latestCachedUpdate) {
      return { success: false, error: 'Обновление ещё не скачано.' };
    }
    const installerPath = latestCachedUpdate.installerPath;
    if (!fs.existsSync(installerPath)) {
      return { success: false, error: 'Файл обновления не найден на диске — скачайте заново.' };
    }

    try {
      // Тот файл, который человек запускал (у portable-сборки это не execPath)
      const portableExe = process.env.PORTABLE_EXECUTABLE_FILE || '';

      if (portableExe && fs.existsSync(portableExe)) {
        // Синхронно: следом программа выходит, сбросить очередь будет негде
        appendLogNow('INFO', 'Обновление', `Подменяю программу: ${portableExe}`);
        const child = spawn(installerPath, applyArgs(portableExe, process.pid), {
          detached: true, stdio: 'ignore', windowsHide: true,
        });
        child.unref();
      } else {
        appendLogNow('INFO', 'Обновление', 'Портативный файл не найден — запускаю установщик');
        const child = spawn(installerPath, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
      }

      // Окно убираем сразу, не дожидаясь выхода: человек нажал одну кнопку и
      // должен увидеть, что дело пошло, а не гадать, услышали ли его
      try { mainWindow?.hide(); } catch (_) { /* окна может уже не быть */ }
      // Выходим следом: помощник ждёт именно этого, чтобы освободить файл
      setTimeout(() => app.exit(0), 400);
      return { success: true };
    } catch (err: any) {
      appendLog('ERROR', 'Обновление', `Не удалось запустить подмену: ${err?.message || err}`);
      return { success: false, error: errorText(err) };
    }
  });

  /** Портативная ли сборка: от этого зависит, что обещать человеку */
  ipcMain.handle('updater:is-portable', () => {
    const fs = require('fs');
    const exe = process.env.PORTABLE_EXECUTABLE_FILE || '';
    return { portable: !!exe && fs.existsSync(exe), path: exe };
  });

  // Get app package status or information
  ipcMain.handle('updater:is-packaged', () => {
    return app.isPackaged;
  });

  ipcMain.handle('updater:version', () => {
    return app.getVersion() || '1.0.0';
  });

  // --- STICKER SUB-WINDOW PROVISIONING (STEP 4) ---
  ipcMain.on('window:open-sticker', (event, noteId) => {
    const stickerWin = new BrowserWindow({
      width: 320,
      height: 380,
      frame: false,            // Полностью убирает рамки Windows (заголовок, кнопки сворачивания)
      alwaysOnTop: true,       // КРИТИЧЕСКИ: Окно всегда зафиксировано поверх всех окон в ОС!
      transparent: false,      // Для стабильного отображения контента
      resizable: true,         // Инженер может растягивать стикер за края
      skipTaskbar: true,       // Не засоряет панель задач Windows
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
      }
    });

    // Загружаем фронтенд с хэш-роутом или query-параметром для отображения конкретной заметки
    // В Vite/React-router используй путь, например: `/sticker?id=${noteId}`
    if (app.isPackaged) {
      stickerWin.loadURL(`file://${path.join(__dirname, '../dist/index.html')}#/sticker?id=${noteId}`);
    } else {
      stickerWin.loadURL(`http://localhost:3000/#/sticker?id=${noteId}`);
    }
  });

});

app.on('window-all-closed', () => {
  app.quit();
});

