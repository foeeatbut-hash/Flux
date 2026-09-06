/**
 * Главный экран — то, что видит человек, войдя в программу.
 *
 * Задача экрана: за один взгляд ответить на три вопроса — «где я
 * остановился», «что изменилось без меня», «куда идти дальше» — и дать одно
 * поле, из которого можно попасть куда угодно. Всё, что на эти вопросы не
 * отвечает, с экрана убрано: раньше половину занимали двенадцать одинаковых
 * плиток разделов и декоративная подложка во весь блок.
 *
 * Порядок разделов не выдуман: он считается по тому, чем пользователь
 * действительно пользуется (счётчик открытий хранится локально).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/store';
import { useToastStore } from '../store/toastStore';
import ProjectFormModal from '../components/ProjectFormModal';
import { dataService, UserNote, SystemChangeLog, Project, ProjectInput } from '../services/dataService';
import { useInsightStore } from '../store/insightStore';
import { fetchCheck, fetchSearch, type SearchHit } from '../lib/insight';
import { rememberSectionUse, sectionUses, recentSections } from '../store/workspaceStore';
import { useWindowStore } from '../store/windowStore';
import { useShareStore } from '../store/shareStore';
import { useNotificationStore } from '../store/notificationStore';
import { SECTIONS } from '../workspace/sections';
import { countOf } from '../lib/plural';
import { motion } from 'motion/react';
import SeasonalBackdrop from '../components/SeasonalBackdrop';
import { splitFullName } from '../lib/declension';
import {
  Search, History, ExternalLink, ArrowRight, Plus, Check,
  FolderKanban, NotebookPen, CornerDownLeft, X, Clock,
  AlertTriangle, CalendarClock, MessageSquareWarning, Bell, Cake, ShieldCheck,
} from 'lucide-react';

type Attention = {
  overdue: number;
  soon: number;
  remarks: number;
  items: { id: string; kind: string; code: string; title: string; revision: string; dueDate: string | null }[];
};

type Hit = {
  kind: 'section' | 'project' | 'note' | 'tag' | 'element' | 'doc' | 'file' | 'vdr';
  id: string;
  title: string;
  hint?: string;
  open: () => void;
};

const KIND_LABEL: Record<Hit['kind'], string> = {
  section: 'Раздел',
  project: 'Проект',
  note: 'Заметка',
  tag: 'Тег',
  element: 'Элемент',
  doc: 'Документ',
  file: 'Файл',
  vdr: 'ВДР',
};

export default function Dashboard() {
  const { user, activeProject, setActiveProject } = useStore();
  const { addToast } = useToastStore();
  // Разделы открываются окнами: панелей больше нет
  const open = (path: string) => { rememberSectionUse(path); useWindowStore.getState().open(path); };
  const setFocusTarget = useShareStore((s) => s.setFocusTarget);

  // Открыть найденный тег не «где-то в реестре», а прямо на нём: раздел
  // «Теги» сам центрирует холст на карточке с такой меткой.
  const openTag = (tagId: string, identifier: string) => {
    setFocusTarget({ r: '/registry', f: `tag:${tagId}`, l: identifier, ty: 'el' });
    open('/registry');
  };

  const [logs, setLogs] = useState<SystemChangeLog[]>([]);
  const [notes, setNotes] = useState<UserNote[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [attention, setAttention] = useState<Attention | null>(null);
  const chatUnread = useNotificationStore((s) => s.chatUnread);
  const unreadNotifications = useNotificationStore((s) => s.unread);
  const { openCheck, openChanges, setCheckCounts } = useInsightStore();
  const checkTotal = useInsightStore((s) => s.checkTotal);
  const checkCritical = useInsightStore((s) => s.checkCritical);

  // ── Данные экрана ──────────────────────────────────────────────────────────
  const load = async () => {
    setLoading(true);
    const [l, n, p] = await Promise.allSettled([
      dataService.getLogs(),
      dataService.getNotes(),
      dataService.getProjects(),
    ]);
    if (l.status === 'fulfilled') setLogs((l.value || []).slice(0, 9));
    if (n.status === 'fulfilled') setNotes((n.value || []).slice(0, 6));
    if (p.status === 'fulfilled') setProjects(p.value || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  // Сводка «требует внимания» по документам проекта — одним запросом.
  useEffect(() => {
    let alive = true;
    if (!activeProject?.id) { setAttention(null); return; }
    fetch(`/api/vdr/attention?projectId=${activeProject.id}&userId=${user?.id || ''}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d && !d.error) setAttention(d as Attention); })
      .catch(() => {});
    return () => { alive = false; };
  }, [activeProject?.id, user?.id]);

  // Замечания по проекту считаем при входе: цифра в «Требует внимания» —
  // единственное место, где о них узнают, не открывая проверку специально
  useEffect(() => {
    let alive = true;
    if (!activeProject?.id) { setCheckCounts(0, 0); return; }
    fetchCheck(activeProject.id).then((r) => { if (alive) setCheckCounts(r.total, r.critical); });
    return () => { alive = false; };
  }, [activeProject?.id]);

  // Состав открытых окон: меняется при любом открытии раздела. Главный экран
  // остаётся смонтированным, поэтому списки пересобираем по нему — иначе
  // они показывали бы то, что было при первом входе.
  const openWindows = useWindowStore((s) => s.windows);

  // ── Разделы: порядок по частоте использования ──────────────────────────────
  const sections = useMemo(() => {
    const uses = sectionUses();
    const list = SECTIONS
      .filter((s) => s.path !== '/' && s.path !== '/logs')
      .filter((s) => !s.adminOnly || user?.role === 'ADMIN');
    return [...list].sort((a, b) => (uses[b.path] || 0) - (uses[a.path] || 0));
  }, [user?.role, loading, openWindows]);

  const recent = useMemo(() => {
    return recentSections()
      .map((path) => SECTIONS.find((s) => s.path === path))
      .filter((s): s is (typeof SECTIONS)[number] => !!s && s.path !== '/')
      .slice(0, 4);
  }, [loading, openWindows]);

  // ── Поиск по всему сразу ───────────────────────────────────────────────────
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [tags, setTags] = useState<any[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Теги подтягиваем при первом обращении к поиску, а не при входе:
  // на большом проекте их тысячи, и грузить их «на всякий случай» незачем.
  const ensureTags = async () => {
    if (tags !== null || !activeProject) return;
    try {
      const data = await dataService.getTags(activeProject.id);
      setTags(data.tags || []);
    } catch (_) {
      setTags([]);
    }
  };

  // Оборудование, документы, файлы и ВДР ищет сервер: их списки на главном
  // экране не лежат, и искать по ним локально не из чего. Запрос уходит с
  // задержкой — иначе он уходил бы на каждое нажатие клавиши.
  const [remote, setRemote] = useState<SearchHit[]>([]);
  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) { setRemote([]); return; }
    const t = setTimeout(() => {
      fetchSearch(text, activeProject?.id).then(setRemote).catch(() => setRemote([]));
    }, 220);
    return () => clearTimeout(t);
  }, [query, activeProject?.id]);

  const hits = useMemo<Hit[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: Hit[] = [];
    for (const s of sections) {
      if (s.title.toLowerCase().includes(q)) {
        out.push({ kind: 'section', id: s.path, title: s.title, open: () => open(s.path) });
      }
    }
    for (const p of projects) {
      if ((p.name || '').toLowerCase().includes(q)) {
        out.push({
          kind: 'project', id: p.id, title: p.name,
          hint: activeProject?.id === p.id ? 'уже активный' : 'сделать активным',
          open: () => { setActiveProject(p as any); addToast(`Проект «${p.name}» активен`, 'success'); },
        });
      }
    }
    for (const n of notes) {
      if ((n.title || '').toLowerCase().includes(q)) {
        out.push({ kind: 'note', id: n.id, title: n.title || 'Без названия', open: () => open('/notes') });
      }
    }
    for (const t of tags || []) {
      if (out.length > 20) break;
      const ident = (t.identifier || '').toLowerCase();
      const brand = (t.brand || '').toLowerCase();
      if (ident.includes(q) || brand.includes(q)) {
        out.push({ kind: 'tag', id: t.id, title: t.identifier, hint: t.brand || undefined, open: () => openTag(t.id, t.identifier) });
      }
    }
    // Виды, которых на главном экране нет: их приносит сервер. Теги, заметки,
    // проекты и разделы уже найдены выше — второй раз не показываем.
    for (const h of remote) {
      if (!['element', 'doc', 'file', 'vdr'].includes(h.kind)) continue;
      out.push({ kind: h.kind as any, id: h.id, title: h.title, hint: h.subtitle, open: () => open(h.route) });
    }
    return out.slice(0, 10);
  }, [query, sections, projects, notes, tags, remote, activeProject?.id]);

  useEffect(() => { setCursor(0); }, [query]);

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, Math.max(0, hits.length - 1))); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const h = hits[cursor]; if (h) { h.open(); setQuery(''); } }
    else if (e.key === 'Escape') { setQuery(''); (e.target as HTMLInputElement).blur(); }
  };

  // Курсор сразу в поиске: главный экран — это и есть точка входа, откуда
  // человек идёт дальше. Сочетание Ctrl+K не занимаем — оно открывает строку
  // оболочки «Спросить или найти» из любого места программы.
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 120);
    return () => clearTimeout(t);
  }, []);

  // Любая буква, набранная на главном экране, попадает в поиск —
  // не нужно целиться мышью в поле.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || (t as any).isContentEditable);
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.length === 1 && /[\p{L}\p{N}-]/u.test(e.key)) {
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── Мелочи оформления ──────────────────────────────────────────────────────
  const relTime = (iso: string) => {
    try {
      const d = new Date(iso);
      const mins = Math.floor((Date.now() - d.getTime()) / 60000);
      if (mins < 1) return 'только что';
      if (mins < 60) return `${mins} мин назад`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours} ч назад`;
      return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    } catch (_) { return ''; }
  };

  const today = new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });

  // Обращаемся по имени, а не по строке «Фамилия Имя Отчество»: программой
  // пользуется живой человек, и «С возвращением, Раупов Хусрав Хусравович»
  // звучит как повестка.
  const greetName = useMemo(() => {
    const u: any = user || {};
    const first = String(u.firstName || '').trim();
    if (first) return first;
    const parsed = splitFullName(String(u.name || ''));
    return parsed.firstName || parsed.lastName || 'Инженер';
  }, [user]);

  // День рождения: сравниваем день и месяц, год не важен
  const isBirthday = useMemo(() => {
    const raw = (user as any)?.birthDate;
    if (!raw) return false;
    const b = new Date(raw);
    if (isNaN(b.getTime())) return false;
    const n = new Date();
    return b.getDate() === n.getDate() && b.getMonth() === n.getMonth();
  }, [user]);

  // Фон можно выключить: на слабой машине и в режиме сосредоточенной работы
  // движение за плитками мешает.
  const [backdropOn, setBackdropOn] = useState<boolean>(() => {
    try { return localStorage.getItem('flux_backdrop') !== '0'; } catch { return true; }
  });
  useEffect(() => {
    const onChange = () => {
      try { setBackdropOn(localStorage.getItem('flux_backdrop') !== '0'); } catch (_) {}
    };
    window.addEventListener('flux:backdrop-changed', onChange);
    return () => window.removeEventListener('flux:backdrop-changed', onChange);
  }, []);

  const openSticker = (e: React.MouseEvent, noteId: string) => {
    e.stopPropagation();
    const win = window as any;
    if (win.electron?.ipcRenderer) {
      win.electron.ipcRenderer.send('window:open-sticker', noteId);
      addToast('Заметка откреплена поверх окон', 'success');
    } else {
      window.open(`/#/sticker?id=${noteId}`, `sticker-${noteId}`, 'width=320,height=380,menubar=no,status=no,toolbar=no,resizable=yes');
    }
  };

  const createProject = async (data: ProjectInput) => {
    try {
      const proj = await dataService.createProject(data, user?.id);
      setShowCreate(false);
      addToast('Проект создан', 'success');
      await dataService.createLog({
        userName: user?.name || '',
        userSymbol: user?.symbol || '',
        description: `Создан новый инженерный проект: ${proj.name}`,
        targetRoute: '/projects',
      });
      setProjects(await dataService.getProjects());
    } catch (err: any) {
      addToast(err.message || 'Не удалось создать проект', 'error');
    }
  };

  return (
    <>
      {/* Фон под плитками: время года и время суток, в день рождения — праздник */}
      {backdropOn && (
        <>
          <SeasonalBackdrop birthday={isBirthday} className="absolute inset-0 z-0" />
          {/* Дымка поверх неба. Без неё небо спорит с текстом: заголовок и
              мелкие подписи ложатся прямо на градиент и теряют контраст. */}
          <div aria-hidden className="absolute inset-0 z-0 pointer-events-none
            bg-gradient-to-b from-white/55 via-white/25 to-white/65
            dark:from-dark-bg/60 dark:via-dark-bg/30 dark:to-dark-bg/70" />
        </>
      )}
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="relative z-10 max-w-[1600px] mx-auto min-h-full flex flex-col gap-5 text-slate-800 dark:text-dark-text-main"
    >
      {/* ── Шапка: над чем работаем ──
           Раньше первой строкой стояло крупное «С возвращением, имя», а
           название проекта пряталось мелким шрифтом под ним. Приветствие
           инженеру ничего не сообщает, а проект определяет всё, что он
           увидит дальше в любом разделе. Поменяли местами и оформили
           штампом: слева графа с проектом, справа — дата и шифр. */}
      <header className="flux-surface rounded-sm">
        <div className="flex items-baseline gap-3 px-4 py-2 rule-b">
          <span className="graf">{isBirthday ? 'С днём рождения' : 'Смена'}</span>
          <span className="text-[13px] text-slate-600 dark:text-dark-text-muted flex items-center gap-1.5">
            {isBirthday && <Cake className="w-3.5 h-3.5 text-rose-500 shrink-0" />}
            {greetName}
          </span>
          <span className="ml-auto data text-2xs text-slate-400 first-letter:uppercase">{today}</span>
        </div>
        <div className="px-4 py-3">
          <div className="graf mb-1">Проект</div>
          {activeProject ? (
            <>
              <h1 className="text-[22px] leading-[1.15] font-semibold tracking-[-0.02em] text-slate-900 dark:text-white truncate">
                {activeProject.name}
              </h1>
              <div className="mt-1 data text-2xs text-slate-400 truncate">шифр {activeProject.id}</div>
            </>
          ) : (
            <>
              <h1 className="text-[22px] leading-[1.15] font-semibold tracking-[-0.02em] text-slate-400">
                Проект не выбран
              </h1>
              <button type="button" onClick={() => open('/projects')}
                className="mt-1 -mx-1 px-1 min-h-6 inline-flex items-center text-[13px] font-medium text-emerald-700 dark:text-emerald-400 hover:underline cursor-pointer">
                Выбрать проект
              </button>
            </>
          )}
        </div>
      </header>

      {/* ── Поиск: одна дверь во всё ── */}
      <div className="relative">
        <div className="flex items-center gap-3 px-4 h-12 rounded-lg flux-surface transition-ui
                        focus-within:border-emerald-600/60 dark:focus-within:border-emerald-400/60
                        focus-within:shadow-[0_0_0_4px_color-mix(in_oklab,var(--color-emerald-500)_18%,transparent)]">
          <Search className="w-[18px] h-[18px] text-slate-400 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={ensureTags}
            onKeyDown={onSearchKey}
            placeholder={activeProject ? 'Найти тег, заметку, проект или раздел' : 'Найти заметку, проект или раздел'}
            aria-label="Поиск по программе"
            className="flux-focus-outer flex-1 bg-transparent outline-none text-[15px] placeholder:text-slate-400 placeholder:font-normal"
          />
          {query ? (
            <button type="button" onClick={() => { setQuery(''); inputRef.current?.focus(); }} aria-label="Очистить поиск"
              className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          ) : (
            <span className="hidden @[700px]:inline text-2xs text-slate-400 shrink-0">
              просто начните печатать · <span className="font-mono">Ctrl+Shift+F</span> — искать везде
            </span>
          )}
        </div>

        {/* Список результатов непрозрачный: сквозь стекло просвечивали плитки
            под ним, и читать найденное было невозможно. */}
        {query.trim() && (
          <div role="listbox" aria-label="Результаты поиска"
            className="absolute z-30 left-0 right-0 mt-1.5 rounded-lg flux-surface bg-white dark:bg-dark-panel shadow-xl overflow-hidden">
            {hits.length === 0 ? (
              <p className="px-3.5 py-3 text-xs text-slate-500 dark:text-dark-text-muted">
                Ничего не нашлось. Попробуйте код тега, название заметки или раздела.
              </p>
            ) : hits.map((h, i) => (
              <button
                key={`${h.kind}-${h.id}`}
                type="button"
                role="option"
                aria-selected={i === cursor}
                onMouseEnter={() => setCursor(i)}
                onClick={() => { h.open(); setQuery(''); }}
                className={`w-full flex items-center gap-3 px-3.5 py-2 text-left cursor-pointer ${
                  i === cursor ? 'bg-emerald-50 dark:bg-emerald-950/40' : ''
                }`}
              >
                <span className="text-2xs font-mono uppercase tracking-wider text-slate-400 w-14 shrink-0">{KIND_LABEL[h.kind]}</span>
                <span className="text-sm font-medium truncate flex-1">{h.title}</span>
                {h.hint && <span className="text-xs text-slate-400 truncate max-w-[30%]">{h.hint}</span>}
                {i === cursor && <CornerDownLeft className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Требует внимания: показывается, только если есть о чём сказать ── */}
      {(() => {
        const rows: { key: string; tone: 'crit' | 'warn' | 'info'; icon: any; text: string; action: string; go: () => void }[] = [];
        // Проверка проекта — первой строкой: это единственное место, где
        // замечания попадаются на глаза сами, без похода в панель
        if (checkTotal) rows.push({
          key: 'check', tone: checkCritical ? 'crit' : 'warn', icon: ShieldCheck,
          text: checkCritical
            ? `Проверка проекта: ${countOf(checkCritical, 'важное замечание')} из ${checkTotal}`
            : `Проверка проекта: ${countOf(checkTotal, 'замечание')}`,
          action: 'Разобрать', go: openCheck,
        });
        if (attention?.overdue) rows.push({
          key: 'overdue', tone: 'crit', icon: AlertTriangle,
          text: `Просрочен срок: ${countOf(attention.overdue, 'документ')}`,
          action: 'Открыть ВДР', go: () => open('/management'),
        });
        if (attention?.remarks) rows.push({
          key: 'remarks', tone: 'crit', icon: MessageSquareWarning,
          text: `Замечания на вас: ${countOf(attention.remarks, 'документ')}`,
          action: 'Посмотреть', go: () => open('/management'),
        });
        if (attention?.soon) rows.push({
          key: 'soon', tone: 'warn', icon: CalendarClock,
          text: `Срок в ближайшую неделю: ${countOf(attention.soon, 'документ')}`,
          action: 'Открыть ВДР', go: () => open('/management'),
        });
        if (chatUnread) rows.push({
          key: 'chat', tone: 'info', icon: MessageSquareWarning,
          text: `Новые сообщения: ${countOf(chatUnread, 'диалог')}`,
          action: 'Открыть чат', go: () => open('/chat'),
        });
        if (unreadNotifications && !chatUnread) rows.push({
          key: 'notif', tone: 'info', icon: Bell,
          text: `Непрочитанные уведомления: ${unreadNotifications}`,
          action: 'Показать', go: () => open('/logs'),
        });
        if (!rows.length) return null;

        // Тон задаёт цветная полоса слева и лёгкая подсветка, а не сплошная
        // заливка во всю строку: срочное видно сразу, но экран не пестрит.
        const tones: Record<string, string> = {
          crit: 'before:bg-rose-500 bg-rose-50/70 dark:bg-rose-950/25 text-rose-900 dark:text-rose-200',
          warn: 'before:bg-amber-500 bg-amber-50/70 dark:bg-amber-950/25 text-amber-900 dark:text-amber-200',
          info: 'before:bg-emerald-500 text-slate-700 dark:text-dark-text-main',
        };
        const toneIcon: Record<string, string> = {
          crit: 'text-rose-600 dark:text-rose-400',
          warn: 'text-amber-600 dark:text-amber-400',
          info: 'text-emerald-700 dark:text-emerald-400',
        };
        return (
          <section aria-label="Требует внимания">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.13em] text-slate-500 dark:text-slate-400 mb-2 select-none">Требует внимания</h2>
            <div className="flex flex-col gap-1.5">
              {rows.map((r) => {
                const Icon = r.icon;
                return (
                  <div key={r.key}
                    className={`relative flex items-center gap-3 pl-4 pr-3 py-2.5 rounded-xl flux-surface overflow-hidden
                                before:content-[''] before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1 ${tones[r.tone]}`}>
                    <Icon className={`w-[18px] h-[18px] shrink-0 ${toneIcon[r.tone]}`} />
                    <span className="text-[14px] font-semibold flex-1 min-w-0 truncate">{r.text}</span>
                    <button type="button" onClick={r.go}
                      className="text-xs font-bold px-2 py-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer shrink-0 transition-ui">
                      {r.action} →
                    </button>
                  </div>
                );
              })}
              {!!attention?.items?.length && (
                <ul className="mt-0.5 flex flex-col gap-0.5 pl-1">
                  {attention.items.slice(0, 4).map((it) => (
                    <li key={it.id}>
                      <button type="button" onClick={() => open('/management')}
                        className="w-full text-left text-xs text-slate-500 dark:text-dark-text-muted hover:text-slate-800 dark:hover:text-white cursor-pointer truncate">
                        <span className="font-mono font-semibold">{it.code || '—'}</span>
                        <span className="mx-1.5">·</span>
                        {it.title || 'Без наименования'}
                        {it.dueDate && (
                          <span className={`ml-1.5 ${it.kind === 'overdue' ? 'text-rose-600 dark:text-rose-400 font-semibold' : 'text-slate-400'}`}>
                            {it.kind === 'overdue' ? 'просрочен ' : 'до '}{new Date(it.dueDate).toLocaleDateString('ru-RU')}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        );
      })()}

      {/* ── Продолжить: где человек был в прошлый раз ── */}
      {recent.length > 0 && (
        <section>
          <h2 className="text-[11px] font-bold uppercase tracking-[0.13em] text-slate-500 dark:text-slate-400 mb-2 select-none">Продолжить</h2>
          <div className="grid grid-cols-2 @[700px]:grid-cols-4 gap-2.5">
            {recent.map((s) => {
              const Icon = s.icon as any;
              return (
                <button
                  key={s.path}
                  type="button"
                  onClick={() => open(s.path)}
                  data-share-route={s.path}
                  data-share-label={s.title}
                  className="flex items-center gap-3 px-3 py-3 rounded-xl flux-tile transition-ui cursor-pointer text-left"
                >
                  {Icon && (
                    <span className="w-8 h-8 rounded-lg bg-emerald-600/12 dark:bg-emerald-400/15 flex items-center justify-center shrink-0">
                      <Icon className="w-[18px] h-[18px] text-emerald-700 dark:text-emerald-300" />
                    </span>
                  )}
                  <span className="text-[14px] font-semibold truncate">{s.title}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Разделы: часто используемые впереди ── */}
      <section>
        <h2 className="text-[11px] font-bold uppercase tracking-[0.13em] text-slate-500 dark:text-slate-400 mb-2 select-none">Разделы</h2>
        {/* Ровная сетка вместо переносящихся пилюль: раньше последний раздел
            уезжал на вторую строку в одиночестве и блок выглядел обрывком. */}
        <div className="grid grid-cols-2 @[560px]:grid-cols-3 @[760px]:grid-cols-4 @[1000px]:grid-cols-6 gap-2">
          {sections.map((s) => {
            const Icon = s.icon as any;
            return (
              <button
                key={s.path}
                type="button"
                onClick={() => open(s.path)}
                data-share-route={s.path}
                data-share-label={s.title}
                className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl flux-tile transition-ui cursor-pointer text-left min-w-0"
              >
                {Icon && <Icon className="w-4 h-4 text-slate-500 dark:text-slate-400 shrink-0" />}
                <span className="text-[13px] font-semibold truncate">{s.title}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Три колонки: изменения, заметки, проекты ──
           Колонки одной высоты и по содержимому: раньше они кончались на
           разных уровнях и низ блока выглядел обрывком. Ниже — небо, и это
           лучше, чем растянутая до края пустая карточка. */}
      <div className="grid grid-cols-1 @[900px]:grid-cols-3 gap-3.5 items-stretch pb-1">
        {/* Последние изменения */}
        <section className="rounded-lg flux-surface overflow-hidden flex flex-col min-h-[240px]">
          <CardHead icon={History} title="Последние изменения"
            action={<>
              {/* Журнал говорит «кто-то что-то менял», лист изменений — что
                  именно стало другим. Второе нужнее перед выпуском ревизии. */}
              <CardLink onClick={openChanges}>Что изменилось</CardLink>
              <CardLink onClick={() => open('/logs')}>Все</CardLink>
            </>} />
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin divide-y divide-black/[0.05] dark:divide-white/[0.06]">
            {loading && <p className="px-4 py-5 text-[13px] text-slate-400">Загружаю…</p>}
            {!loading && logs.length === 0 && <CardEmpty>Пока ничего не менялось.</CardEmpty>}
            {logs.map((log) => (
              <button
                key={log.id}
                type="button"
                onClick={() => { const r = (log as any).targetRoute; if (r && r !== '#') open(r); }}
                className="w-full text-left px-4 py-2.5 hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-ui cursor-pointer"
              >
                <p className="text-[13px] leading-snug text-slate-700 dark:text-dark-text-main line-clamp-2">{log.description}</p>
                <p className="mt-1 text-2xs text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                  <Clock className="w-3 h-3 shrink-0" />
                  {relTime((log as any).createdAt)}
                  <span className="truncate">· {(log.userName || '').replace(/\s*\(.*\)$/, '')}</span>
                </p>
              </button>
            ))}
          </div>
        </section>

        {/* Мои заметки */}
        <section className="rounded-lg flux-surface overflow-hidden flex flex-col min-h-[240px]">
          <CardHead icon={NotebookPen} title="Мои заметки"
            action={<CardLink onClick={() => open('/notes')}>Все</CardLink>} />
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin divide-y divide-black/[0.05] dark:divide-white/[0.06]">
            {!loading && notes.length === 0 && (
              <CardEmpty>
                Заметок пока нет.
                <button type="button" onClick={() => open('/notes')}
                  className="mt-2 inline-flex items-center gap-1.5 text-[13px] font-semibold text-emerald-700 dark:text-emerald-400 cursor-pointer hover:underline">
                  <Plus className="w-3.5 h-3.5" /> Создать первую
                </button>
              </CardEmpty>
            )}
            {notes.map((note) => (
              <div key={note.id} className="px-4 py-2.5 hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-ui group">
                <button type="button" onClick={() => open('/notes')} className="w-full text-left cursor-pointer">
                  <p className="text-[13px] font-semibold truncate">{note.title || 'Без названия'}</p>
                  <p className="text-xs leading-snug text-slate-500 dark:text-dark-text-muted line-clamp-2 mt-0.5">
                    {(note.content || '').replace(/<[^>]*>/g, ' ').trim() || 'Заметка не заполнена'}
                  </p>
                </button>
                <button
                  type="button"
                  onClick={(e) => openSticker(e, note.id)}
                  title="Открыть заметку отдельным окном поверх других"
                  className="mt-1.5 inline-flex items-center gap-1 text-2xs font-semibold text-slate-500 hover:text-emerald-700 dark:hover:text-emerald-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-ui cursor-pointer"
                >
                  <ExternalLink className="w-3 h-3" /> На экран
                </button>
              </div>
            ))}
          </div>
        </section>

        {/* Проекты */}
        <section className="rounded-lg flux-surface overflow-hidden flex flex-col min-h-[240px]">
          <CardHead icon={FolderKanban} title="Проекты"
            action={(
              <CardLink onClick={() => setShowCreate(true)}>
                <Plus className="w-3.5 h-3.5" /> Создать
              </CardLink>
            )} />
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin divide-y divide-black/[0.05] dark:divide-white/[0.06]">
            {!loading && projects.length === 0 && (
              <CardEmpty>Проектов пока нет. Создайте первый — без него не работают теги, оборудование и закупки.</CardEmpty>
            )}
            {projects.map((p) => {
              const active = activeProject?.id === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setActiveProject(active ? null : (p as any))}
                  aria-pressed={active}
                  title={active ? 'Снять как активный' : 'Сделать активным'}
                  className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-left transition-ui cursor-pointer ${
                    active ? 'bg-emerald-500/10' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'
                  }`}
                >
                  <Check className={`w-4 h-4 shrink-0 ${active ? 'text-emerald-700 dark:text-emerald-400' : 'opacity-0'}`} />
                  <span className={`text-[13px] truncate flex-1 ${active ? 'font-bold text-emerald-900 dark:text-emerald-200' : 'font-medium'}`}>{p.name}</span>
                  {active && <span className="text-2xs font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 shrink-0">активный</span>}
                </button>
              );
            })}
          </div>
          <button type="button" onClick={() => open('/projects')}
            className="shrink-0 w-full px-4 py-2.5 text-[13px] font-semibold text-slate-600 dark:text-dark-text-muted hover:bg-black/[0.03] dark:hover:bg-white/[0.04] border-t border-black/[0.05] dark:border-white/[0.06] flex items-center justify-center gap-1.5 cursor-pointer transition-ui">
            Управление проектами <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </section>
      </div>

      {showCreate && (
        <ProjectFormModal
          title="Новый проект"
          onClose={() => setShowCreate(false)}
          onSave={createProject}
        />
      )}
    </motion.div>
    </>
  );
}

/** Шапка карточки: значок в мягком квадрате, название и одно действие справа. */
function CardHead({ icon: Icon, title, action }: { icon: any; title: string; action?: React.ReactNode }) {
  return (
    <div className="shrink-0 flex items-center justify-between gap-2 px-4 py-3 border-b border-black/[0.05] dark:border-white/[0.06]">
      <h2 className="text-[14px] font-bold flex items-center gap-2.5 min-w-0">
        <span className="w-7 h-7 rounded-lg bg-emerald-600/12 dark:bg-emerald-400/15 flex items-center justify-center shrink-0">
          <Icon className="w-4 h-4 text-emerald-700 dark:text-emerald-300" />
        </span>
        <span className="truncate">{title}</span>
      </h2>
      {action}
    </div>
  );
}

/** Тихая ссылка-действие в шапке карточки. */
function CardLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-lg
                 text-slate-600 dark:text-dark-text-muted hover:text-emerald-700 dark:hover:text-emerald-400
                 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] cursor-pointer transition-ui">
      {children}
    </button>
  );
}

/** Пустая карточка: подпись по центру свободного места, а не прижатая к шапке. */
function CardEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full min-h-[140px] flex flex-col items-center justify-center text-center px-6 py-6
                    text-[13px] leading-relaxed text-slate-500 dark:text-dark-text-muted">
      {children}
    </div>
  );
}
