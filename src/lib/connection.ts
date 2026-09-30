/**
 * Одно поле подключения на экране входа: что именно вставил человек.
 *
 * Раньше под формой входа было два вопроса — «адрес сервера программы» и
 * «база данных», — и каждый в своём окне с пятью полями. Их развели после
 * того, как строку подключения к базе вписали в поле сервера и программа
 * перестала работать (src/lib/serverUrl.ts). Но два окна — это лишние действия
 * каждый раз, а путаница лечится не разведением полей, а распознаванием: по
 * самой строке видно, что это — база или сервер.
 *
 *   mysql://Flux:пароль@192.168.120.14:3306/Flux   → общая база (MariaDB/MySQL)
 *   postgresql://user:пароль@host:5432/flux         → общая база (PostgreSQL)
 *   http://192.168.1.100:3000  или  192.168.1.100:3000 → сервер компании
 *
 * Пароль в строке берётся «как есть», даже со спецзнаками: `@`, `:`, `/`, `]`
 * в пароле отдела встречались, и стандартный разбор адреса резал его не там.
 * Поэтому хост ищется после ПОСЛЕДНЕГО `@`, а строка собирается заново с
 * экранированием (buildDbUrl).
 *
 * Без React и без сети — scripts/test-connection.ts.
 */
import { buildDbUrl, missing, type DbParts, DEFAULT_PORT } from './dbUrl';
import { checkServerUrl } from './serverUrl';

export type Connection =
  | { kind: 'database'; url: string; parts: DbParts }
  | { kind: 'server'; url: string }
  | { kind: 'error'; error: string };

const DB_RE = /^(mysql|mariadb|postgres|postgresql):\/\/(.*)$/i;

export function readConnection(raw: string): Connection {
  const s = String(raw || '').trim();
  if (!s) return { kind: 'error', error: 'Вставьте строку подключения к базе или адрес сервера компании.' };

  if (/^(sqlite|file):/i.test(s)) {
    return { kind: 'error', error: 'База на этом компьютере подключается кнопкой «Этот компьютер».' };
  }

  const db = DB_RE.exec(s);
  if (db) {
    const engine = /^(mysql|mariadb)$/i.test(db[1]) ? 'MARIADB' : 'POSTGRES';
    const rest = db[2];
    // Хост — после последнего «@»: в пароле «@» бывает, в адресе сервера — нет
    const at = rest.lastIndexOf('@');
    const cred = at >= 0 ? rest.slice(0, at) : '';
    const tail = at >= 0 ? rest.slice(at + 1) : rest;
    const colon = cred.indexOf(':');
    const user = colon >= 0 ? cred.slice(0, colon) : cred;
    const password = colon >= 0 ? cred.slice(colon + 1) : '';
    const m = /^([^/:?#]+)(?::(\d{1,5}))?\/([^?#]*)/.exec(tail);
    if (!m) return { kind: 'error', error: 'Не разобрать сервер и базу. Пример: mysql://имя:пароль@192.168.1.10:3306/Flux' };
    const safeDecode = (v: string) => { try { return decodeURIComponent(v); } catch (_) { return v; } };
    const parts: DbParts = {
      engine,
      host: m[1],
      port: m[2] || DEFAULT_PORT[engine],
      database: safeDecode(m[3]),
      // Уже закодированное (%40) раскодируем, чтобы не закодировать дважды
      user: safeDecode(user),
      password: /%[0-9a-f]{2}/i.test(password) ? safeDecode(password) : password,
    };
    const lack = missing(parts);
    if (lack) return { kind: 'error', error: lack };
    return { kind: 'database', url: buildDbUrl(parts), parts };
  }

  const server = checkServerUrl(s);
  if (server.error) return { kind: 'error', error: server.error };
  return { kind: 'server', url: server.url };
}
