/**
 * Состояние файлов чата для окна переписки: загрузка вложения (с долей) и
 * итог скачивания («Сохранено в Загрузки» с кнопкой «Показать в папке»).
 *
 * Вынесено из ChatManagement: экран и так велик, а у этих двух состояний свой
 * жизненный цикл и своя разметка.
 */
import React from 'react';
import { CheckCircle2, FolderOpen, X } from 'lucide-react';
import { downloadChatFile, revealDownload, uploadChatFile, type ChatUploaded } from '../../lib/chatFileTransfer';
import { useToastStore } from '../../store/toastStore';

export interface SavedDownload { path: string; name: string }

export function useChatFiles() {
  const addToast = useToastStore((s) => s.addToast);
  const [uploading, setUploading] = React.useState<{ name: string; percent: number } | null>(null);
  const [saved, setSaved] = React.useState<SavedDownload | null>(null);

  /** Загрузить вложение кусками; ошибку не глотает — она показывается тостом */
  const upload = React.useCallback(async (file: File): Promise<ChatUploaded | null> => {
    setUploading({ name: file.name, percent: 0 });
    try {
      const done = await uploadChatFile(file, (share) => setUploading({ name: file.name, percent: Math.round(share * 100) }));
      addToast(`Файл «${file.name}» прикреплён`, 'success');
      return done;
    } catch (error: any) {
      addToast(error?.message || 'Ошибка заливки файла на сервер', 'error');
      return null;
    } finally {
      setUploading(null);
    }
  }, [addToast]);

  const download = React.useCallback(async (filePath: string, fileName: string) => {
    const result = await downloadChatFile(filePath, fileName);
    if (result.kind === 'saved') setSaved({ path: result.path, name: result.name });
    else if (result.kind === 'error') { setSaved(null); addToast(result.message, 'error'); }
  }, [addToast]);

  const reveal = React.useCallback(async () => {
    if (!saved) return;
    const problem = await revealDownload(saved.path);
    if (problem) addToast(problem, 'error');
  }, [saved, addToast]);

  return { uploading, saved, upload, download, reveal, dismiss: () => setSaved(null) };
}

/** Полоса над полем ввода: что сейчас загружается и что сохранено в «Загрузки» */
export function ChatFilesStatus({ uploading, saved, onReveal, onDismiss }: {
  uploading: { name: string; percent: number } | null;
  saved: SavedDownload | null;
  onReveal: () => void;
  onDismiss: () => void;
}) {
  if (!uploading && !saved) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 py-1 text-xs text-slate-600 dark:text-slate-300" data-testid="chat-files-status">
      {uploading && (
        <span role="status" className="fx-st fx-st-info">Загрузка «{uploading.name}»: {uploading.percent}%</span>
      )}
      {saved && (
        <span role="status" className="flex min-w-0 items-center gap-2" data-testid="chat-saved">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <span className="min-w-0 truncate">Сохранено в Загрузки: {saved.name}</span>
          <button type="button" className="fx-btn fx-btn-sm" onClick={onReveal}><FolderOpen className="w-3.5 h-3.5" />Показать в папке</button>
          <button type="button" className="fx-ibtn" aria-label="Закрыть уведомление" onClick={onDismiss}><X className="w-3.5 h-3.5" /></button>
        </span>
      )}
    </div>
  );
}
