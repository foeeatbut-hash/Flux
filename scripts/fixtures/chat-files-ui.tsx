import React from 'react';
import { createRoot } from 'react-dom/client';
import MessageBubble from '../../src/components/chat/MessageBubble';
import { ChatFilesStatus, useChatFiles } from '../../src/components/chat/useChatFiles';
import { markGroups } from '../../src/components/chat/grouping';
import { useToastStore } from '../../src/store/toastStore';
import '../../src/index.css';

const message: any = {
  id: 'm1', content: 'Вот чертежи', createdAt: new Date().toISOString(), senderId: 'peer',
  sender: { id: 'peer', name: 'Иван Петров' },
  attachments: [{ id: 'a1', messageId: 'm1', fileName: 'Чертёж ОВ-12.pdf', filePath: '/chat_files/node-1/%D0%A7.pdf', fileSize: 483_000_000 }],
};
const noop = () => {};
// Уведомления копятся здесь: контейнер тостов на странице проверки не нарисован, а исчезают они по таймеру
const seen: string[] = [];
useToastStore.subscribe((state) => { for (const t of state.toasts) if (!seen.includes(t.message)) seen.push(t.message); });
(window as any).__toasts = () => seen;
const opened: string[] = [];
(window as any).__opened = opened;

function Fixture() {
  const files = useChatFiles();
  const [staged, setStaged] = React.useState<string[]>([]);
  (window as any).__staged = () => staged;
  return <div className="p-4 space-y-3" style={{ maxWidth: 560 }}>
    <MessageBubble msg={message} isMe={false} mark={markGroups([message])[0]} hideNames={false} reactions={[]} emojis={[]} pickerOpen={false}
      onTogglePicker={noop} onReact={noop} onReply={noop} onForward={noop} onPin={noop} onCopy={noop} onEdit={noop} onDelete={noop}
      onOpenEquipment={noop} onOpenFile={(p) => opened.push(p)} onDownloadFile={files.download} formatBytes={(n) => `${Math.round(n / 1048576)} МБ`}>{message.content}</MessageBubble>
    <ChatFilesStatus uploading={files.uploading} saved={files.saved} onReveal={() => void files.reveal()} onDismiss={files.dismiss} />
    <input type="file" aria-label="Выбрать файл" onChange={async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const done = await files.upload(file);
      if (done) setStaged((cur) => [...cur, done.fileName]);
    }} />
    <ul aria-label="Прикреплено">{staged.map((n) => <li key={n}>{n}</li>)}</ul>
  </div>;
}
createRoot(document.getElementById('mount')!).render(<Fixture />);
