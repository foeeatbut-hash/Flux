import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useWindowHotkeys } from '../lib/useWindowHotkeys';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store/store';
import { useToastStore } from '../store/toastStore';
import { dataService, UserNote } from '../services/dataService';
import RichTextEditor from '../components/RichTextEditor';
import { ENV_CONFIG, getAuthToken } from '../config/env';
import { motion, AnimatePresence } from 'motion/react';
import {
  Plus, Search, BookOpen, Calendar, Trash2, ExternalLink,
  Save, FileText, CheckCircle2, RefreshCw, Pin, PinOff, Copy, Download, FileType2, Printer,
  FolderPlus, Folder, ChevronDown, ChevronRight, X, Users2, Share2, UserPlus2
} from 'lucide-react';
import NoteShareDialog from '../components/NoteShareDialog';
import { useModalStore } from '../store/modalStore';

// Диалоги программы вместо системных окон Windows
const { openConfirm } = useModalStore.getState();

const COLORS = [
  { name: 'Желтый', class: 'bg-amber-50 dark:bg-amber-950/20 border-amber-200', btn: 'bg-amber-400' },
  { name: 'Красный', class: 'bg-rose-50 dark:bg-rose-950/20 border-rose-200', btn: 'bg-rose-400' },
  { name: 'Зеленый', class: 'bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200', btn: 'bg-emerald-400' },
  { name: 'Серый', class: 'bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-700', btn: 'bg-slate-400' },
];

/**
 * Цвет заметки — какой из набора. Заметки, заведённые до перехода палитры на
 * amber, хранят в базе жёлтый: у них не загорался кружок в списке и ни один
 * образец не отмечался выбранным. Незнакомый цвет считаем первым из набора.
 */
export const presetOf = (color: string) =>
  COLORS.find(c => color.includes(c.class.split(' ')[0])) || COLORS[0];

