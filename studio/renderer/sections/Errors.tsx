/**
 * Раздел «Ошибки»: обращения пользователей и счётчики сбоев по своим программам.
 * Данных проектов здесь нет: сервер отдаёт разработчику только обезличенное (обращения по программе и счётчики по видам сбоя).
 * «Исправлено в версии» переводит обращение на проверку автору, ему во Flux приходит «Обновить».
 */
import React, { useCallback, useEffect, useState } from 'react';
import { SectionHead } from '../../../src/components/ui/controls';
import { call } from '../call';

interface Report { id: string; number: number; title: string; moduleId: string; moduleVersion: string; status: string; impact: string; revision: number; resolvedVersion: string | null; createdAt: string; known: boolean }
interface Crash { moduleId: string; version: string; kind: string; count: number }
const STATUS: Record<string, string> = {
  NEW: 'Новое', TRIAGE: 'Разбирается', NEEDS_INFO: 'Нужны подробности', PLANNED: 'В планах', IN_PROGRESS: 'В работе', VERIFY: 'На проверке у автора',
  DONE: 'Закрыто', REJECTED: 'Отклонено', DUPLICATE: 'Дубль', WITHDRAWN: 'Отозвано',
};
const IMPACT: Record<string, string> = { LOW: 'Есть обход', NORMAL: 'Мешает', HIGH: 'Не могу продолжить' };
const KIND: Record<string, string> = { crash: 'Сбой', timeout: 'Не уложилась во время', memory: 'Не хватило памяти', bridge: 'Ошибка обмена данными', controls: 'Контрольные примеры', connection: 'Подключение' };

export default function Errors({ bare }: { bare?: boolean }) {
  const [data, setData] = useState<{ reports: Report[]; crashes: Crash[] } | null>(null);
  const [error, setError] = useState('');
  const [fix, setFix] = useState<Record<string, string>>({});
  const load = useCallback(async () => { try { setData(await call('errors')); } catch (e) { setError((e as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);
  const mark = async (r: Report) => {
    setError('');
    try { await call('errorFixed', { reportId: r.id, version: fix[r.id] || '', revision: r.revision }); await load(); } catch (e) { setError((e as Error).message); }
  };
  const open = (r: Report) => !['DONE', 'REJECTED', 'DUPLICATE', 'WITHDRAWN', 'VERIFY'].includes(r.status);

  return (
    <section aria-label="Сбои у пользователей" className="fx-page">
      {!bare && <SectionHead title="Ошибки" />}
      <div className="fx-page-body p-4 studio-body">
      <p className="fx-hint">Обращения и счётчики сбоев по вашим программам. Данные проектов пользователей сюда не попадают.</p>
      {error && <p className="fx-error" role="alert">{error}</p>}
      <h3>Обращения</h3>
      {data && data.reports.length === 0 && <div className="empty">Обращений по вашим программам нет.</div>}
      {data && data.reports.length > 0 && (
        <table className="fx-table"><thead><tr><th>№</th><th>Программа</th><th>Обращение</th><th>Влияние</th><th>Состояние</th><th>Исправлено в версии</th></tr></thead>
          <tbody>{data.reports.map(r => (
            <tr key={r.id}><td>{r.number}</td><td><span className="code">{r.moduleId}</span> {r.moduleVersion}</td><td>{r.title}</td>
              <td>{IMPACT[r.impact] || r.impact}</td><td>{STATUS[r.status] || r.status}</td>
              <td>{r.resolvedVersion ? r.resolvedVersion : open(r) ? (
                <span className="row tight"><label className="sr" htmlFor={`fix-${r.id}`}>Версия исправления, обращение {r.number}</label>
                  <input id={`fix-${r.id}`} className="short" placeholder="1.2.3" value={fix[r.id] || ''} onChange={e => setFix({ ...fix, [r.id]: e.target.value })} />
                  <button className="fx-btn" disabled={!/^\d+\.\d+\.\d+$/.test(fix[r.id] || '')} onClick={() => mark(r)}>Отметить</button></span>
              ) : <span className="fx-hint">—</span>}</td></tr>))}</tbody></table>
      )}
      <h3>Счётчики сбоев</h3>
      {data && data.crashes.length === 0 && <div className="empty">Сбоев не зарегистрировано.</div>}
      {data && data.crashes.length > 0 && (
        <table className="fx-table"><thead><tr><th>Программа</th><th>Версия</th><th>Вид</th><th>Случаев</th></tr></thead>
          <tbody>{data.crashes.map((c, i) => <tr key={i}><td className="code">{c.moduleId}</td><td>{c.version}</td><td>{KIND[c.kind] || c.kind}</td><td>{c.count}</td></tr>)}</tbody></table>
      )}
      </div>
    </section>
  );
}
