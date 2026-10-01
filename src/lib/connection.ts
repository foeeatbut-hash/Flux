import { checkServerUrl } from './serverUrl';

export type Connection = { kind: 'server'; url: string } | { kind: 'error'; error: string };

/** Клиент получает только адрес API: доступ к БД остаётся на сервере компании. */
export function readConnection(raw: string): Connection {
  const text = String(raw || '').trim();
  if (!text) return { kind: 'error', error: 'Введите адрес сервера Flux, например https://flux.company.ru.' };
  if (/^(mysql|mariadb|postgres|postgresql|mongodb|sqlserver|sqlite|file):/i.test(text)) {
    return { kind: 'error', error: 'Это адрес базы данных. Сотрудники подключаются к серверу Flux по HTTPS; базу настраивает владелец на сервере компании.' };
  }
  const explicit = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text);
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(text);
  const checked = checkServerUrl(explicit ? text : `${loopback ? 'http' : 'https'}://${text}`);
  if (checked.error) return { kind: 'error', error: checked.error };
  const address = new URL(checked.url);
  if (address.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(address.hostname.toLowerCase())) {
    return { kind: 'error', error: 'Для сервера компании нужен HTTPS, чтобы логины, файлы и лицензии передавались защищённо. HTTP разрешён только на этом компьютере.' };
  }
  return { kind: 'server', url: checked.url };
}

export type ServerProbe = { ready: boolean; version?: string; needsSetup?: boolean; error?: string };

/** Одного ответа 200 недостаточно: на адресе может находиться сайт или сама БД. */
export async function probeFluxServer(url: string, request: typeof fetch = fetch): Promise<ServerProbe> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const response = await request(`${url}/api/health`, { signal: ctl.signal, credentials: 'omit' });
    const data = await response.json().catch(() => null);
    if (!data || typeof data.ok !== 'boolean' || typeof data.version !== 'string') {
      return { ready: false, error: 'По этому адресу нет API Flux. На сервере с БД нужно отдельно запустить сервер Flux и настроить HTTPS.' };
    }
    if (!response.ok || !data.ok) return { ready: false, error: data.error || 'Сервер Flux найден, но его база данных пока недоступна.' };
    return { ready: true, version: data.version, needsSetup: data.needsSetup === true };
  } catch (_) {
    return { ready: false, error: 'Нет связи с сервером Flux. Проверьте адрес, HTTPS-сертификат, VPN и доступ к порту у администратора компании.' };
  } finally { clearTimeout(timer); }
}
