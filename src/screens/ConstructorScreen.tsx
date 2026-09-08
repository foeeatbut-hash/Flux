import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRibbonFold } from '../components/ribbon/useRibbonFold';
import { useLocation, useSearchParams } from 'react-router-dom';
import { useStore } from '../store/store';
import { PLACEHOLDERS, placeholderToken, fillSnapshot, countTokens } from '../lib/docPlaceholders';
import LabelBar from '../components/constructor/LabelBar';
import RecentDocsPanel from '../components/office/RecentDocsPanel';
import { rememberDoc } from '../store/recentStore';
import { type ConflictChoice } from '../lib/docConflict';
import { useDocRoom } from '../components/collab/useDocRoom';
import SaveConflictDialog from '../components/SaveConflictDialog';
import DocVersionsPanel from '../components/DocVersionsPanel';
import BlocksPanel from '../components/office/BlocksPanel';
import DataWizard from '../components/DataWizard';
import type { CatalogData, WizardResult } from '../lib/constructorTypes';
import EditorFrame from '../components/ribbon/EditorFrame';
import { useWindowTitle } from '../lib/paneTitle';
import { sheetRibbon, SHEET_TEXT_COLORS, SHEET_FILL_COLORS } from '../lib/ribbonSheet';
import { editorFileMenu } from '../lib/ribbonFile';
import { dataService } from '../services/dataService';
import { useToastStore } from '../store/toastStore';
import * as XLSX from 'xlsx';
import {
  Table2, Plus, ArrowLeft, Loader2, Download, FolderOpen, Copy, Trash2,
  RotateCcw, Lock, Users2, Search, ChevronRight, Database, X, CheckCircle2,
  Boxes, RefreshCw, Unlink, AlertTriangle, Printer, History, FileText, ChevronDown, Braces,
  TriangleAlert
} from 'lucide-react';
import TextDocEditor from './TextDocEditor';
import TitleTemplateEditor from './TitleTemplateEditor';
import TitlePanel, { fetchTitlePageHtml, buildPageTemplates, fetchRevisionsSheetHtml, TitleSettings } from './TitlePanel';
import { Stamp } from 'lucide-react';
import { countOf } from '../lib/plural';
import { useModalStore } from '../store/modalStore';
import EnglishVersion from '../components/translate/EnglishVersion';
import { docFingerprint } from '../translate/docPlan';
import { saveBookToWindows, saveBookToExplorer, bookFromSnapshot } from '../lib/bookExport';
import { waitForSheet } from '../lib/engineReady';
import { useOpenFromFile } from '../components/constructor/useOpenFromFile';
import { officeKindForPath } from '../lib/fileTypes';
import { fmtDate, type DocMeta } from '../lib/officeDocs';
import DocLibrary from '../components/office/DocLibrary';

// Диалоги программы вместо системных окон Windows
const { openConfirm, openPrompt } = useModalStore.getState();

// ── Конструктор: сборка своих таблиц из данных проекта ──
// Дизайн: docs/constructor-design-v0.25*.md. Реализация MVP (Фаза 1):
// Библиотека (мои/общие/корзина), редактор на движке Univer (полноценная
// таблица: формулы, стили, листы), мастер «Собрать данные» (теги/оборудование →
// колонки из каталога → фильтр → вставка), автосейв, именование при закрытии,
// экспорт XLSX (скачать / в Проводник). Живые блоки и совместное
// редактирование — следующие фазы (части II и IV дизайна).


const RECENT_KEY = (userId: string) => `constructor_recent_${userId}`;

function pushRecent(userId: string, docId: string) {
  try {
    const list: string[] = JSON.parse(localStorage.getItem(RECENT_KEY(userId)) || '[]');
    const next = [docId, ...list.filter(id => id !== docId)].slice(0, 10);
    localStorage.setItem(RECENT_KEY(userId), JSON.stringify(next));
  } catch (_) {}
}


// ═══════════════════════ Мастер «Собрать данные» ═══════════════════════

// ── Метка-таблица: вставленный кусок данных помнит свой запрос ──
// В интерфейсе это «метка данных» — то же понятие, что в текстовом документе
// (src/lib/docLabels.ts): и там, и здесь документ помнит, откуда взято, и
// обновляется одной кнопкой. Внутри тип назван SmartBlock по истории кода.
// Упрощение MVP относительно части II дизайна: ручные правки внутри блока
// обнаруживаются при обновлении сравнением с последними записанными
// значениями (а не перехватом команд движка) и сохраняются как overrides;
// строки сверяются по entityKey, конфликты решаются поштучно.
interface SmartBlock {
  id: string;
  name: string;
  sheetId: string;
  anchor: { row: number; col: number };
  headerRows: number;
  query: { entity: 'tag' | 'element'; columns: { path: string; title: string }[]; filters: any[] };
  rows: string[];                                        // entityKeys по порядку строк данных
  lastValues: any[][];                                   // что записали при последнем обновлении
  overrides: Record<string, { value: any; base: any }>;  // "entityKey|colIdx"
  state: { lastRefreshAt: string; fingerprint?: string };
}

interface ConflictItem {
  key: string; row: number; col: number;
  colTitle: string; userValue: any; liveValue: any;
}

const sameCell = (a: any, b: any) => String(a ?? '') === String(b ?? '');


// ═══════════════════════ Редактор (движок Univer) ═══════════════════════

