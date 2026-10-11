import React from 'react';
import { Avatar } from '../ui';
import { File, Link as LinkIcon, Paperclip, Radio, Users, X } from 'lucide-react';
import type { ChatAttachment, ChatGroup, ChatUser } from '../../store/chatStore';

export type ChatInfoTab = 'overview' | 'files' | 'tags' | 'members';

interface Props {
  open: boolean;
  peer: ChatUser | null;
  group: ChatGroup | null;
  tab: ChatInfoTab;
  onTabChange: (tab: ChatInfoTab) => void;
  selectedTag: any | null;
  onClearTag: () => void;
  onOpenTag: (tag: string) => void;
  onOpenEquipment: (id: string) => void;
  conversationId: string;
  conversationType: 'DIRECT' | 'GROUP';
  onlineIds: string[];
  onOpenFile: (path: string) => void;
  formatBytes: (bytes: number) => string;
  onClose: () => void;
}

export default function ChatInfoPanel({
  open, peer, group, tab, onTabChange, selectedTag, onClearTag, onOpenTag,
  onOpenEquipment, conversationId, conversationType, onlineIds, onOpenFile, formatBytes, onClose,
}: Props) {
  if (!open || (!peer && !group)) return null;
  const tabs: Array<{ id: ChatInfoTab; label: string }> = [
    { id: 'overview', label: 'Обзор' }, { id: 'files', label: 'Файлы' }, { id: 'tags', label: 'Теги' },
    ...(group ? [{ id: 'members' as const, label: 'Участники' }] : []),
  ];

  return (
    <>
      <button type="button" aria-label="Закрыть сведения" onClick={onClose}
        className="absolute inset-y-0 left-56 right-0 z-20 bg-slate-950/20 @[700px]:left-64 @[900px]:left-72 @[1000px]:hidden" />
      <aside className="absolute inset-y-0 left-56 right-0 z-30 w-auto border-l border-slate-200 dark:border-slate-800 flex flex-col bg-slate-50 dark:bg-slate-900 select-none shrink-0 overflow-y-auto @[700px]:left-64 @[900px]:left-72 @[1000px]:static @[1000px]:left-auto @[1000px]:z-auto @[1000px]:w-72 @[1000px]:bg-slate-50/50 @[1000px]:dark:bg-slate-900/40">
        {!selectedTag && <div className="sticky top-0 z-10 flex min-w-0 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 px-2">
          <div className="flex min-w-0 flex-1 overflow-x-auto" role="tablist" aria-label="Сведения о разговоре">
            {tabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id}
              onClick={() => onTabChange(item.id)} className={`fx-tab flex-none whitespace-nowrap px-1 text-[11px] @[700px]:px-2 @[700px]:text-[13px] ${tab === item.id ? 'is-on' : ''}`}>{item.label}</button>)}
          </div>
          <button type="button" className="fx-ibtn shrink-0 @[1000px]:hidden" aria-label="Закрыть сведения" onClick={onClose}><X className="w-4 h-4" /></button>
        </div>}

        {selectedTag ? <div className="flex-1 flex flex-col">
          <div className="p-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">Карточка тега</span>
            <button type="button" onClick={onClearTag} className="fx-ibtn" title="Назад к разговору"><X className="w-4 h-4" /></button>
          </div>
          <div className="p-4 space-y-4 text-left">
            <div><h4 className="text-sm font-semibold text-slate-800 dark:text-white">{selectedTag.name}</h4><p className="text-xs text-slate-500 dark:text-slate-400">Код узла: {selectedTag.itemCode}</p></div>
            <dl className="space-y-2 text-xs">
              <div><dt className="fx-label">Тип оборудования</dt><dd className="text-slate-800 dark:text-slate-300">{selectedTag.type || 'Спецификация MAX'}</dd></div>
              {selectedTag.monoblock?.name && <div><dt className="fx-label">Моноблок</dt><dd className="text-slate-800 dark:text-slate-300">{selectedTag.monoblock.name}</dd></div>}
              {selectedTag.monoblock?.system?.name && <div><dt className="fx-label">Система</dt><dd className="text-slate-800 dark:text-slate-300">{selectedTag.monoblock.system.name}</dd></div>}
            </dl>
            <button type="button" onClick={() => onOpenEquipment(selectedTag.id)} className="fx-btn fx-btn-primary w-full justify-center"><LinkIcon className="w-3.5 h-3.5" />Открыть оборудование</button>
          </div>
        </div> : tab === 'overview' ? <div className="p-4 space-y-3">
          {peer ? <>
            <div className="flex items-center gap-3"><Avatar name={peer.name} online={onlineIds.includes(peer.id)} />
              <div className="min-w-0"><div className="truncate font-medium text-slate-800 dark:text-slate-100">{peer.name}</div><div className="truncate text-xs text-slate-500 dark:text-slate-400">{peer.role}</div></div>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs"><dt className="text-slate-500 dark:text-slate-400">Табель</dt><dd className="truncate text-slate-700 dark:text-slate-300">{peer.symbol}</dd><dt className="text-slate-500 dark:text-slate-400">Переписка</dt><dd className="text-slate-700 dark:text-slate-300">Личная</dd></dl>
          </> : group ? <>
            <div className="flex items-center gap-2 text-slate-800 dark:text-slate-100">{group.type === 'CHANNEL' ? <Radio className="w-4 h-4" /> : <Users className="w-4 h-4" />}<span className="truncate font-medium">{group.name}</span></div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs"><dt className="text-slate-500 dark:text-slate-400">Тип</dt><dd className="text-slate-700 dark:text-slate-300">{group.type === 'PROJECT' ? 'Группа проекта' : group.type === 'CHANNEL' ? 'Канал' : 'Группа'}</dd><dt className="text-slate-500 dark:text-slate-400">Участники</dt><dd className="text-slate-700 dark:text-slate-300">{group.members?.length ?? '—'}</dd>{group.project && <><dt className="text-slate-500 dark:text-slate-400">Проект</dt><dd className="truncate text-slate-700 dark:text-slate-300">{group.project.name}</dd></>}</dl>
          </> : null}
        </div> : tab === 'files' ? <FilesTab conversationId={conversationId} conversationType={conversationType} onOpenFile={onOpenFile} formatBytes={formatBytes} /> : tab === 'tags' ? <TagsTab conversationId={conversationId} conversationType={conversationType} onOpenTag={onOpenTag} /> : <div className="flex-1 p-2 space-y-1">
          {(group?.members || []).map((member) => <div key={member.id} className="fx-li h-10"><Avatar name={member.name} online={onlineIds.includes(member.id)} /><span className="min-w-0 flex-1"><span className="block truncate">{member.name}</span><span className="block truncate text-xs text-slate-500 dark:text-slate-400">{member.role.replace('ENGINEER_', '')}</span></span></div>)}
          {!group?.members?.length && <p className="p-2 text-xs text-slate-500 dark:text-slate-400">Состав группы недоступен.</p>}
        </div>}
      </aside>
    </>
  );
}

