/**
 * «Опубликовать»: проверка уже пройдена (её делает сама кнопка), остаётся «что нового», номер версии и отправка.
 * Повторная публикация после замечаний владельца — то же окно: версия предлагается следующая.
 */
import React, { useEffect, useState } from 'react';
import { call, type DraftState, type RequestRow } from '../call';
import Modal from './Modal';
import { nextVersion } from './helpers';
import { RIGHT_TEXT, type Right } from './useKey';

export default function PublishDialog({ id, right, onRequestRight, onClose, onDone }: {
  id: string; right: Right; onRequestRight: () => void; onClose: () => void; onDone: (message: string) => void;
}) {
  const [version, setVersion] = useState('');
  const [state, setState] = useState<DraftState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [first, setFirst] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const [tree, manifestFile, requests] = await Promise.all([
          call<{ state: DraftState }>('draftTree', { id }),
          call<{ text: string | null }>('draftFile', { id, path: 'manifest.json' }),
          call<RequestRow[]>('requests').catch(() => [] as RequestRow[]),
        ]);
        const current = String(JSON.parse(manifestFile.text || '{}').version || '0.1.0');
        const mine = requests.filter(r => r.moduleId === id);
        // Версия, которая уже уходила на публикацию, не повторяется: владелец видит разницу только между разными версиями
        setFirst(mine.length === 0);
        setVersion(mine.some(r => r.version === current) ? nextVersion(current) : current);
        setState(tree.state);
      } catch (e) { setError((e as Error).message); }
    })();
  }, [id]);

  const send = async () => {
    if (!state) return;
    setBusy(true); setError('');
    try {
      const manifest = await call<{ text: string | null }>('draftFile', { id, path: 'manifest.json' });
      const parsed = JSON.parse(manifest.text || '{}');
      if (parsed.version !== version) await call('draftSave', { id, path: 'manifest.json', text: `${JSON.stringify({ ...parsed, version }, null, 2)}\n` });
      await call('draftState', { id, changelog: state.changelog, comment: state.comment, channel: state.channel });
      const done = await call<{ id: string; warning: string; historyError?: string }>('publish', { id });
      onDone(`Запрос отправлен владельцу.${done.warning ? ` ${done.warning}` : ''}${done.historyError ? ` ${done.historyError}` : ''}`);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  const patch = (change: Partial<DraftState>) => state && setState({ ...state, ...change });
  const ready = right === 'issued';

  return (
    <Modal title="Опубликовать" onClose={onClose}>
      {!state ? <p className="fx-hint">{error || 'Загрузка…'}</p> : (
        <form onSubmit={e => { e.preventDefault(); if (ready && version && state.changelog.trim()) void send(); }}>
          <p className="fx-hint">Проверка пройдена. Владелец посмотрит программу и выпустит её.</p>
          <div className="field"><label htmlFor="pub-version">Номер версии</label>
            <input id="pub-version" className="fx-input short" value={version} onChange={e => setVersion(e.target.value)} maxLength={20} />
            {!first && <p className="fx-hint">Предложен следующий номер: такая версия уже отправлялась.</p>}</div>
          <div className="field"><label htmlFor="pub-changelog">Что нового</label>
            <textarea id="pub-changelog" className="fx-input" rows={3} maxLength={4000} value={state.changelog} onChange={e => patch({ changelog: e.target.value })} />
            <p className="fx-hint">Это увидят пользователи во Flux Store.</p></div>
          <div className="field"><label htmlFor="pub-comment">Комментарий владельцу (необязательно)</label>
            <textarea id="pub-comment" className="fx-input" rows={2} maxLength={4000} value={state.comment} onChange={e => patch({ comment: e.target.value })} /></div>
          <div className="field"><label htmlFor="pub-channel">Кому доступна</label>
            <select id="pub-channel" className="fx-input" value={state.channel} onChange={e => patch({ channel: e.target.value as 'test' | 'production' })}>
              <option value="test">Только тестировщикам</option><option value="production">Всем пользователям</option></select>
            <p className="fx-hint">Решает владелец; «всем» доступно после проверки у тестировщиков.</p></div>
          {!ready && <p className="fx-note fx-note-warn" role="status">{RIGHT_TEXT[right]}.{' '}
            {(right === 'none' || right === 'revoked') && <button type="button" className="fx-btn" onClick={onRequestRight}>Запросить право публиковать</button>}</p>}
          {error && <p className="fx-error" role="alert">{error}</p>}
          <div className="row studio-modal-actions">
            <button type="submit" className="fx-btn fx-btn-primary" disabled={busy || !ready || !version || !state.changelog.trim()}>{busy ? 'Отправляем…' : 'Отправить владельцу'}</button>
            <button type="button" className="fx-btn" onClick={onClose}>Отмена</button>
          </div>
        </form>)}
    </Modal>
  );
}
