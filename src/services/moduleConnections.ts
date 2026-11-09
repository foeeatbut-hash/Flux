/**
 * Подключения подпрограммы со стороны окна Flux: вызов уходит в главный процесс
 * (`modules:connect`), а когда решение человека ещё не принято, окно показывает
 * ему вопрос и записывает ответ тоже через главный процесс. Решение, разрешение
 * и проверка адреса — не здесь: окно только передаёт вызов и показывает вопрос,
 * поэтому ни подпрограмма, ни ошибка окна не могут «разрешить» себе подключение.
 */
import type { ConnectCall, ConnectErrorCode, GrantAsk } from '../../modules/connections/model';
import { bridge } from './moduleReleaseService';

export type GrantChoice = 'always' | 'once' | 'never';
export type ConnectResult = { ok: true; data: unknown } | { ok: false; code: ConnectErrorCode };

export interface ConnectorOptions {
  moduleId: string;
  version: string;
  /** Сеанс окна подпрограммы: по нему главный процесс закрывает всё, что она открыла */
  session: string;
  /** Окно вопроса; возвращает выбор человека. Закрытие окна без выбора — «не разрешать» */
  ask: (ask: GrantAsk) => Promise<GrantChoice>;
  /** Подпрограмме отказали (человек или политика): окно показывает плашку «Нет доступа к … — Разрешить…» */
  /** Понятные имена программ по идентификатору подключения: из манифеста, который окно получило от главного процесса */
  apps?: Record<string, string>;
  onDenied?: (ask: { connection: string; app: string }) => void;
}

export function createConnector(options: ConnectorOptions) {
  const asking = new Map<string, Promise<GrantChoice>>();
  const invoke = async (connection: string, call: ConnectCall): Promise<any> => {
    const ipc = bridge();
    if (!ipc) return { ok: false, code: 'UNAVAILABLE' };
    try {
      return await ipc.invoke('modules:connect', { moduleId: options.moduleId, version: options.version, session: options.session, connection, call });
    } catch { return { ok: false, code: 'FAILED' }; }
  };
  return {
    async connect(connection: string, call: ConnectCall): Promise<ConnectResult> {
      let reply = await invoke(connection, call);
      if (reply?.code === 'ASK') {
        const ask = reply.ask as GrantAsk;
        // Одновременные вызовы к тому же подключению ждут один и тот же вопрос: человека не спрашивают дважды
        let pending = asking.get(connection);
        if (!pending) {
          pending = options.ask(ask).catch(() => 'never' as GrantChoice).then(async choice => {
            await bridge()?.invoke('modules:grant', { moduleId: options.moduleId, version: options.version, connection, session: options.session, decision: choice }).catch(() => null);
            return choice;
          }).finally(() => { asking.delete(connection); });
          asking.set(connection, pending);
        }
        const choice = await pending;
        if (choice === 'never') { options.onDenied?.({ connection, app: ask.app }); return { ok: false, code: 'NOT_ALLOWED' }; }
        reply = await invoke(connection, call);
        if (reply?.code === 'ASK') return { ok: false, code: 'NOT_ALLOWED' };
      }
      if (reply?.code === 'NOT_ALLOWED') {
        options.onDenied?.({ connection, app: options.apps?.[connection] || connection });
      }
      return reply?.ok ? { ok: true, data: reply.data } : { ok: false, code: (reply?.code as ConnectErrorCode) || 'FAILED' };
    },
    /** Окно подпрограммы закрыто */
    close() { void bridge()?.invoke('modules:connect-close', { session: options.session }).catch(() => null); },
  };
}
