import React from 'react';
import {
  Reply, CornerUpRight, CornerDownRight, Pin, Copy, Pencil, Trash2, Smile,
  File as FileIcon, Download, Check,
} from 'lucide-react';
import type { GroupMark } from './grouping';
import { timeOf } from './grouping';

/**
 * Сообщение в переписке.
 *
 * Собрано по образцу привычных мессенджеров и в цветах Flux.
 *
 * Что изменилось против прежнего вида и почему.
 *
 * Время переехало внутрь пузыря, в правый нижний угол. Раньше над каждым
 * сообщением стояла строка «имя • часы • шесть кнопок», и в переписке из пяти
 * коротких реплик подряд под сам текст оставалась едва треть высоты — всё
 * остальное занимали повторяющиеся подписи.
 *
 * Имя пишется один раз на кучку подряд идущих сообщений, кружок с буквой
 * рисуется тоже один раз — рядом с последним (см. grouping.ts). В личной
 * переписке имя не пишется вовсе: собеседник и так один, и его имя стоит в
 * шапке.
 *
 * Свои сообщения — залитые цветом Flux, чужие — на светлой подложке. Раньше
 * своё отличалось едва заметным зелёным оттенком, и на быстрой прокрутке
 * разобрать, где чья реплика, было тяжело. У последнего сообщения кучки один
 * угол острый: это и есть «хвостик», который показывает, чья сторона.
 *
 * Кнопки действий не занимают места: они всплывают над пузырём при наведении.
 *
 * Отметки «доставлено/прочитано» нет намеренно. В программе не хранится, кто
 * какое сообщение открывал, и рисовать галочки, которые ничего не означают,
 * — хуже, чем не рисовать их вовсе. Одна галочка у своих сообщений говорит
 * ровно то, что известно: сообщение ушло на сервер.
 */

export interface BubbleMessage {
  id: string;
  content: string;
  createdAt: string;
  senderId: string;
  sender?: { name?: string } | null;
  attachments?: Array<{ id: string; fileName: string; filePath: string; fileSize: number }>;
  linkedElementId?: string | null;
  linkedElement?: { id: string; name: string; itemCode: string } | null;
  replyToId?: string | null;
  replyTo?: { id: string; content: string; sender?: { name?: string } | null } | null;
  editedAt?: string | null;
  pinned?: boolean;
  forwardedFrom?: string | null;
}

export interface BubbleReaction { emoji: string; count: number; mine: boolean }

interface Props {
  msg: BubbleMessage;
  isMe: boolean;
  mark: GroupMark;
  /** Личная переписка: имя собеседника уже стоит в шапке, в пузырях не нужно */
  hideNames?: boolean;
  reactions: BubbleReaction[];
  emojis: string[];
  pickerOpen: boolean;
  onTogglePicker: () => void;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onForward: () => void;
  onPin: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenEquipment: (id: string) => void;
  onOpenFile: (path: string) => void;
  onJumpTo?: (id: string) => void;
  formatBytes: (n: number) => string;
  /** Отформатированный текст сообщения */
  children: React.ReactNode;
}

const AVATAR = 'w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-2xs font-semibold select-none';

/** Кнопка во всплывающей панели действий. */
function Act({ icon: Icon, title, onClick, tone = '' }: {
  icon: React.ComponentType<{ className?: string }>;
  title: string; onClick: () => void; tone?: string;
}) {
  return (
    <button
      type="button" onClick={onClick} title={title} aria-label={title}
      className={`p-1.5 rounded-lg cursor-pointer text-slate-500 dark:text-slate-400
                  hover:bg-slate-100 dark:hover:bg-slate-800 transition-ui ${tone}`}
    >
      <Icon className="w-3.5 h-3.5" />
    </button>
  );
}

