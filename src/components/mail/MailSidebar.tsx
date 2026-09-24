import React from 'react';
import {
  Inbox, Send, FileEdit, Trash2, ShieldAlert, Archive, Folder, RefreshCw, Star, MailOpen,
  Building2, AtSign, Plus, PenSquare, Settings2, AlertTriangle,
} from 'lucide-react';
import type { MailAccount, MailFolder } from '../../services/mailService';
import type { MailFilter } from '../../store/mailStore';

/**
 * Левая колонка: ящики, а под открытым — его папки.
 *
 * Ящиков у сотрудника несколько: общая почта компании и сколько угодно своих.
 * Поэтому строкой первого уровня стоит ящик, а не папка — иначе непонятно,
 * чьи «Входящие» перед тобой. Папки раскрыты только у выбранного ящика:
 * четыре ящика по семь папок — это тридцать строк, в которых теряешься.
 *
 * По IMAP ярлык и папка — одно и то же: письмо лежит в одном месте. Поэтому
 * показываем папки и называем их папками, а не ярлыками, как в Gmail.
 *
 * В тесной панели колонка сжимается до значков — подписи уходят, счётчики
 * остаются: без них непонятно, куда смотреть.
 */

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  INBOX: Inbox,
  SENT: Send,
  DRAFTS: FileEdit,
  TRASH: Trash2,
  SPAM: ShieldAlert,
  ARCHIVE: Archive,
  CUSTOM: Folder,
};

interface Props {
  accounts: MailAccount[];
  accountId: string;
  folders: MailFolder[];
  folderId: string;
  filter: MailFilter;
  syncing: boolean;
  /** Непрочитанные по ящикам — считает раздел, здесь только показываем */
  unreadByAccount: Record<string, number>;
  onChooseAccount: (id: string) => void;
  onChooseFolder: (id: string) => void;
  onFilter: (f: MailFilter) => void;
  onSync: () => void;
  onCompose: () => void;
  onAddAccount: () => void;
  onSettings: () => void;
}

/** Как назвать ящик в списке: своё название, иначе адрес. */
export function accountTitle(a: MailAccount): string {
  if (a.label) return a.label;
  if (a.scope === 'SHARED') return 'Общая почта';
  return a.email;
}

