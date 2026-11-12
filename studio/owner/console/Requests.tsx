/**
 * Запросы на публикацию — у владельца (docs/roadmap/modules.md, «Запрос на публикацию и проверка
 * владельцем»). Перенесено из Flux (экран ModuleRequests и PublishRequestView): очередь, код и
 * разница с прошлой версией, «Связь с Flux», отчёт проверок разработчика, замечания к строкам,
 * пробный запуск и решения «Вернуть на доработку» / «Внести изменения сам» / «Отклонить» / «Выпустить».
 * Пакет показывается из тех же байт, что уходят на подпись; хеш показанного пакета главный процесс
 * сверяет с серверным перед каждой подписью.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { bundleText, unpackBundle, type BundleFiles } from '../../../modules/trust/bundle';
import { ACCESS_NAMES, connectionsOf, describeConnection } from '../../../modules/connections/model';
import { manifestOf } from '../../../modules/trust/diff';
import { ownerEditablePaths } from '../../../modules/trust/ownerEdit';
import { call } from './api';
import { Badge, Btn, Dialog, Empty, ErrorLine, Field, Segs, useAction, type Tone } from './ui';
import Trial from './Trial';
import type { ModuleChannel, PublishRequest, RequestDiff } from './types';

export const REQUEST_STATE: Record<PublishRequest['state'], { label: string; tone: Tone }> = {
  pending: { label: 'Ждёт решения', tone: 'warn' }, returned: { label: 'На доработке', tone: 'info' },
  rejected: { label: 'Отклонён', tone: 'bad' }, edited: { label: 'Изменён владельцем', tone: 'info' },
  superseded: { label: 'Заменён новым', tone: 'off' }, released: { label: 'Выпущен', tone: 'ok' },
};
const FILE_STATE: Record<string, string> = { added: 'новый', removed: 'удалён', changed: 'изменён', same: 'без изменений' };
const fromBase64 = (text: string) => { const raw = atob(text), out = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i); return out; };

type Pane = 'files' | 'flux' | 'review' | 'trial';
type Decision = null | 'return' | 'reject' | 'release' | 'edit';
interface Loaded { request: PublishRequest; signature: string; diff: RequestDiff; bundle: string; sha256: string }
interface LineNote { path: string; line: number; text: string }

export default function Requests({ onCount }: { onCount: (n: number) => void }) {
  const [list, setList] = useState<PublishRequest[] | null>(null);
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => {
    call<{ requests: PublishRequest[] }>('requests').then(r => { setList(r.requests); onCount(r.requests.filter(x => x.state === 'pending').length); }).catch(e => setError(e.message));
  }, [onCount]);
  useEffect(load, [load]);
  const pending = (list || []).filter(r => r.state === 'pending');
  const shown = filter === 'pending' ? pending : list || [];
  const current = (list || []).find(r => r.id === selected) || shown[0];
  return <div className="split">
    <div className="side">
      <div className="pad"><Segs value={filter} onChange={setFilter} label="Показать" options={[{ value: 'pending', label: `Ждут · ${pending.length}` }, { value: 'all', label: `Все · ${(list || []).length}` }]} /></div>
      <div className="list">
        {shown.map(r => <button key={r.id} type="button" className="li" aria-current={current?.id === r.id} onClick={() => setSelected(r.id)}
          title={`${r.byOwner ? 'владелец' : r.authorId} · ${r.meta?.changelog.split('\n')[0] || ''}`}>
          <span className="grow">{r.moduleId} {r.version}</span><Badge tone={REQUEST_STATE[r.state].tone}>{REQUEST_STATE[r.state].label}</Badge></button>)}
        {list && !shown.length && <Empty title="Запросов нет" text="Разработчики отправляют программы на проверку из Flux Studio." />}
      </div>
    </div>
    <div className="pane">
      <ErrorLine text={error} />
      {current ? <RequestView key={current.id} summary={current} onChanged={load} /> : <Empty title="Выберите запрос" />}
    </div>
  </div>;
}

function RequestView({ summary, onChanged }: { summary: PublishRequest; onChanged: () => void }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState('');
  const [pane, setPane] = useState<Pane>('files');
  const [path, setPath] = useState('');
  const [decision, setDecision] = useState<Decision>(null);
  const [notes, setNotes] = useState<LineNote[]>([]);
  const [aim, setAim] = useState<{ path: string; line: number } | null>(null);
  const [draft, setDraft] = useState('');
  useEffect(() => {
    let live = true;
    setData(null); setError(''); setPath(''); setNotes([]); setAim(null);
    call<Loaded>('request', { id: summary.id }).then(d => { if (live) { setData(d); setPath(d.diff.files.find(f => f.status !== 'same')?.path || d.diff.files[0]?.path || ''); } }).catch(e => live && setError(e.message));
    return () => { live = false; };
  }, [summary.id]);
  const request = data?.request || summary;
  const files: BundleFiles | null = useMemo(() => { try { return data ? unpackBundle(fromBase64(data.bundle)) : null; } catch { return null; } }, [data]);
  const fileDiff = data?.diff.files.find(f => f.path === path);
  const humanConnections = useMemo(() => connectionsOf(manifestOf(files)), [files]);
  const state = REQUEST_STATE[request.state], meta = request.meta, pending = request.state === 'pending', diff = data?.diff;

  // Номер строки — в новом файле: удалённые строки номера не имеют
  const lines: Array<{ n: number | null; text: string; cls: string }> = useMemo(() => {
    if (fileDiff && fileDiff.status !== 'same' && !fileDiff.binary) {
      let n = 0;
      return fileDiff.lines.map(l => { if (l.op !== '-') n++; return { n: l.op === '-' ? null : n, text: `${l.op} ${l.text}`, cls: l.op === '+' ? 'add' : l.op === '-' ? 'del' : '' }; });
    }
    return ((files && path ? bundleText(files, path) : '') || '').split('\n').map((text, i) => ({ n: i + 1, text, cls: '' }));
  }, [fileDiff, files, path]);

  return <>
    <div className="bar">
      <strong>{request.moduleId} {request.version}</strong><Badge tone={state.tone}>{state.label}</Badge>
      {!request.baseRelease && !request.byOwner && <Badge tone="info">Новая программа</Badge>}
      {diff?.permissions.widened && <Badge tone="warn">Расширены разрешения</Badge>}
      {request.byOwner && <Badge>Изменения владельца</Badge>}
      <span className="grow" />
      {pending && <>
        <Btn onClick={() => setDecision('return')}>Вернуть на доработку</Btn>
        <Btn disabled={!files} title="Правятся manifest.json и файлы данных; код и форма — только через «Вернуть на доработку»" onClick={() => setDecision('edit')}>Внести изменения сам</Btn>
        <Btn tone="danger" onClick={() => setDecision('reject')}>Отклонить</Btn>
        <Btn tone="primary" disabled={!data} onClick={() => setDecision('release')}>Выпустить</Btn></>}
    </div>
    <div className="info">
      <div><span className="muted">Что нового: </span>{meta?.changelog || '—'}</div>
      {meta?.comment && <div><span className="muted">Комментарий разработчика: </span>{meta.comment}</div>}
      <div className="muted">Автор {request.byOwner ? 'владелец' : request.authorId} · просит канал «{meta?.channel === 'test' ? 'тестовый' : 'рабочий'}» · Flux {meta?.fluxVersion || '—'}
        {' · '}разница {diff?.against?.release ? `с выпуском ${diff.against.release}` : diff?.against?.request ? 'с запросом разработчика' : 'не с чем: новая программа'}</div>
    </div>
    <div className="tabs" role="tablist" aria-label="Запрос">
      {([['files', `Файлы${diff ? ` · ${diff.files.filter(f => f.status !== 'same').length}` : ''}`], ['flux', 'Связь с Flux'], ['review', `Замечания и проверки${notes.length ? ` · ${notes.length}` : ''}`], ['trial', 'Проверить в работе']] as Array<[Pane, string]>)
        .map(([value, label]) => <button key={value} role="tab" type="button" aria-selected={pane === value} onClick={() => setPane(value)}>{label}</button>)}
    </div>
    <ErrorLine text={error} />
    {pane === 'files' && <div className="split">
      <div className="side" style={{ width: 260 }}><div className="list">
        {(diff?.files || []).map(f => <button key={f.path} type="button" className="li" aria-current={f.path === path} onClick={() => { setPath(f.path); setAim(null); }}>
          <span className="grow mono">{f.path}</span><span className="muted">{FILE_STATE[f.status]}</span></button>)}</div></div>
      <div className="pane">
        {fileDiff?.binary ? <pre className="code">Двоичный файл</pre> : <pre className="code" data-testid="request-code">
          {lines.map((l, i) => <span key={i} className={`line ${l.cls}`} aria-selected={!!aim && l.n === aim.line && aim.path === path}
            onClick={() => l.n && setAim({ path, line: l.n })} title={l.n ? `Строка ${l.n}: нажмите, чтобы оставить замечание` : undefined}>{l.text}{'\n'}</span>)}</pre>}
        {aim && pending && <div className="sect"><Field label={`Замечание к строке ${aim.line} в ${aim.path}`} hint="Уйдёт разработчику вместе с «Вернуть на доработку»." id="line-note">
          <textarea id="line-note" rows={2} value={draft} onChange={e => setDraft(e.target.value)} /></Field>
          <div className="rows"><Btn tone="primary" disabled={!draft.trim()} onClick={() => { setNotes([...notes, { ...aim, text: draft.trim() }]); setDraft(''); setAim(null); }}>Добавить замечание</Btn>
            <Btn onClick={() => { setAim(null); setDraft(''); }}>Отмена</Btn></div></div>}
      </div>
    </div>}
    {pane === 'flux' && <div className="scroll sect">
      {diff && Object.keys(diff.permissions.added).length === 0 && Object.keys(diff.permissions.removed).length === 0 && <div>Разрешения не изменились.</div>}
      {diff && Object.entries(diff.permissions.added).map(([k, v]) => k === 'connections'
        ? v.map(line => <div key={`+c${line}`} data-testid="diff-connection"><Badge tone="warn">новое</Badge> подключение к {line}</div>)
        : <div key={`+${k}`}><Badge tone="warn">новое</Badge> {k}: {v.join(', ')}</div>)}
      {diff && Object.entries(diff.permissions.removed).map(([k, v]) => <div key={`-${k}`}><Badge>убрано</Badge> {k}: {v.join(', ')}</div>)}
      {humanConnections.length > 0 && <div data-testid="owner-connection-texts"><h3>Подключения — так их увидит человек</h3>
        {humanConnections.map(c => <div key={c.id} className="box">
          <div><b>«{request.moduleId}» хочет подключиться к {c.app}</b></div><div>{c.does}</div>
          <div className="muted">Доступ: {ACCESS_NAMES[c.access]} · {describeConnection(c)}</div></div>)}</div>}
      <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>{files ? bundleText(files, 'manifest.json') : ''}</pre>
    </div>}
    {pane === 'review' && <div className="scroll sect">
      <h3>Ваши замечания к строкам</h3>
      {notes.length ? notes.map((n, i) => <div key={i} className="mono">{n.path}:{n.line} — {n.text}{' '}
        <Btn tone="ghost" onClick={() => setNotes(notes.filter((_, j) => j !== i))}>убрать</Btn></div>) : <div className="muted">Замечаний нет. Нажмите на строку кода во вкладке «Файлы».</div>}
      <h3 style={{ marginTop: 12 }}>Прежние замечания</h3>
      {request.review ? <>{request.review.note && <div>{request.review.note}</div>}
        {request.review.comments.map((c, i) => <div key={i} className="mono">{c.path}{c.line ? `:${c.line}` : ''} — {c.text}</div>)}</> : <div className="muted">Замечаний нет.</div>}
      <h3 style={{ marginTop: 12 }}>Отчёт проверок разработчика (Studio) <Badge tone="warn">заявлено автором</Badge></h3>
      <p className="hint">Отчёт составил и приложил сам автор: это его слова, а не результат проверки владельца. Проверяйте код и разницу.</p>
      <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{meta?.checks || '—'}</pre>
    </div>}
    {pane === 'trial' && <Trial requestId={request.id} />}
    {decision === 'return' && <NoteDialog title="Вернуть на доработку" action="Вернуть" need={false} extra={notes.length ? `Замечаний к строкам: ${notes.length}` : ''}
      onClose={() => setDecision(null)} onDone={async note => { await call('returnRequest', { id: request.id, note, comments: notes }); onChanged(); }} />}
    {decision === 'reject' && <NoteDialog title="Отклонить запрос" action="Отклонить" need extra="" onClose={() => setDecision(null)}
      onDone={async reason => { await call('rejectRequest', { id: request.id, reason }); onChanged(); }} />}
    {decision === 'release' && data && <ReleaseDialog request={request} sha256={data.sha256} onClose={() => setDecision(null)} onDone={onChanged} />}
    {decision === 'edit' && data && files && <EditDialog request={request} sha256={data.sha256} files={files} start={path} onClose={() => setDecision(null)} onDone={onChanged} />}
  </>;
}

function NoteDialog({ title, action, need, extra, onClose, onDone }: { title: string; action: string; need: boolean; extra: string; onClose: () => void; onDone: (note: string) => Promise<void> }) {
  const [note, setNote] = useState('');
  const { busy, error, run } = useAction();
  const go = async () => { if (await run(async () => { await onDone(note.trim()); })) onClose(); };
  return <Dialog title={title} onClose={onClose} busy={busy} footer={<><Btn onClick={onClose} disabled={busy}>Отмена</Btn>
    <Btn tone="primary" disabled={busy || (need && !note.trim())} onClick={() => void go()}>{action}</Btn></>}>
    <Field label={need ? 'Причина' : 'Общее замечание'} id="note"><textarea id="note" rows={4} value={note} onChange={e => setNote(e.target.value)} /></Field>
    {extra && <p className="hint">{extra}</p>}
    <ErrorLine text={error} />
  </Dialog>;
}

function ReleaseDialog({ request, sha256, onClose, onDone }: { request: PublishRequest; sha256: string; onClose: () => void; onDone: () => void }) {
  const [channel, setChannel] = useState<ModuleChannel>(request.meta?.channel || 'production');
  const [when, setWhen] = useState('');
  const { busy, error, run } = useAction();
  const go = async () => {
    const notBefore = when ? new Date(when).getTime() : 0;
    if (Number.isNaN(notBefore)) return;
    // Подпись и подтверждение — в главном процессе: он сам берёт пакет и строит то, что подписывается
    if (await run(() => call('release', { id: request.id, channel, notBefore, sha256 }))) { onDone(); onClose(); }
  };
  return <Dialog title={`Выпустить ${request.moduleId} ${request.version}`} onClose={onClose} busy={busy}
    footer={<><Btn onClick={onClose} disabled={busy}>Отмена</Btn><Btn tone="primary" disabled={busy} onClick={() => void go()}>Подписать и выпустить</Btn></>}>
    <Field label="Канал"><Segs value={channel} onChange={setChannel} label="Канал" options={[{ value: 'test', label: 'Тестовый' }, { value: 'production', label: 'Рабочий' }]} /></Field>
    <Field label="Когда" hint="Пусто — сразу. Выпуск скачается заранее и запустится с этого времени." id="when"><input id="when" type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} /></Field>
    <p className="hint">Перед подписью появится окно подтверждения. Выпуск подписывается ключом издателя из вашего хранилища.</p>
    <ErrorLine text={error} />
  </Dialog>;
}

function EditDialog({ request, sha256, files, start, onClose, onDone }: { request: PublishRequest; sha256: string; files: BundleFiles; start: string; onClose: () => void; onDone: () => void }) {
  const editable = ownerEditablePaths(files);
  const [path, setPath] = useState(editable.includes(start) ? start : editable[0] || '');
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [comment, setComment] = useState('');
  const { busy, error, run } = useAction();
  const text = texts[path] ?? bundleText(files, path) ?? '';
  const go = async () => { if (await run(() => call('ownerEdit', { id: request.id, texts, comment, sha256 }))) { onDone(); onClose(); } };
  return <Dialog title="Внести изменения сам" onClose={onClose} busy={busy}
    footer={<><Btn onClick={onClose} disabled={busy}>Отмена</Btn><Btn tone="primary" disabled={busy || !Object.keys(texts).length} onClick={() => void go()}>Подписать правку</Btn></>}>
    {!editable.length && <p className="hint">В этом пакете нет файлов, которые владелец может править. Исходный код и форму — только через «Вернуть на доработку».</p>}
    <Field label="Файл" id="edit-file"><select id="edit-file" value={path} onChange={e => setPath(e.target.value)}>{editable.map(p => <option key={p} value={p}>{p}</option>)}</select></Field>
    <textarea rows={14} className="mono" aria-label="Содержимое файла" value={text} onChange={e => setTexts({ ...texts, [path]: e.target.value })} />
    <Field label="Комментарий для разработчика" id="edit-comment"><input id="edit-comment" value={comment} onChange={e => setComment(e.target.value)} /></Field>
    <p className="hint">Правятся только manifest.json и файлы данных. Исходный код, form.json, contract.json и build/runtime.js — через «Вернуть на доработку». Правка уходит отдельным запросом от владельца; разработчик увидит её отдельной разницей.</p>
    <ErrorLine text={error} />
  </Dialog>;
}
