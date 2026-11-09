import React, { useEffect, useMemo, useState } from 'react';
import { Area, Btn, Dialog, Field, Input, Seg, Select, Status, Tabs, Toolbar, type Tone } from '../ui';
import { bundleText, packBundle, unpackBundle, type BundleFiles } from '../../../modules/trust/bundle';
import { moduleReleaseService, signAsOwner, type PublishRequest, type RequestDiff } from '../../services/moduleReleaseService';
import type { ModuleChannel } from '../../../modules/trust/claims';
import OwnerSignDialog from './OwnerSignDialog';
import { ACCESS_NAMES, connectionsOf, describeConnection } from '../../../modules/connections/model';
import { manifestOf } from '../../../modules/trust/diff';

export const REQUEST_STATE: Record<PublishRequest['state'], { label: string; tone: Tone }> = {
  pending: { label: 'Ждёт решения', tone: 'amber' }, returned: { label: 'На доработке', tone: 'sky' },
  rejected: { label: 'Отклонён', tone: 'rose' }, edited: { label: 'Изменён владельцем', tone: 'sky' },
  superseded: { label: 'Заменён новым', tone: 'slate' }, released: { label: 'Выпущен', tone: 'emerald' },
};
const FILE_STATE: Record<string, string> = { added: 'новый', removed: 'удалён', changed: 'изменён', same: 'без изменений' };

type Pane = 'files' | 'flux' | 'review';
type Decision = null | 'return' | 'reject' | 'release' | 'edit';

/**
 * Запрос на публикацию у владельца: файлы и разница, «Связь с Flux»,
 * замечания и решения. Пакет показывается из тех же байт, что уходят на
 * подпись. Минимальный вид — полноценный раздел будет в Studio (этап 4).
 */
