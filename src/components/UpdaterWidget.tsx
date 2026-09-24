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
import { Dialog, Btn, Field, Input, Area } from './ui';
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
    <div className="max-w-xl text-left">
      <div className="fx-group-title flex items-center justify-between mt-2">
        <span>Автообновления</span>
        {status !== 'idle' && (
          <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500 animate-ping" />
        )}
      </div>

      <div className="space-y-2">
        <div className="fx-set-row">
          <span className="fx-set-text">Версия</span>
          <span className="text-sm tabular-nums">v{currentVersion}</span>
        </div>
        <div className="fx-set-row">
          <span className="fx-set-text">Источник обновлений</span>
          <span className="text-sm text-slate-500 dark:text-slate-400">
            {getServerBaseUrl() && !getServerBaseUrl().includes('localhost') ? 'Сервер компании' : 'Встроенный сервер'}
          </span>
        </div>

        {isDevSandbox && (
          <p className="fx-note fx-note-warn">Режим разработки — установка обновлений недоступна</p>
        )}

        {/* Одна кнопка на весь путь: проверить — и, если есть что ставить,
            поставить. Этапы человек видит строкой, а не набором кнопок */}
        {phase === 'available' && latest ? (
          <div className="space-y-2 pt-2">
            <div className="text-slate-700 dark:text-slate-300">
              Доступна версия <span className="text-slate-900 dark:text-white tabular-nums">v{latest.version}</span>
              {latest.size ? <span className="text-slate-400 font-normal"> · {formatSize(latest.size)}</span> : null}
            </div>
            <button type="button"
              onClick={handleInstall}
              className="fx-btn fx-btn-primary"
            >
              <Download className="w-3.5 h-3.5 shrink-0" />
              <span>{isElectron ? 'Скачать и установить' : 'Скачать файл'}</span>
            </button>
            <button type="button"
              onClick={() => setShowModal(true)}
              className="fx-btn fx-btn-quiet ml-2"
            >
              Что изменилось
            </button>
          </div>
        ) : busy ? (
          <div className="space-y-1.5 py-1">
            <div className="flex justify-between text-xs text-slate-500 dark:text-slate-400">
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
          <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400 py-2 text-xs">
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-emerald-500 shrink-0" />
            <span>Сравнение версий…</span>
          </div>
        ) : (
          <button type="button"
            onClick={handleCheck}
            className="fx-btn fx-btn-primary mt-3"
          >
            <RefreshCw className="w-3.5 h-3.5 shrink-0" />
            <span>Проверить обновления</span>
          </button>
        )}

        {/* Отказ объясняется словами и не прячется: человек должен знать, что
            обновления у него нет, и почему именно */}
        {!!error && (
          <div className="fx-error py-1">
            {error}
            {phase === 'failed' && latest && (
              <button type="button" onClick={handleInstall}
                className="fx-btn fx-btn-quiet block mt-1">Повторить</button>
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
              Релиз <span className="font-medium">v{b.version}</span> опубликован без файла: {b.why}.
              {!isAdmin && ' Обновиться по нему нельзя — скажите администратору.'}
            </div>
            {isAdmin && (
              <button type="button"
                onClick={async () => {
                  const err = await revoke(b.version);
                  addToast(err || `Публикация v${b.version} отозвана`, err ? 'error' : 'success');
                }}
                className="fx-btn fx-btn-quiet mt-1"
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
            className="fx-btn mt-3 ml-2"
          >
            <PlusCircle />
            <span>Опубликовать релиз</span>
          </button>
        )}
      </div>

      {/* Что изменилось и подтверждение установки */}
      {showModal && latest && (
        <Dialog title={<>Доступно обновление Flux <span className="text-slate-400 font-normal tabular-nums">v{latest.version}</span></>} label="Доступно обновление Flux" width="max-w-lg" onClose={() => setShowModal(false)}
          footer={<>
            <Btn size="lg" onClick={() => setShowModal(false)}>Закрыть</Btn>
            {phase === 'available' && (
              <Btn size="lg" tone="primary" onClick={handleInstall}><Download />{isElectron ? 'Скачать и установить' : 'Скачать файл'}</Btn>
            )}
          </>}>
          <div className="fx-label mb-1">Список изменений</div>
          <div className="whitespace-pre-line text-slate-700 dark:text-slate-300 max-h-[50vh] overflow-y-auto">
            {latest.changelog || 'Описание изменений не указано.'}
          </div>
          <p className="fx-hint mt-3">
            Файл скачивается с вашего сервера Flux. После загрузки приложение закроется,
            обновление подменит exe и программа запустится уже новой версии — данные не затрагиваются.
          </p>
        </Dialog>
      )}

      {/* Администратор: публикация релиза */}
      {showPublishModal && (
        <Dialog title="Публикация обновления" width="max-w-lg" onClose={() => setShowPublishModal(false)} busy={isPublishing}
          footer={<>
            <Btn size="lg" onClick={() => setShowPublishModal(false)} disabled={isPublishing}>Отмена</Btn>
            <Btn size="lg" tone="primary" onClick={handlePublishRelease} disabled={isPublishing}>
              {isPublishing ? 'Загрузка на сервер…' : 'Опубликовать релиз'}
            </Btn>
          </>}>
          <div className="space-y-3">
            {/* Куда уйдёт файл — сказано прямо. Раньше он оставался на диске
                того, кто публиковал, и сотрудники получали «файла этой версии
                нет», хотя запись о релизе видели все */}
            <p className="fx-note fx-note-warn">
              Файл уйдёт в общую базу — ту же, где лежат проекты и переписка. Оттуда его возьмёт
              программа каждого сотрудника, на какой бы машине она ни работала.
              Все, кто сейчас в программе, получат оповещение мгновенно; остальные — при следующей проверке.
            </p>
            <Field label="Номер релиза (версия)">
              <Input value={pubVersion} onChange={(e) => setPubVersion(e.target.value)} placeholder="Например: 0.25.0" className="code" />
              {/* Ошибку в номере видно сразу, а не после рассылки оповещения */}
              {!!versionProblem(pubVersion, currentVersion) && pubVersion.trim() !== '' && (
                <span className="fx-error">{versionProblem(pubVersion, currentVersion)}</span>
              )}
            </Field>
            <Field label="Файл обновления (exe)">
              <input ref={fileInputRef} type="file" accept=".exe" onChange={(e) => handlePickFile(e.target.files?.[0] || null)}
                className="text-xs text-slate-700 dark:text-slate-300 file:mr-2 file:border file:border-slate-300 file:rounded file:px-2 file:py-1 file:bg-transparent file:cursor-pointer" />
              {pubFile && <span className="fx-hint">{pubFile.name} · {formatSize(pubFile.size)} — будет загружен на сервер</span>}
            </Field>
            <Field label="Или прямая ссылка (если файл не загружаете)">
              <Input value={pubFileUrl} onChange={(e) => setPubFileUrl(e.target.value)} placeholder="https://…/Flux-Setup.exe (необязательно)" className="code" />
            </Field>
            <Field label="Список изменений">
              <Area rows={4} value={pubChangelog} onChange={(e) => setPubChangelog(e.target.value)} placeholder={'• Добавлен конструктор таблиц …\n• Улучшен импорт бланков …'} />
            </Field>
            {!!pubError && <p className="fx-error">{pubError}</p>}
          </div>
        </Dialog>
      )}
    </div>
  );
}
