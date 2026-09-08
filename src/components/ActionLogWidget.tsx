import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useLogStore, LogItem } from '../store/logStore';
import { FRAME_H } from '../lib/metrics';
import { useToastStore } from '../store/toastStore';
import { useStore } from '../store/store';
import { useChatStore } from '../store/chatStore';
import { 
  Terminal, 
  Copy, 
  Download, 
  X, 
  AlertCircle, 
  Info, 
  AlertTriangle,
  Check,
  Send
} from 'lucide-react';


// Человекочитаемая должность по роли
function roleLabel(role?: string): string {
  switch (role) {
    case 'ADMIN': return 'Администратор';
    case 'MANAGER': return 'Менеджер проектов';
    case 'ENGINEER_VENT': return 'Инженер ОВиК';
    case 'ENGINEER_AUTO': return 'Инженер КИПиА';
    default: return role || '—';
  }
}

export default function ActionLogWidget() {
  const { logs, widgetOpen, setWidgetOpen, clearLogs } = useLogStore();
  const { addToast } = useToastStore();
  const currentUser = useStore((s) => s.user);

  const [filter, setFilter] = useState<'ALL' | 'INFO' | 'WARN' | 'ERROR'>('ALL');
  const [search, setSearch] = useState('');
  const [copied, setCopied] = useState(false);
  
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom of logs when a new log appears
  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, [logs, widgetOpen, filter, search]);

  // Handle BeforeUnload to trigger Panic Crash Log in Electron
  useEffect(() => {
    const handleBeforeUnload = () => {
      const allLogs = useLogStore.getState().logs;

      // Шапка журнала: кто в программе, версия, время
      const u = (() => { try { return useStore.getState().user; } catch (_) { return null; } })();
      const proj = (() => { try { return useStore.getState().activeProject; } catch (_) { return null; } })();
      const header = [
        '==================== ЖУРНАЛ PDM SYSTEM ====================',
        `Дата выгрузки : ${new Date().toLocaleString('ru-RU')}`,
        `Версия        : 0.20.0`,
        `Пользователь  : ${u?.name || '— (вход не выполнен)'}`,
        `Логин         : ${u?.symbol || '—'}`,
        `Должность     : ${roleLabel(u?.role)}`,
        `Активный проект: ${proj?.name || '—'}`,
        `Записей в журнале: ${allLogs.length}`,
        '===========================================================',
        '',
      ].join('\n');

      const formattedLogsText = header + allLogs
        .map(l => `[${l.timestamp}] [${l.type}] [${l.context}] ${l.message}${l.stack ? `\nStack:\n${l.stack}` : ''}`)
        .join('\n');

      const win = window as any;
      if (win.electron && typeof win.electron.emergencySave === 'function') {
        win.electron.emergencySave(formattedLogsText);
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  const getLogIcon = (type: LogItem['type']) => {
    switch (type) {
      case 'ERROR':
        return <AlertCircle className="w-3.5 h-3.5 text-rose-500 shrink-0" />;
      case 'WARN':
        return <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />;
      case 'INFO':
      default:
        return <Info className="w-3.5 h-3.5 text-slate-400 shrink-0" />;
    }
  };

  const getLogColorClass = (type: LogItem['type']) => {
    switch (type) {
      case 'ERROR':
        return 'text-rose-500 dark:text-rose-400 bg-rose-100/10 border-l-2 border-rose-500';
      case 'WARN':
        return 'text-amber-600 dark:text-amber-400 bg-amber-100/10 border-l-2 border-amber-500';
      case 'INFO':
      default:
        return 'text-slate-700 dark:text-slate-300 border-l-2 border-slate-300 dark:border-slate-700';
    }
  };

  // Filter & Search logs (то, что видно на экране)
  const filteredLogs = logs.filter(log => {
    const matchesFilter = filter === 'ALL' || log.type === filter;
    const matchesSearch = !search ||
      log.context.toLowerCase().includes(search.toLowerCase()) ||
      log.message.toLowerCase().includes(search.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  // Название активной категории для тостов («скопированы только ошибки»)
  const filterLabel = filter === 'ALL' ? '' : filter === 'INFO' ? ' (только инфо)' : filter === 'WARN' ? ' (только предупреждения)' : ' (только ошибки)';

  // Копирование/экспорт/отправка берут ровно то, что отфильтровано на экране:
  // выбрали категорию «Ошибки» — копируются только ошибки, а не весь журнал
  const getFormattedLogs = () => {
    return filteredLogs
      .map(l => `[${l.timestamp}] [${l.type}] [${l.context}] ${l.message}${l.stack ? `\nStack:\n${l.stack}` : ''}`)
      .join('\n');
  };

  const handleCopyLogs = async () => {
    const text = getFormattedLogs();
    if (!text) {
      addToast('Нет записей в выбранной категории', 'info');
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      addToast(`Скопировано записей: ${filteredLogs.length}${filterLabel}`, 'success');
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      addToast('Не удалось скопировать логи', 'error');
    }
  };

  const handleExportLogs = async () => {
    const text = getFormattedLogs();
    if (!text) {
      addToast('Нет записей в выбранной категории', 'info');
      return;
    }

    const win = window as any;
    if (win.electron && typeof win.electron.saveLog === 'function') {
      // Direct Electron Native Dialog Save
      addToast('Открытие системного диалога...', 'info');
      const response = await win.electron.saveLog(text);
      if (response && response.success) {
        addToast(`Лог успешно сохранен: ${response.filePath}`, 'success');
      } else if (response && response.error) {
        addToast(`Ошибка сохранения: ${response.error}`, 'error');
      }
    } else {
      // Browser Fallback (TXT Download)
      try {
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        const dateStr = new Date().toISOString().split('T')[0];
        link.download = `pdm_action_log_${dateStr}.txt`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        addToast('Журнал логов скачан как файл .txt', 'success');
      } catch (err) {
        addToast('Ошибка экспорта логов', 'error');
      }
    }
  };

  const handleSendLogs = async () => {
    const text = getFormattedLogs();
    if (!text) {
      addToast('Нет записей в выбранной категории', 'info');
      return;
    }
    try {
      // Открываем рабочий чат на группе «Ошибки» с уже вставленным текстом логов
      useChatStore.getState().setPending('Ошибки', text);
      setWidgetOpen(false);
      window.location.hash = '#/chat';
      addToast('Логи вставлены в группу «Ошибки» — нажмите «Отправить» в чате.', 'success');
    } catch (err) {
      addToast('Не удалось открыть чат', 'error');
    }
  };

  // Виджет логов — только для авторизованных: на экране входа он перекрывал версию
  if (!currentUser) return null;

  return (
    <div
      id="dx-logs-widget"
      className="fixed z-[9999] flex flex-col items-center pointer-events-none transition-ui duration-300"
      /* Журнал висит под панелькой окна — там же, откуда его теперь открывают.
         Круглая нашлёпка у правого края уехала: она закрывала собой угол
         содержимого и жила отдельно от остального управления программой. */
      style={{ top: FRAME_H + 12, left: 0, right: 0 }}
    >
      
      {/* Mini Window Popover */}
      <AnimatePresence>
        {widgetOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: -12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -12 }}
            transition={{ type: 'spring', damping: 20, stiffness: 250 }}
            className="w-[420px] max-w-[calc(100vw-2rem)] h-[520px] max-h-[calc(100vh-8rem)] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl flex flex-col overflow-hidden pointer-events-auto"
          >
            {/* Header */}
            <div className="px-4 py-3 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-emerald-500" />
                <span className="font-semibold text-sm text-slate-800 dark:text-slate-100">Диагностические логи</span>
                <span className="text-xs text-slate-400 dark:text-slate-500 bg-slate-200/50 dark:bg-slate-800/50 px-1.5 py-0.5 rounded font-mono">
                  {logs.length}
                </span>
              </div>
              <button type="button" 
                onClick={() => setWidgetOpen(false)}
                className="p-1 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-md text-slate-500 dark:text-slate-400 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Quick Filters & Search */}
            <div className="p-3 bg-white dark:bg-slate-900 border-b border-slate-100 dark:border-slate-850 flex flex-col gap-2">
              <div className="flex items-center gap-1.5 text-xs">
                {(['ALL', 'INFO', 'WARN', 'ERROR'] as const).map(f => (
                  <button type="button"
                    key={f}
                    onClick={() => setFilter(f)}
                    className={`px-2 py-1 rounded font-medium transition cursor-pointer ${
                      filter === f 
                        ? 'bg-emerald-550 text-white font-semibold' 
                        : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-750'
                    }`}
                  >
                    {f === 'ALL' ? 'Все' : f === 'INFO' ? 'Инфо' : f === 'WARN' ? 'Предупр.' : 'Ошибки'}
                  </button>
                ))}
              </div>
              <input
                type="text"
                placeholder="Поиск по модулю или тексту..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 font-mono outline-none text-slate-800 dark:text-slate-300 focus:border-emerald-555 transition"
              />
            </div>

            {/* Logs Area */}
            <div 
              ref={scrollContainerRef}
              className="flex-1 overflow-y-auto p-4 bg-slate-50 dark:bg-slate-950 font-mono text-xs leading-relaxed select-text space-y-2 scrollbar-thin"
            >
              {filteredLogs.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-slate-400 dark:text-slate-500 py-12 gap-2 text-center text-xs">
                  <Terminal className="w-8 h-8 opacity-30" />
                  <p>Нет логов для отображения</p>
                </div>
              ) : (
                filteredLogs.map(log => (
                  <div 
                    key={log.id} 
                    className={`p-2 rounded border border-slate-200/40 dark:border-slate-800/40 ${getLogColorClass(log.type)}`}
                  >
                    <div className="flex items-start justify-between gap-1 mb-0.5">
                      <div className="flex items-center gap-1.5">
                        <span className="text-slate-400 dark:text-slate-500 font-bold">[{log.timestamp}]</span>
                        <span className="font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-500/5 dark:bg-emerald-400/10 px-1 rounded">
                          {log.context}
                        </span>
                      </div>
                      {getLogIcon(log.type)}
                    </div>
                    <div className="break-words text-slate-700 dark:text-slate-300 font-medium">
                      {log.message}
                    </div>
                    {log.stack && (
                      <pre className="mt-1.5 p-1.5 bg-rose-200/5 dark:bg-rose-950/20 text-rose-600 dark:text-rose-300 border border-rose-500/10 rounded overflow-x-auto text-xs whitespace-pre-wrap max-h-32">
                        {log.stack}
                      </pre>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* Bottom Actions */}
            <div className="px-3.5 py-3 bg-slate-50 dark:bg-slate-950 border-t border-slate-200 dark:border-slate-800 flex items-center gap-2">
              {/* Действия работают по выбранной категории: фильтр «Ошибки» —
                  копируются/экспортируются/отправляются только ошибки */}
              <button type="button"
                onClick={handleCopyLogs}
                disabled={filteredLogs.length === 0}
                title={filter === 'ALL' ? 'Копировать весь журнал' : `Копировать только категорию «${filter === 'INFO' ? 'Инфо' : filter === 'WARN' ? 'Предупреждения' : 'Ошибки'}»`}
                className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-150 dark:hover:bg-slate-800 disabled:opacity-40 rounded-md cursor-pointer border border-slate-200 dark:border-slate-850 shadow-xs transition font-medium"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                <span>Копировать{filter !== 'ALL' ? ` (${filteredLogs.length})` : ''}</span>
              </button>

              <button type="button"
                onClick={handleExportLogs}
                disabled={filteredLogs.length === 0}
                title={filter === 'ALL' ? 'Экспортировать весь журнал' : 'Экспортировать только выбранную категорию'}
                className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs bg-slate-150 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-40 rounded-md cursor-pointer border border-slate-200 dark:border-slate-800 shadow-xs transition font-semibold"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Экспорт</span>
              </button>

              <button type="button"
                onClick={handleSendLogs}
                disabled={filteredLogs.length === 0}
                title={filter === 'ALL' ? 'Отправить весь журнал в чат' : 'Отправить только выбранную категорию в чат'}
                className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-40 disabled:hover:bg-emerald-600 rounded-md cursor-pointer shadow-xs transition font-semibold border border-transparent"
              >
                <Send className="w-3.5 h-3.5" />
                <span>Отправить</span>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
