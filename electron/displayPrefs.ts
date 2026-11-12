import fs from 'node:fs';

/**
 * Настройки мониторов в `display-workspace.json` в каталоге данных: режим
 * «Рабочий стол на всех мониторах» и выключатель «Нажатие по столу не выводит
 * Flux поверх других программ». Один файл на оба — как велело решение владельца
 * («там же, где остальные настройки мониторов»).
 *
 * Пишутся только известные ключи: чужие и устаревшие (раньше там жило скрытие
 * панели Windows) выпадают при первой записи. Выключатель хранится, только пока
 * он выключен: включённый по умолчанию файл не засоряет.
 */
export interface DisplayPrefs { allMonitors: boolean; deskStaysBack: boolean }

export function readDisplayPrefs(file: string): DisplayPrefs {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { allMonitors: saved?.allMonitors === true, deskStaysBack: saved?.deskStaysBack !== false };
  } catch { return { allMonitors: false, deskStaysBack: true }; }
}

/** Ошибка записи настроек не должна ломать работу: значение уже действует в памяти. */
export function writeDisplayPrefs(file: string, patch: Partial<DisplayPrefs>) {
  const next = { ...readDisplayPrefs(file), ...patch };
  const body: Record<string, boolean> = { allMonitors: next.allMonitors };
  if (!next.deskStaysBack) body.deskStaysBack = false;
  try { fs.writeFileSync(file, JSON.stringify(body), { mode: 0o600 }); } catch {}
}
