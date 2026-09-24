/**
 * Лист «Flux Play» в Параметрах: общий выключатель платформы.
 *
 * Лист видит только тот, кому выдано управление платформой, — и видит он его
 * даже при выключенной платформе. Иначе выключатель отнимал бы право, которым
 * его двигают, и включить платформу обратно было бы некому.
 *
 * Здесь же — единственное место во всей программе, где про платформу говорят
 * вслух: почему она не включается на этой базе. Умолчать об этом нельзя. Для
 * человека, который её включает, «переключатель не работает» без объяснения —
 * это поломка, и искать он её будет не там.
 */
import React from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { ENV_CONFIG, getAuthToken } from '../../config/env';
import { usePolicyStore } from '../../store/policyStore';
import type { PlatformState } from '../../lib/appPolicy';
import SectionShell from './SectionShell';

const authHeaders = (): Record<string, string> => {
  const token = getAuthToken();
  return token
    ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
};

export default function PlayPlatform({ addToast }: { addToast: (m: string, kind?: any) => void }) {
  const platform = usePolicyStore((s) => s.platform);
  const refresh = usePolicyStore((s) => s.refresh);
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState('');
  const [keyDraft, setKeyDraft] = React.useState('');
  const [diag, setDiag] = React.useState<any | null>(null);
  const [diagFailure, setDiagFailure] = React.useState('');
  const [sessions, setSessions] = React.useState<Array<{
    id: string; gameId: string; state: string; ageMs: number; stuck: boolean;
  }>>([]);

  /** Один способ позвать сервер: отказ показывается словами, а не молчанием. */
  const ask = async (path: string, init?: RequestInit): Promise<any> => {
    const res = await fetch(`${ENV_CONFIG.apiUrl}/play${path}`, { headers: authHeaders(), ...init });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(String(data?.error || `сервер ответил ${res.status}`));
    return data;
  };

  /**
   * Диагностика спрашивается ВНЕ заслона платформы.
   *
   * Заслон отвечает «такого нет» всем без игровых прав — в том числе
   * администратору, которому платформу настраивать. Поэтому у диагностики свой
   * адрес и своя проверка: главный администратор видит причину, а обычный
   * сотрудник по-прежнему не видит ничего.
   */
  const loadDiagnostics = React.useCallback(async () => {
    try {
      const res = await fetch(`${ENV_CONFIG.apiUrl}/admin/play-diagnostics`, { headers: authHeaders() });
      if (res.status === 404) { setDiag(null); return; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(data?.error || `сервер ответил ${res.status}`));
      setDiag(data);
      setDiagFailure('');
    } catch (e: any) {
      setDiagFailure(e?.message || 'Не удалось собрать диагностику');
    }
  }, []);

  React.useEffect(() => { void loadDiagnostics(); }, [loadDiagnostics]);

  const grantAdmin = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${ENV_CONFIG.apiUrl}/admin/play-diagnostics/bootstrap`, {
        method: 'POST', headers: authHeaders(), body: '{}',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(data?.error || `сервер ответил ${res.status}`));
      await refresh();
      await loadDiagnostics();
      addToast('Управление платформой выдано вам. Доступ к самим играм выдаётся отдельно.', 'success');
    } catch (e: any) {
      setDiagFailure(e?.message || 'Не удалось выдать право');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Включить платформу одной кнопкой.
   *
   * Раньше это были три действия в трёх местах, и порядок их знал только тот,
   * кто писал программу: выдать себе управление, включить выключатель, выдать
   * себе доступ в карточке. Поэтому раздела не было ни у кого. Сервер делает
   * всё сразу и записывает каждое звено с автором — ничего не выдаётся молча.
   */
  const [openForMe, setOpenForMe] = React.useState(true);
  const enableAll = async () => {
    setBusy(true);
    setFailure('');
    try {
      const res = await fetch(`${ENV_CONFIG.apiUrl}/admin/play-diagnostics/enable`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ openForMe }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(data?.error || `сервер ответил ${res.status}`));
      await refresh();
      await loadDiagnostics();
      addToast(
        openForMe
          ? 'Flux Play включён, раздел открыт вам. Сотрудникам доступ выдаётся в их карточках.'
          : 'Flux Play включён. Доступ сотрудникам выдаётся в их карточках, в разделе «Сотрудники».',
        'success',
      );
      if ((data?.denied || []).length) {
        addToast('Часть доступа запрещена вам лично — запрет снимается в карточке сотрудника.', 'info');
      }
    } catch (e: any) {
      setFailure(e?.message || 'Не удалось включить платформу');
    } finally {
      setBusy(false);
    }
  };

  const loadSessions = React.useCallback(async () => {
    try {
      const data = await ask('/admin/sessions');
      setSessions(Array.isArray(data?.sessions) ? data.sessions : []);
    } catch (_) {
      // Платформа выключена или права сняты — списка просто нет, и это не повод
      // показывать красную плашку на весь лист
      setSessions([]);
    }
  }, []);

  React.useEffect(() => {
    if (!platform.enabled) return;
    void loadSessions();
    void (async () => {
      try {
        const data = await ask('/admin/builds');
        setKeyDraft(String(data?.publisherKey || ''));
      } catch (_) { /* ключа ещё нет */ }
    })();
  }, [platform.enabled, loadSessions]);

  const flipMaintenance = async () => {
    setBusy(true);
    setFailure('');
    try {
      await ask('/maintenance', { method: 'PUT', body: JSON.stringify({ on: !platform.maintenance }) });
      await refresh();
      addToast(
        platform.maintenance
          ? 'Обслуживание снято: матчи начинаются как обычно.'
          : 'Идёт обслуживание: новые матчи не начинаются, идущие продолжаются.',
        'success',
      );
    } catch (e: any) {
      setFailure(e?.message || 'Не удалось переключить обслуживание');
    } finally {
      setBusy(false);
    }
  };

  const saveKey = async () => {
    setBusy(true);
    setFailure('');
    try {
      await ask('/publisher-key', { method: 'PUT', body: JSON.stringify({ publicKey: keyDraft }) });
      addToast(keyDraft ? 'Ключ издателя сохранён.' : 'Ключ издателя убран: сборки ставиться не будут.', 'success');
    } catch (e: any) {
      setFailure(e?.message || 'Не удалось сохранить ключ');
    } finally {
      setBusy(false);
    }
  };

  const dropSession = async (id: string) => {
    setBusy(true);
    setFailure('');
    try {
      await ask(`/admin/cancel/${id}`, { method: 'POST', body: '{}' });
      await loadSessions();
      addToast('Матч снят: места освобождены, лобби вернулось в подготовку.', 'success');
    } catch (e: any) {
      setFailure(e?.message || 'Не удалось снять матч');
    } finally {
      setBusy(false);
    }
  };

  const flip = async () => {
    setBusy(true);
    setFailure('');
    try {
      const res = await fetch(`${ENV_CONFIG.apiUrl}/play/platform`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ enabled: !platform.enabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(data?.error || `сервер ответил ${res.status}`));
      await refresh();
      addToast(
        (data?.platform as PlatformState)?.enabled
          ? 'Flux Play включён. Доступ к нему выдаётся отдельно, в карточке сотрудника.'
          : 'Flux Play выключен — раздел исчез у всех сотрудников.',
        'success',
      );
    } catch (e: any) {
      setFailure(e?.message || 'Не удалось изменить состояние');
    } finally {
      setBusy(false);
    }
  };

  const on = platform.enabled;

  return (
    <SectionShell
      title="Flux Play"
      desc="Встроенная игровая платформа: общий выключатель на всю компанию"
    >
      {!platform.supported && (
        <div className="mb-4 fx-note fx-note-warn">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">На этой базе платформа не включается</p>
              <p className="text-xs text-amber-700/80 dark:text-amber-300/80 mt-1 leading-relaxed">
                {platform.note || 'База не поддерживает то, на чём держится платформа.'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Главное действие, пока платформа выключена: включить её одной кнопкой */}
      {diag && platform.supported && !platform.enabled && (
        <div className="mb-4 fx-set-group">
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Flux Play выключен для всей компании</p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed text-pretty">
            Поэтому раздела нет ни у кого — даже у тех, кому доступ уже выдан. После включения он появится
            у сотрудников с доступом в течение минуты, без перезапуска программы.
          </p>
          <label className="mt-2 flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
            <input type="checkbox" checked={openForMe} onChange={(e) => setOpenForMe(e.target.checked)}
              className="w-3.5 h-3.5 accent-emerald-500 cursor-pointer" />
            Открыть раздел и мне — доступ и все игры
          </label>
          <button type="button" onClick={() => void enableAll()} disabled={busy}
            className="mt-2.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50 cursor-pointer transition-colors">
            Включить Flux Play
          </button>
        </div>
      )}

      {/* Диагностика: почему раздела не видно и что с этим делать */}
      {diag && (
        <div className="mb-4 fx-set-group">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Диагностика</h3>
            <button
              type="button"
              onClick={() => void loadDiagnostics()}
              className="px-2 py-1 rounded-lg text-2xs font-bold bg-slate-100 dark:bg-slate-850
                         text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800
                         cursor-pointer transition-colors"
            >
              Повторить проверку
            </button>
          </div>

          <dl className="mt-2 space-y-1.5 text-xs">
            <div className="flex gap-2">
              <dt className="w-40 shrink-0 text-slate-400 dark:text-slate-500">Платформа</dt>
              <dd className="text-slate-700 dark:text-slate-150">
                {diag.platform?.enabled ? 'включена' : 'выключена'}
                {diag.platform?.maintenance ? ' · идёт обслуживание' : ''}
                {` · правило версии ${diag.platform?.policyVersion ?? '—'}`}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-40 shrink-0 text-slate-400 dark:text-slate-500">База</dt>
              <dd className="text-slate-700 dark:text-slate-150">
                {String(diag.database?.dialect || '')} · {diag.database?.note}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-40 shrink-0 text-slate-400 dark:text-slate-500">Ваш доступ к разделу</dt>
              <dd className={diag.me?.app?.allowed ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}>
                {diag.me?.app?.allowed ? 'есть' : 'нет'} — {diag.me?.app?.note}
                {diag.me?.validUntil ? ` (до ${new Date(diag.me.validUntil).toLocaleDateString('ru-RU')})` : ''}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-40 shrink-0 text-slate-400 dark:text-slate-500">Управление платформой</dt>
              <dd className={diag.me?.admin?.allowed ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}>
                {diag.me?.admin?.allowed ? 'есть' : 'нет'} — {diag.me?.admin?.note}
              </dd>
            </div>
          </dl>

          <ul className="mt-2 space-y-1 text-2xs">
            {(diag.games || []).map((g: any) => (
              <li key={g.id} className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-slate-700 dark:text-slate-150">{g.title}</span>
                <span className={g.allowed ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400 dark:text-slate-500'}>
                  {g.allowed ? 'доступна вам' : g.why}
                </span>
                {g.installable && (
                  <span className="text-slate-400 dark:text-slate-500">
                    {g.published ? `сборка ${g.published}` : 'сборка не опубликована'}
                  </span>
                )}
              </li>
            ))}
          </ul>

          {!diag.me?.admin?.allowed && (
            <button
              type="button"
              onClick={grantAdmin}
              disabled={busy}
              className="fx-btn fx-btn-primary mt-3"
            >
              Выдать мне управление платформой
            </button>
          )}
          <p className="mt-2 text-2xs text-slate-400 dark:text-slate-500 leading-relaxed">
            Кнопка выдаёт только управление платформой — записью в вашей карточке, с автором и временем.
            Доступ к самим играм она не выдаёт: его по-прежнему выдают отдельно, каждому сотруднику.
          </p>
          {diagFailure && (
            <p className="mt-2 text-xs font-semibold text-rose-600 dark:text-rose-400">{diagFailure}</p>
          )}
        </div>
      )}

      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={busy || !platform.supported}
        onClick={flip}
        className="fx-set-row w-full flex-row-reverse items-start text-left cursor-pointer disabled:opacity-60 disabled:cursor-default"
      >
        <span className="fx-switch shrink-0 pointer-events-none" aria-hidden="true" aria-checked={on} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100">
            Платформа включена в компании
          </span>
          <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed text-pretty">
            Выключатель ничего не выдаёт: он только открывает саму возможность.
            Доступ каждому сотруднику выдаётся отдельно — в его карточке, в разделе «Сотрудники».
            Пока доступ не выдан, раздела для человека не существует.
          </span>
        </span>
        {busy && <Loader2 className="w-4 h-4 shrink-0 animate-spin text-slate-400" />}
      </button>

      {failure && (
        <p className="mt-3 text-xs font-semibold text-rose-600 dark:text-rose-400 leading-relaxed">{failure}</p>
      )}

      <p className="mt-4 text-xs text-slate-400 dark:text-slate-500 leading-relaxed">
        Выключение действует немедленно: раздел пропадает у всех, кто сейчас в программе,
        не дожидаясь перезапуска.
      </p>

      {/* Обслуживание: доиграть можно, начать новое нельзя */}
      <button
        type="button"
        role="switch"
        aria-checked={!!platform.maintenance}
        disabled={busy || !platform.enabled}
        onClick={flipMaintenance}
        className="mt-2 fx-set-row w-full flex-row-reverse items-start text-left cursor-pointer disabled:opacity-60 disabled:cursor-default"
      >
        <span className="fx-switch shrink-0 pointer-events-none" aria-hidden="true" aria-checked={platform.maintenance} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100">Обслуживание</span>
          <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed text-pretty">
            Новые матчи не начинаются, уже идущие продолжаются. Это не то же самое,
            что выключить платформу: выключатель убирает раздел вместе с идущими матчами,
            а обслуживание даёт им закончиться.
          </span>
        </span>
      </button>

      {/* Ключ издателя: без него менеджер игр не поставит ничего */}
      <div className="mt-4 fx-set-group">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Ключ издателя сборок</h3>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 leading-relaxed text-pretty">
          Открытая часть ключа, которым подписаны описи сборок игр. Ею программа на машине
          сотрудника проверяет, что сборку выложили вы, а не кто-то, кто добрался до файлового
          сервера. Подписывающая часть сюда не вводится никогда — она остаётся у владельца.
        </p>
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <input
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value.trim())}
            spellCheck={false}
            placeholder="64 знака шестнадцатеричной записи"
            className="flex-1 min-w-[16rem] px-2.5 py-1.5 rounded-lg text-xs font-mono
                       bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-150
                       border border-slate-200 dark:border-slate-800"
          />
          <button
            type="button"
            onClick={saveKey}
            disabled={busy}
            className="fx-btn fx-btn-primary"
          >
            Сохранить
          </button>
        </div>
      </div>

      {/* Зависшие матчи: лобби, из которого иначе никогда не начать */}
      <div className="mt-4 fx-set-group">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Идущие матчи</h3>
          <button
            type="button"
            onClick={loadSessions}
            className="px-2 py-1 rounded-lg text-2xs font-bold bg-slate-100 dark:bg-slate-850
                       text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800
                       cursor-pointer transition-colors"
          >
            Обновить
          </button>
        </div>
        {!sessions.length && (
          <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">Сейчас матчей нет.</p>
        )}
        <ul className="mt-2 space-y-1.5">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center gap-2 flex-wrap text-xs">
              <span className={`shrink-0 px-1.5 py-0.5 rounded font-bold text-2xs ${
                s.stuck
                  ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-300'
                  : 'bg-slate-100 dark:bg-slate-850 text-slate-500 dark:text-slate-400'
              }`}
              >
                {s.stuck ? 'завис' : s.state === 'ALLOCATING' ? 'выделяется' : 'идёт'}
              </span>
              <span className="font-semibold text-slate-700 dark:text-slate-150">{s.gameId}</span>
              <span className="text-slate-400 dark:text-slate-500">{Math.round(s.ageMs / 60000)} мин</span>
              <button
                type="button"
                onClick={() => dropSession(s.id)}
                className="ml-auto px-2 py-0.5 rounded-lg text-2xs font-bold bg-slate-100 dark:bg-slate-850
                           text-slate-600 dark:text-slate-300 hover:text-rose-600 dark:hover:text-rose-400
                           cursor-pointer transition-colors"
              >
                Снять
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-2xs text-slate-400 dark:text-slate-500 leading-relaxed">
          Снятый матч освобождает места, а лобби возвращается в подготовку — группа сможет начать заново.
        </p>
      </div>
    </SectionShell>
  );
}
