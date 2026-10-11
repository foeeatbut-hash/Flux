import React from 'react';
import { Avatar, IconBtn } from '../ui';
import { MessageSquare, Plus, Radio, Search, Users } from 'lucide-react';
import type { ChatGroup, ChatUser } from '../../store/chatStore';
import { matchGroups, matchUsers } from '../../lib/chatSearch';
import { employeeMatchesQuery, passesChatFilter, type ChatFilter } from './chatFilters';

export interface ChatIndexRow {
  id: string;
  type: 'DIRECT' | 'GROUP';
  title: string;
  peerId?: string;
  groupId?: string;
  lastMessage: string;
  lastMessageAt: string | null;
  unreadCount: number;
}

export interface HistorySearchResult {
  chatId: string;
  messageId: string;
  snippet: string;
  createdAt: string;
  type: 'DIRECT' | 'GROUP';
  title: string;
  peerId?: string;
  groupId?: string;
}

export type MessengerSection = 'chats' | 'employees';
export type { ChatFilter } from './chatFilters';

function chatTime(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
}

function UnreadDot({ count }: { count: number }) {
  return <span className="fx-badge fx-badge-accent shrink-0" title={`Непрочитанных: ${count}`}>{count > 99 ? '99+' : count}</span>;
}

interface Props {
  users: ChatUser[];
  groups: ChatGroup[];
  currentUserId?: string;
  activeReceiverId: string | null;
  activeGroupId: string | null;
  unreadByKey: Record<string, number>;
  onlineIds: string[];
  chatIndex: ChatIndexRow[];
  chatIndexReady: boolean;
  section: MessengerSection;
  onSectionChange: (value: MessengerSection) => void;
  filter: ChatFilter;
  onFilterChange: (value: ChatFilter) => void;
  query: string;
  onQueryChange: (value: string) => void;
  onCreateGroup: () => void;
  onOpenDirect: (id: string) => void;
  onOpenGroup: (id: string) => void;
  historySearchOpen: boolean;
  onHistorySearchOpenChange: (value: boolean) => void;
  historyQuery: string;
  onHistoryQueryChange: (value: string) => void;
  historyResults: HistorySearchResult[];
  historyTotal: number;
  historyHasMore: boolean;
  historyLoading: boolean;
  onLoadMoreHistory: () => void;
  historySearchError: string;
  onOpenSearchResult: (result: HistorySearchResult) => void;
}

