import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store/store';
import { useAssistantStore } from '../store/assistantStore';
import { useAssistantCall } from '../components/chat/useAssistantCall';
import AssistantEntry from '../components/chat/AssistantEntry';
import { matchUsers, matchGroups } from '../lib/chatSearch';
import { canvasAttachment } from '../lib/chatDrawing';
import { useToastStore } from '../store/toastStore';
import { usePresenceStore, presenceLabel } from '../store/presenceStore';
import { useChatStore, ChatMessage } from '../store/chatStore';
import { useShareStore } from '../store/shareStore';
import { useNotificationStore } from '../store/notificationStore';
import { decodeShare } from '../lib/shareLink';
import { openInProject } from '../lib/projectScope';
import MessageBubble, { DayDivider } from '../components/chat/MessageBubble';
import { markGroups } from '../components/chat/grouping';
import RichChatInput, { RichChatInputHandle } from '../components/RichChatInput';
import { Link2 } from 'lucide-react';
import {
  MessageSquare, 
  Search, 
  Paperclip, 
  Settings, 
  Send, 
  File, 
  Download, 
  ChevronRight, 
  ChevronLeft, 
  User, 
  X, 
  Link as LinkIcon, 
  Clock,
  Camera,
  Brush,
  Trash2,
  Reply,
  Pencil,
  Copy,
  Smile,
  CornerDownRight,
  CornerUpRight,
  Pin,
  PinOff,
  Plus,
  Users,
  Radio,
  MoreVertical,
  Trash,
  UserPlus,
  Check,
  ChevronDown
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useModalStore } from '../store/modalStore';

// Диалоги программы вместо системных окон Windows
const { openConfirm } = useModalStore.getState();

// Formatted Message Component to recognize #TAG inline links + share-links [[s:..]]
interface FormattedMessageProps {
  text: string;
  onTagClick: (tag: string) => void;
  onShareClick?: (token: string) => void;
}

const FormattedMessage: React.FC<FormattedMessageProps> = ({ text, onTagClick, onShareClick }) => {
  if (!text) return null;

  // Либо токен ссылки [[s:...]], либо #тег
  const regex = /(\[\[s:[A-Za-z0-9_\-]+\]\])|#([a-zA-Z0-9А-Яа-я\-]+)/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const matchIndex = match.index;
    if (matchIndex > lastIndex) parts.push(text.substring(lastIndex, matchIndex));

    if (match[1]) {
      // share-link
      const token = match[1];
      const decoded = decodeShare(token);
      const label = decoded?.l || 'Ссылка';
      parts.push(
        <button key={matchIndex} type="button"
          onClick={(e) => { e.stopPropagation(); onShareClick && onShareClick(token); }}
          className="inline-flex items-center gap-1 mx-0.5 px-1.5 py-0.5 bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:hover:bg-emerald-900 border border-emerald-200 dark:border-emerald-800 rounded-md text-xs font-bold text-emerald-700 dark:text-emerald-400 cursor-pointer transition-ui font-sans select-none align-baseline max-w-[260px]"
          title={`Перейти: ${label}`}>
          <Link2 className="w-3 h-3 shrink-0" />
          <span className="truncate">{label}</span>
        </button>
      );
    } else {
      const tagName = match[2];
      parts.push(
        <button key={matchIndex} type="button"
          onClick={(e) => { e.stopPropagation(); onTagClick(tagName); }}
          className="inline-flex items-center mx-0.5 px-1.5 py-0.5 bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:hover:bg-emerald-900 border border-emerald-200 dark:border-emerald-850 rounded text-xs font-bold text-emerald-700 dark:text-emerald-400 cursor-pointer hover:underline transition-ui font-sans select-none align-baseline shrink-0">
          #{tagName}
        </button>
      );
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) parts.push(text.substring(lastIndex));

  return <span className="whitespace-pre-wrap leading-relaxed select-text font-sans">{parts.length > 0 ? parts : text}</span>;
};

/** Счётчик непрочитанного у строки диалога */
function UnreadDot({ n }: { n: number }) {
  return (
    <span className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-emerald-600 text-white
                     text-2xs font-extrabold grid place-items-center tabular-nums"
          title={`Непрочитанных: ${n}`}>
      {n > 99 ? '99+' : n}
    </span>
  );
}