export default function MailSidebar({
  accounts, accountId, folders, folderId, filter, syncing, unreadByAccount,
  onChooseAccount, onChooseFolder, onFilter, onSync, onCompose, onAddAccount, onSettings,
}: Props) {
  return (
    <aside className="fx-side shrink-0 w-14 @[900px]:w-56 flex flex-col overflow-hidden">
      {/* Написать — первое действие в почте, поэтому первая кнопка */}
      <div className="shrink-0 p-2 flex flex-col gap-1.5">
        <button
          type="button"
          onClick={onCompose}
          disabled={!accountId}
          title="Написать письмо"
          className="fx-btn fx-btn-primary w-full justify-center @[900px]:justify-start"
        >
          <PenSquare className="w-4 h-4 shrink-0" />
          <span className="hidden @[900px]:inline">Написать</span>
        </button>
        <button
          type="button"
          onClick={onSync}
          disabled={syncing || !accountId}
          title="Проверить почту"
          className="fx-btn w-full justify-center @[900px]:justify-start"
        >
          <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${syncing ? 'animate-spin' : ''}`} />
          <span className="hidden @[900px]:inline">{syncing ? 'Проверяем…' : 'Проверить'}</span>
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto scrollbar-thin px-1.5 pb-2 flex flex-col gap-0.5">
        {accounts.map((a) => {
          const open = a.id === accountId;
          const shared = a.scope === 'SHARED';
          const Icon = shared ? Building2 : AtSign;
          const unread = unreadByAccount[a.id] || 0;
          return (
            <div key={a.id} className="flex flex-col gap-0.5">
              <button
                type="button"
                onClick={() => onChooseAccount(a.id)}
                title={`${accountTitle(a)} — ${a.email}`}
                aria-current={open ? 'true' : undefined}
                className="fx-li group relative h-10 justify-center @[900px]:justify-start"
              >
                <Icon className={`w-4 h-4 shrink-0 ${shared ? 'text-sky-600 dark:text-sky-400' : 'text-slate-400 dark:text-slate-500'}`} />
                <span className="hidden @[900px]:flex flex-1 min-w-0 flex-col leading-tight">
                  <span className="truncate font-medium">{accountTitle(a)}</span>
                  <span className="truncate text-xs text-slate-500 dark:text-slate-400">{a.email}</span>
                </span>
                {a.lastError ? (
                  <AlertTriangle className="hidden @[900px]:block w-3.5 h-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                ) : unread > 0 ? (
                  <span className="hidden @[900px]:block fx-badge fx-badge-accent shrink-0">
                    {unread > 999 ? '999+' : unread}
                  </span>
                ) : null}
                {/* Узкая колонка: на 56 px подпись не влезает, счётчик садится
                    на угол значка — как в свёрнутом меню Gmail */}
                {unread > 0 && (
                  <span className="@[900px]:hidden absolute -top-0.5 -right-0.5 min-w-[1rem] h-4 px-1 rounded-full flex items-center justify-center text-xs font-medium tabular-nums bg-emerald-700 text-white">
                    {unread > 99 ? '99' : unread}
                  </span>
                )}
              </button>

              {/* Папки — только у открытого ящика */}
              {open && folders.map((f) => {
                const FIcon = ICONS[f.kind] || Folder;
                const active = f.id === folderId;
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => onChooseFolder(f.id)}
                    title={f.name}
                    aria-current={active ? 'true' : undefined}
                    className="fx-li group relative justify-center @[900px]:justify-start @[900px]:pl-7"
                  >
                    <FIcon className="w-4 h-4 shrink-0" />
                    <span className="hidden @[900px]:block flex-1 min-w-0 truncate">{f.name}</span>
                    {f.unread > 0 && (
                      <>
                        <span className="hidden @[900px]:block fx-badge fx-badge-accent shrink-0">
                          {f.unread > 999 ? '999+' : f.unread}
                        </span>
                        <span className={`@[900px]:hidden absolute -top-0.5 -right-0.5 min-w-[1rem] h-4 px-1 rounded-full flex items-center justify-center text-2xs font-semibold tabular-nums
                          ${active ? 'bg-emerald-700 text-white' : 'bg-slate-400 text-white dark:bg-slate-600'}`}>
                          {f.unread > 99 ? '99' : f.unread}
                        </span>
                      </>
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}

        <button
          type="button"
          onClick={onAddAccount}
          title="Добавить ящик"
          className="fx-li mt-1 justify-center @[900px]:justify-start text-slate-500 dark:text-slate-400"
        >
          <Plus className="w-4 h-4 shrink-0" />
          <span className="hidden @[900px]:block flex-1 min-w-0 truncate">Добавить ящик</span>
        </button>
      </nav>

      {/* Быстрый отбор — то, за чем чаще всего лезут в поиск */}
      <div className="shrink-0 border-t border-slate-200 dark:border-slate-800 p-1.5 flex flex-col gap-0.5">
        {([
          { key: 'all', label: 'Все письма', Icon: MailOpen },
          { key: 'unread', label: 'Непрочитанные', Icon: Inbox },
          { key: 'flagged', label: 'Важные', Icon: Star },
        ] as Array<{ key: MailFilter; label: string; Icon: React.ComponentType<{ className?: string }> }>).map(
          ({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => onFilter(key)}
              title={label}
              aria-pressed={filter === key}
              aria-current={filter === key || undefined}
              className="fx-li"
            >
              <Icon className="w-3.5 h-3.5 shrink-0" />
              <span className="hidden @[900px]:block flex-1 min-w-0 truncate">{label}</span>
            </button>
          ),
        )}
        <button
          type="button"
          onClick={onSettings}
          title="Настройки почты и подписи"
          className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs cursor-pointer text-slate-500 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-slate-850"
        >
          <Settings2 className="w-3.5 h-3.5 shrink-0" />
          <span className="hidden @[900px]:block flex-1 min-w-0 truncate">Настройки и подпись</span>
        </button>
      </div>
    </aside>
  );
}
