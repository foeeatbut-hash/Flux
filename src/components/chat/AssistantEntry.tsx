/**
 * Помощник в списке разговоров Мессенджера.
 *
 * Закреплён первым и выглядит как собеседник, а не как программа, в которую
 * надо идти: просьба владельца была именно такой — «по умолчанию в чате
 * мессенджера есть с ней диалог». История разговоров у него та же, что в
 * разделе «Помощник», — один список, одно хранилище: разговор, начатый здесь,
 * находится там и наоборот.
 */
import React from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import { useAssistantStore } from '../../store/assistantStore';

export default function AssistantEntry() {
  const open = useAssistantStore((s) => s.setOpen);
  return (
    <button
      type="button"
      onClick={() => open(true)}
      title="Спросить помощника. В группе его можно позвать, начав сообщение с «@помощник»"
      className="fx-li h-10"
    >
      <MessageCircleQuestion className="!text-[var(--flux-accent-text)]" />
      <div className="min-w-0 flex-1">
        <div className="truncate leading-5">Помощник</div>
        <div className="text-xs leading-4 text-slate-500 dark:text-slate-400 truncate">В группе зовите через «@помощник»</div>
      </div>
    </button>
  );
}
