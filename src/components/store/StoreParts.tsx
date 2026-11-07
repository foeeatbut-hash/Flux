/**
 * Мелкие части витрины: значок подпрограммы, снимок экрана, звёзды, кнопка-состояние.
 */
import React, { useEffect, useState } from 'react';
import { updateAvailable, type StoreListing } from '../../../modules/store/model';
import { useModuleStore } from '../../store/moduleStoreState';
import { blockers } from '../../services/moduleStoreActions';

export function ModuleIcon({ listing, size = 64 }: { listing: Pick<StoreListing, 'name' | 'color'>; size?: number }) {
  return <div className="stx-ico" style={{ '--c': listing.color, '--s': `${size}px` } as React.CSSProperties} aria-hidden="true">
    {(listing.name.trim()[0] || '?').toUpperCase()}
  </div>;
}

export const Stars = ({ value }: { value: number }) =>
  <span className="stx-stars" aria-label={`Оценка ${value.toFixed(1)} из 5`}>{'★'.repeat(Math.round(value))}{'☆'.repeat(5 - Math.round(value))}</span>;

const urls = new Map<string, string>();
/**
 * Снимок экрана: качается обычным запросом приложения (с токеном входа) и
 * показывается из памяти — а не прямой ссылкой, которая токена не несёт.
 */
export function useAuthedImage(src: string): string {
  const [url, setUrl] = useState(urls.get(src) || '');
  useEffect(() => {
    if (urls.has(src)) { setUrl(urls.get(src)!); return; }
    let alive = true;
    fetch(src).then((r) => (r.ok ? r.blob() : Promise.reject(new Error('нет снимка')))).then((blob) => {
      const made = URL.createObjectURL(blob);
      urls.set(src, made);
      if (alive) setUrl(made);
    }).catch(() => {});
    return () => { alive = false; };
  }, [src]);
  return url;
}

export function Shot({ src, onOpen }: { src: string; onOpen: (url: string) => void }) {
  const url = useAuthedImage(src);
  return <button type="button" className="stx-shot" aria-label="Открыть снимок экрана" disabled={!url}
    style={url ? { backgroundImage: `url(${url})` } : undefined} onClick={() => url && onOpen(url)} />;
}

/** Кольцо загрузки: «Установить» превращается в него, по завершении — «Открыть» */
export function Ring({ label }: { label: string }) {
  return <svg className="stx-ring" viewBox="0 0 32 32" role="progressbar" aria-label={label}><title>{label}</title>
    <circle className="bg" cx="16" cy="16" r="12" /><circle className="fg" cx="16" cy="16" r="12" /></svg>;
}

export type ActionKind = 'install' | 'open' | 'update' | 'busy' | 'blocked';

export function actionOf(l: StoreListing, busy: Record<string, string>): { kind: ActionKind; label: string; title?: string } {
  if (busy[l.moduleId]) return { kind: 'busy', label: busy[l.moduleId] };
  if (l.mine) return updateAvailable(l) ? { kind: 'update', label: 'Обновить' } : { kind: 'open', label: 'Открыть' };
  const why = blockers(l);
  if (l.status !== 'admitted') return { kind: 'blocked', label: 'Установить', title: 'Ещё не допущена администратором' };
  if (l.deprecated) return { kind: 'blocked', label: 'Установить', title: 'Устарела: новым не ставится' };
  return why.length ? { kind: 'blocked', label: 'Установить', title: why[0] } : { kind: 'install', label: 'Установить' };
}

/** Кнопка-состояние справа в карточке и в шапке страницы */
export function ActionButton({ listing, large, onAct }: { listing: StoreListing; large?: boolean; onAct: (kind: ActionKind) => void }) {
  const busy = useModuleStore((s) => s.busy);
  const a = actionOf(listing, busy);
  if (a.kind === 'busy') return <span className="inline-flex items-center gap-2 text-xs" style={{ color: 'var(--flux-text-muted)' }}><Ring label={a.label} />{large && a.label}</span>;
  return <button type="button" className={`stx-act${large ? ' is-lg' : ''}`} data-kind={a.kind} data-testid={`stx-act-${listing.moduleId}`}
    disabled={a.kind === 'blocked'} title={a.title}
    onClick={(e) => { e.stopPropagation(); onAct(a.kind); }}>{a.label}</button>;
}
