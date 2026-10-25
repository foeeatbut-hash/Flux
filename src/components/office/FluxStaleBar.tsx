import React from 'react';
import { changesHeadline } from './FluxChangesList';
import { useOfficeChanges } from './useOfficeChanges';
import type { OfficeFileSource } from './fluxData';

interface Props {
  source: OfficeFileSource | null;
  /** Документ готов: до этого проверять нечего */
  ready: boolean;
  /** Открыть панель Flux на списке изменений */
  onShow: () => void;
  /** «Обновить»: открыть панель и построить план обновления */
  onRefresh: () => void;
  readOnly?: boolean;
}

/**
 * Полоса над документом: данные проекта изменились, а в документе остались старые.
 * Показывается сама, как только проверка нашла расхождение, и пропадает после
 * обновления; закрыть её можно — до следующего изменения данных.
 */
export default function FluxStaleBar({ source, ready, onShow, onRefresh, readOnly }: Props) {
  const { result } = useOfficeChanges(source, ready);
  // Закрытая полоса возвращается, когда набор устаревших значений стал другим
  const signature = result?.changes.filter((c) => !c.manual).map((c) => `${c.anchorId}:${c.now}`).join('|') || '';
  const [hidden, setHidden] = React.useState('');
  if (!result?.stale || hidden === signature) return null;
  return (
    <div role="status" data-testid="flux-stale-bar" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px]"
      style={{ background: 'var(--flux-bg)', borderBottom: '1px solid var(--flux-line)', borderLeft: '3px solid var(--flux-warn)', color: 'var(--flux-text)' }}>
      <span className="fx-st fx-st-warn min-w-0 flex-1 font-medium">{changesHeadline(result)}</span>
      <button type="button" className="fx-btn fx-btn-quiet fx-btn-sm" onClick={onShow}>Показать изменения</button>
      <button type="button" className="fx-btn fx-btn-primary fx-btn-sm" onClick={onRefresh} disabled={readOnly} title={readOnly ? 'Документ открыт только для просмотра' : 'Сравнить с источником и обновить значения'}>Обновить</button>
      <button type="button" className="fx-btn fx-btn-quiet fx-btn-sm" onClick={() => setHidden(signature)} aria-label="Скрыть до следующего изменения данных">Скрыть</button>
    </div>
  );
}
