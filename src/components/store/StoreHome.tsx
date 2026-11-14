/**
 * Главная витрины: карусель «Рекомендуем» и ряды карточек.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { categoryName, storeRows, type StoreListing } from '../../../modules/store/model';
import { WORKS_OFFLINE_LABEL, worksOffline } from '../../../modules/storage/model';
import { ActionButton, ModuleIcon, Stars, type ActionKind } from './StoreParts';

export type OnAct = (listing: StoreListing, kind: ActionKind) => void;
export type OnOpen = (listing: StoreListing) => void;

export function StoreCard({ listing, index = 0, onOpen, onAct }: { listing: StoreListing; index?: number; onOpen: OnOpen; onAct: OnAct }) {
  return <div role="button" tabIndex={0} className="stx-card" style={{ '--i': index } as React.CSSProperties} data-testid={`stx-card-${listing.moduleId}`}
    onClick={() => onOpen(listing)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(listing); }}>
    <ModuleIcon listing={listing} />
    <div className="stx-card-body">
      <div className="stx-card-name">{listing.name}</div>
      <div className="stx-card-sub">{categoryName(listing.category)}{listing.testing ? ' · тестовая' : ''}{worksOffline(listing.manifest) && <span data-testid="stx-offline"> · {WORKS_OFFLINE_LABEL.toLowerCase()}</span>}</div>
      <div className="stx-card-sub">{listing.rating.count ? <><Stars value={listing.rating.avg} /> {listing.rating.avg.toFixed(1)}</> : listing.developer}</div>
    </div>
    <ActionButton listing={listing} onAct={(k) => onAct(listing, k)} />
  </div>;
}

/** Ряд со стрелками прокрутки; карточки появляются ступенями (задержка по номеру) */
export function StoreRow({ title, items, onOpen, onAct }: { title: string; items: StoreListing[]; onOpen: OnOpen; onAct: OnAct }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ left: true, right: false });
  const measure = () => { const el = ref.current; if (el) setEdge({ left: el.scrollLeft < 4, right: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 }); };
  useEffect(measure, [items.length]);
  const by = (dir: number) => ref.current?.scrollBy({ left: dir * 340, behavior: 'smooth' });
  return <section data-testid="stx-row">
    <div className="stx-rowhead"><h2>{title}</h2>
      <button type="button" className="stx-arrow" aria-label="Назад" disabled={edge.left} onClick={() => by(-1)}><ChevronLeft size={16} /></button>
      <button type="button" className="stx-arrow" aria-label="Вперёд" disabled={edge.right} onClick={() => by(1)}><ChevronRight size={16} /></button></div>
    <div className="stx-row" ref={ref} onScroll={measure}>{items.map((l, i) => <StoreCard key={l.moduleId} listing={l} index={i} onOpen={onOpen} onAct={onAct} />)}</div>
  </section>;
}

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Большая обложка: соседние слайды видны по краям, смена раз в 7 с, стоит при наведении и фокусе */
export function StoreCarousel({ items, onOpen, onAct }: { items: StoreListing[]; onOpen: OnOpen; onAct: OnAct }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused || items.length < 2 || reducedMotion()) return;
    const timer = setInterval(() => setIndex((i) => (i + 1) % items.length), 7000);
    return () => clearInterval(timer);
  }, [paused, items.length]);
  if (!items.length) return null;
  const current = items[Math.min(index, items.length - 1)];
  return <section className="stx-hero" aria-roledescription="карусель" aria-label="Рекомендуем" style={{ '--c': current.color } as React.CSSProperties} data-testid="stx-hero"
    onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
    <div className="stx-hero-glow" />
    <div className="stx-hero-track" style={{ transform: `translateX(calc(${-index} * (86% + 16px)))` }}>
      {items.map((l, i) => <div key={l.moduleId} className="stx-slide" aria-current={i === index} aria-hidden={i !== index} style={{ '--c': l.color } as React.CSSProperties}>
        <ModuleIcon listing={l} size={112} />
        <div className="min-w-0">
          <div className="stx-kicker">Рекомендуем · {categoryName(l.category)}</div>
          <h2>{l.name}</h2>
          <p>{l.summary || l.description.slice(0, 160)}</p>
          <div className="flex items-center gap-3">
            <ActionButton listing={l} large onAct={(k) => onAct(l, k)} />
            <button type="button" className="stx-act is-lg" data-kind="open" tabIndex={i === index ? 0 : -1} onClick={() => onOpen(l)}>Подробнее</button>
          </div>
        </div>
      </div>)}
    </div>
    <div className="stx-dots">{items.map((l, i) => <button key={l.moduleId} type="button" aria-label={`Слайд ${i + 1}: ${l.name}`} aria-current={i === index} onClick={() => setIndex(i)} />)}</div>
  </section>;
}

export default function StoreHome({ listings, onOpen, onAct }: { listings: StoreListing[]; onOpen: OnOpen; onAct: OnAct }) {
  const visible = listings.filter((l) => l.status === 'admitted' && !l.deprecated);
  const featured = [...visible].sort((a, b) => b.installs - a.installs || Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 5);
  const rows = storeRows(listings);
  if (!visible.length) return <div className="fx-empty"><div className="fx-empty-title">В Store пока нет программ</div>
    <div className="fx-empty-text">Они появятся, когда владелец выпустит первую, а администратор допустит её в Store.</div></div>;
  return <>
    <StoreCarousel items={featured} onOpen={onOpen} onAct={onAct} />
    {rows.map((r) => <StoreRow key={r.id} title={r.title} items={r.items} onOpen={onOpen} onAct={onAct} />)}
  </>;
}
