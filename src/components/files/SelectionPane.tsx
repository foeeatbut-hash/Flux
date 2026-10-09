import React from 'react';
import { base64ToBytes, windowsFilesRequest, type WindowsFileEntry, type WindowsFileMetadata, type WindowsThumbnail } from '../../lib/windowsFiles';
import { NativeWindowsFileIcon } from '../explorer/WindowsFileIcon';
import { entryRef } from './fileOps';
import { X as T } from './explorerTheme';

export default function SelectionPane({ entries, rootId, mode, onProperties }: { entries: WindowsFileEntry[]; rootId: string; mode: 'details' | 'preview'; onProperties: (entry: WindowsFileEntry) => void }) {
  const entry = entries.length === 1 ? entries[0] : null;
  const [metadata, setMetadata] = React.useState<WindowsFileMetadata | null>(null);
  const [preview, setPreview] = React.useState<{ image?: string; text?: string; pdf?: string; error?: string }>({});
  React.useEffect(() => {
    let active = true; let objectUrl = '';
    setMetadata(null); setPreview({});
    if (!entry) return;
    const ref = entryRef(entry, rootId);
    void windowsFilesRequest<WindowsFileMetadata>({ action: 'metadata', ref }).then((answer) => { if (active && answer.ok) setMetadata(answer.data); });
    if (mode === 'preview' && entry.kind === 'file') {
      const ext = entry.name.split('.').pop()?.toLowerCase() || '';
      const image = /^(png|jpe?g|gif|webp|bmp)$/u.test(ext);
      const text = /^(txt|md|csv|json|log|xml|ini|yaml|yml)$/u.test(ext);
      if ((image || text || ext === 'pdf') && entry.size <= (text ? 2 : 32) * 1048576) {
        void windowsFilesRequest<{ base64: string }>({ action: 'read', ref }).then((answer) => {
          if (!active) return;
          if ('error' in answer) { setPreview({ error: answer.error.message }); return; }
          const bytes = base64ToBytes(answer.data.base64);
          if (text) setPreview({ text: new TextDecoder().decode(bytes) });
          else { objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: ext === 'pdf' ? 'application/pdf' : `image/${ext === 'jpg' ? 'jpeg' : ext}` })); setPreview(ext === 'pdf' ? { pdf: objectUrl } : { image: objectUrl }); }
        });
      } else void windowsFilesRequest<WindowsThumbnail>({ action: 'thumbnail', ref, size: 512, thumbnailOnly: true }).then((answer) => { if (active) setPreview(answer.ok && answer.data.thumbnail ? { image: answer.data.dataUrl } : { error: 'Предварительный просмотр недоступен.' }); });
    }
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [entry?.fileId, entry?.modifiedAt, rootId, mode]);
  return <aside aria-label={mode === 'preview' ? 'Предварительный просмотр' : 'Сведения'} className={`flex w-72 min-w-0 shrink-0 flex-col overflow-auto border-l p-4 ${T.line} ${T.pane} ${T.text}`}>
    {!entry ? <p className={`text-xs ${T.muted}`}>{entries.length ? `Выбрано элементов: ${entries.length}` : 'Выберите файл.'}</p> : <>
      <div className="mb-4 flex items-center gap-3"><NativeWindowsFileIcon entry={entry} fileRef={entryRef(entry, rootId)} size={40} /><h2 className="min-w-0 break-words text-sm">{entry.name}</h2></div>
      {mode === 'preview' && <div className="min-h-32 mb-4">{preview.image ? <img alt={entry.name} src={preview.image} className="max-h-96 max-w-full object-contain" /> : preview.pdf ? <iframe title={entry.name} src={preview.pdf} className="h-[500px] w-full" /> : preview.text !== undefined ? <pre className="whitespace-pre-wrap break-words text-xs">{preview.text}</pre> : <p className={`text-xs ${T.muted}`}>{preview.error || (entry.kind === 'directory' ? 'Папка' : 'Загрузка просмотра…')}</p>}</div>}
      <dl className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-3 text-xs">{[
        ['Тип', entry.kind === 'directory' ? 'Папка' : entry.name.split('.').pop()?.toUpperCase() || 'Файл'],
        ['Размер', entry.kind === 'directory' ? '—' : `${entry.size.toLocaleString('ru-RU')} Б`],
        ['Изменён', new Date(entry.modifiedAt).toLocaleString('ru-RU')],
        ['Хранение', entry.storage === 'flux' ? 'Черновик Flux' : 'Windows'],
        ['Теги', metadata?.tags.join(', ') || '—'], ['Ревизия', metadata?.revision || '—'], ['Ответственный', metadata?.responsible || '—'],
      ].map(([label, value]) => <React.Fragment key={label}><dt className={T.muted}>{label}</dt><dd className="min-w-0 break-words">{value}</dd></React.Fragment>)}</dl>
      <button type="button" onClick={() => onProperties(entry)} className={`mt-5 rounded py-2 text-xs ${T.iconButton}`}>Свойства</button>
    </>}
  </aside>;
}