export default function PublishRequestView({ request, onChanged }: { request: PublishRequest; onChanged: () => void }) {
  const [bundle, setBundle] = useState<Uint8Array | null>(null);
  const [signature, setSignature] = useState('');
  const [diff, setDiff] = useState<RequestDiff | null>(null);
  const [error, setError] = useState('');
  const [pane, setPane] = useState<Pane>('files');
  const [path, setPath] = useState('');
  const [decision, setDecision] = useState<Decision>(null);
  useEffect(() => {
    let live = true;
    setBundle(null); setDiff(null); setError(''); setPath('');
    Promise.all([moduleReleaseService.bundle(request.id), moduleReleaseService.request(request.id), moduleReleaseService.diff(request.id)])
      .then(([b, r, d]) => { if (!live) return; setBundle(b); setSignature(r.signature); setDiff(d); setPath(d.files.find((f) => f.status !== 'same')?.path || d.files[0]?.path || ''); })
      .catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [request.id]);
  const files: BundleFiles | null = useMemo(() => { try { return bundle ? unpackBundle(bundle) : null; } catch { return null; } }, [bundle]);
  const fileDiff = diff?.files.find((f) => f.path === path);
  const humanConnections = useMemo(() => connectionsOf(manifestOf(files)), [files]);
  const state = REQUEST_STATE[request.state];
  const meta = request.meta;
  const pending = request.state === 'pending';

  return <div className="flex min-h-0 flex-1 flex-col">
    <Toolbar>
      <span className="font-semibold">{request.moduleId} {request.version}</span>
      <Status tone={state.tone}>{state.label}</Status>
      {!request.baseRelease && !request.byOwner && <Status tone="sky">Новая подпрограмма</Status>}
      {diff?.permissions.widened && <Status tone="amber">Расширены разрешения</Status>}
      {request.byOwner && <Status tone="slate">Изменения владельца</Status>}
    </Toolbar>
    {pending && <Toolbar>
        <Btn size="sm" onClick={() => setDecision('return')}>Вернуть на доработку</Btn>
        <Btn size="sm" disabled={!files} onClick={() => setDecision('edit')}>Внести изменения сам</Btn>
        <Btn size="sm" tone="danger" onClick={() => setDecision('reject')}>Отклонить</Btn>
        <Btn size="sm" tone="primary" disabled={!bundle} onClick={() => setDecision('release')}>Выпустить</Btn>
    </Toolbar>}
    <div className="px-3 py-2 text-sm flex flex-col gap-1 border-b border-[var(--flux-line)]">
      <div><span className="text-[var(--flux-text-muted)]">Что нового: </span>{meta?.changelog || '—'}</div>
      {meta?.comment && <div><span className="text-[var(--flux-text-muted)]">Комментарий разработчика: </span>{meta.comment}</div>}
      <div className="text-[var(--flux-text-muted)]">Автор {request.byOwner ? 'владелец' : request.authorId} · просит канал «{meta?.channel === 'test' ? 'тестовый' : 'рабочий'}» · Flux {meta?.fluxVersion || '—'}
        {' · '}разница {diff?.against?.release ? `с выпуском ${diff.against.release}` : diff?.against?.request ? 'с запросом разработчика' : 'не с чем: новая подпрограмма'}</div>
    </div>
    <div className="px-3"><Tabs value={pane} onChange={setPane} label="Запрос" tabs={[
      { value: 'files', label: 'Файлы', count: diff?.files.filter((f) => f.status !== 'same').length },
      { value: 'flux', label: 'Связь с Flux' }, { value: 'review', label: 'Замечания и проверки' }]} /></div>
    {error && <div className="fx-error px-3 py-2">{error}</div>}
    {pane === 'files' && <div className="flex min-h-0 flex-1">
      <div className="fx-side w-64 shrink-0 overflow-auto py-1">
        {(diff?.files || []).map((f) => <button key={f.path} type="button" className="fx-li w-full text-left" aria-current={f.path === path}
          onClick={() => setPath(f.path)}><span className="flex-1 truncate font-mono">{f.path}</span><span className="fx-n">{FILE_STATE[f.status]}</span></button>)}
      </div>
      <pre className="min-w-0 flex-1 overflow-auto m-0 p-3 text-xs font-mono leading-5">
        {fileDiff?.binary ? 'Двоичный файл' : fileDiff && fileDiff.status !== 'same'
          ? fileDiff.lines.map((l, i) => <div key={i} className={l.op === '+' ? 'bg-emerald-500/15' : l.op === '-' ? 'bg-rose-500/15' : ''}>{l.op} {l.text}</div>)
          : files && path ? bundleText(files, path) : ''}
      </pre>
    </div>}
    {pane === 'flux' && <div className="p-3 text-sm flex flex-col gap-2 overflow-auto">
      {diff && Object.keys(diff.permissions.added).length === 0 && Object.keys(diff.permissions.removed).length === 0 && <div>Разрешения не изменились.</div>}
      {diff && Object.entries(diff.permissions.added).map(([k, v]) => k === 'connections'
        ? v.map((line) => <div key={`+c${line}`} data-testid="diff-connection"><Status tone="amber">новое</Status> подключение к {line}</div>)
        : <div key={`+${k}`}><Status tone="amber">новое</Status> {k}: {v.join(', ')}</div>)}
      {diff && Object.entries(diff.permissions.removed).map(([k, v]) => <div key={`-${k}`}><Status tone="slate">убрано</Status> {k}: {v.join(', ')}</div>)}
      {humanConnections.length > 0 && <div data-testid="owner-connection-texts"><div className="font-semibold">Подключения — так их увидит человек</div>
        {humanConnections.map((c) => <div key={c.id} className="mt-1 rounded border border-[var(--flux-line)] p-2">
          <div><b>«{request.moduleId}» хочет подключиться к {c.app}</b></div><div>{c.does}</div>
          <div className="text-xs text-[var(--flux-text-muted)]">Доступ: {ACCESS_NAMES[c.access]} · {describeConnection(c)}</div></div>)}</div>}
      <pre className="m-0 text-xs font-mono">{files ? bundleText(files, 'manifest.json') : ''}</pre>
    </div>}
    {pane === 'review' && <div className="p-3 text-sm flex flex-col gap-2 overflow-auto">
      {request.review ? <>
        {request.review.note && <div>{request.review.note}</div>}
        {request.review.comments.map((c, i) => <div key={i} className="font-mono text-xs">{c.path}{c.line ? `:${c.line}` : ''} — {c.text}</div>)}
      </> : <div className="text-[var(--flux-text-muted)]">Замечаний нет.</div>}
      <div className="text-[var(--flux-text-muted)]">Отчёт проверок Studio:</div>
      <pre className="m-0 text-xs font-mono whitespace-pre-wrap">{meta?.checks || '—'}</pre>
    </div>}
    {decision === 'return' && <NoteDialog title="Вернуть на доработку" action="Вернуть" path={path} need={false}
      onClose={() => setDecision(null)} onDone={async (note, line) => {
        await moduleReleaseService.returnForRework(request.id, note, line ? [{ path, line, text: note }] : []); onChanged();
      }} />}
    {decision === 'reject' && <NoteDialog title="Отклонить запрос" action="Отклонить" need path="" onClose={() => setDecision(null)}
      onDone={async (reason) => { await moduleReleaseService.reject(request.id, reason); onChanged(); }} />}
    {decision === 'release' && bundle && <ReleaseDialog request={request} signature={signature} bundle={bundle} onClose={() => setDecision(null)} onDone={onChanged} />}
    {decision === 'edit' && files && <EditDialog request={request} signature={signature} files={files} start={path} onClose={() => setDecision(null)} onDone={onChanged} />}
  </div>;
}

function NoteDialog({ title, action, need, path, onClose, onDone }: { title: string; action: string; need: boolean; path: string; onClose: () => void; onDone: (note: string, line: number | null) => Promise<void> }) {
  const [note, setNote] = useState(''), [line, setLine] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { await onDone(note.trim(), path && Number(line) > 0 ? Number(line) : null); onClose(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return <Dialog title={title} onClose={onClose} busy={busy} footer={<><Btn onClick={onClose}>Отмена</Btn><Btn tone="primary" disabled={busy || (need && !note.trim())} onClick={() => void run()}>{action}</Btn></>}>
    <div className="flex flex-col gap-3">
      <Field label={need ? 'Причина' : 'Замечание'}><Area rows={4} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      {path && <Field label={`Строка в ${path}`} hint="Необязательно: замечание к строке кода"><Input value={line} inputMode="numeric" onChange={(e) => setLine(e.target.value.replace(/\D/g, ''))} /></Field>}
      {error && <div className="fx-error">{error}</div>}
    </div>
  </Dialog>;
}

function ReleaseDialog({ request, signature, bundle, onClose, onDone }: { request: PublishRequest; signature: string; bundle: Uint8Array; onClose: () => void; onDone: () => void }) {
  const [channel, setChannel] = useState<ModuleChannel>(request.meta?.channel || 'production');
  const [when, setWhen] = useState('');
  return <OwnerSignDialog title={`Выпустить ${request.moduleId} ${request.version}`} action="Подписать и выпустить" onClose={onClose}
    onSign={async (password) => {
      const notBefore = when ? new Date(when).getTime() : 0;
      if (Number.isNaN(notBefore)) return 'Неверная дата выпуска';
      const signed = await signAsOwner({ kind: 'release', requestId: request.id, requestSignature: signature, bundle, channel, notBefore }, password);
      if (!signed) return 'Подпись отменена';
      await moduleReleaseService.release(request.id, signed); onDone(); return '';
    }}>
    <Field label="Канал"><Seg value={channel} onChange={setChannel} label="Канал" options={[{ value: 'test', label: 'Тестовый' }, { value: 'production', label: 'Рабочий' }]} /></Field>
    <Field label="Когда" hint="Пусто — сразу. Выпуск скачается заранее и запустится с этого времени."><Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
  </OwnerSignDialog>;
}

function EditDialog({ request, signature, files, start, onClose, onDone }: { request: PublishRequest; signature: string; files: BundleFiles; start: string; onClose: () => void; onDone: () => void }) {
  const editable = Object.keys(files).filter((p) => bundleText(files, p) !== null);
  const [path, setPath] = useState(editable.includes(start) ? start : editable[0] || '');
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [comment, setComment] = useState('');
  const text = texts[path] ?? bundleText(files, path) ?? '';
  return <OwnerSignDialog title="Внести изменения сам" action="Подписать правку" onClose={onClose}
    onSign={async (password) => {
      if (!Object.keys(texts).length) return 'Нет изменений';
      const next: Record<string, Uint8Array | string> = { ...files, ...texts };
      const bundle = packBundle(next);
      const signed = await signAsOwner({ kind: 'owner-edit', parentRequestId: request.id, parentSignature: signature, bundle, comment }, password);
      if (!signed) return 'Подпись отменена';
      await moduleReleaseService.submit(signed, bundle); onDone(); return '';
    }}>
    <Field label="Файл"><Select value={path} onChange={setPath} options={editable.map((p) => ({ value: p, label: p }))} /></Field>
    <Area rows={14} className="font-mono text-xs" value={text} onChange={(e) => setTexts({ ...texts, [path]: e.target.value })} />
    <Field label="Комментарий для разработчика"><Input value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
    <div className="fx-hint">Правка уходит отдельным запросом от владельца; разработчик увидит её отдельной разницей.</div>
  </OwnerSignDialog>;
}