function DocEditor({ docId, onClose, autoRefresh }: { docId: string; onClose: () => void; autoRefresh?: boolean }) {
  const user = useStore(s => s.user);
  const activeProject = useStore(s => s.activeProject);
  const { addToast } = useToastStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const univerRef = useRef<any>(null);       // { univer, univerAPI }
  const lastSavedRef = useRef<string>('');
  const [doc, setDoc] = useState<any>(null);
  /**
   * Время, с которым это окно прочитало документ. Уходит на сервер при каждой
   * записи: разошлось с тем, что там лежит, — значит окно отстало от жизни и
   * пишет старую книгу поверх свежей (см. src/lib/docConflict.ts).
   */
  const baseRef = useRef<string>('');
  const [saveConflict, setSaveConflict] = useState<{ who: string; at: string | null } | null>(null);
  // Пока конфликт не разобран, автосохранение молчит: иначе окно повторяло бы
  // отказ каждые две с половиной секунды
  const saveConflictRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'idle'>('idle');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [nameDialog, setNameDialog] = useState<null | { suggestion: string }>(null);
  const suggestionRef = useRef<string>('');

  // ── Совместное редактирование: комната документа (useDocRoom) ──
  // Кто в файле и где стоит его курсор (как в онлайн-Экселе) плюс рассылка
  // мутаций движка. Эхо гасится флагом fromCollab — родной механизм Univer.
  const applyingRemoteRef = useRef(false);
  const lastSelSentRef = useRef('');
  /**
   * Правил ли этот человек книгу с прошлой записи.
   *
   * Сравнивать снимки для этого нельзя: снимок движка меняется и сам по себе —
   * от применённой чужой операции, от приведения книги к порядку при открытии.
   * Окно, вернувшееся из офлайна, из-за такой разницы объявляло столкновение
   * человеку, который ничего не набирал (поймано scripts/test-collab-live.ts).
   * А вот СВОЮ мутацию окно знает точно: именно её оно и рассылает в комнату.
   */
  const myEditRef = useRef(false);
  const [peerRects, setPeerRects] = useState<{ key: string; name: string; color: string; left: number; top: number; width: number; height: number }[]>([]);

  // ── Метки-таблицы (см. SmartBlock выше) ──
  const bindingsRef = useRef<{ schemaVersion: number; blocks: SmartBlock[] }>({ schemaVersion: 1, blocks: [] });
  const bindingsDirtyRef = useRef(false);
  const [blocksTick, setBlocksTick] = useState(0);          // форс-перерисовка панели блоков
  /**
   * Какая панель пристыкована справа. Одна на все четыре, а не четыре флажка.
   *
   * Флажками они открывались одновременно и наслаивались друг на друга поверх
   * листа. Пристыкованные, они делили бы окно на три полосы, и листу
   * оставалась бы треть. Одно состояние делает это невозможным по устройству,
   * а не по договорённости.
   */
  const [dock, setDock] = useState<'labels' | 'title' | 'versions' | 'blocks' | null>(null);
  const closeDock = () => setDock(null);
  const toggleDock = (p: 'labels' | 'title' | 'versions' | 'blocks') =>
    setDock((cur) => (cur === p ? null : p));
  const blocksOpen = dock === 'blocks';
  // Чтение оформления выделения зовётся из слушателя команд движка, который
  // создаётся раньше самой функции. Держим её в ссылке: слушатель живёт всё
  // время жизни книги, а функция пересоздаётся на каждой отрисовке
  const cellStateFnRef = useRef<() => void>(() => {});
  // Отбор по столбцам: кнопка ленты должна отвечать, включён он или нет,
  // иначе «Фильтр» превращается в кнопку с непредсказуемым действием
  const [filterOn, setFilterOn] = useState(false);
  // История версий: автоснимки перед обновлением данных + ручные + откат
  const versionsOpen = dock === 'versions';
  // Английская версия: снимок на момент открытия сверки и отставшая пара
  const [englishSnap, setEnglishSnap] = useState<any>(null);
  const [stale, setStale] = useState<{ id: string; targetDocId: string } | null>(null);
  // Титул: присвоенный шаблон + реквизиты этого документа (как у Ворда)
  const titleOpen = dock === 'title';
  const [exportOpen, setExportOpen] = useState(false);
  const phOpen = dock === 'labels';
  const [phCount, setPhCount] = useState(0);
  const [titleSettings, setTitleSettings] = useState<TitleSettings>({});
  const [versions, setVersions] = useState<{ id: string; version: number; comment: string; createdAt: string }[]>([]);
  const [reloadTick, setReloadTick] = useState(0); // откат = переинициализация движка
  const [staleMap, setStaleMap] = useState<Record<string, boolean>>({});
  const [refreshingIds, setRefreshingIds] = useState<string[]>([]);
  const [conflicts, setConflicts] = useState<null | { blockId: string; items: ConflictItem[] }>(null);
  const projectIdForData = activeProject?.id || 'default';

  const fetchFingerprint = async (): Promise<Record<string, string> | null> => {
    try {
      const r = await fetch(`/api/constructor/fingerprint?projectId=${projectIdForData}`);
      return r.ok ? await r.json() : null;
    } catch (_) { return null; }
  };

  // Снапшот текущей книги (JSON-строка) — для автосейва и экспорта
  const takeSnapshot = (): string => {
    try {
      const wb = univerRef.current?.univerAPI?.getActiveWorkbook?.();
      const data = wb?.save?.();
      return data ? JSON.stringify(data) : '';
    } catch (_) { return ''; }
  };

  // ═══════════════ Подстановки в шаблонах ═══════════════
  // Шаблон — документ с метками вида {{документ.название}}. Здесь метки
  // заменяются реальными данными. Обходим снимок документа целиком,
  // поэтому одинаково работает и в таблице, и в текстовом документе.
  const placeholderCtx = () => ({
    documentName: doc?.name || '',
    documentNumber: (titleSettings as any)?.docNumber || '',
    revision: (titleSettings as any)?.revision || '',
    projectName: activeProject?.name || '',
    projectCode: (activeProject as any)?.code || '',
    userName: user?.name || '',
    userSymbol: user?.symbol || '',
    userRole: user?.role === 'ADMIN' ? 'Администратор' : 'Инженер',
    now: new Date(),
  });

  // Вставить метку туда, где стоит курсор. Для таблицы это активная
  // ячейка; если движок не отдаёт выделение, кладём метку в буфер обмена,
  // чтобы человек всё равно мог вставить её сам.
  const insertPlaceholder = async (key: string) => {
    const token = placeholderToken(key);
    const api = univerRef.current?.univerAPI;
    // Таблица: метка ложится в активную ячейку.
    try {
      const range = api?.getActiveWorkbook?.()?.getActiveSheet?.()?.getActiveRange?.();
      if (range?.setValue) {
        range.setValue(token);
        addToast(`Метка вставлена: ${token}`, 'success');
        setPhCount(c => c + 1); // счётчик незаполненных обновляем сразу
        void saveNow();
        return;
      }
    } catch (_) { /* ниже — текстовый документ, затем буфер обмена */ }
    // Текстовый документ: метка встаёт туда, где стоит курсор. Без этого
    // в Word-режиме лента работала только через буфер обмена.
    try {
      const activeDoc = api?.getActiveDocument?.();
      if (activeDoc?.insertText) {
        const ok = await activeDoc.insertText(token);
        if (ok) {
          addToast(`Метка вставлена: ${token}`, 'success');
          setPhCount(c => c + 1);
          void saveNow();
          return;
        }
      }
    } catch (_) { /* остаётся буфер обмена */ }
    navigator.clipboard?.writeText(token).then(
      () => addToast(`Метка ${token} скопирована — вставьте в нужное место (Ctrl+V)`, 'info'),
      () => addToast(`Впишите вручную: ${token}`, 'info'),
    );
  };

  // Пересчитываем метки при открытии ленты: человек должен видеть, есть
  // ли в документе что заполнять, до нажатия кнопки.
  useEffect(() => {
    if (!phOpen) return;
    try {
      const raw = takeSnapshot();
      setPhCount(raw ? countTokens(JSON.parse(raw)) : 0);
    } catch (_) { setPhCount(0); }
  }, [phOpen, reloadTick]);

  // Что подставится прямо сейчас — считаем на момент открытия ленты,
  // чтобы дата не «прыгала» на каждой перерисовке.
  const phPreview = useMemo(() => {
    if (!phOpen) return {} as Record<string, string>;
    const ctx = placeholderCtx();
    const out: Record<string, string> = {};
    for (const ph of PLACEHOLDERS) {
      try { out[ph.key] = ph.resolve(ctx as any); } catch (_) { out[ph.key] = ''; }
    }
    return out;
  }, [phOpen, doc?.name, titleSettings, activeProject?.id, user?.id]);

  const fillPlaceholders = async () => {
    const raw = takeSnapshot();
    if (!raw) { addToast('Документ ещё открывается — повторите через секунду', 'info'); return; }
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch (_) { addToast('Не удалось прочитать документ', 'error'); return; }
    const { result, replaced } = fillSnapshot(parsed, placeholderCtx());
    if (!replaced) { addToast('Меток для заполнения не найдено', 'info'); return; }
    setSaveState('saving');
    const res = await fetch(`/api/constructor/docs/${docId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workbook: JSON.stringify(result), baseUpdatedAt: baseRef.current }),
    });
    if (!res.ok) { setSaveState('idle'); addToast('Не удалось сохранить заполненный документ', 'error'); return; }
    lastSavedRef.current = JSON.stringify(result);
    setSaveState('saved');
    addToast(`Заполнено меток: ${replaced}`, 'success');
    setPhCount(0);
    closeDock();
    setLoading(true);
    setReloadTick(t => t + 1); // редактор перечитывает документ уже с данными
  };

  const saveNow = async (extra?: Record<string, any>, force = false) => {
    if (saveConflictRef.current && !force) return;
    // Связи с комнатой нет, а в документе кто-то есть: пока чужие правки до
    // меня не доходят, писать свою книгу целиком — значит класть её поверх них
    if (roomRef.current?.hold.current && !force) return;
    const snapshot = takeSnapshot();
    const bindingsChanged = bindingsDirtyRef.current;
    if (!snapshot && !extra && !bindingsChanged) return;
    if (snapshot === lastSavedRef.current && !extra && !bindingsChanged && !force) return;
    setSaveState('saving');
    try {
      const res = await fetch(`/api/constructor/docs/${docId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(snapshot ? { workbook: snapshot } : {}),
          ...(bindingsChanged ? { bindings: JSON.stringify(bindingsRef.current) } : {}),
          ...(extra || {}),
          baseUpdatedAt: baseRef.current,
          ...(force ? { force: true } : {}),
        }),
      });
      if (res.ok) {
        if (snapshot) { lastSavedRef.current = snapshot; myEditRef.current = false; }
        if (bindingsChanged) bindingsDirtyRef.current = false;
        const d = await res.json();
        setDoc(d.doc);
        baseRef.current = d.doc?.updatedAt || baseRef.current;
        // Участникам комнаты: документ записан, время у него теперь такое.
        // Они получили мою правку операциями и отставшими не являются
        roomRef.current?.send('constructor:saved', { docId, at: baseRef.current });
        saveConflictRef.current = false;
        setSaveConflict(null);
        setSaveState('saved');
        // Правка могла увести русский от английской версии — сверяем сразу,
        // а не при следующем открытии: два разных документа заказчику уходят
        // именно в тот день, когда «поправил и отправил»
        if (snapshot) checkStale(snapshot);
        return;
      }
      const d = await res.json().catch(() => ({}));
      if (res.status === 409 && d.conflict) {
        // Разбор вместо записи. Правка человека цела — она в книге на экране
        saveConflictRef.current = true;
        setSaveConflict({ who: d.who || '', at: d.at || null });
        setSaveState('idle');
        return;
      }
      if (d.error) addToast(d.error, 'error');
      setSaveState('idle');
    } catch (_) { setSaveState('idle'); }
  };

  /**
   * Комната документа. Что делать после возвращения связи, решает
   * collab.afterReconnect: перечитывать документ можно только тогда, когда
   * терять нечего, а при своей несохранённой правке — запись, и столкновение
   * объявит сервер, разобрав его тем же окном, что и всегда.
   */
  const room = useDocRoom({
    docId,
    ready: !loading,
    applyOp: (op) => {
      applyingRemoteRef.current = true;
      try {
        // fromCollab: движок не рассылает эхо и не кладёт чужое в мой undo
        univerRef.current?.univerAPI?.executeCommand(op.id, op.params, { fromCollab: true } as any);
      } catch (_) { console.warn('[Constructor] Не применилась чужая операция:', op.id); }
      finally { setTimeout(() => { applyingRemoteRef.current = false; }, 0); }
    },
    isDirty: () => myEditRef.current,
    onResync: () => { lastSavedRef.current = ''; setLoading(true); setReloadTick(t => t + 1); },
    onResolve: () => { void saveNow(); },
    onNote: (text) => addToast(text, 'info'),
    onPeerSaved: (at) => { baseRef.current = at; },
  });
  // Слушатели движка живут дольше отрисовки и берут комнату из ссылки
  const roomRef = useRef(room);
  roomRef.current = room;
  const peers = room.peers;

  /**
   * Три выхода, и ни один не теряет молча: копия сохраняет обе работы, «своё»
   * уводит чужую правку в историю версий, «его» теряет только то, что человек
   * прямо сейчас видит на экране, — и об этом сказано прямо в окне.
   */
  const resolveSaveConflict = async (choice: ConflictChoice) => {
    if (choice === 'theirs') {
      saveConflictRef.current = false;
      setSaveConflict(null);
      lastSavedRef.current = '';
      setLoading(true);
      setReloadTick(t => t + 1);
      return;
    }
    if (choice === 'mine') {
      saveConflictRef.current = false;
      setSaveConflict(null);
      await saveNow(undefined, true);
      addToast('Сохранено. Правка коллеги — в истории версий', 'success');
      return;
    }
    // Копия: своё уходит отдельным документом, а это окно перечитывает чужую
    // правку — обе работы целы и лежат раздельно
    const copyName = `${doc?.name || 'Документ'} — моя правка`;
    try {
      await dataService.forkDoc(docId, takeSnapshot(), copyName);
      addToast(`Ваша правка сохранена документом «${copyName}»`, 'success');
      saveConflictRef.current = false;
      setSaveConflict(null);
      lastSavedRef.current = '';
      setLoading(true);
      setReloadTick(t => t + 1);
    } catch (e: any) {
      addToast(e?.message || 'Не удалось сохранить копию', 'error');
    }
  };

  // Страховка от вылета/закрытия окна: несохранённый снапшот уходит запросом
  // с keepalive — браузер дошлёт его даже после закрытия страницы. Вместе с
  // автосейвом раз в 2.5 с потеря правок сводится к нулю.
  useEffect(() => {
    const flushOnClose = () => {
      try {
        const snapshot = takeSnapshot();
        if (!snapshot || snapshot === lastSavedRef.current) return;
        fetch(`/api/constructor/docs/${docId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workbook: snapshot, baseUpdatedAt: baseRef.current }),
          keepalive: true,
        }).catch(() => {});
        lastSavedRef.current = snapshot;
      } catch (_) {}
    };
    window.addEventListener('beforeunload', flushOnClose);
    window.addEventListener('pagehide', flushOnClose);
    return () => {
      window.removeEventListener('beforeunload', flushOnClose);
      window.removeEventListener('pagehide', flushOnClose);
    };
  }, [docId]);

  // Инициализация движка: загрузка документа → createUniver → книга из снапшота
  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const res = await fetch(`/api/constructor/docs/${docId}`);
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          addToast(d.error || 'Не удалось открыть документ', 'error');
          onClose();
          return;
        }
        const { doc: loaded } = await res.json();
        if (disposed) return;
        setDoc(loaded);
        try { setTitleSettings(loaded.settings ? JSON.parse(loaded.settings) : {}); } catch (_) { setTitleSettings({}); }
        if (user) pushRecent(user.id, docId);
        try {
          const parsedB = loaded.bindings ? JSON.parse(loaded.bindings) : null;
          if (parsedB && Array.isArray(parsedB.blocks)) bindingsRef.current = parsedB;
        } catch (_) {}
        // Значок «данные проекта изменились» на блоках — сравнение отпечатков
        fetchFingerprint().then(fp => {
          if (!fp || disposed) return;
          const st: Record<string, boolean> = {};
          for (const b of bindingsRef.current.blocks) {
            if (b.state?.fingerprint && fp[b.query.entity] && b.state.fingerprint !== fp[b.query.entity]) st[b.id] = true;
          }
          setStaleMap(st);
        });

        // Движок подгружается лениво — тяжёлый бандл не попадает в общий чанк.
        // Офис-набор: ядро + фильтр, сортировка, условное форматирование,
        // поиск-замена (как в настольном Экселе).
        const pick = (m: any) => m.default ?? m;
        const [{ createUniver, LocaleType, mergeLocales, defaultTheme }, corePreset, filterP, sortP, cfP, frP, ruRU, fRu, sRu, cfRu, frRu] = await Promise.all([
          import('@univerjs/presets'),
          import('@univerjs/presets/preset-sheets-core'),
          import('@univerjs/presets/preset-sheets-filter'),
          import('@univerjs/presets/preset-sheets-sort'),
          import('@univerjs/presets/preset-sheets-conditional-formatting'),
          import('@univerjs/presets/preset-sheets-find-replace'),
          import('@univerjs/presets/preset-sheets-core/locales/ru-RU'),
          import('@univerjs/presets/preset-sheets-filter/locales/ru-RU'),
          import('@univerjs/presets/preset-sheets-sort/locales/ru-RU'),
          import('@univerjs/presets/preset-sheets-conditional-formatting/locales/ru-RU'),
          import('@univerjs/presets/preset-sheets-find-replace/locales/ru-RU'),
        ]);
        await Promise.all([
          import('@univerjs/presets/lib/styles/preset-sheets-core.css'),
          import('@univerjs/presets/lib/styles/preset-sheets-filter.css'),
          import('@univerjs/presets/lib/styles/preset-sheets-sort.css'),
          import('@univerjs/presets/lib/styles/preset-sheets-conditional-formatting.css'),
          import('@univerjs/presets/lib/styles/preset-sheets-find-replace.css'),
        ]);
        if (disposed || !containerRef.current) return;

        const { univer, univerAPI } = createUniver({
          locale: LocaleType.RU_RU,
          locales: { [LocaleType.RU_RU]: mergeLocales(pick(ruRU), pick(fRu), pick(sRu), pick(cfRu), pick(frRu)) },
          theme: defaultTheme,
          presets: [
            (corePreset as any).UniverSheetsCorePreset({
              container: containerRef.current,
              // Родной панели движка нет вовсе: ленту рисует Flux
              // (components/ribbon). Две панели с разными отступами — это два
              // места для одного действия; переключатель между ними держали
              // только ради фильтра, сортировки, условного вида и поиска — они
              // переехали в ленту, во вкладку «Главная». Строка формул и
              // ярлычки листов остаются: без них таблица не таблица
              toolbar: false,
            }),
            (filterP as any).UniverSheetsFilterPreset(),
            (sortP as any).UniverSheetsSortPreset(),
            (cfP as any).UniverSheetsConditionalFormattingPreset(),
            (frP as any).UniverSheetsFindReplacePreset(),
          ],
        });
        univerRef.current = { univer, univerAPI };

        let snapshot: any = null;
        try { snapshot = loaded.workbook ? JSON.parse(loaded.workbook) : null; } catch (_) {}
        // Новая книга: большая сетка сразу (5000×200), расширяется дальше сама
        univerAPI.createWorkbook(snapshot || {
          id: loaded.id,
          name: loaded.name,
          sheetOrder: ['sheet-1'],
          sheets: { 'sheet-1': { id: 'sheet-1', name: 'Лист1', rowCount: 5000, columnCount: 200 } },
        });
        lastSavedRef.current = loaded.workbook || '';
        baseRef.current = loaded.updatedAt || '';
        myEditRef.current = false;      // книга прочитана заново — своих правок нет

        // ── Формульные функции с данными проекта (часть I §7, MVP) ──
        // Асинхронные: движок сам ждёт ответа сервера; повторные вызовы с теми же
        // аргументами берутся из кэша (сбрасывается кнопками обновления данных).
        // Разделитель аргументов — запятая: =ПАРАМ_ЭЛ("бл1.1","Габариты","Высота")
        try {
          const formula = univerAPI.getFormula?.();
          const fnMemo = new Map<string, any>();
          (univerRef.current as any).fnMemo = fnMemo;
          const serverCall = async (fn: string, args: any[]) => {
            const key = `${fn}|${JSON.stringify(args)}`;
            if (fnMemo.has(key)) return fnMemo.get(key);
            try {
              const r = await fetch('/api/constructor/fn', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectId: loaded.projectId, calls: [{ fn, args }] }),
              });
              const v = r.ok ? (await r.json()).results?.[0] ?? '#ОШИБКА' : '#ОШИБКА';
              fnMemo.set(key, v);
              return v;
            } catch (_) { return '#ОШИБКА'; }
          };
          const reg = (names: string[], fn: string, argc: number, desc: string) => {
            for (const n of names) {
              try { formula?.registerAsyncFunction?.(n, async (...a: any[]) => serverCall(fn, a.slice(0, argc).map((x: any) => String(x ?? ''))), desc); }
              catch (e) { console.warn(`[Constructor] Функция ${n} не зарегистрирована:`, e); }
            }
          };
          reg(['ТЕГ', 'TAGINFO'], 'tag', 2, 'Поле тега по идентификатору: =ТЕГ("AHU-2","brand"). Поля: brand, department, wbs, fluid, system.name…');
          reg(['ПАРАМ', 'PARAMINFO'], 'param', 3, 'Параметр оборудования по тегу: =ПАРАМ("AHU-2","Габариты","Высота")');
          reg(['ПАРАМ_ЭЛ', 'PARAMEL'], 'paramEl', 3, 'Параметр по коду элемента: =ПАРАМ_ЭЛ("бл1.1","Габариты","Высота")');
          reg(['ПРОЕКТ', 'PROJECTINFO'], 'project', 1, 'Поле проекта: =ПРОЕКТ("customer"). Поля: name, code, customer, contractor, description');

          // ── Своды по проекту ──
          // Обычная таблица считает по диапазону, который надо сначала руками
          // собрать. Эти считают по живым данным проекта: добавили установку —
          // итог изменился сам, без правки книги
          reg(['ПАРАМ_СУММ', 'PARAMSUM'], 'pSum', 4,
            'Сумма параметра по элементам: =ПАРАМ_СУММ("Аэродинамика","Расход воздуха","equipType","ВЕНТИЛЯТОР"). Два последних довода необязательны — без них считает по всему проекту');
          reg(['ПАРАМ_СРЕДН', 'PARAMAVG'], 'pAvg', 4, 'Среднее параметра по элементам; доводы как у ПАРАМ_СУММ');
          reg(['ПАРАМ_МАКС', 'PARAMMAX'], 'pMax', 4, 'Максимум параметра по элементам; доводы как у ПАРАМ_СУММ');
          reg(['ПАРАМ_МИН', 'PARAMMIN'], 'pMin', 4, 'Минимум параметра по элементам; доводы как у ПАРАМ_СУММ');
          reg(['ПАРАМ_КОЛ', 'PARAMCOUNT'], 'pCount', 4, 'У скольких элементов параметр заполнен числом; доводы как у ПАРАМ_СУММ');
          reg(['КОЛ_ЭЛЕМЕНТОВ', 'COUNTEL'], 'countEl', 2,
            'Сколько элементов подходит условию: =КОЛ_ЭЛЕМЕНТОВ("equipType","КЛАПАН"). Без доводов — все элементы проекта');
          reg(['КОЛ_ТЕГОВ', 'COUNTTAG'], 'countTag', 2,
            'Сколько тегов подходит условию: =КОЛ_ТЕГОВ("department","ОВ"). Без доводов — все теги проекта');
          reg(['СПИСОК_ТЕГОВ', 'LISTTAG'], 'listTag', 2,
            'Перечень тегов через «;»: =СПИСОК_ТЕГОВ("department","ОВ")');

          // ── Состояние оборудования ──
          reg(['ЭЛЕМЕНТ', 'ELEMENTINFO'], 'element', 2,
            'Поле элемента по коду: =ЭЛЕМЕНТ("бл2.1","system.name"). Поля: name, itemCode, equipType, status, system.name, monoblock.name, tags');
          reg(['ТЕГИ_ЭЛ', 'ELTAGS'], 'tagsOf', 1, 'Теги элемента через «;»: =ТЕГИ_ЭЛ("бл2.1")');
          reg(['КОНФЛИКТ', 'ELCONFLICT'], 'conflict', 1,
            'Вид конфликта элемента после импорта расчёта, пусто — конфликта нет: =КОНФЛИКТ("бл2.1")');
          reg(['РЕВИЗИЯ', 'ELREVISION'], 'revision', 1, 'Номер ревизии элемента: =РЕВИЗИЯ("бл2.1")');
          reg(['УСТАНОВКА', 'SYSTEMINFO'], 'system', 2,
            'Свод по установке: =УСТАНОВКА("у1","элементы"). Поля: элементы, моноблоки, категория');
        } catch (e) { console.warn('[Constructor] Регистрация функций пропущена:', e); }

        // Мои мутации → остальным участникам (операции вроде выделения не шлём)
        let selTimer: any = null;
        const cmdDisposer = univerAPI.onCommandExecuted((command: any, options: any) => {
          // Сумма и среднее в строке состояния: считаем после выделения и
          // правки, но не на каждую команду — их за одно движение мыши десятки
          clearTimeout(selTimer);
          selTimer = setTimeout(() => cellStateFnRef.current(), 150);
          if (applyingRemoteRef.current || options?.fromCollab || options?.fromChangeset) return;
          if (command?.type !== 2) return; // 2 = CommandType.MUTATION
          const cmdId = String(command.id || '');
          if (!cmdId.startsWith('sheet.mutation.')) return;
          myEditRef.current = true;
          roomRef.current.send('constructor:op', { docId, op: { id: cmdId, params: command.params } });
        });
        (univerRef.current as any).cmdDisposer = cmdDisposer;

        // Ждём сам лист, а не отмеренное на глаз время: иначе человек,
        // создавший документ, секунду смотрит на белое поле (src/lib/engineReady.ts)
        await waitForSheet(() => !!univerAPI.getActiveWorkbook?.()?.getActiveSheet?.());
        if (disposed) return;
        setLoading(false);

        // Новая книга сохраняется сразу: пока снимок не записан, документ в
        // базе пуст, и открытый на другой машине он выглядит потерянным
        if (!loaded.workbook) setTimeout(() => { void saveNow(); }, 300);

        // Документ создан по шаблону: сразу наполняем блоки данными ЭТОГО проекта
        if (autoRefresh && bindingsRef.current.blocks.length > 0) {
          setTimeout(() => { refreshAll(); }, 600);
        }
      } catch (err: any) {
        console.error('[Constructor] Ошибка инициализации движка:', err);
        addToast('Не удалось загрузить редактор таблиц', 'error');
        onClose();
      }
    })();

    // Автосейв: раз в 2.5 с, только если снапшот реально изменился
    const timer = setInterval(() => { saveNow(); }, 2500);

    // Presence-тикер: шлём своё выделение (если сменилось) и пересчитываем
    // пиксельные рамки выделений коллег (учитывает прокрутку с шагом тика)
    const presenceTimer = setInterval(() => {
      try {
        const api = univerRef.current?.univerAPI;
        const wb = api?.getActiveWorkbook?.();
        const ws = wb?.getActiveSheet?.();
        if (!ws) return;
        const rng = ws.getSelection?.()?.getActiveRange?.();
        const sel = rng ? { sheetId: ws.getSheetId(), row: rng.getRow(), col: rng.getColumn() } : null;
        const selStr = JSON.stringify(sel);
        if (selStr !== lastSelSentRef.current) {
          lastSelSentRef.current = selStr;
          roomRef.current.send('constructor:selection', { docId, selection: sel });
        }
      } catch (_) {}
    }, 350);

    return () => {
      clearInterval(presenceTimer);
      disposed = true;
      clearInterval(timer);
      try { (univerRef.current as any)?.cmdDisposer?.dispose?.(); } catch (_) {}
      try { univerRef.current?.univer?.dispose?.(); } catch (_) {}
      univerRef.current = null;
    };
  }, [docId, reloadTick]);

  // Рамки выделений коллег: пересчёт по peers и позиции ячеек на экране
  useEffect(() => {
    const calc = () => {
      try {
        const api = univerRef.current?.univerAPI;
        const wb = api?.getActiveWorkbook?.();
        const ws = wb?.getActiveSheet?.();
        const cont = containerRef.current;
        if (!ws || !cont) { setPeerRects([]); return; }
        const contRect = cont.getBoundingClientRect();
        // getCellRect движка отсчитывается от канваса листа — переводим в
        // координаты нашего контейнера через положение самого канваса
        const canvasEl = cont.querySelector('canvas[id^="univer-sheet-main-canvas"]');
        const baseRect = canvasEl ? canvasEl.getBoundingClientRect() : contRect;
        const offX = baseRect.x - contRect.x;
        const offY = baseRect.y - contRect.y;
        const mySheet = ws.getSheetId();
        const rects: typeof peerRects = [];
        for (const pp of peers) {
          // Вид выделения знает редактор, а не комната: у таблицы это лист и
          // клетка, у текста будет позиция в потоке
          const sel = pp.selection as { sheetId: string; row: number; col: number } | null;
          if (!sel || sel.sheetId !== mySheet) continue;
          try {
            const cellRect = ws.getRange(sel.row, sel.col).getCellRect();
            if (!cellRect || cellRect.width <= 0 || cellRect.x < 0 || cellRect.y < 0) continue;
            rects.push({
              key: pp.socketId, name: pp.name, color: pp.color,
              left: offX + cellRect.x,
              top: offY + cellRect.y,
              width: cellRect.width, height: cellRect.height,
            });
          } catch (_) {}
        }
        setPeerRects(rects);
      } catch (_) { setPeerRects([]); }
    };
    calc();
    const t = setInterval(calc, 400);
    return () => clearInterval(t);
  }, [peers]);

  // Вставка собранной таблицы от активной ячейки (или A1) — создаёт УМНЫЙ БЛОК:
  // область помнит свой запрос и умеет обновляться из данных проекта
  const handleInsert = async (r: WizardResult) => {
    setWizardOpen(false);
    suggestionRef.current = r.suggestedName;
    try {
      const api = univerRef.current?.univerAPI;
      const ws = api?.getActiveWorkbook?.()?.getActiveSheet?.();
      if (!ws) return;
      const sel = ws.getSelection?.()?.getActiveRange?.();
      const r0 = sel ? sel.getRow() : 0;
      const c0 = sel ? sel.getColumn() : 0;
      const matrix = [r.headers, ...r.rows];
      ws.getRange(r0, c0, matrix.length, r.headers.length).setValues(matrix);
      try { ws.getRange(r0, c0, 1, r.headers.length).setFontWeight('bold'); } catch (_) {}

      const fp = await fetchFingerprint();
      bindingsRef.current.blocks.push({
        id: `blk_${Math.random().toString(36).slice(2, 8)}`,
        name: r.suggestedName,
        sheetId: ws.getSheetId(),
        anchor: { row: r0, col: c0 },
        headerRows: 1,
        query: r.query,
        rows: r.keys,
        lastValues: r.rows,
        overrides: {},
        state: { lastRefreshAt: new Date().toISOString(), fingerprint: fp?.[r.query.entity] },
      });
      bindingsDirtyRef.current = true;
      setBlocksTick(t => t + 1);
      addToast(`Вставлен блок «${r.suggestedName}»: ${countOf(r.rows.length, 'строка')}`, 'success');
      saveNow();
    } catch (err) {
      console.error('[Constructor] Ошибка вставки:', err);
      addToast('Не удалось вставить данные', 'error');
    }
  };

  const sheetOfBlock = (b: SmartBlock) => {
    const wb = univerRef.current?.univerAPI?.getActiveWorkbook?.();
    try { const ws = wb?.getSheetBySheetId?.(b.sheetId); if (ws) return ws; } catch (_) {}
    return null;
  };

  // ── Обновление блока: сверка по entityKey (часть II §2, MVP) ──
  const refreshBlock = async (blockId: string, skipVersion = false) => {
    const b = bindingsRef.current.blocks.find(x => x.id === blockId);
    if (!b || refreshingIds.includes(blockId)) return;
    if (!skipVersion) await makeVersion('перед обновлением данных');
    setRefreshingIds(prev => [...prev, blockId]);
    try {
      const ws = sheetOfBlock(b);
      if (!ws) { addToast('Лист блока не найден — блок отвязан', 'error'); unlinkBlock(blockId); return; }
      const ncols = b.query.columns.length;
      const dataTop = b.anchor.row + b.headerRows;
      const oldN = b.rows.length;

      // 1. Ручные правки с прошлого обновления: текущее ≠ записанное → override
      let cur: any[][] = [];
      try { cur = oldN > 0 ? (ws.getRange(dataTop, b.anchor.col, oldN, ncols).getValues() || []) : []; } catch (_) {}
      for (let i = 0; i < oldN; i++) {
        for (let j = 0; j < ncols; j++) {
          const was = b.lastValues?.[i]?.[j];
          const now = cur?.[i]?.[j];
          if (cur[i] !== undefined && !sameCell(was, now)) {
            b.overrides[`${b.rows[i]}|${j}`] = { value: now, base: was };
          }
        }
      }

      // 2. Свежие данные тем же запросом
      const res = await fetch('/api/constructor/query', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: projectIdForData, entity: b.query.entity,
          columns: b.query.columns.map(c => c.path), filters: b.query.filters, limit: 50000,
        }),
      });
      if (!res.ok) throw new Error('query failed');
      const fresh: { key: string; cells: any[] }[] = (await res.json()).rows;

      // 3. Сводка изменений
      const oldSet = new Set(b.rows);
      const freshKeys = fresh.map(r => r.key);
      const freshSet = new Set(freshKeys);
      const added = freshKeys.filter(k => !oldSet.has(k)).length;
      const removed = b.rows.filter(k => !freshSet.has(k)).length;

      // 4. Высота области: вставляем/удаляем строки, чтобы не съесть содержимое ниже
      const newN = fresh.length;
      if (newN > oldN) ws.insertRowsAfter(dataTop + Math.max(oldN, 1) - 1, newN - oldN);
      else if (newN < oldN) ws.deleteRows(dataTop + newN, oldN - newN);

      // 5. Матрица: свежие значения, поверх — ручные правки; расхождение = конфликт
      const conflictItems: ConflictItem[] = [];
      let changed = 0;
      const matrix = fresh.map((row, i) => row.cells.map((v, j) => {
        const ovKey = `${row.key}|${j}`;
        const ov = b.overrides[ovKey];
        if (ov) {
          if (!sameCell(ov.base, v)) {
            conflictItems.push({
              key: row.key, row: dataTop + i, col: b.anchor.col + j,
              colTitle: b.query.columns[j].title, userValue: ov.value, liveValue: v,
            });
          }
          return ov.value; // ручная правка сохраняется, конфликт решается отдельно
        }
        const oldIdx = b.rows.indexOf(row.key);
        if (oldIdx >= 0 && !sameCell(b.lastValues?.[oldIdx]?.[j], v)) changed++;
        return v;
      }));
      if (newN > 0) ws.getRange(dataTop, b.anchor.col, newN, ncols).setValues(matrix);

      // 6. Чистим overrides исчезнувших строк, фиксируем новое состояние
      for (const k of Object.keys(b.overrides)) {
        if (!freshSet.has(k.slice(0, k.lastIndexOf('|')))) delete b.overrides[k];
      }
      b.rows = freshKeys;
      b.lastValues = matrix;
      const fp = await fetchFingerprint();
      b.state = { lastRefreshAt: new Date().toISOString(), fingerprint: fp?.[b.query.entity] };
      bindingsDirtyRef.current = true;
      setBlocksTick(t => t + 1);
      setStaleMap(m => ({ ...m, [b.id]: false }));

      const parts = [`+${added} новых`, `−${removed} выпало`, `${changed} изменений`];
      if (conflictItems.length) parts.push(`конфликтов: ${conflictItems.length}`);
      addToast(`«${b.name}»: ${parts.join(', ')}`, conflictItems.length ? 'info' : 'success');
      if (conflictItems.length) setConflicts({ blockId: b.id, items: conflictItems });
      await saveNow();
    } catch (err) {
      console.error('[Constructor] Ошибка обновления блока:', err);
      addToast('Не удалось обновить блок', 'error');
    } finally {
      setRefreshingIds(prev => prev.filter(x => x !== blockId));
    }
  };

  // Снимок версии на сервере; перед этим дожимаем автосейв, чтобы снимок был свежим
  const makeVersion = async (comment: string) => {
    try {
      await saveNow();
      await fetch(`/api/constructor/docs/${docId}/versions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment }),
      });
    } catch (_) { /* версия — страховка, её сбой не блокирует работу */ }
  };

  const loadVersions = async () => {
    try {
      const r = await fetch(`/api/constructor/docs/${docId}/versions`);
      if (r.ok) setVersions((await r.json()).versions || []);
    } catch (_) {}
  };

  // Откат: сервер сначала сохранит текущее состояние версией — откат отката возможен
  const restoreVersion = async (v: { id: string; version: number }) => {
    if (!await openConfirm(`Восстановить версию ${v.version}?`, 'Текущее состояние сохранится отдельной версией — ничего не потеряется.', { confirmLabel: 'Восстановить' })) return;
    const r = await fetch(`/api/constructor/docs/${docId}/restore/${v.id}`, { method: 'POST' });
    if (!r.ok) { addToast('Не удалось восстановить версию', 'error'); return; }
    addToast(`Восстановлена версия ${v.version}`, 'success');
    closeDock();
    setLoading(true);
    setReloadTick(t => t + 1); // движок пересоздаётся с восстановленным снапшотом
  };

  /**
   * Обновить данные книги — всё, что взято из проекта, одной кнопкой.
   *
   * Раньше кнопок было две: «Обновить всё» перечитывала блоки, «Заполнить»
   * подставляла метки-подстановки, и человек резонно считал, что умные блоки
   * не работают: он нажимал одну и половина документа оставалась старой.
   * Понятие теперь одно — метка, и обновление одно.
   */
  const refreshAll = async () => {
    (univerRef.current as any)?.fnMemo?.clear?.(); // формулы =ТЕГ/=ПАРАМ возьмут свежее
    await makeVersion('перед обновлением данных'); // автоснимок (часть I §3)
    for (const b of [...bindingsRef.current.blocks]) await refreshBlock(b.id, true);
    // Подстановки заполняются последними: они читают снимок, а блоки его
    // только что переписали. Перечитывать документ ради них незачем, если
    // заполнять нечего — fillPlaceholders сам это увидит
    if (phCount) await fillPlaceholders();
  };

  // Отвязать: данные остаются обычными ячейками, привязка удаляется
  const unlinkBlock = (blockId: string) => {
    bindingsRef.current.blocks = bindingsRef.current.blocks.filter(b => b.id !== blockId);
    bindingsDirtyRef.current = true;
    setBlocksTick(t => t + 1);
    saveNow();
  };

  // Применение решения по конфликту: «Моё» — правка остаётся поверх нового
  // значения; «Из проекта» — в ячейку пишется живое значение, override снимается
  const applyResolution = (blockId: string, item: ConflictItem, take: 'mine' | 'live') => {
    const b = bindingsRef.current.blocks.find(x => x.id === blockId);
    if (!b) return;
    const j = item.col - b.anchor.col;
    const ovKey = `${item.key}|${j}`;
    if (take === 'live') {
      const ws = sheetOfBlock(b);
      try { ws?.getRange(item.row, item.col, 1, 1).setValues([[item.liveValue]]); } catch (_) {}
      delete b.overrides[ovKey];
      const rowIdx = item.row - (b.anchor.row + b.headerRows);
      if (b.lastValues[rowIdx]) b.lastValues[rowIdx][j] = item.liveValue;
    } else if (b.overrides[ovKey]) {
      b.overrides[ovKey].base = item.liveValue; // решено: моя правка поверх нового живого
    }
    bindingsDirtyRef.current = true;
  };

  const resolveConflict = (item: ConflictItem, take: 'mine' | 'live') => {
    if (!conflicts) return;
    applyResolution(conflicts.blockId, item, take);
    const rest = conflicts.items.filter(x => x !== item);
    setConflicts(rest.length ? { ...conflicts, items: rest } : null);
    if (!rest.length) saveNow();
  };

  const resolveAllConflicts = (take: 'mine' | 'live') => {
    if (!conflicts) return;
    for (const item of conflicts.items) applyResolution(conflicts.blockId, item, take);
    setConflicts(null);
    saveNow();
  };

  // Снапшот книги → книга SheetJS (все листы, значения)
  // Снимок книги → книга SheetJS: превращение нужно и выгрузке на диск, и
  // сохранению в Проводник, поэтому живёт рядом с ними (lib/bookExport)
  const buildXlsx = () => bookFromSnapshot(takeSnapshot());

  // Печатный HTML активного листа: значения + жирность из стилей книги.
  // Полная пагинация с колонтитулами — следующая фаза (часть II §8 дизайна).
  const buildPrintHtml = (): string => {
    const snap = JSON.parse(takeSnapshot() || '{}');
    const activeId = univerRef.current?.univerAPI?.getActiveWorkbook?.()?.getActiveSheet?.()?.getSheetId?.();
    const sh = snap.sheets?.[activeId] || Object.values(snap.sheets || {})[0] as any;
    const styles = snap.styles || {};
    let maxR = 0, maxC = 0;
    const cellData = sh?.cellData || {};
    for (const rk of Object.keys(cellData)) {
      const r = Number(rk);
      for (const ck of Object.keys(cellData[rk] || {})) {
        const v = cellData[rk][ck]?.v;
        if (v !== undefined && v !== null && v !== '') { maxR = Math.max(maxR, r); maxC = Math.max(maxC, Number(ck)); }
      }
    }
    const esc = (x: any) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let rowsHtml = '';
    for (let r = 0; r <= maxR; r++) {
      let tds = '';
      for (let c = 0; c <= maxC; c++) {
        const cell = cellData[r]?.[c];
        const st = cell?.s ? (typeof cell.s === 'string' ? styles[cell.s] : cell.s) : null;
        const bold = st?.bl === 1 ? 'font-weight:bold;background:#f1f5f9;' : '';
        tds += `<td style="${bold}">${esc(cell?.v)}</td>`;
      }
      rowsHtml += `<tr>${tds}</tr>`;
    }
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc?.name || 'Документ')}</title>
      <style>
        body { font-family: Calibri, Arial, sans-serif; margin: 16mm 12mm; color: #0f172a; }
        h1 { font-size: 15px; margin: 0 0 2px; }
        .sub { font-size: 10px; color: #64748b; margin-bottom: 10px; }
        table { border-collapse: collapse; width: 100%; font-size: 10px; }
        td { border: 0.5pt solid #94a3b8; padding: 2px 5px; vertical-align: top; }
        tr { page-break-inside: avoid; }
        @page { margin: 10mm; }
      </style></head><body>
      <h1>${esc(doc?.name || 'Документ')}</h1>
      <div class="sub">${esc(activeProject?.name || '')} · ${new Date().toLocaleDateString('ru-RU')} · Flux Office</div>
      <table>${rowsHtml}</table></body></html>`;
  };

  // Печатный HTML с титульным листом первой страницей (если присвоен)
  const buildFullPrintHtml = async (): Promise<string> => {
    const base = buildPrintHtml();
    const [title, revSheet] = await Promise.all([
      fetchTitlePageHtml(docId, titleSettings.titleTemplateId),
      fetchRevisionsSheetHtml(titleSettings),
    ]);
    const front = (title || '') + (revSheet || '');
    return front ? base.replace('<body>', `<body>${front}`) : base;
  };

  const handlePrint = async () => {
    try {
      const html = await buildFullPrintHtml();
      const w = window.open('', '_blank');
      if (!w) { addToast('Всплывающее окно заблокировано', 'error'); return; }
      w.document.write(html);
      w.document.close();
      setTimeout(() => { try { w.print(); } catch (_) {} }, 400);
    } catch (err) { addToast('Ошибка подготовки печати', 'error'); }
  };

  const handlePdf = async () => {
    try {
      const html = await buildFullPrintHtml();
      const win = window as any;
      if (win.electron?.ipcRenderer?.invoke) {
        const hf = await buildPageTemplates(docId, titleSettings);
        const r = await win.electron.ipcRenderer.invoke('print:to-pdf', { html, title: doc?.name || 'Документ', ...hf });
        if (r?.success) addToast('PDF сохранён', 'success');
        else if (!r?.canceled) addToast(r?.error || 'Не удалось сохранить PDF', 'error');
      } else {
        // Браузер: диалог печати — там есть «Сохранить как PDF»
        handlePrint();
      }
    } catch (err) { addToast('Ошибка экспорта PDF', 'error'); }
  };

  // Выгрузка книги и в Windows, и в Проводник — в src/lib/bookExport.ts:
  // это два ответа на один вопрос «отдать людям», и отвечать они должны
  // одинаково с текстовым документом
  const exportDownload = async () => {
    try {
      const out = await saveBookToWindows(buildXlsx(), doc?.name || 'Документ');
      if (out.canceled) return;
      addToast(out.ok ? `Книга сохранена: ${out.path}` : (out.error || 'Не удалось сохранить'), out.ok ? 'success' : 'error');
    } catch (err) { addToast('Ошибка экспорта', 'error'); }
  };

  const exportToExplorer = async () => {
    try {
      const fileName = await saveBookToExplorer(buildXlsx(), doc?.name || 'Документ', user?.id);
      addToast(`«${fileName}» сохранён в Проводник`, 'success');
    } catch (_) { addToast('Не удалось сохранить в Проводник', 'error'); }
  };

  // Закрытие: единственный диалог — имя, и только если оно автогенерированное
  const handleClose = async () => {
    await saveNow();
    if (doc && !doc.named) {
      setNameDialog({ suggestion: suggestionRef.current || `Таблица — ${new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}` });
      return;
    }
    onClose();
  };

  const isAuthor = !doc?.createdById || doc?.createdById === user?.id || user?.role === 'ADMIN';

  // Как зовут это окно: имя книги, а не «Конструктор» — их может быть открыто
  // несколько, и различать их по названию программы нечем
  useWindowTitle(doc?.name || '');

  // Запоминаем открытое для «Открыть недавние» и «Рекомендуем» в Пуске.
  // Пишем, когда у документа уже есть имя: строка «Без названия» в списке
  // недавних не помогает никому
  useEffect(() => {
    if (!doc?.name) return;
    rememberDoc({
      href: `/sheet?doc=${docId}`, title: doc.name, kind: 'sheet',
      at: Date.now(), projectId: activeProject?.id,
    });
  }, [docId, doc?.name, activeProject?.id]);

  // ── Лента: состояние, значения органов и разбор команд ──
  const tabs = useMemo(() => sheetRibbon(), []);
  const [tab, setTab] = useState('Главная');
  // Свёрнутая лента помнится между документами и программами семьи
  const [folded, setFolded] = useRibbonFold();
  const [fileOpen, setFileOpen] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [font, setFont] = useState('');
  const [numFormat, setNumFormat] = useState('General');
  const [textColor, setTextColor] = useState(SHEET_TEXT_COLORS[0]);
  const [fillColor, setFillColor] = useState(SHEET_FILL_COLORS[0]);
  const [wrapOn, setWrapOn] = useState(false);
  const [fontSize, setFontSize] = useState(11);
  const [marks, setMarks] = useState({ bold: false, italic: false, underline: false, strike: false });
  const [gridOn, setGridOn] = useState(true);

  /**
   * Команда движку.
   *
   * Отклонение обещания гасим сами: движок отвечает обещанием, и необработанный
   * отказ уходит в журнал как критическая ошибка программы.
   */
  const exec = (id: string, params?: any) => {
    const api = univerRef.current?.univerAPI;
    if (!api) { addToast('Редактор ещё загружается', 'error'); return; }
    try {
      const r = api.executeCommand(id, params);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (_) { addToast('Не удалось выполнить команду', 'error'); }
    setTimeout(() => saveNow(), 400);
  };

  /** Выделение книги — через фасад: там же и границы, и формат числа */
  const activeRange = () => {
    try {
      return univerRef.current?.univerAPI?.getActiveWorkbook?.()?.getActiveSheet?.()?.getActiveRange?.() || null;
    } catch (_) { return null; }
  };

  /** Действие над выделением фасадом движка: возвращает false, если выделения нет */
  const onRange = (fn: (r: any) => void): boolean => {
    const r = activeRange();
    if (!r) { addToast('Выделите ячейки', 'error'); return false; }
    try { fn(r); } catch (_) { addToast('Не удалось применить к выделению', 'error'); return false; }
    setTimeout(() => saveNow(), 400);
    return true;
  };

  /**
   * Что стоит в выделенных ячейках — в ленту.
   *
   * Кнопка обязана отвечать, что с ней: «Ж» не команда, а переключатель, по
   * нему читают, жирный ли текст под курсором. Сумму и среднее не считаем —
   * их показывает сам движок в своей нижней строке, и вторая такая же строка
   * была бы ровно тем, что мы тут и исправляем.
   */
  const refreshCellState = () => {
    try {
      const r = activeRange();
      if (!r) return;
      const st: any = r.getCellStyle?.();
      const fam = r.getFontFamily?.();
      if (fam) setFont(String(fam));
      const size = r.getFontSize?.();
      if (size) setFontSize(Number(size));
      setMarks({
        bold: !!st?.bold,
        italic: !!st?.italic,
        underline: !!st?.underline,
        strike: !!st?.strikethrough,
      });
      setWrapOn(!!r.getWrap?.());
    } catch (_) { /* выделения нет или движок ещё грузится — молча */ }
  };
  cellStateFnRef.current = refreshCellState;

  /** Книга как шаблон: структура и блоки без данных — для других проектов */
  const saveAsTemplate = async () => {
    await saveNow();
    const res = await fetch(`/api/constructor/docs/${docId}/duplicate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'TEMPLATE', name: `${doc?.name || 'Документ'} — шаблон` }),
    });
    addToast(res.ok ? 'Сохранён в «Шаблоны»: структура, блоки и формулы переиспользуемы' : 'Не удалось сохранить шаблон',
      res.ok ? 'success' : 'error');
  };

  /**
   * Английская версия: сначала сверка, потом документ.
   *
   * Снимок берём один раз и отдаём диалогу: пока человек читает перевод, он же
   * может править русский документ, и собирать английскую версию по съехавшему
   * снимку значит выпустить документ, которого не было.
   */
  const openEnglish = async () => {
    await saveNow();
    try {
      setEnglishSnap(JSON.parse(takeSnapshot() || '{}'));
    } catch (_) {
      addToast('Не удалось прочитать документ', 'error');
    }
  };

  const createEnglish = async (mode: string, workbook: string, name: string, print: string): Promise<boolean> => {
    try {
      const copy = await dataService.forkDoc(docId, workbook, name);
      await fetch('/api/translate/links', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: activeProject?.id, sourceDocId: docId, targetDocId: copy.id, mode, fingerprint: print,
        }),
      });
      addToast(`Создан документ «${name}»`, 'success');
      linkRef.current = { id: '', targetDocId: copy.id, fingerprint: print };
      setStale(null);
      return true;
    } catch (e: any) {
      addToast(e?.message || 'Не удалось создать английскую версию', 'error');
      return false;
    }
  };

  /**
   * Русский документ правят, английский остаётся прежним — и заказчику уходят
   * два разных документа. Сверяем отпечаток текста с тем, что был на момент
   * перевода, и говорим об этом прямо в документе.
   *
   * Связь держим в ссылке, а не только в состоянии: сверка идёт и при каждом
   * сохранении, а обработчик сохранения живёт дольше одной отрисовки.
   */
  const linkRef = useRef<{ id: string; targetDocId: string; fingerprint: string } | null>(null);

  const checkStale = (snapshot?: string) => {
    const link = linkRef.current;
    if (!link?.targetDocId || !link.fingerprint) { setStale(null); return; }
    try {
      const now = docFingerprint(JSON.parse(snapshot || takeSnapshot() || '{}'));
      setStale(now && now !== link.fingerprint ? { id: link.id, targetDocId: link.targetDocId } : null);
    } catch (_) { /* книга ещё не собралась — сверим при следующем сохранении */ }
  };

  useEffect(() => {
    if (loading || !docId) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/translate/links?sourceDocId=${encodeURIComponent(docId)}`);
        if (!res.ok) return;
        const data = await res.json();
        const link = (data.items || [])[0];
        if (!alive) return;
        linkRef.current = link?.targetDocId
          ? { id: link.id, targetDocId: link.targetDocId, fingerprint: link.fingerprint || '' } : null;
        checkStale();
      } catch (_) { /* связи может не быть — это норма */ }
    })();
    return () => { alive = false; };
  }, [docId, loading, reloadTick]);

  const runCommand = (id: string, value?: string) => {
    const api = univerRef.current?.univerAPI;
    switch (id) {
      case 'sh.undo': { const r = api?.undo?.(); if (r?.catch) r.catch(() => {}); return; }
      case 'sh.redo': { const r = api?.redo?.(); if (r?.catch) r.catch(() => {}); return; }
      case 'sh.font': { setFont(value || ''); return exec('sheet.command.set-range-font-family', { value }); }
      case 'sh.size': return exec(value === '+'
        ? 'sheet.command.set-range-font-increase' : 'sheet.command.set-range-font-decrease');
      case 'sh.bold': return exec('sheet.command.set-range-bold');
      case 'sh.italic': return exec('sheet.command.set-range-italic');
      case 'sh.underline': return exec('sheet.command.set-range-underline');
      case 'sh.strike': return exec('sheet.command.set-range-stroke');
      case 'sh.color': {
        const c = value && value !== 'open' ? value : textColor;
        setTextColor(c);
        return exec('sheet.command.set-range-text-color', { value: c });
      }
      case 'sh.fill': {
        const c = value && value !== 'open' ? value : fillColor;
        setFillColor(c);
        return exec('sheet.command.set-background-color', { value: c });
      }
      case 'sh.borders': { onRange(r => r.setBorder('all', 1)); return; }
      case 'sh.noBorders': { onRange(r => r.setBorder('all', 0)); return; }
      case 'sh.left': return exec('sheet.command.set-horizontal-text-align', { value: 1 });
      case 'sh.center': return exec('sheet.command.set-horizontal-text-align', { value: 2 });
      case 'sh.right': return exec('sheet.command.set-horizontal-text-align', { value: 3 });
      case 'sh.top': return exec('sheet.command.set-vertical-text-align', { value: 1 });
      case 'sh.bottom': return exec('sheet.command.set-vertical-text-align', { value: 3 });
      case 'sh.wrap': { setWrapOn(v => !v); return exec('sheet.command.set-text-wrap', { value: wrapOn ? 1 : 3 }); }
      case 'sh.format': {
        const f = value || 'General';
        setNumFormat(f);
        onRange(r => r.setNumberFormat?.(f));
        return;
      }
      case 'sh.merge': return exec('sheet.command.add-worksheet-merge-all');
      case 'sh.unmerge': return exec('sheet.command.remove-worksheet-merge');
      case 'sh.rowAfter': return exec('sheet.command.insert-row-after');
      case 'sh.colAfter': return exec('sheet.command.insert-col-after');
      case 'sh.rowBefore': return exec('sheet.command.insert-row-before');
      case 'sh.colBefore': return exec('sheet.command.insert-col-before');
      case 'sh.delRow': return exec('sheet.command.remove-row');
      case 'sh.delCol': return exec('sheet.command.remove-col');
      case 'sh.clear': return exec('sheet.command.clear-selection-content');
      case 'sh.newSheet': return exec('sheet.command.insert-sheet');
      case 'sh.wizard': return setWizardOpen(true);
      case 'sh.title': return toggleDock('title');
      case 'sh.blocks': return toggleDock('blocks');
      case 'sh.refreshAll': return refreshAll();
      case 'sh.placeholders': return toggleDock('labels');
      case 'sh.template': return saveAsTemplate();
      case 'sh.versions': { toggleDock('versions'); if (!versionsOpen) loadVersions(); return; }
      case 'sh.english': return openEnglish();
      case 'sh.zoom': {
        const next = Math.min(400, Math.max(30, zoom + (value === '+' ? 10 : -10)));
        setZoom(next);
        return exec('sheet.command.set-zoom-ratio', { zoomRatio: next / 100 });
      }
      case 'sh.zoomReset': { setZoom(100); return exec('sheet.command.set-zoom-ratio', { zoomRatio: 1 }); }
      case 'sh.freeze': return exec('sheet.command.set-selection-frozen');
      case 'sh.unfreeze': return exec('sheet.command.cancel-frozen');
      case 'sh.grid': { setGridOn(v => !v); return exec('sheet.command.toggle-gridlines'); }
      // Раньше это было доступно только из родной панели движка — из-за них
      // её и держали. Идентификаторы команд взяты из самих пакетов движка
      case 'sh.find': return exec('ui.operation.open-find-dialog');
      case 'sh.filter': { setFilterOn(v => !v); return exec('sheet.command.smart-toggle-filter'); }
      case 'sh.sortAsc': return exec('sheet.command.sort-range-asc');
      case 'sh.sortDesc': return exec('sheet.command.sort-range-desc');
      case 'sh.cond': return exec('sheet.operation.open.conditional.formatting.panel');
      default: return undefined;
    }
  };

  const organState: Record<string, boolean | string> = {
    'sh.font': font,
    'sh.size': String(fontSize),
    'sh.bold': marks.bold,
    'sh.italic': marks.italic,
    'sh.underline': marks.underline,
    'sh.strike': marks.strike,
    'sh.format': numFormat,
    'sh.color': textColor,
    'sh.fill': fillColor,
    'sh.wrap': wrapOn,
    'sh.grid': gridOn,
    'sh.zoom': `${zoom} %`,
    'sh.title': !!titleSettings.titleTemplateId,
    'sh.blocks': blocksOpen,
    'sh.placeholders': phOpen,
    'sh.versions': versionsOpen,
    'sh.filter': filterOn,
  };
  const organDisabled: Record<string, string> = {};
  if (!bindingsRef.current.blocks.length && !phCount) {
    organDisabled['sh.refreshAll'] = 'В книге пока нет меток данных — обновлять нечего';
  }

  const fileSections = editorFileMenu({
    recent: () => { setFileOpen(false); setRecentOpen(true); },
    saveNow: () => { saveNow(); setFileOpen(false); },
    saveVersion: async () => { setFileOpen(false); await makeVersion('ручное сохранение'); addToast('Версия сохранена', 'success'); },
    versions: () => { setFileOpen(false); setDock('versions'); loadVersions(); },
    copy: async () => {
      setFileOpen(false);
      await saveNow();
      const r = await fetch(`/api/constructor/docs/${docId}/duplicate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `${doc?.name || 'Таблица'} — копия` }),
      });
      addToast(r.ok ? 'Копия создана' : 'Не удалось создать копию', r.ok ? 'success' : 'error');
    },
    template: () => { setFileOpen(false); saveAsTemplate(); },
    revision: () => { setFileOpen(false); setDock('title'); },
    noRevision: 'Ревизии выпускаются у документов, привязанных к строке ВДР',
    print: () => { setFileOpen(false); handlePrint(); },
    pdf: () => { setFileOpen(false); handlePdf(); },
    office: () => { setFileOpen(false); exportDownload(); },
    officeLabel: 'Скачать XLSX',
    officeHint: 'Книга целиком для Excel',
    toExplorer: () => { setFileOpen(false); exportToExplorer(); },
    close: () => { setFileOpen(false); handleClose(); },
  });

  const fileInfo = [
    { label: 'Имя', value: doc?.name || '—' },
    { label: 'Раздел', value: doc?.scope === 'PERSONAL' ? 'Личный' : 'Общий' },
    { label: 'Проект', value: activeProject?.name || '—' },
    { label: 'Меток данных', value: String(bindingsRef.current.blocks.length) },
    { label: 'Изменён', value: doc?.updatedAt ? fmtDate(doc.updatedAt) : '—' },
    { label: 'Меток без данных', value: String(phCount) },
  ];

  return (
    <div className="h-full">
      <EditorFrame
        doc={{
          icon: <Table2 className="w-3.5 h-3.5 text-emerald-600" />,
          name: doc?.name || '',
          onRename: (v) => setDoc((d: any) => ({ ...d, name: v })),
          onClose: handleClose,
          scope: isAuthor ? (doc?.scope === 'PERSONAL' ? 'PERSONAL' : 'SHARED') : undefined,
          onScope: isAuthor ? (v) => saveNow({ scope: v }) : undefined,
          peers,
          link: room.note,
          saveState: saveConflict ? 'conflict' : saveState,
          menu: [
            { label: 'История версий', hint: 'Снимки и возврат к любому', run: () => { setDock('versions'); loadVersions(); } },
            { label: 'Метки данных', hint: 'Что откуда собрано и когда обновлялось', run: () => setDock('blocks') },
          ],
        }}
        tabs={tabs} active={tab} onActive={setTab}
        state={organState} disabled={organDisabled} onCommand={runCommand}
        attention={{ 'sh.refreshAll': Object.values(staleMap).some(Boolean) }}
        folded={folded} onFold={setFolded}
        file={fileSections} fileInfo={fileInfo} fileOpen={fileOpen} onFileOpen={setFileOpen}
      >
      {/*
        Полотно и панели — в одну строку, а не друг поверх друга.
        Панели «Метки», «Версии», «Титул» и лента меток висели НАД листом и
        закрывали ровно те строки, ради которых их открывали: человек нажимал
        «обновить», сдвигал панель, открывал снова. Пристыкованная панель
        ужимает лист, а не прячет его; закрытая не занимает ничего.
      */}
      <div className="absolute inset-0 flex">
      <div className="flex-1 min-w-0 flex flex-col">
      {/* Полотно движка */}
      <div className="flex-1 min-h-0 relative bg-white">
        <div ref={containerRef} className="absolute inset-0" />
        {/* Выделения коллег (как в онлайн-Excel): цветная рамка + имя */}
        {peerRects.map(r => (
          <div key={r.key} className="absolute pointer-events-none z-20"
            style={{ left: r.left, top: r.top, width: r.width, height: r.height, border: `2px solid ${r.color}` }}>
            <span className="absolute -top-5 left-0 px-1.5 py-0.5 rounded text-2xs font-bold text-white whitespace-nowrap shadow-sm"
              style={{ background: r.color }}>{r.name}</span>
          </div>
        ))}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-white dark:bg-slate-950">
            <div className="flex items-center gap-3 text-slate-500"><Loader2 className="w-5 h-5 animate-spin" /> Загрузка редактора…</div>
          </div>
        )}
      </div>
      </div>

      {/* Пристыкованная колонка. Открыта всегда одна панель: две рядом
          оставляют листу треть окна, а отвечают они на разные вопросы */}
      {phOpen && (
        <LabelBar preview={phPreview} unfilled={phCount}
          onInsert={insertPlaceholder} onFill={fillPlaceholders} onClose={closeDock} />
      )}
      {titleOpen && (
        <TitlePanel
          docId={docId}
          projectId={activeProject?.id || 'default'}
          settings={titleSettings}
          onChange={(next, persist) => { setTitleSettings(next); if (persist) saveNow({ settings: JSON.stringify(next) }); }}
          onClose={closeDock}
        />
      )}
      {versionsOpen && (
        <DocVersionsPanel
          versions={versions}
          fmtDate={fmtDate}
          onSave={async () => { await makeVersion('ручное сохранение'); await loadVersions(); addToast('Версия сохранена', 'success'); }}
          onRestore={restoreVersion}
          onClose={closeDock}
        />
      )}
      {blocksOpen && (
        <BlocksPanel
          blocks={bindingsRef.current.blocks as any}
          stale={staleMap}
          refreshing={refreshingIds}
          tick={blocksTick}
          onRefreshAll={refreshAll}
          onRefresh={refreshBlock}
          onUnlink={unlinkBlock}
          onClose={closeDock}
        />
      )}
      </div>

      {wizardOpen && (
        <DataWizard projectId={activeProject?.id || 'default'} onInsert={handleInsert} onClose={() => setWizardOpen(false)} />
      )}
      {saveConflict && (
        <SaveConflictDialog
          info={saveConflict}
          meName={user?.name || ''}
          onChoose={resolveSaveConflict}
        />
      )}

      {/* Английская версия: сверка сегментов, четыре вида двуязычия */}
      {englishSnap && (
        <EnglishVersion
          snapshot={englishSnap}
          docName={doc?.name || 'Документ'}
          onClose={() => setEnglishSnap(null)}
          onCreate={createEnglish}
        />
      )}

      {/* Русский правили после перевода — английский отстал, и это надо видеть */}
      {stale && (
        <div className="absolute left-1/2 -translate-x-1/2 top-2 z-40 flex items-center gap-2 px-3 py-1.5 rounded-lg
                        border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 shadow-lg">
          <TriangleAlert className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
          <span className="text-2xs text-amber-800 dark:text-amber-300">
            Русский изменился после перевода — английская версия отстала
          </span>
          <button type="button" onClick={openEnglish}
            className="px-2 py-0.5 rounded-md text-2xs font-bold bg-amber-600 hover:bg-amber-700 text-white cursor-pointer">
            Обновить
          </button>
          <button type="button" onClick={() => setStale(null)} aria-label="Скрыть"
            className="p-0.5 rounded text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/40 cursor-pointer">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Панель истории версий: автоснимки и ручные, откат */}
      {/* Одно окно недавних на все программы Flux Office: вернуться ко
          вчерашней работе — самое частое дело, а дорог к нему было две */}
      {recentOpen && (
        <RecentDocsPanel
          projectId={activeProject?.id || null}
          onOpen={(href) => { window.location.hash = `#${href}`; }}
          onClose={() => setRecentOpen(false)}
        />
      )}

      {/* Конфликты: ручная правка против изменившегося значения в проекте */}
      {conflicts && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6">
          <div className="w-full max-w-xl max-h-[75vh] bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-2xl flex flex-col">
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
              <AlertTriangle className="w-4.5 h-4.5 text-amber-500" />
              <h3 className="font-bold text-slate-800 dark:text-white">Конфликты: ваши правки против данных проекта</h3>
            </div>
            <div className="flex-1 overflow-auto divide-y divide-slate-100 dark:divide-slate-850">
              {conflicts.items.map((item, i) => (
                <div key={i} className="px-5 py-3">
                  <div className="text-xs font-bold text-slate-500 dark:text-slate-400">{item.colTitle}</div>
                  <div className="mt-1.5 flex items-center gap-2 text-sm">
                    <span className="px-2 py-1 rounded bg-sky-50 dark:bg-sky-950/30 text-sky-700 dark:text-sky-300 font-mono text-xs">моё: {String(item.userValue)}</span>
                    <span className="text-slate-400">против</span>
                    <span className="px-2 py-1 rounded bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300 font-mono text-xs">из проекта: {String(item.liveValue)}</span>
                    {/* Состояние сохранения держим рядом с названием: у правого края
            оно уезжало за границу панели на ноутбуке. */}
        <span className={`text-xs w-24 shrink-0 ${saveState === 'saving' ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400'}`}>
          {saveState === 'saving' ? 'сохраняю…' : saveState === 'saved' ? 'сохранено' : ''}
        </span>
        <div className="flex-1" />
                    <button type="button" onClick={() => resolveConflict(item, 'mine')} className="text-xs font-bold px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-850 cursor-pointer">Моё</button>
                    <button type="button" onClick={() => resolveConflict(item, 'live')} className="text-xs font-bold px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer">Из проекта</button>
                  </div>
                </div>
              ))}
            </div>
            <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-800 flex justify-end gap-2">
              <button type="button" onClick={() => resolveAllConflicts('mine')}
                className="text-xs font-bold px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-850 cursor-pointer">Все мои</button>
              <button type="button" onClick={() => resolveAllConflicts('live')}
                className="text-xs font-bold px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer">Все из проекта</button>
            </div>
          </div>
        </div>
      )}

      {/* Диалог именования при закрытии (часть III §3.3) */}
      {nameDialog && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-2xl p-5 space-y-4">
            <h3 className="font-bold text-slate-800 dark:text-white">Как назвать документ?</h3>
            <input
              autoFocus
              defaultValue={nameDialog.suggestion}
              onFocus={e => e.target.select()}
              onKeyDown={async e => {
                if (e.key === 'Enter') {
                  const v = (e.target as HTMLInputElement).value.trim();
                  if (v) await saveNow({ name: v });
                  onClose();
                }
              }}
              id="constructor-name-input"
              className="w-full px-3 py-2.5 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-800 dark:text-white focus:outline-none focus:border-emerald-500"
            />
            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={onClose} className="px-3.5 py-2 rounded-lg text-xs font-semibold text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-850 cursor-pointer">
                Оставить черновиком
              </button>
              <button type="button"
                onClick={async () => {
                  const v = (document.getElementById('constructor-name-input') as HTMLInputElement)?.value?.trim();
                  if (v) await saveNow({ name: v });
                  onClose();
                }}
                className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold cursor-pointer">
                Готово
              </button>
            </div>
          </div>
        </div>
      )}
      </EditorFrame>
    </div>
  );
}

