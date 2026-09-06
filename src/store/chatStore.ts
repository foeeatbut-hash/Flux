// Весь чат ходит ТОЛЬКО через сервер (HTTP + socket.io). Раньше в Electron
// сообщения и вложения шли по IPC напрямую в БД мимо сервера: события
// io.emit не рассылались, а вложения писались на диск отправителя и у
// собеседника не открывались. Теперь путь один — работает и локально,
// и с сервером компании (адрес подставляет fetch-прокси из config/env).
import { create } from 'zustand';
import { SERVER_BASE_URL } from '../config/env';
import type { Socket } from 'socket.io-client';

export interface ChatAttachment {
  id: string;
  messageId: string;
  fileName: string;
  filePath: string;
  fileSize: number;
}

export interface ChatMessage {
  id: string;
  content: string;
  createdAt: string;
  senderId: string;
  receiverId?: string | null;
  chatGroupId?: string | null;
  linkedElementId?: string | null;
  linkedProjectId?: string | null;
  attachments?: ChatAttachment[];
  sender: {
    id: string;
    name: string;
    symbol: string;
    role: string;
  };
  receiver?: {
    id: string;
    name: string;
    symbol: string;
    role: string;
  } | null;
  linkedElement?: {
    id: string;
    name: string;
    itemCode: string;
  } | null;
  replyToId?: string | null;
  replyTo?: {
    id: string;
    content: string;
    sender?: { id: string; name: string } | null;
  } | null;
  editedAt?: string | null;
  reactions?: string | null;     // JSON: { "👍": ["userId", ...] }
  pinned?: boolean;
  forwardedFrom?: string | null;
}

export interface ChatUser {
  id: string;
  name: string;
  symbol: string;
  role: string;
}

export interface ChatGroup {
  id: string;
  name: string;
  type: string;
  description?: string;
  color?: string;
  ownerId?: string | null;
  projectId?: string | null;
  members?: ChatUser[];
  project?: { id: string; name: string } | null;
}

interface ChatState {
  messages: ChatMessage[];
  /** Сколько последних сообщений держим в переписке */
  messageWindow: number;
  /** Есть ли что показать до текущего окна */
  hasEarlier: boolean;
  loadEarlier: (currentUserId: string) => Promise<void>;
  users: ChatUser[];
  groups: ChatGroup[];
  activeReceiverId: string | null;
  activeGroupId: string | null;
  activeType: 'DIRECT' | 'PROJECT';
  searchQuery: string;
  // Передача черновика из виджета логов в чат (группа «Ошибки»)
  pendingGroupName: string | null;
  pendingDraft: string | null;
  setPending: (groupName: string, draft: string) => void;
  clearPending: () => void;
  // Передача «поделиться-ссылки» в ЛС с пользователем (вставка, не замена)
  pendingReceiverId: string | null;
  pendingInsert: string | null;
  setPendingShare: (receiverId: string, insert: string) => void;
  clearPendingShare: () => void;
  setSearchQuery: (query: string) => void;
  setActiveReceiverId: (id: string | null) => void;
  setActiveGroupId: (id: string | null) => void;
  fetchUsers: () => Promise<void>;
  fetchGroups: () => Promise<void>;
  fetchMessages: (currentUserId: string) => Promise<void>;
  sendMessage: (
    currentUserId: string,
    content: string,
    linkedElementId?: string | null,
    linkedProjectId?: string | null,
    attachments?: { fileName: string; filePath: string; fileSize: number }[],
    replyToId?: string | null
  ) => Promise<void>;
  editMessage: (currentUserId: string, messageId: string, content: string) => Promise<void>;
  deleteMessage: (currentUserId: string, messageId: string) => Promise<void>;
  reactToMessage: (currentUserId: string, messageId: string, emoji: string) => Promise<void>;
  pinMessage: (currentUserId: string, messageId: string) => Promise<void>;
  forwardMessage: (currentUserId: string, messageId: string, target: { groupId?: string; receiverId?: string }) => Promise<void>;
  clearConversation: (currentUserId: string) => Promise<void>;
  createGroup: (data: { name: string; type: 'CUSTOM' | 'CHANNEL'; memberIds: string[]; description?: string; color?: string; ownerId: string }) => Promise<ChatGroup | null>;
  updateGroup: (id: string, data: { name?: string; description?: string; color?: string; memberIds?: string[]; userId: string }) => Promise<void>;
  deleteGroup: (id: string, userId: string) => Promise<void>;
  uploadFile: (fileName: string, base64Data: string) => Promise<{ filePath: string; fileName: string; fileSize: number }>;
  openFile: (filePath: string) => Promise<void>;
  startPolling: (currentUserId: string) => void;
  stopPolling: () => void;
  /** Подписаться на переписку общим сокетом оболочки */
  bindSocket: (socket: Socket, currentUserId: string) => void;
  unbindSocket: (socket: Socket) => void;
}

