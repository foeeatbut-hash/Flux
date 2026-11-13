/**
 * Нижняя панель рабочего окна: «Запуск», «Проблемы», «Публикация», «История», «Сбои у пользователей».
 * Панель сворачивается; вкладки переключаются сами: запуск открывает «Запуск», неудачная проверка — «Проблемы».
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Empty, Status, Tabs } from '../../../src/components/ui/controls';
import { call, REQUEST_STATES, STATE_TONE, type RequestRow } from '../call';
import { TONE } from '../Modules';
import Run from '../sections/Run';
import DevRun from '../sections/DevRun';
import Errors from '../sections/Errors';
import { locate, noteProblems, reviewProblems, type Problem } from './helpers';
import type { AnchoredNote } from '../../shared/ownerNotes';
import { RIGHT_TEXT, RIGHT_TONE, type Right } from './useKey';
import HistoryPanel, { type HistoryHooks } from './History';
import Releases from './Releases';

export type PanelTab = 'run' | 'problems' | 'notes' | 'publication' | 'history' | 'failures';

export function ProblemList({ problems, onGo, empty }: { problems: Problem[]; onGo: (path: string, line?: number) => void; empty: string }) {
  if (!problems.length) return <p className="fx-hint p-3">{empty}</p>;
  return (
    <ul className="studio-problems">
      {problems.map((p, i) => (
        <li key={i}>
          <button type="button" className="studio-problem" disabled={!p.path} onClick={() => p.path && onGo(p.path, p.line)}>
            <span className="studio-problem-src">{p.source}</span>
            <span className="studio-problem-text">{p.title}{p.detail && <span className="fx-hint"> {p.detail}</span>}</span>
            {p.path && <span className="code studio-problem-where">{p.path}{p.line ? `:${p.line}` : ''}</span>}
          </button>
        </li>))}
    </ul>
  );
}

export default function BottomPanel({ id, tab, onTab, open, onToggle, runSignal, problems, onProblems, onGo, right, onRequestRight, rightError, requestsVersion, history, notes }: {
  id: string; tab: PanelTab; onTab: (t: PanelTab) => void; open: boolean; onToggle: () => void; runSignal: number;
  problems: Problem[]; onProblems: (list: Problem[]) => void; onGo: (path: string, line?: number) => void;
  right: Right; onRequestRight: () => void; rightError: string; requestsVersion: number; history: HistoryHooks; notes: { version: string; notes: AnchoredNote[] } | null;
}) {
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(async () => { try { setRequests((await call<RequestRow[]>('requests')).filter(r => r.moduleId === id)); setError(''); } catch (e) { setError((e as Error).message); } }, [id]);
  useEffect(() => { void load(); }, [load, requestsVersion]);
  const latest = requests.length ? requests.reduce((a, b) => a.createdAt > b.createdAt ? a : b) : null;
  const owner = problems.filter(p => p.source === 'Владелец');
  const own = problems.filter(p => p.source !== 'Владелец');
  const reviewRows = [...reviewProblems(latest?.review ?? null)];

  return (
    <div className={`studio-bottom${open ? '' : ' is-closed'}`}>
      <div className="studio-bottom-head">
        <Tabs<PanelTab> value={tab} onChange={t => { onTab(t); if (!open) onToggle(); }} label="Нижняя панель"
          tabs={[{ value: 'run', label: 'Запуск' }, { value: 'problems', label: 'Проблемы', count: own.length || undefined }, { value: 'notes', label: 'Замечания', count: notes?.notes.length || undefined }, { value: 'publication', label: 'Публикация' }, { value: 'history', label: 'История' }, { value: 'failures', label: 'Сбои у пользователей' }]} />
        <button type="button" className="fx-ibtn studio-bottom-toggle" aria-label={open ? 'Свернуть панель' : 'Развернуть панель'} onClick={onToggle}>{open ? <ChevronDown /> : <ChevronUp />}</button>
      </div>
      {open && (
        <div className="studio-bottom-body">
          {/* Запуск не размонтируется при смене вкладки: программа остаётся запущенной */}
          <div hidden={tab !== 'run'} className="studio-run"><DevRun id={id} /><Run id={id} signal={runSignal} onFail={text => onProblems([{ source: 'Запуск', title: text, detail: '', ...locate(text) }, ...own.filter(p => p.source !== 'Запуск'), ...owner])} /></div>
          {tab === 'problems' && <ProblemList problems={own} onGo={onGo} empty="Проблем нет. Нажмите «Проверить», чтобы убедиться." />}
          {tab === 'notes' && (
            <div>
              {notes && notes.notes.length > 0 && <p className="fx-hint px-3 pt-2">Замечания владельца к версии {notes.version}. Метка стоит у строки в редакторе; если строку с тех пор правили, это написано справа.</p>}
              <ProblemList problems={noteProblems(notes?.notes ?? [])} onGo={onGo} empty="Замечаний владельца нет: они появляются, когда владелец возвращает отправленную версию на доработку." />
            </div>)}
          {tab === 'publication' && (
            <div className="p-3">
              <p><Status tone={RIGHT_TONE[right]}>{RIGHT_TEXT[right]}</Status>{' '}
                {(right === 'none' || right === 'revoked') && <button type="button" className="fx-btn fx-btn-primary" onClick={onRequestRight}>Запросить право публиковать</button>}</p>
              {rightError && <p className="fx-error" role="alert">{rightError}</p>}
              {error && <p className="fx-error" role="alert">{error}</p>}
              {!latest && <Empty title="Эта программа ещё не отправлялась" text="Нажмите «Опубликовать» сверху: Studio проверит программу и отправит её владельцу." />}
              {latest && <>
                <h4>Последний запрос</h4>
                <p><span className="data">{latest.version}</span> <Status tone={TONE[STATE_TONE[latest.state] || 'muted']}>{REQUEST_STATES[latest.state] || latest.state}</Status></p>
                {latest.review?.note && <p>{latest.review.note}</p>}
                <ProblemList problems={reviewRows} onGo={onGo} empty="Замечаний владельца нет." />
                {['returned', 'rejected'].includes(latest.state) && <p className="fx-hint">Исправьте файлы и снова нажмите «Опубликовать» — номер версии предложится следующий.</p>}
              </>}
              <Releases id={id} version={requestsVersion + history.version} />
              {requests.length > 1 && <table className="fx-table"><thead><tr><th>Версия</th><th>Состояние</th><th>Отправлена</th></tr></thead>
                <tbody>{[...requests].reverse().map(r => <tr key={r.id}><td className="data">{r.version}</td><td>{REQUEST_STATES[r.state] || r.state}</td><td>{r.createdAt.slice(0, 10)}</td></tr>)}</tbody></table>}
            </div>)}
          {tab === 'history' && <HistoryPanel id={id} hooks={history} />}
          {tab === 'failures' && <Errors bare />}
        </div>)}
    </div>
  );
}
