/**
 * Раздел «Проверка перед отправкой»: договор, привязки, контрольные примеры, пределы, методология, «что нового», снимки.
 * Не прошло — отправка недоступна. Строки «не проверяется автоматически» показаны отдельно: это не отказ, а честная граница.
 */
import React, { useEffect, useState } from 'react';
import { SectionHead } from '../../../src/components/ui/controls';
import { call, type CheckReport, type DraftState } from '../call';

const WORDS = { ok: 'Выполнено', fail: 'Не прошло', manual: 'Не проверяется автоматически' } as const;
const TONE = { ok: 'ok', fail: 'bad', manual: 'muted' } as const;

export default function Check({ id, onGo }: { id: string; onGo: (section: string) => void }) {
  const [report, setReport] = useState<CheckReport | null>(null);
  const [changelog, setChangelog] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setReport(null); setError('');
    if (id) void call<{ state: DraftState }>('draftTree', { id }).then(t => setChangelog(t.state.changelog)).catch(e => setError(e.message));
  }, [id]);

  const run = async () => {
    setBusy(true); setError('');
    try {
      await call('draftState', { id, changelog });
      setReport(await call<CheckReport>('check', { id }));
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  return (
    <section aria-label="Проверка перед отправкой" className="fx-page">
      <SectionHead title="Проверка перед отправкой" />
      <div className="fx-page-body p-4 studio-body">
      <p className="fx-hint">Проверка идёт на этом компьютере по проекту «{id || '—'}». Отчёт прикладывается к запросу и виден владельцу.</p>
      {!id && <div className="empty">Сначала откройте проект в разделе «Проект программы».</div>}
      {id && <>
        <div className="field"><label htmlFor="changelog">Что нового</label>
          <textarea id="changelog" rows={3} maxLength={4000} value={changelog} onChange={e => setChangelog(e.target.value)} />
          <p className="fx-hint">Без этого пользователь во Flux Store не поймёт, зачем обновляться.</p></div>
        {error && <p className="fx-error" role="alert">{error}</p>}
        <div className="row"><button className="fx-btn fx-btn-primary" onClick={run} disabled={busy}>{busy ? 'Проверяем…' : 'Проверить'}</button></div>
      </>}
      {report && <>
        <p className={report.ok ? 'verdict ok' : 'verdict bad'} role="status">
          {report.ok ? 'Проверка пройдена. Можно отправлять на публикацию.' : 'Проверка не пройдена: отправка недоступна, пока есть строки «Не прошло».'}
        </p>
        <table className="fx-table"><thead><tr><th>Проверка</th><th>Итог</th><th>Подробности</th></tr></thead>
          <tbody>{report.items.map(item => (
            <tr key={item.id}><td>{item.title}</td>
              <td><span className={`dot ${TONE[item.status]}`} aria-hidden="true" />{WORDS[item.status]}</td>
              <td>{item.detail}</td></tr>))}</tbody></table>
        {report.ok && <div className="row"><button className="fx-btn fx-btn-primary" onClick={() => onGo('publish')}>Перейти к публикации</button></div>}
      </>}
      </div>
    </section>
  );
}