export default function NotesManagement() {
  const { user, activeProject } = useStore();
  const { addToast } = useToastStore();
  const navigate = useNavigate();

  const [notes, setNotes] = useState<UserNote[]>([]);
  const [scope, setScope] = useState<'mine' | 'shared' | 'common'>('mine');
  const [shareFor, setShareFor] = useState<UserNote | null>(null);
  const [selectedNote, setSelectedNote] = useState<UserNote | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  // Сортировка списка заметок
  const [sortBy, setSortBy] = useState<'updated' | 'title' | 'created'>(() => {
    const v = localStorage.getItem(`pdm_notes_sort_${user?.id || 'anon'}`);
    return v === 'title' || v === 'created' ? v : 'updated';
  });
  const changeSort = (v: 'updated' | 'title' | 'created') => {
    setSortBy(v);
    try { localStorage.setItem(`pdm_notes_sort_${user?.id || 'anon'}`, v); } catch (_) {}
  };
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Теги активного проекта — для вставки внутренних ссылок в заметку
  const [projectTags, setProjectTags] = useState<{ id: string; identifier: string }[]>([]);
  useEffect(() => {
    if (!activeProject?.id) { setProjectTags([]); return; }
    fetch(`/api/projects/${activeProject.id}/tags`)
      .then(r => r.json())
      .then(d => {
        const list = Array.isArray(d) ? d : (d.tags || []);
        setProjectTags(list.map((t: any) => ({ id: t.id, identifier: t.identifier })));
      })
      .catch(() => setProjectTags([]));
  }, [activeProject?.id]);

  // Свёрнутость групп заметок (хранится локально)
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(`pdm_note_groups_collapsed_${user?.id || 'anon'}`) || '{}'); }
    catch (_) { return {}; }
  });
  const toggleGroup = (name: string) => {
    setCollapsedGroups(prev => {
      const next = { ...prev, [name]: !prev[name] };
      try { localStorage.setItem(`pdm_note_groups_collapsed_${user?.id || 'anon'}`, JSON.stringify(next)); } catch (_) {}
      return next;
    });
  };
  // Выбор группы в редакторе
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const groupMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!groupMenuOpen) return;
    const close = (e: MouseEvent) => {
      if (!groupMenuRef.current?.contains(e.target as Node)) setGroupMenuOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [groupMenuOpen]);

  // Auto-save states
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const autoSaveTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Все несохраненные поля копятся здесь: debounce перезапускается на каждое изменение,
  // и без объединения сохранялось бы только последнее поле (потеря правок)
  const pendingFieldsRef = useRef<Partial<UserNote>>({});
  const pendingNoteIdRef = useRef<string | null>(null);

  // Закрепленные заметки (хранится локально для пользователя)
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(`pdm_pinned_notes_${user?.id || 'anon'}`) || '[]');
    } catch (e) { return []; }
  });

  const togglePin = (e: React.MouseEvent, noteId: string) => {
    e.stopPropagation();
    setPinnedIds(prev => {
      const next = prev.includes(noteId) ? prev.filter(id => id !== noteId) : [noteId, ...prev];
      try { localStorage.setItem(`pdm_pinned_notes_${user?.id || 'anon'}`, JSON.stringify(next)); } catch (err) {}
      return next;
    });
  };

  // Немедленно сохраняет накопленные изменения (при переключении заметки, Ctrl+S, размонтировании)
  const flushPendingSave = async () => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    const noteId = pendingNoteIdRef.current;
    const payload = pendingFieldsRef.current;
    if (noteId && Object.keys(payload).length > 0) {
      pendingFieldsRef.current = {};
      pendingNoteIdRef.current = null;
      await saveNoteToDb(noteId, payload);
    }
  };

  // Load all notes
  const loadNotes = async (selectIdAfterLoad?: string) => {
    try {
      setLoading(true);
      const fetched = await dataService.getNotes();
      setNotes(fetched);
      
      if (fetched.length > 0) {
        if (selectIdAfterLoad) {
          const matching = fetched.find(n => n.id === selectIdAfterLoad);
          if (matching) setSelectedNote(matching);
        } else if (!selectedNote) {
          setSelectedNote(fetched[0]);
        } else {
          // Sync currently selected note with updated state
          const current = fetched.find(n => n.id === selectedNote.id);
          if (current) setSelectedNote(current);
        }
      } else {
        setSelectedNote(null);
      }
    } catch (err: any) {
      addToast(err.message || 'Ошибка загрузки заметок', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadNotes();
  }, []);

  // Глубокая ссылка от ИИ-помощника: /notes?new=<заголовок> — создать заметку сразу
  const newNoteHandledRef = useRef(false);
  useEffect(() => {
    if (newNoteHandledRef.current) return;
    const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
    const preset = params.get('new');
    if (preset !== null) {
      newNoteHandledRef.current = true;
      handleCreateNote(preset || undefined);
      // убираем параметр из адреса
      window.history.replaceState(null, '', window.location.hash.split('?')[0]);
    }
  }, []);

  // Handle note deletion
  const handleDeleteNote = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!await openConfirm('Удалить заметку?', 'Восстановить её будет нельзя.', { confirmLabel: 'Удалить', tone: 'danger' })) return;

    try {
      await dataService.deleteNote(id);
      addToast('Заметка удалена', 'success');
      
      // If we are deleting the selected note
      if (selectedNote?.id === id) {
        setSelectedNote(null);
      }
      loadNotes();

      // Log action to SystemChangeLog
      await dataService.createLog({
        userName: user?.name || 'Главный Администратор',
        userSymbol: user?.symbol || 'RaupovKhKh',
        description: `Удалена инженерная заметка`,
        targetRoute: '/notes'
      });
    } catch (err: any) {
      addToast(err.message || 'Не удалось удалить заметку', 'error');
    }
  };

  // Create new note
  const handleCreateNote = async (presetTitle?: string) => {
    try {
      const newNote = await dataService.createNote({
        // Пустой контент — редактор сам покажет подсказку, не нужно стирать текст
        title: presetTitle && presetTitle.trim() ? presetTitle.trim() : 'Новая заметка',
        content: '',
        color: 'bg-amber-50 dark:bg-amber-950/20 border-amber-200'
      });
      addToast('Заметка создана', 'success');
      await loadNotes(newNote.id);

      // Log action
      await dataService.createLog({
        userName: user?.name || 'Главный Администратор',
        userSymbol: user?.symbol || 'RaupovKhKh',
        description: `Создана новая инженерная заметка: "${newNote.title}"`,
        targetRoute: '/notes'
      });
    } catch (err: any) {
      addToast(err.message || 'Ошибка при создании заметки', 'error');
    }
  };

  // Perform backend update
  const saveNoteToDb = async (noteId: string, updatedFields: Partial<UserNote>) => {
    setSaveStatus('saving');
    try {
      await dataService.updateNote(noteId, updatedFields);
      setSaveStatus('saved');
      
      // Update local notes array so sidebar stays perfectly updated
      setNotes(prev => prev.map(n => n.id === noteId ? { ...n, ...updatedFields, updatedAt: new Date().toISOString() } : n));
    } catch (err) {
      setSaveStatus('error');
    }
  };

  // Triggered when anything is updated in the selected note
  const handleNoteChange = (fields: Partial<UserNote>) => {
    if (!selectedNote) return;

    // Immediately update local UI so there is zero lagging
    const updated = { ...selectedNote, ...fields };
    setSelectedNote(updated);

    // Cancel existing timers
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }

    // Debounce backend update by 1000ms, накапливая ВСЕ изменённые поля
    pendingFieldsRef.current = { ...pendingFieldsRef.current, ...fields };
    pendingNoteIdRef.current = selectedNote.id;
    setSaveStatus('saving');
    autoSaveTimerRef.current = setTimeout(() => {
      const noteId = pendingNoteIdRef.current;
      const payload = pendingFieldsRef.current;
      pendingFieldsRef.current = {};
      pendingNoteIdRef.current = null;
      if (noteId) saveNoteToDb(noteId, payload);
    }, 1000);
  };

  // Переключение заметки: сначала сохраняем несохраненное в предыдущей
  const handleSelectNote = (note: UserNote) => {
    if (selectedNote?.id === note.id) return;
    flushPendingSave();
    setSelectedNote(note);
  };

  // Дублировать заметку
  const handleDuplicateNote = async (e: React.MouseEvent, note: UserNote) => {
    e.stopPropagation();
    try {
      const copy = await dataService.createNote({
        title: `${note.title} (копия)`,
        content: note.content,
        color: note.color,
        groupName: note.groupName ?? null,
      });
      addToast('Создана копия заметки', 'success');
      await loadNotes(copy.id);
    } catch (err: any) {
      addToast(err.message || 'Не удалось создать копию', 'error');
    }
  };

  // Экспорт заметки в текстовый файл
  const handleExportNote = (e: React.MouseEvent, note: UserNote) => {
    e.stopPropagation();
    try {
      const tmp = document.createElement('div');
      tmp.innerHTML = note.content || '';
      const text = `${note.title}\n${'='.repeat(Math.max(8, note.title.length))}\n\n${tmp.innerText}`;
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${(note.title || 'заметка').replace(/[\\/:*?"<>|]/g, '_')}.txt`;
      a.click();
      URL.revokeObjectURL(a.href);
      addToast('Заметка экспортирована в TXT', 'success');
    } catch (err: any) {
      addToast('Не удалось экспортировать заметку', 'error');
    }
  };

  // Экспорт заметки в Word (.doc открывается Word'ом как HTML-документ)
  const handleExportWord = (e: React.MouseEvent, note: UserNote) => {
    e.stopPropagation();
    try {
      // Инлайновые стили таблиц: Word не знает tailwind-классов, без них таблицы шли без рамок
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${note.title}</title>` +
        `<style>body{font-family:Calibri,Arial,sans-serif;color:#0f172a} table{border-collapse:collapse;width:100%} td,th{border:1px solid #94a3b8;padding:6px} th{background:#f1f5f9}</style>` +
        `</head><body><h1>${note.title}</h1>${note.content || ''}</body></html>`;
      const blob = new Blob(['﻿', html], { type: 'application/msword' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${(note.title || 'заметка').replace(/[\\/:*?"<>|]/g, '_')}.doc`;
      a.click();
      URL.revokeObjectURL(a.href);
      addToast('Заметка экспортирована в Word (.doc)', 'success');
    } catch (err: any) {
      addToast('Не удалось экспортировать заметку', 'error');
    }
  };

  // Печать заметки (скрытый iframe, чтобы не печатать весь интерфейс)
  const handlePrintNote = (e: React.MouseEvent, note: UserNote) => {
    e.stopPropagation();
    try {
      const frame = document.createElement('iframe');
      frame.style.position = 'fixed';
      frame.style.right = '-10000px';
      document.body.appendChild(frame);
      const doc = frame.contentDocument!;
      doc.open();
      doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${note.title}</title>` +
        `<style>body{font-family:Arial,sans-serif;padding:24px;color:#0f172a} table{border-collapse:collapse} td,th{border:1px solid #94a3b8;padding:6px}</style>` +
        `</head><body><h1>${note.title}</h1>${note.content || ''}</body></html>`);
      doc.close();
      frame.contentWindow!.focus();
      frame.contentWindow!.print();
      setTimeout(() => document.body.removeChild(frame), 2000);
    } catch (err: any) {
      addToast('Не удалось открыть печать', 'error');
    }
  };

  /**
   * Горячие клавиши: Ctrl+S — сохранить, Ctrl+N — новая заметка, Ctrl+F — поиск.
   *
   * Раньше подписка была прямой на `window` и без массива зависимостей:
   * слушатель переподписывался каждой отрисовкой, и КАЖДЫЙ смонтированный
   * Блокнот отвечал на Ctrl+N. Два открытых окна — две заметки за одно
   * нажатие, да ещё и из чужой программы. Теперь клавишу получает только
   * активное окно (src/lib/hotkeys.ts).
   */
  useWindowHotkeys((e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 's') { e.preventDefault(); flushPendingSave(); }
    else if (k === 'n') { e.preventDefault(); handleCreateNote(); }
    else if (k === 'f') { e.preventDefault(); searchInputRef.current?.focus(); }
  });

  // Open sticker window / external link
  const handleOpenSticker = (e: React.MouseEvent, noteId: string) => {
    e.stopPropagation();
    const win = window as any;
    
    if (win.electron && win.electron.ipcRenderer) {
      win.electron.ipcRenderer.send('window:open-sticker', noteId);
      addToast('Стикер откреплен на отдельный рабочий экран!', 'success');
    } else {
      // Fallback popup window in web browsers! Height/width are specified beautifully
      const popup = window.open(
        `/#/sticker?id=${noteId}`,
        `sticker-${noteId}`,
        'width=320,height=380,menubar=no,status=no,toolbar=no,location=no,status=no,directories=no,resizable=yes'
      );
      if (popup) {
        addToast('Стикер открыт во внешнем окне!', 'success');
      } else {
        addToast('Браузер заблокировал всплывающее окно. Одобрите всплывающие окна для сайта.', 'info');
      }
    }
  };

  // Cleanup auto-save on unmount: не теряем несохраненные изменения
  useEffect(() => {
    return () => {
      flushPendingSave();
    };
  }, []);

  // Забрать старую общую заметку себе: данные из прежних версий не должны
  // висеть ничьими, но и раздавать их автоматически нельзя.
  const claimNote = async (note: UserNote) => {
    try {
      const res = await fetch(`${ENV_CONFIG.apiUrl}/notes/${note.id}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {}) },
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Не удалось забрать заметку');
      addToast(`Заметка «${note.title || 'Без названия'}» теперь ваша`, 'success');
      await loadNotes(note.id);
      setScope('mine');
    } catch (e: any) {
      addToast(e.message, 'error');
    }
  };

  // Filter notes based on search query; закрепленные сверху, далее свежие
  const filteredNotes = notes
    .filter(note => {
      // Блокнот личный: раздельно показываем свои, открытые коллегами и
      // старые общие — иначе непонятно, чья запись перед глазами.
      if (scope === 'mine' && !note.mine) return false;
      if (scope === 'shared' && (note.mine || note.legacy)) return false;
      if (scope === 'common' && !note.legacy) return false;
      return true;
    })
    .filter(note =>
      note.title.toLowerCase().includes(search.toLowerCase()) ||
      note.content.toLowerCase().includes(search.toLowerCase())
    )
    .sort((a, b) => {
      const pinA = pinnedIds.includes(a.id) ? 1 : 0;
      const pinB = pinnedIds.includes(b.id) ? 1 : 0;
      if (pinA !== pinB) return pinB - pinA;
      if (sortBy === 'title') return (a.title || '').localeCompare(b.title || '', 'ru');
      if (sortBy === 'created') return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

  // Относительная дата для списка: сегодня ЧЧ:ММ / вчера / дд.мм.гггг
  const relDate = (iso: string) => {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const y = new Date(now); y.setDate(now.getDate() - 1);
    const yesterday = d.toDateString() === y.toDateString();
    const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return `сегодня ${hm}`;
    if (yesterday) return `вчера ${hm}`;
    return d.toLocaleDateString('ru-RU');
  };

  // Счетчик слов и символов выбранной заметки
  const noteStats = (() => {
    if (!selectedNote) return null;
    const tmp = typeof document !== 'undefined' ? document.createElement('div') : null;
    if (!tmp) return null;
    tmp.innerHTML = selectedNote.content || '';
    const text = tmp.innerText.trim();
    const words = text ? text.split(/\s+/).length : 0;
    return { words, chars: text.length };
  })();

  return (
    <motion.div 
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.25 }}
      className="h-full flex gap-4 overflow-x-auto font-sans select-none"
    >
      {/* LEFT SIDEBAR: NOTES DIRECTORY */}
      <div id="notes-sidebar" className="w-56 @[900px]:w-80 shrink-0 flex flex-col bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden shadow-xs">
        {/* Search & Add block */}
        <div className="p-4 border-b border-slate-100 dark:border-slate-800 space-y-3 bg-slate-50/50 dark:bg-slate-900/40">
          <div className="flex items-center justify-between gap-2 min-w-0">
            <h2 className="min-w-0 text-md font-bold text-slate-850 dark:text-white flex items-center gap-2">
              <BookOpen className="w-4 h-4 shrink-0 text-emerald-600" />
              <span className="truncate">Инженерный блокнот</span>
            </h2>
            <button type="button"
              onClick={() => handleCreateNote()}
              data-tour="note-create-btn"
              className="p-1.5 bg-emerald-700 hover:bg-emerald-600 text-white rounded-lg cursor-pointer transition-ui flex items-center justify-center shadow-xs"
              title="Создать заметку"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
          {/* Чей блокнот смотрим */}
          <div className="flex items-center gap-1">
            {(() => {
              const counts = {
                mine: notes.filter(n => n.mine).length,
                shared: notes.filter(n => !n.mine && !n.legacy).length,
                common: notes.filter(n => n.legacy).length,
              };
              return ([['mine', 'Мои'], ['shared', 'Со мной'], ['common', 'Общие']] as const)
                .filter(([id]) => id !== 'common' || counts.common > 0)
                .map(([id, label]) => (
                  <button type="button" key={id} onClick={() => setScope(id)}
                    title={id === 'shared' ? 'Заметки, которыми с вами поделились'
                      : id === 'common' ? 'Заметки из версий до личного блокнота — видны всем'
                      : 'Ваши личные заметки'}
                    className={`px-2.5 py-1 rounded-lg text-2xs font-bold cursor-pointer transition-ui ${
                      scope === id
                        ? 'bg-emerald-600 text-white'
                        : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'}`}>
                    {label} {counts[id] > 0 && <span className="opacity-70">{counts[id]}</span>}
                  </button>
                ));
            })()}
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Поиск заметок… (Ctrl+F)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-8 py-2 bg-slate-100/70 dark:bg-slate-950 border border-transparent dark:border-slate-800 rounded-lg text-xs text-slate-800 dark:text-white placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-emerald-500/20 focus:border-emerald-500 transition-ui"
            />
            {search && (
              <button type="button" onClick={() => setSearch('')} className="absolute right-2 top-2 p-0.5 text-slate-400 hover:text-slate-600 cursor-pointer" title="Очистить">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {/* Сортировка списка */}
          <div className="flex flex-wrap items-center gap-1 text-xs min-w-0">
            <span className="text-slate-400 mr-0.5">Сортировка:</span>
            {([['updated','Изменённые'],['created','Новые'],['title','А–Я']] as const).map(([v, label]) => (
              <button type="button"
                key={v}
                onClick={() => changeSort(v)}
                /* min-h-6: было 20 px — в такую кнопку целятся, а не нажимают */
                className={`px-2 py-1 min-h-6 rounded-md font-semibold cursor-pointer transition-colors ${sortBy === v ? 'bg-emerald-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* List content */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-2">
              <RefreshCw className="w-6 h-6 animate-spin text-emerald-600" />
              <span className="text-xs">Загрузка ваших заметок...</span>
            </div>
          ) : filteredNotes.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full py-12 text-slate-400 dark:text-slate-500 text-center px-4">
              <FileText className="w-8 h-8 text-slate-350 dark:text-slate-750 mb-2" />
              <p className="text-xs font-semibold">Заметок не найдено</p>
              <p className="text-xs mt-0.5 opacity-80">Нажмите «+ Создать», чтобы добавить новую</p>
            </div>
          ) : (() => {
            const renderNote = (note: UserNote) => {
              const isSelected = selectedNote?.id === note.id;
              // strip HTML for text previews
              const cleanContent = note.content ? note.content.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ') : '';

              return (
                <div
                  key={note.id}
                  onClick={() => handleSelectNote(note)}
                  className={`p-3 rounded-xl border transition-ui cursor-pointer relative group text-left ${
                    isSelected 
                      ? 'bg-slate-100/85 dark:bg-slate-800/80 border-slate-300 dark:border-slate-700 shadow-xs' 
                      : 'bg-white dark:bg-slate-900 border-slate-150 dark:border-slate-800/60 hover:bg-slate-50/70 dark:hover:bg-slate-850'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2.5 min-w-0">
                    {/* truncate на самом заголовке ничего не давало: он ещё и
                        flex-контейнер, а в нём многоточие не работает — режет
                        только собственный текст, которого у него нет. Название
                        вылезало за карточку на 34 px, карточка за колонку — на
                        22 px. Обрезает теперь вложенная строка, и она же берёт
                        на себя свободное место. */}
                    <h3 className="text-xs font-bold text-slate-800 dark:text-white flex-1 min-w-0 flex items-center gap-1">
                      {pinnedIds.includes(note.id) && <Pin className="w-3 h-3 text-amber-500 shrink-0" />}
                      <span className="flex-1 min-w-0 truncate">{note.title || 'Новая заметка'}</span>
                      {/* Кому ещё видна заметка — сразу в списке, чтобы личное
                          не оказалось открытым по забывчивости */}
                      {note.mine && (note.sharedWith?.length || 0) > 0 && (
                        <span title={`Открыта ${note.sharedWith!.length} сотрудник(ам)`}
                          className="shrink-0 inline-flex items-center gap-0.5 text-2xs font-semibold text-sky-600 dark:text-sky-400">
                          <Users2 className="w-3 h-3" />{note.sharedWith!.length}
                        </span>
                      )}
                      {!note.mine && !note.legacy && (
                        <span title={note.canEdit ? 'Вам открыли на правку' : 'Вам открыли только на чтение'}
                          className="shrink-0 text-2xs font-semibold text-sky-600 dark:text-sky-400">
                          {note.canEdit ? 'правка' : 'чтение'}
                        </span>
                      )}
                      {note.legacy && (
                        <span title="Заметка из версий до личного блокнота — видна всем"
                          className="shrink-0 text-2xs font-semibold text-amber-600 dark:text-amber-400">общая</span>
                      )}
                    </h3>
                    
                    {/* Кнопки по наведению. Раньше они стояли в строке рядом с
                        названием и не сжимались: восемь кнопок занимают 204 px,
                        а в узкой колонке списка на строку приходится 180 —
                        название выдавливалось наружу, а с min-w-0 исчезало
                        совсем. Теперь они лежат поверх карточки, как и было
                        задумано её `relative group`, и на ширину названия не
                        влияют. Переносятся по строкам, чтобы поместиться в
                        карточку любой ширины. focus-within — чтобы до них
                        можно было добраться с клавиатуры, а не только мышью. */}
                    <div className="absolute top-2 right-2 z-10 max-w-[calc(100%-1rem)] opacity-0 group-hover:opacity-100 focus-within:opacity-100 flex flex-wrap items-center justify-end gap-1 transition-opacity rounded-lg border border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 px-1 py-0.5 shadow-xs">
                      <button type="button"
                        onClick={(e) => togglePin(e, note.id)}
                        className="p-1 text-slate-400 hover:text-amber-500 rounded transition-colors"
                        title={pinnedIds.includes(note.id) ? 'Открепить из верха списка' : 'Закрепить вверху списка'}
                      >
                        {pinnedIds.includes(note.id) ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
                      </button>
                      {note.mine && (
                        <button type="button"
                          onClick={(e) => { e.stopPropagation(); setShareFor(note); }}
                          className={`p-1 rounded transition-colors ${
                            (note.sharedWith?.length || 0) > 0
                              ? 'text-sky-500 hover:text-sky-600'
                              : 'text-slate-400 hover:text-sky-600 dark:hover:text-sky-400'}`}
                          title={(note.sharedWith?.length || 0) > 0
                            ? `Открыта ${note.sharedWith!.length} сотрудник(ам) — изменить доступ`
                            : 'Поделиться заметкой'}
                        >
                          <Share2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {note.legacy && (
                        <button type="button"
                          onClick={(e) => { e.stopPropagation(); void claimNote(note); }}
                          className="p-1 text-amber-500 hover:text-amber-600 rounded transition-colors"
                          title="Забрать заметку себе — она станет личной"
                        >
                          <UserPlus2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button type="button"
                        onClick={(e) => handleDuplicateNote(e, note)}
                        className="p-1 text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 rounded transition-colors"
                        title="Дублировать заметку"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                      <button type="button"
                        onClick={(e) => handleExportNote(e, note)}
                        className="p-1 text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 rounded transition-colors"
                        title="Экспорт в TXT"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                      <button type="button"
                        onClick={(e) => handleExportWord(e, note)}
                        className="p-1 text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 rounded transition-colors"
                        title="Экспорт в Word (.doc)"
                      >
                        <FileType2 className="w-3.5 h-3.5" />
                      </button>
                      <button type="button"
                        onClick={(e) => handlePrintNote(e, note)}
                        className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded transition-colors"
                        title="Печать заметки"
                      >
                        <Printer className="w-3.5 h-3.5" />
                      </button>
                      <button type="button"
                        onClick={(e) => handleOpenSticker(e, note.id)}
                        className="p-1 text-slate-400 hover:text-sky-600 dark:hover:text-sky-400 rounded transition-colors"
                        title="Открепить стикер поверх ОС"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </button>
                      <button type="button"
                        onClick={(e) => handleDeleteNote(e, note.id)}
                        className="p-1 text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 rounded transition-colors"
                        title="Удалить заметку"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2 mt-1 font-light leading-relaxed">
                    {cleanContent || 'Нет содержимого'}
                  </p>

                  <div className="mt-2.5 flex items-center justify-between">
                    <span className="text-xs font-mono text-slate-400 dark:text-slate-500 flex items-center gap-1 whitespace-nowrap">
                      <Calendar className="w-2.5 h-2.5 shrink-0" />
                      {relDate(note.updatedAt)}
                    </span>
                    
                    {/* Кружок цвета заметки */}
                    <div className="flex items-center gap-1.5">
                      <div className={`w-2 h-2 rounded-full ${presetOf(note.color).btn}`} />
                    </div>
                  </div>
                </div>
              );
            };

            // Группировка: заметки без группы сверху, затем группы по алфавиту
            const ungrouped = filteredNotes.filter(n => !n.groupName);
            const grouped: Record<string, UserNote[]> = {};
            for (const n of filteredNotes) {
              if (n.groupName) (grouped[n.groupName] = grouped[n.groupName] || []).push(n);
            }
            const groupNames = Object.keys(grouped).sort((a, b) => a.localeCompare(b, 'ru'));

            return (
              <>
                {ungrouped.map(renderNote)}
                {groupNames.map(g => {
                  // при поиске группы всегда раскрыты, чтобы совпадения были видны
                  const open = search.trim() ? true : !collapsedGroups[g];
                  return (
                    <div key={g} className="space-y-1.5">
                      <button type="button"
                        onClick={() => toggleGroup(g)}
                        className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-left cursor-pointer"
                        title={open ? 'Свернуть группу' : 'Развернуть группу'}
                      >
                        {open ? <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
                        <Folder className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                        <span className="text-xs font-bold text-slate-700 dark:text-slate-300 truncate flex-1">{g}</span>
                        <span className="text-2xs px-1.5 py-0.5 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300">{grouped[g].length}</span>
                      </button>
                      {open && <div className="pl-2 space-y-1.5">{grouped[g].map(renderNote)}</div>}
                    </div>
                  );
                })}
              </>
            );
          })()}
        </div>
      </div>

      {/* RIGHT SIDEBAR: WORKSPACE EDITING AREA */}
      <div id="notes-content" className="flex-1 min-w-[300px] flex flex-col bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden shadow-xs relative">
        {selectedNote ? (
          <div className="flex-grow flex flex-col h-full">
            {/* Header / Meta properties */}
            <div className="p-4 border-b border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 bg-slate-50/20 dark:bg-slate-900/10">
              <div className="flex flex-wrap items-center gap-3 min-w-0">
                {/* Save status notification badge */}
                <div className="flex items-center gap-1.5 text-xs">
                  {saveStatus === 'saving' && (
                    <span className="text-amber-600 dark:text-amber-400 flex items-center gap-1 font-mono text-xs">
                      <RefreshCw className="w-3 h-3 animate-spin" />
                      <span>Сохранение...</span>
                    </span>
                  )}
                  {saveStatus === 'saved' && (
                    <span className="text-emerald-600 dark:text-emerald-450 flex items-center gap-1 font-mono text-xs">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                      <span>Сохранено в SQLite</span>
                    </span>
                  )}
                  {saveStatus === 'idle' && (
                    <span className="text-slate-400 dark:text-slate-500 flex items-center gap-1 font-mono text-xs">
                      <Save className="w-3 h-3" />
                      <span>Ожидание изменений</span>
                    </span>
                  )}
                </div>
                {noteStats && (
                  <span className="text-xs font-mono text-slate-400 dark:text-slate-500 select-none" title="Слов / символов (Ctrl+S — сохранить сейчас)">
                    {noteStats.words} слов · {noteStats.chars} симв.
                  </span>
                )}
              </div>

              {/* Группа заметки */}
              <div className="relative" ref={groupMenuRef}>
                <button type="button"
                  onClick={() => { setGroupMenuOpen(v => !v); setNewGroupName(''); }}
                  className="px-2.5 py-1.5 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-700 dark:text-slate-300 font-semibold cursor-pointer flex items-center gap-1.5 transition-ui"
                  title="Группа заметки: объединяйте заметки по темам"
                >
                  <Folder className="w-3.5 h-3.5 text-emerald-600" />
                  <span className="max-w-[140px] truncate">{selectedNote.groupName || 'Без группы'}</span>
                  <ChevronDown className="w-3 h-3 text-slate-400" />
                </button>
                {groupMenuOpen && (
                  <div className="absolute top-full left-0 mt-1.5 w-60 p-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl z-50 space-y-1">
                    {/* Существующие группы */}
                    {[...new Set(notes.map(n => n.groupName).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, 'ru')).map(g => (
                      <button type="button" key={g}
                        onClick={() => { handleNoteChange({ groupName: g }); setGroupMenuOpen(false); }}
                        className={`w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-left text-xs cursor-pointer ${selectedNote.groupName === g ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 font-bold' : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'}`}>
                        <Folder className="w-3 h-3 text-emerald-500 shrink-0" />
                        <span className="truncate">{g}</span>
                      </button>
                    ))}
                    {selectedNote.groupName && (
                      <button type="button"
                        onClick={() => { handleNoteChange({ groupName: null }); setGroupMenuOpen(false); }}
                        className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-left text-xs text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/20 cursor-pointer">
                        <X className="w-3 h-3 shrink-0" /> Убрать из группы
                      </button>
                    )}
                    {/* Новая группа */}
                    <div className="flex items-center gap-1.5 pt-1 border-t border-slate-100 dark:border-slate-800">
                      <input
                        value={newGroupName}
                        onChange={e => setNewGroupName(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && newGroupName.trim()) {
                            handleNoteChange({ groupName: newGroupName.trim() });
                            setGroupMenuOpen(false);
                          }
                          if (e.key === 'Escape') setGroupMenuOpen(false);
                        }}
                        placeholder="Новая группа…"
                        className="flex-1 h-7 px-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-300 outline-none focus:border-emerald-400"
                      />
                      <button type="button"
                        onClick={() => { if (newGroupName.trim()) { handleNoteChange({ groupName: newGroupName.trim() }); setGroupMenuOpen(false); } }}
                        className="p-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg cursor-pointer" title="Создать группу и добавить заметку">
                        <FolderPlus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Color Preset Palette */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-semibold text-slate-450 dark:text-slate-400 uppercase tracking-wider mr-1">Палитра:</span>
                {COLORS.map(colorPreset => {
                  const isCurrent = presetOf(selectedNote.color).name === colorPreset.name;
                  return (
                    <button type="button"
                      key={colorPreset.name}
                      onClick={() => handleNoteChange({ color: colorPreset.class })}
                      className={`w-5 h-5 rounded-full border cursor-pointer transition-ui ${colorPreset.btn} ${
                        isCurrent ? 'ring-2 ring-offset-2 ring-emerald-500 dark:ring-offset-slate-950 scale-110' : 'border-transparent opacity-80 hover:opacity-100'
                      }`}
                      title={colorPreset.name}
                    />
                  );
                })}
              </div>

              {/* Big Otkrepit button */}
              <button type="button"
                onClick={(e) => handleOpenSticker(e, selectedNote.id)}
                className="px-3 py-1.5 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 border border-slate-200 dark:border-slate-700 hover:border-slate-350 rounded-lg text-xs text-slate-700 dark:text-slate-300 font-semibold cursor-pointer flex items-center gap-1.5 transition-ui shadow-inner"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>Открепить стикер</span>
              </button>
            </div>

            {/* Note title editable header */}
            <div className="px-6 pt-5 pb-2">
              <input
                type="text"
                placeholder="Заголовок заметки"
                value={selectedNote.title}
                onChange={(e) => handleNoteChange({ title: e.target.value })}
                className="w-full text-slate-900 dark:text-white text-xl font-bold border-none outline-none focus:outline-none placeholder-slate-300 dark:placeholder-slate-700 bg-transparent"
              />
              <div className="w-full h-[1px] bg-slate-200 dark:bg-slate-800 mt-2" />
            </div>

            {/* WYSIWYG Editor wrapper */}
            <div className="flex-1 min-w-0 px-6 pb-6 overflow-y-auto">
              <RichTextEditor
                value={selectedNote.content}
                onChange={(html) => handleNoteChange({ content: html })}
                className="h-full border-none shadow-none bg-transparent"
                projectTags={projectTags}
                projectId={activeProject?.id}
                userName={user?.name || user?.symbol || ''}
                onTagNavigate={(tagId) => { if (tagId) navigate(`/registry?focus=${encodeURIComponent(tagId)}`); }}
              />
            </div>
          </div>
        ) : (
          <div className="flex-grow flex flex-col items-center justify-center text-slate-400 dark:text-slate-500 p-8 h-full">
            <BookOpen className="w-12 h-12 text-slate-300 dark:text-slate-700 mb-3" />
            <h3 className="text-md font-bold text-slate-800 dark:text-white">Инженерный Блокнот пуст</h3>
            <p className="text-xs text-center max-w-sm mt-1 opacity-75">
              Выберите заметку слева или создайте новую.</p>
            <button type="button"
              onClick={() => handleCreateNote()}
              className="mt-4 px-4 py-2 bg-emerald-700 hover:bg-emerald-600 active:bg-emerald-800 text-white rounded-lg text-xs font-semibold cursor-pointer transition-ui shadow-md hover:shadow-lg flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" />
              <span>Создать первую заметку</span>
            </button>
          </div>
        )}
      </div>

      {shareFor && (
        <NoteShareDialog
          note={shareFor}
          onClose={() => setShareFor(null)}
          onSaved={() => loadNotes(shareFor.id)}
        />
      )}
    </motion.div>
  );
}
