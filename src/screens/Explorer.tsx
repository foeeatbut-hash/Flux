import { useEffect } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import WindowsExplorer from '../components/explorer/WindowsExplorer';
import SharedFilesFolder from '../components/explorer/SharedFilesFolder';
import { Empty } from '../components/ui';
import { hasFluxExplorer } from '../lib/saveToWindows';
import { useToastStore } from '../store/toastStore';

/** Параметры ссылок прежнего Проводника: они указывали на файл или папку архива Flux */
const LEGACY_PARAMS = ['projectFiles', 'file', 'folder', 'open'];

export const LEGACY_FILE_MESSAGE = 'Файл из прежнего архива Flux больше не открывается в Проводнике';
export const LEGACY_FOLDER_MESSAGE = 'Папка из прежнего архива Flux больше не открывается в Проводнике';

/**
 * Старые ссылки (/explorer?file=…, ?folder=…, ?open=…) остались в письмах,
 * связях, закладках и на рабочем столе. Архива Flux в Проводнике больше нет,
 * поэтому такая ссылка не должна ни падать, ни молчать: говорим, что произошло,
 * и убираем параметры, чтобы сообщение не повторялось при каждом возврате.
 */
function LegacyLinkNotice() {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const addToast = useToastStore((s) => s.addToast);
  const legacy = location.pathname === '/explorer' && LEGACY_PARAMS.some((key) => params.has(key));
  useEffect(() => {
    if (!legacy) return;
    addToast(params.has('file') || params.has('open') ? LEGACY_FILE_MESSAGE : LEGACY_FOLDER_MESSAGE, 'info');
    const next = new URLSearchParams(params);
    for (const key of LEGACY_PARAMS) next.delete(key);
    setParams(next, { replace: true });
  }, [legacy]);
  return null;
}

/** Без моста к папкам компьютера Проводнику показывать нечего: он работает только в установленной программе */
function ExplorerNeedsWindows() {
  return <div className="h-full min-h-0 flex items-center justify-center" data-explorer-unavailable>
    <Empty title="Проводник работает в Flux для Windows"
      text="В браузере нет доступа к папкам и дискам компьютера. Откройте Flux, установленный на компьютере, чтобы работать с файлами." />
  </div>;
}

export default function Explorer() {
  const [params] = useSearchParams();
  const location = useLocation();
  // Старые ссылки на отдельное окно общего доступа остаются рабочими, но
  // открывают внутреннюю папку в том же Проводнике.
  const shared = location.pathname === '/shared-files' || params.get('view') === 'shared';
  if (shared) return <SharedFilesFolder embedded />;
  return <>
    <LegacyLinkNotice />
    {hasFluxExplorer() ? <WindowsExplorer /> : <ExplorerNeedsWindows />}
  </>;
}
