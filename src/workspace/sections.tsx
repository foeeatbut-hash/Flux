/**
 * Реестр разделов программы — единый источник правды о том, какой путь какому
 * экрану соответствует. Используется и роутером, и рабочим столом (Workspace),
 * который держит разделы «живыми» (keep-alive) и раскладывает их по панелям.
 *
 * Каждый раздел лениво подгружается (как и раньше), плюс несёт метаданные:
 *  - scroll: 'auto'  — раздел прокручивается сам (стандартный контент)
 *            'fixed' — раздел занимает всю высоту и управляет прокруткой внутри
 *  - pad: нужен ли внешний отступ p-6 (у таблиц/чатов свой лэйаут)
 */
import React, { lazy } from 'react';
import { resolveSectionPath } from '../lib/sectionAliases';
import { Home, FolderKanban, Tag, Fan, BookOpen, Briefcase, FolderOpen, Table2, FileType, NotebookPen, MessagesSquare, Settings, ClipboardList, Users, LifeBuoy, Mail, FileText, MessageCircleQuestion, Languages, Globe, CalendarDays } from 'lucide-react';

const Dashboard = lazy(() => import('../screens/Dashboard'));
const Explorer = lazy(() => import('../screens/Explorer'));
const Registry = lazy(() => import('../screens/Registry'));
const DictionaryEditor = lazy(() => import('../screens/DictionaryEditor'));
const Equipment = lazy(() => import('../screens/Equipment'));
const UsersManagement = lazy(() => import('../screens/UsersManagement'));
const NotesManagement = lazy(() => import('../screens/NotesManagement'));
const ProjectsManagement = lazy(() => import('../screens/ProjectsManagement'));
const ChatManagement = lazy(() => import('../screens/ChatManagement'));
const MailScreen = lazy(() => import('../screens/Mail'));
const LogsManagement = lazy(() => import('../screens/LogsManagement'));
const ProcurementManagement = lazy(() => import('../screens/ProcurementManagement'));
const SettingsScreen = lazy(() => import('../screens/SettingsScreen'));
const ConstructorScreen = lazy(() => import('../screens/ConstructorScreen'));
const Handbook = lazy(() => import('../screens/Handbook'));
const PdfEditor = lazy(() => import('../screens/PdfEditor'));
const AssistantScreen = lazy(() => import('../screens/AssistantScreen'));
const TranslateScreen = lazy(() => import('../screens/TranslateScreen'));
const BrowserScreen = lazy(() => import('../screens/BrowserScreen'));
const CalendarScreen = lazy(() => import('../screens/CalendarScreen'));

/**
 * Область данных раздела — см. src/lib/projectScope.ts.
 *
 *  'project' — раздел показывает данные одного проекта; смена проекта меняет
 *              в нём всё;
 *  'global'  — раздел живёт поверх проектов и от переключения не меняется;
 *  'mixed'   — в разделе есть и то и другое (Главная, Настройки).
 *
 * Поле обязательное. Раздел, не сказавший, к чему он относится, — это ровно та
 * неясность, из-за которой у людей и возникал вопрос «а эти данные чьи?».
 */
export type SectionScope = 'project' | 'global' | 'mixed';

/**
 * Откуда раздел берёт счётчик на нижней панели. Красный кружок означает «надо
 * разобрать», поэтому его нет у разделов, где число — это просто «сколько
 * открыто»: разбирать там нечего.
 */
export type SectionBadge = 'mail' | 'chat';

export interface SectionDef {
  path: string;
  title: string;
  scope: SectionScope;
  scroll: 'auto' | 'fixed';
  pad: boolean;
  adminOnly?: boolean;
  /**
   * Раздел открывается по праву доступа. Без права его нет ни в меню, ни в
   * Пуске, ни по прямому адресу — и отвечает он словами, а не пустотой
   */
  feature?: string;
  /** Значок раздела: тот же в Пуске, в заголовке окна и на панели задач */
  icon?: React.ComponentType<{ className?: string }>;
  /** Стоит на нижней панели всегда, даже когда не запущен */
  pinned?: boolean;
  badge?: SectionBadge;
  /**
   * Можно открыть несколькими окнами.
   *
   * Ставится там, где у раздела есть что открывать по отдельности: две папки
   * Проводника, две ведомости, два чертежа. Незаявленное считается единичным
   * намеренно: второе окно Почты не даёт ничего, кроме двух счётчиков
   * непрочитанного, — а объяснять человеку, почему их два, нечем.
   */
  multi?: boolean;
  /**
   * Какой вид документа раздел показывает по умолчанию — для семьи Flux Office.
   *
   * «Таблица» и «Документ» — разные программы с разными значками и разными
   * кнопками на панели задач, но экран у них один: и книга, и текст лежат в
   * одной таблице базы, и открывает их один и тот же редактор по виду
   * документа. Поле говорит библиотеке, ЧТО показывать и что заводить кнопкой
   * «Создать»; открыть чужой вид из этого окна по-прежнему можно — это
   * умолчание, а не запрет.
   */
  docKind?: 'DOC' | 'TEXT';
  Component: React.LazyExoticComponent<React.ComponentType<any>>;
}

