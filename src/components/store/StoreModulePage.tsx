/**
 * Страница подпрограммы по образцу страницы приложения в Microsoft Store:
 * крупная шапка, которая при прокрутке сжимается в закреплённую полосу, и
 * блоки-карточки ниже.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { categoryName, formatSize, STATUS_NAMES, type StoreListing } from '../../../modules/store/model';
import { useModuleStore } from '../../store/moduleStoreState';
import { ActionButton, ModuleIcon, Stars, type ActionKind } from './StoreParts';
import { PermissionsList, RequirementsList } from './StoreDialogs';
import { Description, KnownIssues, Reviews, Screenshots, VersionHistory } from './StoreModuleBlocks';

const dateOf = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

export default function StoreModulePage({ listing, onBack, onAct, onReport }: {
  listing: StoreListing; onBack: () => void; onAct: (kind: ActionKind) => void; onReport: () => void;
}) {
  const header = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const local = useModuleStore((s) => s.local);
  // Страница открывается сверху, каким бы ни был прокручен предыдущий экран
  useLayoutEffect(() => { (header.current?.closest('.stx-scroll') as HTMLElement | null)?.scrollTo({ top: 0 }); }, [listing.moduleId]);
  useEffect(() => {
    const scroller = header.current?.closest('.stx-scroll') as HTMLElement | null;
    if (!scroller) return;
    // Порог не меньше 60 px: до раскладки высота шапки может быть нулевой, а полоса от этого не должна мигать
    const on = () => setCompact(scroller.scrollTop > Math.max(60, (header.current?.offsetHeight || 140) - 36));
    scroller.addEventListener('scroll', on, { passive: true });
    on();
    return () => scroller.removeEventListener('scroll', on);
  }, [listing.moduleId]);
  const cached = new Set((local?.available || []).filter((a) => a.moduleId === listing.moduleId).map((a) => a.version));
  return <div data-testid="stx-page" style={{ '--c': listing.color } as React.CSSProperties}>
    <div className={`stx-sticky${compact ? ' is-compact' : ''}`} data-testid="stx-sticky" aria-hidden={!compact}>
      <div className="stx-sticky-bar">
        <ModuleIcon listing={listing} size={32} />
        <div className="t"><div className="font-semibold truncate">{listing.name}</div><div className="text-xs truncate" style={{ color: 'var(--flux-text-muted)' }}>{listing.developer}</div></div>
        <ActionButton listing={listing} onAct={onAct} />
      </div>
    </div>
    <button type="button" className="fx-btn mt-3" onClick={onBack}><ChevronLeft size={16} />Назад</button>
    <div className="stx-ph" ref={header}>
      <ModuleIcon listing={listing} size={84} />
      <div className="min-w-0 flex-1">
        <h1>{listing.name}</h1>
        <div className="stx-meta"><span>{listing.developer}</span><span>{categoryName(listing.category)}</span>
          {listing.rating.count > 0 && <span><Stars value={listing.rating.avg} /> {listing.rating.avg.toFixed(1)} ({listing.rating.count})</span>}
          <span>{STATUS_NAMES[listing.status]}{listing.deprecated ? ' · устарела' : ''}{listing.testing ? ' · тестовая' : ''}</span></div>
        <p className="stx-short">{listing.summary || listing.description}</p>
        <div className="flex items-center gap-3"><ActionButton listing={listing} large onAct={onAct} />
          <button type="button" className="fx-btn" onClick={onReport}>Сообщить о проблеме</button></div>
      </div>
    </div>
    <div className="stx-blocks">
      <Screenshots listing={listing} />
      <Description listing={listing} />
      <KnownIssues listing={listing} />
      <Reviews listing={listing} />
      <section className="stx-block"><h3>Что нового в версии {listing.version}</h3><div style={{ whiteSpace: 'pre-wrap' }}>{listing.changelog || 'Описание не указано.'}</div></section>
      <section className="stx-block"><h3>Разрешения</h3><PermissionsList listing={listing} /></section>
      <section className="stx-block"><h3>Требования</h3><RequirementsList listing={listing} /></section>
      <section className="stx-block"><h3>Дополнительные сведения</h3>
        <dl className="stx-kv">
          <dt>Разработчик</dt><dd>{listing.developer}</dd>
          <dt>Версия</dt><dd>{listing.version}{listing.mine && listing.mine.version !== listing.version ? ` (у вас ${listing.mine.version})` : ''}</dd>
          <dt>Обновлена</dt><dd>{dateOf(listing.updatedAt)}</dd>
          <dt>Размер</dt><dd>{formatSize(listing.size)}</dd>
          <dt>Версия API</dt><dd>v{listing.manifest.contractVersion}</dd>
          <dt>Канал</dt><dd>{listing.channel === 'test' ? 'тестовый' : 'рабочий'}</dd>
          {listing.pinned && <><dt>Закреплена</dt><dd>администратор закрепил версию {listing.pinned}</dd></>}
          {listing.required && <><dt>Обязательная</dt><dd>для вашей должности, версия {listing.required}</dd></>}
        </dl>
        <VersionHistory listing={listing} cached={cached} />
      </section>
    </div>
  </div>;
}