function TagsTab({ conversationId, conversationType, onOpenTag }: {
  conversationId: string; conversationType: 'DIRECT' | 'GROUP'; onOpenTag: (tag: string) => void;
}) {
  const [tags, setTags] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [truncated, setTruncated] = React.useState(false);
  React.useEffect(() => {
    const controller = new AbortController();
    setTags([]); setLoading(true); setTruncated(false);
    const chatId = `${conversationType === 'GROUP' ? 'group' : 'from'}=${conversationId}`;
    (async () => {
      const found = new Set<string>();
      let offset = 0;
      let total = 0;
      let capped = false;
      do {
        const response = await fetch(`/api/chat/search?q=%23&chatId=${encodeURIComponent(chatId)}&limit=100&offset=${offset}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        total = Number(body.total) || 0;
        capped = !!body.truncated;
        for (const row of body.results || []) {
          for (const match of String(row.snippet || '').matchAll(/#([a-zA-Z0-9А-Яа-я_.-]+)/g)) found.add(match[0]);
        }
        offset += (body.results || []).length;
        if (!body.results?.length) break;
        setTags([...found].sort((a, b) => a.localeCompare(b, 'ru-RU')));
      } while (!controller.signal.aborted && offset < Math.min(total, 1000));
      if (!controller.signal.aborted) setTruncated(capped);
    })().catch((error) => { if (error?.name !== 'AbortError') setTruncated(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [conversationId, conversationType]);
  return <div className="flex-1 p-3 space-y-1">
    {loading && tags.length === 0 && <p className="text-xs text-slate-500 dark:text-slate-400">Поиск тегов по истории…</p>}
    {!loading && tags.length === 0 && !truncated && <p className="text-xs text-slate-500 dark:text-slate-400">В истории нет ссылок на теги.</p>}
    {tags.map((tag) => <button key={tag} type="button" onClick={() => onOpenTag(tag.slice(1))} className="fx-li w-full text-left">{tag}</button>)}
    {truncated && <p className="pt-1 text-xs text-slate-500 dark:text-slate-400">Показана доступная часть истории.</p>}
  </div>;
}

function FilesTab({ conversationId, conversationType, onOpenFile, formatBytes }: {
  conversationId: string; conversationType: 'DIRECT' | 'GROUP'; onOpenFile: (path: string) => void; formatBytes: (n: number) => string;
}) {
  const [items, setItems] = React.useState<ChatAttachment[]>([]);
  const [total, setTotal] = React.useState(0);
  const [query, setQuery] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [offset, setOffset] = React.useState(0);
  React.useEffect(() => {
    const controller = new AbortController();
    setItems([]); setTotal(0); setOffset(0); setError(''); setLoading(true);
    fetch(`/api/chat/attachments?type=${conversationType}&conversationId=${encodeURIComponent(conversationId)}&limit=100&offset=0`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((body) => { setItems(body.items || []); setTotal(body.total || 0); setOffset((body.items || []).length); })
      .catch((err) => { if (err?.name !== 'AbortError') setError('Список файлов недоступен.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [conversationId, conversationType]);
  const loadMore = async () => {
    if (loading || offset >= total) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/chat/attachments?type=${conversationType}&conversationId=${encodeURIComponent(conversationId)}&limit=100&offset=${offset}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      setItems((current) => [...current, ...(body.items || [])]);
      setOffset((current) => current + (body.items || []).length);
      setTotal(body.total || 0);
    } catch { setError('Не удалось загрузить следующую страницу файлов.'); }
    finally { setLoading(false); }
  };
  const visible = items.filter((item) => item.fileName.toLocaleLowerCase('ru-RU').includes(query.trim().toLocaleLowerCase('ru-RU')));
  return <div className="flex-1 p-3">
    <h3 className="mb-2 flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300"><Paperclip className="w-4 h-4" />Файлы ({total})</h3>
    <input type="search" aria-label="Поиск файлов" placeholder="Найти файл" value={query} onChange={(event) => setQuery(event.target.value)} className="fx-input mb-2 w-full" />
    {loading && items.length === 0 ? <p className="text-xs text-slate-500 dark:text-slate-400">Загрузка файлов…</p> : error && !items.length ? <p className="text-xs text-rose-700 dark:text-rose-300">{error}</p> : visible.length ? visible.map((file) => <button key={file.id} type="button" onClick={() => onOpenFile(file.filePath)} className="fx-li w-full text-left">
      <File className="w-4 h-4 shrink-0" /><span className="min-w-0 flex-1 truncate">{file.fileName}</span><span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">{formatBytes(file.fileSize)}</span>
    </button>) : <p className="text-xs text-slate-500 dark:text-slate-400">Файлы не найдены.</p>}
    {offset < total && <button type="button" disabled={loading} onClick={() => void loadMore()} className="fx-btn fx-btn-sm mt-2 w-full justify-center">{loading ? 'Загрузка…' : 'Ещё файлы'}</button>}
    {error && items.length > 0 && <p className="mt-2 text-xs text-rose-700 dark:text-rose-300">{error}</p>}
  </div>;
}
