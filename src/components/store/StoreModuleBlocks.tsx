/**
 * Блоки страницы подпрограммы: снимки, описание, известные проблемы, отзывы, история версий.
 */
import React, { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Area, Btn } from '../ui';
import { compareVersions } from '../../../shared/versionCompare';
import { moduleStoreApi, type StoreReview } from '../../services/moduleStoreService';
import { refreshStore, rollbackModule } from '../../services/moduleStoreActions';
import type { StoreListing } from '../../../modules/store/model';
import { Shot, Stars } from './StoreParts';

const dateOf = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });

export function Screenshots({ listing }: { listing: StoreListing }) {
  const [big, setBig] = useState('');
  if (!listing.screenshots.length) return null;
  return <section className="stx-block"><h3>Снимки экрана<ChevronRight className="chev" size={16} /></h3>
    <div className="stx-shots" data-testid="stx-shots">{listing.screenshots.map((src) => <Shot key={src} src={src} onOpen={setBig} />)}</div>
    {big && <div className="stx-lightbox" role="dialog" aria-label="Снимок экрана" onClick={() => setBig('')} onKeyDown={(e) => e.key === 'Escape' && setBig('')} tabIndex={-1} ref={(el) => el?.focus()}>
      <img src={big} alt="Снимок экрана подпрограммы" /></div>}
  </section>;
}

export function Description({ listing }: { listing: StoreListing }) {
  const [open, setOpen] = useState(false);
  if (!listing.description) return null;
  return <section className="stx-block"><h3>Описание<ChevronRight className="chev" size={16} /></h3>
    <div className={`stx-desc${open ? ' open' : ''}`}>{listing.description}</div>
    {listing.description.length > 220 && <button type="button" className="fx-btn mt-2" onClick={() => setOpen(!open)}>{open ? 'Свернуть' : 'Показать больше'}</button>}
  </section>;
}

export function KnownIssues({ listing }: { listing: StoreListing }) {
  if (!listing.known.length) return null;
  return <section className="stx-block" data-testid="stx-known"><h3>Известные проблемы</h3>
    {listing.known.map((k) => <div key={k.id} className="stx-perm"><span>ОБР-{String(k.number).padStart(6, '0')}</span><span>{k.title}{k.workaround ? ` — обход: ${k.workaround}` : ''}</span></div>)}
  </section>;
}

export function Reviews({ listing }: { listing: StoreListing }) {
  const [reviews, setReviews] = useState<StoreReview[]>([]);
  const [all, setAll] = useState(false);
  const [rating, setRating] = useState(5), [text, setText] = useState(''), [error, setError] = useState('');
  const load = () => moduleStoreApi.reviews(listing.moduleId).then(setReviews).catch(() => {});
  useEffect(() => { void load(); }, [listing.moduleId]);
  const total = listing.rating.count || 1;
  const top = [...reviews].filter((r) => r.text).sort((a, b) => b.text.length - a.text.length)[0];
  const save = async () => {
    setError('');
    try { await moduleStoreApi.review(listing.moduleId, rating, text); setText(''); await load(); await refreshStore(); } catch (e: any) { setError(e.message); }
  };
  const view = (r: StoreReview) => <div key={r.id} className="py-2" style={{ borderTop: '1px solid var(--flux-line)' }}>
    <div className="flex items-center gap-2 text-sm"><Stars value={r.rating} /><b>{r.userName || 'Сотрудник'}</b><span style={{ color: 'var(--flux-text-muted)' }}>версия {r.version} · {dateOf(r.updatedAt)}</span>
      {!r.mine && <button type="button" className="fx-btn ml-auto" onClick={() => void moduleStoreApi.reportReview(r.id)}>Пожаловаться</button>}</div>
    {r.text && <div className="mt-1 text-sm" style={{ whiteSpace: 'pre-wrap' }}>{r.text}</div>}
  </div>;
  return <section className="stx-block" data-testid="stx-reviews"><h3>Оценки и отзывы<ChevronRight className="chev" size={16} /></h3>
    {listing.rating.count > 0 ? <div className="stx-rate">
      <div className="big">{listing.rating.avg.toFixed(1)}<div className="text-xs font-normal" style={{ color: 'var(--flux-text-muted)' }}>{listing.rating.count} оценок</div></div>
      <div className="grid gap-1">{listing.rating.stars.map((n, i) => <div key={i} className="stx-bar"><span>{5 - i}</span><i><b style={{ width: `${(n / total) * 100}%` }} /></i><span>{n}</span></div>)}</div>
    </div> : <div className="text-sm" style={{ color: 'var(--flux-text-muted)' }}>Оценок пока нет.</div>}
    {top && !all && view(top)}
    {all && reviews.map(view)}
    {reviews.length > 1 && <button type="button" className="fx-btn mt-2" onClick={() => setAll(!all)}>{all ? 'Свернуть' : `Посмотреть все (${reviews.length})`}</button>}
    {listing.mine && <div className="mt-3 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm">Ваша оценка
        {[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" className="fx-btn" aria-pressed={rating === n} aria-label={`${n} из 5`} onClick={() => setRating(n)}>{n <= rating ? '★' : '☆'}</button>)}</div>
      <Area rows={2} value={text} placeholder="Что работает хорошо, а что нет (необязательно)" onChange={(e) => setText(e.target.value)} />
      {error && <div className="fx-error">{error}</div>}
      <div><Btn tone="primary" onClick={() => void save()}>Отправить отзыв</Btn></div>
    </div>}
  </section>;
}

export function VersionHistory({ listing, cached }: { listing: StoreListing; cached: Set<string> }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const back = async (version: string) => {
    setBusy(version); setError('');
    try { await rollbackModule(listing.moduleId, version); } catch (e: any) { setError(e.message); } finally { setBusy(''); }
  };
  const mine = listing.mine?.version;
  return <div className="mt-3" data-testid="stx-versions">
    <div className="mb-1 text-sm font-semibold">История версий</div>
    {listing.versions.map((v) => <div key={v.version} className="stx-ver">
      <b>{v.version}</b><span style={{ color: 'var(--flux-text-muted)' }}>{dateOf(v.createdAt)}</span>
      <span style={{ whiteSpace: 'pre-wrap' }}>{v.changelog}{v.revoked ? ' (отозвана)' : ''}</span>
      {mine && compareVersions(v.version, mine) < 0 && !v.revoked
        ? <button type="button" className="fx-btn" disabled={!!busy} title={cached.has(v.version) ? 'Версия на этом компьютере: работает без связи' : 'Версия будет скачана из Store'}
          onClick={() => void back(v.version)}>{busy === v.version ? 'Возврат…' : 'Вернуть эту версию'}</button>
        : <span>{mine === v.version ? 'установлена' : ''}</span>}
    </div>)}
    {error && <div className="fx-error mt-2">{error}</div>}
  </div>;
}
