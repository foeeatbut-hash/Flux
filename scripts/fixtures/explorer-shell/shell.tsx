/**
 * Стенд каркаса Проводника: вкладки, строка адреса и панель навигации в одной
 * раскладке с эталоном (окно 1251×1183). Ниже адреса стоят заглушки командной
 * строки и строки состояния — их делает другой этап, но они занимают своё
 * место, чтобы замеры высот шли от тех же отметок, что на снимке.
 *
 * Стенд собирает настоящие компоненты и настоящие хуки; подменён только мост
 * (bridge.ts). Состояние, которое проверка читает глазами, выведено в
 * `data-testid`: место, число обновлений, журнал бросков на вкладки.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../src/index.css';
import { installBridge } from './bridge';
import ExplorerTabs from '../../../src/components/files/ExplorerTabs';
import AddressBar from '../../../src/components/files/AddressBar';
import NavPane from '../../../src/components/files/NavPane';
import { useExplorerTabs } from '../../../src/components/files/useExplorerTabs';
import { useExplorerSearch, searchScopes } from '../../../src/components/files/useExplorerSearch';
import { usePlaceCatalog } from '../../../src/components/files/usePlaceCatalog';
import { useShellKeys } from '../../../src/components/files/useShellKeys';
import { HOME, parentPlace, pathText, placeKey, type Place } from '../../../src/components/files/places';
import { SIZE, X as T } from '../../../src/components/files/explorerTheme';

installBridge();
const params = new URLSearchParams(location.search);
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark');
const w = window as any;
w.__drops = [] as string[];
w.__lastClosed = 0;

function Shell() {
  const tabs = useExplorerTabs({ onLastClosed: () => { w.__lastClosed++; } });
  const { catalog, quick } = usePlaceCatalog();
  const scopes = React.useMemo(() => searchScopes(tabs.place, catalog, quick.filter((item) => item.pinned).map((item) => item.ref)), [tabs.place, catalog, quick]);
  const search = useExplorerSearch(scopes, placeKey(tabs.place));
  const [addressToken, setAddressToken] = React.useState(0);
  const [searchToken, setSearchToken] = React.useState(0);
  const [refreshes, setRefreshes] = React.useState(0);

  const up = () => { const parent = parentPlace(tabs.place); if (parent) tabs.go(parent); };
  const onKeyDown = useShellKeys({
    newTab: () => tabs.open(HOME), closeTab: () => tabs.close(), nextTab: () => tabs.step(1), prevTab: () => tabs.step(-1),
    goBack: tabs.back, goForward: tabs.forward, goUp: up,
    address: () => setAddressToken((n) => n + 1), search: () => setSearchToken((n) => n + 1), refresh: () => setRefreshes((n) => n + 1),
  });

  if (!tabs.ready) return null;
  const hits = search.results.hits;
  return (
    <div id="frame" tabIndex={0} onKeyDown={onKeyDown} className={`flex flex-col outline-none ${T.pane} ${T.text}`} style={{ width: 1251, height: 1183 }}>
      {/* Заголовок окна: в настоящем окне это слот WindowsLayer; здесь полоса той же высоты и цвета */}
      <div data-fake-title className={`flex shrink-0 items-start ${T.strip}`} style={{ height: SIZE.titleBar }}>
        <ExplorerTabs tabs={tabs.tabs} activeId={tabs.activeId} onPick={tabs.pick} onClose={tabs.close} onNew={() => tabs.open(HOME)} onMove={tabs.move}
          onDropOnTab={(tab, event) => { w.__drops.push(`${tab.id}:${[...event.dataTransfer.types].join(',')}`); }} />
        <div style={{ width: 138 }} />
      </div>
      <AddressBar place={tabs.place} catalog={catalog} canBack={tabs.canBack} canForward={tabs.canForward} recent={tabs.recent} search={search}
        onBack={tabs.back} onForward={tabs.forward} onUp={up} onRefresh={() => setRefreshes((n) => n + 1)} onOpen={tabs.go} onJump={tabs.jump}
        focusAddressToken={addressToken} focusSearchToken={searchToken} />
      <div className={`h-px shrink-0 bg-[#e5e5e5] dark:bg-[#3a3a3a]`} />
      <div data-fake-commands className="shrink-0" style={{ height: 46 }} />
      <div className={`h-px shrink-0 bg-[#e5e5e5] dark:bg-[#3a3a3a]`} />
      <div className="flex min-h-0 flex-1">
        <NavPane place={tabs.place} onOpen={tabs.go} onOpenInNewTab={(place: Place) => tabs.open(place, false)} />
        <main className="min-w-0 flex-1 overflow-auto p-4 text-sm">
          <output data-testid="place">{pathText(tabs.place)}</output>
          <output data-testid="kind" className="ml-4 opacity-60">{tabs.place.kind}</output>
          <output data-testid="refreshes" className="ml-4 opacity-60">{refreshes}</output>
          <output data-testid="history" className="ml-4 opacity-60">{tabs.active.history.map((place) => place.name).join(' > ')}</output>
          {search.results.active && (
            <div data-testid="results" className="mt-3">
              <div data-testid="results-status">{search.results.status}{search.results.reason ? `:${search.results.reason}` : ''}</div>
              <div data-testid="results-count">{hits.length}</div>
              {hits.slice(0, 5).map((hit) => <div key={hit.fileId}>{hit.name}</div>)}
            </div>
          )}
        </main>
      </div>
      <div data-fake-status className={`shrink-0 bg-[#f3f3f3] dark:bg-[#1c1c1c]`} style={{ height: 24 }} />
    </div>
  );
}

createRoot(document.getElementById('mount')!).render(<Shell />);
