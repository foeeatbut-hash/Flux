import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { FolderOpen, RefreshCw, Share2 } from 'lucide-react';
import { useStore } from '../../store/store';
import { openHref } from '../../lib/fileTypes';
import { ENV_CONFIG } from '../../config/env';
import { receivedFiles, hideSharedFile, sourceBindings, syncOwnedSources, type SharedFile } from '../../services/fileSharingService';
import { Btn, Empty, Input, SectionHead } from '../ui';
import FileBadge from '../ui/FileBadge';
import FileShareDialog from './FileShareDialog';

/** Каталог всегда сверяется с правами после возврата из офлайна; копии не подменяют общий объект. */
export default function SharedFilesFolder({ embedded = false }: { embedded?: boolean }) {
  const navigate = useNavigate(); const location = useLocation(); const user = useStore((state) => state.user);
  const routeParams = new URLSearchParams(location.search);
  const root = routeParams.get('root'); const path = routeParams.get('path');
  const returnHref = root ? `/explorer?${new URLSearchParams({ root, path: path || '' })}` : '/explorer';
  const [files, setFiles] = useState<SharedFile[]>([]); const [query, setQuery] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [sharing, setSharing] = useState<SharedFile | null>(null);
  const [syncStatus, setSyncStatus] = useState<string[]>([]);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const request = ++generation.current;
    try { const data = await receivedFiles(); if (request === generation.current) { setFiles(data.files); setError(''); if (user?.id) setSyncStatus(sourceBindings(user.id).filter(source => source.status).map(source => `${source.name}: ${source.status}`)); } }
    catch (err: any) { if (request === generation.current) { setFiles([]); setError(err?.message || 'Общий доступ временно недоступен'); } }
  }, [user?.id]);
  useEffect(() => {
    setFiles([]); setSyncStatus([]); void load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 3000);
    const online = () => { setFiles([]); void load(); };
    const visible = () => { if (document.visibilityState === 'visible') online(); };
    window.addEventListener('online', online); document.addEventListener('visibilitychange', visible);
    return () => { generation.current++; clearInterval(timer); window.removeEventListener('online', online); document.removeEventListener('visibilitychange', visible); };
  }, [load]);
  const sync = async () => { if (!user?.id) return; setBusy(true); try { setSyncStatus(await syncOwnedSources(user.id)); await load(); } finally { setBusy(false); } };
  const items = files.filter((file) => `${file.name} ${file.ownerName}`.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru')));
  const hide = async (file: SharedFile) => { try { await hideSharedFile(file.id); await load(); } catch (err: any) { setError(err?.message || 'Не удалось скрыть файл'); } };
  const open = async (file: SharedFile) => {
    if (/\.(docx|xlsx|xlsm|pdf|md|markdown)$/i.test(file.name)) navigate(openHref(file));
    else {
      // Виртуальный файл без локального пути: стандартная выгрузка требует
      // текущих прав; после отзыва прямой адрес также перестаёт работать.
      try {
        const response = await fetch(`${ENV_CONFIG.apiUrl}/files/${encodeURIComponent(file.id)}/raw`);
        if (!response.ok) throw Error('Файл недоступен. Обновите папку, чтобы проверить права.');
        const href = URL.createObjectURL(await response.blob());
        const link = document.createElement('a'); link.href = href; link.download = file.name; link.click();
        setTimeout(() => URL.revokeObjectURL(href), 1000);
      } catch (cause: any) { setError(cause?.message || 'Не удалось получить файл'); }
    }
  };
  return <div className="h-full min-h-0 flex flex-col text-slate-800 dark:text-slate-100">
    <SectionHead title="Общий доступ" count={files.length} actions={<>{embedded && <Btn tone="ghost" onClick={() => navigate(returnHref)}><FolderOpen className="w-3.5 h-3.5" /> Проводник</Btn>}<Btn disabled={busy} onClick={() => void load()}><RefreshCw className="w-3.5 h-3.5" /> Обновить</Btn>{user?.id && sourceBindings(user.id).length > 0 && <Btn disabled={busy} onClick={() => void sync()}>Синхронизировать мои исходники</Btn>}</>} />
    <div className="fx-tools"><Input placeholder="Найти по имени или владельцу" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Поиск общих файлов" /></div>
    {error && <p className="fx-error px-3 py-2" role="alert">{error}</p>}
    {!!syncStatus.length && <div className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400" role="status">{syncStatus.map((status, index) => <p key={index}>{status}</p>)}</div>}
    <div className="flex-1 min-h-0 overflow-auto">{items.length ? <table className="fx-table w-full"><thead><tr><th>Имя</th><th>Владелец</th><th>Разрешение</th><th>Изменён</th><th /></tr></thead><tbody>{items.map((file) => <tr key={file.id} onDoubleClick={() => open(file)}><td><button type="button" className="flex items-center gap-2 text-left" onClick={() => open(file)}><FileBadge file={file} size={18} /><span>{file.name}</span></button></td><td>{file.ownerName}</td><td>{file.permission === 'VIEW' ? 'Просмотр' : file.permission === 'OWNER' ? 'Владелец' : 'Редактирование'}</td><td className="tabular-nums">{new Date(file.updatedAt).toLocaleDateString('ru-RU')}</td><td><div className="fx-row-acts">{file.ownerId === user?.id ? <Btn tone="ghost" onClick={() => setSharing(file)}><Share2 className="w-3.5 h-3.5" /> Кому доступен</Btn> : <Btn tone="ghost" onClick={() => void hide(file)}>Скрыть у меня</Btn>}</div></td></tr>)}</tbody></table> : <Empty title={query ? 'Файлы не найдены' : 'Папка «Общий доступ» пуста'} text={query ? 'Измените поисковый запрос.' : 'Здесь появятся файлы, которыми поделились с вами сотрудники.'} />}</div>
    {sharing && user?.id && <FileShareDialog actorId={user.id} fileId={sharing.id} name={sharing.name} onClose={() => setSharing(null)} onChanged={() => void load()} />}
  </div>;
}
