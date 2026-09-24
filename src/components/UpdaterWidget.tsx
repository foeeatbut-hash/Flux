/**
 * Обновление программы в настройках.
 *
 * Одна кнопка на всё: нажал — скачалось, проверилось, программа закрылась,
 * подменила свой exe и открылась уже новой. Двух шагов («скачать», потом
 * «установить») здесь быть не должно: человек, нажавший «скачать», уже сказал,
 * чего хочет, и второе подтверждение — это просто ещё одно место, где можно
 * забыть нажать и остаться на старой версии.
 *
 * Состояние живёт в updateStore: о том же обновлении должен знать значок у
 * часов, а он к этому окну отношения не имеет.
 */
import React, { useState, useEffect, useRef } from 'react';
import {
  RefreshCw,
  CheckCircle2,
  Download,
  ArrowUpCircle,
  PlusCircle,
  Settings,
  FileUp,
  Link2
} from 'lucide-react';
import { useToastStore } from '../store/toastStore';
import { useStore } from '../store/store';
import { getServerBaseUrl } from '../config/env';
import { useUpdateStore } from '../store/updateStore';
import { phaseLabel, fileUrlOf, versionFromFileName, versionProblem } from '../lib/updates';

// ── Автообновления через сервер ──
// Админ публикует релиз прямо на сервер (загружает exe или даёт прямую ссылку),
// запись попадает в AppUpdate. Сотрудники проверяют /api/updates/latest на том
// сервере, с которым работают (встроенный или сервер компании), качают exe
// оттуда же и портативное приложение подменяет само себя. Никакого стороннего
// хостинга и прямых подключений клиента к базе.

// Сравнение версий, адрес файла и разбор отказов — в src/lib/updates.ts:
// теми же правилами пользуется главный процесс, который и качает файл

