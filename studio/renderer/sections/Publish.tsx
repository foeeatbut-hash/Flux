/**
 * Раздел «Публикация»: ключ разработчика и сертификат, «Отправить на публикацию», состояние запросов и замечания владельца.
 * Закрытый ключ окно не видит: показывается только открытая часть, подписывает главный процесс.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { SectionHead } from '../../../src/components/ui/controls';
import { call, REQUEST_STATES, STATE_TONE, type DraftState, type KeyInfo, type RequestRow } from '../call';

const CERT: Record<string, string> = {
  nokey: 'Ключа нет', none: 'Сертификата нет: запросите его у владельца', requested: 'Запрос отправлен владельцу, ждём сертификат', issued: 'Сертификат выдан', revoked: 'Сертификат отозван', foreign: 'Ключ выдан другому профилю',
};
const CERT_TONE: Record<string, string> = { nokey: 'muted', requested: 'warn', none: 'warn', issued: 'ok', revoked: 'bad', foreign: 'bad' };

function KeyCard() {
  const [info, setInfo] = useState<KeyInfo | null>(null);
  const [cert, setCert] = useState('nokey');
  const [request, setRequest] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const refresh = useCallback(async () => {
    try { setInfo(await call<KeyInfo>('keyInfo')); setCert((await call<{ status: string }>('keyCertificate')).status); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const act = async (fn: () => Promise<void>) => { setError(''); try { await fn(); } catch (e) { setError((e as Error).message); } };

  return (
    <div className="panel" aria-labelledby="key-title">
      <h3 id="key-title">Ключ разработчика и сертификат</h3>
      <p className="fx-hint">Закрытая часть ключа хранится в защищённом хранилище Windows и никуда не передаётся. Запрос уходит владельцу в очередь, он выдаёт сертификат.</p>
      {error && <p className="fx-error" role="alert">{error}</p>}
      {info && !info.available && !info.exists && <p className="fx-error" role="alert">Защищённое хранилище на этом компьютере недоступно, ключ создать нельзя. Войдите в Windows своей учётной записью.</p>}
      {info?.damaged && <p className="fx-error" role="alert">Файл ключа повреждён, поэтому новый ключ не создаётся: он затёр бы прежний. Сохраните копию developer-key.json из каталога данных Studio и обратитесь к владельцу.</p>}
      {info && !info.exists && !info.damaged && <div className="row"><button className="fx-btn fx-btn-primary" disabled={!info.available} onClick={() => act(async () => { await call('keyCreate'); await refresh(); })}>Создать ключ</button></div>}
      {info?.exists && <>
        <dl className="facts">
          <dt>Открытая часть</dt><dd className="code" data-testid="public-key">{info.publicKey}</dd>
          <dt>Сертификат</dt><dd><span className={`dot ${CERT_TONE[cert] || 'muted'}`} aria-hidden="true" />{CERT[cert] || cert}</dd>
        </dl>
        <div className="row">
          <button className="fx-btn fx-btn-primary" disabled={cert === 'issued' || cert === 'requested'} onClick={() => act(async () => { await call('keyRequestSend'); await refresh(); })}>Отправить владельцу</button>
          <button className="fx-btn" onClick={() => act(async () => { setRequest((await call<{ text: string }>('keyRequest')).text); setCopied(false); })}>Показать текст запроса</button>
          <button className="fx-btn" onClick={() => void refresh()}>Обновить статус</button>
        </div>
        <p className="fx-hint">«Отправить владельцу» кладёт запрос в очередь владельца. Текст запроса — запасной путь: его можно передать любым способом.</p>
        <div className="row">
          {!confirmNew ? <button className="fx-btn" onClick={() => setConfirmNew(true)}>Создать новый ключ…</button> : <>
            <span className="fx-error" role="alert">Сертификат прежнего ключа перестанет подходить, его придётся запрашивать заново. Прежний файл ключа сохранится копией.</span>
            <button className="fx-btn" onClick={() => act(async () => { await call('keyCreate', { replace: true }); setConfirmNew(false); setRequest(''); await refresh(); })}>Да, создать новый ключ</button>
            <button className="fx-btn" onClick={() => setConfirmNew(false)}>Отмена</button></>}
        </div>
        {request && <div className="field"><label htmlFor="cert-request">Передайте этот запрос владельцу</label>
          <textarea id="cert-request" rows={3} readOnly value={request} onFocus={e => e.currentTarget.select()} />
          <div className="row"><button className="fx-btn" onClick={() => { void navigator.clipboard?.writeText(request).then(() => setCopied(true)); }}>{copied ? 'Скопировано' : 'Скопировать'}</button></div></div>}
      </>}
    </div>
  );
}

export default function Publish({ id, onGo, onOpen }: { id: string; onGo: (section: string) => void; onOpen: (id: string) => void }) {
  const [state, setState] = useState<DraftState | null>(null);
  const [requests, setRequests] = useState<RequestRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState('');
  const load = useCallback(async () => { try { setRequests(await call<RequestRow[]>('requests')); } catch (e) { setError((e as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setState(null); if (id) void call<{ state: DraftState }>('draftTree', { id }).then(t => setState(t.state)).catch(() => {}); }, [id]);

  const patch = async (change: Partial<DraftState>) => { if (!state) return; setState({ ...state, ...change }); try { await call('draftState', { id, ...change }); } catch (e) { setError((e as Error).message); } };
  const send = async () => {
    setBusy(true); setError(''); setSent('');
    try {
      const done = await call<{ id: string; warning: string }>('publish', { id });
      setSent(`Запрос отправлен владельцу.${done.warning ? ` ${done.warning}` : ''}`);
      await load();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  const reopen = async (row: RequestRow) => {
    setError('');
    try { const made = await call<{ id: string }>('draftImport', { requestId: row.id }); onOpen(made.id); onGo('project'); }
    catch (e) { setError((e as Error).message); }
  };

  return (
    <section aria-label="Публикация" className="fx-page">
      <SectionHead title="Публикация" />
      <div className="fx-page-body p-4 studio-body">
      <KeyCard />
      <div className="panel" aria-labelledby="send-title">
        <h3 id="send-title">Отправить на публикацию</h3>
        {!id ? <div className="empty small">Откройте проект в разделе «Проект программы».</div> : state && <>
          <p className="fx-hint">Проект «{id}». Перед отправкой Studio заново прогоняет проверку; если она не пройдена, отправка недоступна.</p>
          <div className="field"><label htmlFor="pub-changelog">Что нового</label>
            <textarea id="pub-changelog" rows={2} maxLength={4000} value={state.changelog} onChange={e => patch({ changelog: e.target.value })} /></div>
          <div className="field"><label htmlFor="pub-comment">Комментарий владельцу</label>
            <textarea id="pub-comment" rows={2} maxLength={4000} value={state.comment} onChange={e => patch({ comment: e.target.value })} /></div>
          <div className="field"><label htmlFor="pub-channel">Просить канал</label>
            <select id="pub-channel" value={state.channel} onChange={e => patch({ channel: e.target.value as 'test' | 'production' })}>
              <option value="test">Тестовый</option><option value="production">Рабочий</option></select>
            <p className="fx-hint">Решает владелец. Рабочий канал сразу доступен только с правом «Просить рабочий канал».</p></div>
          {error && <p className="fx-error" role="alert">{error}</p>}
          {sent && <p className="verdict ok" role="status">{sent}</p>}
          <div className="row">
            <button className="fx-btn fx-btn-primary" onClick={send} disabled={busy}>{busy ? 'Отправляем…' : 'Отправить на публикацию'}</button>
            <button className="fx-btn" onClick={() => onGo('check')}>Проверка</button></div>
        </>}
      </div>

      <h3>Мои запросы</h3>
      {requests && requests.length === 0 && <div className="empty">Вы ещё ничего не отправляли.</div>}
      {requests && requests.length > 0 && (
        <table className="fx-table"><thead><tr><th>Программа</th><th>Версия</th><th>Состояние</th><th>Замечания владельца</th><th></th></tr></thead>
          <tbody>{requests.map(r => (
            <tr key={r.id}>
              <td className="code">{r.moduleId}</td><td>{r.version}</td>
              <td><span className={`dot ${STATE_TONE[r.state] || 'muted'}`} aria-hidden="true" />{REQUEST_STATES[r.state] || r.state}</td>
              <td>{r.review ? <>{r.review.note}{r.review.comments.map((c, i) => <div key={i} className="fx-hint"><span className="code">{c.path}{c.line ? `:${c.line}` : ''}</span> {c.text}</div>)}</> : <span className="fx-hint">—</span>}</td>
              <td className="end">{['returned', 'rejected'].includes(r.state) && <button className="fx-btn" onClick={() => reopen(r)}>Исправить и отправить заново</button>}</td>
            </tr>))}</tbody></table>
      )}
      </div>
    </section>
  );
}