export default function MessageBubble({
  msg, isMe, mark, hideNames, reactions, emojis, pickerOpen,
  onTogglePicker, onReact, onReply, onForward, onPin, onCopy, onEdit, onDelete,
  onOpenEquipment, onOpenFile, onJumpTo, formatBytes, children,
}: Props) {
  const name = isMe ? 'Вы' : (msg.sender?.name || 'Сотрудник');

  // Уголок — только у последнего в кучке: у остальных все углы круглые, и
  // кучка читается как один блок, а не как стопка отдельных карточек.
  const corner = mark.last
    ? (isMe ? 'rounded-br-md' : 'rounded-bl-md')
    : '';

  return (
    <div
      id={`msg-${msg.id}`}
      className={`flux-lazy-item group flex items-end gap-2 rounded-2xl ${isMe ? 'flex-row-reverse' : ''} ${mark.last ? 'mb-2' : 'mb-0.5'}`}
    >
      {/* Кружок отправителя — один на кучку, у последнего сообщения */}
      {mark.last ? (
        <div className={`${AVATAR} ${isMe
          ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300'
          : 'bg-slate-150 dark:bg-slate-800 text-slate-600 dark:text-slate-350'}`}>
          {(msg.sender?.name || 'С').charAt(0)}
        </div>
      ) : (
        <div className={`${AVATAR} invisible`} aria-hidden />
      )}

      <div className={`relative max-w-[min(68%,560px)] min-w-0 flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
        {/* Имя — один раз на кучку и только в групповой переписке */}
        {mark.first && !hideNames && !isMe && (
          <span className="px-2 pb-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400 select-none">
            {name}
          </span>
        )}

        {/* Панель действий: всплывает по наведению и места не занимает.
            Сбоку от пузыря, а не над ним: над первым сообщением кучки стоит
            имя отправителя, и панель его закрывала. Сбоку она не закрывает
            ничего — пузырь занимает не больше двух третей ширины. */}
        <div
          className={`absolute top-0 z-20 opacity-0 group-hover:opacity-100 focus-within:opacity-100
                      transition-opacity flex items-center gap-0.5 p-0.5 rounded-xl
                      bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-md
                      ${isMe ? 'right-full mr-2' : 'left-full ml-2'}`}
        >
          <Act icon={Smile} title="Реакция" onClick={onTogglePicker} tone="hover:text-amber-500" />
          <Act icon={Reply} title="Ответить" onClick={onReply} tone="hover:text-emerald-600 dark:hover:text-emerald-400" />
          <Act icon={CornerUpRight} title="Переслать" onClick={onForward} tone="hover:text-sky-600 dark:hover:text-sky-400" />
          <Act icon={Pin} title={msg.pinned ? 'Открепить' : 'Закрепить'} onClick={onPin}
            tone={msg.pinned ? 'text-amber-500' : 'hover:text-amber-500'} />
          <Act icon={Copy} title="Копировать текст" onClick={onCopy} tone="hover:text-emerald-600 dark:hover:text-emerald-400" />
          {isMe && <Act icon={Pencil} title="Изменить" onClick={onEdit} tone="hover:text-amber-600 dark:hover:text-amber-400" />}
          {isMe && <Act icon={Trash2} title="Удалить" onClick={onDelete} tone="hover:text-rose-600 dark:hover:text-rose-400" />}
        </div>

        {pickerOpen && (
          <div className={`absolute -top-12 z-30 flex gap-0.5 p-1 rounded-xl bg-white dark:bg-slate-950
                           border border-slate-200 dark:border-slate-700 shadow-xl ${isMe ? 'right-0' : 'left-0'}`}>
            {emojis.map((em) => (
              <button
                key={em} type="button" onClick={() => onReact(em)}
                className="w-7 h-7 flex items-center justify-center rounded-lg text-base cursor-pointer
                           hover:bg-slate-100 dark:hover:bg-slate-800 hover:scale-110 transition-transform"
              >
                {em}
              </button>
            ))}
          </div>
        )}

        {/* Пузырь */}
        <div
          className={`relative rounded-2xl ${corner} px-3 py-2 text-xs leading-relaxed min-w-0 max-w-full
                      break-words overflow-hidden shadow-3xs transition-ui ${
            isMe
              ? 'bg-emerald-600 text-white dark:bg-emerald-700'
              : 'bg-white dark:bg-slate-850 text-slate-800 dark:text-slate-150 border border-slate-200 dark:border-slate-800'
          }`}
        >
          {msg.forwardedFrom && (
            <div className={`mb-1 text-2xs font-semibold flex items-center gap-1 select-none ${
              isMe ? 'text-emerald-100' : 'text-sky-600 dark:text-sky-400'}`}>
              <CornerUpRight className="w-3 h-3" /> Переслано от {msg.forwardedFrom}
            </div>
          )}

          {msg.replyTo && (
            <button
              type="button"
              onClick={() => onJumpTo?.(msg.replyTo!.id)}
              className={`mb-1.5 w-full text-left pl-2 pr-1 py-0.5 rounded-md border-l-2 cursor-pointer transition-ui ${
                isMe
                  ? 'border-white/70 bg-white/12 hover:bg-white/20'
                  : 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40 hover:bg-emerald-100 dark:hover:bg-emerald-950/60'
              }`}
              title="Перейти к сообщению"
            >
              <span className={`block text-2xs font-semibold truncate ${isMe ? 'text-white' : 'text-emerald-700 dark:text-emerald-400'}`}>
                <CornerDownRight className="w-3 h-3 inline mr-1 -mt-0.5" />
                {msg.replyTo.sender?.name || 'Сообщение'}
              </span>
              <span className={`block text-2xs truncate ${isMe ? 'text-emerald-50/90' : 'text-slate-500 dark:text-slate-400'}`}>
                {(msg.replyTo.content || '').slice(0, 120) || 'Вложение'}
              </span>
            </button>
          )}

          <div className={isMe ? 'flux-own-msg' : ''}>{children}</div>

          {msg.linkedElement && (
            <button
              type="button"
              onClick={() => onOpenEquipment(msg.linkedElementId!)}
              className={`mt-2 text-left block w-full p-2 rounded-lg cursor-pointer transition-ui ${
                isMe ? 'bg-white/15 hover:bg-white/25' : 'bg-emerald-50 dark:bg-emerald-950/40 hover:bg-emerald-100 dark:hover:bg-emerald-950/60'
              }`}
            >
              <span className={`block text-2xs font-semibold mb-0.5 ${
                isMe ? 'text-emerald-50' : 'text-emerald-800 dark:text-emerald-400'}`}>
                Оборудование
              </span>
              <span className={`block text-xs font-semibold ${isMe ? 'text-white' : 'text-slate-800 dark:text-slate-150'}`}>
                {msg.linkedElement.name}
              </span>
              <span className={`block text-2xs ${isMe ? 'text-emerald-50/80' : 'text-slate-500 dark:text-slate-400'}`}>
                Код узла: {msg.linkedElement.itemCode}
              </span>
            </button>
          )}

          {msg.attachments && msg.attachments.length > 0 && (
            <div className="mt-2 space-y-1">
              {msg.attachments.map((f) => (
                <button
                  key={f.id} type="button" onClick={() => onOpenFile(f.filePath)}
                  className={`w-full text-left flex items-center justify-between gap-2 p-2 rounded-lg cursor-pointer transition-ui ${
                    isMe ? 'bg-white/15 hover:bg-white/25' : 'bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800'
                  }`}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <FileIcon className={`w-3.5 h-3.5 shrink-0 ${isMe ? 'text-white' : 'text-emerald-650 dark:text-emerald-400'}`} />
                    <span className="min-w-0">
                      <span className={`block text-2xs font-semibold truncate ${isMe ? 'text-white' : 'text-slate-850 dark:text-slate-150'}`}>
                        {f.fileName}
                      </span>
                      <span className={`block text-2xs ${isMe ? 'text-emerald-50/80' : 'text-slate-400'}`}>
                        {formatBytes(f.fileSize)}
                      </span>
                    </span>
                  </span>
                  <Download className={`w-3.5 h-3.5 shrink-0 ${isMe ? 'text-white/80' : 'text-slate-400'}`} />
                </button>
              ))}
            </div>
          )}

          {/* Время в углу пузыря. Пустой хвост нужен, чтобы последняя строка
              текста не заезжала под время: у коротких реплик они на одной
              строке, у длинных время просто съезжает вниз. */}
          <span className="float-right ml-2 mt-1 flex items-center gap-1 select-none translate-y-0.5">
            {msg.editedAt && (
              <span className={`text-2xs ${isMe ? 'text-emerald-50/70' : 'text-slate-400'}`}
                title={`Изменено ${new Date(msg.editedAt).toLocaleString('ru-RU')}`}>изм.</span>
            )}
            {msg.pinned && <Pin className={`w-2.5 h-2.5 ${isMe ? 'text-emerald-50/80' : 'text-amber-500'}`} />}
            <span className={`text-2xs ${isMe ? 'text-emerald-50/80' : 'text-slate-400 dark:text-slate-500'}`}>
              {timeOf(msg.createdAt)}
            </span>
            {isMe && <Check className="w-3 h-3 text-emerald-50/80" aria-label="Отправлено" />}
          </span>
          <span className="clear-both block" />
        </div>

        {/* Реакции прижаты к пузырю снизу */}
        {reactions.length > 0 && (
          <div className={`flex flex-wrap gap-1 mt-1 ${isMe ? 'justify-end' : ''}`}>
            {reactions.map((r) => (
              <button
                key={r.emoji} type="button" onClick={() => onReact(r.emoji)}
                title={r.mine ? 'Убрать реакцию' : 'Поставить реакцию'}
                className={`flex items-center gap-1 pl-1.5 pr-2 py-0.5 rounded-full text-2xs cursor-pointer transition-ui ${
                  r.mine
                    ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300 ring-1 ring-emerald-400 dark:ring-emerald-700'
                    : 'bg-slate-100 dark:bg-slate-850 text-slate-600 dark:text-slate-350 hover:bg-slate-200 dark:hover:bg-slate-800'
                }`}
              >
                <span className="text-xs leading-none">{r.emoji}</span>
                <span className="font-medium">{r.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Плашка с датой посередине переписки. */
export function DayDivider({ label }: { label: string }) {
  return (
    <div className="sticky top-1 z-10 flex justify-center py-2 pointer-events-none select-none">
      <span className="px-3 py-1 rounded-full text-xs font-medium bg-slate-900/70 dark:bg-slate-100/15 text-white backdrop-blur-sm shadow-sm">
        {label}
      </span>
    </div>
  );
}
