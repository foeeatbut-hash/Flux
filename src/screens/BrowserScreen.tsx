/**
 * Браузер — обычный браузер, внутри программы.
 *
 * Chromium в Flux уже есть: Electron это он и есть. Поэтому здесь не «окно с
 * сайтом», а настоящие вкладки — по процессу на страницу, с историей, назад и
 * вперёд, закладками и поиском из адресной строки.
 *
 * Разделение простое и его стоит держать в голове: всё, что видно на этом
 * экране, рисует React — полосу вкладок, адресную строку, полку закладок. Сама
 * страница живёт в главном процессе (electron/browser.ts) и рисуется поверх
 * пустого места, которое мы ей оставляем. Отсюда единственная тонкость: место
 * надо мерить и сообщать, иначе страница ляжет поверх адресной строки.
 *
 * В браузере (не в Electron) раздела нет: показать чужой сайт внутри вкладки
 * нельзя — половина сайтов этого не позволяет, — и обещать браузер там, где
 * его не бывает, честнее не обещать вовсе.
 */
import React from 'react';
import {
  ArrowLeft, ArrowRight, RotateCw, X, Plus, Star, Globe, Home, History,
  TriangleAlert, ExternalLink, Search, Languages, Download,
} from 'lucide-react';
import { useStore } from '../store/store';
import { useBrowserStore } from '../store/browserStore';
import { useToastStore } from '../store/toastStore';
import { useTranslateStore } from '../store/translateStore';
import { ENGINES, prettyUrl, tabLabel, hostOf } from '../lib/browserUrl';
import { useOverlayStore } from '../store/overlayStore';
import { useDownloadStore } from '../store/downloadStore';
import DownloadsPanel from '../components/browser/DownloadsPanel';

const api = () => (window as any).electron?.browser || null;