export default function ChatManagement() {
  const { user, activeProject, setActiveProject } = useStore();
  // Непрочитанное по каждому диалогу — считает хранилище уведомлений
  const chatUnreadByKey = useNotificationStore((s) => s.chatUnreadByKey);
  const { addToast } = useToastStore();
  const navigate = useNavigate();

  const {
    messages,
    users,
    groups,
    activeReceiverId,
    activeGroupId,
    activeType,
    searchQuery,
    setSearchQuery,
    setActiveReceiverId,
    setActiveGroupId,
    fetchUsers,
    fetchGroups,
    fetchMessages,
    sendMessage,
    editMessage,
    deleteMessage,
    uploadFile,
    openFile,
    startPolling,
    stopPolling,
    pendingGroupName,
    pendingDraft,
    clearPending,
    pendingReceiverId,
    pendingInsert,
    clearPendingShare,
    hasEarlier,
    loadEarlier
  } = useChatStore();
  const setFocusTarget = useShareStore(s => s.setFocusTarget);

  // Переход по «поделиться-ссылке» в сообщении.
  //
  // Чат — общий раздел: в нём лежат ссылки на данные всех проектов. Ссылка на
  // чужой проект не ломается и не открывается молча — спрашивает, как и всё
  // остальное в программе (см. src/lib/projectScope.ts). Раньше здесь был свой
  // текст вопроса, отличавшийся от всех прочих.
  const handleShareClick = (token: string) => {
    const t = decodeShare(token);
    if (!t) return;
    openInProject({
      what: t.l ? `«${t.l}»` : 'Ссылка из чата',
      projectId: t.p || null,
      open: () => { setFocusTarget(t); navigate(t.r); },
    });
  };

  const [messageText, setMessageText] = useState('');

  // Приём логов из виджета: выбрать группу «Ошибки» и вставить текст в поле ввода
  useEffect(() => {
    if (!pendingGroupName) return;
    const g = groups.find(gr => gr.name === pendingGroupName);
    if (g) {
      setActiveGroupId(g.id);
      if (pendingDraft) setMessageText(pendingDraft);
      clearPending();
    }
  }, [pendingGroupName, groups]);

  // Приём «поделиться-ссылки»: открыть ЛС с пользователем и вставить токен в поле.
  // Значение читаем из стора на момент выполнения — иначе StrictMode/повторный
  // запуск эффекта вставляет токен дважды.
  useEffect(() => {
    if (!pendingReceiverId) return;
    setActiveReceiverId(pendingReceiverId);
    const ins = useChatStore.getState().pendingInsert;
    if (ins) setMessageText(prev => (prev ? prev + ' ' : '') + ins);
    clearPendingShare();
  }, [pendingReceiverId]);

  // При открытии диалога — пометить его ЧАТ-уведомления прочитанными
  useEffect(() => {
    if (!user?.id) return;
    if (activeReceiverId) useNotificationStore.getState().markConversationRead(user.id, `from=${activeReceiverId}`);
    else if (activeGroupId) useNotificationStore.getState().markConversationRead(user.id, `group=${activeGroupId}`);
  }, [activeReceiverId, activeGroupId, user?.id]);

  const [replyTarget, setReplyTarget] = useState<ChatMessage | null>(null);
  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
  const [conversationSearch, setConversationSearch] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [stagedAttachments, setStagedAttachments] = useState<{ fileName: string; filePath: string; fileSize: number }[]>([]);
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);
  const [selectedElementName, setSelectedElementName] = useState<string | null>(null);

  // Autocomplete suggestions state
  const messageInputRef = useRef<RichChatInputHandle>(null);
  const [autocompleteSuggestions, setAutocompleteSuggestions] = useState<Array<{ text: string; description: string; elementId?: string }>>([]);
  const [isAutocompleteLoading, setIsAutocompleteLoading] = useState(false);
  const [activeTagQuery, setActiveTagQuery] = useState<string | null>(null);
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);

  // Слово перед курсором приходит из rich-инпута; «#вен» → запрос автодополнения
  const handleCaretWord = (word: string | null) => {
    setActiveTagQuery(word && word.startsWith('#') ? word.slice(1) : null);
  };

  // Заменяем набираемое «#вен» на выбранный тег
  const insertTagAtCursor = (tagText: string) => {
    messageInputRef.current?.replaceWordBeforeCaret(`#${tagText} `);
    setAutocompleteSuggestions([]);
    setActiveTagQuery(null);
  };

  // UI state
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(true);
  const [reactPickerFor, setReactPickerFor] = useState<string | null>(null); // id сообщения для выбора реакции
  const [forwardFor, setForwardFor] = useState<ChatMessage | null>(null);     // сообщение для пересылки
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showGroupSettings, setShowGroupSettings] = useState(false);
  const [showChatMenu, setShowChatMenu] = useState(false);                    // меню в шапке диалога
  // Форма создания группы/канала
  const [ngName, setNgName] = useState('');
  const [ngType, setNgType] = useState<'CUSTOM' | 'CHANNEL'>('CUSTOM');
  const [ngMembers, setNgMembers] = useState<string[]>([]);
  const [ngBusy, setNgBusy] = useState(false);
  // Форма настроек группы
  const [gsName, setGsName] = useState('');
  const [gsMembers, setGsMembers] = useState<string[]>([]);
  const [isEquipmentModalOpen, setIsEquipmentModalOpen] = useState(false);
  const [projectComponents, setProjectComponents] = useState<any[]>([]);
  const [compSearch, setCompSearch] = useState('');

  // Engineering tag viewer
  const [selectedTagElement, setSelectedTagElement] = useState<any | null>(null);

  // Snapshot Drawing states
  const [screenshotData, setScreenshotData] = useState<string | null>(null);
  const [isAnnotating, setIsAnnotating] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  // Кнопка «вниз к новым сообщениям» — показываем, когда прокручено вверх
  const [showScrollDown, setShowScrollDown] = useState(false);
  const scrollToBottom = () => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  const lastMessageIdRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Initial loading
  useEffect(() => {
    fetchUsers();
    fetchGroups();
  }, []);

  // Debounced tags/components autocomplete search
  useEffect(() => {
    if (activeTagQuery === null) {
      setAutocompleteSuggestions([]);
      return;
    }

    const delayDebounce = setTimeout(async () => {
      try {
        setIsAutocompleteLoading(true);
        let list = [];
        const url = `/api/chat/autocomplete-tags?query=${encodeURIComponent(activeTagQuery)}&projectId=${activeProject?.id || ''}`;
        const res = await fetch(url);
        if (res.ok) {
          list = await res.json();
        }
        setAutocompleteSuggestions(list || []);
        setAutocompleteIndex(0);
      } catch (e) {
        console.error('[Autocomplete] Error fetching tag matches:', e);
      } finally {
        setIsAutocompleteLoading(false);
      }
    }, 120);

    return () => clearTimeout(delayDebounce);
  }, [activeTagQuery, activeProject?.id]);

  // Переписку слушает общий сокет оболочки (SocketProvider) и слушает всегда.
  // Здесь остаётся только страховочный опрос открытого разговора
  useEffect(() => {
    if (user?.id) startPolling(user.id);
    return () => stopPolling();
  }, [user?.id, activeReceiverId, activeGroupId]);

  /**
   * Подгрузка ранних: держим место чтения.
   *
   * Сообщения добавляются СВЕРХУ, а браузер сохраняет scrollTop — из-за этого
   * список уезжал вниз на высоту добавленного, и инженер терял то место, где
   * читал. Запоминаем расстояние до низа и восстанавливаем его после отрисовки.
   */
  const keepAnchorRef = useRef<number | null>(null);
  const handleLoadEarlier = () => {
    const el = messagesContainerRef.current;
    keepAnchorRef.current = el ? el.scrollHeight - el.scrollTop : null;
    if (user?.id) loadEarlier(user.id);
  };
  useLayoutEffect(() => {
    const el = messagesContainerRef.current;
    if (!el || keepAnchorRef.current === null) return;
    el.scrollTop = el.scrollHeight - keepAnchorRef.current;
    keepAnchorRef.current = null;
  }, [messages]);

  // Scroll on message add: только при новых сообщениях и только если пользователь у низа
  useEffect(() => {
    // Подгрузили ранние — низ списка не менялся, доскроллить нас не должно
    if (keepAnchorRef.current !== null) return;
    const lastId = messages.length > 0 ? messages[messages.length - 1].id : null;
    if (lastId === lastMessageIdRef.current) return;
    const isFirstLoad = lastMessageIdRef.current === null;
    lastMessageIdRef.current = lastId;

    const container = messagesContainerRef.current;
    const nearBottom = !container ||
      container.scrollHeight - container.scrollTop - container.clientHeight < 160;
    const lastMsg = messages[messages.length - 1];
    const isOwn = lastMsg && lastMsg.senderId === user?.id;

    if (isFirstLoad || nearBottom || isOwn) {
      chatEndRef.current?.scrollIntoView({ behavior: isFirstLoad ? 'auto' : 'smooth' });
    }
  }, [messages]);

  // При смене собеседника/группы сбрасываем трекер последнего сообщения
  useEffect(() => {
    lastMessageIdRef.current = null;
  }, [activeReceiverId, activeGroupId]);

  // Load project equipment components for dialog picker
  useEffect(() => {
    if (activeProject && isEquipmentModalOpen) {
      fetch(`/api/projects/${activeProject.id}/systems`)
        .then(res => res.json())
        .then(data => {
          if (data.systems) {
            const comps = data.systems.flatMap((sys: any) => 
              (sys.monoblocks || []).flatMap((mono: any) => 
                (mono.components || []).map((c: any) => ({
                  ...c,
                  systemName: sys.name,
                  monoblockName: mono.name
                }))
              )
            );
            setProjectComponents(comps);
          }
        })
        .catch(err => console.error('[Chat] Error loading project components:', err));
    }
  }, [activeProject, isEquipmentModalOpen]);

  // Load screenshot onto canvas and setup standard parameters
  useEffect(() => {
    if (isAnnotating && screenshotData && canvasRef.current) {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = screenshotData;
        img.onload = () => {
          canvas.width = img.naturalWidth || 1280;
          canvas.height = img.naturalHeight || 720;
          ctx.drawImage(img, 0, 0);
          ctx.strokeStyle = '#dc2626'; // engineering red annotation marker
          ctx.lineWidth = 4;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
        };
      }
    }
  }, [isAnnotating, screenshotData]);

  // Поиск по людям и группам одной строкой — src/lib/chatSearch.ts
  const filteredUsers = matchUsers(users, user?.id, searchQuery);
  const filteredGroups = matchGroups(groups, searchQuery);

  const activePeer = users.find(u => u.id === activeReceiverId);
  const activeGroup = groups.find(g => g.id === activeGroupId);

  // Кто сейчас в сети. Список общий на всю программу и приходит сокетом;
  // администратор в нём наравне со всеми — скрытое присутствие начальства
  // означало бы, что одни видят, кому можно писать, а другие пишут в пустоту
  const onlineIds = usePresenceStore(s => s.online);
  const lastSeenMap = usePresenceStore(s => s.lastSeen);
  const peerOnline = !!activePeer && onlineIds.includes(activePeer.id);
  const peerSeen = activePeer ? (lastSeenMap[activePeer.id] ?? null) : null;

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      addToast('Загрузка файла во вложение...', 'info');
      const reader = new FileReader();
      reader.onloadend = async () => {
        try {
          const rawResult = reader.result as string;
          const base64Data = rawResult.split(',')[1];
          const uploaded = await uploadFile(file.name, base64Data);
          
          setStagedAttachments(prev => [...prev, {
            fileName: uploaded.fileName,
            filePath: uploaded.filePath,
            fileSize: uploaded.fileSize
          }]);
          addToast(`Файл "${file.name}" успешно прикреплен!`, 'success');
        } catch (uploadErr) {
          addToast('Ошибка заливки файла на сервер', 'error');
        }
      };
      reader.readAsDataURL(file);
    } catch (err) {
      addToast('Не удалось обработать файл', 'error');
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Вызов помощника через «@» — components/chat/useAssistantCall: там же и
  // правило приватности, по которому он видит только заданный вопрос
  const maybeAskAssistant = useAssistantCall({
    me: user,
    projectId: activeProject?.id || null,
    say: (userId, text, projectId) => sendMessage(userId, text, null, projectId, [], null),
    toast: (text, kind) => addToast(text, kind),
  });

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!user) return;
    if (isSendingMessage) return;
    if (!messageText.trim() && stagedAttachments.length === 0 && !selectedElementId) {
      return;
    }

    setIsSendingMessage(true);
    try {
      if (editingMessage) {
        await editMessage(user.id, editingMessage.id, messageText);
        setEditingMessage(null);
      } else {
        await sendMessage(
          user.id,
          messageText,
          selectedElementId,
          activeProject?.id || null,
          stagedAttachments,
          replyTarget?.id || null
        );
        setReplyTarget(null);
      }

      setMessageText('');
      setStagedAttachments([]);
      setSelectedElementId(null);
      setSelectedElementName(null);

      // Сообщение, начатое с «@помощник», кроме собеседников уходит и ему
      void maybeAskAssistant(messageText, !!editingMessage);
      // Возвращаем фокус в поле — чтобы можно было сразу печатать дальше
      requestAnimationFrame(() => messageInputRef.current?.focus());
    } catch (err: any) {
      addToast('Ошибка отправки сообщения: ' + err.message, 'error');
    } finally {
      setIsSendingMessage(false);
    }
  };

  // Действия над сообщением (как в обычных мессенджерах)
  const handleStartReply = (msg: ChatMessage) => {
    setEditingMessage(null);
    setReplyTarget(msg);
    messageInputRef.current?.focus();
  };

  const handleStartEdit = (msg: ChatMessage) => {
    setReplyTarget(null);
    setEditingMessage(msg);
    setMessageText(msg.content);
    messageInputRef.current?.focus();
  };

  const handleCancelComposeMode = () => {
    if (editingMessage) setMessageText('');
    setReplyTarget(null);
    setEditingMessage(null);
  };

  const handleCopyMessage = async (msg: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(msg.content);
      addToast('Текст сообщения скопирован', 'success');
    } catch (e) {
      addToast('Не удалось скопировать', 'error');
    }
  };

  const handleDeleteMessage = async (msg: ChatMessage) => {
    if (!user) return;
    if (!await openConfirm('Удалить сообщение?', 'Сообщение и вложения к нему исчезнут у всех участников. Действие необратимо.', { confirmLabel: 'Удалить', tone: 'danger' })) return;
    try {
      await deleteMessage(user.id, msg.id);
      addToast('Сообщение удалено', 'success');
    } catch (err: any) {
      addToast(err.message || 'Не удалось удалить сообщение', 'error');
    }
  };

  const {
    reactToMessage, pinMessage, forwardMessage, clearConversation,
    createGroup, updateGroup, deleteGroup,
  } = useChatStore();

  const REACTION_EMOJIS = ['👍', '❤️', '🔥', '✅', '❌', '😄', '🙏', '👀'];

  const handleReact = async (msg: ChatMessage, emoji: string) => {
    if (!user) return;
    setReactPickerFor(null);
    try { await reactToMessage(user.id, msg.id, emoji); } catch (_) {}
  };

  const handlePin = async (msg: ChatMessage) => {
    if (!user) return;
    try {
      await pinMessage(user.id, msg.id);
      addToast(msg.pinned ? 'Сообщение откреплено' : 'Сообщение закреплено', 'success');
    } catch (_) { addToast('Не удалось изменить закрепление', 'error'); }
  };

  const handleForwardTo = async (target: { groupId?: string; receiverId?: string }) => {
    if (!user || !forwardFor) return;
    try {
      await forwardMessage(user.id, forwardFor.id, target);
      addToast('Сообщение переслано', 'success');
      setForwardFor(null);
    } catch (err: any) {
      addToast(err.message || 'Не удалось переслать', 'error');
    }
  };

  const handleClearHistory = async () => {
    if (!user) return;
    setShowChatMenu(false);
    if (!await openConfirm('Очистить переписку?', 'Все сообщения и вложения в этом диалоге будут удалены у всех участников. Действие необратимо.', { confirmLabel: 'Очистить', tone: 'danger' })) return;
    try {
      await clearConversation(user.id);
      addToast('История очищена', 'success');
    } catch (_) { addToast('Не удалось очистить историю', 'error'); }
  };

  // Разбор JSON-реакций сообщения в массив { emoji, count, mine }
  const parseReactions = (msg: ChatMessage): { emoji: string; count: number; mine: boolean }[] => {
    if (!msg.reactions) return [];
    try {
      const obj = JSON.parse(msg.reactions) as Record<string, string[]>;
      return Object.entries(obj).map(([emoji, ids]) => ({
        emoji, count: ids.length, mine: !!user && ids.includes(user.id),
      }));
    } catch (_) { return []; }
  };

  const pinnedMessages = messages.filter(m => m.pinned);
  const isChannel = activeGroup?.type === 'CHANNEL';
  const canPostInActive = !isChannel || (activeGroup?.ownerId === user?.id) || user?.role === 'ADMIN';

  const EMOJIS = ['👍','✅','❌','🔥','⚠️','📐','🔧','⚙️','📊','📁','💡','🚀','👌','🙏','😀','😄','😅','🤔','😐','😢','💪','🤝','📌','⏰','❗','❓','🟢','🔴'];

  const insertEmoji = (emoji: string) => {
    if (messageInputRef.current) {
      messageInputRef.current.insertText(emoji);
    } else {
      setMessageText(prev => prev + emoji);
    }
    setShowEmojiPicker(false);
  };

  const handleEquipmentClick = (elementId: string) => {
    if (!elementId) return;
    addToast('Переход к узлу MAX-оборудования...', 'success');
    navigate(`/equipment?elementId=${elementId}`);
  };

  const formatBytes = (bytes: number, decimals = 2) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  };

  const filteredComps = projectComponents.filter(c => 
    c.name.toLowerCase().includes(compSearch.toLowerCase()) || 
    c.itemCode.toLowerCase().includes(compSearch.toLowerCase())
  );

  const allHistoryAttachments = messages.flatMap(m => m.attachments || []);

  // Поиск по текущей переписке
  const visibleMessages = conversationSearch.trim()
    ? messages.filter(m => m.content.toLowerCase().includes(conversationSearch.trim().toLowerCase()))
    : messages;

  // Разбивка на кучки подряд идущих сообщений одного человека (grouping.ts)
  const groupMarks = React.useMemo(() => markGroups(visibleMessages), [visibleMessages]);

  /** Перейти к сообщению, на которое отвечали, и подсветить его. */
  const jumpToMessage = (id: string) => {
    const el = document.getElementById(`msg-${id}`);
    if (!el) { addToast('Это сообщение осталось выше — нажмите «Показать более ранние».', 'info'); return; }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('flux-hb-flash');
    window.setTimeout(() => el.classList.remove('flux-hb-flash'), 2000);
  };

  /**
   * Тег, отправленный в чат, ведёт к самой вещи, а не в раздел «вообще».
   *
   * Здесь чинились сразу две вещи. Раздел «Оборудование» открывался по адресу
   * `?elementId=`, а ждёт он `?element=` — параметр молча пропадал, и человек
   * попадал в раздел, где сам искал позицию глазами. А тег, который есть в
   * реестре, но ещё не привязан к оборудованию, объявлялся «не
   * зарегистрированным в базе»: сообщение об ошибке про тег, заведённый час
   * назад тем же человеком.
   */
  const handleTagClick = async (tag: string) => {
    try {
      const pid = activeProject?.id || '';
      const res = await fetch(`/api/chat/search-element?tag=${encodeURIComponent(tag)}${pid ? `&projectId=${encodeURIComponent(pid)}` : ''}`);
      const data = res.ok ? await res.json() : {};

      if (data.element) {
        navigate(`/equipment?element=${encodeURIComponent(data.element.id)}`);
        return;
      }
      if (data.tag) {
        navigate(`/registry?focus=${encodeURIComponent(data.tag.id)}`);
        return;
      }
      if (data.elsewhere) {
        addToast(`Тег ${tag} — из проекта «${data.elsewhere.project?.name || 'другого'}». Переключите проект, чтобы открыть его.`, 'info');
        return;
      }
      addToast(`Тег ${tag} в этом проекте не найден — возможно, он ещё не заведён.`, 'info');
    } catch (err: any) {
      addToast('Не удалось найти тег: ' + err.message, 'error');
    }
  };

  // CAPTURE SCREENSHOT TRIGGER
  const handleCaptureScreen = async () => {
    const win = window as any;
    try {
      addToast('Захват экрана в процессе...', 'info');
      let dataUrl = '';
      if (win.electron && win.electron.ipcRenderer) {
        dataUrl = await win.electron.ipcRenderer.invoke('desktop:capture');
      } else {
        // Web grid blueprint canvas simulation for cloud environments
        const canvas = document.createElement('canvas');
        canvas.width = 1200;
        canvas.height = 700;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          // grid background
          ctx.fillStyle = '#0f172a';
          ctx.fillRect(0, 0, 1200, 700);

          ctx.strokeStyle = '#1e293b';
          ctx.lineWidth = 1;
          for (let x = 0; x < 1200; x += 40) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, 700);
            ctx.stroke();
          }
          for (let y = 0; y < 700; y += 40) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(1200, y);
            ctx.stroke();
          }

          // draw mechanical shapes
          ctx.strokeStyle = '#10b981';
          ctx.lineWidth = 3;
          ctx.strokeRect(300, 200, 600, 300);

          ctx.strokeStyle = '#38bdf8';
          ctx.beginPath();
          ctx.arc(600, 350, 90, 0, Math.PI * 2);
          ctx.stroke();

          ctx.fillStyle = '#f8fafc';
          ctx.font = 'bold 22px monospace';
          ctx.fillText('MAX ENGINEERING CAPTURE: SCHEMATIC AHU-2', 80, 80);
          ctx.fillStyle = '#64748b';
          ctx.font = '13px monospace';
          ctx.fillText(`Сгенерирован: ${new Date().toLocaleString()} • Web-окружение`, 80, 110);
        }
        dataUrl = canvas.toDataURL('image/png');
      }

      setScreenshotData(dataUrl);
      setIsAnnotating(true);
      addToast('Снимок готов к нанесению аннотаций!', 'success');
    } catch (err: any) {
      addToast('Не удалось совершить захват экрана: ' + err.message, 'error');
    }
  };

  // Drawing mouse handlers for red pen canvas markings
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    ctx.beginPath();
    ctx.moveTo(x, y);
    setIsDrawing(true);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const handleMouseUp = () => {
    setIsDrawing(false);
  };

  const handleClearDrawing = () => {
    if (!canvasRef.current || !screenshotData) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = screenshotData;
      img.onload = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
      };
    }
  };

  const handleSendDrawing = async () => {
    if (!canvasRef.current) return;
    try {
      addToast('Заливка снимка на сетевой сервер...', 'info');
      // Превращение холста в файл — в src/lib/chatDrawing.ts
      const uploaded = await canvasAttachment(canvasRef.current, uploadFile);
      setStagedAttachments(prev => [...prev, uploaded]);
      setIsAnnotating(false);
      setScreenshotData(null);
      addToast('Аннотированный скриншот прикреплен к сообщениям!', 'success');
    } catch (err: any) {
      addToast('Ошибка загрузки рисунка с экрана: ' + err.message, 'error');
    }
  };

  return (
    <div className="h-full flex bg-white dark:bg-slate-900 rounded-xl overflow-hidden shadow-xs border border-slate-200 dark:border-slate-800 transition-colors">
      
      {/* LEFT PANEL: Users List & Automated Project Rooms */}
      <div className="w-44 @[700px]:w-56 @[900px]:w-80 flex flex-col border-r border-slate-200 dark:border-slate-800 shrink-0 bg-slate-50/55 dark:bg-slate-900/40 select-none">
        
        {/* Top Header & Fast Search bar */}
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 shrink-0">
          <h2 className="text-base font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2 mb-3">
            <MessageSquare className="w-4 h-4 text-emerald-650 dark:text-emerald-400" />
            Чат
          </h2>
          <div className="relative">
            <input
              type="text"
              placeholder="Найти собеседника по ФИО"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full text-xs pl-8 pr-3 py-2 bg-white dark:bg-slate-950 border border-slate-250 dark:border-slate-850 rounded-lg text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-hidden focus:ring-1 focus:ring-emerald-500 transition-ui font-sans"
            />
            <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-slate-400" />
          </div>
        </div>

        {/* Categories channels scrolling container */}
        <div data-tour="chat-peers" className="flex-1 overflow-y-auto p-2 space-y-4">

          {/* Помощник — закреплённый первым разговор, а не программа, в которую
              надо идти (components/chat/AssistantEntry) */}
          <AssistantEntry />

          {/* Section 1: Groups & Channels */}
          <div className="space-y-1">
            <div className="px-3 py-1 flex items-center justify-between">
              <span className="text-xs font-extrabold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
                Группы и каналы
              </span>
              <button
                type="button"
                onClick={() => setShowCreateGroup(true)}
                className="p-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer transition-colors"
                title="Создать группу или канал"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
            {groups.length === 0 ? (
              <p className="text-xs p-3 text-slate-400 italic">Групп пока нет. Нажмите «+», чтобы создать.</p>
            ) : filteredGroups.length === 0 ? (
              // Группы есть, но поиск их не нашёл — молча пустеть список не должен
              <p className="text-xs p-3 text-slate-400 italic">По запросу групп не найдено.</p>
            ) : (
              filteredGroups.map((g) => {
                const active = g.id === activeGroupId;
                const unread = chatUnreadByKey[`group=${g.id}`] || 0;
                const isCh = g.type === 'CHANNEL';
                const isProj = g.type === 'PROJECT';
                const subtitle = isCh ? 'Канал' : isProj ? 'Группа проекта' : `Группа · ${g.members?.length || 0} уч.`;
                return (
                  <button type="button"
                    key={g.id}
                    onClick={() => setActiveGroupId(g.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-ui ${
                      active
                        ? 'bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/40 text-emerald-900 dark:text-white'
                        : 'hover:bg-slate-100/75 dark:hover:bg-slate-800/40 border border-transparent'
                    }`}
                  >
                    <div className="w-8 h-8 rounded-lg bg-emerald-100 dark:bg-emerald-950 flex items-center justify-center shrink-0 border border-emerald-200 dark:border-emerald-850 text-emerald-700 dark:text-emerald-400">
                      {isCh ? <Radio className="w-4 h-4" /> : <Users className="w-4 h-4" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-bold text-slate-850 dark:text-white block truncate leading-tight">
                        {g.name}
                      </span>
                      <span className="text-xs text-slate-400 font-semibold block truncate mt-0.5">
                        {subtitle}
                      </span>
                    </div>
                    {unread > 0 && !active && <UnreadDot n={unread} />}
                  </button>
                );
              })
            )}
          </div>

          {/* Section 2: Direct Messages (Личные диалоги) */}
          <div className="space-y-1">
            <div className="px-3 py-1 text-xs font-extrabold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
              Личные диалоги
            </div>
            {filteredUsers.length === 0 ? (
              <div className="text-center py-6 text-xs text-slate-400">
                {searchQuery.trim() ? 'По запросу сотрудников не найдено' : 'Пока нет других сотрудников'}
              </div>
            ) : (
              filteredUsers.map((u) => {
                const active = u.id === activeReceiverId;
                const unread = chatUnreadByKey[`from=${u.id}`] || 0;
                return (
                  <button type="button"
                    key={u.id}
                    onClick={() => setActiveReceiverId(u.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-ui ${
                      active 
                        ? 'bg-emerald-50 dark:bg-emerald-950/25 border border-emerald-250 dark:border-emerald-900/50' 
                        : 'hover:bg-slate-100/70 dark:hover:bg-slate-800/50 border border-transparent'
                    }`}
                  >
                    <div className="relative shrink-0">
                      <div className="w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-850 flex items-center justify-center text-xs font-bold text-emerald-750 dark:text-emerald-400 border border-slate-300 dark:border-slate-700">
                        {u.name.charAt(0)}
                      </div>
                      {/* Точка «в сети» на самом значке, а не строкой рядом:
                          её видно боковым зрением, не читая */}
                      {onlineIds.includes(u.id) && (
                        <span
                          aria-label="В сети"
                          title="В сети"
                          className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-500
                                     border-2 border-slate-50 dark:border-slate-900"
                        />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className={`text-xs truncate ${unread > 0 && !active
                          ? 'font-extrabold text-slate-900 dark:text-white'
                          : 'font-bold text-slate-850 dark:text-white'}`}>
                          {u.name}
                        </span>
                        {unread > 0 && !active && <UnreadDot n={unread} />}
                      </div>
                      <div className="flex items-center justify-between text-xs text-slate-400 leading-normal mt-0.5">
                        <span className="truncate">Таб: {u.symbol}</span>
                        <span className="shrink-0 text-slate-500 font-mono bg-slate-100 dark:bg-slate-950 px-1 rounded text-xs">
                          {u.role.replace('ENGINEER_', '')}
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>

        </div>
      </div>

      {/* CENTRAL PANEL: Messages Area stream */}
      <div className="flex-1 flex flex-col min-w-0 bg-white dark:bg-slate-900 relative">
        {(activePeer || activeGroup) ? (
          <>
            {/* Thread Header Info bar */}
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-white dark:bg-slate-900 shrink-0 select-none">
              <div className="flex items-center gap-3">
                {activeType === 'DIRECT' && activePeer ? (
                  <>
                    <div className="relative">
                      <div className="w-9 h-9 rounded-full bg-emerald-100 dark:bg-emerald-950/45 flex items-center justify-center text-sm font-bold text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900">
                        {activePeer.name.charAt(0)}
                      </div>
                      {peerOnline && (
                        <span
                          aria-label="В сети"
                          className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-500
                                     border-2 border-white dark:border-slate-900"
                        />
                      )}
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100 leading-tight">
                        {activePeer.name}
                      </h3>
                      {/* «В сети» стоит первым: прежде чем писать, человек
                          решает, ждать ли ответа сейчас */}
                      <p className="text-xs leading-snug mt-0.5">
                        <span className={peerOnline
                          ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                          : 'text-slate-400'}>
                          {presenceLabel(peerOnline, peerSeen)}
                        </span>
                        <span className="text-slate-400"> • Таб. {activePeer.symbol} • {activePeer.role}</span>
                      </p>
                    </div>
                  </>
                ) : activeGroup ? (
                  <>
                    <div className="w-9 h-9 rounded-lg bg-emerald-100 dark:bg-emerald-950/45 flex items-center justify-center text-sm font-bold text-emerald-800 dark:text-emerald-300 border border-emerald-205 dark:border-emerald-855">
                      👥
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100 leading-tight">
                        {activeGroup.name}
                      </h3>
                      <p className="text-xs text-slate-400 leading-snug mt-0.5 truncate max-w-lg">
                        Тип: Комната Проекта • Сквозная синхронизация сотрудников
                      </p>
                    </div>
                  </>
                ) : null}
              </div>
              
              <div className="flex items-center gap-2">
                {/* Поиск по сообщениям текущей переписки */}
                <div className="relative">
                  <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-slate-400" />
                  <input
                    type="text"
                    value={conversationSearch}
                    onChange={(e) => setConversationSearch(e.target.value)}
                    placeholder="Поиск в переписке..."
                    className="w-44 pl-8 pr-7 py-1.5 bg-slate-100/70 dark:bg-slate-950 border border-transparent dark:border-slate-800 rounded-lg text-xs text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 focus:border-emerald-500 transition-ui"
                  />
                  {conversationSearch && (
                    <button
                      type="button"
                      onClick={() => setConversationSearch('')}
                      className="absolute right-1.5 top-1.5 p-0.5 text-slate-400 hover:text-rose-500 cursor-pointer"
                      title="Сбросить поиск"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {/* Меню диалога: настройки группы, очистка истории, удаление */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowChatMenu(!showChatMenu)}
                    className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-white transition-colors cursor-pointer"
                    title="Действия"
                  >
                    <MoreVertical className="w-5 h-5" />
                  </button>
                  {showChatMenu && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setShowChatMenu(false)} />
                      <div className="absolute right-0 top-full mt-1 z-50 w-56 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl py-1">
                        {activeGroup && activeGroup.type !== 'PROJECT' && (
                          <button type="button" onClick={() => { setShowChatMenu(false); setShowGroupSettings(true); }} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">
                            <Settings className="w-3.5 h-3.5" /> Настройки {activeGroup.type === 'CHANNEL' ? 'канала' : 'группы'}
                          </button>
                        )}
                        <button type="button" onClick={handleClearHistory} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">
                          <Trash2 className="w-3.5 h-3.5" /> Очистить историю
                        </button>
                        {activeGroup && activeGroup.type !== 'PROJECT' && (activeGroup.ownerId === user?.id || user?.role === 'ADMIN') && (
                          <button type="button" onClick={async () => { setShowChatMenu(false); if (await openConfirm(`Удалить ${activeGroup.type === 'CHANNEL' ? 'канал' : 'группу'} «${activeGroup.name}»?`, 'Вся переписка и вложения будут удалены у всех участников. Действие необратимо.', { confirmLabel: 'Удалить', tone: 'danger' }) && user) { try { await deleteGroup(activeGroup.id, user.id); setActiveGroupId(null); addToast('Удалено', 'success'); } catch (e: any) { addToast(e.message, 'error'); } } }} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 cursor-pointer">
                            <Trash className="w-3.5 h-3.5" /> Удалить {activeGroup.type === 'CHANNEL' ? 'канал' : 'группу'}
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => setIsRightPanelOpen(!isRightPanelOpen)}
                  className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-white transition-colors cursor-pointer"
                  title="Подробная информация"
                >
                  {isRightPanelOpen ? <ChevronRight className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}
                </button>
              </div>
            </div>

            {/* Панель закреплённых сообщений */}
            {pinnedMessages.length > 0 && (
              <div className="px-4 py-2 border-b border-amber-200/60 dark:border-amber-900/40 bg-amber-50/60 dark:bg-amber-950/15 shrink-0 flex items-start gap-2">
                <Pin className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="text-2xs font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">Закреплено ({pinnedMessages.length})</div>
                  <div className="text-xs text-slate-600 dark:text-slate-300 truncate">{pinnedMessages[pinnedMessages.length - 1].content || 'Вложение'}</div>
                </div>
              </div>
            )}

            {/* Conversation Messages Lists */}
            <div
              ref={messagesContainerRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
                setShowScrollDown(!nearBottom);
              }}
              className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-50/50 dark:bg-slate-900/20 relative">
              {conversationSearch.trim() && (
                <div className="sticky top-0 z-10 -mt-1 mb-1 flex items-center justify-center">
                  <span className="px-3 py-1 rounded-full bg-emerald-600/90 text-white text-xs font-semibold shadow">
                    {visibleMessages.length === 0 ? 'Ничего не найдено' : `Найдено сообщений: ${visibleMessages.length}`}
                  </span>
                </div>
              )}
              {visibleMessages.length === 0 && !conversationSearch.trim() ? (
                <div className="h-full flex flex-col items-center justify-center p-6 text-center select-none">
                  <MessageSquare className="w-8 h-8 text-slate-300 dark:text-slate-700 mb-2 animate-bounce" />
                  <p className="text-xs text-slate-400 mt-1 max-w-xs">
                    Напечатайте текст с инженерными тегами вида <span className="font-mono text-emerald-500 font-bold">#бл2.1</span> или привяжите спецификацию
                  </p>
                </div>
              ) : (
                <>
                {/* Показываем хвост переписки; ранние подтягиваются по требованию.
                    Тянуть многолетний чат целиком на каждое событие — дорого */}
                {hasEarlier && !conversationSearch.trim() && (
                  <div className="flex justify-center py-2">
                    <button
                      onClick={handleLoadEarlier}
                      className="text-2xs font-bold px-3 py-1.5 rounded-full border border-slate-200
                                 dark:border-slate-700 text-slate-500 hover:text-emerald-600
                                 hover:border-emerald-500 cursor-pointer bg-white dark:bg-slate-900"
                    >
                      Показать более ранние
                    </button>
                  </div>
                )}
                {visibleMessages.map((msg, msgIndex) => {
                  const isMe = msg.senderId === user?.id;
                  const mark = groupMarks[msgIndex];
                  return (
                    <React.Fragment key={msg.id}>
                      {mark.newDay && <DayDivider label={mark.dayLabel} />}
                      <MessageBubble
                        msg={msg as any}
                        isMe={isMe}
                        mark={mark}
                        hideNames={!activeGroupId}
                        reactions={parseReactions(msg)}
                        emojis={REACTION_EMOJIS}
                        pickerOpen={reactPickerFor === msg.id}
                        onTogglePicker={() => setReactPickerFor(reactPickerFor === msg.id ? null : msg.id)}
                        onReact={(em) => handleReact(msg, em)}
                        onReply={() => handleStartReply(msg)}
                        onForward={() => setForwardFor(msg)}
                        onPin={() => handlePin(msg)}
                        onCopy={() => handleCopyMessage(msg)}
                        onEdit={() => handleStartEdit(msg)}
                        onDelete={() => handleDeleteMessage(msg)}
                        onOpenEquipment={handleEquipmentClick}
                        onOpenFile={openFile}
                        onJumpTo={jumpToMessage}
                        formatBytes={formatBytes}
                      >
                        <FormattedMessage text={msg.content} onTagClick={handleTagClick} onShareClick={handleShareClick} />
                      </MessageBubble>
                    </React.Fragment>
                  );
                })}
                </>
              )}
              {/* Кнопка быстрого возврата к последним сообщениям */}
              {showScrollDown && (
                <div className="sticky bottom-1 z-10 flex justify-end pointer-events-none">
                  <button type="button"
                    onClick={scrollToBottom}
                    className="pointer-events-auto w-9 h-9 rounded-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-lg flex items-center justify-center text-slate-500 hover:text-emerald-600 dark:hover:text-emerald-400 cursor-pointer transition-colors"
                    title="К последним сообщениям"
                  >
                    <ChevronDown className="w-5 h-5" />
                  </button>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* В канале писать может только владелец/админ — остальным показываем заглушку */}
            {!canPostInActive ? (
              <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shrink-0 text-center text-xs text-slate-400 dark:text-slate-500 flex items-center justify-center gap-2">
                <Radio className="w-4 h-4" /> Это канал — публиковать может только владелец или администратор.
              </div>
            ) : (
            /* Input Form Panel */
            <form onSubmit={handleSend} className="p-3 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-2 shrink-0 relative">
              {(replyTarget || editingMessage) && (
                <div className="flex items-center justify-between gap-2 px-3 py-2 bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/50 rounded-lg select-none">
                  <div className="flex items-center gap-2 min-w-0">
                    {editingMessage ? (
                      <Pencil className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                    ) : (
                      <Reply className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <div className="text-2xs font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                        {editingMessage ? 'Редактирование сообщения' : `Ответ: ${replyTarget?.sender?.name || ''}`}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                        {(editingMessage?.content || replyTarget?.content || '').slice(0, 120)}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleCancelComposeMode}
                    className="p-1 text-slate-400 hover:text-rose-500 rounded cursor-pointer shrink-0"
                    title="Отменить"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}
              
              {/* Autocomplete suggestions dropdown panel right above input bar */}
              {autocompleteSuggestions.length > 0 && (
                <div id="tag-autocomplete-dropdown" className="absolute bottom-full left-3 right-3 mb-2 max-h-56 bg-white dark:bg-slate-950 border border-slate-200 dark:border-emerald-950 rounded-xl shadow-2xl overflow-y-auto z-50 divide-y divide-slate-100 dark:divide-slate-900 animate-in fade-in slide-in-from-bottom-2 duration-150">
                  <div className="p-2 bg-slate-50 dark:bg-slate-900/60 text-xs font-extrabold text-slate-400 dark:text-slate-500 uppercase tracking-widest flex items-center justify-between select-none border-b border-slate-100 dark:border-slate-900">
                    <span>💡 Подходящие к вводу MAX/KKS теги</span>
                    <span className="font-mono text-xs opacity-80">Клавиши ↑ ↓ Enter для ввода</span>
                  </div>
                  {autocompleteSuggestions.map((sug, idx) => {
                    const active = idx === autocompleteIndex;
                    return (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => insertTagAtCursor(sug.text)}
                        onMouseEnter={() => setAutocompleteIndex(idx)}
                        className={`w-full text-left p-2.5 flex flex-col gap-1 transition-ui text-xs border-l-2 outline-hidden cursor-pointer ${
                          active 
                            ? 'bg-emerald-50 dark:bg-emerald-950/25 border-emerald-650 text-slate-900 dark:text-white font-semibold' 
                            : 'border-transparent hover:bg-slate-50 dark:hover:bg-slate-900/10 text-slate-700 dark:text-slate-350'
                        }`}
                      >
                        <span className="font-mono text-xs text-emerald-700 dark:text-emerald-400 font-extrabold flex items-center gap-0.5">
                          #{sug.text}
                        </span>
                        <span className="text-xs text-slate-450 dark:text-slate-500 leading-normal truncate">
                          {sug.description}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Draft additions header */}
              {(stagedAttachments.length > 0 || selectedElementId) && (
                <div className="flex flex-wrap gap-2 py-1 items-center select-none">
                  {selectedElementId && (
                    <div className="flex items-center gap-1.5 px-2 py-1 bg-emerald-50 dark:bg-emerald-955/20 border border-emerald-250 dark:border-emerald-900 rounded-md text-xs text-emerald-800 dark:text-emerald-400 font-bold shrink-0">
                      <LinkIcon className="w-3.5 h-3.5 text-emerald-600" />
                      <span>Связь: {selectedElementName}</span>
                      <button 
                        type="button" 
                        onClick={() => { setSelectedElementId(null); setSelectedElementName(null); }}
                        className="p-0.5 hover:bg-emerald-100 dark:hover:bg-emerald-900 rounded cursor-pointer"
                      >
                        <X className="w-3 h-3 text-emerald-600" />
                      </button>
                    </div>
                  )}

                  {stagedAttachments.map((att, idx) => (
                    <div 
                      key={idx} 
                      className="flex items-center gap-1.5 px-2 py-1 bg-slate-105 dark:bg-slate-950/45 border border-slate-200 dark:border-slate-850 rounded-md text-xs text-slate-600 dark:text-slate-400 shrink-0"
                    >
                      <File className="w-3.5 h-3.5 text-emerald-500" />
                      <span className="truncate max-w-[120px]">{att.fileName}</span>
                      <button 
                        type="button" 
                        onClick={() => setStagedAttachments(prev => prev.filter((_, i) => i !== idx))}
                        className="p-0.5 hover:bg-slate-200 dark:hover:bg-slate-800 rounded cursor-pointer"
                      >
                        <X className="w-3 h-3 text-slate-500" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Controls bar layout */}
              <div className="flex items-center gap-2">
                <input 
                  type="file" 
                  ref={fileInputRef} 
                  onChange={handleFileChange} 
                  className="hidden" 
                />
                
                {/* 1. File Upload */}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="p-2 bg-slate-50 hover:bg-slate-100 dark:bg-slate-950 dark:hover:bg-slate-800 border border-slate-250 dark:border-slate-850 rounded-lg text-slate-500 hover:text-emerald-700 dark:hover:text-emerald-400 transition-colors cursor-pointer"
                  title="Прикрепить файл чертежа"
                >
                  <Paperclip className="w-4 h-4" />
                </button>

                {/* 2. Link PDM specification */}
                <button
                  type="button"
                  onClick={() => setIsEquipmentModalOpen(true)}
                  className="p-2 bg-slate-50 hover:bg-slate-100 dark:bg-slate-950 dark:hover:bg-slate-800 border border-slate-250 dark:border-slate-850 rounded-lg text-slate-500 hover:text-emerald-700 dark:hover:text-emerald-400 transition-colors cursor-pointer"
                  title="Привязать узел оборудования"
                >
                  <LinkIcon className="w-4 h-4" />
                </button>

                {/* 3. Fast Screenshot Capturer button (Camera Icon) */}
                <button
                  type="button"
                  onClick={handleCaptureScreen}
                  className="p-2 bg-slate-50 hover:bg-slate-100 dark:bg-slate-950 dark:hover:bg-slate-800 border border-slate-250 dark:border-slate-850 rounded-lg text-rose-500 hover:text-rose-700 dark:hover:text-rose-450 transition-colors cursor-pointer"
                  title="Инженерный снимок экрана с разметкой"
                >
                  <Camera className="w-4 h-4" />
                </button>

                {/* Emoji picker */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                    className="p-2 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer transition-colors"
                    title="Эмодзи"
                  >
                    <Smile className="w-4 h-4" />
                  </button>
                  {showEmojiPicker && (
                    <div className="absolute bottom-full left-0 mb-2 p-2 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl grid grid-cols-7 gap-1 z-50 w-64">
                      {EMOJIS.map(em => (
                        <button
                          key={em}
                          type="button"
                          onClick={() => insertEmoji(em)}
                          className="w-8 h-8 flex items-center justify-center text-lg rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer transition-colors"
                        >
                          {em}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Rich-поле ввода: ссылки-теги отображаются чипами ещё до отправки */}
                <RichChatInput
                  ref={messageInputRef}
                  value={messageText}
                  onChange={setMessageText}
                  onCaretWord={handleCaretWord}
                  onSend={() => handleSend()}
                  placeholder="Напишите сообщение... (# — вставить тег, Shift+Enter — новая строка)"
                  onKeyDown={(e) => {
                    if (autocompleteSuggestions.length > 0) {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setAutocompleteIndex(prev => (prev + 1) % autocompleteSuggestions.length);
                      } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setAutocompleteIndex(prev => (prev - 1 + autocompleteSuggestions.length) % autocompleteSuggestions.length);
                      } else if (e.key === 'Enter') {
                        e.preventDefault();
                        const chosen = autocompleteSuggestions[autocompleteIndex];
                        if (chosen) {
                          insertTagAtCursor(chosen.text);
                        }
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setAutocompleteSuggestions([]);
                        setActiveTagQuery(null);
                      }
                    } else if (e.key === 'Escape' && (replyTarget || editingMessage)) {
                      e.preventDefault();
                      handleCancelComposeMode();
                    }
                  }}
                />

                <button
                  type="submit"
                  className="p-2 bg-emerald-650 hover:bg-emerald-800 text-white rounded-lg transition-colors cursor-pointer flex items-center justify-center shrink-0 shadow-sm"
                  title="Отправить сообщение"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </form>
            )}
          </>
        ) : (
          <div className="flex-1 min-w-0 flex flex-col items-center justify-center p-4 @[700px]:p-8 text-center bg-slate-50/20 select-none">
            <MessageSquare className="w-12 h-12 text-slate-200 dark:text-slate-800 mb-4 animate-pulse" />
            <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100 mb-1">
              Выберите диалог
            </h3>
            <p className="text-xs text-slate-400 max-w-sm min-w-0 leading-relaxed text-pretty">
              Слева — группы проекта и личные диалоги. Откройте любой, чтобы переписываться, ссылаться на оборудование и отправлять файлы.
            </p>
          </div>
        )}
      </div>

      {/* RIGHT PANEL: Collapsible Active Peer Profile / Dynamic TAG Card File History list */}
      {(activePeer || activeGroup) && isRightPanelOpen && (
        <div className="hidden @[1000px]:flex w-72 border-l border-slate-200 dark:border-slate-800 flex-col bg-slate-50/50 dark:bg-slate-900/40 select-none shrink-0 overflow-y-auto">
          
          {selectedTagElement ? (
            /* DYNAMIC TAG CARD SECTION (ФИЧА 2: Быстрая карточка тега) */
            <div className="flex-1 flex flex-col h-full select-none">
              <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-emerald-50/55 dark:bg-emerald-950/25">
                <span className="text-xs font-extrabold text-emerald-700 dark:text-emerald-400 uppercase tracking-wider flex items-center gap-1.5 font-sans">
                  ⚙️ Карточка тега
                </span>
                <button type="button" 
                  onClick={() => setSelectedTagElement(null)}
                  className="p-1 hover:bg-slate-200 dark:hover:bg-slate-800 rounded text-slate-400 hover:text-slate-800 dark:hover:text-white cursor-pointer transition-colors"
                  title="Вернуться к диалогу"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-5 space-y-4 text-left">
                <div className="space-y-1">
                  <h4 className="text-xs font-black text-slate-800 dark:text-white leading-snug">
                    {selectedTagElement.name}
                  </h4>
                  <p className="text-xs font-mono text-slate-400">
                    Код узла: {selectedTagElement.itemCode}
                  </p>
                </div>

                <div className="bg-white dark:bg-slate-950 p-3 rounded-lg border border-slate-200 dark:border-slate-800/80 space-y-2.5 shadow-3xs text-xs">
                  <div>
                    <span className="text-xs text-slate-400 uppercase block font-extrabold">Тип оборудования</span>
                    <span className="font-semibold text-slate-800 dark:text-slate-300 block mt-0.5">
                      {selectedTagElement.type || 'Спецификация MAX'}
                    </span>
                  </div>

                  {selectedTagElement.monoblock && (
                    <div>
                      <span className="text-xs text-slate-400 uppercase block font-extrabold">Моноблок</span>
                      <span className="font-semibold text-slate-800 dark:text-slate-300 block mt-0.5">
                        📦 {selectedTagElement.monoblock.name}
                      </span>
                    </div>
                  )}

                  {selectedTagElement.monoblock?.system && (
                    <div>
                      <span className="text-xs text-slate-400 uppercase block font-extrabold">Система</span>
                      <span className="font-semibold text-slate-800 dark:text-slate-300 block mt-0.5">
                        🌐 {selectedTagElement.monoblock.system.name}
                      </span>
                    </div>
                  )}
                </div>

                {/* Technical specifications */}
                <div className="space-y-1.5">
                  <h5 className="text-xs font-extrabold text-slate-400 uppercase tracking-wider">
                    Технические параметры
                  </h5>
                  <div className="bg-white dark:bg-slate-950 rounded-lg border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-900 overflow-hidden text-xs shadow-3xs">
                    {(() => {
                      try {
                        const specs = typeof selectedTagElement.specs === 'string'
                          ? JSON.parse(selectedTagElement.specs)
                          : selectedTagElement.specs;

                        if (specs && typeof specs === 'object' && Object.keys(specs).length > 0) {
                          return Object.entries(specs).map(([k, v]: [string, any]) => (
                            <div key={k} className="flex justify-between p-2">
                              <span className="text-slate-400">{k}:</span>
                              <span className="font-mono font-bold text-slate-705 dark:text-slate-300 text-xs">{String(v)}</span>
                            </div>
                          ));
                        }
                      } catch (e) {}
                      return (
                        <div className="p-3 text-center text-slate-400 text-xs italic">
                          Спецификации загружены из файла Excel
                        </div>
                      );
                    })()}
                  </div>
                </div>

                {/* Project Explorer switcher */}
                <button type="button"
                  onClick={() => {
                    addToast('Перенаправление в Проводник...', 'success');
                    navigate(`/equipment?elementId=${selectedTagElement.id}`);
                  }}
                  className="w-full py-2 bg-emerald-650 hover:bg-emerald-800 text-white font-bold rounded-lg text-xs transition-colors cursor-pointer flex items-center justify-center gap-1 shadow-sm"
                >
                  <LinkIcon className="w-3.5 h-3.5" />
                  Открыть в Проводнике
                </button>
              </div>
            </div>
          ) : (
            /* STANDARD PROFILE DIRECT / GROUP SECTION */
            <>
              {activeType === 'DIRECT' && activePeer ? (
                <div className="p-5 text-center border-b border-slate-200 dark:border-slate-800">
                  <div className="w-16 h-16 rounded-full bg-emerald-100 dark:bg-emerald-950/60 flex items-center justify-center text-xl font-bold text-emerald-800 dark:text-emerald-400 border border-emerald-250 dark:border-emerald-850/50 mx-auto mb-3">
                    {activePeer.name.charAt(0)}
                  </div>
                  <h4 className="text-xs font-extrabold text-slate-800 dark:text-white leading-tight truncate">
                    {activePeer.name}
                  </h4>
                  <p className="text-xs text-slate-400 mt-1 font-semibold bg-slate-100 dark:bg-slate-900 py-0.5 px-2 rounded-full inline-block">
                    {activePeer.role}
                  </p>
                  
                  <div className="mt-4 grid grid-cols-2 gap-2 text-left text-xs">
                    <div className="bg-white dark:bg-slate-950/50 p-2 rounded-lg border border-slate-150 dark:border-slate-850">
                      <p className="text-slate-400 text-xs leading-tight mb-0.5">Табель</p>
                      <p className="font-mono font-bold text-slate-700 dark:text-slate-300 truncate">{activePeer.symbol}</p>
                    </div>
                    <div className="bg-white dark:bg-slate-950/50 p-2 rounded-lg border border-slate-150 dark:border-slate-850">
                      <p className="text-slate-400 text-xs leading-tight mb-0.5">Переписка</p>
                      <p className="font-bold text-emerald-700 dark:text-emerald-400 leading-none mt-1 truncate">Личная</p>
                    </div>
                  </div>
                </div>
              ) : activeGroup ? (
                <div className="p-5 text-center border-b border-slate-200 dark:border-slate-800">
                  <div className="w-16 h-16 rounded-lg bg-emerald-100 dark:bg-emerald-950/60 flex items-center justify-center text-xl border border-emerald-250 dark:border-emerald-850/50 mx-auto mb-3">
                    👥
                  </div>
                  <h4 className="text-xs font-extrabold text-slate-800 dark:text-white leading-tight truncate">
                    {activeGroup.name}
                  </h4>
                  <p className="text-xs text-slate-400 mt-1 font-semibold bg-slate-100 dark:bg-slate-900 py-0.5 px-2 rounded-full inline-block">
                    Проектная комната
                  </p>
                  
                  <div className="mt-4 grid grid-cols-2 gap-2 text-left text-xs">
                    <div className="bg-white dark:bg-slate-950/50 p-2 rounded-lg border border-slate-150 dark:border-slate-850">
                      <p className="text-slate-400 text-xs leading-tight mb-0.5">Участники</p>
                      <p className="font-mono font-bold text-slate-700 dark:text-slate-300 truncate">Все сотрудники</p>
                    </div>
                    <div className="bg-white dark:bg-slate-950/50 p-2 rounded-lg border border-slate-150 dark:border-slate-850">
                      <p className="text-slate-400 text-xs leading-tight mb-0.5">Переписка</p>
                      <p className="font-bold text-emerald-700 dark:text-emerald-400 leading-none mt-1 truncate">Групповая</p>
                    </div>
                  </div>
                </div>
              ) : null}

              {/* Shared Files attachment listings */}
              <div className="flex-1 p-4 text-left">
                <h5 className="text-xs font-extrabold text-slate-400 uppercase tracking-wider mb-2.5 flex items-center gap-1.5">
                  <Paperclip className="w-3.5 h-3.5 text-slate-400" />
                  История вложений ({allHistoryAttachments.length})
                </h5>

                {allHistoryAttachments.length === 0 ? (
                  <div className="text-center py-8 text-slate-400 text-xs italic">
                    Вложения отсутствуют
                  </div>
                ) : (
                  <div className="space-y-1 max-h-[350px] overflow-y-auto pr-1">
                    {allHistoryAttachments.map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => openFile(f.filePath)}
                        className="w-full text-left flex items-center justify-between p-2 hover:bg-slate-100/80 dark:hover:bg-slate-800 border border-slate-100 dark:border-transparent rounded-lg cursor-pointer group transition-ui"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <File className="w-3.5 h-3.5 text-slate-450 shrink-0 group-hover:text-emerald-600" />
                          <div className="min-w-0">
                            <p className="text-xs font-bold text-slate-700 dark:text-slate-300 truncate group-hover:text-slate-950 dark:group-hover:text-emerald-400">
                              {f.fileName}
                            </p>
                            <p className="text-xs text-slate-400 font-mono">
                              {formatBytes(f.fileSize)}
                            </p>
                          </div>
                        </div>
                        <Download className="w-3 h-3 text-slate-400 hover:text-slate-700" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

        </div>
      )}

      {/* EQUIPMENT SELECTION PIE SYSTEM ATTACH DIALOG */}
      <AnimatePresence>
        {isEquipmentModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/55 backdrop-blur-md select-none">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white dark:bg-slate-900 border border-slate-250 dark:border-slate-800 shadow-2xl rounded-lg w-full max-w-lg overflow-hidden flex flex-col"
            >
              <div className="p-4 bg-slate-50 dark:bg-slate-950/40 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-slate-800 dark:text-white flex items-center gap-1.5 font-sans">
                    <Settings className="w-4 h-4 text-emerald-600 animate-spin" style={{ animationDuration: '6s' }} />
                    Привязка узла к сообщению
                  </h3>
                  <p className="text-xs text-slate-400 mt-1">
                    Проект: {activeProject?.name || 'все проекты'}
                  </p>
                </div>
                <button 
                  type="button"
                  onClick={() => setIsEquipmentModalOpen(false)}
                  className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white rounded-md cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-3 border-b border-slate-150 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/20">
                <div className="relative">
                  <input
                    type="text"
                    placeholder="Поиск по наименованию детали в спецификации MAX..."
                    value={compSearch}
                    onChange={(e) => setCompSearch(e.target.value)}
                    className="w-full text-xs pl-8 pr-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-250 dark:border-slate-850 rounded-lg text-slate-800 dark:text-slate-100 focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
                  />
                  <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-slate-400" />
                </div>
              </div>

              <div className="flex-1 max-h-80 overflow-y-auto p-2 space-y-1 bg-slate-50/25">
                {filteredComps.length === 0 ? (
                  <div className="text-center py-10 text-xs text-slate-400 italic">
                    Оборудование по спецификации не найдено.
                  </div>
                ) : (
                  filteredComps.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setSelectedElementId(c.id);
                        setSelectedElementName(`${c.name} (${c.systemName})`);
                        setIsEquipmentModalOpen(false);
                        addToast(`Выбран узел: ${c.name}`, 'info');
                      }}
                      className="w-full text-left p-2 hover:bg-emerald-50/50 dark:hover:bg-emerald-950/10 border border-slate-100 dark:border-transparent rounded-lg cursor-pointer transition-ui flex items-center justify-between"
                    >
                      <div>
                        <p className="text-xs font-bold text-slate-805 dark:text-slate-300">
                          ⚙️ {c.name}
                        </p>
                        <p className="text-xs text-slate-400 mt-0.5">
                          Код: <span className="font-mono text-emerald-500 font-bold">{c.itemCode}</span> • Моноблок: {c.monoblockName}
                        </p>
                      </div>
                      <span className="text-xs bg-slate-100 dark:bg-slate-950 px-2 py-0.5 rounded font-bold text-slate-500 shadow-3xs">
                        {c.systemName}
                      </span>
                    </button>
                  ))
                )}
              </div>

              <div className="p-3 border-t border-slate-150 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 text-right shrink-0">
                <button
                  type="button"
                  onClick={() => setIsEquipmentModalOpen(false)}
                  className="px-4 py-1.5 bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-lg text-xs font-bold hover:bg-slate-300 dark:hover:bg-slate-700 cursor-pointer"
                >
                  Закрыть
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* SCREENSHOT ANNOTATION CANVAS DIALOG (ФИЧА 3) */}
      <AnimatePresence>
        {isAnnotating && screenshotData && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/55 backdrop-blur-md">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-slate-900 border border-slate-800 shadow-2xl rounded-lg w-full max-w-5xl overflow-hidden flex flex-col h-[85vh]"
            >
              {/* Head */}
              <div className="p-4 bg-slate-950 border-b border-slate-850 flex items-center justify-between text-left shrink-0">
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center gap-1.5 font-sans">
                    <Brush className="w-4 h-4 text-rose-500 animate-pulse" />
                    Инженерные аннотации снимка экрана
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5 font-sans">
                    Зажмите и ведите курсор по снимку, чтобы нанести красные пометки карандашом
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setIsAnnotating(false);
                    setScreenshotData(null);
                  }}
                  className="p-1 text-slate-450 hover:text-white rounded-md cursor-pointer transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Canvas Area */}
              <div className="flex-1 bg-slate-950 overflow-auto flex items-center justify-center p-4 min-h-0 relative">
                <canvas
                  ref={canvasRef}
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                  onMouseLeave={handleMouseUp}
                  className="max-w-full max-h-full border border-slate-800 shadow-xl cursor-crosshair bg-slate-900 object-contain rounded-lg"
                />
              </div>

              {/* Toolbar Foot */}
              <div className="p-4 bg-slate-950 border-t border-slate-800 flex items-center justify-between shrink-0">
                <button
                  type="button"
                  onClick={handleClearDrawing}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white text-xs font-bold rounded-lg cursor-pointer transition-ui flex items-center gap-1.5"
                >
                  <Trash2 className="w-3.5 h-3.5 text-rose-500" />
                  Сбросить рисунок
                </button>
                
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setIsAnnotating(false);
                      setScreenshotData(null);
                    }}
                    className="px-4 py-2 bg-slate-900 text-slate-400 hover:text-slate-200 text-xs font-bold rounded-lg cursor-pointer transition-ui"
                  >
                    Отмена
                  </button>
                  <button
                    type="button"
                    onClick={handleSendDrawing}
                    className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg cursor-pointer transition-ui flex items-center gap-1.5 shadow-sm"
                  >
                    <Send className="w-3.5 h-3.5" />
                    Прикрепить к чату
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── Модалка: создание группы/канала ── */}
      {showCreateGroup && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-950/55 backdrop-blur-md" onClick={() => !ngBusy && setShowCreateGroup(false)}>
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 shadow-2xl p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-slate-900 dark:text-white">Создать {ngType === 'CHANNEL' ? 'канал' : 'группу'}</h3>
              <button type="button" onClick={() => setShowCreateGroup(false)} className="p-1 text-slate-400 hover:text-rose-500 cursor-pointer"><X className="w-5 h-5" /></button>
            </div>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <button type="button" onClick={() => setNgType('CUSTOM')} className={`flex items-center justify-center gap-1.5 py-2 rounded-lg border text-xs font-semibold cursor-pointer transition-colors ${ngType === 'CUSTOM' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'}`}>
                <Users className="w-4 h-4" /> Группа
              </button>
              <button type="button" onClick={() => setNgType('CHANNEL')} className={`flex items-center justify-center gap-1.5 py-2 rounded-lg border text-xs font-semibold cursor-pointer transition-colors ${ngType === 'CHANNEL' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'}`}>
                <Radio className="w-4 h-4" /> Канал
              </button>
            </div>
            <input type="text" value={ngName} onChange={(e) => setNgName(e.target.value)} placeholder={ngType === 'CHANNEL' ? 'Название канала' : 'Название группы'} className="w-full mb-1 px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500" />
            <p className="text-xs text-slate-400 mb-2">{ngType === 'CHANNEL' ? 'В канал пишет только владелец/админ, остальные читают.' : 'Участники группы могут писать и читать.'}</p>
            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">Участники ({ngMembers.length})</div>
            <div className="max-h-48 overflow-y-auto border border-slate-200 dark:border-slate-800 rounded-lg divide-y divide-slate-100 dark:divide-slate-850 mb-4">
              {users.filter(u => u.id !== user?.id).map(u => {
                const sel = ngMembers.includes(u.id);
                return (
                  <button key={u.id} type="button" onClick={() => setNgMembers(sel ? ngMembers.filter(id => id !== u.id) : [...ngMembers, u.id])} className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer">
                    <span className="text-xs text-slate-700 dark:text-slate-300">{u.name} <span className="text-slate-400 font-mono">({u.symbol})</span></span>
                    <span className={`w-4 h-4 rounded border flex items-center justify-center ${sel ? 'bg-emerald-600 border-emerald-600' : 'border-slate-300 dark:border-slate-600'}`}>{sel && <Check className="w-3 h-3 text-white" />}</span>
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              disabled={ngBusy || !ngName.trim()}
              onClick={async () => {
                if (!user) return;
                setNgBusy(true);
                try {
                  const g = await createGroup({ name: ngName.trim(), type: ngType, memberIds: ngMembers, ownerId: user.id });
                  addToast(ngType === 'CHANNEL' ? 'Канал создан' : 'Группа создана', 'success');
                  setShowCreateGroup(false); setNgName(''); setNgMembers([]); setNgType('CUSTOM');
                  if (g) setActiveGroupId(g.id);
                } catch (e: any) { addToast(e.message || 'Не удалось создать', 'error'); }
                finally { setNgBusy(false); }
              }}
              className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm font-bold rounded-lg cursor-pointer transition-colors"
            >
              {ngBusy ? 'Создание…' : 'Создать'}
            </button>
          </div>
        </div>
      )}

      {/* ── Модалка: пересылка сообщения ── */}
      {forwardFor && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-950/55 backdrop-blur-md" onClick={() => setForwardFor(null)}>
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 shadow-2xl p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-bold text-slate-900 dark:text-white">Переслать сообщение</h3>
              <button type="button" onClick={() => setForwardFor(null)} className="p-1 text-slate-400 hover:text-rose-500 cursor-pointer"><X className="w-5 h-5" /></button>
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 mb-3 p-2 bg-slate-50 dark:bg-slate-950 rounded-lg border border-slate-200 dark:border-slate-800 truncate">{forwardFor.content || 'Вложение'}</div>
            <div className="max-h-72 overflow-y-auto space-y-1">
              <div className="text-2xs font-bold uppercase tracking-wider text-slate-400 px-1 py-1">Группы и каналы</div>
              {groups.map(g => (
                <button key={g.id} type="button" onClick={() => handleForwardTo({ groupId: g.id })} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer text-xs text-slate-700 dark:text-slate-300">
                  {g.type === 'CHANNEL' ? <Radio className="w-4 h-4 text-emerald-500" /> : <Users className="w-4 h-4 text-emerald-500" />} {g.name}
                </button>
              ))}
              <div className="text-2xs font-bold uppercase tracking-wider text-slate-400 px-1 py-1 mt-2">Личные диалоги</div>
              {users.filter(u => u.id !== user?.id).map(u => (
                <button key={u.id} type="button" onClick={() => handleForwardTo({ receiverId: u.id })} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer text-xs text-slate-700 dark:text-slate-300">
                  <User className="w-4 h-4 text-emerald-500" /> {u.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Модалка: настройки группы/канала ── */}
      {showGroupSettings && activeGroup && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-950/55 backdrop-blur-md" onClick={() => setShowGroupSettings(false)}>
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 shadow-2xl p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-slate-900 dark:text-white">Настройки {activeGroup.type === 'CHANNEL' ? 'канала' : 'группы'}</h3>
              <button type="button" onClick={() => setShowGroupSettings(false)} className="p-1 text-slate-400 hover:text-rose-500 cursor-pointer"><X className="w-5 h-5" /></button>
            </div>
            <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">Название</label>
            <input type="text" defaultValue={activeGroup.name} onChange={(e) => setGsName(e.target.value)} className="w-full mb-3 px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm text-slate-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500" />
            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">Участники</div>
            <div className="max-h-44 overflow-y-auto border border-slate-200 dark:border-slate-800 rounded-lg divide-y divide-slate-100 dark:divide-slate-850 mb-4">
              {users.map(u => {
                const initial = (activeGroup.members || []).some(m => m.id === u.id);
                const cur = gsMembers.length ? gsMembers : (activeGroup.members || []).map(m => m.id);
                const sel = cur.includes(u.id);
                const isOwner = activeGroup.ownerId === u.id;
                return (
                  <button key={u.id} type="button" disabled={isOwner} onClick={() => { const base = gsMembers.length ? gsMembers : (activeGroup.members || []).map(m => m.id); setGsMembers(sel ? base.filter(id => id !== u.id) : [...base, u.id]); }} className={`w-full flex items-center justify-between px-3 py-2 text-left ${isOwner ? 'opacity-60' : 'hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer'}`}>
                    <span className="text-xs text-slate-700 dark:text-slate-300">{u.name} {isOwner && <span className="text-amber-500 font-semibold">· владелец</span>}</span>
                    <span className={`w-4 h-4 rounded border flex items-center justify-center ${sel ? 'bg-emerald-600 border-emerald-600' : 'border-slate-300 dark:border-slate-600'}`}>{sel && <Check className="w-3 h-3 text-white" />}</span>
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={async () => {
                if (!user) return;
                try {
                  await updateGroup(activeGroup.id, {
                    name: gsName || activeGroup.name,
                    memberIds: gsMembers.length ? gsMembers : (activeGroup.members || []).map(m => m.id),
                    userId: user.id,
                  });
                  addToast('Сохранено', 'success');
                  setShowGroupSettings(false); setGsName(''); setGsMembers([]);
                } catch (e: any) { addToast(e.message || 'Не удалось сохранить', 'error'); }
              }}
              className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold rounded-lg cursor-pointer transition-colors"
            >
              Сохранить
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
