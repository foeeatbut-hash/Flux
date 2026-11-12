/**
 * Подключения программы со стороны окна Flux: вызов уходит в главный процесс
 * (`modules:connect`), а когда решение человека ещё не принято, окно показывает
 * ему вопрос и записывает ответ тоже через главный процесс. Решение, разрешение
 * и проверка адреса — не здесь: окно только передаёт вызов и показывает вопрос,
 * поэтому ни программа, ни ошибка окна не могут «разрешить» себе подключение.
 */
import type { ConnectCall, ConnectErrorCode, GrantAsk, NetCall } from '../../modules/connections/model';
import { bridge } from './moduleReleaseService';

/** `later` — окно программы закрыто, человек не отвечал: ничего не запоминается, спросим при следующем обращении */
export type GrantChoice = 'always' | 'once' | 'never' | 'later';
export type ConnectResult = { ok: true; data: unknown } | { ok: false; code: ConnectErrorCode };

export interface ConnectorOptions {
  moduleId: string;
  version: string;
  /** Сеанс окна программы: по нему главный процесс закрывает всё, что она открыла */
  session: string;
  /** Окно вопроса; возвращает выбор человека. Закрытие окна без выбора — «не разрешать» */
  ask: (ask: GrantAsk) => Promise<GrantChoice>;
  /** Программе отказали (человек или политика): окно показывает плашку «Нет доступа к … — Разрешить…» */
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
          pending = options.ask(ask).catch(() => 'later' as GrantChoice).then(async choice => {
            if (choice === 'later') return choice;
            await bridge()?.invoke('modules:grant', { moduleId: options.moduleId, version: options.version, connection, session: options.session, decision: choice }).catch(() => null);
            return choice;
          }).finally(() => { asking.delete(connection); });
          asking.set(connection, pending);
        }
        const choice = await pending;
        // Закрытие окна программы без ответа не запоминается и плашки не показывает
        if (choice === 'later') return { ok: false, code: 'NOT_ALLOWED' };
        if (choice === 'never') { options.onDenied?.({ connection, app: ask.app }); return { ok: false, code: 'NOT_ALLOWED' }; }
        reply = await invoke(connection, call);
        if (reply?.code === 'ASK') return { ok: false, code: 'NOT_ALLOWED' };
      }
      if (reply?.code === 'NOT_ALLOWED') {
        options.onDenied?.({ connection, app: options.apps?.[connection] || connection });
      }
      return reply?.ok ? { ok: true, data: reply.data } : { ok: false, code: (reply?.code as ConnectErrorCode) || 'FAILED' };
    },
    /** Обращение по полному адресу: разрешение дано при установке, вопроса человеку нет; отказ политики — NOT_ALLOWED */
    async net(call: NetCall): Promise<ConnectResult> {
      const ipc = bridge();
      if (!ipc) return { ok: false, code: 'UNAVAILABLE' };
      try {
        const reply: any = await ipc.invoke('modules:net', { moduleId: options.moduleId, version: options.version, session: options.session, call });
        return reply?.ok ? { ok: true, data: reply.data } : { ok: false, code: (reply?.code as ConnectErrorCode) || 'FAILED' };
      } catch { return { ok: false, code: 'FAILED' }; }
    },
    /** Окно программы закрыто */
    close() { void bridge()?.invoke('modules:connect-close', { session: options.session }).catch(() => null); },
  };
}
