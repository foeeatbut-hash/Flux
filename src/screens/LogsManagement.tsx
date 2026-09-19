import React, { useEffect, useState } from 'react';
import { dataService, SystemChangeLog } from '../services/dataService';
import { useToastStore } from '../store/toastStore';
import { useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import {
  History, Search, RefreshCw, Clock, ArrowLeft, ArrowRight,
  User, Database, Filter, Calendar, Layers, Shield, FileText,
  AlertTriangle, Trash2
} from 'lucide-react';
import { countOf } from '../lib/plural';
import { authorsOf, authorKey, ALL_AUTHORS } from '../lib/outcomes';

export default function LogsManagement() {
  const navigate = useNavigate();
  const { addToast } = useToastStore();

  const [logs, setLogs] = useState<SystemChangeLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedUser, setSelectedUser] = useState<string>(ALL_AUTHORS);
  const [selectedCategory, setSelectedCategory] = useState('');

  /**
   * Журнал берётся из двух мест и показывается одним списком.
   *
   * События проекта (кто что менял) писались и раньше. К ним добавились
   * действия сотрудников, которые пишет сервер: вход, создание, правка,
   * удаление, выгрузка, публикация, изменение прав. Раньше журнал отвечал на
   * «что изменилось», а на «кто что делал» — нет.
   */
  const fetchAllLogs = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const fetchedLogs = await dataService.getLogs();
      let actions: SystemChangeLog[] = [];
      try {
        const r = await fetch('/api/logs/actions?take=300');
        if (r.ok) {
          const d = await r.json();
          actions = (Array.isArray(d?.actions) ? d.actions : []).map((a: any) => ({
            id: `a:${a.id}`,
            userId: a.userId || '',
            userName: a.userName || 'Сотрудник',
            // Символа у серверного действия нет — и раньше сюда ставилась
            // пустая строка, по которой список авторов схлопывал ВСЕХ в одного
            userSymbol: '',
            description: a.target ? `${a.what} (${String(a.target).slice(0, 8)})` : a.what,
            targetRoute: a.route || '',
            createdAt: a.createdAt,
          }));
        }
      } catch (_) { /* журнал действий может быть недоступен по праву */ }
      const at = (x: any) => new Date(x?.createdAt || 0).getTime() || 0;
      setLogs([...fetchedLogs, ...actions].sort((x, y) => at(y) - at(x)));
      if (silent) {
        addToast('Журнал обновлен', 'success');
      }
    } catch (err: any) {
      console.error('Failed to load system logs:', err);
      addToast('Ошибка при загрузке логов', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAllLogs();
  }, []);

  // Format absolute date
  const formatAbsoluteDate = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleDateString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    } catch (e) {
      return isoString;
    }
  };

  // Format relative time
  const formatRelativeTime = (isoString: string) => {
    try {
      const date = new Date(isoString);
      const diffMs = Date.now() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);

      if (diffMins < 1) return 'только что';
      if (diffMins < 60) return `${diffMins} мин. назад`;
      const diffHours = Math.floor(diffMins / 60);
      if (diffHours < 24) return `${diffHours} ч. назад`;
      return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    } catch (e) {
      return '';
    }
  };

  // Detect category keywords for elegant tags
  const getLogCategory = (description: string) => {
    const desc = description.toLowerCase();
    if (desc.includes('проект') || desc.includes('project')) return { label: 'Проекты', color: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/20 dark:text-blue-400 dark:border-blue-800/80', icon: Layers };
    if (desc.includes('тег') || desc.includes('tag')) return { label: 'Теги', color: 'bg-emerald-50 text-emerald-700 border-emerald-250 dark:bg-emerald-950/20 dark:text-emerald-400 dark:border-emerald-800/80', icon: Database };
    if (desc.includes('файл') || desc.includes('чертеж') || desc.includes('документ')) return { label: 'Документы', color: 'bg-purple-50 text-purple-750 border-purple-200 dark:bg-purple-950/20 dark:text-purple-400 dark:border-purple-800/80', icon: FileText };
    if (desc.includes('пользователь') || desc.includes('admin') || desc.includes('сотрудник')) return { label: 'Сотрудники', color: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/20 dark:text-amber-400 dark:border-amber-800/90', icon: User };
    return { label: 'Система', color: 'bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-900/50 dark:text-slate-350 dark:border-slate-800', icon: History };
  };

  // Extract list of all unique users from current logs for filter selection
  // Авторы — по устойчивому ключу (userId у серверных действий, символ у
  // событий проекта). Раньше ключом был символ, и всем серверным действиям он
  // ставился пустым: в фильтре они сливались в одну запись, счётчик людей
  // занижался, а выбрать такого автора было нельзя вовсе — пустое значение
  // означало «все»
  const uniqueUsers = authorsOf(logs as any);

  // Filter logs based on search + selected filters
  const filteredLogs = logs.filter(log => {
    const matchesSearch = 
      log.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      log.userName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      log.userSymbol.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesUser = selectedUser === ALL_AUTHORS ? true : authorKey(log as any) === selectedUser;

    // Filter by categoric tagging based on keyword mapper
    let matchesCategory = true;
    if (selectedCategory) {
      const category = getLogCategory(log.description).label;
      matchesCategory = category === selectedCategory;
    }

    return matchesSearch && matchesUser && matchesCategory;
  });

  const handleRowClick = (targetRoute: string) => {
    if (targetRoute && targetRoute !== '#') {
      navigate(targetRoute);
      addToast(`Переход к разделу: ${targetRoute}`, 'info');
    } else {
      addToast('Для данной системной записи нет прямой ссылки перехода', 'info');
    }
  };

  const handleClearFilters = () => {
    setSearchQuery('');
    setSelectedUser(ALL_AUTHORS);
    setSelectedCategory('');
    addToast('Фильтры очищены', 'info');
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.99 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.99 }}
      transition={{ duration: 0.2 }}
      className="@container space-y-6 text-slate-800 dark:text-slate-100 font-sans select-none"
    >
      {/* HEADER SECTION */}
      <div className="flex flex-col @[640px]:flex-row @[640px]:items-center @[640px]:justify-between gap-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 shadow-xs relative overflow-hidden">
        <div className="flex items-center gap-3">
          <button type="button"
            onClick={() => navigate('/')}
            className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white rounded-xl transition-ui cursor-pointer border border-slate-200/60 dark:border-slate-800 shrink-0"
            title="Назад на Главный экран"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white flex items-center gap-2">
              <History className="w-5 h-5 text-emerald-600" />
              <span>Журнал системных изменений</span>
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Аудит инженерных действий, модификаций спецификаций и активности в реальном времени
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button type="button"
            onClick={() => fetchAllLogs(true)}
            disabled={loading}
            className="px-3.5 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-xs font-bold rounded-lg border border-slate-200 dark:border-slate-755 transition-ui flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            title="Обновить журнал изменений"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Обновить данные</span>
          </button>
        </div>
      </div>

      {/* QUICK STATUS METRICS */}
      <div className="grid grid-cols-1 @[820px]:grid-cols-3 gap-4">
        <div className="p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-emerald-100/60 dark:bg-emerald-950/40 flex items-center justify-center shrink-0">
            <History className="w-5 h-5 text-emerald-650 dark:text-emerald-400" />
          </div>
          <div>
            <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Всего изменений</h4>
            <p className="text-lg font-bold text-slate-900 dark:text-white mt-0.5">{logs.length}</p>
          </div>
        </div>

        <div className="p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-emerald-100/60 dark:bg-emerald-950/40 flex items-center justify-center shrink-0">
            <User className="w-5 h-5 text-emerald-650 dark:text-emerald-400" />
          </div>
          <div>
            <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Активных инженеров</h4>
            <p className="text-lg font-bold text-slate-900 dark:text-white mt-0.5">{uniqueUsers.length}</p>
          </div>
        </div>

        <div className="p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-amber-100/60 dark:bg-amber-950/40 flex items-center justify-center shrink-0">
            <Clock className="w-5 h-5 text-amber-600 dark:text-amber-400" />
          </div>
          <div>
            <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Последняя запись</h4>
            <p className="text-sm font-bold text-slate-905 dark:text-slate-100 mt-1 truncate max-w-[200px]" title={logs[0] ? formatAbsoluteDate(logs[0].createdAt) : '-'}>
              {logs[0] ? formatRelativeTime(logs[0].createdAt) : 'Записей нет'}
            </p>
          </div>
        </div>
      </div>

      {/* FILTER AND SEARCH CONTROLS */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 shadow-2xs space-y-3.5">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold text-slate-550 dark:text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
            <Filter className="w-3.5 h-3.5" />
            <span>Параметры фильтрации логов</span>
          </h3>
          {(searchQuery || selectedUser !== ALL_AUTHORS || selectedCategory) && (
            <button type="button"
              onClick={handleClearFilters}
              className="text-xs font-bold text-rose-650 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-350 cursor-pointer flex items-center gap-1"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Сбросить настройки</span>
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 @[640px]:grid-cols-3 gap-3">
          {/* SEARCH INPUT */}
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-4 w-4 text-slate-400" />
            </div>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Поиск по описанию или инженеру..."
              className="block w-full pl-9 pr-3 py-2 text-xs border border-slate-205 dark:border-slate-750 bg-slate-50 dark:bg-slate-950/80 rounded-xl focus:outline-none focus:border-emerald-500 text-slate-900 dark:text-white transition-ui shadow-2xs placeholder-slate-400"
            />
          </div>

          {/* USER SELECTION FILTER */}
          <div className="relative">
            <select
              value={selectedUser}
              onChange={(e) => setSelectedUser(e.target.value)}
              className="block w-full px-3 py-2 text-xs border border-slate-205 dark:border-slate-750 bg-slate-50 dark:bg-slate-950/80 rounded-xl focus:outline-none focus:border-emerald-500 text-slate-800 dark:text-white transition-ui shadow-2xs cursor-pointer"
            >
              <option value={ALL_AUTHORS}>Все сотрудники</option>
              {uniqueUsers.map(({ key, label }) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </div>

          {/* CATEGORY SELECTOR */}
          <div className="relative">
            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className="block w-full px-3 py-2 text-xs border border-slate-205 dark:border-slate-750 bg-slate-50 dark:bg-slate-950/80 rounded-xl focus:outline-none focus:border-emerald-500 text-slate-800 dark:text-white transition-ui shadow-2xs cursor-pointer"
            >
              <option value="">Все категории событий</option>
              <option value="Проекты">Проекты</option>
              <option value="Теги">Теги / BIM ККС</option>
              <option value="Документы">Документы и Чертежи</option>
              <option value="Сотрудники">Права и Сотрудники</option>
              <option value="Система">Системные проверки</option>
            </select>
          </div>
        </div>
      </div>

      {/* DETAILED TILES / TABLE LOGS VIEW */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xs overflow-hidden">
        <div className="border-b border-slate-100 dark:border-slate-800/80 px-5 py-4 bg-slate-50/50 dark:bg-slate-900/40 flex items-center justify-between">
          <span className="text-xs font-bold text-slate-700 dark:text-slate-300">
            Отображено: <strong className="font-mono text-emerald-600 font-bold">{filteredLogs.length}</strong> из {countOf(logs.length, 'запись')}
          </span>
          <span className="text-xs text-slate-410 dark:text-slate-500 italic">
            Нажмите на запись для мгновенного сквозного перехода к объекту
          </span>
        </div>

        {loading ? (
          <div className="py-24 text-center">
            <RefreshCw className="w-8 h-8 text-emerald-600 animate-spin mx-auto mb-3" />
            <p className="text-xs text-slate-400 font-medium">Считывание записей базы данных PostgreSQL...</p>
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="py-20 text-center flex flex-col items-center justify-center gap-2">
            <AlertTriangle className="w-10 h-10 text-slate-300 dark:text-slate-700" />
            <h3 className="font-bold text-sm text-slate-700 dark:text-slate-300">Лог-записи не обнаружены</h3>
            <p className="text-xs text-slate-400 max-w-sm leading-relaxed px-4">
              Возможно, заданы слишком строгие фильтры поиска или база данных изменений еще не содержит связанных записей.
            </p>
            {(searchQuery || selectedUser !== ALL_AUTHORS || selectedCategory) && (
              <button type="button"
                onClick={handleClearFilters}
                className="mt-2.5 px-3 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg text-xs font-bold transition-ui border border-slate-200 dark:border-slate-700 cursor-pointer"
              >
                Сбросить фильтры
              </button>
            )}
          </div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800/80">
            {filteredLogs.map((log) => {
              const cat = getLogCategory(log.description);
              const CatIcon = cat.icon;
              return (
                <div
                  key={log.id}
                  onClick={() => handleRowClick(log.targetRoute)}
                  className="flux-lazy-item p-4 hover:bg-slate-50/70 dark:hover:bg-slate-950/20 transition-ui cursor-pointer flex flex-col @[640px]:flex-row @[640px]:items-center justify-between gap-3.5 relative group pl-5 border-l-3 border-transparent hover:border-emerald-600"
                >
                  <div className="flex items-start gap-4">
                    {/* User identifier rounded bubble */}
                    <div className="shrink-0 w-9 h-9 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center font-bold text-xs uppercase text-slate-650 dark:text-slate-300">
                      {log.userSymbol.slice(0, 2)}
                    </div>

                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                        <span className="text-xs font-bold text-slate-800 dark:text-slate-300 font-sans">
                          {log.userName}
                        </span>
                        <span className="text-xs font-mono font-bold bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded-md text-slate-503">
                          ID: {log.userSymbol}
                        </span>
                        
                        {/* Categorised tag label */}
                        <span className={`text-xs px-2 py-0.5 rounded-md font-semibold border flex items-center gap-1 shrink-0 ${cat.color}`}>
                          <CatIcon className="w-3 h-3" />
                          <span>{cat.label}</span>
                        </span>
                      </div>

                      <p className="text-xs text-slate-600 dark:text-slate-350 leading-relaxed font-light">
                        {log.description}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center justify-between @[640px]:justify-end gap-4 shrink-0 mt-2 sm:mt-0 pt-2 sm:pt-0 border-t border-slate-100 sm:border-0 dark:border-slate-800">
                    <div className="text-left @[640px]:text-right space-y-0.5">
                      <div className="text-xs font-bold text-slate-700 dark:text-slate-300 font-mono tracking-tight flex items-center @[640px]:justify-end gap-1.5">
                        <Calendar className="w-3.5 h-3.5 text-slate-400" />
                        <span>{formatAbsoluteDate(log.createdAt)}</span>
                      </div>
                      <div className="text-xs text-slate-400 dark:text-slate-500 font-mono flex items-center @[640px]:justify-end gap-1">
                        <Clock className="w-3 w-3" />
                        <span>({formatRelativeTime(log.createdAt)})</span>
                      </div>
                    </div>

                    {/* Target link shortcut indicator */}
                    <div className="w-7 h-7 rounded-lg bg-slate-50 dark:bg-slate-800/80 group-hover:bg-emerald-50 dark:group-hover:bg-emerald-950/40 flex items-center justify-center transition-ui">
                      <ChevronRightIcon className="w-4 h-4 text-slate-400 group-hover:text-emerald-600 dark:group-hover:text-emerald-400" />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </motion.div>
  );
}

// Inline simple Chevron icon component safely without complex setup
function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg 
      className={className} 
      xmlns="http://www.w3.org/2000/svg" 
      fill="none" 
      viewBox="0 0 24 24" 
      strokeWidth={2} 
      stroke="currentColor"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
    </svg>
  );
}