// ═══════════════════════ Выбор редактора по типу документа ═══════════════════════
// Таблица (DOC/TEMPLATE) → редактор Univer Sheets; текст (TEXT) → Univer Docs.
// При глубокой ссылке (/constructor?doc=…) тип берётся лёгким запросом meta.
function EditorGate({ docId, knownKind, autoRefresh, onClose }: {
  docId: string; knownKind?: string; autoRefresh?: boolean; onClose: () => void;
}) {
  const [kind, setKind] = useState<string | null>(knownKind || null);
  const { addToast } = useToastStore();

  useEffect(() => {
    if (kind) return;
    let alive = true;
    fetch(`/api/constructor/docs/${docId}/meta`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => { if (alive) setKind(d?.doc?.kind || 'DOC'); })
      .catch(() => { if (alive) { addToast('Не удалось открыть документ', 'error'); onClose(); } });
    return () => { alive = false; };
  }, [docId, kind]);

  if (!kind) {
    return <div className="h-full flex items-center justify-center text-slate-400"><Loader2 className="w-6 h-6 animate-spin" /></div>;
  }
  if (kind === 'TITLE') {
    return <TitleTemplateEditor docId={docId} onClose={onClose} />;
  }
  if (kind === 'TEXT' || kind === 'NOTE') {
    return <TextDocEditor docId={docId} onClose={onClose} />;
  }
  return <DocEditor docId={docId} autoRefresh={autoRefresh} onClose={onClose} />;
}

