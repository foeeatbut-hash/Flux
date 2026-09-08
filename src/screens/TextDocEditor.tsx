import React, { useEffect, useRef, useState } from 'react';
import { useRibbonFold } from '../components/ribbon/useRibbonFold';
import { useStore } from '../store/store';
import { useToastStore } from '../store/toastStore';
import { Loader2, FileText, StickyNote } from 'lucide-react';
import TitlePanel, { fetchTitlePageHtml, buildPageTemplates, fetchRevisionsSheetHtml, TitleSettings } from './TitlePanel';
import { useModalStore } from '../store/modalStore';
import {
  buildDocHtml, safeFileName, DOC_FONTS,
  readPageSetup, applyPageSetup, PageSetup, pageOf,
} from '../lib/docExport';
import { emptyDocSnapshot, normalizeDocSnapshot } from '../lib/docSnapshot';
import DocRuler from '../components/DocRuler';
import ParagraphSpacingMenu from '../components/ParagraphSpacingMenu';
import PageSetupDialog from '../components/PageSetupDialog';
import DocVersionsPanel from '../components/DocVersionsPanel';
import RevisionDialog from '../components/office/RevisionDialog';
import DataFieldsPanel from '../components/DataFieldsPanel';
import RecentDocsPanel from '../components/office/RecentDocsPanel';
import { rememberDoc } from '../store/recentStore';
import { describeParagraph, type RulerModel } from '../lib/docStyle';
import {
  patchParagraphs, patchDocumentStyle, readParagraphStyle, readZoom, type EngineCtx,
} from '../lib/docEngine';
import EditorFrame from '../components/ribbon/EditorFrame';
import { useWindowTitle } from '../lib/paneTitle';
import { docRibbon, DOC_TEXT_COLORS, DOC_MARK_COLORS } from '../lib/ribbonDoc';
import { editorFileMenu } from '../lib/ribbonFile';
import { useEscape } from '../lib/useEscape';
import { type ConflictChoice } from '../lib/docConflict';
import SaveConflictDialog from '../components/SaveConflictDialog';
import { useDocRoom } from '../components/collab/useDocRoom';
import { dataService } from '../services/dataService';
import { wordBytes, wordToExplorer } from '../lib/docOutput';
import { saveBytes } from '../lib/saveToWindows';
import { useDocLabels } from '../components/doc/useDocLabels';

// Диалоги программы вместо системных окон Windows
const { openConfirm } = useModalStore.getState();

// ── Текстовый документ (Ворд) — редактор студии Конструктора ──
// Тот же движок Univer, что и у таблиц, но документный пресет: страницы А4,
// шрифты и стили, списки, таблицы, поиск, отмена/повтор. Хранение — снапшот
// IDocumentData в ConstructorDoc.workbook (общие маршруты: автосейв, версии,
// корзина, зеркало в Проводнике). Дизайн: docs/docs-studio-design.md.

function fmtDate(s: string) {
  try { return new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch (_) { return s; }
}

/**
 * Скачать файл под нужным именем.
 *
 * Ссылку обязательно кладём в страницу: у ссылки вне документа браузер
 * игнорирует атрибут download и сохраняет файл как «download» — без имени и
 * без расширения, Ворд такой файл не открывает.
 */
function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
}

// Плоский текст документа из снапшота (для экспорта TXT и поиска)
function snapshotToPlainText(snap: any): string {
  const ds: string = snap?.body?.dataStream || '';
  // \r — конец абзаца, \n — конец секции; служебные маркеры объектов отсекаем
  return ds.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/\r/g, '\n').replace(/\n+$/, '');
}

// Сборка печатного HTML и файла для Ворда живёт в ./docExport — там же её тесты
// (scripts/test-doc-export.ts). Прежняя версия лежала здесь и незаметно теряла
// шрифт абзаца, выравнивание и поля страницы.


