/**
 * Сведения о черновике при наведении (лист «States»): предпросмотр, состояние,
 * проект и тег, даты, размер. Появляются через 500 мс — быстрая прогулка мыши
 * по плиткам не должна мигать карточками.
 */
import React from 'react';
import type { WindowsDraftEntry } from '../../../filesystem/contracts';
import { draftRef } from '../../lib/draftsActions';
import { Z } from '../../lib/layers';
import { draftExt, formatSize, STATE_LABEL, type DraftState } from '../../lib/draftsPanel';
import { windowsFilesRequest, type WindowsThumbnail } from '../../lib/windowsFiles';
import { DraftIcon, StateDot } from './DraftTile';

export const HOVER_DELAY = 500;
const CARD_W = 248;
const IMAGES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const when = (iso: string | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
};

export default function DraftDetails({ entry, rect, state, projects }: { entry: WindowsDraftEntry; rect: DOMRect; state: DraftState; projects: string[] }) {
  const [preview, setPreview] = React.useState<string | null>(null);
  React.useEffect(() => {
    setPreview(null);
    if (!IMAGES.has(draftExt(entry))) return;
    let active = true;
    // Нет миниатюры — карточка остаётся со значком типа: предпросмотр не важнее самих сведений.
    void windowsFilesRequest<WindowsThumbnail>({ action: 'thumbnail', ref: draftRef(entry), size: 160, thumbnailOnly: true }).then((answer) => {
      if (active && 'data' in answer && answer.data.thumbnail) setPreview(answer.data.dataUrl);
    });
    return () => { active = false; };
  }, [entry.draftId]);
  const ref = React.useRef<HTMLDivElement>(null);
  const [top, setTop] = React.useState(rect.top - 8);
  // Над плиткой, а если места нет — под ней; по горизонтали не выходит за окно.
  React.useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0;
    setTop(rect.top - height - 6 >= 4 ? rect.top - height - 6 : Math.min(window.innerHeight - height - 4, rect.bottom + 6));
  }, [rect, preview]);
  const left = Math.max(4, Math.min(rect.left + rect.width / 2 - CARD_W / 2, window.innerWidth - CARD_W - 4));
  const tags = entry.metadata?.tags || [];
  return <div ref={ref} role="tooltip" data-draft-details className="fx-pop pointer-events-none fixed rounded-lg border border-[var(--flux-line)] p-2.5 text-xs text-[var(--flux-text)]"
    style={{ left, top, width: CARD_W, zIndex: Z.tray + 1 }}>
    <div className="flex items-center gap-2">
      {preview ? <img src={preview} alt="" className="h-10 w-10 shrink-0 rounded object-cover" /> : <DraftIcon entry={entry} size={40} />}
      <div className="min-w-0">
        <div className="break-words text-[13px] font-medium leading-4">{entry.name}</div>
        <div className="mt-0.5 flex items-center gap-1 text-[var(--flux-text-muted)]"><StateDot state={state} />{STATE_LABEL[state]}</div>
      </div>
    </div>
    <dl className="mt-2 grid grid-cols-[64px_minmax(0,1fr)] gap-x-2 gap-y-0.5">
      <dt className="text-[var(--flux-text-muted)]">Проект</dt><dd className="truncate">{projects.join(', ') || 'Не в проекте'}</dd>
      {tags.length > 0 && <><dt className="text-[var(--flux-text-muted)]">Тег</dt><dd className="truncate">{tags.join(', ')}</dd></>}
      <dt className="text-[var(--flux-text-muted)]">Изменён</dt><dd className="tabular-nums">{when(entry.modifiedAt)}</dd>
      {entry.createdAt && <><dt className="text-[var(--flux-text-muted)]">Создан</dt><dd className="tabular-nums">{when(entry.createdAt)}</dd></>}
      {entry.kind !== 'directory' && <><dt className="text-[var(--flux-text-muted)]">Размер</dt><dd className="tabular-nums">{formatSize(entry.size)}</dd></>}
    </dl>
  </div>;
}
