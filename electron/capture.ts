import {
  app, BrowserWindow, Tray, Menu, clipboard, globalShortcut, nativeImage, screen, ipcMain,
} from 'electron';
import path from 'path';
import crypto from 'crypto';
import { TRAY_ICON_PNG } from './trayIcon';
import { bringToFront } from './windowForeground';

/**
 * Захват с экрана: свёрнутый пульт, слежение за буфером, трей, горячая клавиша.
 * Разбор написанного здесь — docs/screen-capture-design.md.
 *
 * Главное, чего тут НЕТ: чтения выделения из чужого окна. В Windows такого
 * способа для Electron нет. Работаем от буфера обмена, но не ждём галочку
 * молча: пока режим включён, буфер опрашивается, и пульт сам сообщает, что
 * появилось. Инженеру остаётся выделить, скопировать и подтвердить.
 */

const PULT_W = 306;
const PULT_H = 172;
const MARGIN = 18;
const POLL_MS = 400;
/** Больше в разбор не тащим: окно перестанет отвечать, а пользы ноль */
const MAX_CHARS = 50000;

export interface CaptureItem {
  kind: 'text' | 'table' | 'image';
  /** Простой текст. Для картинки — пусто */
  text: string;
  /** Флейвор text/html: у копии из Excel и Word здесь настоящая таблица */
  html: string;
  /** Картинка как data:URL — уходит в OCR на стороне рендерера */
  image: string;
  /** Сколько знаков отрезали лимитом */
  truncated: number;
  at: number;
}

type PultState =
  | { name: 'idle' }
  | { name: 'stale' }
  | { name: 'ready'; kind: CaptureItem['kind']; lines: number; chars: number; cells: number;
      truncated: number; preview: string }
  | { name: 'basket'; count: number; lines: number };

let tray: Tray | null = null;
let pult: BrowserWindow | null = null;
let active = false;
let timer: NodeJS.Timeout | null = null;

/** Отпечаток буфера на момент входа в режим: защита от устаревшего содержимого */
/** Захват, ожидающий, пока рендерер за ним придёт */
let pending: { items: CaptureItem[] } | null = null;
let baseline = '';
let lastSeen = '';
let current: CaptureItem | null = null;
const basket: CaptureItem[] = [];

const hash = (s: string) => crypto.createHash('sha1').update(s).digest('hex');

/** Слепок буфера для сравнения. Картинку хешируем по размеру и первым байтам */
function clipboardFingerprint(): string {
  const formats = clipboard.availableFormats();
  if (formats.some((f) => f.startsWith('image/'))) {
    const img = clipboard.readImage();
    if (!img.isEmpty()) {
      const s = img.getSize();
      return hash(`img:${s.width}x${s.height}:` + img.toBitmap().subarray(0, 4096).toString('base64'));
    }
  }
  return hash('txt:' + clipboard.readText() + '|' + clipboard.readHTML());
}

function readClipboard(): CaptureItem | null {
  const formats = clipboard.availableFormats();

  if (formats.some((f) => f.startsWith('image/')) && !clipboard.readText().trim()) {
    const img = clipboard.readImage();
    if (!img.isEmpty()) {
      return { kind: 'image', text: '', html: '', image: img.toDataURL(), truncated: 0, at: Date.now() };
    }
  }

  const raw = clipboard.readText() || '';
  if (!raw.trim()) return null;

  const html = clipboard.readHTML() || '';
  // Таблицу узнаём по разметке или по табуляциям — из Excel приходит и то и другое
  const isTable = /<table[\s>]/i.test(html) || /\t/.test(raw);

  const text = raw.length > MAX_CHARS ? raw.slice(0, MAX_CHARS) : raw;
  return {
    kind: isTable ? 'table' : 'text',
    text,
    html: html.length > MAX_CHARS * 4 ? '' : html,
    image: '',
    truncated: Math.max(0, raw.length - text.length),
    at: Date.now(),
  };
}

function describe(item: CaptureItem | null): PultState {
  if (basket.length && !item) return { name: 'basket', count: basket.length, lines: basketLines() };
  if (!item) return baseline === lastSeen ? { name: 'stale' } : { name: 'idle' };
  const lines = item.text ? item.text.split(/\r?\n/).filter((l) => l.trim()).length : 0;
  const cells = item.kind === 'table'
    ? item.text.split(/\r?\n/).filter((l) => l.trim())
        .reduce((n, l) => n + l.split('\t').length, 0)
    : 0;
  // Первая строка захвата: инженеру надо видеть, что он вообще взял,
  // не разворачивая программу
  const preview = item.text.split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 60) || '';
  return { name: 'ready', kind: item.kind, lines, chars: item.text.length, cells, truncated: item.truncated, preview };
}

const basketLines = () =>
  basket.reduce((n, b) => n + (b.text ? b.text.split(/\r?\n/).filter((l) => l.trim()).length : 0), 0);

function pushState() {
  if (!pult || pult.isDestroyed()) return;
  const state = current ? describe(current) : describe(null);
  pult.webContents.send('capture:state', { state, basket: basket.length });
}

/** Опрос буфера. Дешевле и предсказуемее, чем ловить системные события копирования */
function tick() {
  if (!active) return;
  let fp = '';
  try { fp = clipboardFingerprint(); } catch { return; }
  if (fp === lastSeen) return;
  lastSeen = fp;
  if (fp === baseline) { current = null; pushState(); return; }
  try { current = readClipboard(); } catch { current = null; }
  pushState();
}

