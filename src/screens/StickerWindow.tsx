import React, { useEffect, useState, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { dataService, UserNote } from '../services/dataService';
import { useToastStore } from '../store/toastStore';
import RichTextEditor from '../components/RichTextEditor';
import { X, RefreshCw, Save, Check, ExternalLink } from 'lucide-react';
import { motion } from 'motion/react';

const COLORS = [
  { name: 'Желтый', class: 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 text-amber-900 dark:text-amber-100', btn: 'bg-amber-400' },
  { name: 'Красный', class: 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 text-rose-905 dark:text-rose-100', btn: 'bg-rose-400' },
  { name: 'Зеленый', class: 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 text-emerald-900 dark:text-emerald-100', btn: 'bg-emerald-400' },
  { name: 'Серый', class: 'bg-slate-100 dark:bg-slate-800 border-slate-350 dark:border-slate-700 text-slate-800 dark:text-slate-100', btn: 'bg-slate-400' },
];

/** Какой цвет из набора у заметки; незнакомый считаем первым. */
const presetOf = (color: string) =>
  COLORS.find(c => color.includes(c.class.split(' ')[0])) || COLORS[0];

export default function StickerWindow() {
  const location = useLocation();
  const { addToast } = useToastStore();
  const [note, setNote] = useState<UserNote | null>(null);
  const [loading, setLoading] = useState(true);
  
  // Auto-save states
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const autoSaveTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Накапливаем все несохраненные поля: debounce-таймер перезапускается на каждое
  // изменение, и без объединения сохранялся бы только последний fields (потеря правок)
  const pendingFieldsRef = useRef<Partial<UserNote>>({});

  // Extract note ID from URL param
  const query = new URLSearchParams(location.search);
  const noteId = query.get('id') || '';

  const loadNote = async () => {
    if (!noteId) return;
    try {
      setLoading(true);
      const fetched = await dataService.getNoteById(noteId);
      setNote(fetched);
    } catch (err: any) {
      addToast('Ошибка загрузки стикера', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadNote();
  }, [noteId]);

  // Handle auto save
  const handleNoteChange = (fields: Partial<UserNote>) => {
    if (!note) return;

    // Fast local state update
    const updated = { ...note, ...fields };
    setNote(updated);

    // Cancel existing timer
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }

    setSaveStatus('saving');
    pendingFieldsRef.current = { ...pendingFieldsRef.current, ...fields };
    autoSaveTimerRef.current = setTimeout(async () => {
      const payload = pendingFieldsRef.current;
      pendingFieldsRef.current = {};
      try {
        await dataService.updateNote(note.id, payload);
        setSaveStatus('saved');
      } catch (err) {
        setSaveStatus('error');
      }
    }, 1000);
  };

  // Close electron or popup window directly
  const handleClose = () => {
    window.close();
  };

  // Setup periodic polling sync (every 3 seconds) to handle changes made on main program
  useEffect(() => {
    const syncInterval = setInterval(async () => {
      if (!noteId || saveStatus === 'saving') return;
      try {
        const fresh = await dataService.getNoteById(noteId);
        // Only update local state if another window edited it (compare updated timestamp)
        if (note && fresh && fresh.updatedAt !== note.updatedAt) {
          setNote(fresh);
        }
      } catch (e) {
        // fail silently for sync
      }
    }, 3000);

    return () => {
      clearInterval(syncInterval);
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
  }, [noteId, note, saveStatus]);

  if (loading) {
    return (
      <div className="w-screen h-screen flex flex-col items-center justify-center bg-slate-900 text-slate-300 select-none">
        <RefreshCw className="w-8 h-8 animate-spin text-emerald-500 mb-2" />
        <span className="text-xs font-mono">Загрузка стикера...</span>
      </div>
    );
  }

  if (!note) {
    return (
      <div className="w-screen h-screen flex flex-col items-center justify-center bg-rose-950 text-rose-250 p-4 text-center select-none">
        <span className="text-sm font-semibold">Стикер не найден</span>
        <span className="text-xs mt-1 opacity-85">Возможно, заметка была удалена.</span>
        <button type="button" onClick={handleClose} className="mt-4 px-2.5 py-1 bg-rose-800 text-white text-xs rounded transition-ui">
          Закрыть
        </button>
      </div>
    );
  }

  // Какой цвет из набора у заметки. Сравниваем по первому классу, а не по всей
  // строке: в «Блокноте» тот же цвет описан короче — без цвета текста, — и
  // строгое равенство не совпадало ни для одной заметки.
  const stylePreset = presetOf(note.color);

  return (
    <div className={`w-screen h-screen flex flex-col border border-slate-350 dark:border-slate-800 p-0 overflow-hidden box-border select-none relative ${stylePreset.class}`}>
      
      {/* DRAG BAR (Step 4 & 5). Highly critical: -webkit-app-region: drag */}
      <div 
        id="drag-header"
        className="h-10 border-b border-black/5 dark:border-white/5 flex items-center justify-between px-3 shrink-0 cursor-move"
        style={{ WebkitAppRegion: 'drag' } as any}
      >
        {/* Status icon / indication */}
        <div className="flex items-center gap-1.5" style={{ WebkitAppRegion: 'no-drag' } as any}>
          <div className="w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse" />
          <span className="text-xs font-mono max-w-[100px] truncate opacity-70 font-medium">
            {note.title || 'Стикер'}
          </span>
          {saveStatus === 'saving' && (
            <RefreshCw className="w-2.5 h-2.5 animate-spin text-emerald-600 dark:text-emerald-400" />
          )}
          {saveStatus === 'saved' && (
            <div className="text-xs font-mono text-emerald-600 dark:text-emerald-400 flex items-center gap-0.5">
              <Check className="w-2.5 h-2.5" />
              <span>Sync</span>
            </div>
          )}
        </div>

        {/* Color Palette Buttons & window controls */}
        <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as any}>
          {/* Color Selects */}
          <div className="flex items-center gap-1">
            {COLORS.map(c => {
              const isCurrent = presetOf(note.color).name === c.name;
              return (
                <button type="button"
                  key={c.name}
                  onClick={() => handleNoteChange({ color: c.class })}
                  className={`w-3.5 h-3.5 rounded-full ${c.btn} border border-black/10 transition-transform cursor-pointer hover:scale-110 ${
                    isCurrent ? 'ring-1 ring-offset-1 ring-slate-400 dark:ring-offset-slate-900 scale-110' : ''
                  }`}
                  title={c.name}
                />
              );
            })}
          </div>

          <div className="w-[1px] h-4 bg-black/10 dark:bg-white/10 mx-0.5" />

          {/* Native close button */}
          <button type="button"
            onClick={handleClose}
            className="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 text-slate-700 dark:text-slate-300 hover:text-rose-600 dark:hover:text-rose-400 cursor-pointer transition-colors"
            title="Закрыть стикер"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* COMPACT NOTE TITLE */}
      <div className="px-3 pt-2 pb-1 shrink-0">
        <input
          type="text"
          placeholder="Название стикера"
          value={note.title}
          onChange={(e) => handleNoteChange({ title: e.target.value })}
          className="w-full text-xs font-medium border-none outline-none focus:outline-none bg-transparent placeholder-black/40 dark:placeholder-white/40"
        />
      </div>

      {/* SIMPLIFIED EDITOR CONTEXT (Step 4 & 5) */}
      <div className="flex-1 p-2 overflow-y-auto">
        <RichTextEditor
          value={note.content}
          onChange={(html) => handleNoteChange({ content: html })}
          className="h-full border-none shadow-none bg-transparent prose-xs"
        />
      </div>
    </div>
  );
}