export const SECTIONS: SectionDef[] = [
  { path: '/', title: 'Главная', icon: Home, scope: 'mixed', scroll: 'auto', pad: true, Component: Dashboard },
  { path: '/projects', title: 'Проекты', icon: FolderKanban, scope: 'global', scroll: 'auto', pad: true, Component: ProjectsManagement },
  { path: '/registry', title: 'Теги', icon: Tag, scope: 'project', scroll: 'fixed', pad: true, pinned: true, Component: Registry },
  { path: '/equipment', title: 'Оборудование', icon: Fan, scope: 'project', scroll: 'auto', pad: true, pinned: true, Component: Equipment },
  { path: '/directory', title: 'Справочник', icon: BookOpen, scope: 'project', scroll: 'fixed', pad: true, Component: DictionaryEditor },
  { path: '/management', title: 'Менеджмент', icon: Briefcase, scope: 'project', scroll: 'auto', pad: true, Component: ProcurementManagement },
  { path: '/explorer', title: 'Проводник', icon: FolderOpen, scope: 'global', scroll: 'auto', pad: true, pinned: true, multi: true, Component: Explorer },
  // Flux Office — семья редакторов, устроенная как офисный пакет: у каждого
  // вида документа своя программа со своим значком и своим именем в одно
  // слово. Раньше и книга, и текст, и шаблон титула звались «Конструктором» —
  // словом из инженерной жизни, которое не говорит, что программа делает.
  { path: '/sheet', title: 'Таблица', icon: Table2, scope: 'project', scroll: 'auto', pad: true, pinned: true, multi: true, docKind: 'DOC', Component: ConstructorScreen },
  { path: '/doc', title: 'Документ', icon: FileType, scope: 'project', scroll: 'auto', pad: true, multi: true, docKind: 'TEXT', Component: ConstructorScreen },
  // «Просмотр» открывается из Проводника и живёт своим окном: у него своя лента и
  // свои пометки, и возвращаться из него надо туда, откуда пришли
  { path: '/pdf', title: 'Просмотр', icon: FileText, scope: 'project', scroll: 'fixed', pad: false, multi: true, Component: PdfEditor },
  // Помощник — такая же программа: окно, кнопка на панели задач, место на
  // столе. Спросить на секунду по-прежнему можно панелью (Ctrl+K), но
  // разговаривать про открытую ведомость удобнее рядом с ней, а не поверх
  { path: '/assistant', title: 'Помощник', icon: MessageCircleQuestion, scope: 'project', scroll: 'fixed', pad: false, Component: AssistantScreen },
  // Переводчик — программа с окном по той же причине, что и помощник: перевод
  // идёт рядом с ведомостью, а не поверх неё. Область проектная: словарь и
  // память принадлежат проекту, у соседнего заказчика свои названия
  { path: '/translate', title: 'Переводчик', icon: Languages, scope: 'project', scroll: 'fixed', pad: false, Component: TranslateScreen },
  // Браузер — программа с окном и вкладками. Область общая: закладки живут
  // по проекту, но сам браузер от проекта не зависит, и переключение проекта
  // не должно закрывать открытую страницу
  { path: '/browser', title: 'Браузер', icon: Globe, scope: 'global', scroll: 'fixed', pad: false, Component: BrowserScreen },
  // Календарь — общий: события живут по проектам, но человек смотрит в него
  // как в свой день целиком, а не как в часть проекта
  { path: '/calendar', title: 'Календарь', icon: CalendarDays, scope: 'global', scroll: 'fixed', pad: false, Component: CalendarScreen },
  { path: '/notes', title: 'Блокнот', icon: NotebookPen, scope: 'global', scroll: 'auto', pad: true, multi: true, Component: NotesManagement },
  { path: '/chat', title: 'Мессенджер', icon: MessagesSquare, scope: 'global', scroll: 'fixed', pad: true, badge: 'chat', Component: ChatManagement },
  // Почта занимает всю высоту и прокручивает списки внутри — как Чат и Теги
  { path: '/mail', title: 'Почта', icon: Mail, scope: 'global', scroll: 'fixed', pad: true, pinned: true, badge: 'mail', Component: MailScreen },
  { path: '/settings', title: 'Настройки', icon: Settings, scope: 'mixed', scroll: 'auto', pad: true, Component: SettingsScreen },
  { path: '/handbook', title: 'Руководство', icon: LifeBuoy, scope: 'global', scroll: 'fixed', pad: true, Component: Handbook },
  { path: '/logs', title: 'Журнал', icon: ClipboardList, scope: 'global', scroll: 'auto', pad: true, feature: 'log.view', Component: LogsManagement },
  { path: '/users', title: 'Сотрудники', icon: Users, scope: 'global', scroll: 'auto', pad: true, adminOnly: true, Component: UsersManagement },
];

const BY_PATH = new Map(SECTIONS.map((s) => [s.path, s]));

// Раздел по пути ('/registry' и т.п.); неизвестный путь → Главная
export function sectionForPath(pathname: string): SectionDef {
  return BY_PATH.get(resolveSectionPath(pathname)) || SECTIONS[0];
}

export function isKnownSection(pathname: string): boolean {
  return BY_PATH.has(resolveSectionPath(pathname));
}

/** Область данных раздела; неизвестный путь считаем общим. */
export function scopeForPath(pathname: string): SectionScope {
  return BY_PATH.get(resolveSectionPath(pathname))?.scope || 'global';
}