export default function ChatSidebar(props: Props) {
  const {
    users, groups, currentUserId, activeReceiverId, activeGroupId, unreadByKey, onlineIds,
    chatIndex, chatIndexReady, section, onSectionChange, filter, onFilterChange, query,
    onQueryChange, onCreateGroup, onOpenDirect, onOpenGroup, historySearchOpen,
    onHistorySearchOpenChange, historyQuery, onHistoryQueryChange, historyResults,
    historyTotal, historyHasMore, historyLoading, onLoadMoreHistory, historySearchError, onOpenSearchResult,
  } = props;
  const people = matchUsers(users, currentUserId, '').filter((person) => {
    const employee = person as ChatUser & { department?: string; title?: string; position?: string };
    return employeeMatchesQuery(employee, query);
  });
  const searchedGroups = matchGroups(groups, query);
  const groupRow = (id: string) => chatIndex.find((row) => row.type === 'GROUP' && (row.groupId === id || row.id === `group=${id}`));
  const directRow = (id: string) => chatIndex.find((row) => row.type === 'DIRECT' && (row.peerId === id || row.id === `from=${id}`));
  const unreadGroup = (id: string) => chatIndexReady ? (groupRow(id)?.unreadCount || 0) : (unreadByKey[`group=${id}`] || 0);
  const unreadDirect = (id: string) => chatIndexReady ? (directRow(id)?.unreadCount || 0) : (unreadByKey[`from=${id}`] || 0);
  const visibleGroups = searchedGroups.filter((group) => passesChatFilter(filter, 'GROUP', unreadGroup(group.id)))
    .sort((a, b) => Date.parse(groupRow(b.id)?.lastMessageAt || '') - Date.parse(groupRow(a.id)?.lastMessageAt || ''));
  const visiblePeople = people.filter((person) => (!chatIndexReady || !!directRow(person.id))
    && passesChatFilter(filter, 'DIRECT', unreadDirect(person.id)))
    .sort((a, b) => Date.parse(directRow(b.id)?.lastMessageAt || '') - Date.parse(directRow(a.id)?.lastMessageAt || ''));

  return <aside className="fx-side w-56 @[700px]:w-64 @[900px]:w-72 flex flex-col shrink-0 select-none">
    <div className="px-3 pt-3 pb-2 shrink-0 space-y-2">
      <div className="flex items-center justify-between gap-2"><h2 className="text-[15px] font-semibold text-slate-900 dark:text-white">Мессенджер</h2>
        <IconBtn label="Создать группу или канал" onClick={onCreateGroup}><Plus className="w-4 h-4" /></IconBtn></div>
      <div className="flex" role="tablist" aria-label="Раздел мессенджера">
        {([{ id: 'chats', label: 'Чаты' }, { id: 'employees', label: 'Сотрудники' }] as const).map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={section === tab.id}
          onClick={() => onSectionChange(tab.id)} className={`fx-tab flex-1 ${section === tab.id ? 'is-on' : ''}`}>{tab.label}</button>)}
      </div>
      <div className="relative"><input type="search" placeholder={section === 'employees' ? 'Поиск сотрудников' : 'Поиск чатов и сотрудников'}
        aria-label={section === 'employees' ? 'Поиск сотрудников' : 'Поиск чатов'} value={query} onChange={(e) => onQueryChange(e.target.value)} className="fx-input w-full pl-7" />
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" /></div>
      {section === 'chats' && <button type="button" aria-pressed={historySearchOpen} onClick={() => onHistorySearchOpenChange(!historySearchOpen)} className="fx-btn fx-btn-quiet w-full justify-start text-xs">
        <Search className="w-3.5 h-3.5" /> Искать по всей переписке
      </button>}
    </div>

    <div data-tour="chat-peers" className="flex-1 overflow-y-auto px-2 pb-2 space-y-3">
      {section === 'chats' && historySearchOpen ? <div className="space-y-2" aria-label="Поиск по истории переписки">
        <input autoFocus type="search" value={historyQuery} onChange={(e) => onHistoryQueryChange(e.target.value)} placeholder="Слова из сообщения" aria-label="Искать по всей переписке" className="fx-input w-full" />
        {historySearchError && <p className="px-2 text-xs text-rose-700 dark:text-rose-300">{historySearchError}</p>}
        {historyLoading && <p className="px-2 text-xs text-slate-500 dark:text-slate-400">Поиск…</p>}
        {historyQuery.trim() && historyResults.length === 0 && !historySearchError && !historyLoading && <p className="px-2 text-xs text-slate-500 dark:text-slate-400">Совпадений пока нет.</p>}
        {historyResults.length > 0 && <p className="px-2 text-xs text-slate-500 dark:text-slate-400">Найдено: {historyTotal}</p>}
        {historyResults.map((result) => <button key={result.messageId} type="button" className="fx-li w-full text-left" onClick={() => onOpenSearchResult(result)}>
          <span className="min-w-0 flex-1"><span className="block truncate leading-5">{result.title || 'Разговор'}</span><span className="block truncate text-xs text-slate-500 dark:text-slate-400">{result.snippet}</span></span>
          <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">{chatTime(result.createdAt)}</span>
        </button>)}
        {historyHasMore && <button type="button" disabled={historyLoading} onClick={onLoadMoreHistory} className="fx-btn fx-btn-sm w-full justify-center">{historyLoading ? 'Загрузка…' : 'Ещё результаты'}</button>}
      </div> : section === 'chats' ? <>
        <div className="fx-seg" role="group" aria-label="Фильтр чатов">
          {([{ id: 'all', label: 'Все' }, { id: 'unread', label: 'Непрочитанные' }, { id: 'groups', label: 'Группы' }, { id: 'direct', label: 'Личные' }] as const).map((item) => <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => onFilterChange(item.id)}>{item.label}</button>)}
        </div>
        <div className="space-y-1"><div className="px-2 py-1 fx-label">Группы и каналы</div>
          {groups.length === 0 ? <p className="px-2 py-1 text-xs text-slate-500 dark:text-slate-400">Групп пока нет — создайте кнопкой «+» вверху.</p> : visibleGroups.length === 0 ? <p className="px-2 py-1 text-xs text-slate-500 dark:text-slate-400">Группы по запросу не найдены.</p> : visibleGroups.map((group) => {
            const active = group.id === activeGroupId;
            const index = groupRow(group.id);
            const isChannel = group.type === 'CHANNEL';
            const subtitle = index?.lastMessage || (isChannel ? 'Канал' : group.type === 'PROJECT' ? 'Группа проекта · все участники проекта' : `Группа · ${group.members?.length || 0} уч.`);
            const unread = unreadGroup(group.id);
            return <button key={group.id} type="button" onClick={() => onOpenGroup(group.id)} aria-current={active || undefined} className="fx-li h-10">
              {isChannel ? <Radio /> : <Users />}<span className="min-w-0 flex-1"><span className="block truncate leading-5">{group.name}</span><span className="block truncate text-xs leading-4 text-slate-500 dark:text-slate-400">{subtitle}</span></span>
              {index?.lastMessageAt && <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">{chatTime(index.lastMessageAt)}</span>}{unread > 0 && !active && <UnreadDot count={unread} />}
            </button>;
          })}
        </div>
        <div className="space-y-1"><div className="px-2 py-1 fx-label">Личные диалоги</div>
          {visiblePeople.length === 0 ? <div className="px-2 py-1 text-xs text-slate-500 dark:text-slate-400">{query.trim() ? 'Личные диалоги не найдены' : 'Личных диалогов пока нет'}</div> : visiblePeople.map((person) => {
            const active = person.id === activeReceiverId;
            const index = directRow(person.id);
            const unread = unreadDirect(person.id);
            return <button key={person.id} type="button" onClick={() => onOpenDirect(person.id)} aria-current={active || undefined} className="fx-li h-10">
              <Avatar name={person.name} online={onlineIds.includes(person.id)} /><span className="min-w-0 flex-1"><span className="block truncate leading-5">{person.name}</span><span className="block truncate text-xs leading-4 text-slate-500 dark:text-slate-400" title={index?.lastMessage || undefined}>{index?.lastMessage || `${person.symbol} · ${person.role.replace('ENGINEER_', '')}`}</span></span>
              {index?.lastMessageAt && <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">{chatTime(index.lastMessageAt)}</span>}{unread > 0 && !active && <UnreadDot count={unread} />}
            </button>;
          })}
        </div>
      </> : <div className="space-y-1" aria-label="Сотрудники"><div className="px-2 py-1 fx-label">Доступные сотрудники</div>
        {people.length === 0 ? <p className="px-2 py-2 text-xs text-slate-500 dark:text-slate-400">Сотрудники по запросу не найдены.</p> : people.map((person) => <button key={person.id} type="button" onClick={() => onOpenDirect(person.id)} aria-current={person.id === activeReceiverId || undefined} className="fx-li h-10 w-full text-left">
          <Avatar name={person.name} online={onlineIds.includes(person.id)} /><span className="min-w-0 flex-1"><span className="block truncate leading-5">{person.name}</span><span className="block truncate text-xs leading-4 text-slate-500 dark:text-slate-400">{person.symbol} · {person.role.replace('ENGINEER_', '')}</span></span>
        </button>)}
      </div>}
    </div>
  </aside>;
}