// ═══════════════════════ Библиотека ═══════════════════════

export default function ConstructorScreen() {
  const user = useStore(s => s.user);
  const activeProject = useStore(s => s.activeProject);
  const { addToast } = useToastStore();
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeDocId, setActiveDocIdRaw] = useState<string | null>(() => searchParams.get('doc'));
  // id документа живёт и в URL — ссылки из Проводника/уведомлений открывают документ сразу
  const setActiveDocId = (id: string | null) => {
    setActiveDocIdRaw(id);
    setSearchParams(id ? { doc: id } : {}, { replace: true });
  };
  // Переход на /constructor?doc=… из Проводника/уведомлений меняет URL уже после
  // монтирования — синхронизируем открытый документ с параметром
  useEffect(() => {
    const fromUrl = searchParams.get('doc');
    if (fromUrl !== activeDocId) setActiveDocIdRaw(fromUrl);
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  // Принесённый файл Word или Excel: разбор в окне, документ заводится один раз
  useOpenFromFile({
    fileId: searchParams.get('fromFile') || '',
    projectId: activeProject?.id || 'default',
    openDoc: (docId) => setSearchParams({ doc: docId }, { replace: true }),
    giveUp: () => setSearchParams({}, { replace: true }),
    say: (text, kind) => addToast(text, kind),
  });
  const [trashOpen, setTrashOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  /**
   * Какая это программа семьи: «Таблица» или «Документ».
   *
   * Экран у них один — и книга, и текст лежат в одной таблице базы, и
   * открывает их один редактор по виду документа. Различаются они тем, ЧТО
   * показывают в библиотеке и что заводит кнопка «Создать». Путь берём из
   * адреса, а не из реестра разделов: реестр подгружает этот экран, и импорт
   * обратно замкнул бы круг.
   */
  const myKind = officeKindForPath(useLocation().pathname);
  // Вкладки: все / таблицы (Эксель) / документы (Ворд). Заметки — в отдельной
  // программе «Блокнот», здесь их нет. Открыта та, ради которой программу и
  // запустили; переключиться на чужую можно — это умолчание, а не запрет
  const [tab, setTab] = useState<'all' | 'sheet' | 'text'>(myKind === 'TEXT' ? 'text' : 'sheet');
  const [docQuery, setDocQuery] = useState('');
  const [docSort, setDocSort] = useState<'updated' | 'name'>('updated');
  const autoRefreshRef = useRef(false); // открыть следующий документ с обновлением блоков

  const projectId = activeProject?.id || 'default';

  const loadDocs = async () => {
    try {
      const res = await fetch(`/api/constructor/docs?projectId=${projectId}`);
      if (res.ok) setDocs((await res.json()).docs || []);
    } catch (_) {}
    setLoading(false);
  };

  useEffect(() => { setLoading(true); loadDocs(); }, [activeProject?.id, activeDocId]);

  const me = user?.id;
  // Фильтр по вкладке: sheet = таблицы (DOC), text = текстовые документы (TEXT)
  const matchesTab = (d: DocMeta) =>
    tab === 'all' ? true : tab === 'sheet' ? d.kind === 'DOC' : d.kind === 'TEXT';
  // Поиск и порядок в списке: при десятках документов вкладок «Все /
  // Таблицы / Документы» уже мало.
  const matchesQuery = (d: DocMeta) => {
    const q = docQuery.trim().toLowerCase();
    return !q || String(d.name || '').toLowerCase().includes(q);
  };
  const sortDocs = (list: DocMeta[]) => {
    const arr = [...list];
    if (docSort === 'name') arr.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru'));
    else arr.sort((a, b) => new Date((b as any).updatedAt || 0).getTime() - new Date((a as any).updatedAt || 0).getTime());
    return arr;
  };
  const alive = sortDocs(docs.filter(d => !d.deletedAt && matchesQuery(d) && (d.kind === 'TEMPLATE' || d.kind === 'TITLE' || matchesTab(d))));
  const templates = alive.filter(d => d.kind === 'TEMPLATE');
  const titleTemplates = alive.filter(d => d.kind === 'TITLE');
  const recents = useMemo(() => {
    if (!me) return [] as DocMeta[];
    try {
      const ids: string[] = JSON.parse(localStorage.getItem(RECENT_KEY(me)) || '[]');
      return ids.map(id => alive.find(d => d.id === id)).filter(Boolean).slice(0, 3) as DocMeta[];
    } catch (_) { return []; }
  }, [docs, me]);
  // «Мои» — по авторству, а не только по приватности (часть III §1)
  const isLibraryTemplate = (d: DocMeta) => d.kind === 'TEMPLATE' || d.kind === 'TITLE';
  const myDocs = alive.filter(d => !isLibraryTemplate(d) && (d.scope === 'PERSONAL' ? d.ownerId === me : d.createdById === me));
  const sharedDocs = alive.filter(d => !isLibraryTemplate(d) && d.scope === 'SHARED');
  const trash = docs.filter(d => d.deletedAt);

  // Создание: таблица (DOC), документ (TEXT) или шаблон титула (TITLE)
  const createDoc = async (kind: 'DOC' | 'TEXT' | 'TITLE' = 'DOC') => {
    // Имя спрашиваем сразу: иначе документ называется «Без названия — 2
    // августа», и через неделю в списке невозможно понять, что это.
    const what = kind === 'TEXT' ? 'документ' : kind === 'TITLE' ? 'шаблон титула' : 'таблицу';
    const example = kind === 'TEXT' ? 'Например: Пояснительная записка'
      : kind === 'TITLE' ? 'Например: Титул для заказчика «Азот»'
      : 'Например: Ведомость вентиляции';
    const name = await openPrompt(`Как назвать ${what}?`, 'Название можно изменить позже.', example);
    if (name === null) return; // отмена — документ не создаём

    const res = await fetch('/api/constructor/docs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, ...(kind !== 'DOC' ? { kind } : {}), ...(name.trim() ? { name: name.trim() } : {}) }),
    });
    if (res.ok) {
      const { doc } = await res.json();
      loadDocs(); // список знает kind нового документа до открытия
      setActiveDocId(doc.id);
    } else addToast('Не удалось создать документ', 'error');
  };

  const patchDoc = async (id: string, body: any, okMsg?: string) => {
    const res = await fetch(`/api/constructor/docs/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (res.ok) { if (okMsg) addToast(okMsg, 'success'); loadDocs(); }
    else { const d = await res.json().catch(() => ({})); addToast(d.error || 'Ошибка', 'error'); }
  };

  const duplicateDoc = async (id: string) => {
    const res = await fetch(`/api/constructor/docs/${id}/duplicate`, { method: 'POST' });
    if (res.ok) { addToast('Документ продублирован', 'success'); loadDocs(); }
  };

  // «Создать документ» из шаблона: копия как DOC + свежие данные при открытии
  const createFromTemplate = async (tmpl: DocMeta) => {
    const res = await fetch(`/api/constructor/docs/${tmpl.id}/duplicate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'DOC', name: tmpl.name }),
    });
    if (res.ok) {
      const { doc } = await res.json();
      autoRefreshRef.current = true;
      setActiveDocId(doc.id);
    } else addToast('Не удалось создать документ по шаблону', 'error');
  };

  const deleteForever = async (id: string) => {
    if (!await openConfirm('Удалить документ?', 'Документ и все его версии будут удалены. Действие необратимо.', { confirmLabel: 'Удалить', tone: 'danger' })) return;
    const res = await fetch(`/api/constructor/docs/${id}`, { method: 'DELETE' });
    if (res.ok) { addToast('Документ удалён', 'success'); loadDocs(); }
    else { const d = await res.json().catch(() => ({})); addToast(d.error || 'Ошибка', 'error'); }
  };

  if (activeDocId) {
    const ar = autoRefreshRef.current;
    autoRefreshRef.current = false;
    return <EditorGate docId={activeDocId} knownKind={docs.find(d => d.id === activeDocId)?.kind} autoRefresh={ar} onClose={() => { setActiveDocId(null); loadDocs(); }} />;
  }

  return (
    <DocLibrary
      loading={loading}
      myKind={myKind}
      tab={tab} onTab={setTab}
      query={docQuery} onQuery={setDocQuery}
      sort={docSort} onSort={setDocSort}
      recents={recents}
      myDocs={myDocs}
      sharedDocs={sharedDocs.filter(d => d.createdById !== me)}
      templates={templates}
      titleTemplates={titleTemplates}
      trash={trash}
      trashOpen={trashOpen} onTrashOpen={setTrashOpen}
      onOpen={setActiveDocId}
      onCreate={createDoc}
      onDuplicate={duplicateDoc}
      onPatch={patchDoc}
      onFromTemplate={createFromTemplate}
      onDeleteForever={deleteForever}
    />
  );
}