/** Общий сокет оболочки, на который подписан чат, и сами подписки */
let bound: Socket | null = null;
let onReceived: ((msg: ChatMessage) => void) | null = null;
let onUpdated: ((patch: Partial<ChatMessage> & { id: string }) => void) | null = null;
let onDeleted: ((payload: { id: string }) => void) | null = null;
let onConnect: (() => void) | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let visibilityHandler: (() => void) | null = null;

/**
 * Метка открытого диалога. Растёт при каждом переключении, и ответ сервера
 * принимается, только если метка не изменилась, пока он летел.
 *
 * Без этого быстрое переключение между чатами кончалось тем, что медленный
 * ответ первого диалога затирал сообщения второго: в окне чужая переписка
 * под именем текущего собеседника.
 */
let convToken = 0;

// Обновляет messages только если список реально изменился — опрос каждые 3 секунды
// не должен дергать перерисовку и скролл без новых сообщений
const messagesSignature = (list: any[]) =>
  list.map(m => `${m.id}:${m.editedAt || ''}:${m.reactions || ''}:${m.pinned ? 1 : 0}`).join('|');

const setMessagesIfChanged = (set: any, get: any, data: any[]) => {
  const prev = get().messages || [];
  if (Array.isArray(data) && messagesSignature(prev) === messagesSignature(data)) {
    return;
  }
  set({ messages: data });
};


