import React, { useEffect, useState } from 'react';
import { dataService, SystemChangeLog } from '../services/dataService';
import { useToastStore } from '../store/toastStore';
import { useNavigate } from 'react-router-dom';
import { History, Search, RefreshCw, ArrowRight, User, Database, Layers, FileText } from 'lucide-react';
import { SectionHead, Toolbar, Btn, Input, Select, Empty, Avatar } from '../components/ui';
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

  // Раздел записи — по словам в описании. Цвета у раздела нет: он не говорит
  // «хорошо» или «плохо», и по методологии цвет ему не положен — только значок
  const getLogCategory = (description: string) => {
    const desc = description.toLowerCase();
    if (desc.includes('проект') || desc.includes('project')) return { label: 'Проекты', icon: Layers };
    if (desc.includes('тег') || desc.includes('tag')) return { label: 'Теги', icon: Database };
    if (desc.includes('файл') || desc.includes('чертеж') || desc.includes('документ')) return { label: 'Документы', icon: FileText };
    if (desc.includes('пользователь') || desc.includes('admin') || desc.includes('сотрудник')) return { label: 'Сотрудники', icon: User };
    return { label: 'Система', icon: History };
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

  // Переход виден и так; запись без адреса просто не нажимается. Раньше
  // каждый щелчок сопровождался уведомлением «Переход к разделу…»
  const hasLink = (route: string) => !!route && route !== '#';

  const handleClearFilters = () => {
    setSearchQuery('');
    setSelectedUser(ALL_AUTHORS);
    setSelectedCategory('');
  };
  const filtered = !!searchQuery || selectedUser !== ALL_AUTHORS || !!selectedCategory;

  return (
    <div className="fx-page select-none">
      <SectionHead
        title="Журнал"
        count={`${countOf(logs.length, 'запись')} · ${countOf(uniqueUsers.length, 'сотрудник')}`}
        actions={
          <Btn tone="ghost" onClick={() => fetchAllLogs(true)} disabled={loading} title="Обновить журнал изменений">
            <RefreshCw className={loading ? 'animate-spin' : ''} />Обновить
          </Btn>
        }
      />
      <Toolbar>
        <label className="relative w-72 max-w-full">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
          <Input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Поиск: действие, объект или сотрудник" aria-label="Поиск по журналу" className="pl-7" />
        </label>
        <Select value={selectedUser} onChange={setSelectedUser} aria-label="Сотрудник" className="w-48"
          options={[{ value: ALL_AUTHORS, label: 'Все сотрудники' }, ...uniqueUsers.map(({ key, label }) => ({ value: key, label }))]} />
        <Select value={selectedCategory} onChange={setSelectedCategory} aria-label="Раздел" className="w-40"
          options={[{ value: '', label: 'Все разделы' }, ...['Проекты', 'Теги', 'Документы', 'Сотрудники', 'Система'].map((v) => ({ value: v, label: v }))]} />
        {filtered && <Btn tone="ghost" onClick={handleClearFilters}>Сбросить</Btn>}
        <span className="ml-auto text-xs text-slate-400 whitespace-nowrap" title={logs[0] ? formatAbsoluteDate(logs[0].createdAt) : undefined}>
          {filtered ? `показано ${filteredLogs.length} из ${logs.length}` : logs[0] ? `последняя запись ${formatRelativeTime(logs[0].createdAt)}` : ''}
        </span>
      </Toolbar>
      <div className="fx-page-body">
        {loading && logs.length === 0 ? (
          <Empty title="Загрузка…" />
        ) : filteredLogs.length === 0 ? (
          <Empty title={filtered ? 'Ничего не найдено' : 'Записей пока нет'} text={filtered ? 'Под эти фильтры не подходит ни одна запись.' : 'Здесь появятся действия сотрудников и изменения в проектах.'}>
            {filtered && <Btn onClick={handleClearFilters} className="mt-3">Сбросить фильтры</Btn>}
          </Empty>
        ) : (
          <table className="fx-table">
            <thead>
              <tr><th className="w-36">Когда</th><th className="w-72">Сотрудник</th><th className="w-32">Раздел</th><th>Действие</th><th className="w-10" /></tr>
            </thead>
            <tbody>
              {filteredLogs.map((log) => {
                const cat = getLogCategory(log.description);
                const CatIcon = cat.icon;
                const link = hasLink(log.targetRoute);
                return (
                  <tr key={log.id} className={`flux-lazy-item ${link ? 'cursor-pointer' : ''}`} onClick={link ? () => navigate(log.targetRoute) : undefined} title={formatAbsoluteDate(log.createdAt)}>
                    <td className="text-slate-500 dark:text-slate-400 whitespace-nowrap">{formatRelativeTime(log.createdAt)}</td>
                    <td className="max-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <Avatar name={log.userName} />
                        <span className="truncate">{log.userName}</span>
                        {log.userSymbol && <span className="code text-xs text-slate-400 shrink-0">{log.userSymbol}</span>}
                      </div>
                    </td>
                    <td className="text-slate-500 dark:text-slate-400 whitespace-nowrap"><CatIcon className="inline w-3.5 h-3.5 mr-1.5 -mt-0.5" />{cat.label}</td>
                    <td className="max-w-0"><div className="truncate" title={log.description}>{log.description}</div></td>
                    <td>{link && <div className="fx-row-acts"><ArrowRight className="w-4 h-4 text-slate-400" aria-label="Перейти к объекту" /></div>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