export default function TextDocEditor({ docId, onClose }: { docId: string; onClose: () => void }) {
  const user = useStore(s => s.user);
  const activeProject = useStore(s => s.activeProject);
  const { addToast } = useToastStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const univerRef = useRef<any>(null);
  const fdocRef = useRef<any>(null);         // FDocument для вставки текста
  const lastSavedRef = useRef<string>('');
  const [doc, setDoc] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'idle'>('idle');
  const [nameDialog, setNameDialog] = useState(false);
  /**
   * Какая панель пристыкована справа. Одна на три, а не три флажка: три
   * пристыкованные колонки оставили бы листу треть окна, а наложенные — как
   * было — закрывали ровно тот кусок, ради которого их открывали.
   */
  const [dock, setDock] = useState<'title' | 'fields' | 'versions' | null>(null);
  const closeDock = () => setDock(null);
  const toggleDock = (p: 'title' | 'fields' | 'versions') =>
    setDock((cur) => (cur === p ? null : p));
  const versionsOpen = dock === 'versions';
  const [versions, setVersions] = useState<{ id: string; version: number; comment: string; createdAt: string }[]>([]);
  const [reloadTick, setReloadTick] = useState(0);
  const [counts, setCounts] = useState({ words: 0, chars: 0 });
  const dataOpen = dock === 'fields'; // панель меток данных
  const docLabels = useDocLabels({
    projectId: activeProject?.id || 'default',
    plainText: () => snapshotToPlainText(JSON.parse(takeSnapshot() || '{}')),
    replaceText: (from, to) => fdocRef.current?.replaceText?.(from, to),
    save: (bindings) => { saveNow({ bindings }); },
    say: (message, kind) => addToast(message, kind),
  });
  // ── Титул: присвоенный шаблон + реквизиты именно этого документа ──
  const titleOpen = dock === 'title';
  const [settings, setSettings] = useState<TitleSettings>({});
  // ── Линейка и стиль абзаца под курсором ──
  // Состояние обновляется по командам движка (курсор, правка, масштаб): линейка
  // должна показывать отступы того абзаца, в котором человек сейчас стоит.
  const [ruler, setRuler] = useState<{ model: RulerModel; pxPerPt: number; leftPx: number; topPx: number; hasSelection: boolean } | null>(null);
  const [paraStyle, setParaStyle] = useState<any>(null);
  const presetRef = useRef<any>(null);       // модуль пресета: служба выделения и масштаб

  // «Разметка страницы» — формат листа, ориентация, поля (как в Ворде)
  const [pageDialog, setPageDialog] = useState(false);
  const [pageSetup, setPageSetup] = useState<PageSetup | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  // «Выпустить ревизию» — для документов, привязанных к строке ВДР
  const [revDialog, setRevDialog] = useState(false);
  const [revPlace, setRevPlace] = useState('');
  const [revDesc, setRevDesc] = useState('');
  const [revBusy, setRevBusy] = useState(false);

  const issueRevision = async (kind: 'next' | 'certify') => {
    if (!settings.vdrItemId) return;
    setRevBusy(true);
    try {
      const r = await fetch(`/api/vdr/items/${settings.vdrItemId}/issue-revision`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, place: revPlace, description: revDesc }),
      });
      if (!r.ok) { addToast('Не удалось выпустить ревизию', 'error'); return; }
      const d = await r.json();
      setSettings(s => ({ ...s, docMeta: { ...s.docMeta, revision: d.item.revision } }));
      addToast(`Выпущена ревизия ${d.item.revision}`, 'success');
      setRevDialog(false); setRevPlace(''); setRevDesc('');
      // Снимок версии документа — ревизия зафиксирована и в истории Конструктора
      makeVersion(`ревизия ${d.item.revision}`);
    } finally { setRevBusy(false); }
  };

  // ── Совместное редактирование (как у таблиц): комната документа ──
  const applyingRemoteRef = useRef(false);
  /**
   * Правил ли этот человек страницу с прошлой записи. Разницы снимков для
   * этого мало: снимок меняется и от чужой операции, и от приведения документа
   * к порядку при открытии, — а своя мутация окну известна точно.
   */
  const myEditRef = useRef(false);
  /**
   * Время, с которым это окно прочитало документ. Без него автосохранение
   * текстового документа клало мою страницу поверх чужой правки молча — та же
   * беда, от которой у таблиц давно стоит сверка (см. src/lib/docConflict.ts).
   */
  const baseRef = useRef<string>('');
  const [saveConflict, setSaveConflict] = useState<{ who: string; at: string | null } | null>(null);
  const saveConflictRef = useRef(false);

  const takeSnapshot = (): string => {
    try {
      const d = univerRef.current?.univerAPI?.getActiveDocument?.();
      const data = d?.getSnapshot?.();
      return data ? JSON.stringify(data) : '';
    } catch (_) { return ''; }
  };

  const saveNow = async (extra?: Record<string, any>, force = false) => {
    // Пока столкновение не разобрано, окно молчит: иначе оно повторяло бы
    // отказ каждые две с половиной секунды
    if (saveConflictRef.current && !force) return;
    // Связи с комнатой нет, а в документе кто-то есть: чужие правки до меня не
    // доходят, и запись своей страницы целиком легла бы поверх них
    if (roomRef.current?.hold.current && !force) return;
    const snapshot = takeSnapshot();
    if (!snapshot && !extra) return;
    if (snapshot === lastSavedRef.current && !extra && !force) return;
    setSaveState('saving');
    try {
      const res = await fetch(`/api/constructor/docs/${docId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(snapshot ? { workbook: snapshot } : {}),
          ...(extra || {}),
          baseUpdatedAt: baseRef.current,
          ...(force ? { force: true } : {}),
        }),
      });
      if (res.ok) {
        if (snapshot) { lastSavedRef.current = snapshot; myEditRef.current = false; }
        const d = await res.json();
        setDoc(d.doc);
        baseRef.current = d.doc?.updatedAt || baseRef.current;
        roomRef.current?.send('constructor:saved', { docId, at: baseRef.current });
        saveConflictRef.current = false;
        setSaveConflict(null);
        setSaveState('saved');
        return;
      }
      const d = await res.json().catch(() => ({}));
      if (res.status === 409 && d.conflict) {
        // Разбор вместо записи. Текст человека цел — он на экране
        saveConflictRef.current = true;
        setSaveConflict({ who: d.who || '', at: d.at || null });
        setSaveState('idle');
        return;
      }
      if (d.error) addToast(d.error, 'error');
      setSaveState('idle');
    } catch (_) { setSaveState('idle'); }
  };

  /** Три выхода из столкновения — те же, что у таблиц, и с тем же смыслом */
  const resolveSaveConflict = async (choice: ConflictChoice) => {
    saveConflictRef.current = false;
    setSaveConflict(null);
    if (choice === 'theirs') {
      lastSavedRef.current = '';
      setLoading(true);
      setReloadTick(t => t + 1);
      return;
    }
    if (choice === 'mine') {
      await saveNow(undefined, true);
      addToast('Сохранено. Правка коллеги — в истории версий', 'success');
      return;
    }
    try {
      await dataService.forkDoc(docId, takeSnapshot(), `${doc?.name || 'Документ'} — моя правка`);
      addToast('Ваша правка сохранена отдельным документом', 'success');
      lastSavedRef.current = '';
      setLoading(true);
      setReloadTick(t => t + 1);
    } catch (_) {
      addToast('Не удалось создать копию — правка осталась на экране', 'error');
      saveConflictRef.current = true;
      setSaveConflict({ who: '', at: null });
    }
  };

  /**
   * Комната документа: кто здесь ещё, чужие правки и поведение при обрыве
   * связи. Решение после возвращения принимает collab.afterReconnect.
   */
  const room = useDocRoom({
    docId,
    ready: !loading,
    applyOp: (op) => {
      applyingRemoteRef.current = true;
      try { univerRef.current?.univerAPI?.executeCommand(op.id, op.params, { fromCollab: true } as any); }
      catch (_) { /* операция чужого движка не подошла — своя страница цела */ }
      finally { setTimeout(() => { applyingRemoteRef.current = false; }, 0); }
    },
    isDirty: () => myEditRef.current,
    onResync: () => { lastSavedRef.current = ''; setLoading(true); setReloadTick(t => t + 1); },
    onResolve: () => { void saveNow(); },
    onNote: (text) => addToast(text, 'info'),
    onPeerSaved: (at) => { baseRef.current = at; },
  });
  const roomRef = useRef(room);
  roomRef.current = room;
  const peers = room.peers;

  // Страховка от вылета: несохранённый снапшот уходит keepalive-запросом
  useEffect(() => {
    const flushOnClose = () => {
      try {
        const snapshot = takeSnapshot();
        if (!snapshot || snapshot === lastSavedRef.current) return;
        fetch(`/api/constructor/docs/${docId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workbook: snapshot }),
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

  // Инициализация движка: документный пресет Univer (страницы как в Ворде)
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
        baseRef.current = loaded.updatedAt || '';
        myEditRef.current = false;      // документ прочитан заново — своих правок нет
        saveConflictRef.current = false;
        setSaveConflict(null);
        try { setSettings(loaded.settings ? JSON.parse(loaded.settings) : {}); } catch (_) { setSettings({}); }

        // Ядро документов + гиперссылки + картинки (drawing) — ближе к Ворду
        const pick = (m: any) => m.default ?? m;
        const [{ createUniver, LocaleType, mergeLocales, defaultTheme }, docsPreset, linkP, drawP, ruRU, linkRu, drawRu] = await Promise.all([
          import('@univerjs/presets'),
          import('@univerjs/presets/preset-docs-core'),
          import('@univerjs/presets/preset-docs-hyper-link'),
          import('@univerjs/presets/preset-docs-drawing'),
          import('@univerjs/presets/preset-docs-core/locales/ru-RU'),
          import('@univerjs/presets/preset-docs-hyper-link/locales/ru-RU'),
          import('@univerjs/presets/preset-docs-drawing/locales/ru-RU'),
        ]);
        await Promise.all([
          import('@univerjs/presets/lib/styles/preset-docs-core.css'),
          import('@univerjs/presets/lib/styles/preset-docs-hyper-link.css'),
          import('@univerjs/presets/lib/styles/preset-docs-drawing.css'),
        ]);
        if (disposed || !containerRef.current) return;

        const { univer, univerAPI } = createUniver({
          locale: LocaleType.RU_RU,
          locales: { [LocaleType.RU_RU]: mergeLocales(pick(ruRU), pick(linkRu), pick(drawRu)) },
          theme: defaultTheme,
          presets: [
            (docsPreset as any).UniverDocsCorePreset({
              container: containerRef.current,
              // Своя лента рисуется поверх (components/ribbon), родной панели
              // движка нет вовсе: две панели с разными отступами и цветами —
              // это два разных места для одного и того же действия
              header: false,
              toolbar: false,
              footer: false,
              ribbonType: 'classic',
            }),
            (linkP as any).UniverDocsHyperLinkPreset(),
            (drawP as any).UniverDocsDrawingPreset(),
          ],
        });
        univerRef.current = { univer, univerAPI };
        // Модуль пресета держим у себя: из него берём службу выделения и
        // масштаб полотна — ядро их наружу не отдаёт
        presetRef.current = docsPreset;

        // Список шрифтов в ленте. Через настройку пресета не проходит — он
        // пропускает только часть полей (customFontFamily среди них нет), это
        // видно по тому, что в списке оставались китайские шрифты. Поэтому
        // правим сам справочник шрифтов движка: убираем всё лишнее и кладём
        // свой набор в нужном порядке.
        try {
          const fontService: any = (univer as any).__getInjector?.().get((docsPreset as any).IFontService);
          if (fontService?.getFonts) {
            for (const f of [...fontService.getFonts()]) fontService.removeFont(f.value);
            for (const f of DOC_FONTS) fontService.addFont({ ...f });
          }
        } catch (_) {
          // Не вышло — в ленте останется список движка. Документ от этого не
          // страдает: шрифт можно вписать руками, а выгрузка его сохранит.
        }

        let snapshot: any = null;
        try { snapshot = loaded.workbook ? JSON.parse(loaded.workbook) : null; } catch (_) {}
        // Пустого снапшота движку недостаточно — даём валидный чистый лист
        const isNew = !snapshot || !snapshot.body;
        // Сохранённые до этой правки документы лежат без headers/footers/
        // tableSource — в них не вставить ни колонтитул, ни таблицу. Чиним при
        // открытии, а не миграцией базы: снапшот и так разбирается здесь.
        snapshot = isNew ? emptyDocSnapshot(loaded.id, loaded.name) : normalizeDocSnapshot(snapshot);
        const fdoc = univerAPI.createUniverDoc(snapshot);
        fdocRef.current = fdoc;
        lastSavedRef.current = loaded.workbook || '';

        // Метки документа: что и откуда сюда подставлено. Без этого чтения
        // документ, открытый заново, забывал бы свои метки, и «Обновить
        // данные» честно отвечало бы «меток нет» на документе, полном меток
        docLabels.load(loaded.bindings);

        // Импорт из файла Проводника: содержимое вставляется при первом
        // открытии (сервер положил plain-текст в bindings.importText)
        if (isNew) {
          let parsed: any = null;
          try { parsed = loaded.bindings ? JSON.parse(loaded.bindings) : null; } catch (_) {}
          const importText = String(parsed?.importText || '');
          if (importText) {
            let landed = false;
            try {
              await fdoc?.appendText?.(importText);
              // Спрашиваем сам документ, а не ответ движка: `appendText` в
              // разных сборках возвращает то себя, то ничего, и по нему успех
              // от неудачи не отличить
              landed = snapshotToPlainText(fdoc?.getSnapshot?.())
                .includes(importText.trim().slice(0, 40));
            } catch (_) {}
            if (landed) {
              // Текст на месте — задание импорта снимаем, метки оставляем
              setTimeout(() => saveNow({ bindings: docLabels.bindings() }), 800);
            } else {
              // Вставка не удалась. Задание НЕ снимаем: раньше снимали сразу, и
              // текст пропадал навсегда — документ открывался пустым при каждом
              // следующем открытии, а причину было уже не найти
              addToast('Текст из файла вставить не удалось. Он не потерян: закройте документ и откройте заново', 'error');
            }
          }
        }

        // Мои мутации → остальным участникам комнаты (useDocRoom)
        const cmdDisposer = univerAPI.onCommandExecuted((command: any, options: any) => {
          // Линейка следит за курсором, правкой и масштабом — иначе она
          // показывала бы отступы того абзаца, где человек стоял раньше
          scheduleRulerRefresh();
          if (applyingRemoteRef.current || options?.fromCollab || options?.fromChangeset) return;
          if (command?.type !== 2) return; // MUTATION
          const cmdId = String(command.id || '');
          if (!cmdId.startsWith('doc.mutation.')) return;
          myEditRef.current = true;
          roomRef.current.send('constructor:op', { docId, op: { id: cmdId, params: command.params } });
        });
        (univerRef.current as any).cmdDisposer = cmdDisposer;

        setLoading(false);
        // Первый пересчёт после того, как движок разложил страницу
        setTimeout(() => { if (!disposed) refreshRuler(); }, 400);
      } catch (err: any) {
        console.error('[Constructor] Ошибка инициализации текстового редактора:', err);
        addToast('Не удалось загрузить редактор документов', 'error');
        onClose();
      }
    })();

    /*
      Автосохранение: раз в 2,5 с и ТОЛЬКО если правка моя.

      Раньше признаком было «снимок изменился». Но снимок меняется и тогда,
      когда приехала чужая правка, — и окно записывало на сервер документ,
      которого само не правило. Если такой тик попадал между записью коллеги и
      сообщением «коллега записал», окно писало со старым временем чтения и
      получало отказ: человеку показывали разбор столкновения там, где он
      вообще ничего не делал. Признак «правка моя» в программе был, спрашивать
      его забыли.
    */
    const timer = setInterval(() => { if (myEditRef.current) saveNow(); }, 2500);
    return () => {
      disposed = true;
      clearInterval(timer);
      try { (univerRef.current as any)?.cmdDisposer?.dispose?.(); } catch (_) {}
      // Движок держит свой корень React. Снести его прямо здесь нельзя: уборка
      // эффекта идёт внутри отрисовки, и React ругается «нельзя размонтировать
      // корень во время отрисовки». Отпускаем в следующий тик — к этому моменту
      // отрисовка закончена.
      const dying = univerRef.current;
      univerRef.current = null;
      fdocRef.current = null;
      presetRef.current = null;
      clearTimeout(rulerTimerRef.current);
      setTimeout(() => { try { dying?.univer?.dispose?.(); } catch (_) {} }, 0);
    };
  }, [docId, reloadTick]);

  // Полотно меняет ширину при сворачивании боковой панели и окна — линейка
  // должна оставаться ровно над листом
  useEffect(() => {
    const box = containerRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => scheduleRulerRefresh());
    ro.observe(box);
    return () => ro.disconnect();
  }, [loading]);

  // ── Линейка: пересчёт и перетаскивание ──
  // Команды движка идут пачками (одно нажатие клавиши — несколько команд),
  // поэтому пересчёт откладываем, а не считаем на каждую
  const rulerTimerRef = useRef<any>(null);
  const scheduleRulerRefresh = () => {
    clearTimeout(rulerTimerRef.current);
    rulerTimerRef.current = setTimeout(() => refreshRuler(), 120);
  };

  const engineCtx = (): EngineCtx | null => {
    const u = univerRef.current;
    const fdoc = fdocRef.current;
    if (!u || !fdoc || !presetRef.current) return null;
    return { univer: u.univer, univerAPI: u.univerAPI, preset: presetRef.current, fdoc };
  };

  const refreshRuler = () => {
    const ctx = engineCtx();
    const box = containerRef.current;
    if (!ctx || !box) return;
    let snap: any = {};
    try { snap = ctx.fdoc.getSnapshot?.() || {}; } catch (_) { return; }
    const page = pageOf(snap);
    const st = readParagraphStyle(ctx);      // null — курсора в тексте нет
    const d = describeParagraph(st);
    setParaStyle(st);
    // Лист движок рисует по центру полотна, пункт в пиксель на масштаб
    const pxPerPt = readZoom(ctx);
    const widthPx = page.widthPt * pxPerPt;

    // Место линейки считаем по самому полотну, а не по всей области редактора:
    // сверху внутри неё лежит лента движка, и от её высоты зависит, где
    // начинается лист. В Ворде линейка стоит между лентой и листом — тут так же.
    const canvas = box.querySelector('canvas');
    const cRect = canvas?.getBoundingClientRect();
    const bRect = box.getBoundingClientRect();
    const topPx = cRect ? Math.max(0, Math.round(cRect.top - bRect.top)) : 0;
    const centerPx = cRect ? (cRect.left - bRect.left) + cRect.width / 2 : box.clientWidth / 2;

    // Слова и знаки для строки состояния: считаем здесь же — refreshRuler
    // и так вызывается на каждую правку и на каждое движение курсора
    try {
      const text = snapshotToPlainText(snap);
      const words = (text.match(/[А-Яа-яA-Za-zЁё0-9]+/g) || []).length;
      setCounts({ words, chars: text.replace(/\s/g, '').length });
    } catch (_) {}

    setRuler({
      model: {
        pageWidthPt: page.widthPt,
        marginLeftPt: page.left,
        marginRightPt: page.right,
        firstLinePt: d.firstLinePt,
        indentStartPt: d.startPt,
        indentEndPt: d.endPt,
      },
      pxPerPt,
      leftPx: Math.max(0, centerPx - widthPx / 2),
      topPx,
      hasSelection: st !== null,
    });
  };

  // Поля страницы — свойство документа, применяем сразу и без перезагрузки
  const dragMargins = (patch: { marginLeftPt?: number; marginRightPt?: number }) => {
    const ctx = engineCtx();
    if (!ctx) return;
    const next: Record<string, number> = {};
    if (patch.marginLeftPt !== undefined) next.marginLeft = patch.marginLeftPt;
    if (patch.marginRightPt !== undefined) next.marginRight = patch.marginRightPt;
    if (!patchDocumentStyle(ctx, next)) { addToast('Не удалось изменить поля', 'error'); return; }
    refreshRuler();
    saveNow();
  };

  // Отступы — свойство выделенных абзацев, а не всего документа
  const dragIndents = (patch: { firstLinePt?: number; indentStartPt?: number; indentEndPt?: number }) => {
    const ctx = engineCtx();
    if (!ctx) return;
    const next: any = {};
    if (patch.firstLinePt !== undefined) next.indentFirstLine = { v: patch.firstLinePt };
    if (patch.indentStartPt !== undefined) next.indentStart = { v: patch.indentStartPt };
    if (patch.indentEndPt !== undefined) next.indentEnd = { v: patch.indentEndPt };
    if (!patchParagraphs(ctx, next)) { addToast('Поставьте курсор в текст', 'error'); return; }
    refreshRuler();
    saveNow();
  };

  /** Интервалы и красная строка — к выделенным абзацам */
  const applyParagraph = (patch: any) => {
    const ctx = engineCtx();
    if (!ctx) { addToast('Редактор ещё загружается', 'error'); return; }
    if (!patchParagraphs(ctx, patch)) { addToast('Поставьте курсор в текст', 'error'); return; }
    refreshRuler();
    saveNow();
  };

  /**
   * Вставка метки: значение проекта или тега в позицию курсора.
   *
   * В документ попадает значение, а не код: документ уходит в Word и к
   * заказчику, где считать некому. Но откуда значение взято — документ теперь
   * ПОМНИТ, и по кнопке «Обновить данные» метки оживают. Раньше здесь
   * вставлялся мёртвый текст, и шифр проекта в записке застывал навсегда,
   * пока в ведомости он же оставался живым. Правила и хранение меток —
   * src/lib/docLabels.ts и ../components/doc/useDocLabels.
   */
  const insertField = async (text: string, source?: { fn: string; args: string[] }) => {
    const fdoc = fdocRef.current;
    if (!fdoc) return;
    try {
      if (fdoc.insertText) await fdoc.insertText(text);
      else await fdoc.appendText?.(text);
      if (source && text) docLabels.record(text, source);
      setTimeout(() => saveNow(source && text ? { bindings: docLabels.bindings() } : undefined), 400);
    } catch (_) { addToast('Не удалось вставить значение', 'error'); }
  };

  // ── Версии (общие маршруты с таблицами) ──
  const makeVersion = async (comment: string) => {
    try {
      await saveNow();
      await fetch(`/api/constructor/docs/${docId}/versions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment }),
      });
    } catch (_) {}
  };

  const loadVersions = async () => {
    try {
      const r = await fetch(`/api/constructor/docs/${docId}/versions`);
      if (r.ok) setVersions((await r.json()).versions || []);
    } catch (_) {}
  };

  const restoreVersion = async (v: { id: string; version: number }) => {
    if (!await openConfirm(`Восстановить версию ${v.version}?`, 'Текущее состояние сохранится отдельной версией — ничего не потеряется.', { confirmLabel: 'Восстановить' })) return;
    const r = await fetch(`/api/constructor/docs/${docId}/restore/${v.id}`, { method: 'POST' });
    if (!r.ok) { addToast('Не удалось восстановить версию', 'error'); return; }
    addToast(`Восстановлена версия ${v.version}`, 'success');
    closeDock();
    setLoading(true);
    setReloadTick(t => t + 1);
  };

  // ── Печать / PDF / Ворд / экспорт ──
  // Полный документ: титульный лист и лист ревизий (уже со значениями формул,
  // их подставляет сервер) + тело документа. forWord добавляет разметку, по
  // которой Ворд открывает файл своим документом с нашими полями листа.
  const buildFullHtml = async (forWord = false): Promise<string> => {
    const snap = JSON.parse(takeSnapshot() || '{}');
    const [title, revSheet] = await Promise.all([
      fetchTitlePageHtml(docId, settings.titleTemplateId),
      fetchRevisionsSheetHtml(settings),
    ]);
    const front = (title || '') + (revSheet || '');
    return buildDocHtml(snap, {
      title: doc?.name || 'Документ',
      subtitle: `${activeProject?.name || ''} · ${new Date().toLocaleDateString('ru-RU')} · Flux Office`,
      titlePageHtml: front || undefined,
    }, forWord);
  };

  const handlePrint = async () => {
    try {
      const html = await buildFullHtml();
      const w = window.open('', '_blank');
      if (!w) { addToast('Всплывающее окно заблокировано', 'error'); return; }
      w.document.write(html);
      w.document.close();
      setTimeout(() => { try { w.print(); } catch (_) {} }, 400);
    } catch (_) { addToast('Ошибка подготовки печати', 'error'); }
  };

  const handlePdf = async () => {
    try {
      const win = window as any;
      if (win.electron?.ipcRenderer?.invoke) {
        const hf = await buildPageTemplates(docId, settings);
        const r = await win.electron.ipcRenderer.invoke('print:to-pdf', { html: await buildFullHtml(), title: doc?.name || 'Документ', ...hf });
        if (r?.success) addToast('PDF сохранён', 'success');
        else if (!r?.canceled) addToast(r?.error || 'Не удалось сохранить PDF', 'error');
      } else handlePrint();
    } catch (_) { addToast('Ошибка экспорта PDF', 'error'); }
  };

  /**
   * Выгрузка в Word — настоящим файлом `.docx`.
   *
   * Раньше отсюда уходил HTML с расширением `.doc`. Word открывал его с
   * предупреждением «формат не соответствует расширению», и человек, отправивший
   * документ заказчику, каждый раз объяснял получателю, что это нормально.
   * Сборка файла живёт в src/lib/docOutput.ts — там же её проверки.
   */
  const exportWord = async () => {
    try {
      const name = doc?.name || 'Документ';
      const bytes = await wordBytes(await buildFullHtml(true), JSON.parse(takeSnapshot() || '{}'));
      const out = await saveBytes(safeFileName(name, 'docx'), bytes);
      if (out.canceled) return;
      addToast(out.ok ? `Документ Word сохранён: ${out.path || name}` : (out.error || 'Не удалось сохранить'), out.ok ? 'success' : 'error');
    } catch (_) { addToast('Не удалось выгрузить в Ворд', 'error'); }
  };

  // Тот же файл, но в общий Проводник — чтобы отдать коллеге, не пересылая почтой
  const wordToExplorerFile = async () => {
    try {
      const fileName = safeFileName(doc?.name || 'Документ', 'docx');
      const bytes = await wordBytes(await buildFullHtml(true), JSON.parse(takeSnapshot() || '{}'));
      await wordToExplorer(bytes, fileName, user?.id || null);
      addToast(`«${fileName}» сохранён в Проводник`, 'success');
    } catch (_) { addToast('Не удалось сохранить в Проводник', 'error'); }
  };

  const exportTxt = () => {
    try {
      const text = snapshotToPlainText(JSON.parse(takeSnapshot() || '{}'));
      download(new Blob([text], { type: 'text/plain;charset=utf-8' }),
        safeFileName(doc?.name || 'Документ', 'txt'));
    } catch (_) { addToast('Ошибка экспорта', 'error'); }
  };

  const exportToExplorer = async () => {
    try {
      const text = snapshotToPlainText(JSON.parse(takeSnapshot() || '{}'));
      const b64 = btoa(unescape(encodeURIComponent(text)));
      const fileName = `${doc?.name || 'Документ'}.txt`;
      const res = await fetch('/api/files', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: fileName, filePath: `/shared/${fileName}`, type: 'TXT',
          size: text.length, content: b64, createdById: user?.id || null,
        }),
      });
      if (!res.ok) throw new Error('files failed');
      addToast(`«${fileName}» сохранён в Проводник`, 'success');
    } catch (_) { addToast('Не удалось сохранить в Проводник', 'error'); }
  };

  // ── Разметка страницы ──
  // Движок читает размер листа и поля из снапшота при создании документа,
  // поэтому меняем снапшот, сохраняем и пересоздаём редактор — лист сразу
  // становится нужного формата, и печать с выгрузкой берут те же значения.
  const openPageDialog = () => {
    try { setPageSetup(readPageSetup(JSON.parse(takeSnapshot() || '{}'))); }
    catch (_) { setPageSetup(readPageSetup({})); }
    setPageDialog(true);
  };

  // Настройку берём из окна, а не из своего состояния: окно правит свою копию,
  // и чтение здешней (ещё не тронутой) означало бы «Применить» без действия
  const applyPageDialog = async (chosen: PageSetup) => {
    if (!chosen) return;
    try {
      const snap = JSON.parse(takeSnapshot() || '{}');
      if (!snap.body) { addToast('Документ ещё загружается', 'error'); return; }
      const next = applyPageSetup(snap, chosen);
      const res = await fetch(`/api/constructor/docs/${docId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workbook: JSON.stringify(next) }),
      });
      if (!res.ok) { addToast('Не удалось изменить разметку', 'error'); return; }
      lastSavedRef.current = JSON.stringify(next);
      setPageDialog(false);
      setLoading(true);
      setReloadTick(t => t + 1);   // пересоздаём движок с новым листом
      addToast('Разметка страницы применена', 'success');
    } catch (_) { addToast('Не удалось изменить разметку', 'error'); }
  };

  const handleClose = async () => {
    await saveNow();
    if (doc && !doc.named) { setNameDialog(true); return; }
    onClose();
  };

  const isAuthor = !doc?.createdById || doc?.createdById === user?.id || user?.role === 'ADMIN';

  // Имя окна — имя документа: два документа рядом иначе неразличимы
  useWindowTitle(doc?.name || '');

  // То же, что у таблицы: список недавних один на все программы Flux Office
  useEffect(() => {
    if (!doc?.name) return;
    rememberDoc({
      href: `/doc?doc=${docId}`, title: doc.name, kind: 'text',
      at: Date.now(), projectId: activeProject?.id,
    });
  }, [docId, doc?.name, activeProject?.id]);

  // ── Лента: состояние вкладок, значения органов и разбор команд ──
  const tabs = React.useMemo(() => docRibbon(), []);
  const [tab, setTab] = useState('Главная');
  // Свёрнутая лента помнится между документами и программами семьи
  const [folded, setFolded] = useRibbonFold();
  const [fileOpen, setFileOpen] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  const [showRuler, setShowRuler] = useState(true);
  const [fontSize, setFontSize] = useState(11);
  // Выбранный шрифт и стиль держим у себя: движок не отдаёт наружу оформление
  // под курсором, а поле со списком обязано показывать хоть что-то честное —
  // последнее, что человек сам выбрал
  const [font, setFont] = useState('');
  const [blockStyle, setBlockStyle] = useState('normal');
  const [zoom, setZoom] = useState(100);
  const [textColor, setTextColor] = useState(DOC_TEXT_COLORS[0]);
  const [markColor, setMarkColor] = useState(DOC_MARK_COLORS[0]);
  const [tablePop, setTablePop] = useState<{ x: number; y: number } | null>(null);
  const [gridHover, setGridHover] = useState({ r: 0, c: 0 });
  const [spacingAt, setSpacingAt] = useState<{ x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Всплывающие панели ленты закрываются с клавиатуры: их подложка ловит
  // нажатие мимо, и без Esc редактор кажется зависшим
  useEscape(!!spacingAt, () => setSpacingAt(null));
  useEscape(!!tablePop, () => setTablePop(null));

  /** Всплывающая панель органа встаёт под самим органом, а не «примерно там» */
  const organRect = (id: string) => {
    const el = rootRef.current?.querySelector(`[data-organ="${id}"]`) as HTMLElement | null;
    const r = el?.getBoundingClientRect();
    return r ? { x: r.left, y: r.bottom + 6 } : { x: 120, y: 150 };
  };

  /**
   * Команда движку.
   *
   * Отклонение обещания гасим сами: движок отвечает обещанием, и необработанный
   * отказ уходит в журнал как критическая ошибка программы. Сохранение —
   * с задержкой: одно нажатие даёт несколько мутаций, и записывать надо
   * получившееся, а не промежуточное.
   */
  const exec = (id: string, params?: any) => {
    const api = univerRef.current?.univerAPI;
    if (!api) { addToast('Редактор ещё загружается', 'error'); return; }
    try {
      const r = api.executeCommand(id, params);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (_) { addToast('Не удалось выполнить команду', 'error'); }
    setTimeout(() => { saveNow(); scheduleRulerRefresh(); }, 400);
  };

  /** Отступ абзаца слева: шаг 1,25 см — тот же, что у красной строки по ГОСТ */
  const stepIndent = (dir: 1 | -1) => {
    const ctx = engineCtx();
    if (!ctx) return;
    const cur = Number(readParagraphStyle(ctx)?.indentStart?.v || 0);
    const next = Math.max(0, cur + dir * 36);
    if (!patchParagraphs(ctx, { indentStart: next ? { v: next } : null })) {
      addToast('Поставьте курсор в текст', 'error'); return;
    }
    refreshRuler();
    saveNow();
  };

  const STYLE_CMD: Record<string, string> = {
    normal: 'doc.command.normal-text-heading',
    title: 'doc.command.title',
    subtitle: 'doc.command.subtitle-heading',
    h1: 'doc.command.h1-heading',
    h2: 'doc.command.h2-heading',
    h3: 'doc.command.h3-heading',
    h4: 'doc.command.h4-heading',
  };

  /** Значение проекта в позицию курсора — теми же серверными функциями, что и формулы */
  const insertProjectValue = async (fn: string, args: string[], fallback: string) => {
    try {
      const r = await fetch('/api/constructor/fn', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: activeProject?.id || 'default', calls: [{ fn, args }] }),
      });
      const v = r.ok ? (await r.json()).results?.[0] : null;
      insertField(v && v !== '#ОШИБКА' ? String(v) : fallback);
    } catch (_) { insertField(fallback); }
  };

  const runCommand = (id: string, value?: string) => {
    const api = univerRef.current?.univerAPI;
    switch (id) {
      case 'doc.undo': { const r = api?.undo?.(); if (r?.catch) r.catch(() => {}); return; }
      case 'doc.redo': { const r = api?.redo?.(); if (r?.catch) r.catch(() => {}); return; }
      case 'doc.font': { setFont(value || ''); return exec('doc.command.set-inline-format-font-family', { value }); }
      case 'doc.size': {
        const next = Math.min(96, Math.max(6, fontSize + (value === '+' ? 1 : -1)));
        setFontSize(next);
        return exec('doc.command.set-inline-format-fontsize', { value: next });
      }
      case 'doc.bold': return exec('doc.command.set-inline-format-bold');
      case 'doc.italic': return exec('doc.command.set-inline-format-italic');
      case 'doc.underline': return exec('doc.command.set-inline-format-underline');
      case 'doc.strike': return exec('doc.command.set-inline-format-strikethrough');
      case 'doc.sub': return exec('doc.command.set-inline-format-subscript');
      case 'doc.sup': return exec('doc.command.set-inline-format-superscript');
      case 'doc.color': {
        const c = value && value !== 'open' ? value : textColor;
        setTextColor(c);
        return exec('doc.command.set-inline-format-text-color', { value: c });
      }
      case 'doc.mark': {
        const c = value && value !== 'open' ? value : markColor;
        setMarkColor(c);
        return exec('doc.command.set-inline-format-text-background-color', { value: c });
      }
      case 'doc.left': return exec('doc.command.align-left');
      case 'doc.center': return exec('doc.command.align-center');
      case 'doc.right': return exec('doc.command.align-right');
      case 'doc.justify': return exec('doc.command.align-justify');
      case 'doc.indent': return stepIndent(1);
      case 'doc.outdent': return stepIndent(-1);
      case 'doc.spacing': return setSpacingAt(spacingAt ? null : organRect('doc.spacing'));
      case 'doc.bullets': return exec('doc.command.bullet-list');
      case 'doc.numbers': return exec('doc.command.order-list');
      case 'doc.checklist': return exec('doc.command.check-list');
      case 'doc.style': { setBlockStyle(value || 'normal'); return exec(STYLE_CMD[value || 'normal'] || STYLE_CMD.normal); }
      case 'doc.table': return setTablePop(tablePop ? null : organRect('doc.table'));
      case 'doc.image': return exec('doc.command.insert-float-image');
      case 'doc.link': return exec('doc.operation.show-hyper-link-edit-popup');
      case 'doc.rule': return exec('doc.command.horizontal-line');
      case 'doc.headerFooter': return exec('doc.command.open-header-footer-panel');
      case 'doc.title': return toggleDock('title');
      case 'doc.page': return openPageDialog();
      case 'doc.ruler': return setShowRuler(v => !v);
      case 'doc.fields': return toggleDock('fields');
      case 'doc.refreshData': return docLabels.refresh();
      case 'doc.today': return insertField(new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }));
      case 'doc.author': return insertField(user?.name || user?.symbol || 'Автор');
      case 'doc.revision': return setRevDialog(true);
      case 'doc.versions': { toggleDock('versions'); if (!versionsOpen) loadVersions(); return; }
      case 'doc.zoom': {
        const next = Math.min(400, Math.max(30, zoom + (value === '+' ? 10 : -10)));
        setZoom(next);
        return exec('doc.command.set-zoom-ratio', { zoomRatio: next / 100 });
      }
      case 'doc.zoomReset': { setZoom(100); return exec('doc.command.set-zoom-ratio', { zoomRatio: 1 }); }
      default: return undefined;
    }
  };

  const organState: Record<string, boolean | string> = {
    'doc.font': font,
    'doc.style': blockStyle,
    'doc.size': String(fontSize),
    'doc.zoom': `${zoom} %`,
    'doc.color': textColor,
    'doc.mark': markColor,
    'doc.ruler': showRuler,
    'doc.title': !!settings.titleTemplateId,
    'doc.fields': dataOpen,
    'doc.versions': versionsOpen,
  };
  const organDisabled: Record<string, string> = {};
  if (!settings.vdrItemId) organDisabled['doc.revision'] = 'Документ не привязан к строке ВДР — выпускать нечего';
  if (!activeProject?.id) {
    organDisabled['doc.fields'] = 'Проект не выбран — значения брать неоткуда';
    organDisabled['doc.today'] = 'Проект не выбран';
  }
  // Кнопка, которой нечего делать, врёт человеку молча: пусть скажет причину
  if (!docLabels.labels.length) {
    organDisabled['doc.refreshData'] = 'В документе нет меток данных — обновлять нечего';
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
        body: JSON.stringify({ name: `${doc?.name || 'Документ'} — копия` }),
      });
      addToast(r.ok ? 'Копия создана' : 'Не удалось создать копию', r.ok ? 'success' : 'error');
    },
    template: async () => {
      setFileOpen(false);
      await saveNow();
      const r = await fetch(`/api/constructor/docs/${docId}/duplicate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'TEMPLATE', name: `${doc?.name || 'Документ'} — шаблон` }),
      });
      addToast(r.ok ? 'Сохранён в «Шаблоны»' : 'Не удалось сохранить шаблон', r.ok ? 'success' : 'error');
    },
    revision: () => { setFileOpen(false); setRevDialog(true); },
    noRevision: settings.vdrItemId ? undefined : 'Документ не привязан к строке ВДР — выпускать нечего',
    print: () => { setFileOpen(false); handlePrint(); },
    pdf: () => { setFileOpen(false); handlePdf(); },
    office: () => { setFileOpen(false); exportWord(); },
    officeLabel: 'В Ворд (.doc)',
    officeHint: 'Откроется в Ворде: шрифты, поля и значения полей на месте',
    toExplorer: () => { setFileOpen(false); wordToExplorerFile(); },
    plain: () => { setFileOpen(false); exportTxt(); },
    plainLabel: 'Текст (.txt)',
    close: () => { setFileOpen(false); handleClose(); },
  });

  const fileInfo = [
    { label: 'Имя', value: doc?.name || '—' },
    { label: 'Раздел', value: doc?.scope === 'PERSONAL' ? 'Личный' : 'Общий' },
    { label: 'Ревизия', value: settings.docMeta?.revision || '—' },
    { label: 'Проект', value: activeProject?.name || '—' },
    { label: 'Изменён', value: doc?.updatedAt ? fmtDate(doc.updatedAt) : '—' },
    { label: 'Слов', value: String(counts.words) },
  ];

  return (
    <div ref={rootRef} className="h-full">
      <EditorFrame
        doc={{
          icon: doc?.kind === 'NOTE'
            ? <StickyNote className="w-3.5 h-3.5 text-amber-500" />
            : <FileText className="w-3.5 h-3.5 text-emerald-600" />,
          name: doc?.name || '',
          onRename: (v) => setDoc((d: any) => ({ ...d, name: v })),
          onClose: handleClose,
          revision: settings.docMeta?.revision || null,
          onRevision: settings.vdrItemId ? () => setRevDialog(true) : undefined,
          scope: isAuthor ? (doc?.scope === 'PERSONAL' ? 'PERSONAL' : 'SHARED') : undefined,
          onScope: isAuthor ? (v) => saveNow({ scope: v }) : undefined,
          peers,
          link: room.note,
          saveState: saveConflict ? 'conflict' : saveState,
          menu: [
            { label: 'Открыть в Проводнике', hint: 'Зеркало документа в общей папке', run: () => window.location.assign('#/explorer') },
            { label: 'История версий', hint: 'Снимки и возврат к любому', run: () => { setDock('versions'); loadVersions(); } },
          ],
        }}
        tabs={tabs} active={tab} onActive={setTab}
        state={organState} disabled={organDisabled} onCommand={runCommand}
        folded={folded} onFold={setFolded}
        file={fileSections} fileInfo={fileInfo} fileOpen={fileOpen} onFileOpen={setFileOpen}
        statusLeft={<>{counts.words} слов · {counts.chars} знаков{settings.docMeta?.revision ? ` · ревизия ${settings.docMeta.revision}` : ''}</>}
        statusRight={<>{zoom} %</>}
      >
      {/*
        Полотно и панели — в одну строку, а не друг поверх друга: наложенная
        панель закрывала ровно тот кусок листа, ради которого её открывали
      */}
      <div className="absolute inset-0 flex">
      <div className="flex-1 min-w-0 relative bg-slate-100 dark:bg-slate-950">
        {/* Линейка над листом — между лентой и страницей, как в Ворде */}
        {!loading && ruler && showRuler && (
          <div className="absolute left-0 right-0 z-20 pointer-events-none" style={{ top: ruler.topPx }}>
            <div className="pointer-events-auto">
              <DocRuler
                model={ruler.model}
                pxPerPt={ruler.pxPerPt}
                leftPx={ruler.leftPx}
                hasSelection={ruler.hasSelection}
                onMargins={dragMargins}
                onIndents={dragIndents}
              />
            </div>
          </div>
        )}
        <div ref={containerRef} className="absolute inset-0" />
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-white dark:bg-slate-950">
            <div className="flex items-center gap-3 text-slate-500"><Loader2 className="w-5 h-5 animate-spin" /> Загрузка редактора…</div>
          </div>
        )}
      </div>

      {/* Пристыкованная колонка: открыта всегда одна панель */}
      {titleOpen && (
        <TitlePanel
          docId={docId}
          projectId={activeProject?.id || 'default'}
          settings={settings}
          onChange={(next, persist) => { setSettings(next); if (persist) saveNow({ settings: JSON.stringify(next) }); }}
          onClose={closeDock}
        />
      )}
      {dataOpen && (
        <DataFieldsPanel
          projectId={activeProject?.id || 'default'}
          projectName={activeProject?.name || ''}
          userName={user?.name || user?.symbol || 'Пользователь'}
          labels={docLabels.labels}
          onInsert={insertField}
          onRefresh={docLabels.refresh}
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
      </div>

      {/* «Разметка страницы»: формат листа, ориентация, поля */}
      {pageDialog && pageSetup && (
        <PageSetupDialog
          value={pageSetup}
          onApply={applyPageDialog}
          onClose={() => setPageDialog(false)}
        />
      )}
      {/* Документ ушёл вперёд, пока его правили: разбор, а не тихая запись */}
      {saveConflict && (
        <SaveConflictDialog
          info={saveConflict}
          meName={user?.name || ''}
          onChoose={resolveSaveConflict}
        />
      )}

      {/* История версий — тот же компонент, что у таблиц */}
      {/* Одно окно недавних на все программы Flux Office: вернуться ко
          вчерашней работе — самое частое дело, а дорог к нему было две */}
      {recentOpen && (
        <RecentDocsPanel
          projectId={activeProject?.id || null}
          onOpen={(href) => { window.location.hash = `#${href}`; }}
          onClose={() => setRecentOpen(false)}
        />
      )}

      {/* Выпуск ревизии: место и описание изменения → ВДР + лист ревизий */}
      {revDialog && (
        <RevisionDialog
          current={settings.docMeta?.revision || ''}
          place={revPlace} onPlace={setRevPlace}
          desc={revDesc} onDesc={setRevDesc}
          busy={revBusy}
          onIssue={issueRevision}
          onClose={() => setRevDialog(false)}
        />
      )}

      {/* Именование при закрытии */}
      {nameDialog && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-2xl p-5 space-y-4">
            <h3 className="font-bold text-slate-800 dark:text-white">Как назвать документ?</h3>
            <input
              autoFocus
              defaultValue={`Документ — ${new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}`}
              onFocus={e => e.target.select()}
              onKeyDown={async e => {
                if (e.key === 'Enter') {
                  const v = (e.target as HTMLInputElement).value.trim();
                  if (v) await saveNow({ name: v });
                  onClose();
                }
              }}
              id="textdoc-name-input"
              className="w-full px-3 py-2.5 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-800 dark:text-white focus:outline-none focus:border-sky-500"
            />
            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={onClose} className="px-3.5 py-2 rounded-lg text-xs font-semibold text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-850 cursor-pointer">
                Оставить черновиком
              </button>
              <button type="button"
                onClick={async () => {
                  const v = (document.getElementById('textdoc-name-input') as HTMLInputElement)?.value?.trim();
                  if (v) await saveNow({ name: v });
                  onClose();
                }}
                className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-xs font-bold cursor-pointer">
                Готово
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Сетка вставки таблицы — раскрывается под своей кнопкой в ленте */}
      {tablePop && (
        <>
          <div className="fixed inset-0 z-[130]" onClick={() => setTablePop(null)} />
          <div className="fixed z-[140] p-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl"
            style={{ left: Math.min(tablePop.x, window.innerWidth - 240), top: Math.min(tablePop.y, window.innerHeight - 200) }}>
            <div className="grid grid-cols-10 gap-0.5" onMouseLeave={() => setGridHover({ r: 0, c: 0 })}>
              {Array.from({ length: 8 }).map((_, r) =>
                Array.from({ length: 10 }).map((_, c) => (
                  <div key={`${r}-${c}`}
                    onMouseEnter={() => setGridHover({ r: r + 1, c: c + 1 })}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setTablePop(null);
                      exec('doc.command.create-table', { rowCount: r + 1, colCount: c + 1 });
                    }}
                    className={`w-4 h-4 rounded-sm border cursor-pointer ${
                      r < gridHover.r && c < gridHover.c
                        ? 'bg-emerald-500 border-emerald-600'
                        : 'bg-slate-100 dark:bg-slate-850 border-slate-200 dark:border-slate-800'}`} />
                ))
              )}
            </div>
            <div className="text-center text-2xs text-slate-500 dark:text-slate-400 mt-1.5 font-mono">
              {gridHover.r > 0 ? `${gridHover.r} × ${gridHover.c}` : 'Выберите размер'}
            </div>
          </div>
        </>
      )}

      {/* Интервалы абзаца — та же панель, что была кнопкой в прежней шапке */}
      {spacingAt && (
        <>
          <div className="fixed inset-0 z-[130]" onClick={() => setSpacingAt(null)} />
          <div className="fixed z-[140]" style={{ left: Math.min(spacingAt.x, window.innerWidth - 280), top: spacingAt.y }}>
            <ParagraphSpacingMenu style={paraStyle} onApply={(patch) => { setSpacingAt(null); applyParagraph(patch); }} />
          </div>
        </>
      )}
      </EditorFrame>
    </div>
  );
}