export const useChatStore = create<ChatState>((set, get) => {
  return {
    messages: [],
    messageWindow: 300,
    hasEarlier: false,
    users: [],
    groups: [],
    activeReceiverId: null,
    activeGroupId: null,
    activeType: 'DIRECT',
    searchQuery: '',
    pendingGroupName: null,
    pendingDraft: null,
    pendingReceiverId: null,
    pendingInsert: null,

    setPending: (groupName, draft) => set({ pendingGroupName: groupName, pendingDraft: draft }),
    clearPending: () => set({ pendingGroupName: null, pendingDraft: null }),
    setPendingShare: (receiverId, insert) => set({ pendingReceiverId: receiverId, pendingInsert: insert }),
    clearPendingShare: () => set({ pendingReceiverId: null, pendingInsert: null }),

    setSearchQuery: (query) => set({ searchQuery: query }),
    
    setActiveReceiverId: (id) => {
      convToken++;
      set({ activeReceiverId: id, activeGroupId: null, activeType: 'DIRECT', messages: [], messageWindow: 300, hasEarlier: false });
    },

    setActiveGroupId: (id) => {
      convToken++;
      set({ activeGroupId: id, activeReceiverId: null, activeType: 'PROJECT', messages: [], messageWindow: 300, hasEarlier: false });
    },

    fetchUsers: async () => {
      try {
        const response = await fetch('/api/users');
        if (!response.ok) throw new Error('Failed to fetch users');
        const data = await response.json();
        set({ users: data });
      } catch (err) {
        console.error('[ChatStore] Error fetching users:', err);
      }
    },

    fetchGroups: async () => {
      try {
        const response = await fetch('/api/chat/groups');
        if (!response.ok) throw new Error('Failed response');
        const data = await response.json();
        set({ groups: data });
      } catch (err) {
        console.error('[ChatStore] Error fetching groups:', err);
      }
    },

    fetchMessages: async (currentUserId) => {
      const { activeReceiverId, activeGroupId, activeType, messageWindow } = get();
      const mine = convToken;

      try {
        // Сервер отдаёт хвост переписки. Целиком её тянуть незачем: список
        // перечитывается на каждое событие сокета, а читают почти всегда конец
        const limit = messageWindow || 300;
        if (activeType === 'DIRECT') {
          if (!activeReceiverId) return;
          const res = await fetch(`/api/chat/messages?senderId=${currentUserId}&receiverId=${activeReceiverId}&limit=${limit}`);
          if (!res.ok) throw new Error('Failed response');
          const data = await res.json();
          // Пока ответ летел, могли открыть другой диалог — тогда он не наш
          if (mine !== convToken) return;
          set({ hasEarlier: Array.isArray(data) && data.length >= limit });
          setMessagesIfChanged(set, get, data);
        } else {
          // PROJECT Group
          if (!activeGroupId) return;
          const res = await fetch(`/api/chat/group-messages?groupId=${activeGroupId}&limit=${limit}`);
          if (!res.ok) throw new Error('Failed response');
          const data = await res.json();
          if (mine !== convToken) return;
          set({ hasEarlier: Array.isArray(data) && data.length >= limit });
          setMessagesIfChanged(set, get, data);
        }
      } catch (err) {
        console.error('[ChatStore] Error fetching messages:', err);
      }
    },

    /** Показать более раннее: расширяем окно и перечитываем */
    loadEarlier: async (currentUserId) => {
      set({ messageWindow: (get().messageWindow || 300) + 500 });
      await get().fetchMessages(currentUserId);
    },

    sendMessage: async (currentUserId, content, linkedElementId = null, linkedProjectId = null, attachments = [], replyToId = null) => {
      const { activeReceiverId, activeGroupId, activeType } = get();
      const mine = convToken;

      try {
        if (activeType === 'DIRECT') {
          if (!activeReceiverId) return;
          const payload = {
            senderId: currentUserId,
            receiverId: activeReceiverId,
            content,
            linkedElementId,
            linkedProjectId,
            attachments,
            replyToId
          };
          const res = await fetch(`/api/chat/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          if (res.ok) {
            const data = await res.json();
            // Сервер сам рассылает chat:message_received через socket.io.
            // Если диалог успели сменить — в чужое окно сообщение не кладём
            if (mine !== convToken) return;
            set((state) => ({ messages: [...state.messages.filter(m => m.id !== data.id), data] }));
          }
        } else {
          // PROJECT Group
          if (!activeGroupId) return;
          const payload = {
            senderId: currentUserId,
            groupId: activeGroupId,
            content,
            linkedElementId,
            linkedProjectId,
            attachments,
            replyToId
          };
          const res = await fetch(`/api/chat/group-messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          if (res.ok) {
            const data = await res.json();
            if (mine !== convToken) return;
            set((state) => ({ messages: [...state.messages.filter(m => m.id !== data.id), data] }));
          }
        }
      } catch (err) {
        console.error('[ChatStore] Error sending message:', err);
        throw err;
      }
    },

    // Редактирование своего сообщения
    editMessage: async (currentUserId, messageId, content) => {
      const res = await fetch(`/api/chat/messages/${messageId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUserId, content })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Не удалось изменить сообщение');
      set((state) => ({ messages: state.messages.map(m => m.id === messageId ? data : m) }));
    },

    // Удаление своего сообщения
    deleteMessage: async (currentUserId, messageId) => {
      const res = await fetch(`/api/chat/messages/${messageId}?userId=${encodeURIComponent(currentUserId)}`, {
        method: 'DELETE'
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Не удалось удалить сообщение');
      }
      set((state) => ({ messages: state.messages.filter(m => m.id !== messageId) }));
    },

    // Реакция эмодзи (через встроенный сервер; в Electron fetch проксируется)
    reactToMessage: async (currentUserId, messageId, emoji) => {
      const res = await fetch(`/api/chat/messages/${messageId}/react`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUserId, emoji }),
      }).catch(() => null);
      // Сорвалась сеть — оставляем как было. Раньше сюда падал null, и одна
      // неудачная попытка стирала все реакции сообщения на экране
      if (!res || !res.ok) throw new Error('Не удалось поставить реакцию');
      const { reactions } = await res.json();
      set((state) => ({ messages: state.messages.map(m => m.id === messageId ? { ...m, reactions } : m) }));
    },

    pinMessage: async (currentUserId, messageId) => {
      const res = await fetch(`/api/chat/messages/${messageId}/pin`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUserId }),
      }).catch(() => null);
      if (res && res.ok) {
        const { pinned } = await res.json();
        set((state) => ({ messages: state.messages.map(m => m.id === messageId ? { ...m, pinned } : m) }));
      }
    },

    forwardMessage: async (currentUserId, messageId, target) => {
      const res = await fetch(`/api/chat/forward`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, senderId: currentUserId, toGroupId: target.groupId || null, toReceiverId: target.receiverId || null }),
      }).catch(() => null);
      if (!res || !res.ok) throw new Error('Не удалось переслать сообщение');
    },

    clearConversation: async (currentUserId) => {
      const { activeType, activeGroupId, activeReceiverId } = get();
      let url = '';
      if (activeType === 'PROJECT' && activeGroupId) {
        url = `/api/chat/conversation?groupId=${encodeURIComponent(activeGroupId)}`;
      } else if (activeReceiverId) {
        url = `/api/chat/conversation?userA=${encodeURIComponent(currentUserId)}&userB=${encodeURIComponent(activeReceiverId)}`;
      }
      if (!url) return;
      const res = await fetch(url, { method: 'DELETE' }).catch(() => null);
      if (res && res.ok) set({ messages: [] });
    },

    createGroup: async (data) => {
      const res = await fetch(`/api/chat/groups`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }).catch(() => null);
      if (!res || !res.ok) throw new Error('Не удалось создать');
      const { group } = await res.json();
      await get().fetchGroups();
      return group;
    },

    updateGroup: async (id, data) => {
      const res = await fetch(`/api/chat/groups/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }).catch(() => null);
      if (!res || !res.ok) {
        const d = res ? await res.json().catch(() => ({})) : {};
        throw new Error(d.message || 'Не удалось изменить');
      }
      await get().fetchGroups();
    },

    deleteGroup: async (id, userId) => {
      const res = await fetch(`/api/chat/groups/${id}?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' }).catch(() => null);
      if (!res || !res.ok) {
        const d = res ? await res.json().catch(() => ({})) : {};
        throw new Error(d.message || 'Не удалось удалить');
      }
      await get().fetchGroups();
    },

    // Вложение хранится в базе данных (раздача /chat_files/{id}/{имя}) —
    // так файл открывается у всех участников при любом режиме базы
    uploadFile: async (fileName, base64Data) => {
      try {
        const res = await fetch('/api/chat/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName, base64Data })
        });
        if (!res.ok) throw new Error('File upload failure');
        return await res.json();
      } catch (err: any) {
        console.error('[ChatStore] Error uploading file:', err);
        throw err;
      }
    },

    openFile: async (filePath) => {
      try {
        const win = window as any;
        const p = String(filePath || '');
        if (p.startsWith('/chat_files/') || p.startsWith('http')) {
          // Файл на сервере: открываем по URL (в Electron — системным браузером)
          const url = p.startsWith('http') ? p : `${SERVER_BASE_URL}${p}`;
          if (win.electron?.openExternal) {
            const result = await win.electron.openExternal(url);
            if (result && result.success === false) alert(result.error || 'Не удалось открыть файл.');
          } else {
            window.open(url, '_blank');
          }
        } else if (win.electron?.ipcRenderer) {
          // Легаси: старые сообщения с абсолютным путём на диске этой машины
          const result = await win.electron.ipcRenderer.invoke('chat:open-file', p);
          if (!result.success) alert(result.error || 'Не удалось открыть файл.');
        } else {
          alert('Файл хранится на компьютере отправителя и недоступен по сети.');
        }
      } catch (err) {
        console.error('[ChatStore] Error opening file:', err);
      }
    },

    startPolling: (currentUserId) => {
      get().stopPolling();
      get().fetchMessages(currentUserId);
      // Основной канал теперь socket.io (chat:message_received и т.д.);
      // опрос — только страховка пропущенного события, поэтому редкий.
      // Пока окно скрыто (свёрнуто, в трее, режим захвата) — не опрашиваем
      // вовсе: страховать нечего, никто не смотрит
      pollTimer = setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden) return;
        get().fetchMessages(currentUserId);
      }, 12000);
      // Вернулись к окну — сразу подтягиваем пропущенное, не дожидаясь такта
      visibilityHandler = () => {
        if (typeof document !== 'undefined' && !document.hidden) get().fetchMessages(currentUserId);
      };
      document.addEventListener('visibilitychange', visibilityHandler);
    },

    stopPolling: () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (visibilityHandler) {
        document.removeEventListener('visibilitychange', visibilityHandler);
        visibilityHandler = null;
      }
    },

    /**
     * Переписка слушается ОБЩИМ сокетом оболочки.
     *
     * Раньше чат заводил ВТОРОЕ соединение и подписывался на нём, а звали его
     * только из открытого Мессенджера. Значит вне раздела о новом сообщении
     * узнавали лишь из опроса уведомлений — отсюда и задержка. Второе
     * соединение рвалось при уходе с раздела, и в консоль летело
     * «WebSocket is closed before the connection is established».
     *
     * Теперь подписка одна, живёт вместе с оболочкой и слушает всегда.
     */
    bindSocket: (socket, currentUserId) => {
      if (bound === socket) return;
      if (bound) get().unbindSocket(bound);
      bound = socket;

      onReceived = (msg: ChatMessage) => {
        const { activeReceiverId, activeGroupId, activeType } = get();
        const mine = (activeType === 'DIRECT' && activeReceiverId
            && (msg.senderId === activeReceiverId || msg.receiverId === activeReceiverId))
          || (activeType === 'PROJECT' && activeGroupId && msg.chatGroupId === activeGroupId);
        if (!mine) return;
        set((state) => ({ messages: [...state.messages.filter((m) => m.id !== msg.id), msg] }));
      };
      // Правки в реальном времени: редактирование/реакции/пин приходят частичным
      // объектом ({id, ...изменённые поля}) — сливаем в существующее сообщение
      onUpdated = (patch: Partial<ChatMessage> & { id: string }) => {
        if (!patch?.id) return;
        set((state) => ({
          messages: state.messages.map((m) => (m.id === patch.id ? { ...m, ...patch } : m)),
        }));
      };
      onDeleted = (payload: { id: string }) => {
        if (!payload?.id) return;
        set((state) => ({ messages: state.messages.filter((m) => m.id !== payload.id) }));
      };
      // Пока связи не было, события до нас не дошли: догоняем сразу, а не
      // ждём такта страховочного опроса
      onConnect = () => { if (currentUserId) get().fetchMessages(currentUserId); };

      socket.on('chat:message_received', onReceived);
      socket.on('chat:message_updated', onUpdated);
      socket.on('chat:message_deleted', onDeleted);
      socket.on('connect', onConnect);
    },

    unbindSocket: (socket) => {
      if (onReceived) socket.off('chat:message_received', onReceived);
      if (onUpdated) socket.off('chat:message_updated', onUpdated);
      if (onDeleted) socket.off('chat:message_deleted', onDeleted);
      if (onConnect) socket.off('connect', onConnect);
      onReceived = null; onUpdated = null; onDeleted = null; onConnect = null;
      if (bound === socket) bound = null;
    },
  };
});