/** Где стоял пульт в прошлый раз. Файл, а не память: переживает перезапуск */
function posFile() {
  return path.join(app.getPath('userData'), 'capture-pult.json');
}
function savedPos(): { x: number; y: number } | null {
  try {
    const fs = require('fs');
    const raw = JSON.parse(fs.readFileSync(posFile(), 'utf-8'));
    if (typeof raw?.x === 'number' && typeof raw?.y === 'number') return { x: raw.x, y: raw.y };
  } catch {}
  return null;
}
function savePos(x: number, y: number) {
  try { require('fs').writeFileSync(posFile(), JSON.stringify({ x, y })); } catch {}
}

function placePult(win: BrowserWindow) {
  const saved = savedPos();
  if (saved) {
    // Монитор могли отключить — проверяем, что сохранённая точка ещё на экране
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return saved.x + PULT_W > a.x && saved.x < a.x + a.width
          && saved.y + PULT_H > a.y && saved.y < a.y + a.height;
    });
    if (onScreen) { win.setBounds({ x: saved.x, y: saved.y, width: PULT_W, height: PULT_H }); return; }
  }
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  // Именно workArea, а не bounds: иначе пульт уедет под панель задач
  const { x, y, width, height } = display.workArea;
  win.setBounds({
    x: Math.round(x + width - PULT_W - MARGIN),
    y: Math.round(y + height - PULT_H - MARGIN),
    width: PULT_W,
    height: PULT_H,
  });
}

function createPult() {
  if (pult && !pult.isDestroyed()) { pult.show(); return pult; }
  pult = new BrowserWindow({
    width: PULT_W,
    height: PULT_H,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Ключевое: окно не забирает фокус. Иначе клик по пульту снимает выделение
    // в чужом окне, а копирование ушло бы в пульт, а не в бланк
    focusable: false,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  pult.setAlwaysOnTop(true, 'screen-saver');
  placePult(pult);

  const hashRoute = '#/capture';
  if (process.env.NODE_ENV === 'development') pult.loadURL('http://localhost:3000/' + hashRoute);
  else pult.loadFile(path.join(__dirname, '../dist/index.html'), { hash: '/capture' });

  pult.once('ready-to-show', () => { pult?.showInactive(); pushState(); });
  pult.on('closed', () => { pult = null; });
  return pult;
}

export function setupCapture(getMain: () => BrowserWindow | null) {
  const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG, 'base64'));

  const start = () => {
    if (active) return;
    active = true;
    basket.length = 0;
    current = null;
    try { baseline = clipboardFingerprint(); } catch { baseline = ''; }
    lastSeen = baseline;
    getMain()?.hide();
    createPult();
    if (timer) clearInterval(timer);
    timer = setInterval(tick, POLL_MS);
    updateTrayMenu();
  };

  const stop = (showMain: boolean) => {
    active = false;
    if (timer) { clearInterval(timer); timer = null; }
    if (pult && !pult.isDestroyed()) pult.close();
    pult = null;
    current = null;
    basket.length = 0;
    if (showMain) {
      const m = getMain();
      if (m) bringToFront(m);
    }
    updateTrayMenu();
  };

  const confirm = () => {
    const items = [...basket];
    if (current) items.push(current);
    if (!items.length) return;
    const main = getMain();
    stop(true);
    // Захват кладём в ожидание, а не шлём сразу.
    //
    // Раньше отправляли `send` сразу после показа окна, и если рендерер в этот
    // момент ещё не поднялся (первый запуск, захват из трея на холодной
    // программе), сообщение уходило в никуда и захват пропадал молча.
    // Теперь рендерер забирает его сам: и по подсказке, и при своём появлении
    pending = { items };
    main?.webContents.send('capture:ready');
  };

  function updateTrayMenu() {
    if (!tray) return;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: active ? 'Прекратить захват' : 'Захват с экрана\tCtrl+Shift+X', click: () => (active ? stop(true) : start()) },
      { type: 'separator' },
      { label: 'Показать Flux', click: () => { const m = getMain(); if (m) bringToFront(m); } },
      { type: 'separator' },
      { label: 'Выход', click: () => { stop(false); app.quit(); } },
    ]));
  }

  try {
    tray = new Tray(icon);
    tray.setToolTip('Flux');
    // Без трея скрытое главное окно потерялось бы: показать его было бы нечем
    tray.on('click', () => { const m = getMain(); if (m) bringToFront(m); });
    updateTrayMenu();
  } catch (e) { tray = null; }

  try { globalShortcut.register('CommandOrControl+Shift+X', () => (active ? stop(true) : start())); } catch (e) {}

  ipcMain.on('capture:start', start);
  ipcMain.on('capture:cancel', () => stop(true));
  ipcMain.on('capture:confirm', confirm);
  ipcMain.on('capture:to-basket', () => {
    if (!current) return;
    basket.push(current);
    current = null;
    // Следующее копирование снова считается новым
    baseline = ' ';
    pushState();
  });
  // Рендерер забирает ожидающий захват: при своём появлении и по подсказке
  ipcMain.handle('capture:take-pending', () => {
    const p = pending;
    pending = null;
    return p;
  });
  ipcMain.handle('capture:sync', () => {
    const state = current ? describe(current) : describe(null);
    return { state, basket: basket.length };
  });
  ipcMain.on('capture:clear-basket', () => {
    basket.length = 0;
    pushState();
  });
  ipcMain.on('capture:move', (_e, dx: number, dy: number) => {
    if (!pult || pult.isDestroyed()) return;
    const b = pult.getBounds();
    const x = Math.round(b.x + dx);
    const y = Math.round(b.y + dy);
    pult.setBounds({ ...b, x, y });
    savePos(x, y);
  });

  app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (e) {} });
}
