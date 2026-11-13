/**
 * «Запустить во Flux»: тот же пакет, что уйдёт владельцу, но во Flux на этом компьютере и только у вас — без Store и проверки.
 * Всё делает главный процесс (studio/shell/devRunHost.ts); здесь кнопка, состояние и причина отказа словами.
 * Состояние спрашивается раз в несколько секунд: продление аренды может не удаться без участия окна (Flux убрал папку).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { call } from '../call';

interface DevRunState { running: boolean; moduleId: string; version: string; builtAt: number; problem: string }
const POLL_MS = 5000;

export default function DevRun({ id, onStarted }: { id: string; onStarted?: () => void }) {
  const [state, setState] = useState<DevRunState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const refresh = useCallback(() => call<DevRunState>('devRunState').then(s => { if (alive.current) setState(s); }).catch(() => {}), []);
  useEffect(() => {
    setError('');
    void refresh();
    const timer = setInterval(() => { void refresh(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [id, refresh]);

  const act = async (action: 'devRunStart' | 'devRunStop') => {
    setBusy(true); setError('');
    try {
      const next = await call<DevRunState>(action, { id });
      if (alive.current) setState(next);
      if (action === 'devRunStart') onStarted?.();
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setBusy(false); }
  };

  const mine = !!state?.running && state.moduleId === id;
  const time = mine ? new Date(state!.builtAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <div className="panel" aria-labelledby="devrun-title" data-testid="studio-devrun">
      <h3 id="devrun-title">Запуск во Flux</h3>
      {mine ? (
        <>
          <div className="row">
            <span className="fx-st fx-st-ok" role="status">Запущено во Flux — до закрытия Studio</span>
            <span className="muted">версия {state!.version}, собрано в {time}</span>
          </div>
          {state!.problem && <p className="error" role="alert">{state!.problem} Запуск во Flux остановится сам через минуту.</p>}
          <p className="hint">Откройте Flux на этом компьютере и войдите под своим именем: программа появится в списке с плашкой «Разработка — не выпущено». Другим людям и в Store она не попадает.</p>
          <div className="row">
            <button className="fx-btn" disabled={busy} onClick={() => void act('devRunStart')}>Запустить заново</button>
            <button className="fx-btn" disabled={busy} onClick={() => void act('devRunStop')}>Убрать</button>
          </div>
        </>
      ) : (
        <>
          <p className="hint">Проверьте программу так, как её увидят люди, не отправляя в Store: она появится во Flux на этом компьютере у вас одного, на настоящих данных проектов. Подходит для всех языков, включая Python.</p>
          <div className="row"><button className="fx-btn" disabled={busy} onClick={() => void act('devRunStart')}>Запустить во Flux</button></div>
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
