import React, { createContext, useContext, useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { usePresenceStore } from '../store/presenceStore';
import { ENV_CONFIG, getAuthToken } from '../config/env';
import { isNewer } from '../lib/updates';
import { useToastStore } from '../store/toastStore';
import { useStore } from '../store/store';
import { useNotificationStore } from '../store/notificationStore';
import { useChatStore } from '../store/chatStore';
import { useNavigate } from 'react-router-dom';

// ── Реальное соединение socket.io — всегда ──
// Раньше в «локальном режиме» подключалась мок-заглушка с локальным эхом,
// из-за чего события между пользователями не ходили вовсе. Теперь клиент
// всегда соединяется с сервером (встроенным localhost или сервером компании) —
// сервер ретранслирует события остальным (socket.broadcast/io.emit).

interface SocketContextType {
  socket: Socket | null;
  isConnected: boolean;
  emitTagChange: (type: 'linked' | 'updated', tagId: string, details?: any) => void;
  emitEquipmentConflict: (componentId: string, systemId: string, message: string, changeDetails: string) => void;
}

const SocketContext = createContext<SocketContextType>({
  socket: null,
  isConnected: false,
  emitTagChange: () => {},
  emitEquipmentConflict: () => {}
});

export const useRealTimeSync = () => useContext(SocketContext);

interface SocketProviderProps {
  children: React.ReactNode;
}

export const SocketProvider: React.FC<SocketProviderProps> = ({ children }) => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const { addToast } = useToastStore();
  const userId = useStore((s) => s.user?.id);
  const navigate = useNavigate();
  /**
   * Токен в зависимостях, а не только идентификатор человека.
   *
   * Сокет получает токен ОДИН РАЗ, при создании, и держит его вечно: при
   * переподключении socket.io шлёт тот же самый. Пока эффект зависел только от
   * userId, повторный вход (истёк тридцатидневный срок токена, перезапустили
   * сервер, администратор сбросил сессию) не пересоздавал сокет — и тот
   * навсегда оставался с недействительным токеном. Сервер его не пускал, а по
   * HTTP всё работало: токен там читается на каждом запросе.
   *
   * Снаружи это выглядело как «статус в сети не работает»: чат опрашивается по
   * HTTP и жил, а присутствие ходит только сокетом и молчало до перезапуска
   * программы.
   */
  const [token, setToken] = useState<string>(() => getAuthToken());
  useEffect(() => {
    const check = () => {
      const now = getAuthToken();
      setToken((was) => (was === now ? was : now));
    };
    // Вход и выход происходят в этом же окне — событие storage сюда не придёт
    const timer = setInterval(check, 2000);
    window.addEventListener('storage', check);
    return () => { clearInterval(timer); window.removeEventListener('storage', check); };
  }, []);

  useEffect(() => {
    // Сервер пускает по токену сессии — подключаемся только после входа
    if (!userId) {
      setSocket(null);
      setIsConnected(false);
      return;
    }

    console.log('[RealTimeSync] Подключение socket.io к серверу:', ENV_CONFIG.socketUrl);
    const activeSocket = io(ENV_CONFIG.socketUrl, {
      auth: { token },
      // websocket в приоритете, polling — запасной транспорт (строгие прокси)
      transports: ['websocket', 'polling'],
      autoConnect: true,
      // Встроенный сервер стартует параллельно с окном — соединение
      // молча переподключается, пока порт не откроется
      reconnectionDelay: 800,
      reconnectionDelayMax: 4000,
    });

    /**
     * Состояние сокета пишется в журнал.
     *
     * Раньше о нём не было ни строчки, и мёртвый сокет выглядел как «статус в
     * сети не работает» — без единой зацепки, потому что HTTP-запросы в
     * журнале были и отвечали нормально.
     */
    const journal = (level: 'INFO' | 'ERROR', text: string) => {
      try { (window as any).__pdmLogStore?.getState().addLog(level, 'Связь', text); } catch (_) {}
    };

    activeSocket.on('connect', () => {
      setIsConnected(true);
      journal('INFO', `Живая связь установлена: ${ENV_CONFIG.socketUrl}`);
      // Связь вернулась — список «кто в сети» просим заново: пока её не было,
      // кто-то успел прийти и уйти, а мы этого не слышали
      activeSocket.emit('presence:list');
    });
    activeSocket.on('disconnect', (reason: string) => {
      setIsConnected(false);
      journal('INFO', `Живая связь потеряна: ${reason}`);
      // Без связи мы не знаем ничего о чужом присутствии. Показывать прежний
      // список — значит уверенно врать: половина этих людей уже ушла
      usePresenceStore.getState().reset();
    });
    activeSocket.on('connect_error', (err: any) => {
      setIsConnected(false);
      const why = String(err?.message || err);
      journal('ERROR', `Живая связь не устанавливается: ${why}`);
      // Сервер не принял токен — берём свежий и пробуем им. Без этого сокет
      // вечно долбится старым, а «кто в сети» не работает до перезапуска
      if (/unauthorized|auth/i.test(why)) {
        const fresh = getAuthToken();
        if (fresh && fresh !== (activeSocket.auth as any)?.token) {
          (activeSocket as any).auth = { token: fresh };
          setToken(fresh);
        }
      }
    });

    setSocket(activeSocket);

    /**
     * Сервер компании старее программы — предупреждаем один раз.
     *
     * Программа у сотрудников обновляется сама, а сервер разворачивают отдельно
     * и обновить его забывают. Старый сервер не знает новых событий, и раздел
     * выглядит сломанным, хотя сломано несоответствие версий. Молчать об этом —
     * значит отправить человека искать несуществующую поломку.
     */
    void (async () => {
      try {
        const mine = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '';
        const r = await fetch('/api/health');
        const d = await r.json().catch(() => ({}));
        const server = String(d?.version || '');
        journal('INFO', `Сервер: ${server || 'версия не сообщается'}, программа: ${mine}`);
        if (mine && server && isNewer(mine, server)) {
          addToast(
            `Сервер компании версии ${server}, а программа ${mine}. `
            + 'Часть возможностей не будет работать, пока сервер не обновят.',
            'info',
          );
        }
      } catch (_) { /* сервер не ответил — об этом скажет сама связь */ }
    })();

    // Стандартные подписчики: транслируем события в window, чтобы экраны
    // могли динамически перезагружать данные
    const handleTagLinked = (data: { tagId: string; timestamp: string; details?: any }) => {
      window.dispatchEvent(new CustomEvent('socket:tag:linked', { detail: data }));
    };

    const handleTagUpdated = (data: { tagId: string; timestamp: string; details?: any }) => {
      window.dispatchEvent(new CustomEvent('socket:tag:updated', { detail: data }));
    };

    // Кто-то изменил карточку, которую я, возможно, сейчас смотрю. Тост тут
    // не нужен — сообщать должна сама карточка, и только если она открыта.
    const handleEntityChanged = (data: { kind: string; id: string; by?: string; byId?: string; at?: number }) => {
      window.dispatchEvent(new CustomEvent('socket:entity:changed', { detail: data }));
    };

    const handleEquipmentConflict = (data: {
      componentId: string;
      systemId: string;
      message: string;
      changeDetails: string;
    }) => {
      window.dispatchEvent(new CustomEvent('socket:equipment:conflict', { detail: data }));

      // Кликабельный тост: переход к урегулированию конфликта
      addToast(
        `🚨 ${data.message || 'Обнаружен конфликт оборудования! Нажмите для перехода к урегулированию.'}`,
        'error',
        () => {
          localStorage.setItem('focusedConflictId', data.componentId);
          localStorage.setItem('focusedConflictSystemId', data.systemId);
          navigate('/equipment');
        }
      );
    };

    // Админ опубликовал новый релиз — сообщаем сразу, не дожидаясь ручной проверки
    const handleUpdatePublished = (data: { version: string; changelog?: string }) => {
      window.dispatchEvent(new CustomEvent('socket:app:update-published', { detail: data }));
      addToast(`Опубликовано обновление Flux v${data.version} — откройте Настройки, чтобы установить.`, 'info');
    };

    /**
     * Уведомление, толкнутое сервером.
     *
     * Раньше новое узнавалось только опросом раз в пятнадцать секунд, и на
     * столько же опаздывало окошко Windows: его поднимает окно программы, а
     * окно узнавало из того же опроса. Теперь путь один и тот же — `ingest`
     * делает ровно то, что делал опрос, — поэтому всплывашка, звук, счётчик и
     * окошко Windows работают без единой правки.
     */
    const handleNotify = (row: any) => {
      if (row) useNotificationStore.getState().ingest([row]);
    };

    // Кто в сети: список целиком при подключении, дальше по одному событию
    const handlePresenceList = (d: { online?: string[]; lastSeen?: Record<string, number> }) =>
      usePresenceStore.getState().setList(d?.online || [], d?.lastSeen || {});
    const handlePresenceOn = (d: { userId?: string }) =>
      usePresenceStore.getState().setOnline(String(d?.userId || ''));
    const handlePresenceOff = (d: { userId?: string; at?: number }) =>
      usePresenceStore.getState().setOffline(String(d?.userId || ''), Number(d?.at) || Date.now());

    activeSocket.on('presence:list', handlePresenceList);
    activeSocket.on('presence:online', handlePresenceOn);
    activeSocket.on('presence:offline', handlePresenceOff);
    activeSocket.on('tag:linked', handleTagLinked);
    activeSocket.on('tag:updated', handleTagUpdated);
    activeSocket.on('equipment:conflict', handleEquipmentConflict);
    activeSocket.on('app:update-published', handleUpdatePublished);
    activeSocket.on('entity:changed', handleEntityChanged);
    activeSocket.on('notify:new', handleNotify);
    // Переписка слушается ОБЩИМ сокетом и всегда, а не только при открытом
    // Мессенджере: своего соединения у чата больше нет
    useChatStore.getState().bindSocket(activeSocket, userId);

    return () => {
      activeSocket.off('presence:list', handlePresenceList);
      activeSocket.off('presence:online', handlePresenceOn);
      activeSocket.off('presence:offline', handlePresenceOff);
      activeSocket.off('tag:linked', handleTagLinked);
      activeSocket.off('tag:updated', handleTagUpdated);
      activeSocket.off('equipment:conflict', handleEquipmentConflict);
      activeSocket.off('app:update-published', handleUpdatePublished);
      activeSocket.off('entity:changed', handleEntityChanged);
      activeSocket.off('notify:new', handleNotify);
      useChatStore.getState().unbindSocket(activeSocket);
      activeSocket.disconnect();
    };
  }, [addToast, navigate, userId, token]);

  const emitTagChange = (type: 'linked' | 'updated', tagId: string, details?: any) => {
    if (!socket) return;
    const eventName = type === 'linked' ? 'tag:linked' : 'tag:updated';
    // Сервер ретранслирует остальным (socket.broadcast.emit); свой экран
    // обновляется локально по факту действия
    socket.emit(eventName, { tagId, timestamp: new Date().toISOString(), details });
  };

  const emitEquipmentConflict = (componentId: string, systemId: string, message: string, changeDetails: string) => {
    if (!socket) return;
    socket.emit('equipment:conflict', { componentId, systemId, message, changeDetails });
  };

  return (
    <SocketContext.Provider value={{ socket, isConnected, emitTagChange, emitEquipmentConflict }}>
      {children}
    </SocketContext.Provider>
  );
};
