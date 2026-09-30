/**
 * Подключение на экране входа — одно поле вместо двух окон.
 *
 * Было: кнопка «сервер» со своим окном и кнопка «база» с окном на пять полей.
 * Человек, которому надо просто подключиться к базе отдела, проходил оба и
 * путался, какое из них ему нужно. Теперь он вставляет то, что ему дали, —
 * строку `mysql://…`, `postgresql://…` или адрес сервера, — а программа сама
 * понимает, что это (src/lib/connection.ts), показывает распознанное без
 * пароля, проверяет и подключается одной кнопкой.
 *
 * Как именно подключаться, зависит от того, работает ли встроенный сервер:
 *  - работает (обычный режим) — он сам проверяет базу и переключается на неё;
 *  - не работает (выбран сервер компании) — спросить некого, поэтому настройку
 *    пишет оболочка, а программа перезапускается уже на новой базе.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Database, Server, Laptop, Loader2, Eye, EyeOff } from 'lucide-react';
import { dataService } from '../services/dataService';
import { getConfiguredServerUrl, setConfiguredServerUrl } from '../config/env';
import { readConnection } from '../lib/connection';
import { labelOfUrl, ENGINE_LABEL } from '../lib/dbUrl';

const shell = (): any => (window as any).electron?.ipcRenderer;

async function serverAnswers(url: string): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch(`${url}/api/health`, { signal: ctl.signal });
    clearTimeout(t);
    return r.ok;
  } catch (_) {
    return false;
  }
}

/** Перезапуск программы, если режим меняется; в браузере — перезагрузка страницы */
async function restart() {
  const s = shell();
  if (s?.invoke) { try { await s.invoke('app:relaunch'); return; } catch (_) { /* ниже — перезагрузка */ } }
  window.location.reload();
}

export default function ConnectionPanel() {
  const [serverUrl] = useState(() => getConfiguredServerUrl());
  const [dbType, setDbType] = useState('LOCAL');
  const [dbUrl, setDbUrl] = useState('');
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (serverUrl) return; // режим сервера компании: встроенного сервера нет
    dataService.getDbConfig().then((c: any) => {
      setDbType(c?.current_db_type || 'LOCAL');
      setDbUrl(c?.database_url || '');
    }).catch(() => {});
  }, [serverUrl]);

  const current = serverUrl ? `Сервер компании · ${serverUrl.replace(/^https?:\/\//, '')}` : labelOfUrl(dbType, dbUrl);
  const isLocal = !serverUrl && String(dbType).toUpperCase() !== 'REMOTE';
  const parsed = useMemo(() => readConnection(draft), [draft]);

  // Что распознано — без пароля: строка на виду у всех, кто рядом
  const recognized = parsed.kind === 'database'
    ? `База ${ENGINE_LABEL[parsed.parts.engine]} · ${parsed.parts.host}:${parsed.parts.port} · ${parsed.parts.database} · пользователь ${parsed.parts.user}`
    : parsed.kind === 'server' ? `Сервер компании · ${parsed.url}` : '';

  const useDatabase = async (url: string) => {
    const s = shell();
    if (serverUrl && s?.invoke) {
      // Встроенный сервер не запущен — настройку пишет оболочка, проверит старт
      await setConfiguredServerUrl('');
      const r = await s.invoke('app:set-database', url);
      if (!r?.success) throw new Error(r?.error || 'Не удалось сохранить подключение.');
      await restart();
      return;
    }
    const type = url ? 'REMOTE' : 'LOCAL';
    if (url) {
      const t = await dataService.testDbConnection({ current_db_type: type, database_url: url }) as any;
      if (!t?.success) throw new Error(t?.message || 'База не отвечает.');
    }
    const r = await dataService.switchDb({ current_db_type: type, database_url: url }) as any;
    if (r && r.success === false) throw new Error(r.message || 'Не удалось переключить базу.');
    window.location.reload();
  };

  const connect = async () => {
    if (parsed.kind === 'error') {
      // Кнопки «Этот компьютер» на локальной базе нет — и отправлять к ней нельзя
      setError(isLocal && /Этот компьютер/.test(parsed.error) ? 'Программа уже работает с базой на этом компьютере.' : parsed.error);
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (parsed.kind === 'server') {
        if (!(await serverAnswers(parsed.url))) throw new Error('Сервер не отвечает. Проверьте адрес и что сервер компании запущен.');
        await setConfiguredServerUrl(parsed.url);
        await restart();
      } else {
        await useDatabase(parsed.url);
      }
    } catch (e: any) {
      // Встроенный сервер переключает базу до входа только с этого же компьютера
      const text = String(e?.message || e || '');
      setError(/401|403|требуется вход/i.test(text)
        ? 'Подключение меняется в программе на этом компьютере, а не через браузер.'
        : text || 'Не удалось подключиться.');
      setBusy(false);
    }
  };

  const toLocal = async () => {
    setBusy(true);
    setError('');
    try { await useDatabase(''); } catch (e: any) { setError(String(e?.message || e)); setBusy(false); }
  };

  return (
    <div className="w-full flex flex-col items-center gap-2 pb-1">
      <button
        type="button"
        onClick={() => { setOpen((v) => !v); setError(''); }}
        className="fx-btn fx-btn-quiet"
        aria-expanded={open}
        title="Где программа берёт данные"
      >
        {serverUrl ? <Server className="w-4 h-4" /> : isLocal ? <Laptop className="w-4 h-4" /> : <Database className="w-4 h-4" />}
        <span>Подключение: {current.replace(/^База: /, '')}</span>
      </button>

      {open && (
        <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-3">
          <label className="fx-field block">
            <span className="fx-label block mb-1">Строка подключения к базе или адрес сервера</span>
            <div className="flex items-center gap-2">
              <input
                type={show ? 'text' : 'password'}
                value={draft}
                autoFocus
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => { setDraft(e.target.value); setError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void connect(); }}
                placeholder="mysql://имя:пароль@192.168.1.10:3306/Flux"
                className="fx-input font-mono flex-1 min-w-0"
              />
              <button type="button" className="fx-ibtn" onClick={() => setShow((v) => !v)}
                aria-label={show ? 'Скрыть строку' : 'Показать строку'} title={show ? 'Скрыть' : 'Показать'}>
                {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </label>

          {error
            ? <p className="fx-error">{error}</p>
            : recognized
              ? <p className="fx-hint">{recognized}</p>
              : <p className="fx-hint">Вставьте строку, которую дал администратор: mysql://…, postgresql://… или http://адрес:3000.</p>}

          <div className="flex items-center justify-end gap-2">
            {!isLocal && (
              <button type="button" className="fx-btn fx-btn-quiet mr-auto" onClick={toLocal} disabled={busy}
                title="Работать с базой на этом компьютере">
                <Laptop className="w-4 h-4" /> Этот компьютер
              </button>
            )}
            <button type="button" className="fx-btn" onClick={() => setOpen(false)} disabled={busy}>Отмена</button>
            <button type="button" className="fx-btn fx-btn-primary" onClick={connect} disabled={busy || !draft.trim()}>
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              Подключиться
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
