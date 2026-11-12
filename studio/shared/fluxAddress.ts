/**
 * Адрес общей базы у лежащего рядом Flux.
 *
 * Flux хранит подключение в config.json своей папки данных (`pdm-app`): `current_db_type` и `database_url`
 * (electron/main.ts, electron/connectionConfig.ts). Studio читает тот же файл, чтобы разработчику не вводить
 * адрес с паролем второй раз. Файл только читается и никуда не пишется; пароль в окно не уходит —
 * окну отдаётся описание «сервер/база». Ручной ввод адреса остаётся запасным путём.
 *
 * Чистая часть без обращения к диску: пути-кандидаты и разбор содержимого; чтение файла делает вызывающий.
 */
import path from 'node:path';

export interface FluxAddress {
  /** Найден ли пригодный адрес */
  found: boolean;
  /** Сам адрес (с паролем): остаётся в главном процессе */
  uri: string;
  /** Что показать человеку: сервер и база без пароля */
  display: string;
  /** Почему адрес не взят, словами; пусто, если найден */
  reason: string;
  /** Откуда прочитан (путь к config.json) */
  source: string;
}

const none = (reason: string, source = ''): FluxAddress => ({ found: false, uri: '', display: '', reason, source });

/** Папка данных Flux: та же, что в electron/main.ts (APPDATA, иначе ~/Library/Application Support или ~/.config) */
export function fluxDataDirs(env: Record<string, string | undefined>, platform: string, home: string): string[] {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const bases = [
    env.APPDATA || (platform === 'darwin' ? join(home, 'Library', 'Application Support') : join(home, '.config')),
  ];
  // Запасная папка Flux, если базовую вычислить не удалось (electron/main.ts: ~/pdm-app)
  const dirs = bases.map(base => join(base, 'pdm-app'));
  dirs.push(join(home, 'pdm-app'));
  return [...new Set(dirs)];
}

/** Описание базы без пароля: «сервер:порт/база» */
export function describeDatabase(uri: string): string {
  try {
    const url = new URL(uri);
    const kind = /^postgres/.test(url.protocol) ? 'PostgreSQL' : 'MariaDB / MySQL';
    const port = url.port || (kind === 'PostgreSQL' ? '5432' : '3306');
    return `${kind} · ${url.hostname}:${port}/${decodeURIComponent(url.pathname.slice(1))}`;
  } catch { return ''; }
}

/**
 * Разбирает config.json Flux. `accept` — проверка адреса самой Studio (какие базы она умеет подключать):
 * бросает ошибку с причиной словами либо возвращает приведённый адрес.
 */
export function parseFluxConfig(content: string, accept: (uri: string) => string, source = ''): FluxAddress {
  let config: any;
  try { config = JSON.parse(content); } catch { return none('Файл настроек Flux не читается.', source); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return none('Файл настроек Flux не читается.', source);
  if (config.current_db_type !== 'REMOTE') return none('Flux на этом компьютере работает с локальной базой, а Studio подключается к общей: введите адрес общей базы.', source);
  const raw = typeof config.database_url === 'string' ? config.database_url.trim() : '';
  if (!raw) return none('В настройках Flux адрес общей базы не указан.', source);
  let uri: string;
  try { uri = accept(raw); } catch (error: any) { return none(String(error?.message || 'Адрес из настроек Flux не подходит.').replace(/\s*Образец:.*$/, ''), source); }
  return { found: true, uri, display: describeDatabase(uri), reason: '', source };
}

/**
 * Ищет адрес у Flux: первая папка данных, где есть config.json. `read` возвращает текст файла или null, если файла нет.
 * Папки перебираются по порядку; если файл в первой папке есть, но адреса в нём нет, дальше не ищем:
 * другой Flux с другим адресом — это уже неоднозначность, которую человек разрешает вводом вручную.
 */
export function findFluxAddress(options: {
  env: Record<string, string | undefined>; platform: string; home: string;
  read: (file: string) => string | null; accept: (uri: string) => string;
}): FluxAddress {
  const join = options.platform === 'win32' ? path.win32.join : path.posix.join;
  for (const dir of fluxDataDirs(options.env, options.platform, options.home)) {
    const file = join(dir, 'config.json');
    let content: string | null;
    try { content = options.read(file); } catch { content = null; }
    if (content !== null) return parseFluxConfig(content, options.accept, file);
  }
  return none('Рядом со Studio настроек Flux не найдено: введите адрес общей базы.');
}
