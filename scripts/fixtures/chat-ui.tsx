import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import ChatSidebar, { ChatIndexRow, HistorySearchResult, MessengerSection, ChatFilter } from '../../src/components/chat/ChatSidebar';
import ChatInfoPanel, { ChatInfoTab } from '../../src/components/chat/ChatInfoPanel';
import MessageBubble from '../../src/components/chat/MessageBubble';
import { markGroups } from '../../src/components/chat/grouping';
import { Send } from 'lucide-react';
import type { ChatGroup, ChatMessage, ChatUser } from '../../src/store/chatStore';
import '../../src/index.css';

const users: ChatUser[] = [
  { id: 'employee-1', name: 'Иван Петров', symbol: '1042', role: 'ENGINEER_VENT', department: 'Проектирование', title: 'Инженер' } as any,
  { id: 'employee-2', name: 'Мария Смирнова', symbol: '1043', role: 'ENGINEER_ELECTRIC' },
  { id: 'service', name: 'Flux Guide', symbol: 'F', role: 'SERVICE' },
];
const group: ChatGroup = { id: 'group-1', name: 'R15 · Группа проекта', type: 'PROJECT', ownerId: 'employee-1', projectId: 'project-1', members: users.slice(0, 2) };
const groups = [group];
const index: ChatIndexRow[] = [
  { id: 'group=group-1', groupId: group.id, type: 'GROUP', title: group.name, lastMessage: 'Проверить перечень клапанов', lastMessageAt: new Date().toISOString(), unreadCount: 2 },
  { id: 'from=employee-1', peerId: 'employee-1', type: 'DIRECT', title: 'Иван Петров', lastMessage: 'Отправил обновлённый файл', lastMessageAt: new Date(Date.now() - 86400000).toISOString(), unreadCount: 0 },
];
const messages: ChatMessage[] = [
  { id: 'request-1', content: 'Какой проект активен? #R15-TAG', createdAt: new Date().toISOString(), senderId: 'employee-1', guideRequest: true, sender: { id: 'employee-1', name: 'Иван Петров', symbol: '1042', role: 'ENGINEER_VENT' } },
  { id: 'reply-1', content: 'F · Flux Guide\n\nОткрыт проект R15.', createdAt: new Date().toISOString(), senderId: 'service', guideReply: { projectId: 'project-1', kind: 'project' }, sender: { id: 'service', name: 'Flux Guide', symbol: 'F', role: 'SERVICE' } },
  { id: 'spoof-1', content: 'F · Flux Guide\n\nТекст сотрудника.', createdAt: new Date().toISOString(), senderId: 'employee-2', sender: { id: 'employee-2', name: 'Мария Смирнова', symbol: '1043', role: 'ENGINEER_ELECTRIC' } },
];
const results: HistorySearchResult[] = [{ chatId: 'group=group-1', groupId: 'group-1', messageId: 'request-1', type: 'GROUP', title: group.name, snippet: 'Какой проект активен?', createdAt: new Date().toISOString() }];
const noop = () => {};

