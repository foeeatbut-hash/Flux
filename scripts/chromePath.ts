/**
 * Поиск Chromium/Chrome для наборов интерфейса.
 *
 * Номер сборки Playwright в образе меняется (chromium-1194 -> chromium-1243),
 * и зашитый в скрипт путь молча превращал набор в пропуск или падение.
 * Порядок: FLUX_CHROME (так задан в CI) -> первый существующий
 * /opt/pw-browsers/chromium-<номер>/chrome-linux64|chrome-linux/chrome
 * (новейшая сборка первой) -> системный chromium -> стандартные пути
 * Chrome/Edge на Windows.
 */
import fs from 'node:fs';
import path from 'node:path';

const PW_ROOT = '/opt/pw-browsers';

function pwCandidates(): string[] {
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(PW_ROOT).filter((d) => /^chromium-\d+$/.test(d)); } catch { /* каталога нет */ }
  dirs.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  const out: string[] = [];
  for (const d of dirs) for (const sub of ['chrome-linux64', 'chrome-linux']) out.push(path.join(PW_ROOT, d, sub, 'chrome'));
  return out;
}

function candidates(): string[] {
  const win = ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].flatMap((v) => {
    const base = process.env[v];
    return base ? [path.join(base, 'Google/Chrome/Application/chrome.exe'), path.join(base, 'Microsoft/Edge/Application/msedge.exe')] : [];
  });
  return [...pwCandidates(), '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', ...win];
}

/** Путь к браузеру или undefined, если его нет нигде. */
export function findChromeOrUndefined(): string | undefined {
  if (process.env.FLUX_CHROME) return process.env.FLUX_CHROME;
  return candidates().find((p) => fs.existsSync(p));
}

/**
 * Путь к браузеру. Если не найден — прежний путь по умолчанию: запуск упадёт
 * понятной ошибкой Playwright «Executable doesn't exist», а не молча.
 */
export function findChrome(): string {
  return findChromeOrUndefined() ?? '/usr/bin/chromium';
}