function formatSize(bytes: number): string {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} МБ` : `${Math.round(bytes / 1024)} КБ`;
}

export default function UpdaterWidget() {
  const { user } = useStore();
  const { addToast } = useToastStore();

  // Публикация релиза (админ)
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [pubVersion, setPubVersion] = useState('');
  const [pubChangelog, setPubChangelog] = useState('');
  const [pubFile, setPubFile] = useState<File | null>(null);
  const [pubFileUrl, setPubFileUrl] = useState('');
  const [isPublishing, setIsPublishing] = useState(false);
  /** Почему публикация не удалась — прямо в окне, а не всплывающей подсказкой */
  const [pubError, setPubError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showModal, setShowModal] = useState(false);

  const phase = useUpdateStore((s) => s.phase);
  const percent = useUpdateStore((s) => s.percent);
  const latest = useUpdateStore((s) => s.latest);
  const error = useUpdateStore((s) => s.error);
  const currentVersion = useUpdateStore((s) => s.current);
  const isPackaged = useUpdateStore((s) => s.packaged);
  const isPortable = useUpdateStore((s) => s.portable);
  const init = useUpdateStore((s) => s.init);
  const check = useUpdateStore((s) => s.check);
  const install = useUpdateStore((s) => s.install);
  const markSeen = useUpdateStore((s) => s.markSeen);
  const broken = useUpdateStore((s) => s.broken);
  const revoke = useUpdateStore((s) => s.revoke);

  const isElectron = typeof window !== 'undefined' && (window as any).electron !== undefined;
  const busy = phase === 'downloading' || phase === 'verifying' || phase === 'installing';
  /** Куда уходит запрос за файлом: сервер, с которым работает эта программа */
  const base = getServerBaseUrl() || (typeof window !== 'undefined' ? window.location.origin : '');

  useEffect(() => {
    void init(typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0');
  }, [init]);

  // Человек в разделе обновлений — значку у часов больше подпрыгивать незачем
  useEffect(() => { markSeen(); }, [markSeen]);

  // Автопроверка при открытии настроек + мгновенная реакция на публикацию
  // (сервер шлёт socket-событие, SocketProvider транслирует его в window)
  useEffect(() => {
    const timer = setTimeout(() => { void check(true); }, 1200);
    const onPublished = () => { void check(true); };
    window.addEventListener('socket:app:update-published', onPublished);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('socket:app:update-published', onPublished);
    };
  }, [check]);

  const handleCheck = async () => {
    await check(false);
    const s = useUpdateStore.getState();
    if (s.error) { addToast(`Ошибка проверки: ${s.error}`, 'error'); return; }
    if (s.latest) { setShowModal(true); addToast(`Найдена версия v${s.latest.version}`, 'success'); }
    else addToast(`У вас последняя версия (v${s.current}).`, 'info');
  };

  /**
   * Одно нажатие на всё. В программе — скачает, проверит и обновится само;
   * в браузере обновлять нечего, поэтому там файл просто отдаётся человеку.
   */
  const handleInstall = async () => {
    setShowModal(false);
    if (!latest) return;
    if (isElectron) { await install(); return; }
    try {
      const base = getServerBaseUrl() || window.location.origin;
      const res = await fetch(fileUrlOf(latest.fileUrl, base));
      if (!res.ok) throw new Error(`Сервер ответил ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Flux ${latest.version}.exe`;
      a.click();
      URL.revokeObjectURL(url);
      addToast(`Файл Flux ${latest.version}.exe скачан — замените им текущий exe.`, 'success');
    } catch (err: any) {
      addToast(`Не удалось скачать: ${err.message}`, 'error');
    }
  };

  /**
   * Файл выбран — номер версии берётся из его имени.
   *
   * Руками номер набирать не надо: именно на этом обновления и встали. В поле
   * оказалось «90» вместо «0.90.0», запись о релизе разошлась всем сотрудникам,
   * а файл на сервере лежал под настоящим номером — и каждый получал «файла
   * этой версии нет».
   */
  const handlePickFile = (file: File | null) => {
    setPubFile(file);
    if (!file) return;
    const fromName = versionFromFileName(file.name);
    if (fromName) setPubVersion(fromName);
  };

  const handlePublishRelease = async () => {
    const version = pubVersion.trim();
    const badVersion = versionProblem(version);
    if (badVersion) {
      addToast(badVersion, 'error');
      return;
    }
    if (!pubFile && !pubFileUrl.trim()) {
      addToast('Выберите файл exe или укажите прямую ссылку', 'error');
      return;
    }

    setIsPublishing(true);
    setPubError('');
    try {
      // Шаг 1: файл — на сервер (сырыми байтами, минуя JSON-лимиты)
      if (pubFile) {
        const upRes = await fetch(`/api/updates/upload?version=${encodeURIComponent(version)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: pubFile,
        });
        const upData = await upRes.json().catch(() => ({}));
        if (!upRes.ok) throw new Error(upData.error || `Загрузка файла: сервер ответил ${upRes.status}`);
        // Файл, не попавший в общую базу, виден только на этой машине.
        // Публиковать такое нельзя: оповещение уйдёт всем, а скачать не сможет
        // никто — именно так отдел и просидел два выпуска без обновлений
        if (upData?.shared === false) {
          throw new Error(String(upData.warning || 'Файл не попал в общую базу — сотрудники его не скачают.'));
        }
      }
      // Шаг 2: запись релиза (ссылка на сервер, если файл загружен)
      const res = await fetch('/api/updates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version, changelog: pubChangelog, fileUrl: pubFileUrl.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Сервер ответил ${res.status}`);

      /**
       * Проверяем, что файл действительно лежит там, откуда его будут качать.
       *
       * Это не перестраховка. Публикация уходит на ТОТ сервер, с которым
       * работает эта программа, а берут файл сотрудники из общей базы. Спросить
       * дешевле, чем узнать от них через день. Спрашиваем именно вопросом, а не
       * скачиванием: 130 мегабайт по сети ради двух байтов никому не нужны.
       */
      const probe = await fetch(fileUrlOf(`/api/updates/check/${version}`, base)).catch(() => null);
      const state = probe ? await probe.json().catch(() => null) : null;
      if (!state?.ok) {
        setPubError(
          `Релиз записан, но файла на сервере нет (${state?.why || (probe ? `код ${probe.status}` : 'сервер не ответил')}). `
          + 'Сотрудники его не скачают — опубликуйте заново.',
        );
        addToast('Файл на сервере не найден — смотрите объяснение в окне публикации', 'error');
        return;
      }

      addToast(`Релиз v${version} опубликован — сотрудники получат оповещение.`, 'success');
      setShowPublishModal(false);
      setPubChangelog('');
      setPubFile(null);
      void check(true);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Причина остаётся в окне, а не уезжает с всплывающей подсказкой:
      // читать её приходится внимательно, а иногда и показывать кому-то
      setPubError(errMsg);
      addToast(`Ошибка публикации: ${errMsg}`, 'error');
    } finally {
      setIsPublishing(false);
    }
  };

  const isAdmin = user?.role === 'ADMIN';
  const isDevSandbox = isElectron && !isPackaged;

  return (
    <div className="bg-slate-100 dark:bg-slate-900/50 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800/40 text-left font-sans">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-mono font-bold text-slate-400 dark:text-slate-500">Автообновления</span>
        {status !== 'idle' && (
          <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500 animate-ping" />
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 font-mono">
          <span>Версия ПО:</span>
          <span className="font-bold text-slate-700 dark:text-slate-300">v{currentVersion}</span>
        </div>
        <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 font-mono pb-1 border-b border-slate-200/50 dark:border-slate-800/50">
          <span>Источник обновлений:</span>
          <span className="text-emerald-600 dark:text-emerald-400 font-bold text-xs">
            {getServerBaseUrl() && !getServerBaseUrl().includes('localhost') ? 'Сервер компании' : 'Встроенный сервер'}
          </span>
        </div>

        {isDevSandbox && (
          <div className="text-center py-1 bg-amber-500/10 dark:bg-amber-500/5 border border-amber-500/20 rounded">
            <span className="text-xs font-bold text-amber-600 dark:text-amber-400">Режим разработки — установка обновлений недоступна</span>
          </div>
        )}

        {/* Одна кнопка на весь путь: проверить — и, если есть что ставить,
            поставить. Этапы человек видит строкой, а не набором кнопок */}
        {phase === 'available' && latest ? (
          <div className="space-y-2">
            <div className="text-xs text-slate-600 dark:text-slate-300 font-semibold">
              Доступна версия <span className="font-extrabold text-emerald-600 dark:text-emerald-400">v{latest.version}</span>
              {latest.size ? <span className="text-slate-400 font-normal"> · {formatSize(latest.size)}</span> : null}
            </div>
            <button type="button"
              onClick={handleInstall}
              className="w-full py-1.5 bg-emerald-700 hover:bg-emerald-600 active:scale-95 text-white rounded text-xs font-bold transition-ui flex items-center justify-center gap-1.5 cursor-pointer font-sans"
            >
              <Download className="w-3.5 h-3.5 shrink-0" />
              <span>{isElectron ? 'Скачать и установить' : 'Скачать файл'}</span>
            </button>
            <button type="button"
              onClick={() => setShowModal(true)}
              className="w-full py-1 text-xs font-semibold text-slate-500 hover:text-emerald-600 cursor-pointer"
            >
              Что изменилось
            </button>
          </div>
        ) : busy ? (
          <div className="space-y-1.5 py-1">
            <div className="flex justify-between text-xs font-mono font-bold text-slate-500 dark:text-slate-400">
              <span>{phaseLabel(phase, percent)}</span>
            </div>
            <div className="w-full bg-slate-200 dark:bg-slate-800 h-1.5 rounded overflow-hidden">
              <div className="bg-emerald-500 h-full transition-ui duration-300"
                style={{ width: `${phase === 'downloading' ? percent : 100}%` }} />
            </div>
            {phase === 'installing' && (
              <p className="text-xs text-slate-500 dark:text-slate-400 leading-snug">
                Программа сейчас закроется и откроется заново уже новой версии. Данные не затрагиваются.
              </p>
            )}
          </div>
        ) : phase === 'checking' ? (
          <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400 py-1 text-xs justify-center bg-slate-200/40 dark:bg-slate-800/40 rounded">
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-emerald-500 shrink-0" />
            <span className="font-medium">Сравнение версий…</span>
          </div>
        ) : (
          <button type="button"
            onClick={handleCheck}
            className="w-full py-1.5 px-3 bg-emerald-700 hover:bg-emerald-600 active:scale-95 text-white rounded text-xs font-bold transition-ui flex items-center justify-center gap-1.5 cursor-pointer font-sans"
          >
            <RefreshCw className="w-3.5 h-3.5 shrink-0" />
            <span>Проверить обновления</span>
          </button>
        )}

        {/* Отказ объясняется словами и не прячется: человек должен знать, что
            обновления у него нет, и почему именно */}
        {!!error && (
          <div className="text-xs text-rose-600 dark:text-rose-400 leading-snug bg-rose-500/10 rounded p-2">
            {error}
            {phase === 'failed' && latest && (
              <button type="button" onClick={handleInstall}
                className="block mt-1 font-bold underline cursor-pointer">Повторить</button>
            )}
          </div>
        )}

        {/* Портативная сборка подменяет себя на месте — это стоит сказать
            заранее, иначе закрывшееся окно выглядит как поломка */}
        {isElectron && isPackaged && !isPortable && phase === 'available' && (
          <p className="text-xs text-amber-600 dark:text-amber-400 leading-snug">
            Программа запущена не портативным файлом — обновление поставит обычный установщик.
          </p>
        )}

        {/* Публикация без файла — не молчаливая беда, а видимая строка.
            Раньше такая запись жила в общей базе вечно: у всех горело
            «доступно обновление», нажатие отвечало «файла этой версии нет»,
            и убрать её было нечем */}
        {broken.map((b) => (
          <div key={b.version} className="text-xs leading-snug bg-amber-500/10 rounded p-2 text-amber-700 dark:text-amber-300">
            <div>
              Релиз <span className="font-bold">v{b.version}</span> опубликован без файла: {b.why}.
              {!isAdmin && ' Обновиться по нему нельзя — скажите администратору.'}
            </div>
            {isAdmin && (
              <button type="button"
                onClick={async () => {
                  const err = await revoke(b.version);
                  addToast(err || `Публикация v${b.version} отозвана`, err ? 'error' : 'success');
                }}
                className="mt-1 font-bold underline cursor-pointer"
              >
                Отозвать публикацию
              </button>
            )}
          </div>
        ))}

        {/* Публикация релиза — только администратор */}
        {isAdmin && (
          <button type="button"
            onClick={() => setShowPublishModal(true)}
            className="w-full mt-1.5 py-1 px-3 bg-slate-200 hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-300 rounded text-xs font-bold font-sans transition-ui flex items-center justify-center gap-1 cursor-pointer border border-slate-300 dark:border-slate-800"
          >
            <PlusCircle className="w-3.5 h-3.5 text-emerald-500" />
            <span>Опубликовать релиз</span>
          </button>
        )}
      </div>

      {/* CHANGELOG И ПОДТВЕРЖДЕНИЕ УСТАНОВКИ */}
      {showModal && latest && (
        <div className="fixed inset-0 bg-slate-950/70 z-[100] flex items-center justify-center p-4 backdrop-blur-xs">
          <div className="bg-white dark:bg-slate-950 rounded-lg w-full max-w-lg border border-slate-200 dark:border-slate-850 shadow-2xl overflow-hidden animate-in fade-in duration-200 max-h-[90vh] flex flex-col">
            <div className="bg-slate-50 dark:bg-slate-990 p-4 border-b border-slate-200 dark:border-slate-850 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ArrowUpCircle className="w-5 h-5 text-emerald-500" />
                <h3 className="text-sm font-bold text-slate-900 dark:text-white font-sans">Доступно обновление Flux</h3>
              </div>
              <span className="bg-emerald-100 dark:bg-emerald-950/50 text-emerald-800 dark:text-emerald-400 px-2 py-0.5 rounded text-xs font-bold font-mono">
                v{latest.version}
              </span>
            </div>

            <div className="p-5 flex-1 overflow-y-auto text-left">
              <div className="bg-slate-50 dark:bg-slate-900 p-3.5 rounded-lg border border-slate-200 dark:border-slate-800/80 mb-4">
                <h4 className="text-xs font-extrabold text-slate-500 dark:text-slate-450 mb-2 font-mono">Список изменений релиза:</h4>
                <div className="whitespace-pre-line text-slate-700 dark:text-slate-300 text-xs font-sans leading-relaxed space-y-1">
                  {latest.changelog || 'Описание изменений не указано.'}
                </div>
              </div>

              <div className="text-xs leading-normal bg-sky-500/10 dark:bg-sky-500/5 p-2.5 rounded border border-sky-500/20 text-slate-700 dark:text-sky-300">
                Файл скачивается с вашего сервера Flux. После загрузки приложение закроется,
                обновление подменит exe и программа запустится уже новой версии — данные не затрагиваются.
              </div>
            </div>

            <div className="p-4 bg-slate-50 dark:bg-slate-990 border-t border-slate-200 dark:border-slate-850 flex items-center justify-end gap-2 shrink-0">
              <button type="button"
                onClick={() => setShowModal(false)}
                className="px-4 py-1.5 bg-slate-200 hover:bg-slate-300 dark:bg-slate-900 dark:hover:bg-slate-850 text-slate-700 dark:text-slate-300 rounded text-xs font-bold transition-ui cursor-pointer"
              >
                Закрыть
              </button>
              {phase === 'available' && (
                <button type="button"
                  onClick={handleInstall}
                  className="px-4 py-1.5 bg-emerald-700 hover:bg-emerald-600 active:scale-95 text-white rounded text-xs font-bold transition-ui flex items-center gap-1.5 cursor-pointer shadow-md shadow-emerald-500/10"
                >
                  <Download className="w-3.5 h-3.5 shrink-0" />
                  <span>{isElectron ? 'Скачать и установить' : 'Скачать файл'}</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* АДМИН: ПУБЛИКАЦИЯ РЕЛИЗА */}
      {showPublishModal && (
        <div className="fixed inset-0 bg-slate-950/70 z-[100] flex items-center justify-center p-4 backdrop-blur-xs">
          <div className="bg-white dark:bg-slate-950 rounded-lg w-full max-w-lg border border-slate-200 dark:border-slate-850 shadow-2xl overflow-hidden animate-in fade-in duration-200 max-h-[90vh] flex flex-col text-left">
            <div className="bg-slate-50 dark:bg-slate-990 p-4 border-b border-slate-200 dark:border-slate-850 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Settings className="w-5 h-5 text-emerald-500 animate-spin-slow" />
                <h3 className="text-sm font-bold text-slate-900 dark:text-white font-sans">Публикация обновления (ADMIN)</h3>
              </div>
            </div>

            <div className="p-5 flex-1 overflow-y-auto space-y-4">
              {/* Куда уйдёт файл — сказано прямо. Раньше он оставался на диске
                  того, кто публиковал, и сотрудники получали «файла этой версии
                  нет», хотя запись о релизе видели все */}
              <div className="text-xs leading-normal bg-amber-500/10 dark:bg-amber-500/5 p-2.5 rounded border border-amber-500/20 text-amber-800 dark:text-amber-300">
                Файл уйдёт в общую базу — ту же, где лежат проекты и переписка. Оттуда его возьмёт
                программа каждого сотрудника, на какой бы машине она ни работала.
                Все, кто сейчас в программе, получат оповещение мгновенно; остальные — при следующей проверке.
              </div>

              <div className="space-y-1">
                <label className="text-xs font-mono font-bold text-slate-400">Номер релиза (версия):</label>
                <input
                  type="text"
                  value={pubVersion}
                  onChange={(e) => setPubVersion(e.target.value)}
                  placeholder="Например: 0.25.0"
                  className="w-full text-xs p-2 rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-800 dark:text-white font-mono"
                />
                {/* Ошибку в номере видно сразу, а не после рассылки оповещения */}
                {!!versionProblem(pubVersion, currentVersion) && pubVersion.trim() !== '' && (
                  <p className="text-xs text-rose-600 dark:text-rose-400 leading-snug">
                    {versionProblem(pubVersion, currentVersion)}
                  </p>
                )}
              </div>

              <div className="space-y-1">
                <label className="text-xs font-mono font-bold text-slate-400 flex items-center gap-1">
                  <FileUp className="w-3.5 h-3.5" /> Файл обновления (exe):
                </label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".exe"
                  onChange={(e) => handlePickFile(e.target.files?.[0] || null)}
                  className="w-full text-xs p-2 rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-800 dark:text-white file:mr-2 file:px-2 file:py-1 file:rounded file:border-0 file:bg-emerald-600 file:text-white file:text-xs file:font-bold file:cursor-pointer"
                />
                {pubFile && (
                  <p className="text-xs text-emerald-600 dark:text-emerald-400">
                    {pubFile.name} · {formatSize(pubFile.size)} — будет загружен на сервер
                  </p>
                )}
              </div>

              <div className="space-y-1">
                <label className="text-xs font-mono font-bold text-slate-400 flex items-center gap-1">
                  <Link2 className="w-3.5 h-3.5" /> Или прямая ссылка (если файл не загружаете):
                </label>
                <input
                  type="text"
                  value={pubFileUrl}
                  onChange={(e) => setPubFileUrl(e.target.value)}
                  placeholder="https://…/Flux-Setup.exe (необязательно)"
                  className="w-full text-xs p-2 rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-800 dark:text-white font-mono"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-mono font-bold text-slate-400">Список изменений (Changelog):</label>
                <textarea
                  rows={4}
                  value={pubChangelog}
                  onChange={(e) => setPubChangelog(e.target.value)}
                  placeholder="• Добавлен конструктор таблиц ...&#10;• Улучшен импорт бланков ..."
                  className="w-full text-xs p-2 rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-800 dark:text-white font-sans resize-none"
                />
              </div>
            </div>

            {!!pubError && (
              <div className="mx-5 mb-4 text-xs leading-snug bg-rose-500/10 border border-rose-500/20 rounded p-2.5 text-rose-700 dark:text-rose-300">
                {pubError}
              </div>
            )}

            <div className="p-4 bg-slate-50 dark:bg-slate-990 border-t border-slate-200 dark:border-slate-850 flex items-center justify-end gap-2 shrink-0">
              <button type="button"
                onClick={() => setShowPublishModal(false)}
                disabled={isPublishing}
                className="px-4 py-1.5 bg-slate-200 hover:bg-slate-300 dark:bg-slate-900 dark:hover:bg-slate-850 text-slate-700 dark:text-slate-300 rounded text-xs font-bold transition-ui cursor-pointer disabled:opacity-50"
              >
                Отмена
              </button>
              <button type="button"
                onClick={handlePublishRelease}
                disabled={isPublishing}
                className="px-4 py-1.5 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white rounded text-xs font-bold transition-ui flex items-center gap-1.5 cursor-pointer shadow-md shadow-emerald-500/10 font-sans"
              >
                {isPublishing ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                )}
                <span>{isPublishing ? 'Загрузка на сервер...' : 'Опубликовать релиз'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