function Fixture() {
  const [section, setSection] = useState<MessengerSection>('chats');
  const [filter, setFilter] = useState<ChatFilter>('all');
  const [query, setQuery] = useState('');
  const [activeGroupId, setActiveGroupId] = useState<string | null>(group.id);
  const [activeReceiverId, setActiveReceiverId] = useState<string | null>(null);
  const [rightOpen, setRightOpen] = useState(false);
  const [rightTab, setRightTab] = useState<ChatInfoTab>('overview');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyResults, setHistoryResults] = useState<HistorySearchResult[]>([]);
  const [guideMode, setGuideMode] = useState(false);
  const online = ['employee-1'];
  const markers = markGroups(messages);
  (window as any).__fixture = {
    setHistoryQuery: (value: string) => { setHistoryQuery(value); setHistoryResults(value ? results : []); },
    guideMode: () => guideMode,
  };
  return <div className="@container h-screen min-h-0 overflow-hidden text-[13px] leading-5">
    <div className="relative flex h-full min-w-0 overflow-hidden bg-[var(--flux-surface)] text-[var(--flux-text)]">
      <ChatSidebar users={users} groups={groups} currentUserId="self" hiddenOnMobile={!!(activeReceiverId || activeGroupId)} activeReceiverId={activeReceiverId} activeGroupId={activeGroupId}
        unreadByKey={{ 'group=group-1': 2 }} onlineIds={online} chatIndex={index} chatIndexReady
        section={section} onSectionChange={setSection} filter={filter} onFilterChange={setFilter} query={query} onQueryChange={setQuery}
        onCreateGroup={noop} onOpenDirect={(id) => { setActiveReceiverId(id); setActiveGroupId(null); }}
        onOpenGroup={(id) => { setActiveGroupId(id); setActiveReceiverId(null); }} historySearchOpen={historyOpen}
        onHistorySearchOpenChange={setHistoryOpen} historyQuery={historyQuery} onHistoryQueryChange={(value) => (window as any).__fixture.setHistoryQuery(value)}
        historyResults={historyResults} historyTotal={historyResults.length} historyHasMore={false} historyLoading={false} onLoadMoreHistory={noop}
        historySearchError="" onOpenSearchResult={(result) => { setActiveGroupId(result.groupId || null); }} />
      <main className="flex min-w-0 flex-1 flex-col bg-white dark:bg-slate-900">
        <header className="fx-head justify-between"><div className="flex min-w-0 items-center gap-2"><button type="button" aria-label="Назад к чатам" className="fx-ibtn shrink-0 @[700px]:hidden" onClick={() => { setActiveGroupId(null); setActiveReceiverId(null); }}><span aria-hidden>←</span></button><div className="min-w-0"><div className="truncate font-semibold">{activeGroupId ? group.name : 'Иван Петров'}</div><div className="hidden @[700px]:block text-xs text-slate-500 dark:text-slate-400">Группа проекта · 2 участника</div></div></div>
          <button type="button" className="fx-btn" aria-label="Подробная информация" onClick={() => setRightOpen(!rightOpen)}>Сведения</button></header>
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3" aria-label="Переписка">
          {messages.map((message, i) => <MessageBubble key={message.id} msg={message as any} isMe={i === 0} mark={markers[i]} hideNames={false}
            reactions={[]} emojis={[]} pickerOpen={false} onTogglePicker={noop} onReact={noop} onReply={noop} onForward={noop} onPin={noop} onCopy={noop} onEdit={noop} onDelete={noop}
            onOpenEquipment={noop} onOpenFile={noop} formatBytes={(n) => `${n} B`}>
            {message.content.startsWith('F · Flux Guide') ? message.content.replace(/^F · Flux Guide\n\n/, '') : message.content}
          </MessageBubble>)}
        </div>
        <div className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
          {guideMode && <p className="mb-1 text-xs text-slate-600 dark:text-slate-300">Ответ Flux Guide увидят участники разговора.</p>}
          <div className="flex items-center gap-2">
            <input aria-label="Сообщение" placeholder={guideMode ? 'Спросить Flux Guide…' : 'Напишите сообщение'} className={`fx-input min-w-0 flex-1 ${guideMode ? 'ring-2 ring-emerald-500 dark:ring-emerald-400' : ''}`} />
            <button type="button" aria-label="F" aria-pressed={guideMode} onClick={() => setGuideMode(!guideMode)} className={`fx-ibtn font-semibold ${guideMode ? '!bg-emerald-600 !text-white' : ''}`}>F</button>
            <button type="button" aria-label="Отправить" className="fx-btn fx-btn-primary"><Send className="h-4 w-4" /></button>
          </div>
        </div>
      </main>
      <ChatInfoPanel open={rightOpen} sidebarHiddenOnMobile={!!(activeReceiverId || activeGroupId)} peer={activeReceiverId ? users[0] : null} group={activeGroupId ? group : null} tab={rightTab} onTabChange={setRightTab}
        selectedTag={null} onClearTag={noop} onOpenTag={noop} onOpenEquipment={noop} conversationId={activeGroupId || activeReceiverId || ''}
        conversationType={activeGroupId ? 'GROUP' : 'DIRECT'} onlineIds={online} onOpenFile={noop} formatBytes={(n) => `${n} B`} onClose={() => setRightOpen(false)} />
    </div>
  </div>;
}

createRoot(document.getElementById('mount')!).render(<Fixture />);