export default function BrowserScreen() {
  const activeProject = useStore((s) => s.activeProject);
  const { addToast } = useToastStore();
  const st = useBrowserStore();
  // Сколько открыто поверх содержимого: родной слой страницы обязан уступить
  const overlays = useOverlayStore((o) => o.count);
  const stageRef = React.useRef<HTMLDivElement>(null);
  const [address, setAddress] = React.useState('');
  // Что показано вместо страницы: история, загрузки или ничего
  const [panel, setPanel] = React.useState<'' | 'history' | 'downloads'>('');
  const showHistory = panel === 'history';
  const setShowHistory = (v: boolean | ((p: boolean) => boolean)) =>
    setPanel((p) => ((typeof v === 'function' ? v(p === 'history') : v) ? 'history' : ''));
  const desktop = !!api();
  const going = useDownloadStore((s) => s.items.some((d) => d.state === 'progress'));

  const active = st.tabs.find((t) => t.id === st.activeId) || null;
  const blank = !active || !active.url;

  React.useEffect(() => { void st.load(activeProject?.id || ''); }, [activeProject?.id]);

  // Личная папка загрузок называется логином, а список скачанного — свой у
  // каждого: за одним компьютером в отделе иногда работают двое
  const me = useStore((s) => s.user);
  React.useEffect(() => {
    useDownloadStore.getState().setWho(me?.id || '');
    if (me?.symbol) void api()?.setOwner?.(me.symbol);
  }, [me?.id, me?.symbol]);

  // Адресная строка следует за страницей, но не перебивает набор: пока человек
  // печатает, подменять текст под его пальцами нельзя
  const [typing, setTyping] = React.useState(false);
  React.useEffect(() => {
    if (!typing) setAddress(active?.url ? prettyUrl(active.url) : '');
  }, [active?.url, typing]);

  // События страниц из главного процесса
  React.useEffect(() => {
    const b = api();
    if (!b) return;
    const offState = b.onState((s: any) => useBrowserStore.getState().applyState(s));
    const offOpened = b.onOpened((p: any) => useBrowserStore.getState().addOpened(p.id, p.url));
    const offFailed = b.onFailed((p: any) => useBrowserStore.getState().setFailed(p.id, p.desc || 'Страница не открылась'));
    // Скачанное живёт в разделе «Загрузки», а не в исчезающей подсказке: до
    // этого о файле сообщали один раз и больше нигде не показывали
    const offDownload = b.onDownload((p: any) => {
      const before = useDownloadStore.getState().items.find((d) => d.id === p.id);
      useDownloadStore.getState().apply(p);
      if (!before) addToast(`Скачивается: ${p.name}`, 'info');
      else if (p.state === 'done' && before.state !== 'done') addToast(`Скачано: ${p.name}`, 'success');
      else if (p.state === 'failed' && before.state !== 'failed') addToast(`Не скачалось: ${p.name}`, 'error');
    });
    return () => { offState?.(); offOpened?.(); offFailed?.(); offDownload?.(); };
  }, [addToast]);

  /**
   * Где стоять странице. Меряем пустое место и сообщаем числами: главный
   * процесс не знает ни про полосу вкладок, ни про полку закладок.
   */
  const lastBox = React.useRef('');
  const place = React.useCallback((force = false) => {
    const b = api();
    const el = stageRef.current;
    if (!b || !el) return;
    const r = el.getBoundingClientRect();
    const key = `${Math.round(r.left)}:${Math.round(r.top)}:${Math.round(r.width)}:${Math.round(r.height)}`;
    if (!force && key === lastBox.current) return;
    lastBox.current = key;
    void b.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
  }, []);

  /**
   * Следим за МЕСТОМ, а не только за размером.
   *
   * Наблюдатель за размером молчит, когда меняется одно положение, — а именно
   * это и происходит, когда человек тянет окно программы за заголовок:
   * оболочка едет, страница остаётся стоять там, где была, потому что новых
   * чисел ей никто не послал. Поэтому проверяем прямоугольник на каждом кадре
   * и отправляем числа только при настоящем сдвиге: сравнение дешёвое, а
   * перетаскивание перестаёт быть особым случаем.
   */
  React.useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let alive = true;
    const tick = () => {
      if (!alive) return;
      place();
      raf = requestAnimationFrame(tick);
    };
    let raf = requestAnimationFrame(tick);
    const ro = new ResizeObserver(() => place(true));
    ro.observe(el);
    // Слушатель именованный и снимается тем же capture, каким поставлен: без
    // этого каждое открытие Браузера оставляло на window ещё один обработчик
    // прокрутки, и он продолжал двигать уже закрытую страницу
    const onScroll = () => place(true);
    window.addEventListener('scroll', onScroll, true);
    place(true);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [place]);

  /**
   * Когда страницу видно.
   *
   * Кроме пустой вкладки и ухода из раздела есть третий случай, из-за которого
   * казалось, что панели «не открываются»: родной слой Chromium всегда выше
   * любой разметки, и Пуск, панель уведомлений или диалог, открытые поверх
   * браузера, оказывались ПОД страницей. Поэтому страница уступает дорогу
   * всему, что открыто поверх (src/store/overlayStore.ts).
   */
  React.useEffect(() => {
    const b = api();
    if (!b) return;
    if (blank || panel || overlays > 0) { void b.hide(); return; }
    if (st.activeId) { void b.show(st.activeId); place(true); }
  }, [blank, panel, st.activeId, overlays, place]);

  React.useEffect(() => () => { void api()?.hide(); }, []);

  /**
   * Ссылку могли прислать со стороны — из письма, чата или заметки. Забираем
   * её один раз и сразу гасим: иначе следующий приход в раздел снова открыл бы
   * прошлую ссылку поверх того, что человек уже читает.
   */
  React.useEffect(() => {
    const url = st.pending;
    if (!url) return;
    st.setPending('');
    void (async () => {
      await st.newTab();
      await st.open(url);
    })();
  }, [st.pending]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTyping(false);
    if (!st.tabs.length) await st.newTab();
    const r = await st.open(address);
    if (!r.ok && r.reason) addToast(r.reason, 'error');
  };

  const translateSelection = async () => {
    const b = api();
    if (!b || !active) return;
    const text = await b.selection(active.id);
    if (!text.trim()) { addToast('Выделите текст на странице', 'info'); return; }
    useTranslateStore.getState().setPending(text);
    addToast('Текст передан Переводчику', 'success');
  };

  if (!desktop) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-center px-8">
        <Globe className="w-10 h-10 text-slate-300 dark:text-slate-700" />
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Браузер работает в программе на компьютере</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm">
          Во вкладке браузера показать чужой сайт нельзя — так устроены сами сайты. Откройте Flux
          на рабочем месте, и раздел заработает.
        </p>
      </div>
    );
  }

  const bookmarked = !!active?.url && st.bookmarks.some((b) => b.url === active.url);
  const tabBtn = 'shrink-0 flex items-center gap-1.5 h-8 px-2.5 rounded-t-lg cursor-pointer text-xs max-w-[200px]';
  const navBtn = 'w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-850 disabled:opacity-30 disabled:cursor-default';

  return (
    <div className="h-full flex flex-col bg-white dark:bg-dark-surface">
      {/* Полоса вкладок */}
      <div className="shrink-0 flex items-end gap-0.5 px-1.5 pt-1.5 border-b border-slate-200 dark:border-dark-border">
        {st.tabs.map((t) => (
          <div
            key={t.id}
            onClick={() => { setPanel(''); void st.select(t.id); }}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); void st.closeTab(t.id); } }}
            title={t.url || 'Новая вкладка'}
            className={`${tabBtn} ${t.id === st.activeId && !showHistory
              ? 'bg-slate-100 dark:bg-slate-850 text-slate-800 dark:text-slate-100 font-semibold'
              : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-900'}`}
          >
            {t.loading
              ? <RotateCw className="w-3 h-3 shrink-0 animate-spin text-emerald-500" />
              : <Globe className="w-3 h-3 shrink-0 text-slate-400" />}
            <span className="truncate">{tabLabel(t.title, t.url)}</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); void st.closeTab(t.id); }}
              title="Закрыть вкладку"
              aria-label="Закрыть вкладку"
              className="shrink-0 w-4 h-4 rounded flex items-center justify-center hover:bg-slate-300 dark:hover:bg-slate-700"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => { setShowHistory(false); void st.newTab(); }}
          title="Новая вкладка (Ctrl+T)"
          aria-label="Новая вкладка"
          className="shrink-0 w-7 h-7 mb-0.5 rounded-lg flex items-center justify-center cursor-pointer
                     text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-850"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {/* Адресная строка */}
      <div className="shrink-0 flex items-center gap-1 px-2 py-1.5 border-b border-slate-200 dark:border-dark-border">
        <button type="button" className={navBtn} disabled={!active?.canGoBack} onClick={() => st.act('back')} title="Назад" aria-label="Назад">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <button type="button" className={navBtn} disabled={!active?.canGoForward} onClick={() => st.act('forward')} title="Вперёд" aria-label="Вперёд">
          <ArrowRight className="w-4 h-4" />
        </button>
        <button type="button" className={navBtn} disabled={!active?.url} onClick={() => st.act('reload')} title="Обновить" aria-label="Обновить">
          <RotateCw className={`w-4 h-4 ${active?.loading ? 'animate-spin' : ''}`} />
        </button>
        <button type="button" className={navBtn} onClick={() => { setShowHistory(false); void st.newTab(); }} title="Начальная страница" aria-label="Начальная страница">
          <Home className="w-4 h-4" />
        </button>

        <form onSubmit={submit} className="flex-1 min-w-0">
          <div className="flex items-center gap-2 h-8 px-3 rounded-lg border border-slate-200 dark:border-dark-border
                          bg-slate-50 dark:bg-slate-900 focus-within:border-emerald-500">
            <Search className="w-3.5 h-3.5 shrink-0 text-slate-400" />
            <input
              value={address}
              onChange={(e) => { setTyping(true); setAddress(e.target.value); }}
              onBlur={() => setTyping(false)}
              placeholder="Адрес или поиск"
              spellCheck={false}
              className="flex-1 min-w-0 bg-transparent outline-none text-xs text-slate-800 dark:text-slate-150 placeholder:text-slate-400"
            />
            {!!active?.url && (
              <span className="shrink-0 text-2xs text-slate-400 font-mono">{hostOf(active.url)}</span>
            )}
          </div>
        </form>

        <button type="button" className={navBtn} disabled={!active?.url} onClick={() => void st.toggleBookmark()}
          title={bookmarked ? 'Убрать из закладок' : 'В закладки проекта'} aria-label="Закладка">
          <Star className={`w-4 h-4 ${bookmarked ? 'fill-amber-400 text-amber-500' : ''}`} />
        </button>
        <button type="button" className={navBtn} disabled={!active?.url} onClick={translateSelection}
          title="Перевести выделенный на странице текст" aria-label="Перевести выделенное">
          <Languages className="w-4 h-4" />
        </button>
        <button type="button" className={navBtn} onClick={() => setShowHistory((v) => !v)} title="История" aria-label="История">
          <History className="w-4 h-4" />
        </button>
        <button type="button" className={`${navBtn} relative`} aria-label="Загрузки"
          onClick={() => setPanel((p) => (p === 'downloads' ? '' : 'downloads'))}
          title="Загрузки — всё скачивается в вашу личную папку">
          <Download className="w-4 h-4" />
          {/* Точка, пока файл идёт: раздел не обязан быть открытым, чтобы
              человек понял, что скачивание живо */}
          {going && <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-emerald-500" />}
        </button>
        <button type="button" className={navBtn} disabled={!active?.url} onClick={() => st.act('external')}
          title="Открыть в браузере Windows" aria-label="Открыть снаружи">
          <ExternalLink className="w-4 h-4" />
        </button>
      </div>

      {/* Полка закладок — общие на проект */}
      {st.bookmarks.length > 0 && (
        <div className="shrink-0 flex items-center gap-1 px-2 py-1 overflow-x-auto border-b border-slate-200 dark:border-dark-border">
          {st.bookmarks.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => { setShowHistory(false); void st.open(b.url); }}
              onContextMenu={(e) => { e.preventDefault(); void st.removeBookmark(b.id); }}
              title={`${b.url}\nПравая кнопка — убрать из закладок`}
              className="shrink-0 flex items-center gap-1.5 h-6 px-2 rounded-lg text-2xs cursor-pointer
                         text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-850"
            >
              <Star className="w-3 h-3 fill-amber-400 text-amber-500" />
              <span className="truncate max-w-[160px]">{b.title}</span>
            </button>
          ))}
        </div>
      )}

      {/* Место страницы: её рисует движок поверх этого прямоугольника */}
      <div ref={stageRef} className="flex-1 min-h-0 relative bg-white dark:bg-slate-950">
        {panel === 'downloads' ? (
          <DownloadsPanel />
        ) : showHistory ? (
          <div className="absolute inset-0 overflow-y-auto p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">История</h2>
              <button type="button" onClick={() => st.clearHistory()}
                className="text-2xs text-slate-500 hover:text-rose-600 cursor-pointer">Очистить</button>
            </div>
            {st.history.length === 0 && <p className="text-xs text-slate-400">Пока пусто.</p>}
            {st.history.slice(0, 200).map((h) => (
              <button key={`${h.url}-${h.at}`} type="button"
                onClick={() => { setShowHistory(false); void st.open(h.url); }}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left cursor-pointer
                           hover:bg-slate-100 dark:hover:bg-slate-850">
                <Globe className="w-3.5 h-3.5 shrink-0 text-slate-400" />
                <span className="flex-1 min-w-0 truncate text-xs text-slate-700 dark:text-slate-150">{h.title}</span>
                <span className="shrink-0 text-2xs text-slate-400 font-mono truncate max-w-[220px]">{prettyUrl(h.url)}</span>
              </button>
            ))}
          </div>
        ) : active?.error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center">
            <TriangleAlert className="w-8 h-8 text-amber-500" />
            <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Страница не открылась</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md">{active.error}</p>
            <button type="button" onClick={() => st.act('reload')}
              className="mt-2 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 text-white cursor-pointer hover:bg-emerald-700">
              Повторить
            </button>
          </div>
        ) : blank ? (
          <div className="absolute inset-0 overflow-y-auto flex flex-col items-center justify-center gap-4 p-8">
            <Globe className="w-9 h-9 text-slate-300 dark:text-slate-700" />
            <form onSubmit={submit} className="w-full max-w-xl">
              <input
                autoFocus
                value={address}
                onChange={(e) => { setTyping(true); setAddress(e.target.value); }}
                placeholder="Адрес или поиск"
                className="w-full h-10 px-4 rounded-xl border border-slate-200 dark:border-dark-border
                           bg-white dark:bg-slate-900 outline-none focus:border-emerald-500
                           text-sm text-slate-800 dark:text-slate-150 placeholder:text-slate-400"
              />
            </form>
            <div className="flex items-center gap-1.5">
              {ENGINES.map((e) => (
                <button key={e.id} type="button" onClick={() => st.setEngine(e.id)}
                  className={`px-2.5 py-1 rounded-lg text-2xs font-semibold cursor-pointer ${
                    st.engine === e.id
                      ? 'bg-emerald-600 text-white'
                      : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-850'}`}>
                  {e.label}
                </button>
              ))}
            </div>
            {st.bookmarks.length > 0 && (
              <div className="w-full max-w-xl">
                <p className="text-xs font-medium text-slate-400 mb-2">Закладки проекта</p>
                <div className="grid grid-cols-2 @[720px]:grid-cols-3 gap-1.5">
                  {st.bookmarks.slice(0, 12).map((b) => (
                    <button key={b.id} type="button" onClick={() => void st.open(b.url)}
                      className="flex items-center gap-2 px-2.5 py-2 rounded-lg text-left cursor-pointer
                                 border border-slate-200 dark:border-dark-border hover:border-emerald-500">
                      <Star className="w-3.5 h-3.5 shrink-0 fill-amber-400 text-amber-500" />
                      <span className="min-w-0 truncate text-xs text-slate-700 dark:text-slate-150">{b.title}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {st.allowed.length > 0 && (
              <p className="text-2xs text-slate-400 text-center max-w-md">
                Открываются только адреса из списка, который ведёт администратор: {st.allowed.slice(0, 4).join(', ')}
                {st.allowed.length > 4 ? ` и ещё ${st.allowed.length - 4}` : ''}.
              </p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
